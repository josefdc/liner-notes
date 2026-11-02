// The kinds of what the golden run's pages show (kinds.mjs). Run with: node --test 'evals/**/*.test.mjs'

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { build, CHART_PATH, countKinds, REPORT_PATH, readResults, share } from "./kinds.mjs";

const byLabel = (rows) => Object.fromEntries(rows.map((row) => [row.label, row]));

// The committed records give these counts: a change to a record, or to how a kind is read,
// changes them, and the README's figures with them.
test("the committed golden run's pages: counts by kind", () => {
  const { results } = readResults();
  assert.equal(results.length, 24);
  const rows = byLabel(countKinds(results));
  assert.deepEqual(rows.Claims.counts, { measured: 0, sourced: 232, inferred: 44, missing: 0 });
  assert.deepEqual(rows.Claims.origins, { code: 164, model: 68 });
  assert.deepEqual(rows["Song-relation links"].counts, {
    measured: 0,
    sourced: 86,
    inferred: 16,
    missing: 0,
  });
  assert.deepEqual(rows.Tempo.counts, { measured: 22, sourced: 0, inferred: 0, missing: 2 });
  assert.deepEqual(rows.Tempo.reasons, { unsteady_tempo: 1, no_preview: 1 });
  // No key is served on the golden set.
  assert.deepEqual(rows.Key.counts, { measured: 0, sourced: 0, inferred: 0, missing: 24 });
  assert.deepEqual(rows.Key.reasons, {
    no_sustained_pitch: 19,
    speech_like: 2,
    few_pitch_classes: 1,
    one_harmonic_series: 1,
    no_preview: 1,
  });
  assert.deepEqual(rows.Loudness.counts, { measured: 23, sourced: 0, inferred: 0, missing: 1 });
});

// The claims' split agrees with the agent report's "claims shown as sourced" for row d.
test("the sourced claims agree with the agent report", () => {
  const report = readFileSync(new URL("../reports/agent-2026-10-31.md", import.meta.url), "utf8");
  assert.match(report, /\| d \| [^|]+ \| kind sourced \| 84\.1 % \(232\/276\) \| 276 \|/);
});

test("the audio values come from the v2 block, not the flat audioSource field", () => {
  const measured = {
    claims: [],
    genealogy: { links: [] },
    audioSource: "unavailable",
    audio: {
      tempo: { bpm: 120 },
      key: null,
      loudness: { rmsMean: 0.1 },
      withheld: { key: { code: "no_sustained_pitch" } },
    },
  };
  const none = {
    claims: [
      { kind: "sourced", origin: "code" },
      { kind: "inferred", origin: "model" },
    ],
    genealogy: { links: [{ kind: "inferred" }] },
    audio: null,
    audioUnavailableReason: "no_preview",
  };
  const rows = byLabel(countKinds([{ result: measured }, { result: none }]));
  assert.deepEqual(rows.Tempo.counts, { measured: 1, sourced: 0, inferred: 0, missing: 1 });
  assert.deepEqual(rows.Tempo.reasons, { no_preview: 1 });
  assert.deepEqual(rows.Key.reasons, { no_sustained_pitch: 1, no_preview: 1 });
  assert.deepEqual(rows.Claims.counts, { measured: 0, sourced: 1, inferred: 1, missing: 0 });
  assert.equal(rows["Song-relation links"].n, 1);
  assert.throws(() => countKinds([{ result: { claims: [{ kind: "guessed" }] } }]), /guessed/);
});

test("shares carry a Wilson interval from n = 10, counts only below", () => {
  assert.equal(share(232, 276), "232/276 = 84.1 % [79.3, 87.9]");
  assert.equal(share(3, 9), "3/9");
});

test("the committed report and chart are what the script writes", () => {
  const { report, chart } = build();
  assert.equal(readFileSync(REPORT_PATH, "utf8"), report, "run: node evals/agent/kinds.mjs");
  assert.equal(readFileSync(CHART_PATH, "utf8"), chart, "run: node evals/agent/kinds.mjs");
});
