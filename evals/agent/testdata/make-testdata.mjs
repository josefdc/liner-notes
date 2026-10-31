#!/usr/bin/env node
// Writes the scorer's synthetic test data: run records for every live golden row (ablations a-d,
// plus a second run of the CI subset), the report rendered from them, and broken copies of that
// report that check-report.mjs must reject. Every record says `"synthetic": true`; none is a
// measurement. Deterministic: running it twice writes the same bytes (report.test.mjs checks
// that the committed files are what it writes).
//
//   node evals/agent/testdata/make-testdata.mjs

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CI_SUBSET, goldTargets, liveRows, readGolden } from "../lib/golden.mjs";
import { scoreAll } from "../lib/score.mjs";
import { rng, wilson } from "../lib/stats.mjs";
import { rateCells, renderReport } from "../report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const TESTDATA_DATE = "2026-10-31";
export const TESTDATA_COMMIT = "synthetic";

const mb = (row) => `https://musicbrainz.org/recording/${row.mbid}`;

/** One synthetic run of a golden row for an ablation. */
function makeRun(row, ablation, index, repeat, next) {
  const targets = goldTargets(row);
  const evidence = [];
  const edges = [];
  const claims = [];
  if (ablation !== "a") {
    evidence.push({
      id: `ev-mb-${row.isrc}`,
      url: mb(row),
      excerpt: `MusicBrainz recording "${row.title}" by ${row.artist}.`,
    });
    // Every third row cites a Wikipedia page; so does row d for a row whose only gold sources are
    // on Wikipedia, which takes its held-out credit away there.
    const heldOutOnly = targets.some((t) => t.sources.every((s) => s.heldOut));
    if (index % 3 === 0 || (ablation === "d" && heldOutOnly)) {
      evidence.push({
        id: `ev-wp-${row.isrc}`,
        url: "https://en.wikipedia.org/wiki/Synthetic_test_page",
        excerpt: `${row.title} is a song by ${row.artist}.`,
      });
    }
  }
  for (const [i, t] of targets.entries()) {
    const relation = [...t.relations][0];
    const target = { title: t.target.title, artist: t.target.artist };
    const id = `ev-edge-${row.isrc}-${i}`;
    // The code builds an edge only from a source it queries (MusicBrainz in this data).
    const queried = t.sources.some((s) => !s.heldOut);
    if (ablation !== "a" && queried && (index + i) % 4 !== 3) {
      evidence.push({
        id,
        url: mb(row),
        excerpt: `MusicBrainz: "${row.title}" by ${row.artist} ${relation === "cover" ? "is a cover of" : "samples"} "${target.title}" by ${target.artist}.`,
      });
      edges.push({ direction: "uses", relation, origin: "code", target, evidenceIds: [id] });
    }
    if (ablation !== "b" && next() < 0.6) {
      edges.push({ direction: "uses", relation, origin: "model", target, evidenceIds: [] });
    }
  }
  // Reverse edges are never scored.
  edges.push({
    direction: "usedBy",
    relation: "sample",
    origin: "code",
    target: { title: "Synthetic Later Track", artist: "Synthetic Artist" },
    evidenceIds: [],
  });
  // A model edge gold does not list: on an exhaustive row it is a false positive; the verifier
  // removes it from row d on every other row.
  if (ablation !== "b" && index % 5 === 1 && (ablation !== "d" || index % 2 === 0)) {
    edges.push({
      direction: "uses",
      relation: "sample",
      origin: "model",
      target: { title: "Invented Break", artist: "Nobody In Particular" },
      evidenceIds: [],
    });
  }
  if (ablation !== "b") {
    claims.push(
      {
        id: `c1-${row.isrc}`,
        text: `"${row.title}" is by ${row.artist}.`,
        origin: "model",
        verdict: ablation === "a" ? null : "supported",
      },
      {
        id: `c2-${row.isrc}-${repeat}`,
        text: `Synthetic claim ${index % 4} about "${row.title}".`,
        origin: "model",
        verdict: ablation === "a" ? null : index % 4 === 0 ? "unsupported" : "supported",
      },
    );
  }
  const pipeline = ablation === "c" || ablation === "d";
  const wrongIdentity = row.stratum === "ambiguous-titles" && index % 2 === 1;
  return {
    version: 1,
    synthetic: true,
    runId: `synthetic-${ablation}-${repeat}-${row.isrc}`,
    isrc: row.isrc,
    ablation,
    repeat,
    commit: TESTDATA_COMMIT,
    recordedAt: `${TESTDATA_DATE}T00:00:00.000Z`,
    identity: wrongIdentity
      ? { isrc: "USAAA0000001", mbid: "synthetic-other" }
      : { isrc: row.isrc, mbid: row.mbid },
    clarification: pipeline
      ? { fired: row.stratum === "ambiguous-titles" || index === 7, answer: "top-ranked" }
      : null,
    preview: pipeline ? { available: !(row.stratum === "non-english" && index % 2 === 0) } : null,
    evidence,
    edges,
    claims,
    schemaValid: pipeline ? index !== 11 : null,
    fallback: pipeline ? index === 11 : null,
    latencyMs: pipeline ? Math.round(30_000 + next() * 30_000) : null,
    usage: pipeline
      ? {
          inputTokens: Math.round(14_000 + next() * 4_000),
          outputTokens: Math.round(1_800 + next() * 1_600),
          usd: Math.round((0.009 + next() * 0.006) * 1e6) / 1e6,
        }
      : null,
  };
}

/** The synthetic run records, grouped by file name. */
export function makeRuns(golden) {
  const rows = liveRows(golden);
  const files = {};
  for (const ablation of ["a", "b", "c", "d"]) {
    // Rows c and d draw the same numbers: d is c after the verifier.
    const next = rng(100 + (ablation === "c" ? "d" : ablation).charCodeAt(0));
    files[`ablation-${ablation}.json`] = rows.map((row, i) => makeRun(row, ablation, i, 0, next));
  }
  const next = rng(200);
  files["variance.json"] = rows
    .map((row, i) => [row, i])
    .filter(([row]) => CI_SUBSET.includes(row.isrc))
    .map(([row, i]) => makeRun(row, "d", i, 1, next));
  return files;
}

const replaceOnce = (text, from, to) => {
  const hit = typeof from === "string" ? text.includes(from) : from.test(text);
  if (!hit) throw new Error(`make-testdata: ${from} not in the report`);
  return text.replace(from, to);
};

/** The table line that starts with `prefix`, as a regex for replaceOnce. */
const line = (prefix) =>
  new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\n]*$`, "m");

/** A table line's cells for k of n as the report shows them. */
const rateRow = (head, k, n) =>
  `${head} | ${rateCells({ k, n, value: n ? k / n : null, ci: wilson(k, n) }).join(" | ")} |`;

/**
 * The broken reports: each gets one thing wrong that check-report must reject, and says which in
 * its name. The `structural` ones fail the structural checks on their own; the others are
 * consistent on their face and only re-rendering from the run records catches them.
 */
export function brokenReports(md, json) {
  const lines = md.split("\n");
  const data = JSON.parse(json);
  const out = {};
  const pipelineLines = (f) => {
    let inPipeline = false;
    return lines
      .map((l) => {
        if (l.startsWith("## ")) inPipeline = l.startsWith("## Pipeline");
        return inPipeline && l.startsWith("|") ? f(l) : l;
      })
      .join("\n");
  };
  // No CI: the pipeline table without its CI column.
  out["report-no-ci.md"] = pipelineLines((l) => {
    const cells = l.split(" | ");
    cells.splice(3, 1);
    return cells
      .join(" | ")
      .replace(/ \|$/, "")
      .concat(" |")
      .replace(/\| \|$/, "|");
  });
  out["report-no-ablation-d.md"] = lines.filter((l) => !/^\| d \|/.test(l)).join("\n");
  out["report-no-clarification.md"] = lines
    .filter((l) => !l.startsWith("| clarification rate |"))
    .join("\n");
  // The pipeline table indented (still a table to some renderers) and without n or CI.
  out["report-indented-no-n.md"] = pipelineLines(
    (l) => `  ${l.split(" | ").slice(0, 2).join(" | ")} |`,
  );
  // An HTML table in place of a row.
  out["report-html-table.md"] =
    `${replaceOnce(md, line("| code-built edge coverage |"), "").replace("\n\n|", "\n|")}\n<table><tr><th>metric</th><th>value</th></tr><tr><td>code-built edge coverage</td><td>99.0 %</td></tr></table>\n`;
  // n and interval that do not belong to the value.
  out["report-ci-mismatch.md"] = replaceOnce(
    md,
    line("| model edge precision |"),
    "| model edge precision | 66.7 % (4/6) | 600 | [99.0 %, 99.9 %] |",
  );
  out["report-ci-not-numeric.md"] = replaceOnce(
    md,
    line("| fallback rate |"),
    "| fallback rate | 4.2 % (1/24) | 24 | [banana, 0.0 %] |",
  );
  out["report-ci-reversed.md"] = replaceOnce(
    md,
    line("| latency p50 |"),
    "| latency p50 | 49.4 s | 24 | [51.3 s, 44.4 s] |",
  );
  // Made-up ablation numbers whose intervals are not theirs.
  out["report-fake-ablation.md"] = replaceOnce(
    replaceOnce(
      md,
      line("| d | pipeline after the verifier (what the UI shows) | edge precision"),
      "| d | pipeline after the verifier (what the UI shows) | edge precision (all proposed edges) | 100.0 % (17/17) | 17 | [99.5 %, 100.0 %] |",
    ),
    line("| d | pipeline after the verifier (what the UI shows) | hallucinated-sample rate"),
    "| d | pipeline after the verifier (what the UI shows) | hallucinated-sample rate | 0.0 % (0/5) | 5 | [0.0 %, 0.1 %] |",
  );
  // Made-up numbers with their own correct Wilson interval: only the run records show it.
  out["report-fake-consistent.md"] = replaceOnce(
    md,
    line("| d | pipeline after the verifier (what the UI shows) | edge recall"),
    rateRow("| d | pipeline after the verifier (what the UI shows) | edge recall", 16, 16),
  );
  // Held-out not excluded: every held-out target counted whatever the run cites, in the report
  // and in its results file alike.
  let heldOut = md.replaceAll("report-good.json", "report-heldout-unexcluded.json");
  const unexcluded = JSON.parse(json);
  for (const [id, h] of Object.entries(unexcluded.heldOut)) {
    let found = 0;
    for (const run of h.perRun) {
      run.citedSites = [];
      for (const t of run.targets) {
        t.counted = true;
        t.excludedBy = [];
        if (t.found) found++;
      }
    }
    h.excluded = 0;
    h.nAfterExclusion = h.gold;
    h.found = found;
    h.excludedBySite = {};
    heldOut = replaceOnce(
      heldOut,
      line(`| ${id} | ${h.gold} | `),
      rateRow(`| ${id} | ${h.gold} | 0`, found, h.gold),
    );
    heldOut = replaceOnce(
      heldOut,
      line(`| ${id} | ${data.ablations[id].what} | held-out edge recall`),
      rateRow(`| ${id} | ${data.ablations[id].what} | held-out edge recall`, found, h.gold),
    );
  }
  out["report-heldout-unexcluded.md"] = heldOut;
  out["report-heldout-unexcluded.json"] = `${JSON.stringify(unexcluded, null, 2)}\n`;
  // Labels described as made by people, in the gold line and on a line of their own.
  out["report-human-labelled.md"] = replaceOnce(
    md,
    "none comes from listening.",
    "none comes from listening. Every edge was Human-labelled by two annotators; hand-labelled where sources disagree.",
  );
  out["report-human-elsewhere.md"] = replaceOnce(
    md,
    "- **Date**:",
    "- **Labels**: gold is labelled by the author.\n- **Date**:",
  );
  // A stratum with n < 10 shown as a rate, and as a decimal.
  out["report-stratum-rate.md"] = replaceOnce(
    md,
    line("| no-sample-controls | hallucinated-sample rate |"),
    "| no-sample-controls | hallucinated-sample rate | 20.0 % (1/5) | 5 | [3.6 %, 62.4 %] |",
  );
  out["report-stratum-decimal.md"] = replaceOnce(
    md,
    line("| no-sample-controls | hallucinated-sample rate |"),
    "| no-sample-controls | hallucinated-sample rate | rate 0.20 | 5 | counts only (n < 10) |",
  );
  // Synthetic runs presented as a measurement.
  out["report-synthetic-no-banner.md"] = md.replace(/^> .*\n/gm, "").replace(/^\n\n/m, "\n");
  // "not measured" where the runs have n = 24.
  out["report-not-measured.md"] = replaceOnce(
    md,
    line("| clarification rate |"),
    "| clarification rate | not measured | 24 | [4.3 %, 31.0 %] |",
  );
  return out;
}

/** What runsSha256 gives for the runs/ files about to be written. */
function runFilesSha256(files) {
  const hash = createHash("sha256");
  for (const path of Object.keys(files)
    .filter((p) => p.startsWith("runs/") && p.endsWith(".json"))
    .map((p) => p.slice("runs/".length))
    .sort()) {
    hash.update(`${path}\0`).update(files[`runs/${path}`]).update("\0");
  }
  return hash.digest("hex");
}

/** Every test-data file, by path relative to evals/agent/testdata. */
export function testdataFiles() {
  const golden = readGolden();
  const runFiles = makeRuns(golden);
  const out = {};
  for (const [name, runs] of Object.entries(runFiles)) {
    out[`runs/${name}`] = `${JSON.stringify(runs, null, 2)}\n`;
  }
  const result = scoreAll(golden, Object.values(runFiles).flat(), { subset: "all" });
  const { md, json } = renderReport(golden, result, {
    date: TESTDATA_DATE,
    commit: TESTDATA_COMMIT,
    goldenLabel: "evals/golden.jsonl",
    runsLabel: "evals/agent/testdata/runs",
    runsSha: runFilesSha256(out),
    jsonName: "report-good.json",
  });
  out["report-good.md"] = md;
  out["report-good.json"] = json;
  Object.assign(out, brokenReports(md, json));
  return out;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  for (const [path, text] of Object.entries(testdataFiles())) {
    mkdirSync(dirname(join(HERE, path)), { recursive: true });
    writeFileSync(join(HERE, path), text);
    console.log(`wrote evals/agent/testdata/${path}`);
  }
}
