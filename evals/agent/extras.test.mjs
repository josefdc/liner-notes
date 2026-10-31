// The report's extras (lib/extras.mjs) on small hand-built records: the models, cost per tier,
// source errors, claims shown as sourced and the verifier as a classifier.
// Run with: node --test 'evals/**/*.test.mjs'

import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifier,
  models,
  perTier,
  sourceErrors,
  sourceSummary,
  sourcedClaims,
} from "./lib/extras.mjs";

const call = (tier, deployment, usd, inputTokens = 100, outputTokens = 10) => ({
  tier,
  deployment,
  usd,
  inputTokens,
  outputTokens,
});
const run = (isrc, ablation, extra = {}) => ({ isrc, ablation, repeat: 0, ...extra });

test("models: the judge's deployment is never counted as a generator", () => {
  const runs = [
    run("A", "d", { calls: [call("fast", "luna", 0.001), call("judge", "sol", 0.002)] }),
    run("A", "a", { calls: [call("research", "sol", 0.003)] }),
  ];
  const m = models(runs);
  assert.deepEqual(m.generators, ["luna"]);
  assert.deepEqual(m.judges, ["sol"]);
  assert.deepEqual(m.baseline, ["sol"]);
  assert.equal(m.judgeIsGenerator, false);
  assert.deepEqual(m.baselineTiers, ["research sol"]);
  assert.deepEqual(m.composerTiers, [], "no call is the composer's");
  const composed = models([
    run("A", "d", { calls: [{ ...call("main", "luna", 0), callSite: "composer" }] }),
  ]);
  assert.deepEqual(composed.composerTiers, ["main luna"]);
  const same = models([
    run("A", "d", { calls: [call("main", "sol", 0), call("judge", "sol", 0)] }),
  ]);
  assert.equal(same.judgeIsGenerator, true);
});

test("perTier: calls, tokens and USD per analysis, first runs of row d only", () => {
  const runs = [
    run("A", "d", { calls: [call("fast", "luna", 0.001), call("fast", "luna", 0.001)] }),
    run("B", "d", { calls: [call("judge", "sol", 0.004)] }),
    run("B", "d", { repeat: 1, calls: [call("judge", "sol", 9)] }),
  ];
  const [fast, judge] = perTier(runs);
  assert.equal(fast.tier, "fast");
  assert.deepEqual(fast.calls.values, [2, 0]);
  assert.deepEqual(fast.tokens.values, [220, 0]);
  assert.equal(judge.usd.value, 0.002);
  assert.equal(judge.usd.ci, null, "below the minimum n there is no interval");
});

test("sourceErrors: not configured is listed apart and is not an error of the run", () => {
  const runs = [
    run("A", "d", {
      outcome: "complete",
      sourceErrors: [{ source: "discogs", code: "not_configured" }],
    }),
    run("B", "d", {
      outcome: "complete",
      sourceErrors: [
        { source: "musicbrainz", code: "unavailable" },
        { source: "discogs", code: "not_configured" },
      ],
    }),
    run("C", "d", { outcome: "error", sourceErrors: [] }),
  ];
  const s = sourceErrors(runs);
  assert.deepEqual([s.any.k, s.any.n], [1, 3]);
  assert.deepEqual(
    s.bySource.map((b) => [b.key, b.k]),
    [["musicbrainz: unavailable", 1]],
  );
  assert.deepEqual(s.notConfigured, ["discogs"]);
  assert.deepEqual(s.failed, [{ isrc: "C", outcome: "error" }]);
});

test("sourcedClaims: kind sourced over every claim of the row's first runs", () => {
  const runs = [
    run("A", "a", { claims: [{ kind: "inferred" }, { kind: "inferred" }] }),
    run("A", "d", { claims: [{ kind: "sourced" }, { kind: "inferred" }] }),
    run("A", "d", { repeat: 1, claims: [{ kind: "sourced" }] }),
  ];
  const s = sourcedClaims(runs);
  assert.deepEqual([s.a.k, s.a.n], [0, 2]);
  assert.deepEqual([s.d.k, s.d.n], [1, 2]);
  assert.equal(s.b, undefined);
});

test("classifier: rejected is not shown as sourced; a mutation counts under its positive's source", () => {
  const cases = [
    { label: "supported", positiveSource: "code", shownAsSourced: true, verdict: "supported" },
    { label: "supported", positiveSource: "model", shownAsSourced: false, verdict: "partial" },
    {
      label: "unsupported",
      positiveSource: "code",
      mutation: "swap",
      shownAsSourced: false,
      verdict: "unsupported",
    },
    {
      label: "unsupported",
      positiveSource: "model",
      mutation: "swap",
      shownAsSourced: true,
      verdict: "supported",
    },
    {
      label: "unsupported",
      positiveSource: "model",
      mutation: "negate",
      shownAsSourced: false,
      verdict: null,
    },
  ];
  const c = classifier({ cases, judge: {}, perturb: {}, pool: {} });
  assert.deepEqual([c.overall.falsePositive.k, c.overall.falsePositive.n], [1, 2]);
  assert.deepEqual([c.overall.catch.k, c.overall.catch.n], [2, 3]);
  const model = c.bySource.find((b) => b.source === "model");
  assert.deepEqual([model.catch.k, model.catch.n], [1, 2]);
  assert.equal(c.unjudged, 1);
  assert.deepEqual(
    c.byMutation.map((m) => [m.mutation, m.k, m.n]),
    [
      ["negate", 1, 1],
      ["swap", 1, 2],
    ],
  );
  assert.equal(classifier(null), null);
});

test("sourceErrors: a source that ran without its credential is listed apart, with the rate without it", () => {
  const runs = [
    run("A", "d", {
      outcome: "complete",
      sourceErrors: [{ source: "secondhandsongs", code: "unavailable" }],
    }),
    run("B", "d", {
      outcome: "complete",
      sourceErrors: [
        { source: "secondhandsongs", code: "unavailable" },
        { source: "musicbrainz", code: "unavailable" },
      ],
    }),
    run("C", "d", { outcome: "complete", sourceErrors: [] }),
  ];
  const summary = (unset, statuses) => ({ version: 1, unset, statuses });
  const summaries = new Map([
    ["A", summary(["SHS_API_KEY"], { secondhandsongs: { 403: 2 } })],
    ["B", summary([], {})],
    ["C", summary(["SHS_API_KEY"], { secondhandsongs: { 403: 1 } })],
  ]);
  const s = sourceErrors(runs, summaries);
  assert.deepEqual([s.any.k, s.any.n], [2, 3]);
  assert.deepEqual([s.withoutUncredentialed.k, s.withoutUncredentialed.n], [1, 3]);
  assert.deepEqual(s.withoutCredential, [
    { source: "secondhandsongs", credential: "SHS_API_KEY", runs: 2, statuses: { 403: 3 } },
  ]);
  // A run with no summary: nothing is said about credentials.
  const partial = sourceErrors(runs, new Map([["A", summaries.get("A")]]));
  assert.deepEqual(partial.withoutCredential, []);
  assert.equal(partial.withoutUncredentialed, null);
});

test("sourceSummary: names of unset credentials and status counts, never a link or a body", () => {
  const dir = mkdtempSync(join(tmpdir(), "source-summary-"));
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "credentials.json"),
      '{"version":1,"unset":["SHS_API_KEY","DISCOGS_TOKEN"]}',
    );
    writeFileSync(join(dir, "audio.json"), '{"version":1,"entries":{"x":{"tempo":1}}}');
    writeFileSync(
      join(dir, "secondhandsongs.json"),
      JSON.stringify({
        version: 1,
        entries: {
          "GET https://a/1": { status: 403, text: "x" },
          "GET https://a/2": { status: 403 },
        },
      }),
    );
    assert.deepEqual(sourceSummary(dir), {
      version: 1,
      unset: ["DISCOGS_TOKEN", "SHS_API_KEY"],
      statuses: { secondhandsongs: { 403: 2 } },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
