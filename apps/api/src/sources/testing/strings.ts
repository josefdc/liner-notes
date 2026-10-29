/**
 * Test helper: generated strings for comparing a rewritten text matcher with the expression it
 * replaces, a clock for the time one call takes, and how a call's cost grows with its text.
 *
 *   const texts = [...allStrings([" ", "to", "A1"], 5), ...randomStrings(parts, 20_000)];
 *   expect(disagreements(texts, rewritten, old)).toEqual([]);
 */

import { isDeepStrictEqual } from "node:util";

/** Every string of up to `maxParts` parts from `parts` (repeats allowed), the empty one first. */
export function allStrings(parts: readonly string[], maxParts: number): string[] {
  const out = [""];
  let last = [""];
  for (let length = 1; length <= maxParts; length++) {
    last = last.flatMap((prefix) => parts.map((part) => prefix + part));
    for (const text of last) out.push(text);
  }
  return out;
}

/**
 * `count` strings of 1 to `maxParts` parts drawn from `parts`, from a fixed seed: the same
 * strings on every run.
 */
export function randomStrings(
  parts: readonly string[],
  count: number,
  maxParts = 16,
  seed = 1,
): string[] {
  let state = seed;
  const next = (below: number) => {
    // A 32-bit linear congruential generator; Math.imul keeps the product exact.
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return (state >>> 16) % below;
  };
  return Array.from({ length: count }, () => {
    let text = "";
    for (let i = 1 + next(maxParts); i > 0; i--) text += parts[next(parts.length)];
    return text;
  });
}

/**
 * How long one call takes, in milliseconds, with its result: the fastest of `runs` calls. A busy
 * machine only ever adds time, so the fastest of a few is the closest to the call's own cost. A
 * call that takes more than `stopAboveMs` ends the timing there: one that far over a bound is a
 * slow form, not a busy machine, and running it again only makes the failure take longer.
 * `clock` reads the time; threadCpuMs counts only the CPU time the call uses.
 */
export function timed<T>(
  call: () => T,
  {
    runs = 1,
    stopAboveMs = Number.POSITIVE_INFINITY,
    clock = () => performance.now(),
  }: { runs?: number; stopAboveMs?: number; clock?: () => number } = {},
): { ms: number; result: T } {
  let fastest = Number.POSITIVE_INFINITY;
  let result: T | undefined;
  for (let run = 0; run < runs; run++) {
    const start = clock();
    result = call();
    const ms = clock() - start;
    fastest = Math.min(fastest, ms);
    if (ms > stopAboveMs) break;
  }
  return { ms: fastest, result: result as T };
}

/**
 * The CPU time this thread has used, in milliseconds (user and system). A busy machine does not
 * add to it, as it adds to the time on the clock; it moves in steps of about 1 ms.
 */
export function threadCpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

/** The shortest sample `growth` reads: the thread's CPU clock moves in steps of about 1 ms. */
const MIN_SAMPLE_MS = 10;

/**
 * How a call's cost grows from a text of `size` characters to one `factor` times longer, with its
 * result on the longer text. A call that reads the text once grows about as the text does, and one
 * that reads on to the end of the text from each match grows about as its square.
 *
 * The cost is the CPU time of the thread that runs the call, not the time on the clock: a busy
 * machine adds waits between the thread's turns on a CPU, and more of them to a long call than to
 * a short one, which no number of runs evens out, while the CPU time the call uses stays about the
 * same.
 * Each sample repeats the call until it reads MIN_SAMPLE_MS or more, and is divided by the calls
 * it made; the cost on each text is the lowest of `runs` samples, the two texts taken in turn.
 *
 * A sample over `maxMs` throws: a scan that slow fails on that, not on a ratio from fewer samples.
 */
export function growth<T>(
  make: (size: number) => string,
  call: (text: string) => T,
  { size, factor, maxMs, runs = 3 }: { size: number; factor: number; maxMs: number; runs?: number },
): { ratio: number; smallMs: number; bigMs: number; result: T } {
  const small = make(size);
  const big = make(size * factor);
  /** One sample: the CPU time of one call on `text`, from as many calls as MIN_SAMPLE_MS takes. */
  const sample = (text: string) => {
    const start = threadCpuMs();
    let calls = 0;
    let used = 0;
    let result: T;
    do {
      result = call(text);
      calls++;
      used = threadCpuMs() - start;
      if (used > maxMs) {
        throw new Error(
          `a call on ${text.length} characters took ${Math.round(used)} ms of CPU time, over ${maxMs} ms`,
        );
      }
    } while (used < MIN_SAMPLE_MS);
    return { ms: used / calls, result };
  };
  let smallMs = Number.POSITIVE_INFINITY;
  let bigMs = Number.POSITIVE_INFINITY;
  let result: T | undefined;
  for (let run = 0; run < runs; run++) {
    smallMs = Math.min(smallMs, sample(small).ms);
    const timing = sample(big);
    result = timing.result;
    bigMs = Math.min(bigMs, timing.ms);
  }
  return { ratio: bigMs / smallMs, smallMs, bigMs, result: result as T };
}

/**
 * The inputs on which `now` and `old` give different results, at most `limit` of them with both
 * results. A test asserts this once over a large corpus instead of once per input, which keeps
 * the test fast on a loaded machine.
 */
export function disagreements<T>(
  inputs: Iterable<T>,
  now: (input: T) => unknown,
  old: (input: T) => unknown,
  limit = 5,
): Array<{ input: T; now: unknown; old: unknown }> {
  const found: Array<{ input: T; now: unknown; old: unknown }> = [];
  for (const input of inputs) {
    const [a, b] = [now(input), old(input)];
    if (!isDeepStrictEqual(a, b)) found.push({ input, now: a, old: b });
    if (found.length >= limit) break;
  }
  return found;
}
