/**
 * Client-side pacing of one source's requests (Discogs, SecondHandSongs; MusicBrainz has its
 * own queue in musicbrainz.ts): at most one request every `intervalMs` and, when the source sets
 * one, at most `budget.max` requests in any `budget.windowMs`. Each request reserves the next
 * free slot and waits for it; a request whose slot is more than `maxWaitMs` away is refused at
 * once (`PaceRefused`, with the wait) and takes no slot, so a caller with a deadline is told
 * "rate limited" instead of waiting past it. A request whose signal aborts while it waits gives
 * its slot back when no later request has reserved one.
 *
 * After the source itself said "slow down", `holdFor` keeps every request of this source from
 * starting before the wait it asked for.
 *
 * The pace can depend on the configuration (SecondHandSongs allows more with an API key), so it
 * is read for each request.
 */

export interface Pace {
  /** The least time between the starts of two requests. */
  intervalMs: number;
  /** At most `max` requests start in any window of `windowMs`. */
  budget?: { max: number; windowMs: number };
  /** The longest a request may wait for its slot; a later slot is refused. */
  maxWaitMs: number;
}

/** Thrown when a request's slot is further away than its pace allows it to wait. */
export class PaceRefused extends Error {
  constructor(
    readonly waitMs: number,
    message: string,
  ) {
    super(message);
    this.name = "PaceRefused";
  }
}

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

export class RequestPacer {
  /** The earliest start of the next request. */
  #next = 0;
  /** The starts (past and reserved) inside the budget window, in order. */
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
    this.#starts = [];
  }

  /**
   * Reserves the next slot and waits for it. Rejects with PaceRefused when the slot is more than
   * the pace's `maxWaitMs` away, and with the signal's reason when it aborts first.
   */
  async slot(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (unpaced) return;
    const { intervalMs, budget, maxWaitMs } = this.pace();
    const now = Date.now();
    let at = Math.max(now, this.#next);
    if (budget) {
      this.#starts = this.#starts.filter((t) => t > now - budget.windowMs);
      if (this.#starts.length >= budget.max) {
        // The slot frees when the oldest start that keeps the window full leaves it.
        at = Math.max(at, this.#starts[this.#starts.length - budget.max] + budget.windowMs);
      }
    }
    const wait = at - now;
    if (wait > maxWaitMs) {
      throw new PaceRefused(
        wait,
        `paced: the next ${this.name} request may start in ${Math.ceil(wait / 1000)} s`,
      );
    }
    const before = this.#next;
    this.#next = at + intervalMs;
    this.#starts.push(at);
    if (wait <= 0) return;
    try {
      await sleep(wait, signal);
    } catch (error) {
      // The slot goes back when it is still the last one reserved.
      if (this.#next === at + intervalMs && this.#starts.at(-1) === at) {
        this.#next = before;
        this.#starts.pop();
      }
      throw error;
    }
  }

  /** The source asked to slow down: no request starts within `ms` from now. */
  holdFor(ms: number): void {
    if (unpaced || !Number.isFinite(ms) || ms <= 0) return;
    this.#next = Math.max(this.#next, Date.now() + ms);
  }
}
