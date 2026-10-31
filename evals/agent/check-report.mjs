#!/usr/bin/env node
// Checks an agent eval report (evals/reports/agent-latest.md or a dated one) for what #33 asks of
// it, and exits 1 naming every problem. Two layers:
//
// 1. Truth. The report is rendered again from the run records and the golden file its header
//    names, with its own date, commit and subset, and must equal the file byte for byte; so must
//    its results file. The held-out exclusion is re-derived from the runs' evidence, never read
//    from the results file. Synthetic run records need the synthetic-data banner and cannot be
//    published in evals/reports.
// 2. Structure, which holds even if the renderer were wrong:
//    - the header names the dataset with the golden file's sha256 (which must still match), the
//      run records, the date, the commit, the results file and where gold comes from;
//    - no label is described as made by people (human-labelled, hand-labelled, annotators,
//      labelled by a person…), anywhere in the report;
//    - every table is a Markdown table at the start of its line (no HTML, no indent) with a
//      value, an n and a "95 % CI" column;
//    - every row's value agrees with its n: below n = 10, counts "k/n" (or the values
//      themselves) with "counts only", never a rate; from n = 10, a rate "p % (k/n)" whose p and
//      Wilson interval are recomputed from k and n, or a statistic with a numeric interval
//      lo <= hi; "no data" only where n = 0;
//    - the ablation table has rows a, b, c and d; the clarification rate is reported;
//    - the held-out table gives n before and after the exclusion, they add up, and the ablation
//      table's held-out n is the one after it.
//
//   node evals/agent/check-report.mjs evals/reports/agent-latest.md

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT, readGolden } from "./lib/golden.mjs";
import { readRuns, scoreAll } from "./lib/score.mjs";
import { MIN_N_FOR_RATE, wilson } from "./lib/stats.mjs";
import {
  ALL_EQUAL,
  buildReport,
  COUNTS_ONLY,
  inTestdata,
  runsSha256,
  SYNTHETIC_BANNER,
} from "./report.mjs";

const CI = "95 % CI";
const ABLATION_ROWS = ["a", "b", "c", "d"];
const HELD_OUT_HEADING = "Held-out recall after the per-run domain exclusion";
export const REPORTS_DIR = join(REPO_ROOT, "evals", "reports");
export const MADE_BY_PEOPLE =
  /\b(?:human|hand|manual(?:ly)?|person)[-\s]?(?:labell?(?:ed|ing)|annotat(?:ed|ion|ing))\b|\bannotators?\b|\blabell?ed\s+by\s+(?:(?:a|an|one|two|three|several|the|our)\s+)?(?:persons?|people|humans?|hand|annotators?|authors?|listeners?|experts?|volunteers?|raters?)\b/i;

/** Splits Markdown into sections (by "## " heading), each with its tables. */
export function parseReport(md) {
  const sections = [{ heading: "(top)", tables: [] }];
  let table = null;
  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      sections.push({ heading: line.slice(3).trim(), tables: [] });
      table = null;
      continue;
    }
    if (!line.startsWith("|")) {
      table = null;
      continue;
    }
    const cells = line
      .replace(/^\|\s?/, "")
      .replace(/\s?\|\s*$/, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, "|"));
    if (!table) {
      table = { head: cells, rows: [] };
      sections.at(-1).tables.push(table);
    } else if (!cells.every((c) => /^:?-+:?$/.test(c))) table.rows.push(cells);
  }
  return sections;
}

const pct = (x) => `${(100 * x).toFixed(1)} %`;
const NUMBER = String.raw`-?\d+(?:\.\d+)?`;
const STAT = new RegExp(`^(?:USD )?(${NUMBER})(?: s)?$`);
const RATE = new RegExp(String.raw`^(${NUMBER}) % \((\d+)/(\d+)\)$`);

/** Problems with one table row's value, n and CI cells. */
export function checkCells(label, value, nCell, ci) {
  if (!/^\d+$/.test(nCell)) return [`${label}: n is not a count ("${nCell}")`];
  const n = Number(nCell);
  if (n === 0) {
    return value === "no data" && ci === "none (n = 0)"
      ? []
      : [`${label}: n = 0 must read "no data" and "none (n = 0)"`];
  }
  if (/no data|not measured|n\/a|pending/i.test(value)) {
    return [`${label}: "${value}" although n = ${n}`];
  }
  if (n < MIN_N_FOR_RATE) {
    const problems = [];
    if (ci !== COUNTS_ONLY) {
      problems.push(`${label}: n = ${n} < ${MIN_N_FOR_RATE} must be counts only, with no interval`);
    }
    const counts = value.match(/^(\d+)\/(\d+)$/);
    const values = value.match(/^values (.+)$/);
    if (counts) {
      if (+counts[2] !== n || +counts[1] > n) {
        problems.push(`${label}: count ${value} does not match n = ${n}`);
      }
    } else if (values) {
      const list = values[1].split(", ");
      if (list.length !== n || !list.every((v) => STAT.test(v))) {
        problems.push(`${label}: ${list.length} values for n = ${n}`);
      }
    } else {
      problems.push(
        `${label}: n = ${n} < ${MIN_N_FOR_RATE} must be shown as counts, not as a rate ("${value}")`,
      );
    }
    return problems;
  }
  if (ci.startsWith("counts only")) return [`${label}: counts only although n = ${n}`];
  const rate = value.match(RATE);
  if (rate) {
    const [k, d] = [+rate[2], +rate[3]];
    if (d !== n || k > n) return [`${label}: ${k}/${d} does not match n = ${n}`];
    const problems = [];
    if (rate[1] !== (100 * (k / n)).toFixed(1)) {
      problems.push(`${label}: ${rate[1]} % is not ${k}/${n}`);
    }
    const [lo, hi] = wilson(k, n);
    const expected = `[${pct(lo)}, ${pct(hi)}]`;
    if (ci !== expected) {
      problems.push(`${label}: interval ${ci} is not the Wilson interval ${expected} of ${k}/${n}`);
    }
    return problems;
  }
  if (!STAT.test(value)) return [`${label}: "${value}" is not a count, a rate or a statistic`];
  const equal = ci.endsWith(` ${ALL_EQUAL}`);
  const interval = (equal ? ci.slice(0, -ALL_EQUAL.length - 1) : ci).match(/^\[(.+), (.+)\]$/);
  if (!interval || !STAT.test(interval[1]) || !STAT.test(interval[2])) {
    return [`${label}: no numeric 95 % confidence interval ("${ci}")`];
  }
  const [lo, hi] = [interval[1], interval[2]].map((x) => Number(x.match(STAT)[1]));
  if (equal && lo !== hi) return [`${label}: "${ALL_EQUAL}" on an interval of width ${hi - lo}`];
  return lo <= hi ? [] : [`${label}: interval ${ci} is reversed`];
}

function checkTables(md, sections, problems) {
  if (/<\s*\/?\s*(?:table|tr|td|th)\b/i.test(md)) {
    problems.push("an HTML table: every table must be a Markdown table with n and a 95 % CI");
  }
  md.split("\n").forEach((line, i) => {
    if (/^\s+\|/.test(line)) problems.push(`line ${i + 1}: an indented table line`);
  });
  let tables = 0;
  for (const section of sections) {
    for (const [ti, t] of section.tables.entries()) {
      tables++;
      const name = `table ${ti + 1} in "${section.heading}"`;
      const nCol = t.head.findIndex((h) => h === "n" || h === "n after exclusion");
      const ciCol = t.head.indexOf(CI);
      const valueCol = t.head.findIndex((h) => h === "value" || h.startsWith("recall"));
      if (nCol < 0) problems.push(`${name}: no n column`);
      if (ciCol < 0) problems.push(`${name}: no "${CI}" column`);
      if (valueCol < 0) problems.push(`${name}: no value column`);
      if (nCol < 0 || ciCol < 0 || valueCol < 0) continue;
      for (const row of t.rows) {
        const label = `${name}, row "${row.slice(0, 3).join(" | ")}"`;
        if (row.length !== t.head.length) {
          problems.push(`${label}: ${row.length} cells for ${t.head.length} columns`);
          continue;
        }
        problems.push(...checkCells(label, row[valueCol], row[nCol], row[ciCol]));
      }
    }
  }
  if (tables === 0) problems.push("no tables");
}

/** The header fields check-report needs to render the report again. */
export function parseHeader(md) {
  const top = md.split("\n## ")[0];
  const grab = (re) => top.match(re)?.slice(1) ?? null;
  return {
    dataset: grab(/^- \*\*Dataset\*\*: `([^`]+)`, sha256 `([0-9a-f]{64})`/m),
    runs: grab(
      /^- \*\*Run records\*\*: `([^`]+)`, sha256 `([0-9a-f]{64})`;[^\n]*\(subset: ([^)]+)\)\.$/m,
    ),
    date: grab(/^- \*\*Date\*\*: (\d{4}-\d{2}-\d{2})$/m)?.[0] ?? null,
    commit: grab(/^- \*\*Commit\*\*: `([^`]+)`/m)?.[0] ?? null,
    results: grab(/^- \*\*Results\*\*: `([^`/]+\.json)`$/m)?.[0] ?? null,
    gold: top.match(/^- \*\*Gold\*\*[^\n]*/m)?.[0] ?? null,
  };
}

function checkHeader(h, md, problems) {
  if (!h.dataset) problems.push("header: the dataset with the golden file's sha256");
  if (!h.runs) problems.push("header: the run records with their sha256, and the subset");
  if (!h.date) problems.push("header: the date");
  if (!h.commit) problems.push("header: the commit");
  if (!h.results) problems.push("header: the results file");
  if (!h.gold || !/described by its sources/.test(h.gold)) {
    problems.push("header: where gold comes from (its sources and dates)");
  }
  const people = md.match(MADE_BY_PEOPLE);
  if (people) {
    problems.push(
      `labels described as made by people ("${people[0]}"); gold is described by its sources`,
    );
  }
}

function ablationTable(sections) {
  return sections
    .flatMap((s) => s.tables)
    .find((t) => ["row", "what it runs", "metric"].every((h) => t.head.includes(h)));
}

function checkAblations(t, problems) {
  if (!t) {
    problems.push("the ablation table (row, what it runs, metric)");
    return;
  }
  const present = new Set(t.rows.map((r) => r[t.head.indexOf("row")]));
  for (const id of ABLATION_ROWS) if (!present.has(id)) problems.push(`ablation row ${id}`);
}

function checkClarification(sections, problems) {
  const found = sections
    .flatMap((s) => s.tables.flatMap((t) => t.rows))
    .some((r) => r[0].startsWith("clarification rate"));
  if (!found) problems.push("the clarification rate");
}

function heldOutTable(sections) {
  const t = sections.find((s) => s.heading === HELD_OUT_HEADING)?.tables[0];
  if (!t) return null;
  const col = (prefix) => t.head.findIndex((h) => h.startsWith(prefix));
  const cols = [col("row"), col("held-out gold"), col("excluded"), col("n after exclusion")];
  if (cols.some((i) => i < 0)) return null;
  const [row, gold, excluded, after] = cols;
  return new Map(
    t.rows.map((r) => [r[row], { gold: +r[gold], excluded: +r[excluded], after: +r[after] }]),
  );
}

function checkHeldOut(sections, ablations, problems) {
  const table = heldOutTable(sections);
  if (!table) {
    problems.push(
      `section "${HELD_OUT_HEADING}" with held-out gold, excluded and n after exclusion`,
    );
    return;
  }
  for (const [id, h] of table) {
    if (h.after !== h.gold - h.excluded) {
      problems.push(
        `held-out row ${id}: n after exclusion ${h.after} != ${h.gold} - ${h.excluded}`,
      );
    }
  }
  if (!ablations) return;
  const [rCol, mCol, nCol] = ["row", "metric", "n"].map((x) => ablations.head.indexOf(x));
  for (const r of ablations.rows) {
    if (r[mCol] !== "held-out edge recall") continue;
    const h = table.get(r[rCol]);
    if (!h) problems.push(`held-out table: row ${r[rCol]}`);
    else if (+r[nCol] !== h.after) {
      problems.push(
        `ablation row ${r[rCol]}: held-out recall n ${r[nCol]} is not the n after exclusion (${h.after})`,
      );
    }
  }
}

/** The first line where two texts differ, for the message. */
function firstDifference(expected, actual) {
  const e = expected.split("\n");
  const a = actual.split("\n");
  const cut = (s) => (s === undefined ? "(nothing)" : s.length > 100 ? `${s.slice(0, 97)}...` : s);
  for (let i = 0; i < Math.max(e.length, a.length); i++) {
    if (e[i] !== a[i]) return `line ${i + 1}: expected "${cut(e[i])}", found "${cut(a[i])}"`;
  }
  return "no line differs";
}

const gitOk = (args) => {
  try {
    execFileSync("git", args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
};
const commitExists = (c) =>
  typeof c === "string" && /^[0-9a-f]{7,40}$/.test(c) && gitOk(["cat-file", "-e", `${c}^{commit}`]);

/**
 * What a report published in evals/reports must also satisfy. It cannot prove the run records
 * came from real runs; it does refuse what only test data or a substituted dataset would give.
 */
function checkPublished({ h, runsPath, runs, result }, problems, reportsDir) {
  const where = relative(REPO_ROOT, reportsDir);
  if (result.synthetic) {
    problems.push(`a report of synthetic run records cannot be published in ${where}`);
  }
  if (inTestdata(resolve(REPO_ROOT, runsPath))) {
    problems.push(`run records under a testdata directory cannot be published in ${where}`);
  }
  for (const c of new Set([h.commit, ...runs.map((r) => r.commit)])) {
    if (c === undefined) problems.push("a run record has no commit");
    else if (!commitExists(c)) problems.push(`commit ${c} is not in this repository`);
  }
}

/** A published report's dataset: evals/golden.jsonl, as it was at the report's commit. */
function checkPinnedGolden(h, goldenPath, sha, problems, where) {
  if (goldenPath !== "evals/golden.jsonl") {
    problems.push(
      `a report published in ${where} must score evals/golden.jsonl, not ${goldenPath}`,
    );
  } else if (commitExists(h.commit)) {
    let pinned = null;
    try {
      pinned = execFileSync("git", ["show", `${h.commit}:evals/golden.jsonl`], {
        cwd: REPO_ROOT,
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      problems.push(`evals/golden.jsonl does not exist at commit ${h.commit}`);
    }
    if (pinned && createHash("sha256").update(pinned).digest("hex") !== sha) {
      problems.push(`the dataset's sha256 is not evals/golden.jsonl at commit ${h.commit}`);
    }
  }
}

/** Renders the report again from what its header names, and compares. */
async function checkTruth(h, md, path, sections, problems, reportsDir) {
  if (!h.dataset || !h.runs || !h.date || !h.commit || !h.results) return;
  const [goldenPath, sha] = h.dataset;
  const [runsPath, runsSha, subsetCell] = h.runs;
  const subset = subsetCell === "as recorded" ? undefined : subsetCell;
  if (!relative(reportsDir, resolve(path)).startsWith("..")) {
    checkPinnedGolden(h, goldenPath, sha, problems, relative(REPO_ROOT, reportsDir));
  }
  let golden;
  try {
    golden = readGolden(resolve(REPO_ROOT, goldenPath));
  } catch (error) {
    problems.push(`dataset ${goldenPath}: ${error.message.split("\n")[0]}`);
    return;
  }
  if (golden.sha256 !== sha) {
    problems.push(
      `dataset ${goldenPath} is not the one scored (its sha256 is now ${golden.sha256}): render the report again`,
    );
    return;
  }
  if (!existsSync(resolve(REPO_ROOT, runsPath))) {
    problems.push(`run records ${runsPath} not found`);
    return;
  }
  const nowSha = runsSha256(resolve(REPO_ROOT, runsPath));
  if (nowSha !== runsSha) {
    problems.push(
      `run records ${runsPath} changed since the report (sha256 now ${nowSha}): render it again, or keep each run's records in a directory of its own`,
    );
    return;
  }
  let runs;
  let rendered;
  try {
    runs = readRuns(resolve(REPO_ROOT, runsPath));
    rendered = await buildReport({
      runs: runsPath,
      golden: goldenPath,
      subset,
      date: h.date,
      commit: h.commit,
      jsonName: h.results,
    });
  } catch (error) {
    problems.push(`cannot score the run records: ${error.message}`);
    return;
  }
  // The held-out exclusion, from the runs' own evidence: named on its own, as it is the easiest
  // number to get wrong by hand.
  const result = scoreAll(golden, runs, { subset });
  const table = heldOutTable(sections);
  for (const [id, a] of Object.entries(result.ablations)) {
    const row = table?.get(id);
    if (row && (row.excluded !== a.heldOut.excluded || row.after !== a.heldOut.n)) {
      problems.push(
        `held-out row ${id}: the runs' evidence excludes ${a.heldOut.excluded} of ${a.heldOut.gold} targets (n after exclusion ${a.heldOut.n}); the report says ${row.excluded} (${row.after})`,
      );
    }
  }
  if (result.synthetic && !md.includes(SYNTHETIC_BANNER)) {
    problems.push("the synthetic-data banner: the run records are synthetic");
  }
  if (!relative(reportsDir, resolve(path)).startsWith("..")) {
    checkPublished({ h, runsPath, runs, result }, problems, reportsDir);
  }
  if (rendered.md !== md) {
    problems.push(
      `the report is not what its run records give (${firstDifference(rendered.md, md)}); render it again with report.mjs`,
    );
  }
  const jsonPath = join(dirname(path), h.results);
  if (!existsSync(jsonPath)) {
    problems.push(`results file ${h.results} not found next to the report`);
  } else {
    const json = readFileSync(jsonPath, "utf8");
    if (json !== rendered.json) {
      problems.push(
        `results file ${h.results} is not what the run records give (${firstDifference(rendered.json, json)})`,
      );
    }
  }
}

/**
 * Every problem found in the report at `path`; empty when it passes. `truth: false` runs the
 * structural checks alone (the tests use it to show each holds on its own).
 */
export async function checkReport(path, { truth = true, reportsDir = REPORTS_DIR } = {}) {
  const md = readFileSync(path, "utf8");
  const sections = parseReport(md);
  const h = parseHeader(md);
  const problems = [];
  checkHeader(h, md, problems);
  checkTables(md, sections, problems);
  const ablations = ablationTable(sections);
  checkAblations(ablations, problems);
  checkClarification(sections, problems);
  checkHeldOut(sections, ablations, problems);
  if (truth) await checkTruth(h, md, path, sections, problems, resolve(reportsDir));
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) {
    console.error("usage: node evals/agent/check-report.mjs <report.md>");
    process.exit(2);
  }
  if (!existsSync(path)) {
    console.error(`check-report: ${path} does not exist`);
    process.exit(1);
  }
  const problems = await checkReport(path).catch((error) => [`cannot check: ${error.message}`]);
  if (problems.length) {
    console.error(`check-report: ${path} has ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `check-report: ${path} ok (matches its run records; every table has n and a 95 % CI; ablation rows a-d; clarification rate; held-out n after the exclusion)`,
  );
}
