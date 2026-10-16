/**
 * Retention: deletes LangGraph checkpoints, store items and run records once they are old.
 *
 * - Checkpoints (and their pending writes) are deleted per thread once the thread has been idle
 *   for the checkpoint retention period: neither a checkpoint nor a run record of the thread
 *   changed within it. Completed runs, failed runs, clarifications nobody answered and runs cut
 *   short by a restart all become idle. A thread whose activity time cannot be read (a
 *   checkpoint not stored as JSON and no run record) is kept.
 * - Store items (LangGraph BaseStore) are deleted when not updated within the store retention.
 * - Run records are deleted when they finished (or, if never finished, started) longer ago than
 *   the run retention.
 *
 * Defaults: checkpoints 24 hours, store items 30 days, runs 30 days. Override with
 * CHECKPOINT_RETENTION_HOURS, STORE_RETENTION_DAYS and RUN_RETENTION_DAYS.
 */

import type Database from "better-sqlite3";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export interface RetentionPolicy {
  checkpointRetentionMs: number;
  storeRetentionMs: number;
  runRetentionMs: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  checkpointRetentionMs: 24 * HOUR_MS,
  storeRetentionMs: 30 * DAY_MS,
  runRetentionMs: 30 * DAY_MS,
};

function positiveNumber(name: string, raw: string | undefined, fallback: number): number {
  if (raw == null || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (Number.isFinite(value) && value > 0) return value;
  console.warn(`[Retention] Ignoring ${name}=${JSON.stringify(raw)}: expected a positive number.`);
  return fallback;
}

/** Reads the retention periods from the environment, falling back to the defaults. */
export function retentionFromEnv(env: NodeJS.ProcessEnv = process.env): RetentionPolicy {
  return {
    checkpointRetentionMs:
      positiveNumber(
        "CHECKPOINT_RETENTION_HOURS",
        env.CHECKPOINT_RETENTION_HOURS,
        DEFAULT_RETENTION.checkpointRetentionMs / HOUR_MS,
      ) * HOUR_MS,
    storeRetentionMs:
      positiveNumber(
        "STORE_RETENTION_DAYS",
        env.STORE_RETENTION_DAYS,
        DEFAULT_RETENTION.storeRetentionMs / DAY_MS,
      ) * DAY_MS,
    runRetentionMs:
      positiveNumber(
        "RUN_RETENTION_DAYS",
        env.RUN_RETENTION_DAYS,
        DEFAULT_RETENTION.runRetentionMs / DAY_MS,
      ) * DAY_MS,
  };
}

export interface PruneResult {
  threads: number;
  checkpoints: number;
  writes: number;
  storeItems: number;
  runs: number;
}

function tableExists(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) != null
  );
}

/** Threads whose last checkpoint or run activity is at or before `cutoffSec`. */
function idleThreads(db: Database.Database, cutoffSec: number): string[] {
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
       GROUP BY thread_id
       HAVING MAX(at) <= ?`,
    )
    .all(cutoffSec) as Array<{ thread_id: string }>;
  return rows.map((r) => r.thread_id);
}

/** Deletes everything older than the policy allows. Runs in one transaction. */
export function pruneDatabase(
  db: Database.Database,
  policy: RetentionPolicy = retentionFromEnv(),
  now: number = Date.now(),
): PruneResult {
  const result: PruneResult = { threads: 0, checkpoints: 0, writes: 0, storeItems: 0, runs: 0 };

  db.transaction(() => {
    if (tableExists(db, "checkpoints")) {
      const threads = idleThreads(db, Math.floor((now - policy.checkpointRetentionMs) / 1000));
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

    const runCutoff = Math.floor((now - policy.runRetentionMs) / 1000);
    result.runs = db
      .prepare("DELETE FROM runs WHERE COALESCE(finished_at, created_at) <= ?")
      .run(runCutoff).changes;
  })();

  const total = result.checkpoints + result.writes + result.storeItems + result.runs;
  if (total > 0) {
    console.log(
      `[Retention] Pruned ${result.threads} threads (${result.checkpoints} checkpoints, ` +
        `${result.writes} writes), ${result.storeItems} store items, ${result.runs} runs`,
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
      console.error("[Retention] Cache purge failed:", err);
    }
    try {
      pruneDatabase(db);
    } catch (err) {
      console.error("[Retention] Pruning failed:", err);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
