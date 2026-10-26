/**
 * Client-side pacing of one source's requests (Discogs, SecondHandSongs; Deezer's two lanes are
 * paced by LanePacer below; MusicBrainz has its own queue in musicbrainz.ts): at most one request
 * every `intervalMs` and, for each budget the source sets, at most `max` requests in any window
 * of `windowMs`. Each request reserves the
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
const pacers = new Set<{ clear(): void }>();
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
    this.#starts = this.#starts.filter((t) => t + longest > now);
    let at = Math.max(now, this.#next, this.#heldUntil);
    for (const { max, windowMs } of budgets) {
      // Within this window, the slot frees when the oldest start that keeps it full leaves it.
      // Moving `at` later for one budget only empties the windows of the others.
      const inside = this.#starts.filter((t) => t + windowMs > at);
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

// =============================================================================
// A pacer with a priority lane (Deezer)
// =============================================================================

/**
 * The pace of a source whose requests come in two lanes: at most `max` requests start in any
 * window of `windowMs`, of which at most `backgroundMax` from the background lane.
 */
export interface LanePace {
  windowMs: number;
  max: number;
  backgroundMax: number;
  /** The longest a request may wait for its slot; a later slot is refused. */
  maxWaitMs: number;
}

/** "priority" requests always start before waiting "background" ones. */
export type Lane = "priority" | "background";

export interface LaneSlotOptions extends SlotOptions {
  lane?: Lane;
}

interface Start {
  at: number;
  lane: Lane;
}

interface Waiter {
  lane: Lane;
  go: () => void;
}

/**
 * When a request of `lane` may start, at or after `from`, given the starts so far (in order).
 * Within a window, a slot frees when the oldest start that keeps it full leaves it.
 *
 * A start is inside the window at `at` while `start.at + windowMs > at`: the same sum that moves
 * `at`, so the start that frees the slot is outside at the new `at`. Written as
 * `start.at > at - windowMs`, a fractional clock time can round so that it never leaves, and the
 * loop never ends.
 */
function earliestStart(starts: readonly Start[], lane: Lane, from: number, pace: LanePace): number {
  let at = from;
  for (;;) {
    const inside = starts.filter((start) => start.at + pace.windowMs > at);
    if (inside.length >= pace.max) {
      at = inside[inside.length - pace.max].at + pace.windowMs;
      continue;
    }
    if (lane === "background") {
      const background = inside.filter((start) => start.lane === "background");
      if (background.length >= pace.backgroundMax) {
        at = background[background.length - pace.backgroundMax].at + pace.windowMs;
        continue;
      }
    }
    return at;
  }
}

/**
 * A pacer for one source with two lanes (LanePace). Unlike RequestPacer, a request reserves no
 * slot ahead: it waits in its lane's queue, first come, first served, and starts when the window
 * has room; a waiting priority request always goes first, so it never waits behind background
 * requests, which only take the room priority ones leave.
 *
 * A request is refused at once (PaceRefused) when the slot it would get, with no other request
 * coming ahead of it, is more than `maxWaitMs` away or later than its `notAfter`; a background
 * request that priority requests have kept waiting until its `notAfter` is refused then. A
 * refused request is never sent. A request whose signal aborts while it waits leaves the queue
 * at once, rejecting with the signal's reason. Like RequestPacer, it paces one process and is
 * switched off by setUnpacedForTests.
 */
export class LanePacer {
  #starts: Start[] = [];
  #priority: Waiter[] = [];
  #background: Waiter[] = [];
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    readonly name: string,
    private readonly pace: () => LanePace,
  ) {
    pacers.add(this);
  }

  /** Forgets its starts and lets every waiting request go. */
  clear(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#starts = [];
    const waiting = [...this.#priority, ...this.#background];
    this.#priority = [];
    this.#background = [];
    for (const waiter of waiting) waiter.go();
  }

  /** Requests waiting for a slot (tests). */
  get waiting(): number {
    return this.#priority.length + this.#background.length;
  }

  #prune(now: number, pace: LanePace): void {
    this.#starts = this.#starts.filter((start) => start.at + pace.windowMs > now);
  }

  /** When a new request of `lane` would start if no other request came ahead of it. */
  #estimate(lane: Lane, now: number, pace: LanePace): number {
    const starts = [...this.#starts];
    const ahead: Lane[] = [
      ...this.#priority.map((): Lane => "priority"),
      ...(lane === "background" ? this.#background.map((): Lane => "background") : []),
      lane,
    ];
    let at = now;
    for (const next of ahead) {
      at = earliestStart(starts, next, at, pace);
      starts.push({ at, lane: next });
    }
    return at;
  }

  /** Starts every waiting request the window has room for, priority first; then waits. */
  #pump(): void {
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const pace = this.pace();
    for (;;) {
      const queue = this.#priority.length > 0 ? this.#priority : this.#background;
      const head = queue[0];
      if (!head) return;
      const now = pacingClock();
      this.#prune(now, pace);
      const at = earliestStart(this.#starts, head.lane, now, pace);
      if (at > now) {
        this.#timer = setTimeout(() => this.#pump(), Math.ceil(at - now));
        this.#timer.unref?.();
        return;
      }
      queue.shift();
      this.#starts.push({ at: now, lane: head.lane });
      head.go();
    }
  }

  #refusal(wait: number): PaceRefused {
    return new PaceRefused(
      wait,
      `paced: the next ${this.name} request may start in ${Math.ceil(wait / 1000)} s`,
    );
  }

  /**
   * Waits for a slot in `lane` (priority by default). Rejects with PaceRefused when the slot is
   * more than the pace's `maxWaitMs` away or later than `notAfter`, and with the signal's reason
   * when it aborts first.
   */
  async slot(options: LaneSlotOptions = {}): Promise<void> {
    const { signal, notAfter, lane = "priority" } = options;
    signal?.throwIfAborted();
    if (unpaced) return;
    const pace = this.pace();
    const now = pacingClock();
    this.#prune(now, pace);
    const at = this.#estimate(lane, now, pace);
    const wait = at - now;
    // A slot free now is taken whatever the deadline: only a wait can make a request too late.
    if (wait > pace.maxWaitMs || (wait > 0 && notAfter !== undefined && at > notAfter)) {
      throw this.#refusal(wait);
    }
    if (wait <= 0) {
      this.#starts.push({ at: now, lane });
      return;
    }
    const queue = lane === "priority" ? this.#priority : this.#background;
    await new Promise<void>((resolve, reject) => {
      let late: ReturnType<typeof setTimeout> | undefined;
      const leave = () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        clearTimeout(late);
        signal?.removeEventListener("abort", onAbort);
        this.#pump();
      };
      const onAbort = () => {
        leave();
        reject(signal?.reason);
      };
      const waiter: Waiter = {
        lane,
        go: () => {
          clearTimeout(late);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      // Priority requests that came ahead kept it waiting past its deadline: it is not sent.
      if (lane === "background" && notAfter !== undefined) {
        late = setTimeout(
          () => {
            leave();
            reject(this.#refusal(0));
          },
          // Just after it: a slot due at `notAfter` itself is still taken.
          Math.max(0, Math.ceil(notAfter - now)) + 1,
        );
        late.unref?.();
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      queue.push(waiter);
      this.#pump();
    });
  }
}
