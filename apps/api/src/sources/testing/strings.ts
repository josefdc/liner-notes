/**
 * Test helper: generated strings for comparing a rewritten text matcher with the expression it
 * replaces, and a clock for the time one call takes.
 *
 *   for (const text of [...allStrings([" ", "to", "A1"], 5), ...randomStrings(parts, 20_000)])
 *     expect(rewritten(text), text).toEqual(old(text));
 */

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

/** How long one call takes, in milliseconds, with its result. */
export function timed<T>(call: () => T): { ms: number; result: T } {
  const start = performance.now();
  const result = call();
  return { ms: performance.now() - start, result };
}
