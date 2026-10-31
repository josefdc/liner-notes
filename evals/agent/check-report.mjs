#!/usr/bin/env node
// Checks an agent eval report (evals/reports/agent-latest.md or a dated one) for what #33 asks of
// it, and exits 1 naming every part that is missing:
// - the header states the dataset with the golden file's sha256, the date, the commit, the
//   results file and where gold comes from (never "human-labelled" unless a person labelled it);
// - every table has an n column and a 95 % CI column, and every row of it an integer n and an
//   interval (or, only where n is 0, "none (n = 0)"; only where n < 10, "counts only");
// - a stratum with n < 10 is shown as counts, not as a rate;
// - the ablation table has rows a, b, c and d;
// - the clarification rate is reported with its interval;
// - held-out recall is after the per-run domain exclusion: the held-out table gives n before and
//   after it, they add up, the ablation table uses the n after it, and the results file shows,
//   run by run, that no counted target has all its held-out sources on sites the run cites.
//
//   node evals/agent/check-report.mjs evals/reports/agent-latest.md

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CI = "95 % CI";
const ABLATION_ROWS = ["a", "b", "c", "d"];
const HELD_OUT_HEADING = "Held-out recall after the per-run domain exclusion";

/** Splits Markdown into sections (by "## " heading) holding their tables. */
export function parseReport(md) {
  const sections = [{ heading: "(top)", lines: [], tables: [] }];
  let table = null;
  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      sections.push({ heading: line.slice(3).trim(), lines: [], tables: [] });
      table = null;
      continue;
    }
    const section = sections.at(-1);
    section.lines.push(line);
    if (line.startsWith("|")) {
      const cells = line
        .replace(/^\|\s?/, "")
        .replace(/\s?\|\s*$/, "")
        .split(/\s\|\s/)
        .map((c) => c.trim().replace(/\\\|/g, "|"));
      if (!table) {
        table = { head: cells, rows: [] };
        section.tables.push(table);
      } else if (!cells.every((c) => /^-+$/.test(c))) table.rows.push(cells);
    } else table = null;
  }
  return sections;
}

const isInterval = (s) => /^\[[^,[\]]+, [^,[\]]+\]$/.test(s);

function checkTables(sections, problems) {
  let tables = 0;
  for (const section of sections) {
    for (const [ti, t] of section.tables.entries()) {
      tables++;
      const name = `table ${ti + 1} in "${section.heading}"`;
      const nCol = t.head.findIndex((h) => h === "n" || h.startsWith("n "));
      const ciCol = t.head.indexOf(CI);
      if (nCol < 0) problems.push(`${name}: no n column`);
      if (ciCol < 0) problems.push(`${name}: no "${CI}" column`);
      if (nCol < 0 || ciCol < 0) continue;
      for (const row of t.rows) {
        const label = `${name}, row "${row.slice(0, 3).join(" | ")}"`;
        if (row.length !== t.head.length) {
          problems.push(`${label}: ${row.length} cells for ${t.head.length} columns`);
          continue;
        }
        const n = Number(row[nCol]);
        const ci = row[ciCol];
        if (!Number.isInteger(n) || n < 0) {
          problems.push(`${label}: n is not a count ("${row[nCol]}")`);
          continue;
        }
        if (n === 0 ? ci !== "none (n = 0)" : !isInterval(ci) && !ci.startsWith("counts only")) {
          problems.push(`${label}: no 95 % confidence interval ("${ci}")`);
        }
        if (ci.startsWith("counts only") && n >= 10) {
          problems.push(`${label}: counts only although n = ${n}`);
        }
        if (section.heading.startsWith("Per stratum") && n > 0 && n < 10) {
          if (!ci.startsWith("counts only") || row.some((c) => /%/.test(c))) {
            problems.push(`${label}: a stratum with n < 10 must be shown as counts, not a rate`);
          }
        }
      }
    }
  }
  if (tables === 0) problems.push("no tables");
}

function checkHeader(md, problems) {
  const top = md.split("\n## ")[0];
  if (!/\*\*Dataset\*\*:.*sha256 `[0-9a-f]{64}`/.test(top)) {
    problems.push("header: dataset with the golden file's sha256");
  }
  if (!/\*\*Date\*\*: \d{4}-\d{2}-\d{2}/.test(top)) problems.push("header: date");
  if (!/\*\*Commit\*\*: `[^`]+`/.test(top)) problems.push("header: commit");
  if (!/\*\*Results\*\*: `[^`]+\.json`/.test(top)) problems.push("header: results file");
  const gold = top.match(/\*\*Gold\*\*[^\n]*/)?.[0];
  if (!gold || !/described by its sources/.test(gold)) {
    problems.push("header: where gold comes from (its sources and dates)");
  } else if (/human-labelled/.test(gold) && !/none is human-labelled/.test(gold)) {
    problems.push("header: gold is described as human-labelled");
  }
}

const find = (sections, prefix) => sections.find((s) => s.heading.startsWith(prefix));

function checkAblations(sections, problems) {
  const section = find(sections, "Ablations");
  const t = section?.tables[0];
  if (!t) {
    problems.push('section "Ablations" with its table');
    return null;
  }
  const rowCol = t.head.indexOf("row");
  const present = new Set(t.rows.map((r) => r[rowCol]));
  for (const id of ABLATION_ROWS) {
    if (!present.has(id)) problems.push(`ablation row ${id}`);
  }
  return t;
}

function checkClarification(sections, problems) {
  const rows = sections.flatMap((s) => s.tables.flatMap((t) => t.rows.map((r) => [t, r])));
  const hit = rows.find(([, r]) => r[0].startsWith("clarification rate"));
  if (!hit) {
    problems.push("clarification rate");
    return;
  }
  const [t, r] = hit;
  const ci = r[t.head.indexOf(CI)];
  if (!ci || !(isInterval(ci) || ci === "none (n = 0)")) {
    problems.push("clarification rate: its 95 % confidence interval");
  }
}

function checkHeldOut(sections, ablationTable, md, path, problems) {
  const t = find(sections, HELD_OUT_HEADING)?.tables[0];
  if (!t) {
    problems.push(`section "${HELD_OUT_HEADING}" with its table (held-out n after exclusion)`);
    return;
  }
  const col = (prefix) => t.head.findIndex((h) => h.startsWith(prefix));
  const [row, gold, excluded, after] = [
    col("row"),
    col("held-out gold"),
    col("excluded"),
    col("n after exclusion"),
  ];
  if ([row, gold, excluded, after].some((i) => i < 0)) {
    problems.push(
      "held-out table: columns row, held-out gold targets, excluded, n after exclusion",
    );
    return;
  }
  const table = new Map(
    t.rows.map((r) => [r[row], { gold: +r[gold], excluded: +r[excluded], after: +r[after] }]),
  );
  for (const [id, h] of table) {
    if (h.after !== h.gold - h.excluded) {
      problems.push(
        `held-out row ${id}: n after exclusion ${h.after} != ${h.gold} - ${h.excluded}`,
      );
    }
  }
  if (ablationTable) {
    const [rCol, mCol, nCol] = ["row", "metric", "n"].map((h) => ablationTable.head.indexOf(h));
    for (const r of ablationTable.rows) {
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
  const name = md.match(/\*\*Results\*\*: `([^`]+\.json)`/)?.[1];
  if (!name) return;
  const jsonPath = join(dirname(path), name);
  if (!existsSync(jsonPath)) {
    problems.push(`results file ${name} (needed to check the per-run held-out exclusion)`);
    return;
  }
  const data = JSON.parse(readFileSync(jsonPath, "utf8"));
  for (const [id, h] of Object.entries(data.heldOut ?? {})) {
    let counted = 0;
    const wrong = [];
    for (const run of h.perRun ?? []) {
      const cited = new Set(run.citedSites ?? []);
      for (const target of run.targets ?? []) {
        const shouldCount = target.heldOutSites.some((s) => !cited.has(s));
        if (target.counted) counted++;
        if (target.counted !== shouldCount) wrong.push(`${run.runId ?? run.isrc}: ${target.key}`);
      }
    }
    if (wrong.length) {
      problems.push(
        `held-out row ${id}: ${wrong.length} target(s) counted against the per-run domain exclusion (${wrong.slice(0, 3).join("; ")}${wrong.length > 3 ? "; …" : ""})`,
      );
    }
    if (counted !== h.nAfterExclusion) {
      problems.push(
        `held-out row ${id}: ${counted} counted targets, n after exclusion says ${h.nAfterExclusion}`,
      );
    }
    const md = table.get(id);
    if (md && md.after !== h.nAfterExclusion) {
      problems.push(`held-out row ${id}: the report's n after exclusion differs from ${name}`);
    }
  }
}

/** Every problem found in the report at `path`; empty when it passes. */
export function checkReport(path) {
  const md = readFileSync(path, "utf8");
  const sections = parseReport(md);
  const problems = [];
  checkHeader(md, problems);
  checkTables(sections, problems);
  const ablations = checkAblations(sections, problems);
  checkClarification(sections, problems);
  checkHeldOut(sections, ablations, md, path, problems);
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
  const problems = checkReport(path);
  if (problems.length) {
    console.error(`check-report: ${path} is missing ${problems.length} part(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(
    `check-report: ${path} ok (tables with n and 95 % CI, ablation rows a-d, clarification rate, held-out n after exclusion)`,
  );
}
