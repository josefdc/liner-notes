// Confidence intervals for the agent report: Wilson score intervals for proportions and a
// seeded percentile bootstrap for everything else (means, medians, p95). Pure and deterministic:
// the same input and seed always give the same interval.

/** The z value of a two-sided 95 % interval. */
export const Z95 = 1.959963984540054;
/** Bootstrap resamples and seed used by the report unless a caller asks otherwise. */
export const BOOTSTRAP_RESAMPLES = 10_000;
export const BOOTSTRAP_SEED = 33;
/** Below this n a stratum is shown as counts, never as a rate. */
export const MIN_N_FOR_RATE = 10;

/**
 * Wilson score interval for k successes out of n, as [low, high]. null when n is 0: there is no
 * rate to bound.
 */
export function wilson(k, n, z = Z95) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) {
    throw new RangeError(`wilson: need integers 0 <= k <= n, got k=${k} n=${n}`);
  }
  if (n === 0) return null;
  const p = k / n;
  const z2 = z * z;
  const centre = (p + z2 / (2 * n)) / (1 + z2 / n);
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/** mulberry32: a small seeded PRNG, enough for resampling and for picking mutations. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The q-quantile (0..1) of numbers, linear between order statistics (type 7). */
export function quantile(values, q) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((x, y) => x - y);
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

export const mean = (values) =>
  values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;

/**
 * Percentile bootstrap of `statistic` over `values` (one value per track), as [low, high].
 * null when there are no values; a zero-width interval when every value is equal.
 */
export function bootstrap(
  values,
  statistic,
  { resamples = BOOTSTRAP_RESAMPLES, seed = BOOTSTRAP_SEED } = {},
) {
  if (values.length === 0) return null;
  if (values.every((v) => v === values[0])) return [statistic(values), statistic(values)];
  const next = rng(seed);
  const stats = new Array(resamples);
  const sample = new Array(values.length);
  for (let r = 0; r < resamples; r++) {
    for (let i = 0; i < values.length; i++) sample[i] = values[Math.floor(next() * values.length)];
    stats[r] = statistic(sample);
  }
  return [quantile(stats, 0.025), quantile(stats, 0.975)];
}

/** Jaccard index of two sets of strings; 1 when both are empty. */
export function jaccard(a, b) {
  const x = new Set(a);
  const y = new Set(b);
  if (x.size === 0 && y.size === 0) return 1;
  let both = 0;
  for (const v of x) if (y.has(v)) both++;
  return both / (x.size + y.size - both);
}
