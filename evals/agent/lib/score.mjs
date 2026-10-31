// Scoring agent runs against the golden set (evals/README.md, "Scoring edges" and "Held-out
// gold"). Pure: run records in, counts and intervals out. No network, no model.
//
// A run record (one analysis of one golden row), as the harness writes it:
//
//   {
//     "version": 1,
//     "synthetic": true,              // only in test data: never a measurement
//     "runId": "…", "isrc": "…",      // the golden row the run analysed
//     "ablation": "d",                // a model only · b deterministic only · c before the
//                                     // verifier · d after the verifier (what the UI shows)
//     "repeat": 0,                    // 1 for the variance re-run
//     "commit": "…", "recordedAt": "…",
//     "identity": { "isrc": "…", "mbid": "…" } | null,   // the recording the run resolved
//     "clarification": { "fired": true, "answer": "top-ranked" } | null,
//     "preview": { "available": true } | null,
//     "evidence": [{ "id": "…", "url": "…", "excerpt": "…" }],
//     "edges": [{ "direction": "uses" | "usedBy", "relation": "sample", "origin": "code",
//                 "target": { "title": "…", "artist": "…", "isrc"?: "…", "mbid"?: "…" },
//                 "evidenceIds": ["…"] }],
//     "claims": [{ "id": "…", "text": "…", "origin": "model", "verdict": "supported" }],
//     "schemaValid": true, "fallback": false, "latencyMs": 41000,
//     "usage": { "inputTokens": 16000, "outputTokens": 3000, "usd": 0.012 }
//   }
//
// Only forward edges ("uses": the row's track uses the target) are scored, as gold lists only
// forward relations.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { goldTargets, otherDocumented, RELATIONS, sameRecording, site } from "./golden.mjs";
import { bootstrap, jaccard, MIN_N_FOR_RATE, mean, quantile, wilson } from "./stats.mjs";
import { containsWords, normText } from "./support.mjs";

export const ABLATIONS = {
  a: "model only, no tools or evidence",
  b: "deterministic only, no model",
  c: "pipeline before the verifier",
  d: "pipeline after the verifier (what the UI shows)",
};

/** Reads every *.json file in a directory: each holds one run record or an array of them. */
export function readRuns(dir) {
  const runs = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const data = JSON.parse(readFileSync(join(dir, name), "utf8"));
    for (const run of Array.isArray(data) ? data : [data]) {
      if (!run || typeof run !== "object" || !run.isrc || !ABLATIONS[run.ablation]) {
        throw new Error(`${name}: a run record needs isrc and ablation a-d`);
      }
      runs.push({ repeat: 0, ...run, file: name });
    }
  }
  return runs;
}

const forwardEdges = (run) =>
  (run.edges ?? []).filter((e) => e.direction === "uses" && RELATIONS.includes(e.relation));

const edgeKey = (e) => `${normText(e.target.title)}|${normText(e.target.artist)}|${e.relation}`;

/** Proposed edges once per target and relation; a code-built copy wins over a model one. */
function distinctEdges(edges) {
  const byKey = new Map();
  for (const e of edges) {
    const prior = byKey.get(edgeKey(e));
    if (!prior || (prior.origin !== "code" && e.origin === "code")) byKey.set(edgeKey(e), e);
  }
  return [...byKey.values()];
}

/** The sites a run's evidence cites. */
export const citedSites = (run) =>
  new Set(
    (run.evidence ?? [])
      .map((ev) => {
        try {
          return site(ev.url);
        } catch {
          return null;
        }
      })
      .filter(Boolean),
  );

/**
 * One run against its golden row, with the per-run held-out rule: a gold target stays held-out
 * only while at least one of its held-out sources is on a site the run's evidence does not cite.
 */
export function scoreRun(row, run) {
  const proposed = distinctEdges(forwardEdges(run));
  const cited = citedSites(run);
  const targets = goldTargets(row).map((t) => {
    const matches = (e) => sameRecording(t.target, e.target) && t.relations.has(e.relation);
    const heldOutSources = t.sources.filter((s) => s.heldOut);
    const uncited = heldOutSources.filter((s) => !cited.has(s.site));
    return {
      key: t.key,
      found: proposed.some(matches),
      foundByCode: proposed.some((e) => e.origin === "code" && matches(e)),
      heldOutDefault: heldOutSources.length > 0,
      heldOut: uncited.length > 0,
      heldOutSites: [...new Set(heldOutSources.map((s) => s.site))],
    };
  });
  const evidenceText = (run.evidence ?? []).map((ev) => ev.excerpt ?? "");
  const edges = proposed.map((e) => {
    const target = goldTargets(row).find(
      (t) => sameRecording(t.target, e.target) && t.relations.has(e.relation),
    );
    if (target) return { edge: e, outcome: "tp" };
    if (otherDocumented(row).some((o) => sameRecording(o.target, e.target))) {
      return { edge: e, outcome: "other-documented" };
    }
    if (row.labels.edgesExhaustive) return { edge: e, outcome: "fp" };
    // Gold may not list every relation here: only a clearly unsupported proposal counts, one
    // that nothing in the run's evidence names.
    const named = evidenceText.some((x) => containsWords(x, e.target.title));
    return { edge: e, outcome: named ? "unresolved" : "fp" };
  });
  return {
    isrc: row.isrc,
    runId: run.runId ?? null,
    stratum: row.stratum,
    citedSites: [...cited].sort(),
    targets,
    edges,
    sampleEdges: proposed.length,
    hallucinated: row.stratum === "no-sample-controls" && proposed.length > 0,
  };
}

const rate = (k, n) => ({ k, n, value: n === 0 ? null : k / n, ci: wilson(k, n) });
const sum = (xs, f) => xs.reduce((s, x) => s + f(x), 0);

function precision(scored, origin) {
  const edges = scored.flatMap((s) =>
    s.edges.filter((e) => origin === undefined || e.edge.origin === origin),
  );
  const tp = edges.filter((e) => e.outcome === "tp").length;
  const fp = edges.filter((e) => e.outcome === "fp").length;
  return rate(tp, tp + fp);
}

/** The edge metrics of one ablation row: recall, precision, held-out recall, hallucination. */
export function edgeMetrics(scored) {
  const withGold = scored.filter((s) => s.targets.length > 0);
  const targets = withGold.flatMap((s) => s.targets);
  const heldOutDefault = targets.filter((t) => t.heldOutDefault);
  const heldOut = targets.filter((t) => t.heldOut);
  const controls = scored.filter((s) => s.stratum === "no-sample-controls");
  const perControl = controls.map((s) => s.sampleEdges);
  return {
    tracks: scored.length,
    recall: {
      ...rate(
        sum(targets, (t) => +t.found),
        targets.length,
      ),
      rows: withGold.length,
    },
    codeCoverage: rate(
      sum(targets, (t) => +t.foundByCode),
      targets.length,
    ),
    precision: precision(scored),
    modelPrecision: precision(scored, "model"),
    heldOut: {
      ...rate(
        sum(heldOut, (t) => +t.found),
        heldOut.length,
      ),
      gold: heldOutDefault.length,
      excluded: heldOutDefault.length - heldOut.length,
      rows: scored.filter((s) => s.targets.some((t) => t.heldOut)).length,
    },
    hallucination: rate(
      sum(controls, (s) => +s.hallucinated),
      controls.length,
    ),
    edgesPerControl: {
      n: perControl.length,
      value: mean(perControl),
      ci: bootstrap(perControl, mean),
    },
  };
}

const p50 = (xs) => quantile(xs, 0.5);
const p95 = (xs) => quantile(xs, 0.95);
const statOf = (values, f) => ({ n: values.length, value: f(values), ci: bootstrap(values, f) });
const has = (x) => typeof x === "number" && Number.isFinite(x);

/** The pipeline metrics, from the after-verifier runs (row d, first run of each track). */
export function pipelineMetrics(rowsByIsrc, runs) {
  const scored = runs.map((run) => scoreRun(rowsByIsrc.get(run.isrc), run));
  const identityOk = (run) => {
    const row = rowsByIsrc.get(run.isrc);
    const id = run.identity;
    if (!id) return false;
    if (id.mbid && row.mbid) return id.mbid === row.mbid;
    return id.isrc === row.isrc;
  };
  const judged = runs.flatMap((r) =>
    (r.claims ?? []).filter((c) => c.origin === "model" && typeof c.verdict === "string"),
  );
  const latency = runs.map((r) => r.latencyMs).filter(has);
  const tokens = runs
    .map((r) => (r.usage ? r.usage.inputTokens + r.usage.outputTokens : null))
    .filter(has);
  const usd = runs.map((r) => r.usage?.usd).filter(has);
  const m = edgeMetrics(scored);
  return {
    tracks: runs.length,
    preview: rate(
      sum(runs, (r) => +(r.preview?.available === true)),
      runs.length,
    ),
    identity: rate(
      sum(runs, (r) => +identityOk(r)),
      runs.length,
    ),
    codeCoverage: m.codeCoverage,
    modelPrecision: m.modelPrecision,
    clarification: rate(
      sum(runs, (r) => +(r.clarification?.fired === true)),
      runs.length,
    ),
    support: rate(judged.filter((c) => c.verdict === "supported").length, judged.length),
    schemaValid: rate(
      sum(runs, (r) => +(r.schemaValid === true)),
      runs.length,
    ),
    fallback: rate(
      sum(runs, (r) => +(r.fallback === true)),
      runs.length,
    ),
    latencyP50: statOf(latency, p50),
    latencyP95: statOf(latency, p95),
    tokens: statOf(tokens, mean),
    usd: statOf(usd, mean),
    identityOk,
    scored,
  };
}

/** Per-stratum results; a stratum with n < MIN_N_FOR_RATE is shown as counts only. */
export function strata(rowsByIsrc, runs, identityOk) {
  const byStratum = new Map();
  for (const run of runs) {
    const row = rowsByIsrc.get(run.isrc);
    const list = byStratum.get(row.stratum) ?? [];
    list.push(run);
    byStratum.set(row.stratum, list);
  }
  return [...byStratum.entries()].map(([stratum, list]) => {
    const scored = list.map((run) => scoreRun(rowsByIsrc.get(run.isrc), run));
    const m = edgeMetrics(scored);
    const identity = rate(
      sum(list, (r) => +identityOk(r)),
      list.length,
    );
    const countsOnly = (r) => ({ ...r, countsOnly: r.n < MIN_N_FOR_RATE });
    return {
      stratum,
      identity: countsOnly(identity),
      recall: countsOnly(m.recall),
      hallucination: countsOnly(m.hallucination),
    };
  });
}

/** Run-to-run variance: Jaccard of claims and of edges for tracks run twice (row d). */
export function variance(runs) {
  const first = new Map();
  const pairs = [];
  for (const r of runs.filter((x) => x.ablation === "d" && x.repeat === 0)) first.set(r.isrc, r);
  for (const again of runs.filter((x) => x.ablation === "d" && x.repeat === 1)) {
    const one = first.get(again.isrc);
    if (one) pairs.push([one, again]);
  }
  const claimSet = (r) => (r.claims ?? []).map((c) => normText(c.text));
  const edgeSet = (r) => forwardEdges(r).map(edgeKey);
  const claims = pairs.map(([x, y]) => jaccard(claimSet(x), claimSet(y)));
  const edges = pairs.map(([x, y]) => jaccard(edgeSet(x), edgeSet(y)));
  return { pairs: pairs.length, claims: statOf(claims, mean), edges: statOf(edges, mean) };
}

/** Everything the report needs from a set of runs. */
export function scoreAll(golden, runs, { subset } = {}) {
  const rowsByIsrc = new Map(golden.rows.map((r) => [r.isrc, r]));
  const unknown = runs.filter((r) => !rowsByIsrc.get(r.isrc)?.liveSubset);
  if (unknown.length) {
    throw new Error(
      `runs for rows that are not live golden rows: ${[...new Set(unknown.map((r) => r.isrc))].join(", ")}`,
    );
  }
  const first = runs.filter((r) => r.repeat === 0);
  const ablations = {};
  for (const id of Object.keys(ABLATIONS)) {
    const list = first.filter((r) => r.ablation === id);
    if (list.length === 0) continue;
    const scored = list.map((run) => scoreRun(rowsByIsrc.get(run.isrc), run));
    ablations[id] = { ...edgeMetrics(scored), scored };
  }
  const d = first.filter((r) => r.ablation === "d");
  const pipeline = d.length ? pipelineMetrics(rowsByIsrc, d) : null;
  return {
    subset: subset ?? null,
    // One synthetic record makes the whole report test data.
    synthetic: runs.some((r) => r.synthetic === true),
    commits: [...new Set(runs.map((r) => r.commit).filter(Boolean))].sort(),
    runs: runs.length,
    tracks: new Set(runs.map((r) => r.isrc)).size,
    ablations,
    pipeline,
    strata: pipeline ? strata(rowsByIsrc, d, pipeline.identityOk) : [],
    variance: variance(runs),
  };
}
