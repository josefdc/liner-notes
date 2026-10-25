/**
 * `npm run report -w apps/api`: what the API's runs looked like, day by day, from its own
 * database (SQLITE_DB_PATH, from the environment or apps/api/.env; else data/sonic-agent.db).
 * The database is opened read-only; nothing is called and nothing is written.
 *
 * Per UTC day of the run's start, and in total:
 *   runs        every run recorded: live (computed for the request), replay (a recording served
 *               again) and cached (a result an earlier run composed); and by status: completed,
 *               failed, cancelled, open (running, or waiting for the user's choice)
 *   p50 / p95   duration of the completed live runs, in seconds: from start to finish less the
 *               time the run waited at the track picker (runs.ts). Times are whole seconds. A
 *               run whose wait is unknown (stored before waits were kept) is left out and
 *               counted apart
 *   fallback    completed live runs whose result was built from source data only (the composer
 *               failed), of the completed live runs with a stored result
 *   model       model call attempts by the day they were made, their tokens and their cost
 *               estimated at the price table, from the database's usage rows (llm_usage): the
 *               app's own accounting. The spend log (LLM_SPEND_LOG) stays the authoritative
 *               record; rows past the run retention are no longer here (retention.ts)
 *
 * Options:
 *   -- --days N   the last N days, today included (default 7, at most 366)
 *   -- --json     the report as JSON instead of a table
 *
 * Never prints what anyone typed, a run id, a key or an endpoint. Exits 1 when the database
 * cannot be read, 2 for a bad option.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import { API_ROOT } from "../config/apiPackage.js";
import { getDefaultDbPath } from "../store/database.js";
import { runDurationSql } from "../store/runs.js";

const DAY_SECONDS = 24 * 60 * 60;
export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 366;

export interface Durations {
  /** Completed live runs whose duration is known. */
  runs: number;
  /** Completed live runs left out: their wait at the track picker is unknown. */
  unknown: number;
  /** Seconds, nearest rank; null without a known duration. */
  p50: number | null;
  p95: number | null;
}

export interface Fallbacks {
  /** Completed live runs with a stored result. */
  runs: number;
  /** Of those, the results built from source data only. */
  fallback: number;
  /** fallback / runs; null without a stored result. */
  rate: number | null;
}

export interface ModelUse {
  calls: number;
  /** Attempts that ended in an error. */
  errors: number;
  inputTokens: number;
  outputTokens: number;
  /** Estimated at the price table. */
  usd: number;
  /** Attempts the provider reported no usage for, counted at the worst case. */
  estimatedCalls: number;
}

export interface ReportRow {
  /** YYYY-MM-DD (UTC), or "total". */
  day: string;
  runs: number;
  live: number;
  replay: number;
  cached: number;
  completed: number;
  failed: number;
  cancelled: number;
  open: number;
  durations: Durations;
  fallback: Fallbacks;
  /** Null when the database keeps no usage rows (schema before 4). */
  model: ModelUse | null;
}

export interface RunReport {
  from: string;
  to: string;
  days: number;
  /** The database's schema version (PRAGMA user_version). */
  schemaVersion: number;
  /** False for a database not migrated to keep waits (schema before 11): no duration known. */
  pausesKept: boolean;
  perDay: ReportRow[];
  total: ReportRow;
  /** Model spend of the window by purpose (dev, eval, showcase, ...). */
  modelByPurpose: Record<string, ModelUse> | null;
}

/** The value at percentile `p` of ascending `sorted`, by nearest rank; null when empty. */
export function percentile(sorted: readonly number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

const utcDay = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10);

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  return (
    db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").get(table, column) !== undefined
  );
}

function hasTable(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

/** JSON in a column read without failing on a value that is not JSON. */
const jsonField = (column: string, path: string) =>
  `CASE WHEN json_valid(${column}) THEN json_extract(${column}, '${path}') END`;

interface RunFacts {
  day: string;
  kind: "live" | "replay" | "cached";
  status: string;
  duration: number | null;
  /** 1/0 for a completed run with a stored result; null otherwise. */
  fallback: number | null;
}

const emptyModelUse = (): ModelUse => ({
  calls: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  usd: 0,
  estimatedCalls: 0,
});

function addModelUse(into: ModelUse, row: ModelUse): void {
  into.calls += row.calls;
  into.errors += row.errors;
  into.inputTokens += row.inputTokens;
  into.outputTokens += row.outputTokens;
  into.usd += row.usd;
  into.estimatedCalls += row.estimatedCalls;
}

function summarise(day: string, runs: RunFacts[], model: ModelUse | null): ReportRow {
  const count = (test: (run: RunFacts) => boolean) => runs.filter(test).length;
  const completedLive = runs.filter((run) => run.kind === "live" && run.status === "completed");
  const known = completedLive
    .map((run) => run.duration)
    .filter((duration): duration is number => duration !== null)
    .sort((a, b) => a - b);
  const withResult = completedLive.filter((run) => run.fallback !== null);
  const fallback = withResult.filter((run) => run.fallback === 1).length;
  return {
    day,
    runs: runs.length,
    live: count((run) => run.kind === "live"),
    replay: count((run) => run.kind === "replay"),
    cached: count((run) => run.kind === "cached"),
    completed: count((run) => run.status === "completed"),
    failed: count((run) => run.status === "failed"),
    cancelled: count((run) => run.status === "cancelled"),
    open: count((run) => run.status === "running" || run.status === "interrupted"),
    durations: {
      runs: known.length,
      unknown: completedLive.length - known.length,
      p50: percentile(known, 50),
      p95: percentile(known, 95),
    },
    fallback: {
      runs: withResult.length,
      fallback,
      rate: withResult.length > 0 ? fallback / withResult.length : null,
    },
    model,
  };
}

/**
 * The report of the `days` days up to `now` (unix ms), today included, from an API database at
 * schema 2 or later. Reads only.
 */
export function buildReport(
  db: Database.Database,
  { days = DEFAULT_DAYS, now = Date.now() }: { days?: number; now?: number } = {},
): RunReport {
  if (!hasTable(db, "runs")) throw new Error("the database has no runs table");
  const today = Math.floor(now / 1000 / DAY_SECONDS) * DAY_SECONDS;
  const fromSec = today - (days - 1) * DAY_SECONDS;
  const dayList = Array.from({ length: days }, (_, i) => utcDay(fromSec + i * DAY_SECONDS));

  const pausesKept = hasColumn(db, "runs", "paused_seconds");
  const replayOf = jsonField("payload", "$.replayOf");
  const resultFrom = jsonField("payload", "$.resultFrom");
  const hasAnalysis = hasColumn(db, "runs", "analysis");
  const fallbackSql = hasAnalysis
    ? `CASE WHEN json_valid(analysis) THEN COALESCE(json_extract(analysis, '$.run.fallback'), 0) END`
    : "NULL";
  const rows = db
    .prepare(
      `SELECT created_at, status,
         CASE WHEN ${replayOf} IS NOT NULL THEN 'replay'
              WHEN ${resultFrom} = 'another_run' THEN 'cached'
              ELSE 'live' END AS kind,
         ${pausesKept ? runDurationSql() : "NULL"} AS duration,
         CASE WHEN status = 'completed' THEN ${fallbackSql} END AS fallback
       FROM runs WHERE created_at >= ? ORDER BY created_at`,
    )
    .all(fromSec) as Array<{
    created_at: number;
    status: string;
    kind: RunFacts["kind"];
    duration: number | null;
    fallback: number | null;
  }>;
  const facts: RunFacts[] = rows.map((row) => ({
    day: utcDay(row.created_at),
    kind: row.kind,
    status: row.status,
    duration: row.duration,
    fallback: row.fallback === null ? null : row.fallback ? 1 : 0,
  }));

  let modelByDay: Map<string, ModelUse> | null = null;
  let modelByPurpose: Record<string, ModelUse> | null = null;
  if (hasTable(db, "llm_usage")) {
    const usage = db
      .prepare(
        `SELECT date(created_at, 'unixepoch') AS day, purpose,
           COUNT(*) AS calls,
           SUM(status <> 'ok') AS errors,
           COALESCE(SUM(input_tokens), 0) AS inputTokens,
           COALESCE(SUM(output_tokens), 0) AS outputTokens,
           COALESCE(SUM(usd_est), 0) AS usd,
           SUM(estimated) AS estimatedCalls
         FROM llm_usage WHERE created_at >= ? GROUP BY day, purpose ORDER BY day, purpose`,
      )
      .all(fromSec) as Array<ModelUse & { day: string; purpose: string }>;
    modelByDay = new Map();
    modelByPurpose = {};
    for (const { day, purpose, ...use } of usage) {
      const forDay = modelByDay.get(day) ?? emptyModelUse();
      addModelUse(forDay, use);
      modelByDay.set(day, forDay);
      modelByPurpose[purpose] ??= emptyModelUse();
      addModelUse(modelByPurpose[purpose], use);
    }
  }

  const perDay = dayList.map((day) =>
    summarise(
      day,
      facts.filter((run) => run.day === day),
      modelByDay ? (modelByDay.get(day) ?? emptyModelUse()) : null,
    ),
  );
  let totalModel: ModelUse | null = null;
  if (modelByDay) {
    totalModel = emptyModelUse();
    for (const use of modelByDay.values()) addModelUse(totalModel, use);
  }
  return {
    from: dayList[0],
    to: dayList[dayList.length - 1],
    days,
    schemaVersion: db.pragma("user_version", { simple: true }) as number,
    pausesKept,
    perDay,
    total: summarise("total", facts, totalModel),
    modelByPurpose,
  };
}

// =============================================================================
// Text
// =============================================================================

const usd = (value: number) => `$${value.toFixed(4)}`;
const seconds = (value: number | null) => (value === null ? "-" : String(value));
const rate = ({ fallback, runs, rate }: Fallbacks) =>
  rate === null ? "-" : `${fallback}/${runs} ${Math.round(rate * 100)}%`;

/** The report as a table with notes on what each column counts. */
export function formatReport(report: RunReport): string {
  const header = [
    "day",
    "runs",
    "live",
    "replay",
    "cached",
    "done",
    "failed",
    "cancel",
    "open",
    "p50 s",
    "p95 s",
    "fallback",
    "calls",
    "tokens in",
    "tokens out",
    "USD",
  ];
  const line = (row: ReportRow) => [
    row.day,
    String(row.runs),
    String(row.live),
    String(row.replay),
    String(row.cached),
    String(row.completed),
    String(row.failed),
    String(row.cancelled),
    String(row.open),
    seconds(row.durations.p50),
    seconds(row.durations.p95),
    rate(row.fallback),
    ...(row.model
      ? [
          String(row.model.calls),
          String(row.model.inputTokens),
          String(row.model.outputTokens),
          usd(row.model.usd),
        ]
      : ["-", "-", "-", "-"]),
  ];
  const table = [header, ...report.perDay.map(line), line(report.total)];
  const widths = header.map((_, i) => Math.max(...table.map((cells) => cells[i].length)));
  const render = (cells: string[]) =>
    cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
      .join("  ")
      .trimEnd();

  const { total } = report;
  const notes = [
    `Durations: ${total.durations.runs} completed live runs, start to finish less the time ` +
      "spent waiting at the track picker, whole seconds (p50/p95 by nearest rank)." +
      (report.pausesKept
        ? total.durations.unknown > 0
          ? ` ${total.durations.unknown} left out: stored before waits were kept.`
          : ""
        : " None known: the database is at schema " +
          `v${report.schemaVersion}, before waits were kept (start the API once to migrate it).`),
    `Fallback: completed live runs whose result was built from source data only, of the ` +
      `${total.fallback.runs} with a stored result.`,
    total.model
      ? `Model: ${total.model.calls} call attempts (${total.model.errors} failed), cost ` +
        "estimated at the price table from the database's usage rows" +
        (total.model.estimatedCalls > 0
          ? `; ${total.model.estimatedCalls} reported no usage and count at the worst case`
          : "") +
        ". The spend log (LLM_SPEND_LOG) is the authoritative record."
      : "Model: the database keeps no usage rows.",
  ];
  if (report.modelByPurpose && Object.keys(report.modelByPurpose).length > 0) {
    notes.push(
      `Model by purpose: ${Object.entries(report.modelByPurpose)
        .map(([purpose, use]) => `${purpose} ${use.calls} calls ${usd(use.usd)}`)
        .join(", ")}.`,
    );
  }
  return [
    `Runs ${report.from} to ${report.to} (UTC, ${report.days} days), by the day each started`,
    "",
    render(header),
    ...report.perDay.map((row) => render(line(row))),
    render(line(report.total)),
    "",
    ...notes,
  ].join("\n");
}

// =============================================================================
// Command line
// =============================================================================

/** SQLITE_DB_PATH from the environment, else from apps/api/.env (that one value only). */
function dbPathFromSettings(env: NodeJS.ProcessEnv): string {
  if (env.SQLITE_DB_PATH?.trim()) return getDefaultDbPath(env);
  const file = join(API_ROOT, ".env");
  let fromFile: string | undefined;
  if (existsSync(file)) {
    try {
      fromFile = dotenv.parse(readFileSync(file)).SQLITE_DB_PATH;
    } catch {
      // An unreadable settings file names no database; the default is used.
    }
  }
  return getDefaultDbPath({ SQLITE_DB_PATH: fromFile });
}

export interface ReportDependencies {
  env?: NodeJS.ProcessEnv;
  now?: number;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

export function main(argv: string[], deps: ReportDependencies = {}): number {
  const out = deps.out ?? ((text: string) => console.log(text));
  const err = deps.err ?? ((text: string) => console.error(text));
  let values: { days?: string; json?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: { days: { type: "string" }, json: { type: "boolean", default: false } },
    }));
  } catch (error) {
    err(`report: ${(error as Error).message}`);
    err("Usage: npm run report -w apps/api -- [--days N] [--json]");
    return 2;
  }
  const days = values.days === undefined ? DEFAULT_DAYS : Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    err(`report: --days takes a whole number from 1 to ${MAX_DAYS}`);
    return 2;
  }

  const dbPath = dbPathFromSettings(deps.env ?? process.env);
  if (!existsSync(dbPath)) {
    err(`report: no database at ${dbPath} (set SQLITE_DB_PATH)`);
    return 1;
  }
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
    const report = buildReport(db, { days, now: deps.now });
    out(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return 0;
  } catch (error) {
    err(`report: could not read ${dbPath}: ${(error as Error).message}`);
    return 1;
  } finally {
    db?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
