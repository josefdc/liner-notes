/**
 * The run report: what the API's runs looked like, day by day, from its own database.
 *
 *   npm run report -w apps/api -- [--days N] [--json]     in a checkout (tsx)
 *   node dist/report.js [--days N] [--json]                in the API image, e.g.
 *     docker compose -f deploy/compose.prod.yml exec api node dist/report.js
 *
 * The database is SQLITE_DB_PATH, and the retention RUN_RETENTION_DAYS, read as the API reads
 * them: from the environment when set there (a blank value means the default, as for the API),
 * else from apps/api/.env (those two values only); else data/sonic-agent.db and 30 days.
 * Nothing is called. Nothing is written when the database has both its -wal and -shm files (the
 * API is running: the file is opened read-only and reads them) or no -wal (the API is stopped:
 * a file of at most 1 GiB is read into memory, and kept only if it did not change meanwhile).
 * Otherwise it is opened read-only, and SQLite creates the missing -wal or -shm next to it (a
 * larger file, a file that changed while it was read, or a -wal a crash left without -shm). Run
 * it as the API's user (in the image, `docker compose exec` does).
 *
 * Runs are counted by the UTC day each started; model use by the UTC day of each call:
 *   runs        every run recorded: live (computed for the request), replay (a recording served
 *               again, or a run whose model answers were replayed from stored answers) and
 *               cached (a result an earlier run composed); and by status: completed, failed,
 *               cancelled, open (running, or waiting for the user's choice)
 *   p50 / p95   duration of the completed live runs, in seconds: from start to finish less the
 *               time the run waited at the track picker (runs.ts). Times are whole seconds. A
 *               run whose wait is unknown is left out and counted apart
 *   fallback    completed live runs whose result was built from source data only (the composer
 *               failed), of the completed live runs whose stored result says either way; one
 *               that says neither is counted apart
 *   model       model call attempts sent to the provider, their tokens and their cost estimated
 *               at the price table, from the database's usage rows (llm_usage): the app's own
 *               accounting. Calls answered from stored answers, attempts stopped before their
 *               request left or that made no connection, and attempts recorded before schema 12
 *               (which do not say whether they were sent) are counted apart. Token columns leave
 *               out the attempts marked estimated (tokens unknown or partial); USD counts those
 *               at their estimate. The spend log (LLM_SPEND_LOG) stays the authoritative record
 *
 * Days before the cutoff retention last applied are shown as pruned: their runs and usage rows
 * have been deleted (retention.ts records the cutoff), so they are not counted, and the total
 * leaves them out. The day of the cutoff is marked as partly pruned (*). A database that records
 * no cutoff (schema before 12, or not pruned since) is marked from RUN_RETENTION_DAYS, and the
 * report says so. On a database that may have been pruned before it was migrated to 12 (it
 * held runs or usage rows, or was first migrated more than a day before), the prunes made then
 * were not recorded: the days they may have emptied (up to a day, the shortest retention,
 * before the migration) are marked unknown (?) until the recorded cutoff passes them; their
 * counts are what is left.
 *
 * Known limits:
 *   - A prune under a clock that was ahead records a cutoff in the future, and the latest cutoff
 *     is kept: days after it read as pruned (though their records exist) until real time passes
 *     it. Correct the clock before the API prunes.
 *   - Retention keeps a run until it finished longer ago than the retention, with its usage
 *     rows, but the report counts runs by the day each started: such a run (a long wait at the
 *     picker) on a pruned day is left out, though it is still stored.
 *   - The read-only open needs to create -wal or -shm when one is missing, so in a directory the
 *     user running the report cannot write it fails ("attempt to write a readonly database"):
 *     run it as the API's user.
 *   - Reading the file into memory takes about 2.3 times its size at peak (some 2.3 GiB for a
 *     file just under the 1 GiB limit).
 *   - Attempts whose request left the process count as sent unless the failure shows no
 *     connection was made; an abort or LLM_TIMEOUT_MS firing while the connection was being made
 *     cannot be told apart from one after the request was sent, and counts as sent.
 *   - A database is taken as new when it was migrated to 12 holding no runs or usage rows and
 *     within a day of its first migration: no day is marked unknown. It can have had no record
 *     old enough to prune, unless records were written with times in the past.
 *
 * Never prints what anyone typed, a run id, a key or an endpoint. Exits 1 when the database
 * cannot be read, 2 for a bad option.
 */

import { existsSync, readFileSync, type Stats, statSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import { API_ROOT } from "../config/apiPackage.js";
import { getDefaultDbPath } from "../store/database.js";
import {
  DEFAULT_RETENTION,
  MIN_RUN_RETENTION_MS,
  retentionFromEnv,
  retentionRecord,
} from "../store/retention.js";
import { runDurationSql } from "../store/runs.js";
import { isMainModule } from "./isMain.js";

const DAY_SECONDS = 24 * 60 * 60;
export const DEFAULT_DAYS = 7;
export const MAX_DAYS = 366;
const DEFAULT_RETENTION_DAYS = DEFAULT_RETENTION.runRetentionMs / 1000 / DAY_SECONDS;

const USAGE = [
  "Usage: npm run report -w apps/api -- [--days N] [--json]",
  "       node dist/report.js [--days N] [--json]   (in the API image)",
  `  --days N   the last N days, today included (default ${DEFAULT_DAYS}, at most ${MAX_DAYS})`,
  "  --json     the report as JSON instead of a table",
].join("\n");

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
  /** Completed live runs whose stored result says whether it is a fallback. */
  runs: number;
  /** Of those, the results built from source data only. */
  fallback: number;
  /** Completed live runs with a stored result that does not say (stored before it was kept). */
  unknown: number;
  /** fallback / runs; null when none says. */
  rate: number | null;
}

export interface ModelUse {
  /**
   * Call attempts sent to the provider: the request left the process and did not fail in a way
   * that shows no connection was made (llm_usage.sent).
   */
  calls: number;
  /** Of those, the attempts that ended in an error. */
  errors: number;
  /** Tokens of the attempts not marked estimated. */
  inputTokens: number;
  outputTokens: number;
  /** Estimated cost at the price table, the estimated attempts included. */
  usdEstimate: number;
  /**
   * Attempts marked estimated: the provider reported no usage or only part of it (counted at
   * the worst case), or the answer was filtered (counted at its input only).
   */
  estimatedCalls: number;
  /** Calls answered from stored answers: never sent, no cost, not in the counts above. */
  replayedCalls: number;
  /**
   * Attempts not sent: stopped before the request left, or no connection made. Not in `calls`;
   * they cost nothing.
   */
  unsentCalls: number;
  /**
   * Attempts recorded before schema 12, which do not say whether they were sent. Not in
   * `calls`; their tokens and cost are counted.
   */
  sentUnknownCalls: number;
}

/**
 * How much of a day's records the retention has kept: all, part (the day of the cutoff), none,
 * or not known (a prune that was not recorded may have deleted some: see `unrecordedUntil`).
 */
export type DayRetention = "kept" | "partly_pruned" | "pruned" | "unknown";

export interface ReportRow {
  /** YYYY-MM-DD (UTC), or "total". */
  day: string;
  retention: DayRetention;
  runs: number;
  live: number;
  /** Recordings served again plus runs whose model answers were replayed. */
  replay: number;
  /** Of `replay`, the runs whose model answers were replayed from stored answers. */
  replayedAnswers: number;
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

/** A day whose records the retention has deleted: nothing about it is known any more. */
export interface PrunedDay {
  day: string;
  retention: "pruned";
}

export interface RunReport {
  from: string;
  to: string;
  days: number;
  /** The run retention setting, in days (RUN_RETENTION_DAYS). */
  retentionDays: number;
  /**
   * Where the cutoff that marks pruned days comes from: "recorded", the latest one retention
   * applied to this database (retention_state); "setting", now less `retentionDays`, used only
   * when the database records none (schema before 12, or not pruned since).
   */
  cutoffSource: "recorded" | "setting";
  /** Runs and usage rows at or before this time (ISO 8601) may have been deleted. */
  cutoff: string;
  /**
   * Prunes made before the database recorded its cutoffs (migration 12) may have deleted runs
   * and usage rows at or before this time (ISO 8601): a day not pruned that starts at or before
   * it is "unknown". Null when none can have been (a database created at schema 12 or later).
   */
  unrecordedUntil: string | null;
  /** The first day whose records are all kept. */
  keptFrom: string;
  /** The database's schema version (PRAGMA user_version). */
  schemaVersion: number;
  /** False for a database not migrated to keep waits (schema before 11): no duration known. */
  pausesKept: boolean;
  perDay: Array<ReportRow | PrunedDay>;
  /** The days not pruned. */
  total: ReportRow;
  /** Model use of the days not pruned, by purpose (dev, eval, showcase, ...). */
  modelByPurpose: Record<string, ModelUse> | null;
}

export const isPrunedDay = (row: ReportRow | PrunedDay): row is PrunedDay => !("runs" in row);

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

type RunKind = "live" | "replay" | "replayed_answers" | "cached";

interface RunFacts {
  day: string;
  kind: RunKind;
  status: string;
  duration: number | null;
  /** For a completed run with a stored result: 1/0 when it says, -1 when it does not; else null. */
  fallback: number | null;
}

const emptyModelUse = (): ModelUse => ({
  calls: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  usdEstimate: 0,
  estimatedCalls: 0,
  replayedCalls: 0,
  unsentCalls: 0,
  sentUnknownCalls: 0,
});

function addModelUse(into: ModelUse, row: ModelUse): void {
  into.calls += row.calls;
  into.errors += row.errors;
  into.inputTokens += row.inputTokens;
  into.outputTokens += row.outputTokens;
  into.usdEstimate += row.usdEstimate;
  into.estimatedCalls += row.estimatedCalls;
  into.replayedCalls += row.replayedCalls;
  into.unsentCalls += row.unsentCalls;
  into.sentUnknownCalls += row.sentUnknownCalls;
}

function summarise(
  day: string,
  retention: DayRetention,
  runs: RunFacts[],
  model: ModelUse | null,
): ReportRow {
  const count = (test: (run: RunFacts) => boolean) => runs.filter(test).length;
  const completedLive = runs.filter((run) => run.kind === "live" && run.status === "completed");
  const known = completedLive
    .map((run) => run.duration)
    .filter((duration): duration is number => duration !== null)
    .sort((a, b) => a - b);
  const says = completedLive.filter((run) => run.fallback === 0 || run.fallback === 1);
  const fallback = says.filter((run) => run.fallback === 1).length;
  return {
    day,
    retention,
    runs: runs.length,
    live: count((run) => run.kind === "live"),
    replay: count((run) => run.kind === "replay" || run.kind === "replayed_answers"),
    replayedAnswers: count((run) => run.kind === "replayed_answers"),
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
      runs: says.length,
      fallback,
      unknown: count((run) => run.kind === "live" && run.fallback === -1),
      rate: says.length > 0 ? fallback / says.length : null,
    },
    model,
  };
}

/**
 * The report of the `days` days up to `now` (unix ms), today included, from an API database at
 * schema 2 or later. Days are marked pruned from the cutoff retention recorded in the database,
 * or, when it records none, from `retentionDays` before `now`. Reads only.
 */
export function buildReport(
  db: Database.Database,
  {
    days = DEFAULT_DAYS,
    now = Date.now(),
    retentionDays = DEFAULT_RETENTION_DAYS,
  }: { days?: number; now?: number; retentionDays?: number } = {},
): RunReport {
  if (!hasTable(db, "runs")) throw new Error("the database has no runs table");
  const today = Math.floor(now / 1000 / DAY_SECONDS) * DAY_SECONDS;
  const fromSec = today - (days - 1) * DAY_SECONDS;
  // Runs and usage rows at or before the cutoff may have been deleted (retention.ts).
  const record = retentionRecord(db);
  const recordedCutoff = record?.runCutoff ?? null;
  const cutoffSec = recordedCutoff ?? Math.floor(now / 1000 - retentionDays * DAY_SECONDS);
  // A prune before cutoffs were recorded deleted only records that ended at least the shortest
  // run retention before it ran, so at or before this time.
  const unrecordedUntil =
    record?.recordedSince == null
      ? null
      : record.recordedSince - Math.floor(MIN_RUN_RETENTION_MS / 1000);
  const unknownUntil =
    unrecordedUntil !== null && unrecordedUntil > cutoffSec ? unrecordedUntil : null;
  const dayStarts = Array.from({ length: days }, (_, i) => fromSec + i * DAY_SECONDS);
  const retentionOf = (start: number): DayRetention => {
    if (start + DAY_SECONDS <= cutoffSec + 1) return "pruned";
    if (unknownUntil !== null && start <= unknownUntil) return "unknown";
    return start <= cutoffSec ? "partly_pruned" : "kept";
  };
  const firstKept = dayStarts.find((start) => retentionOf(start) !== "pruned") ?? today;
  const lastDeletable = Math.max(cutoffSec, unknownUntil ?? cutoffSec);
  const keptFrom = utcDay(Math.floor(lastDeletable / DAY_SECONDS) * DAY_SECONDS + DAY_SECONDS);

  const pausesKept = hasColumn(db, "runs", "paused_seconds");
  const replayOf = jsonField("payload", "$.replayOf");
  const resultFrom = jsonField("payload", "$.resultFrom");
  const replayMode = hasColumn(db, "runs", "mode") ? "mode = 'replay'" : "0";
  const fallbackSql = hasColumn(db, "runs", "analysis")
    ? `CASE WHEN json_valid(analysis) THEN
         COALESCE(json_extract(analysis, '$.run.fallback'), -1) END`
    : "NULL";
  const rows = db
    .prepare(
      `SELECT created_at, status,
         CASE WHEN ${replayOf} IS NOT NULL THEN 'replay'
              WHEN ${resultFrom} = 'another_run' THEN 'cached'
              WHEN ${replayMode} THEN 'replayed_answers'
              ELSE 'live' END AS kind,
         ${pausesKept ? runDurationSql() : "NULL"} AS duration,
         CASE WHEN status = 'completed' THEN ${fallbackSql} END AS fallback
       FROM runs WHERE created_at >= ? ORDER BY created_at`,
    )
    .all(firstKept) as Array<{
    created_at: number;
    status: string;
    kind: RunKind;
    duration: number | null;
    fallback: number | null;
  }>;
  const facts: RunFacts[] = rows.map((row) => ({
    day: utcDay(row.created_at),
    kind: row.kind,
    status: row.status,
    duration: row.duration,
    fallback: row.fallback,
  }));

  let modelByDay: Map<string, ModelUse> | null = null;
  let modelByPurpose: Record<string, ModelUse> | null = null;
  if (hasTable(db, "llm_usage")) {
    // Replayed calls were never sent; of the others, `sent` says (null before schema 12).
    const attempt = "mode <> 'replay'";
    const sentKept = hasColumn(db, "llm_usage", "sent");
    const sent = sentKept ? `${attempt} AND sent = 1` : "0";
    const counted = `${attempt} AND estimated = 0`;
    const usage = db
      .prepare(
        `SELECT date(created_at, 'unixepoch') AS day, purpose,
           COALESCE(SUM(${sent}), 0) AS calls,
           COALESCE(SUM(${sent} AND status <> 'ok'), 0) AS errors,
           COALESCE(SUM(CASE WHEN ${counted} THEN input_tokens END), 0) AS inputTokens,
           COALESCE(SUM(CASE WHEN ${counted} THEN output_tokens END), 0) AS outputTokens,
           COALESCE(SUM(CASE WHEN ${attempt} THEN usd_est END), 0) AS usdEstimate,
           COALESCE(SUM(${attempt} AND estimated <> 0), 0) AS estimatedCalls,
           COALESCE(SUM(mode = 'replay'), 0) AS replayedCalls,
           COALESCE(SUM(${sentKept ? `${attempt} AND sent = 0` : "0"}), 0) AS unsentCalls,
           COALESCE(SUM(${sentKept ? `${attempt} AND sent IS NULL` : attempt}), 0)
             AS sentUnknownCalls
         FROM llm_usage WHERE created_at >= ? GROUP BY day, purpose ORDER BY day, purpose`,
      )
      .all(firstKept) as Array<ModelUse & { day: string; purpose: string }>;
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

  const perDay = dayStarts.map((start): ReportRow | PrunedDay => {
    const day = utcDay(start);
    const retention = retentionOf(start);
    if (retention === "pruned") return { day, retention };
    return summarise(
      day,
      retention,
      facts.filter((run) => run.day === day),
      modelByDay ? (modelByDay.get(day) ?? emptyModelUse()) : null,
    );
  });
  let totalModel: ModelUse | null = null;
  if (modelByDay) {
    totalModel = emptyModelUse();
    for (const use of modelByDay.values()) addModelUse(totalModel, use);
  }
  return {
    from: utcDay(fromSec),
    to: utcDay(today),
    days,
    retentionDays,
    cutoffSource: recordedCutoff === null ? "setting" : "recorded",
    cutoff: new Date(cutoffSec * 1000).toISOString(),
    unrecordedUntil:
      unrecordedUntil === null ? null : new Date(unrecordedUntil * 1000).toISOString(),
    keptFrom,
    schemaVersion: db.pragma("user_version", { simple: true }) as number,
    pausesKept,
    perDay,
    total: summarise(
      "total",
      perDay.some((row) => row.retention === "unknown")
        ? "unknown"
        : perDay.some((row) => row.retention !== "kept")
          ? "partly_pruned"
          : "kept",
      facts,
      totalModel,
    ),
    modelByPurpose,
  };
}

// =============================================================================
// Text
// =============================================================================

const usd = (value: number) => `$${value.toFixed(4)}`;
const when = (iso: string) => `${iso.slice(0, 16).replace("T", " ")} UTC`;
/** Calls sent, and the attempts not known to be sent (before schema 12) as +N?. */
const calls = (use: ModelUse) =>
  use.sentUnknownCalls > 0 ? `${use.calls}+${use.sentUnknownCalls}?` : String(use.calls);
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
    "USD (est.)",
  ];
  const line = (row: ReportRow): string[] => [
    row.day === "total"
      ? row.day
      : `${row.day}${row.retention === "partly_pruned" ? "*" : row.retention === "unknown" ? "?" : ""}`,
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
          calls(row.model),
          String(row.model.inputTokens),
          String(row.model.outputTokens),
          usd(row.model.usdEstimate),
        ]
      : ["-", "-", "-", "-"]),
  ];
  const lines = report.perDay.map((row) => (isPrunedDay(row) ? null : line(row)));
  const table = [header, ...lines.filter((cells) => cells !== null), line(report.total)];
  const widths = header.map((_, i) => Math.max(...table.map((cells) => cells[i].length)));
  const render = (cells: string[]) =>
    cells
      .map((cell, i) => (i === 0 ? cell.padEnd(widths[i]) : cell.padStart(widths[i])))
      .join("  ")
      .trimEnd();
  const rendered = report.perDay.map((row, i) => {
    const cells = lines[i];
    return cells ? render(cells) : `${row.day.padEnd(widths[0])}  pruned`;
  });

  const { total } = report;
  const pruned = report.perDay.filter(isPrunedDay).length;
  const partly = report.perDay.some((row) => row.retention === "partly_pruned");
  const notes = [
    `Durations: ${total.durations.runs} completed live runs, start to finish less the time ` +
      "spent waiting at the track picker, whole seconds (p50/p95 by nearest rank)." +
      (report.pausesKept
        ? total.durations.unknown > 0
          ? ` ${total.durations.unknown} left out: their wait is unknown (stored before ` +
            "waits were kept, first recorded at a resume, recovered after a restart, or " +
            "timed by a clock that went back)."
          : ""
        : " None known: the database is at schema " +
          `v${report.schemaVersion}, before waits were kept (start the API once to migrate it).`),
    "Replay: recordings served again, and runs whose model answers were replayed from stored " +
      `answers (${total.replayedAnswers}); neither is counted as live.`,
    "Fallback: completed live runs whose result was built from source data only, of the " +
      `${total.fallback.runs} whose stored result says either way` +
      (total.fallback.unknown > 0 ? `; ${total.fallback.unknown} say neither.` : "."),
    total.model
      ? `Model, by the day of the call: ${total.model.calls} call attempts sent to the ` +
        `provider (${total.model.errors} failed), cost estimated at the price table from the ` +
        "database's usage rows." +
        (total.model.estimatedCalls > 0
          ? ` ${total.model.estimatedCalls} are marked estimated (no usage or part of it ` +
            "reported, counted at the worst case; or a filtered answer, counted at its input " +
            "only): the token columns leave them out, USD (est.) counts their estimate."
          : "") +
        (total.model.replayedCalls > 0
          ? ` ${total.model.replayedCalls} calls answered from stored answers are not counted ` +
            "(never sent, no cost)."
          : "") +
        (total.model.unsentCalls > 0
          ? ` ${total.model.unsentCalls} attempts not sent (stopped before the request left, ` +
            "or no connection made) are not counted as calls; they cost nothing."
          : "") +
        (total.model.sentUnknownCalls > 0
          ? ` ${total.model.sentUnknownCalls} attempts recorded before schema v12 do not say ` +
            "whether they were sent: not counted as calls (shown as +N? in calls), their " +
            "tokens and USD are."
          : "") +
        " The spend log (LLM_SPEND_LOG) is the authoritative record."
      : "Model: the database keeps no usage rows.",
  ];
  if (report.modelByPurpose && Object.keys(report.modelByPurpose).length > 0) {
    notes.push(
      `Model by purpose: ${Object.entries(report.modelByPurpose)
        .map(
          ([purpose, use]) =>
            `${purpose} ${use.calls} calls` +
            (use.sentUnknownCalls > 0
              ? ` (and ${use.sentUnknownCalls} attempts not known to be sent)`
              : "") +
            ` ${usd(use.usdEstimate)}`,
        )
        .join(", ")}.`,
    );
  }
  const unknown = report.perDay.filter((row) => row.retention === "unknown").length;
  const past =
    `records are complete from ${report.keptFrom}.` +
    (pruned > 0 ? ` ${pruned} pruned days are not counted, in the total either.` : "") +
    (partly ? " * partly pruned." : "");
  const fromSetting =
    `days are marked from the current RUN_RETENTION_DAYS=${report.retentionDays}: ` +
    (pruned > 0 || partly || unknown > 0 ? past : "none in this window is past it.");
  if (report.cutoffSource === "setting" && report.schemaVersion < 12) {
    notes.push(
      `Retention: the database is at schema v${report.schemaVersion}, which records no cutoff ` +
        `applied by retention (start the API once to migrate it), so ${fromSetting} Days ` +
        "deleted under a shorter setting would show as kept.",
    );
  } else if (report.cutoffSource === "setting") {
    notes.push(
      "Retention: the database has not been pruned since it began to record the cutoffs " +
        `retention applies, so ${fromSetting}`,
    );
  } else if (pruned > 0 || partly || unknown > 0) {
    notes.push(
      `Retention: runs and usage rows up to ${when(report.cutoff)} have been deleted (the ` +
        `latest cutoff retention applied); ${past}`,
    );
  }
  if (unknown > 0 && report.unrecordedUntil) {
    notes.push(
      "Retention before schema v12 was not recorded: prunes made then may have deleted runs " +
        `and usage rows up to ${when(report.unrecordedUntil)}. The ${unknown} days marked ? ` +
        "show what is left: they may have had more, and so may the total.",
    );
  }
  return [
    `Runs ${report.from} to ${report.to} (UTC, ${report.days} ${report.days === 1 ? "day" : "days"}): runs by the day each ` +
      "started, model use by the day of the call",
    "",
    render(header),
    ...rendered,
    render(line(report.total)),
    "",
    ...notes,
  ].join("\n");
}

// =============================================================================
// Command line
// =============================================================================

/** apps/api/.env's values; empty when there is none or it cannot be read. */
function settingsFileValues(): Record<string, string> {
  const path = join(API_ROOT, ".env");
  if (!existsSync(path)) return {};
  try {
    return dotenv.parse(readFileSync(path));
  } catch {
    // An unreadable settings file sets nothing; the defaults are used.
    return {};
  }
}

/**
 * The settings the report needs, as the API reads them: a variable set in the environment wins
 * (even blank, which then means the default, as dotenv leaves it so for the API), else the
 * settings file's value. Only these two are taken from the file.
 */
export function reportSettings(
  env: NodeJS.ProcessEnv,
  file: Record<string, string> = settingsFileValues(),
): { SQLITE_DB_PATH?: string; RUN_RETENTION_DAYS?: string } {
  const pick = (name: "SQLITE_DB_PATH" | "RUN_RETENTION_DAYS") =>
    env[name] !== undefined ? env[name] : file[name];
  return { SQLITE_DB_PATH: pick("SQLITE_DB_PATH"), RUN_RETENTION_DAYS: pick("RUN_RETENTION_DAYS") };
}

/** SQLite's header bytes 18 and 19: 2 for a database in WAL mode, 1 for rollback journal. */
const WAL_VERSION_OFFSETS = [18, 19];

/** A database larger than this is opened read-only rather than read into memory. */
export const MAX_IN_MEMORY_BYTES = 1024 ** 3;

export interface OpenForReadingOptions {
  /** Default MAX_IN_MEMORY_BYTES. */
  maxInMemoryBytes?: number;
  /** Reads the file into memory (default readFileSync); for tests. */
  readFile?: (path: string) => Buffer;
}

const sameFile = (a: Stats, b: Stats) =>
  a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/**
 * Opens the database to read it. With no -wal file (the API is not running) and at most
 * `maxInMemoryBytes`, the file is read into memory: a copy set to rollback-journal mode, since
 * an in-memory database cannot use WAL, and nothing is written next to the file. The copy is
 * kept only if the file is the same after the read (inode, size and modification time) and no
 * -wal appeared meanwhile (the API started).
 *
 * Otherwise the file is opened read-only, reading the API's -wal and -shm when it runs. SQLite
 * then creates whichever of -wal and -shm is missing (a larger file with the API stopped, a file
 * that changed while it was read, or a -wal a crash left without its -shm), as the user running
 * the report, and leaves them.
 */
export function openForReading(
  dbPath: string,
  { maxInMemoryBytes = MAX_IN_MEMORY_BYTES, readFile = readFileSync }: OpenForReadingOptions = {},
): Database.Database {
  const readOnly = () => new Database(dbPath, { readonly: true, fileMustExist: true });
  const wal = `${dbPath}-wal`;
  if (existsSync(wal)) return readOnly();
  const before = statSync(dbPath);
  if (before.size > maxInMemoryBytes) return readOnly();
  const image = readFile(dbPath);
  if (existsSync(wal) || image.length !== before.size || !sameFile(before, statSync(dbPath))) {
    return readOnly();
  }
  for (const offset of WAL_VERSION_OFFSETS) if (image[offset] === 2) image[offset] = 1;
  return new Database(image);
}

export interface ReportDependencies {
  env?: NodeJS.ProcessEnv;
  /** The settings file's values (default: apps/api/.env's). */
  settingsFile?: Record<string, string>;
  now?: number;
  out?: (text: string) => void;
  err?: (text: string) => void;
}

export function main(argv: string[], deps: ReportDependencies = {}): number {
  const out = deps.out ?? ((text: string) => console.log(text));
  const err = deps.err ?? ((text: string) => console.error(text));
  let values: { days?: string; json?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        days: { type: "string" },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
      },
    }));
  } catch (error) {
    err(`report: ${(error as Error).message}`);
    err(USAGE);
    return 2;
  }
  if (values.help) {
    out(USAGE);
    return 0;
  }
  const days = values.days === undefined ? DEFAULT_DAYS : Number(values.days);
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) {
    err(`report: --days takes a whole number from 1 to ${MAX_DAYS}`);
    return 2;
  }

  const settings = reportSettings(deps.env ?? process.env, deps.settingsFile);
  const retentionDays =
    retentionFromEnv(settings, (message) => err(`report: ${message}`)).runRetentionMs /
    1000 /
    DAY_SECONDS;
  const dbPath = getDefaultDbPath(settings);
  if (!existsSync(dbPath)) {
    err(`report: no database at ${dbPath} (set SQLITE_DB_PATH)`);
    return 1;
  }
  let db: Database.Database | null = null;
  try {
    db = openForReading(dbPath);
    const report = buildReport(db, { days, now: deps.now, retentionDays });
    out(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
    return 0;
  } catch (error) {
    err(`report: could not read ${dbPath}: ${(error as Error).message}`);
    return 1;
  } finally {
    db?.close();
  }
}

if (isMainModule(import.meta)) {
  process.exitCode = main(process.argv.slice(2));
}
