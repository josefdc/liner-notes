#!/usr/bin/env node
// Measured model spending, from the spend log, with the app's own rule (apps/api/src/llm/
// spendLog.ts `summarise`: a settle line replaces its reservation, a reservation with no settle
// line counts at its worst case, a line without `kind` counts as settled):
//
//   node evals/agent/spend.mjs [--log <path>] [--runs <dir>]... [--json]
//
// --log defaults to LLM_SPEND_LOG from the environment (this script never reads apps/api/.env).
// The caps are the app's (config/settings.ts), from BUDGET_* in the environment, else their
// defaults. It prints the total, the total per purpose (the log's `unit`) against each
// evaluation purpose's cap, and dev plus showcase spending against BUDGET_TOTAL_USD minus
// BUDGET_EVAL_FLOOR_USD.
//
// Harness calls: every spend line whose run id belongs to a committed eval record (the run
// records under evals/agent/runs, or the --runs directories given, and the perturbation judge's
// records under evals/agent/perturb) must carry an `eval:*` purpose. Eval spending whose run id
// no committed record names (a pilot, a run that was not kept) is listed apart, never hidden.
//
// Exits 1 when the total is above BUDGET_TOTAL_USD, a purpose is above its cap, or a harness
// call carries another purpose. No network and no model.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { importApp } from "./lib/app.mjs";
import { EVALS_DIR } from "./lib/golden.mjs";

export const RUNS_ROOT = join(EVALS_DIR, "agent", "runs");
export const PERTURB_ROOT = join(EVALS_DIR, "agent", "perturb");

const usd = (x) => `USD ${x.toFixed(4)}`;

function parseArgs(argv) {
  const opts = { runs: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--log") opts.log = value();
    else if (flag === "--runs") opts.runs.push(value());
    else if (flag === "--json") opts.json = true;
    else throw new Error(`unknown argument ${flag}`);
  }
  return opts;
}

/** `~/…` expanded; anything else must be absolute, as the app requires of LLM_SPEND_LOG. */
export function logPath(raw) {
  const value = raw?.trim() ?? "";
  if (!value) throw new Error("no spend log: pass --log <path> or set LLM_SPEND_LOG");
  const path = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
  if (!isAbsolute(path)) throw new Error(`the spend log must be an absolute path: ${value}`);
  return path;
}

/** Every *.json file under `dir`, recursively, in code-point order. */
function jsonFiles(dir) {
  let names;
  try {
    names = readdirSync(dir).sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return jsonFiles(path);
    return name.endsWith(".json") ? [path] : [];
  });
}

/**
 * The run ids of committed eval records: run records (runId) and perturbation judge records
 * (`runIds`). The spend lines of these runs are the harness's calls.
 */
export function harnessRunIds(dirs) {
  const ids = new Set();
  for (const file of dirs.flatMap(jsonFiles)) {
    const data = JSON.parse(readFileSync(file, "utf8"));
    for (const item of Array.isArray(data) ? data : [data]) {
      if (typeof item?.runId === "string") ids.add(item.runId);
      for (const id of item?.runIds ?? []) if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}

/** The app's caps from BUDGET_* in `env` (only those variables are read), else the defaults. */
export async function appCaps(env = process.env) {
  const { readLlmSettings } = await importApp("apps/api/src/config/settings.ts");
  const budgetOnly = Object.fromEntries(
    Object.entries(env).filter(([name]) => name.startsWith("BUDGET_")),
  );
  const { settings, errors } = readLlmSettings(budgetOnly);
  const budgetErrors = errors.filter((e) => e.includes("BUDGET_"));
  if (budgetErrors.length) throw new Error(budgetErrors.join("; "));
  return settings.budget;
}

/** Totals per purpose and the checks, from the log's lines (pure apart from the app's sum). */
export function spendReport(lines, summarise, caps, harnessIds) {
  const totals = summarise(lines);
  const settledIds = new Set(lines.filter((l) => l.kind === "settle").map((l) => l.id));
  // The lines that count: settles, hand-written lines, and reservations never settled.
  const counted = lines.filter((l) => l.kind !== "reserve" || !settledIds.has(l.id));
  const purposes = Object.entries(totals.byUnitUsd)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([unit, spent]) => {
      const cap = caps.evalSubCapsUsd[unit];
      const calls = counted.filter((l) => (l.unit ?? "") === unit).length;
      return {
        unit,
        usd: spent,
        calls,
        cap: cap ?? null,
        within: cap === undefined || spent <= cap,
      };
    });
  const harness = counted.filter((l) => typeof l.runId === "string" && harnessIds.has(l.runId));
  const notEval = harness.filter((l) => !String(l.unit ?? "").startsWith("eval:"));
  const outside = counted.filter(
    (l) => String(l.unit ?? "").startsWith("eval:") && !harnessIds.has(l.runId),
  );
  const outsideByUnit = {};
  for (const l of outside) outsideByUnit[l.unit] = (outsideByUnit[l.unit] ?? 0) + l.usd_est;
  const devShowcase = (totals.byUnitUsd.dev ?? 0) + (totals.byUnitUsd.showcase ?? 0);
  const devLimit = caps.totalUsd - caps.evalFloorUsd;
  const failures = [
    ...(totals.totalUsd > caps.totalUsd
      ? [`total ${usd(totals.totalUsd)} is above BUDGET_TOTAL_USD (${usd(caps.totalUsd)})`]
      : []),
    ...purposes
      .filter((p) => !p.within)
      .map((p) => `${p.unit} ${usd(p.usd)} is above its cap (${usd(p.cap)})`),
    ...(notEval.length
      ? [
          `${notEval.length} harness call(s) carry a purpose that is not eval:* (${[...new Set(notEval.map((l) => l.unit))].join(", ")})`,
        ]
      : []),
  ];
  return {
    totalUsd: totals.totalUsd,
    todayUsd: totals.todayUsd,
    lines: totals.lines,
    openReservations: totals.openReservations,
    caps,
    purposes,
    harness: {
      runIds: harnessIds.size,
      calls: harness.length,
      usd: harness.reduce((s, l) => s + l.usd_est, 0),
      notEval: notEval.length,
    },
    outsideRecords: { calls: outside.length, byUnitUsd: outsideByUnit },
    devShowcase: { usd: devShowcase, limit: devLimit, within: devShowcase <= devLimit },
    failures,
  };
}

function print(path, r) {
  const lines = [
    `spend log: ${path}`,
    `  ${r.lines} lines, ${r.openReservations} reservation(s) with no settle line (counted at their worst case)`,
    `total: ${usd(r.totalUsd)} of ${usd(r.caps.totalUsd)} (BUDGET_TOTAL_USD)${r.totalUsd <= r.caps.totalUsd ? "" : "  OVER"}`,
    `today (UTC): ${usd(r.todayUsd)} of ${usd(r.caps.dailyUsd)} (BUDGET_DAILY_USD)`,
    "by purpose:",
    ...r.purposes.map(
      (p) =>
        `  ${(p.unit || "(none)").padEnd(20)} ${usd(p.usd).padStart(12)}  ${String(p.calls).padStart(4)} calls${p.cap === null ? "" : `  cap ${usd(p.cap)} ${p.within ? "within" : "OVER"}`}`,
    ),
    `dev + showcase: ${usd(r.devShowcase.usd)} of ${usd(r.devShowcase.limit)} (BUDGET_TOTAL_USD - BUDGET_EVAL_FLOOR_USD) ${r.devShowcase.within ? "within" : "past it (those calls are refused)"}`,
    `harness calls: ${r.harness.calls} over ${r.harness.runIds} committed run id(s), ${usd(r.harness.usd)}; ${r.harness.notEval === 0 ? "every one carries an eval:* purpose" : `${r.harness.notEval} do not carry an eval:* purpose`}`,
    `eval spending no committed record names: ${r.outsideRecords.calls} call(s)${
      Object.keys(r.outsideRecords.byUnitUsd).length
        ? ` (${Object.entries(r.outsideRecords.byUnitUsd)
            .map(([u, v]) => `${u} ${usd(v)}`)
            .join(", ")})`
        : ""
    }`,
  ];
  console.log(lines.join("\n"));
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`spend: ${error.message}`);
    process.exit(2);
  }
  const path = logPath(opts.log ?? process.env.LLM_SPEND_LOG);
  const { parseSpendLog, summarise } = await importApp("apps/api/src/llm/spendLog.ts");
  const lines = parseSpendLog(readFileSync(path, "utf8"));
  const caps = await appCaps();
  const dirs = opts.runs.length ? opts.runs.map((d) => resolve(d)) : [RUNS_ROOT, PERTURB_ROOT];
  const report = spendReport(lines, summarise, caps, harnessRunIds(dirs));
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else print(path, report);
  for (const f of report.failures) console.error(`spend: ${f}`);
  if (report.failures.length) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`spend: ${error.message}`);
    process.exit(1);
  });
}
