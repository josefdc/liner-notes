/**
 * Test helper: generated strings for comparing a rewritten text matcher with the expression it
 * replaces, and a clock for the time one call takes.
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
 * machine only ever adds time, so the fastest of a few is the closest to the call's own cost.
 */
export function timed<T>(call: () => T, runs = 1): { ms: number; result: T } {
  let fastest = Number.POSITIVE_INFINITY;
  let result: T | undefined;
  for (let run = 0; run < runs; run++) {
    const start = performance.now();
    result = call();
    fastest = Math.min(fastest, performance.now() - start);
  }
  return { ms: fastest, result: result as T };
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
