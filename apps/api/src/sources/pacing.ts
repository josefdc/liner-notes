/**
 * Client-side pacing of one source's requests (Discogs, SecondHandSongs, Deezer; MusicBrainz has
 * its own queue in musicbrainz.ts): at most one request every `intervalMs` and, for each budget the
 * source sets, at most `max` requests in any window of `windowMs`. Each request reserves the
 * next free slot and waits for it. A request is refused at once (`PaceRefused`, with the wait),
 * and takes no slot, when its slot is more than `maxWaitMs` away, or is not free now and comes
 * later than the caller's `notAfter` (the time by which a request must start to be answered
 * within the caller's deadline): it is never sent, and the caller reports the source as not asked, never as a
 * timeout. A request whose signal aborts while it waits gives its slot back when no later
 * request has reserved one.
 *
 * After the source itself said "slow down", `holdFor` keeps every request of this source from
 * starting before the wait it asked for (at most MAX_HOLD_MS); a request that was already
 * waiting for a slot inside the hold takes a new slot after it.
 *
 * Times are read from a monotonic clock (`performance.now()`), so a step of the wall clock
 * moves no slot. Pacing is per process: two API processes (or an evaluation run beside the API)
 * on one host each pace on their own, while the sources count requests per IP address.
 *
 * The pace can depend on the configuration (SecondHandSongs allows more with an API key), so it
 * is read for each request.
 */

export interface Budget {
  max: number;
  windowMs: number;
}

export interface Pace {
  /** The least time between the starts of two requests. */
  intervalMs: number;
  /** For each, at most `max` requests start in any window of `windowMs`. */
  budgets?: readonly Budget[];
  /** The longest a request may wait for its slot; a later slot is refused. */
  maxWaitMs: number;
}

/** The longest a source's "slow down" holds its requests: a longer Retry-After is cut to it. */
export const MAX_HOLD_MS = 10 * 60 * 1000;

/**
 * Thrown when a request is not sent: its slot is further away than it may wait, or after the
 * caller's deadline ("pace"), or the caller's deadline passed before it could start
 * ("deadline", by `pacedFetchJson`).
 */
export class PaceRefused extends Error {
  constructor(
    readonly waitMs: number,
    message: string,
    readonly why: "pace" | "deadline" = "pace",
  ) {
    super(message);
    this.name = "PaceRefused";
  }
}

/** The monotonic clock the pacers read, in ms. */
export const pacingClock = (): number => performance.now();

/** Every pacer, for the tests' switch. */
const pacers = new Set<RequestPacer>();
let unpaced = false;

/**
 * Tests: with `true` no request is paced or held (the default in tests, see
 * test/setup/sourcePacing.ts), with `false` requests are paced as in production. Either way
 * every pacer forgets its reserved slots and holds.
 */
export function setUnpacedForTests(value: boolean): void {
  unpaced = value;
  for (const pacer of pacers) pacer.clear();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export interface SlotOptions {
  signal?: AbortSignal;
  /** On `pacingClock`: the latest a request may start; a later slot is refused. */
  notAfter?: number;
}

export class RequestPacer {
  /** The earliest start of the next request. */
  #next = 0;
  /** Until when the source asked us to send nothing. */
  #heldUntil = 0;
  /** The starts (past and reserved) inside the longest budget window, in order. */
  #starts: number[] = [];

  constructor(
    readonly name: string,
    private readonly pace: () => Pace,
  ) {
    pacers.add(this);
  }

  /** Forgets reserved slots and holds. */
  clear(): void {
    this.#next = 0;
    this.#heldUntil = 0;
    this.#starts = [];
  }

  /** How many starts it keeps for its budgets (tests). */
  get kept(): number {
    return this.#starts.length;
  }

  /** The earliest start a new request may take at `now`, by the spacing, hold and budgets. */
  #earliest(now: number, budgets: readonly Budget[]): number {
    const longest = Math.max(0, ...budgets.map((b) => b.windowMs));
    this.#starts = this.#starts.filter((t) => t > now - longest);
    let at = Math.max(now, this.#next, this.#heldUntil);
    for (const { max, windowMs } of budgets) {
      // Within this window, the slot frees when the oldest start that keeps it full leaves it.
      // Moving `at` later for one budget only empties the windows of the others.
      const inside = this.#starts.filter((t) => t > at - windowMs);
      if (inside.length >= max) at = Math.max(at, inside[inside.length - max] + windowMs);
    }
    return at;
  }

  /**
   * Reserves the next slot and waits for it. Rejects with PaceRefused when the slot is more than
   * the pace's `maxWaitMs` away or later than `notAfter`, and with the signal's reason when it
   * aborts first.
   */
  async slot(options: SlotOptions = {}): Promise<void> {
    const { signal, notAfter } = options;
    signal?.throwIfAborted();
    if (unpaced) return;
    for (;;) {
      const { intervalMs, budgets = [], maxWaitMs } = this.pace();
      const now = pacingClock();
      const at = this.#earliest(now, budgets);
      const wait = at - now;
      // A slot free now is taken whatever the deadline: only a wait the pacing asks for can
      // make a request start too late.
      if (wait > maxWaitMs || (wait > 0 && notAfter !== undefined && at > notAfter)) {
        throw new PaceRefused(
          wait,
          `paced: the next ${this.name} request may start in ${Math.ceil(wait / 1000)} s`,
        );
      }
      const before = this.#next;
      const heldAtReserve = this.#heldUntil;
      this.#next = at + intervalMs;
      if (budgets.length > 0) this.#starts.push(at);
      if (wait <= 0) return;
      try {
        await sleep(wait, signal);
      } catch (error) {
        this.#giveBack(at, intervalMs, before);
        throw error;
      }
      // A hold that came while it waited and still runs: it takes a new slot after the hold.
      if (this.#heldUntil > heldAtReserve && this.#heldUntil > pacingClock()) {
        this.#giveBack(at, intervalMs, before);
        continue;
      }
      return;
    }
  }

  /** The slot at `at` goes back when it is still the last one reserved. */
  #giveBack(at: number, intervalMs: number, before: number): void {
    if (this.#next === at + intervalMs) this.#next = before;
    if (this.#starts.at(-1) === at) this.#starts.pop();
  }

  /**
   * The source asked to slow down: no request starts within `ms` from now, at most MAX_HOLD_MS.
   * Returns the hold applied (0 when none).
   */
  holdFor(ms: number): number {
    if (unpaced || !Number.isFinite(ms) || ms <= 0) return 0;
    const held = Math.min(ms, MAX_HOLD_MS);
    this.#heldUntil = Math.max(this.#heldUntil, pacingClock() + held);
    return held;
  }
}
