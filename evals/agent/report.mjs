#!/usr/bin/env node
// Renders the agent eval report from run records (see lib/score.mjs for their shape).
//
//   node evals/agent/report.mjs --runs <dir>                      print the report (Markdown)
//   node evals/agent/report.mjs --runs <dir> --subset all --out evals/reports
//                                   write agent-<date>.md, .json and agent-latest.md there
//                                   (--subset is required there: a row with no record fails)
// Options: --golden <path> (default evals/golden.jsonl), --subset ci|all (score only those
// rows), --date YYYY-MM-DD (default: today, UTC), --commit <sha> (default: git HEAD).
// `npm run eval:table -- --runs <dir>` is the same as the first form.
//
// No network and no model: it only reads the run records and the golden file.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ANY_SITE,
  GOLDEN_PATH,
  goldSources,
  liveRows,
  REPO_ROOT,
  readGolden,
  subsetRows,
} from "./lib/golden.mjs";
import {
  classifier,
  JUDGE_FILE,
  models,
  PERTURB_DIR,
  perTier,
  readPerturbRecords,
  sourcedClaims,
  sourceErrors,
} from "./lib/extras.mjs";
import { RESULTS_DIR } from "./lib/record.mjs";
import { ABLATIONS, readRuns, scoreAll } from "./lib/score.mjs";
import { BOOTSTRAP_RESAMPLES, BOOTSTRAP_SEED, MIN_N_FOR_RATE } from "./lib/stats.mjs";

export const CI_HEADER = "95 % CI";

const pct = (x) => `${(100 * x).toFixed(1)} %`;
const cell = (s) => String(s).replace(/\|/g, "\\|");

function table(head, rows) {
  return [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

/**
 * A proportion as value, n and CI cells. Below MIN_N_FOR_RATE it is counts only, in every
 * table: "k/n" and no interval.
 */
export function rateCells(r) {
  if (r.n === 0) return ["no data", 0, "none (n = 0)"];
  if (r.n < MIN_N_FOR_RATE) return [`${r.k}/${r.n}`, r.n, COUNTS_ONLY];
  return [`${pct(r.value)} (${r.k}/${r.n})`, r.n, `[${pct(r.ci[0])}, ${pct(r.ci[1])}]`];
}

/** A statistic over tracks; below MIN_N_FOR_RATE the values themselves, with no interval. */
export function statCells(s, format) {
  if (s.n === 0) return ["no data", 0, "none (n = 0)"];
  if (s.n < MIN_N_FOR_RATE) return [`values ${s.values.map(format).join(", ")}`, s.n, COUNTS_ONLY];
  const ci = `[${format(s.ci[0])}, ${format(s.ci[1])}]`;
  // Every track has the same value, so every resample does: say so rather than imply precision.
  // A zero-width interval over values that differ (ties at a cap) carries no mark.
  const allEqual = s.values?.length > 0 && s.values.every((v) => v === s.values[0]);
  return [format(s.value), s.n, allEqual ? `${ci} ${ALL_EQUAL}` : ci];
}

export const ALL_EQUAL = "(all resamples equal)";

/** Markdown-escapes text a run record supplies (a proposed title or artist). */
export const escapeMd = (text) => String(text).replace(/[\\`*_[\]<>#|~]/g, "\\$&");

/**
 * Where the runs of a record directory were recorded, in words, when the directory keeps it
 * (`provenance.txt`): the commit the records name is the code revision the runs were recorded
 * from, which a squash merge leaves out of the repository's history.
 */
export const PROVENANCE_FILE = "provenance.txt";

export function readProvenance(dir) {
  const path = join(dir, PROVENANCE_FILE);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8").replace(/\s+/g, " ").trim();
  return text || null;
}

/**
 * The sha256 of a run-record directory: every *.json file and the provenance note, by name, in
 * code-point order.
 */
export function runsSha256(dir) {
  const hash = createHash("sha256");
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".json") || n === PROVENANCE_FILE)
    .sort()) {
    hash
      .update(`${name}\0`)
      .update(readFileSync(join(dir, name)))
      .update("\0");
  }
  // The perturbation judge's record and its audit, and each row's whole normalised result (what
  // the replay compares), when the directory keeps them.
  for (const sub of [PERTURB_DIR, RESULTS_DIR]) {
    const path = join(dir, sub);
    if (!existsSync(path)) continue;
    for (const name of readdirSync(path)
      .filter((n) => n.endsWith(".json"))
      .sort()) {
      hash
        .update(`${sub}/${name}\0`)
        .update(readFileSync(join(path, name)))
        .update("\0");
    }
  }
  return hash.digest("hex");
}

export const COUNTS_ONLY = `counts only (n < ${MIN_N_FOR_RATE})`;
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const tokens = (x) => String(Math.round(x));
const usd = (x) => `USD ${x.toFixed(4)}`;
const decimal = (x) => x.toFixed(2);

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

/** Per run, the cited sites and each held-out target (the checker re-derives all of it). */
function heldOutDetail(scored) {
  return scored.map((s) => ({
    isrc: s.isrc,
    runId: s.runId,
    citedSites: s.citedSites,
    targets: s.targets
      .filter((t) => t.heldOutDefault)
      .map((t) => ({
        key: t.key,
        heldOutSites: t.heldOutSites,
        excludedBy: t.excludedBy,
        counted: t.heldOut,
        found: t.found,
      })),
  }));
}

function unmatched(scored) {
  return scored.flatMap((s) =>
    s.edges
      .filter((e) => e.outcome === "fp" || e.outcome === "unresolved")
      .map((e) => ({
        isrc: s.isrc,
        target: { title: e.edge.target.title, artist: e.edge.target.artist },
        relation: e.edge.relation,
        origin: e.edge.origin ?? null,
        outcome: e.outcome,
        why: e.why ?? null,
      })),
  );
}

const plainRate = ({ k, n, value, ci }) => ({ k, n, value, ci });
const plainStat = ({ n, value, ci, values }) => ({ n, value, ci, values });
const plainPrecision = (p) => ({
  ...plainRate(p),
  wrongRelation: p.wrongRelation,
  duplicates: p.duplicates,
  unresolved: p.unresolved,
  otherDocumented: p.otherDocumented,
});
const sites = (counts) =>
  Object.entries(counts)
    .map(([s, n]) => `${s === ANY_SITE ? "a page whose site cannot be placed" : s} ${n}`)
    .join(", ");

/** Renders { md, json } from scored results and the report's metadata. */
export function renderReport(
  golden,
  result,
  {
    date,
    commit,
    goldenLabel,
    runsLabel,
    runsSha,
    jsonName: name,
    extras = null,
    provenance = null,
  },
) {
  const jsonName = name ?? `agent-${date}.json`;
  const live = liveRows(golden);
  const sources = goldSources(live);
  const p = result.pipeline;
  const lines = [];
  lines.push(`# Agent evals, ${date}`, "");
  if (result.synthetic) lines.push(SYNTHETIC_BANNER, "");
  lines.push(
    `- **Dataset**: \`${goldenLabel}\`, sha256 \`${golden.sha256}\`; ${golden.rows.length} rows, ${live.length} in the live subset.`,
    `- **Run records**: \`${runsLabel}\`, sha256 \`${runsSha}\`; ${result.runs} records over ${result.tracks} tracks (subset: ${result.subset ?? "as recorded"}).`,
    `- **Date**: ${date}`,
    `- **Commit**: \`${commit}\`${result.commits.length ? ` (runs recorded at ${result.commits.map((c) => `\`${c}\``).join(", ")})` : ""}`,
    ...(provenance ? [`- **Provenance**: ${provenance}`] : []),
    `- **Results**: \`${jsonName}\``,
    `- **Gold** is described by its sources, each read on the date given in the golden file: ${sources
      .map(
        (s) =>
          `${s.site} (${s.refs} ${s.refs === 1 ? "reference" : "references"}, read ${s.first === s.last ? s.first : `${s.first} to ${s.last}`})`,
      )
      .join("; ")}. Every gold label cites one of these sources; none comes from listening.`,
    ...(extras?.models ? modelLines(extras.models) : []),
    "",
    "## How to read it",
    "",
    `- **n** is printed next to every value. Proportions carry a 95 % Wilson score interval; means, medians and p95 carry a 95 % percentile bootstrap over tracks (${BOOTSTRAP_RESAMPLES.toLocaleString("en-US")} resamples, seed ${BOOTSTRAP_SEED}). Edges and claims of one track are not independent, so pooled intervals are narrower than they should be.`,
    `- Any row with n < ${MIN_N_FOR_RATE}, in any table, is shown as counts (or the values themselves), with no rate and no interval.`,
    '- **Edges** are scored per distinct gold target, forward relations only, strictly against gold (`evals/README.md`, "Scoring edges"). One gold target gives one true positive however many spellings propose it; a gold target with a relation gold does not accept is a false positive. A proposal that matches an `otherDocumentedTargets` entry is left out of precision; on rows whose gold is not exhaustive, so is a proposal that one evidence sentence states this track uses, by that relation, naming its title and artist. **Model edge precision** covers only the edges the code did not also build.',
    "- **Held-out recall**: a gold target is held-out only when none of its sources is one the pipeline queries (a target MusicBrainz also documents can be found by echoing MusicBrainz), and it stops counting in a run whose evidence cites the site of any of its sources; an archived, translated or mirrored copy counts as its original, and a page whose site cannot be placed counts as citing every site. The held-out table gives n before and after that exclusion, and which sites removed targets.",
    "- **Pre-verifier support rate**: of the model's claims before the verifier (row c), the share the judge marked supported; a claim the judge did not reach counts as not supported.",
    "- **Clarification**: the harness answers the clarification step with the top-ranked candidate, never the gold ISRC; the clarification rate is how often the step fired.",
    "- **Rows b, c and d come from the same runs.** Row d counts the relations the result shows as documented (sourced links: code-built ones, and model ones whose own claim the judge found supported); a model link the verifier did not source is shown as a possible relation, labelled model inference, and counts in row c only. Row c is every relation the run proposed and every claim it wrote, before the verifier's verdicts take effect. Row b is the code-built links and claims of the same runs. Row a is a separate call per track: the composer's prompt with only the title and artist, no tools and no evidence.",
    `- **Ablations**: ${Object.entries(ABLATIONS)
      .map(([id, what]) => `(${id}) ${what}`)
      .join("; ")}.`,
    "",
  );

  const json = {
    version: 1,
    date,
    commit,
    ...(provenance ? { provenance } : {}),
    synthetic: result.synthetic,
    golden: { path: goldenLabel, sha256: golden.sha256, rows: golden.rows.length },
    runRecords: { path: runsLabel, sha256: runsSha },
    subset: result.subset,
    runs: result.runs,
    tracks: result.tracks,
    goldSources: sources,
    pipeline: null,
    ablations: {},
    heldOut: {},
    strata: [],
    variance: null,
    unmatched: [],
    pending: [],
  };

  if (p) {
    const s = p.support;
    const rows = [
      ["preview coverage", ...rateCells(p.preview)],
      ["identity accuracy (recording level)", ...rateCells(p.identity)],
      ["clarification rate", ...rateCells(p.clarification)],
      ["code-built edge coverage", ...rateCells(p.codeCoverage)],
      ["model edge precision", ...rateCells(p.modelPrecision)],
      [`pre-verifier support rate (row c model claims, ${s.unjudged} not judged)`, ...rateCells(s)],
      ["schema-valid rate", ...rateCells(p.schemaValid)],
      ["fallback rate", ...rateCells(p.fallback)],
      ["latency p50", ...statCells(p.latencyP50, seconds)],
      ["latency p95", ...statCells(p.latencyP95, seconds)],
      ["tokens per analysis (mean)", ...statCells(p.tokens, tokens)],
      ["USD per analysis (mean)", ...statCells(p.usd, usd)],
    ];
    lines.push(
      "## Pipeline (row d, after the verifier)",
      "",
      table(["metric", "value", "n", CI_HEADER], rows),
      "",
    );
    json.pipeline = {
      tracks: p.tracks,
      ...Object.fromEntries(
        ["preview", "identity", "clarification", "codeCoverage", "schemaValid", "fallback"].map(
          (k) => [k, plainRate(p[k])],
        ),
      ),
      modelPrecision: plainPrecision(p.modelPrecision),
      support: { ...plainRate(s), unjudged: s.unjudged },
      ...Object.fromEntries(
        ["latencyP50", "latencyP95", "tokens", "usd"].map((k) => [k, plainStat(p[k])]),
      ),
    };
  } else {
    lines.push("## Pipeline (row d, after the verifier)", "", "Pending: no row d runs.", "");
    json.pending.push("pipeline");
  }
  if (extras?.perTier && p) renderExtras(extras, lines, json);

  const ablationRows = [];
  const heldOutRows = [];
  const leftOut = [];
  const countedFalse = [];
  const exclusions = [];
  for (const [id, what] of Object.entries(ABLATIONS)) {
    const a = result.ablations[id];
    if (!a) continue;
    ablationRows.push(
      [id, what, "edge recall", ...rateCells(a.recall)],
      [id, what, "edge precision (all proposed edges)", ...rateCells(a.precision)],
      [id, what, "held-out edge recall", ...rateCells(a.heldOut)],
      [id, what, "hallucinated-sample rate", ...rateCells(a.hallucination)],
      [id, what, "edges per no-sample track (mean)", ...statCells(a.edgesPerControl, decimal)],
    );
    const pr = a.precision;
    countedFalse.push(`(${id}) ${pr.wrongRelation}`);
    leftOut.push(
      `(${id}) ${pr.duplicates} duplicate, ${pr.otherDocumented} other documented, ${pr.unresolved} unresolved`,
    );
    heldOutRows.push([id, a.heldOut.gold, a.heldOut.excluded, ...rateCells(a.heldOut)]);
    if (a.heldOut.excluded > 0) exclusions.push(`(${id}) ${sites(a.excludedBySite)}`);
    json.ablations[id] = {
      what,
      tracks: a.tracks,
      recall: plainRate(a.recall),
      precision: plainPrecision(a.precision),
      modelPrecision: plainPrecision(a.modelPrecision),
      heldOutRecall: plainRate(a.heldOut),
      hallucination: plainRate(a.hallucination),
      edgesPerControl: plainStat(a.edgesPerControl),
    };
    json.heldOut[id] = {
      gold: a.heldOut.gold,
      excluded: a.heldOut.excluded,
      nAfterExclusion: a.heldOut.n,
      found: a.heldOut.k,
      excludedBySite: a.excludedBySite,
      perRun: heldOutDetail(a.scored),
    };
  }
  const heldOutNote = Object.entries(result.ablations)
    .filter(([, a]) => a.heldOut.n < MIN_N_FOR_RATE)
    .map(([id, a]) => `(${id}) ${a.heldOut.n} of ${a.heldOut.gold}`);
  lines.push(
    "## Ablations",
    "",
    table(["row", "what it runs", "metric", "value", "n", CI_HEADER], ablationRows),
    "",
    `False positives with the right target and the wrong relation, included in precision: ${countedFalse.join("; ")}. Left out of precision: ${leftOut.join("; ")}.`,
    "",
    ...(extras?.sourcedClaims ? sourcedClaimLines(extras.sourcedClaims, json) : []),
    "## Held-out recall after the per-run domain exclusion",
    "",
    table(
      [
        "row",
        "held-out gold targets",
        "excluded (run cites a site of its sources)",
        "recall (found/n)",
        "n after exclusion",
        CI_HEADER,
      ],
      heldOutRows,
    ),
    "",
    exclusions.length
      ? `Targets excluded, by the cited site: ${exclusions.join("; ")}.`
      : "No target was excluded: no run cites a site of a held-out target's sources.",
    ...(heldOutNote.length
      ? [
          "",
          `Few held-out targets (${heldOutNote.join("; ")}): only gold targets that no queried source documents are held-out, and runs that cite their sources' sites lose them, so held-out recall rests on these few and is shown as counts.`,
        ]
      : []),
    ...(extras?.perTier
      ? [
          "",
          "Why each proposal of the committed golden run was not matched, the held-out target's included, is described in `docs/failures.md`.",
        ]
      : []),
    "",
  );

  if (result.strata.length) {
    const rows = result.strata.flatMap((s) => [
      [s.stratum, "identity accuracy", ...rateCells(s.identity)],
      [s.stratum, "edge recall", ...rateCells(s.recall)],
      ...(s.stratum === "no-sample-controls"
        ? [[s.stratum, "hallucinated-sample rate", ...rateCells(s.hallucination)]]
        : []),
    ]);
    lines.push(
      "## Per stratum (row d)",
      "",
      table(["stratum", "metric", "value", "n", CI_HEADER], rows),
      "",
    );
    json.strata = result.strata.map((s) => ({
      stratum: s.stratum,
      identity: plainRate(s.identity),
      recall: plainRate(s.recall),
      hallucination: plainRate(s.hallucination),
    }));
  }

  const v = result.variance;
  if (v.pairs > 0) {
    lines.push(
      "## Run-to-run variance (row d, tracks run twice)",
      "",
      table(
        ["metric", "value", "n", CI_HEADER],
        [
          ["Jaccard index of claims (mean)", ...statCells(v.claims, decimal)],
          ["Jaccard index of edges (mean)", ...statCells(v.edges, decimal)],
        ],
      ),
      "",
    );
    json.variance = { pairs: v.pairs, claims: plainStat(v.claims), edges: plainStat(v.edges) };
  } else {
    lines.push("## Run-to-run variance", "", "Pending: no track was run twice.", "");
    json.pending.push("variance");
  }

  if (extras?.classifier) renderClassifier(extras, lines, json);
  else {
    lines.push(
      "## Verifier as a classifier",
      "",
      "Pending: no judge recording of `evals/perturb.jsonl`. The numeric check's catch and false-positive rates on the same set are printed by `node evals/agent/perturb-check.mjs`.",
      "",
    );
    json.pending.push("verifier-classifier");
  }
  lines.push(
    "## Agreement with human labels",
    "",
    "Pending: no labels from people exist. `node evals/agent/export-labels.mjs` writes the claims to label, without verdicts.",
    "",
  );
  json.pending.push("human-agreement");

  const misses = p ? unmatched(p.scored) : [];
  json.unmatched = misses;
  lines.push("## Unmatched proposed edges (row d)", "");
  if (misses.length === 0) lines.push("None.", "");
  else {
    for (const m of misses) {
      const why =
        m.outcome === "fp"
          ? `false positive (${m.why})`
          : "left out (gold is not exhaustive and an evidence sentence states it)";
      lines.push(
        `- \`${m.isrc}\`: "${escapeMd(m.target.title)}" ${m.target.artist ? `by ${escapeMd(m.target.artist)}` : "with no artist"}, ${m.relation}${m.origin ? `, ${m.origin}` : ""}: ${why}`,
      );
    }
    lines.push("");
  }
  return { md: `${lines.join("\n").trimEnd()}\n`, json: `${JSON.stringify(json, null, 2)}\n` };
}

const list = (xs) => (xs.length ? xs.map((x) => `\`${x}\``).join(", ") : "none recorded");

/** The header's lines on the models: which wrote, which judged, and the missing second judge. */
function modelLines(m) {
  const baselineIsJudge = m.baseline.some((d) => m.judges.includes(d));
  return [
    `- **Models**: the pipeline writes on ${list(m.generatorTiers)} and judges on ${list(m.judges)}; ${m.judgeIsGenerator ? "**the judge's model also writes in the pipeline**" : "the judge's model writes nothing the judge reads"}. The model-only baseline (row a) runs on ${list(m.baseline)}${baselineIsJudge ? ", the judge's model, so it is never judged" : " and is never judged"}: none of its claims is shown as sourced. All of this is read from the spend lines the run records keep.`,
    "- **Second judge**: none. A judge from another model family (Gemini) is unavailable: the app's Gemini provider is not implemented and refuses every call (`LLM_PROVIDER=gemini`, `apps/api/src/llm/factory.ts`), so every verdict here comes from one judge model.",
  ];
}

/** Cost per model tier and the sources the runs could not read. */
function renderExtras(extras, lines, json) {
  const tierRows = extras.perTier.flatMap((t) => {
    const name = `${t.tier} (${t.deployments.join(", ")})`;
    return [
      [`${name}: calls per analysis (mean)`, ...statCells(t.calls, decimal)],
      [`${name}: tokens per analysis (mean)`, ...statCells(t.tokens, tokens)],
      [`${name}: USD per analysis (mean)`, ...statCells(t.usd, usd)],
    ];
  });
  lines.push(
    "## Cost per model tier (row d)",
    "",
    "From the spend lines of each run (the app's own accounting: input and output tokens as the provider reported them, reasoning included in output, at the prices in `apps/api/src/llm/prices.ts`).",
    "",
    table(["metric", "value", "n", CI_HEADER], tierRows),
    "",
  );
  json.perTier = extras.perTier.map((t) => ({
    tier: t.tier,
    deployments: t.deployments,
    calls: plainStat(t.calls),
    tokens: plainStat(t.tokens),
    usd: plainStat(t.usd),
  }));
  const s = extras.sources;
  lines.push(
    "## Sources the runs could not read (row d)",
    "",
    "Every run is kept and counted whatever its sources answered; no run was repeated to get a better answer. A source with no credential configured is not an error of the run and is listed apart.",
    "",
    table(
      ["metric", "value", "n", CI_HEADER],
      [
        ["runs with at least one source error (source-error rate)", ...rateCells(s.any)],
        ...s.bySource.map((b) => [`runs where ${b.key}`, ...rateCells(b)]),
      ],
    ),
    "",
    `Not configured in these runs: ${s.notConfigured.length ? s.notConfigured.join(", ") : "none"}. Runs with no result: ${s.failed.length ? s.failed.map((f) => `\`${f.isrc}\` (${escapeMd(f.outcome)})`).join(", ") : "none"}.`,
    "",
  );
  json.sources = {
    any: plainRate(s.any),
    bySource: s.bySource.map((b) => ({ key: b.key, ...plainRate(b) })),
    notConfigured: s.notConfigured,
    failed: s.failed,
  };
  json.models = extras.models;
}

/** The claims each row shows as sourced. */
function sourcedClaimLines(sc, json) {
  const ids = Object.keys(sc);
  if (!ids.length) return [];
  json.sourcedClaims = Object.fromEntries(ids.map((id) => [id, plainRate(sc[id])]));
  return [
    table(
      ["row", "what it runs", "claims shown as sourced", "value", "n", CI_HEADER],
      ids.map((id) => [
        id,
        ABLATIONS[id],
        id === "a" ? "0 by construction (no evidence, never judged)" : "kind sourced",
        ...rateCells(sc[id]),
      ]),
    ),
    "",
  ];
}

/** The verifier as a classifier, from the judge record and the audit of its model positives. */
function renderClassifier(extras, lines, json) {
  const c = extras.classifier;
  const rows = [
    ["all positives rejected (false-positive rate)", ...rateCells(c.overall.falsePositive)],
    ["all mutations rejected (catch rate)", ...rateCells(c.overall.catch)],
    ...c.bySource.flatMap((b) => [
      [`${b.source} positives rejected (false-positive rate)`, ...rateCells(b.falsePositive)],
      [`mutations of ${b.source} positives rejected (catch rate)`, ...rateCells(b.catch)],
    ]),
    ...c.byMutation.map((m) => [`mutation "${m.mutation}" rejected`, ...rateCells(m)]),
  ];
  const verdicts = Object.entries(c.verdicts)
    .map(([v, n]) => `${v === "null" ? "no verdict" : v} ${n}`)
    .join(", ");
  const pool = c.pool;
  lines.push(
    "## Verifier as a classifier",
    "",
    `The app's judge (\`judgeClaims\`, on ${list(c.judge.deployments)}) on the ${c.cases} claim cases of \`${c.perturb.path}\` (sha256 \`${c.perturb.sha256}\`), recorded at \`${c.commit}\`: \`${extras.judgeFile}\`, replayed at no cost from \`fixtures/cassettes/llm/perturb\`. A statement is never judged beside its own mutation. A case is rejected when its verdict would not show it as sourced (the app's rule: \`supported\`, or \`partial\` for a statement that asserts no relation); a case the judge did not reach counts as rejected. Verdicts: ${verdicts}.`,
    "",
    "Positives never come from a verdict: they are code-built sourced claims (supported by construction) or model claims that pass the deterministic support check (`evals/agent/lib/support.mjs`). Mutations are unsupported by their cited excerpts, which is not the same as false. A mutation counts under its positive's source.",
    "",
    table(["metric", "value", "n", CI_HEADER], rows),
    "",
    `Model-positive pool: ${pool.modelClaimsCitingEvidence} model claims of the recordings cite evidence; ${pool.passedSupportCheck} pass the support check and are the model positives, ${pool.modelClaimsCitingEvidence - pool.passedSupportCheck} are refused. The check is a conservative heuristic over English sentences, so the model positives lean towards simple sentences. The model claims come from the showcase recordings in \`fixtures/replays\` (read by \`evals/agent/make-perturb.mjs\`), which do not record which model wrote them: that the judge never judged its own model's text there cannot be shown from the committed files.`,
    "",
  );
  json.classifier = {
    judgeFile: extras.judgeFile,
    cases: c.cases,
    unjudged: c.unjudged,
    verdicts: c.verdicts,
    overall: {
      falsePositive: plainRate(c.overall.falsePositive),
      catch: plainRate(c.overall.catch),
    },
    bySource: c.bySource.map((b) => ({
      source: b.source,
      falsePositive: plainRate(b.falsePositive),
      catch: plainRate(b.catch),
    })),
    byMutation: c.byMutation.map((m) => ({ mutation: m.mutation, ...plainRate(m) })),
    pool: {
      modelClaimsCitingEvidence: pool.modelClaimsCitingEvidence,
      passedSupportCheck: pool.passedSupportCheck,
    },
  };
  const a = extras.audit;
  if (!a) {
    lines.push("Audit of the model positives: pending.", "");
    json.pending.push("model-positive-audit");
    return;
  }
  const stated = a.positives.filter((x) => x.stated).length;
  const refusedStated = a.refused.filter((x) => x.stated);
  const lenient = [...a.positives, ...a.refused].filter((x) => x.stated && x.lenient);
  const strict = (xs) => xs.filter((x) => x.stated && !x.lenient).length;
  const strictly = (xs) =>
    xs.some((x) => x.stated && x.lenient)
      ? `, ${strict(xs)} of ${xs.length} on the strictest reading`
      : "";
  const reading = (x) => (x.lenient ? " on a lenient reading" : "");
  lines.push(
    "### Audit of the model positives",
    "",
    `${a.method} Positives stated by their excerpts: ${stated} of ${a.positives.length}${strictly(a.positives)}. Refused claims stated by their excerpts (correct claims the check refused): ${refusedStated.length} of ${a.refused.length}${strictly(a.refused)}${lenient.length ? ` (lenient: ${lenient.map((x) => `\`${x.id}\``).join(", ")})` : ""}.`,
    "",
    ...a.positives.map(
      (x) =>
        `- positive \`${x.id}\`: ${x.stated ? `stated${reading(x)}` : "**not stated**"}. ${escapeMd(x.note)}`,
    ),
    ...a.refused.map(
      (x) =>
        `- refused \`${x.id}\`: ${x.stated ? `stated${reading(x)} (a correct claim the check refused)` : "not stated"}. ${escapeMd(x.note)}`,
    ),
    "",
  );
  json.audit = {
    positives: a.positives.length,
    positivesStated: stated,
    positivesStatedStrictly: strict(a.positives),
    refused: a.refused.length,
    refusedStated: refusedStated.length,
    refusedStatedStrictly: strict(a.refused),
    lenient: lenient.map((x) => x.id),
  };
}

export const SYNTHETIC_BANNER = [
  "> **Synthetic test data.** These runs were generated for the scorer's tests",
  "> (`evals/agent/testdata/make-testdata.mjs`). No number below measures the app.",
].join("\n");

function parseArgs(argv) {
  const opts = { golden: GOLDEN_PATH };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--runs") opts.runs = value();
    else if (flag === "--golden") opts.golden = value();
    else if (flag === "--out") opts.out = value();
    else if (flag === "--date") opts.date = value();
    else if (flag === "--commit") opts.commit = value();
    else if (flag === "--subset") opts.subset = value();
    else throw new Error(`unknown argument ${flag}`);
  }
  if (!opts.runs) throw new Error("--runs <dir> is required");
  if (opts.date && !/^\d{4}-\d{2}-\d{2}$/.test(opts.date)) throw new Error("--date: YYYY-MM-DD");
  return opts;
}

/**
 * Scores the run records in `opts.runs` and renders the report; used by the CLI, eval.mjs and
 * check-report.mjs (which re-renders a report to compare it).
 */
export async function buildReport(opts) {
  const golden = readGolden(resolve(REPO_ROOT, opts.golden ?? GOLDEN_PATH));
  const runsPath = resolve(REPO_ROOT, opts.runs);
  let runs = readRuns(runsPath);
  let keep = null;
  if (opts.subset) {
    const rows = subsetRows(golden, opts.subset);
    keep = new Set(rows.map((r) => r.isrc));
    runs = runs.filter((r) => keep.has(r.isrc));
    // Every subset row needs a first run in row d and in every other row that was run: a track
    // that crashed must not leave the denominators unnoticed.
    const ablations = new Set(["d", ...runs.map((r) => r.ablation)]);
    const missing = [...ablations].sort().flatMap((id) => {
      const have = new Set(
        runs.filter((r) => r.ablation === id && (r.repeat ?? 0) === 0).map((r) => r.isrc),
      );
      const lacking = rows.filter((r) => !have.has(r.isrc));
      return lacking.length
        ? [`row ${id}: ${lacking.map((r) => `${r.isrc} (${r.title})`).join(", ")}`]
        : [];
    });
    if (missing.length) {
      throw new Error(`subset ${opts.subset} has rows with no run record: ${missing.join("; ")}`);
    }
  }
  if (runs.length === 0) throw new Error(`no run records in ${opts.runs}`);
  const result = scoreAll(golden, runs, { subset: opts.subset });
  const perturb = readPerturbRecords(runsPath);
  const kept = runs.filter((r) => keep === null || keep.has(r.isrc));
  // Records from the live harness carry their spend lines; the synthetic test data does not, and
  // its report has none of these sections.
  const recorded = kept.some((r) => Array.isArray(r.calls));
  const extras =
    recorded || perturb.judge
      ? {
          models: recorded ? models(kept) : null,
          perTier: recorded ? perTier(kept) : null,
          sources: recorded ? sourceErrors(kept) : null,
          sourcedClaims: recorded ? sourcedClaims(kept) : null,
          classifier: classifier(perturb.judge),
          audit: perturb.audit,
          judgeFile: perturb.judge
            ? `${relative(REPO_ROOT, runsPath)}/${PERTURB_DIR}/${JUDGE_FILE}`
            : null,
        }
      : null;
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const label = (path) => relative(REPO_ROOT, path) || path;
  return {
    date,
    ...renderReport(golden, result, {
      date,
      commit: opts.commit ?? gitCommit(),
      goldenLabel: label(golden.path),
      runsLabel: label(runsPath),
      runsSha: runsSha256(runsPath),
      jsonName: opts.jsonName,
      extras,
      provenance: readProvenance(runsPath),
    }),
  };
}

/** Is a path inside a directory named `testdata`? */
export const inTestdata = (path) => resolve(path).split(/[\\/]/).includes("testdata");

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`report: ${error.message}`);
    process.exit(2);
  }
  if (opts.out) {
    const reports = join(REPO_ROOT, "evals", "reports");
    const published = !relative(reports, resolve(opts.out)).startsWith("..");
    if (published && !opts.subset) {
      console.error(
        "report: a report published in evals/reports needs --subset ci or all, so rows with no run record are named, not left out",
      );
      process.exit(1);
    }
    if (published && inTestdata(opts.runs)) {
      console.error(
        "report: run records under a testdata directory cannot be published in evals/reports",
      );
      process.exit(1);
    }
  }
  const { date, md, json } = await buildReport(opts);
  if (!opts.out) {
    process.stdout.write(md);
    return;
  }
  mkdirSync(opts.out, { recursive: true });
  writeFileSync(join(opts.out, `agent-${date}.md`), md);
  writeFileSync(join(opts.out, `agent-${date}.json`), json);
  writeFileSync(join(opts.out, "agent-latest.md"), md);
  console.log(`wrote ${join(opts.out, `agent-${date}.{md,json}`)} and agent-latest.md`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`report: ${error.message}`);
    process.exit(1);
  });
}
