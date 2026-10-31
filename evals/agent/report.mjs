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
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

/** The sha256 of a run-record directory: every *.json file, by name, in code-point order. */
export function runsSha256(dir) {
  const hash = createHash("sha256");
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .sort()) {
    hash
      .update(`${name}\0`)
      .update(readFileSync(join(dir, name)))
      .update("\0");
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
  { date, commit, goldenLabel, runsLabel, runsSha, jsonName: name },
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
    `- **Results**: \`${jsonName}\``,
    `- **Gold** is described by its sources, each read on the date given in the golden file: ${sources
      .map(
        (s) =>
          `${s.site} (${s.refs} ${s.refs === 1 ? "reference" : "references"}, read ${s.first === s.last ? s.first : `${s.first} to ${s.last}`})`,
      )
      .join("; ")}. Every gold label cites one of these sources; none comes from listening.`,
    "",
    "## How to read it",
    "",
    `- **n** is printed next to every value. Proportions carry a 95 % Wilson score interval; means, medians and p95 carry a 95 % percentile bootstrap over tracks (${BOOTSTRAP_RESAMPLES.toLocaleString("en-US")} resamples, seed ${BOOTSTRAP_SEED}). Edges and claims of one track are not independent, so pooled intervals are narrower than they should be.`,
    `- Any row with n < ${MIN_N_FOR_RATE}, in any table, is shown as counts (or the values themselves), with no rate and no interval.`,
    '- **Edges** are scored per distinct gold target, forward relations only, strictly against gold (`evals/README.md`, "Scoring edges"). One gold target gives one true positive however many spellings propose it; a gold target with a relation gold does not accept is a false positive. A proposal that matches an `otherDocumentedTargets` entry is left out of precision; on rows whose gold is not exhaustive, so is a proposal that one evidence sentence states this track uses, by that relation, naming its title and artist. **Model edge precision** covers only the edges the code did not also build.',
    "- **Held-out recall**: a gold target is held-out only when none of its sources is one the pipeline queries (a target MusicBrainz also documents can be found by echoing MusicBrainz), and it stops counting in a run whose evidence cites the site of any of its sources; an archived, translated or mirrored copy counts as its original, and a page whose site cannot be placed counts as citing every site. The held-out table gives n before and after that exclusion, and which sites removed targets.",
    "- **Pre-verifier support rate**: of the model's claims before the verifier (row c), the share the judge marked supported; a claim the judge did not reach counts as not supported.",
    "- **Clarification**: the harness answers the clarification step with the top-ranked candidate, never the gold ISRC; the clarification rate is how often the step fired.",
    `- **Ablations**: ${Object.entries(ABLATIONS)
      .map(([id, what]) => `(${id}) ${what}`)
      .join("; ")}.`,
    "",
  );

  const json = {
    version: 1,
    date,
    commit,
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

  lines.push(
    "## Verifier as a classifier",
    "",
    "Pending: no judge recording of `evals/perturb.jsonl`. The numeric check's catch and false-positive rates on the same set are printed by `node evals/agent/perturb-check.mjs`.",
    "",
    "## Agreement with human labels",
    "",
    "Pending: no labels from people exist. `node evals/agent/export-labels.mjs` writes the claims to label, without verdicts.",
    "",
  );
  json.pending.push("verifier-classifier", "human-agreement");

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
        `- \`${m.isrc}\`: "${escapeMd(m.target.title)}" by ${escapeMd(m.target.artist)}, ${m.relation}${m.origin ? `, ${m.origin}` : ""}: ${why}`,
      );
    }
    lines.push("");
  }
  return { md: `${lines.join("\n").trimEnd()}\n`, json: `${JSON.stringify(json, null, 2)}\n` };
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
  if (opts.subset) {
    const rows = subsetRows(golden, opts.subset);
    const keep = new Set(rows.map((r) => r.isrc));
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
