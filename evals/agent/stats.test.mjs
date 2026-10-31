// Interval helpers. Run with: node --test 'evals/**/*.test.mjs'

import assert from "node:assert/strict";
import { test } from "node:test";

import { bootstrap, jaccard, mean, quantile, rng, wilson } from "./lib/stats.mjs";

const close = (actual, expected, digits = 4) =>
  assert.ok(Math.abs(actual - expected) < 10 ** -digits, `${actual} != ${expected}`);

test("Wilson intervals match published values", () => {
  const [lo, hi] = wilson(5, 10);
  close(lo, 0.2366);
  close(hi, 0.7634);
  const [zlo, zhi] = wilson(0, 10);
  assert.equal(zlo, 0);
  close(zhi, 0.2775);
  assert.equal(wilson(0, 0), null);
  assert.throws(() => wilson(3, 2), RangeError);
});

test("the bootstrap is seeded: the same input gives the same interval", () => {
  const values = [3.14, 1.59, 2.65, 3.58, 9.79, 3.23, 8.46, 2.64, 3.38, 3.27];
  const a = bootstrap(values, mean);
  const b = bootstrap(values, mean);
  assert.deepEqual(a, b);
  assert.ok(a[0] < mean(values) && mean(values) < a[1]);
  assert.notDeepEqual(bootstrap(values, mean, { seed: 7 }), a);
  assert.deepEqual(bootstrap([2, 2, 2], mean), [2, 2]);
  assert.equal(bootstrap([], mean), null);
});

test("quantiles, the PRNG and Jaccard", () => {
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(quantile([], 0.5), null);
  const r1 = rng(1);
  const r2 = rng(1);
  assert.deepEqual([r1(), r1()], [r2(), r2()]);
  assert.equal(jaccard(["a", "b"], ["b", "c"]), 1 / 3);
  assert.equal(jaccard([], []), 1);
});
