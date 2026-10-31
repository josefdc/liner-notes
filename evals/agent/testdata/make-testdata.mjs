#!/usr/bin/env node
// Writes the scorer's synthetic test data: run records for every live golden row (ablations a-d,
// plus a second run of the CI subset), the report rendered from them, and broken copies of that
// report that check-report.mjs must reject. Every record says `"synthetic": true`; none is a
// measurement. Deterministic: running it twice writes the same bytes (report.test.mjs checks
// that the committed files are what it writes).
//
//   node evals/agent/testdata/make-testdata.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CI_SUBSET, goldTargets, liveRows, readGolden } from "../lib/golden.mjs";
import { scoreAll } from "../lib/score.mjs";
import { rng } from "../lib/stats.mjs";
import { renderReport } from "../report.mjs";

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
    // Every third row cites a Wikipedia page, so its Wikipedia-sourced edges lose held-out credit.
    if (index % 3 === 0) {
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
    if (ablation !== "a" && (index + i) % 4 !== 3) {
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
  if (!text.includes(from)) throw new Error(`make-testdata: "${from}" not in the report`);
  return text.replace(from, to);
};

/** The broken reports: each misses one part check-report requires. */
export function brokenReports(md, json) {
  const lines = md.split("\n");
  // No CI: drop the CI column of the pipeline table.
  const noCi = [];
  let inPipeline = false;
  for (const line of lines) {
    if (line.startsWith("## ")) inPipeline = line.startsWith("## Pipeline");
    if (inPipeline && line.startsWith("|")) {
      const cells = line.split(" | ");
      cells.splice(3, 1);
      noCi.push(cells.join(" | "));
    } else noCi.push(line);
  }
  const noAblationD = lines.filter((l) => !/^\| d \|/.test(l)).join("\n");
  const noClarification = lines.filter((l) => !l.startsWith("| clarification rate |")).join("\n");
  // Held-out not excluded: every held-out target counted, whatever the run cites.
  const data = JSON.parse(json);
  let heldOutMd = md.replaceAll("report-good.json", "report-heldout-unexcluded.json");
  for (const [id, h] of Object.entries(data.heldOut)) {
    for (const run of h.perRun) for (const t of run.targets) t.counted = true;
    const before = `| ${id} | ${h.gold} | ${h.excluded} | ${h.nAfterExclusion} |`;
    h.excluded = 0;
    h.nAfterExclusion = h.gold;
    heldOutMd = replaceOnce(heldOutMd, before, `| ${id} | ${h.gold} | 0 | ${h.gold} |`);
  }
  return {
    "report-no-ci.md": noCi.join("\n"),
    "report-no-ablation-d.md": noAblationD,
    "report-no-clarification.md": noClarification,
    "report-heldout-unexcluded.md": heldOutMd,
    "report-heldout-unexcluded.json": `${JSON.stringify(data, null, 2)}\n`,
  };
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
