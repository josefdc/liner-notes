/**
 * Retention: deletes LangGraph checkpoints, store items and run records once they are old.
 *
 * - Checkpoints (and their pending writes) are deleted per thread once the thread has been idle
 *   for the checkpoint retention period: no checkpoint was written and no run of the thread
 *   started or finished within it. A thread with an open run (status "running" or
 *   "interrupted", e.g. waiting for the user to pick a track) is kept regardless, until that
 *   run started longer ago than the run retention; past that it counts as abandoned. A thread
 *   whose activity time cannot be read (a checkpoint not stored as JSON and no run record) is
 *   kept.
 * - Store items (LangGraph BaseStore) are deleted when not updated within the store retention,
 *   whatever their namespace.
 * - Run records are deleted when they finished (or, if never finished, started) longer ago than
 *   the run retention, and the events their streams sent with them.
 * - Stored stream events are deleted once they were sent longer ago than the event retention,
 *   whatever their run. They are kept only to record a run as a replay soon after it ran; the
 *   run's result stays with the run. The event retention is never longer than the run retention.
 *
 * Defaults: checkpoints 24 hours, store items 30 days, runs 30 days, run events 7 days.
 * Override with CHECKPOINT_RETENTION_HOURS (at least 1), STORE_RETENTION_DAYS,
 * RUN_RETENTION_DAYS and RUN_EVENT_RETENTION_DAYS (at least 1 each); smaller values are raised
 * to the minimum with a warning.
 */

import type Database from "better-sqlite3";
import { FINAL_RUN_STATUSES } from "./runs.js";
import { logger } from "../logger.js";

const log = logger("Retention");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface RetentionPolicy {
  checkpointRetentionMs: number;
  storeRetentionMs: number;
  runRetentionMs: number;
  runEventRetentionMs: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  checkpointRetentionMs: 24 * HOUR_MS,
  storeRetentionMs: 30 * DAY_MS,
  runRetentionMs: 30 * DAY_MS,
  runEventRetentionMs: 7 * DAY_MS,
};

function setting(name: string, raw: string | undefined, fallback: number, minimum: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    log.warn(`Ignoring ${name}=${JSON.stringify(raw)}: expected a positive number.`);
    return fallback;
  }
  if (value < minimum) {
    log.warn(`${name}=${value} is below the minimum; using ${minimum}.`);
    return minimum;
  }
  return value;
}

/** Reads the retention periods from the environment, falling back to the defaults. */
export function retentionFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  return {
    checkpointRetentionMs:
      setting(
        "CHECKPOINT_RETENTION_HOURS",
        env.CHECKPOINT_RETENTION_HOURS,
        DEFAULT_RETENTION.checkpointRetentionMs / HOUR_MS,
        1,
      ) * HOUR_MS,
    storeRetentionMs:
      setting(
        "STORE_RETENTION_DAYS",
        env.STORE_RETENTION_DAYS,
        DEFAULT_RETENTION.storeRetentionMs / DAY_MS,
        1,
      ) * DAY_MS,
    runRetentionMs:
      setting(
        "RUN_RETENTION_DAYS",
        env.RUN_RETENTION_DAYS,
        DEFAULT_RETENTION.runRetentionMs / DAY_MS,
        1,
      ) * DAY_MS,
    runEventRetentionMs:
      setting(
        "RUN_EVENT_RETENTION_DAYS",
        env.RUN_EVENT_RETENTION_DAYS,
        DEFAULT_RETENTION.runEventRetentionMs / DAY_MS,
        1,
      ) * DAY_MS,
  };
}

export interface PruneResult {
  threads: number;
  checkpoints: number;
  writes: number;
  storeItems: number;
  runs: number;
  runEvents: number;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null
  );
}

/**
 * Threads whose last checkpoint or run activity is at or before `cutoffSec`, except threads with
 * an open run (not finished) that started after `openRunCutoffSec`.
 */
function idleThreads(db: Database.Database, cutoffSec: number, openRunCutoffSec: number): string[] {
  const finalStatuses = FINAL_RUN_STATUSES.map((status) => `'${status}'`).join(", ");
  const rows = db
    .prepare(
      `WITH activity AS (
         SELECT thread_id,
                MAX(CASE WHEN type = 'json' AND json_valid(CAST(checkpoint AS TEXT))
                         THEN unixepoch(json_extract(CAST(checkpoint AS TEXT), '$.ts')) END) AS at
         FROM checkpoints GROUP BY thread_id
         UNION ALL
         SELECT thread_id, MAX(COALESCE(finished_at, created_at)) FROM runs GROUP BY thread_id
       )
       SELECT thread_id FROM activity
       WHERE thread_id IN (SELECT thread_id FROM checkpoints)
         AND thread_id NOT IN (
           SELECT thread_id FROM runs
           WHERE (finished_at IS NULL OR status NOT IN (${finalStatuses})) AND created_at > ?
         )
       GROUP BY thread_id
       HAVING MAX(at) <= ?`,
    )
    .all(openRunCutoffSec, cutoffSec) as Array<{ thread_id: string }>;
  return rows.map((r) => r.thread_id);
}

/** Deletes everything older than the policy allows. Runs in one transaction. */
export function pruneDatabase(
  db: Database.Database,
  policy: RetentionPolicy = retentionFromEnv(),
  now: number = Date.now(),
): PruneResult {
  const result: PruneResult = {
    threads: 0,
    checkpoints: 0,
    writes: 0,
    storeItems: 0,
    runs: 0,
    runEvents: 0,
  };

  const runCutoff = Math.floor((now - policy.runRetentionMs) / 1000);

  db.transaction(() => {
    if (tableExists(db, "checkpoints")) {
      const threads = idleThreads(
        db,
        Math.floor((now - policy.checkpointRetentionMs) / 1000),
        runCutoff,
      );
      const deleteCheckpoints = db.prepare("DELETE FROM checkpoints WHERE thread_id = ?");
      const deleteWrites = tableExists(db, "writes")
        ? db.prepare("DELETE FROM writes WHERE thread_id = ?")
        : null;
      for (const threadId of threads) {
        result.checkpoints += deleteCheckpoints.run(threadId).changes;
        result.writes += deleteWrites?.run(threadId).changes ?? 0;
      }
      result.threads = threads.length;
    }

    // store_items timestamps are ISO-8601 strings in UTC, which compare correctly as text.
    const storeCutoff = new Date(now - policy.storeRetentionMs).toISOString();
    result.storeItems = db
      .prepare("DELETE FROM store_items WHERE updated_at < ?")
      .run(storeCutoff).changes;

    // A run's events go with it; events older than the event retention go whatever their run
    // (this also removes the events of a run whose record could not be written).
    const expired = "SELECT run_id FROM runs WHERE COALESCE(finished_at, created_at) <= ?";
    const eventCutoffMs = now - Math.min(policy.runEventRetentionMs, policy.runRetentionMs);
    result.runEvents = db
      .prepare(`DELETE FROM run_events WHERE sent_at <= ? OR run_id IN (${expired})`)
      .run(eventCutoffMs, runCutoff).changes;
    result.runs = db
      .prepare("DELETE FROM runs WHERE COALESCE(finished_at, created_at) <= ?")
      .run(runCutoff).changes;
  })();

  const total =
    result.checkpoints + result.writes + result.storeItems + result.runs + result.runEvents;
  if (total > 0) {
    log.info(
      `Pruned ${result.threads} threads (${result.checkpoints} checkpoints, ` +
        `${result.writes} writes), ${result.storeItems} store items, ${result.runs} runs ` +
        `(${result.runEvents} events)`,
    );
  }
  return result;
}

export const RETENTION_INTERVAL_MS = HOUR_MS;

/**
 * Purges expired cache rows and prunes old data now, then every `intervalMs` (an hour by
 * default). A failure is logged and retried at the next tick. Returns a function that stops it.
 */
export function startRetention(
  db: Database.Database,
  cache: { purgeExpired(): unknown },
  intervalMs: number = RETENTION_INTERVAL_MS,
): () => void {
  const run = () => {
    try {
      cache.purgeExpired();
    } catch (err) {
      log.error("Cache purge failed", { err });
    }
    try {
      pruneDatabase(db);
    } catch (err) {
      log.error("Pruning failed", { err });
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
