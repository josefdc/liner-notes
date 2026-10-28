/**
 * Test helper: generated strings for comparing a rewritten text matcher with the expression it
 * replaces, and clocks for the time one call takes and for how it grows with its text.
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
 */
export function timed<T>(
  call: () => T,
  {
    runs = 1,
    stopAboveMs = Number.POSITIVE_INFINITY,
  }: { runs?: number; stopAboveMs?: number } = {},
): { ms: number; result: T } {
  let fastest = Number.POSITIVE_INFINITY;
  let result: T | undefined;
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    result = call();
    const ms = performance.now() - start;
    fastest = Math.min(fastest, ms);
    if (ms > stopAboveMs) break;
  }
  return { ms: fastest, result: result as T };
}

/**
 * How a call's time grows from a text of `size` characters to one `factor` times longer, with its
 * result on the longer text: the fastest of `runs` calls on each, the two texts taken in turn.
 * A busy machine slows the calls on both texts alike, so the ratio holds where a bound in
 * milliseconds does not; a call that reads the text once grows about as the text does, and one
 * that reads on to the end of the text from each match grows about as its square. A call on the
 * longer text that takes more than `stopAboveMs` ends the timing there, as in `timed`.
 */
export function growth<T>(
  make: (size: number) => string,
  call: (text: string) => T,
  {
    size,
    factor,
    runs = 3,
    stopAboveMs = Number.POSITIVE_INFINITY,
  }: { size: number; factor: number; runs?: number; stopAboveMs?: number },
): { ratio: number; smallMs: number; bigMs: number; result: T } {
  const small = make(size);
  const big = make(size * factor);
  let smallMs = Number.POSITIVE_INFINITY;
  let bigMs = Number.POSITIVE_INFINITY;
  let result: T | undefined;
  for (let run = 0; run < runs; run++) {
    smallMs = Math.min(smallMs, timed(() => call(small)).ms);
    const timing = timed(() => call(big));
    result = timing.result;
    bigMs = Math.min(bigMs, timing.ms);
    if (timing.ms > stopAboveMs) break;
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
