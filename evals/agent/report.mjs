#!/usr/bin/env node
// Renders the agent eval report from run records (see lib/score.mjs for their shape).
//
//   node evals/agent/report.mjs --runs <dir>                      print the report (Markdown)
//   node evals/agent/report.mjs --runs <dir> --out evals/reports  write agent-<date>.md, .json
//                                                                 and agent-latest.md there
// Options: --golden <path> (default evals/golden.jsonl), --subset ci|all (score only those
// rows), --date YYYY-MM-DD (default: today, UTC), --commit <sha> (default: git HEAD).
// `npm run eval:table -- --runs <dir>` is the same as the first form.
//
// No network and no model: it only reads the run records and the golden file.

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
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

/** A proportion as value and CI cells; counts only below MIN_N_FOR_RATE when asked. */
function rateCells(r, { countsOnly = false } = {}) {
  if (r.n === 0) return ["no data", 0, "none (n = 0)"];
  if (countsOnly) return [`${r.k}/${r.n}`, r.n, `counts only (n < ${MIN_N_FOR_RATE})`];
  return [`${pct(r.value)} (${r.k}/${r.n})`, r.n, `[${pct(r.ci[0])}, ${pct(r.ci[1])}]`];
}

function statCells(s, format) {
  if (s.n === 0) return ["no data", 0, "none (n = 0)"];
  return [format(s.value), s.n, `[${format(s.ci[0])}, ${format(s.ci[1])}]`];
}

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

/** The held-out detail the checker re-derives: per run, the cited sites and each target. */
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
      })),
  );
}

const plainRate = ({ k, n, value, ci }) => ({ k, n, value, ci });
const plainStat = ({ n, value, ci }) => ({ n, value, ci });

/** Renders { md, json } from scored results and the report's metadata. */
export function renderReport(golden, result, { date, commit, goldenLabel, jsonName: name }) {
  const jsonName = name ?? `agent-${date}.json`;
  const live = liveRows(golden);
  const sources = goldSources(live);
  const p = result.pipeline;
  const lines = [];
  lines.push(`# Agent evals, ${date}`, "");
  if (result.synthetic) {
    lines.push(
      "> **Synthetic test data.** These runs were generated for the scorer's tests",
      "> (`evals/agent/testdata/make-testdata.mjs`). No number below measures the app.",
      "",
    );
  }
  lines.push(
    `- **Dataset**: \`${goldenLabel}\`, sha256 \`${golden.sha256}\`; ${golden.rows.length} rows, ${live.length} in the live subset.`,
    `- **Runs scored**: ${result.runs} run records over ${result.tracks} tracks (subset: ${result.subset ?? "as recorded"}).`,
    `- **Date**: ${date}`,
    `- **Commit**: \`${commit}\`${result.commits.length ? ` (runs recorded at ${result.commits.map((c) => `\`${c}\``).join(", ")})` : ""}`,
    `- **Results**: \`${jsonName}\``,
    `- **Gold** is described by its sources, each read on the date given in the golden file: ${sources
      .map(
        (s) =>
          `${s.site} (${s.refs} ${s.refs === 1 ? "reference" : "references"}, read ${s.first === s.last ? s.first : `${s.first} to ${s.last}`})`,
      )
      .join(
        "; ",
      )}. No gold label in this version was made by a person listening; none is human-labelled.`,
    "",
    "## How to read it",
    "",
    `- **n** is printed next to every value. Proportions carry a 95 % Wilson score interval; means, medians and p95 carry a 95 % percentile bootstrap over tracks (${BOOTSTRAP_RESAMPLES.toLocaleString("en-US")} resamples, seed ${BOOTSTRAP_SEED}). Edges and claims of one track are not independent, so pooled intervals are narrower than they should be.`,
    `- A stratum with n < ${MIN_N_FOR_RATE} is shown as counts, not as a rate.`,
    '- **Edges** are scored per distinct gold target, forward relations only, strictly against gold (`evals/README.md`, "Scoring edges"). A proposal that matches an `otherDocumentedTargets` entry is left out of precision; on rows whose gold is not exhaustive, a proposal the run\'s evidence names is left out too.',
    "- **Held-out recall** counts a gold target as held-out in a run only while one of its held-out sources is on a site the run's evidence does not cite. The held-out table gives n before and after that exclusion.",
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
    const rows = [
      ["preview coverage", ...rateCells(p.preview), "Wilson"],
      ["identity accuracy (recording level)", ...rateCells(p.identity), "Wilson"],
      ["clarification rate", ...rateCells(p.clarification), "Wilson"],
      ["code-built edge coverage", ...rateCells(p.codeCoverage), "Wilson"],
      ["model edge precision", ...rateCells(p.modelPrecision), "Wilson"],
      ["pre-verifier support rate (model claims)", ...rateCells(p.support), "Wilson"],
      ["schema-valid rate", ...rateCells(p.schemaValid), "Wilson"],
      ["fallback rate", ...rateCells(p.fallback), "Wilson"],
      ["latency p50", ...statCells(p.latencyP50, seconds), "bootstrap"],
      ["latency p95", ...statCells(p.latencyP95, seconds), "bootstrap"],
      ["tokens per analysis (mean)", ...statCells(p.tokens, tokens), "bootstrap"],
      ["USD per analysis (mean)", ...statCells(p.usd, usd), "bootstrap"],
    ];
    lines.push(
      "## Pipeline (row d, after the verifier)",
      "",
      table(["metric", "value", "n", CI_HEADER, "interval"], rows),
      "",
    );
    json.pipeline = {
      tracks: p.tracks,
      ...Object.fromEntries(
        ["preview", "identity", "clarification", "codeCoverage", "modelPrecision"]
          .concat(["support", "schemaValid", "fallback"])
          .map((k) => [k, plainRate(p[k])]),
      ),
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
    heldOutRows.push([
      id,
      a.heldOut.gold,
      a.heldOut.excluded,
      a.heldOut.n,
      a.heldOut.k,
      ...(a.heldOut.n === 0
        ? ["no data", "none (n = 0)"]
        : [pct(a.heldOut.value), `[${pct(a.heldOut.ci[0])}, ${pct(a.heldOut.ci[1])}]`]),
    ]);
    json.ablations[id] = {
      what,
      tracks: a.tracks,
      recall: plainRate(a.recall),
      precision: plainRate(a.precision),
      modelPrecision: plainRate(a.modelPrecision),
      heldOutRecall: plainRate(a.heldOut),
      hallucination: plainRate(a.hallucination),
      edgesPerControl: plainStat(a.edgesPerControl),
    };
    json.heldOut[id] = {
      gold: a.heldOut.gold,
      excluded: a.heldOut.excluded,
      nAfterExclusion: a.heldOut.n,
      found: a.heldOut.k,
      perRun: heldOutDetail(a.scored),
    };
  }
  lines.push(
    "## Ablations",
    "",
    table(["row", "what it runs", "metric", "value", "n", CI_HEADER], ablationRows),
    "",
    "## Held-out recall after the per-run domain exclusion",
    "",
    table(
      [
        "row",
        "held-out gold targets",
        "excluded (run cites the source's site)",
        "n after exclusion",
        "found",
        "recall",
        CI_HEADER,
      ],
      heldOutRows,
    ),
    "",
  );

  if (result.strata.length) {
    const rows = result.strata.flatMap((s) => [
      [
        s.stratum,
        "identity accuracy",
        ...rateCells(s.identity, { countsOnly: s.identity.countsOnly }),
      ],
      [s.stratum, "edge recall", ...rateCells(s.recall, { countsOnly: s.recall.countsOnly })],
      ...(s.stratum === "no-sample-controls"
        ? [
            [
              s.stratum,
              "hallucinated-sample rate",
              ...rateCells(s.hallucination, { countsOnly: s.hallucination.countsOnly }),
            ],
          ]
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
    "Pending: no human labels. `node evals/agent/export-labels.mjs` writes the claims to label, without verdicts.",
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
          ? "false positive"
          : "left out (gold is not exhaustive and the run's evidence names it)";
      lines.push(
        `- \`${m.isrc}\`: "${m.target.title}" by ${m.target.artist}, ${m.relation}${m.origin ? `, ${m.origin}` : ""}: ${why}`,
      );
    }
    lines.push("");
  }
  return { md: `${lines.join("\n").trimEnd()}\n`, json: `${JSON.stringify(json, null, 2)}\n` };
}

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

/** Scores the runs in `runs` and renders the report; used by the CLI and by eval.mjs. */
export async function buildReport(opts) {
  const golden = readGolden(resolve(opts.golden ?? GOLDEN_PATH));
  let runs = readRuns(resolve(opts.runs));
  if (opts.subset) {
    const keep = new Set(subsetRows(golden, opts.subset).map((r) => r.isrc));
    runs = runs.filter((r) => keep.has(r.isrc));
  }
  if (runs.length === 0) throw new Error(`no run records in ${opts.runs}`);
  const result = scoreAll(golden, runs, { subset: opts.subset });
  const date = opts.date ?? new Date().toISOString().slice(0, 10);
  const goldenLabel = relative(REPO_ROOT, golden.path) || golden.path;
  return {
    date,
    ...renderReport(golden, result, { date, commit: opts.commit ?? gitCommit(), goldenLabel }),
  };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`report: ${error.message}`);
    process.exit(2);
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
