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
//     "edges": [{ "direction": "uses" | "usedBy",
//                 "relation": "sample" | "interpolation" | "cover" | "remix",
//                 "origin": "code" | "model",
//                 "target": { "title": "…", "artist": "…", "isrc"?: "…", "mbid"?: "…" },
//                 "evidenceIds": ["…"] }],
//     "claims": [{ "id": "…", "text": "…", "origin": "model", "verdict": "supported" }],
//     "schemaValid": true, "fallback": false, "latencyMs": 41000,
//     "usage": { "inputTokens": 16000, "outputTokens": 3000, "usd": 0.012 }
//   }
//
// Only forward sample, interpolation and cover edges ("uses": the row's track uses the target) are
// scored, as gold lists only those. A record with an unknown ablation, direction, relation or
// origin is an error, never silently dropped.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  ANY_SITE,
  citedSite,
  goldTargets,
  otherDocumented,
  RELATIONS,
  sameRecording,
} from "./golden.mjs";
import { bootstrap, jaccard, MIN_N_FOR_RATE, mean, quantile, wilson } from "./stats.mjs";
import { analyse, nameKey, normText, sentences } from "./support.mjs";

export const ABLATIONS = {
  a: "model only, no tools or evidence",
  b: "deterministic only, no model",
  c: "pipeline before the verifier",
  d: "pipeline after the verifier (what the UI shows)",
};

export const EDGE_RELATIONS = [...RELATIONS, "remix"];
export const DIRECTIONS = ["uses", "usedBy"];
export const ORIGINS = ["code", "model"];

/** Throws, naming the record and field, when a run record is not in the documented shape. */
export function validateRun(run, where = "run record") {
  const fail = (why) => {
    throw new Error(`${where}${run?.runId ? ` (${run.runId})` : ""}: ${why}`);
  };
  if (!run || typeof run !== "object") fail("not an object");
  if (typeof run.isrc !== "string") fail("isrc missing");
  if (!ABLATIONS[run.ablation]) fail(`ablation "${run.ablation}" is not a, b, c or d`);
  if (![0, 1].includes(run.repeat ?? 0)) fail(`repeat ${run.repeat} is not 0 or 1`);
  for (const [i, e] of (run.edges ?? []).entries()) {
    if (!DIRECTIONS.includes(e?.direction)) fail(`edge ${i}: direction "${e?.direction}"`);
    if (!EDGE_RELATIONS.includes(e.relation)) fail(`edge ${i}: relation "${e.relation}"`);
    if (e.origin !== undefined && !ORIGINS.includes(e.origin)) {
      fail(`edge ${i}: origin "${e.origin}"`);
    }
    if (typeof e.target?.title !== "string" || typeof e.target?.artist !== "string") {
      fail(`edge ${i}: target needs a title and an artist`);
    }
  }
  for (const [i, c] of (run.claims ?? []).entries()) {
    if (typeof c?.text !== "string") fail(`claim ${i}: text`);
    if (c.origin !== undefined && !ORIGINS.includes(c.origin))
      fail(`claim ${i}: origin "${c.origin}"`);
  }
  return run;
}

/** Reads every *.json file in a directory: each holds one run record or an array of them. */
export function readRuns(dir) {
  const runs = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    const data = JSON.parse(readFileSync(join(dir, name), "utf8"));
    for (const [i, run] of (Array.isArray(data) ? data : [data]).entries()) {
      runs.push({ repeat: 0, ...validateRun(run, `${name}[${i}]`) });
    }
  }
  return runs;
}

const forwardEdges = (run) =>
  (run.edges ?? []).filter((e) => e.direction === "uses" && RELATIONS.includes(e.relation));

const edgeKey = (e) => `${normText(e.target.title)}|${normText(e.target.artist)}|${e.relation}`;

/**
 * Proposed edges once per spelling of target and relation, code-built copies first: when the
 * code and the model propose the same edge, the code's copy is the one scored, so model
 * precision covers only the edges the code did not also build.
 */
function distinctEdges(edges) {
  const byKey = new Map();
  for (const e of edges) {
    const prior = byKey.get(edgeKey(e));
    if (!prior || (prior.origin !== "code" && e.origin === "code")) byKey.set(edgeKey(e), e);
  }
  const all = [...byKey.values()];
  return [...all.filter((e) => e.origin === "code"), ...all.filter((e) => e.origin !== "code")];
}

/** The sites a run's evidence cites (golden.mjs citedSite: it fails closed to ANY_SITE). */
export const citedSites = (run) => new Set((run.evidence ?? []).map((ev) => citedSite(ev.url)));

/**
 * Does one sentence of the run's evidence name this proposal as an entity: its title as a quoted
 * title, its artist as a name, and a relation? Only then may an unmatched proposal on a row
 * whose gold is not exhaustive be left out of precision.
 */
function evidenceNames(run, target) {
  const title = normText(target.title);
  const artist = nameKey(target.artist);
  if (!title || !artist) return false;
  return (run.evidence ?? []).some((ev) =>
    sentences(ev.excerpt ?? "").some((sentence) => {
      const a = analyse(sentence);
      const titles = new Set(a.entities.filter((e) => e.kind === "title").map((e) => e.key));
      const names = new Set(a.entities.map((e) => e.key));
      return a.relation !== null && !a.negated && titles.has(title) && names.has(artist);
    }),
  );
}

/**
 * One run against its golden row.
 * - Held-out, per run: a gold target counts as held-out only when the run's evidence cites none
 *   of the sites of its held-out sources (a page that cannot be placed counts as citing all).
 * - Precision, strict: one true positive per gold target; another spelling of a target already
 *   credited (an ISRC match, a remaster title) is a duplicate, left out; a gold target with a
 *   relation gold does not accept is a false positive ("right target, wrong relation"), and so is
 *   the track itself. Other proposals: an `otherDocumentedTargets` match is left out; on a row
 *   whose gold is exhaustive it is a false positive; otherwise it is left out ("unresolved") only
 *   when one evidence sentence names its title and artist with a relation.
 */
export function scoreRun(row, run) {
  const proposed = distinctEdges(forwardEdges(run));
  const cited = citedSites(run);
  const golds = goldTargets(row);
  const credited = new Set();
  const self = { title: row.title, artist: row.artist, isrc: row.isrc, mbid: row.mbid };
  const edges = proposed.map((e) => {
    const target = golds.find((t) => sameRecording(t.target, e.target));
    if (target) {
      if (!target.relations.has(e.relation)) {
        return { edge: e, outcome: "fp", why: "right target, wrong relation", target: target.key };
      }
      if (credited.has(target.key)) return { edge: e, outcome: "duplicate", target: target.key };
      credited.add(target.key);
      return { edge: e, outcome: "tp", target: target.key };
    }
    if (sameRecording(self, e.target)) return { edge: e, outcome: "fp", why: "the track itself" };
    if (otherDocumented(row).some((o) => sameRecording(o.target, e.target))) {
      return { edge: e, outcome: "other-documented" };
    }
    if (row.labels.edgesExhaustive) return { edge: e, outcome: "fp", why: "not in gold" };
    if (evidenceNames(run, e.target)) return { edge: e, outcome: "unresolved" };
    return { edge: e, outcome: "fp", why: "nothing in the run's evidence names it" };
  });
  const targets = golds.map((t) => {
    const heldOutSources = t.sources.filter((s) => s.heldOut);
    const heldOutSites = [...new Set(heldOutSources.map((s) => s.site))];
    const citedHeldOut = cited.has(ANY_SITE)
      ? heldOutSites
      : heldOutSites.filter((s) => cited.has(s));
    return {
      key: t.key,
      found: credited.has(t.key),
      foundByCode: edges.some(
        (x) => x.outcome === "tp" && x.target === t.key && x.edge.origin === "code",
      ),
      heldOutDefault: heldOutSources.length > 0,
      heldOut: heldOutSources.length > 0 && citedHeldOut.length === 0,
      heldOutSites,
      excludedBy: citedHeldOut,
    };
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
  const count = (outcome) => edges.filter((e) => e.outcome === outcome).length;
  const tp = count("tp");
  const fp = count("fp");
  return {
    ...rate(tp, tp + fp),
    wrongRelation: edges.filter((e) => e.why === "right target, wrong relation").length,
    duplicates: count("duplicate"),
    unresolved: count("unresolved"),
    otherDocumented: count("other-documented"),
  };
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
    edgesPerControl: statOf(perControl, mean),
    excludedBySite: excludedBySite(heldOutDefault),
  };
}

/** How many held-out targets each cited site took out of held-out recall. */
function excludedBySite(targets) {
  const counts = {};
  for (const t of targets) for (const s of t.excludedBy) counts[s] = (counts[s] ?? 0) + 1;
  return Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

const p50 = (xs) => quantile(xs, 0.5);
const p95 = (xs) => quantile(xs, 0.95);
/** A statistic over per-track values; no bootstrap below MIN_N_FOR_RATE (the values are kept). */
function statOf(values, f) {
  return {
    n: values.length,
    value: values.length ? f(values) : null,
    ci: values.length >= MIN_N_FOR_RATE ? bootstrap(values, f) : null,
    values: [...values],
  };
}
const has = (x) => typeof x === "number" && Number.isFinite(x);

/** Identity at recording level: the row's MusicBrainz recording when both know it, else ISRC. */
export function identityCorrect(row, run) {
  const id = run.identity;
  if (!id) return false;
  if (id.mbid && row.mbid) return id.mbid === row.mbid;
  return id.isrc === row.isrc;
}

/**
 * The pre-verifier support rate: of the model's claims before the verifier (row c), the share
 * the judge marked supported. A claim the judge did not reach counts as not supported, and how
 * many there were is kept.
 */
export function supportRate(runs) {
  const claims = runs.flatMap((r) => (r.claims ?? []).filter((c) => c.origin === "model"));
  return {
    ...rate(claims.filter((c) => c.verdict === "supported").length, claims.length),
    unjudged: claims.filter((c) => typeof c.verdict !== "string").length,
  };
}

/**
 * The pipeline metrics, from the after-verifier runs (row d, first run of each track); the
 * support rate is from the before-verifier runs (row c), when there are any.
 */
export function pipelineMetrics(rowsByIsrc, runs, beforeVerifier = []) {
  const scored = runs.map((run) => scoreRun(rowsByIsrc.get(run.isrc), run));
  const identityOk = (run) => identityCorrect(rowsByIsrc.get(run.isrc), run);
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
    support: supportRate(beforeVerifier),
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
  for (const r of runs.filter((x) => x.ablation === "d" && (x.repeat ?? 0) === 0)) {
    first.set(r.isrc, r);
  }
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
  for (const [i, run] of runs.entries()) validateRun(run, `run ${i}`);
  const first = runs.filter((r) => (r.repeat ?? 0) === 0);
  const ablations = {};
  for (const id of Object.keys(ABLATIONS)) {
    const list = first.filter((r) => r.ablation === id);
    if (list.length === 0) continue;
    const scored = list.map((run) => scoreRun(rowsByIsrc.get(run.isrc), run));
    ablations[id] = { ...edgeMetrics(scored), scored };
  }
  const d = first.filter((r) => r.ablation === "d");
  const c = first.filter((r) => r.ablation === "c");
  const pipeline = d.length ? pipelineMetrics(rowsByIsrc, d, c) : null;
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
