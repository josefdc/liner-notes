/**
 * Run records: one row per analysis run in the `runs` table (migration 2).
 *
 * Columns:
 *   run_id          unique id of the run
 *   thread_id       LangGraph thread the run's checkpoints are stored under
 *   query           the song query as the user typed it
 *   status          see RunStatus
 *   created_at      unix seconds when the run started
 *   finished_at     unix seconds when it reached a final status; null while it is open
 *   model_available 1/0 whether the language model answered; null when unknown
 *   audio_available 1/0 whether audio was measured; null when unknown
 *   payload         JSON with anything else worth keeping about the run; null when none
 *
 * Rows are deleted by the retention job (retention.ts) once they are older than the run
 * retention period. New columns are added by later numbered migrations.
 */

import type Database from "better-sqlite3";

/** "interrupted" waits for the user (e.g. to pick between candidate tracks). */
export type RunStatus = "running" | "interrupted" | "completed" | "failed" | "cancelled";

export const FINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "cancelled"];

export interface RunRecord {
  runId: string;
  threadId: string;
  query: string;
  status: RunStatus;
  createdAt: number;
  finishedAt: number | null;
  modelAvailable: boolean | null;
  audioAvailable: boolean | null;
  payload: unknown;
}

interface RunRow {
  run_id: string;
  thread_id: string;
  query: string;
  status: RunStatus;
  created_at: number;
  finished_at: number | null;
  model_available: number | null;
  audio_available: number | null;
  payload: string | null;
}

const toFlag = (value: boolean | null | undefined): number | null =>
  value == null ? null : value ? 1 : 0;
const fromFlag = (value: number | null): boolean | null => (value == null ? null : value === 1);
const nowSec = () => Math.floor(Date.now() / 1000);

export function startRun(
  db: Database.Database,
  run: { runId: string; threadId: string; query: string; status?: RunStatus },
): void {
  db.prepare(
    "INSERT INTO runs (run_id, thread_id, query, status, created_at) VALUES (?, ?, ?, ?, ?)",
  ).run(run.runId, run.threadId, run.query, run.status ?? "running", nowSec());
}

/**
 * Updates a run's status and flags. A final status sets finished_at; an open status clears it
 * (a resumed run is open again). Fields left undefined keep their stored value.
 */
export function updateRun(
  db: Database.Database,
  runId: string,
  update: {
    status: RunStatus;
    modelAvailable?: boolean | null;
    audioAvailable?: boolean | null;
    payload?: unknown;
  },
): boolean {
  const finished = FINAL_RUN_STATUSES.includes(update.status) ? nowSec() : null;
  const result = db
    .prepare(
      `UPDATE runs SET
         status = ?,
         finished_at = ?,
         model_available = CASE WHEN ? THEN ? ELSE model_available END,
         audio_available = CASE WHEN ? THEN ? ELSE audio_available END,
         payload = CASE WHEN ? THEN ? ELSE payload END
       WHERE run_id = ?`,
    )
    .run(
      update.status,
      finished,
      update.modelAvailable !== undefined ? 1 : 0,
      toFlag(update.modelAvailable),
      update.audioAvailable !== undefined ? 1 : 0,
      toFlag(update.audioAvailable),
      update.payload !== undefined ? 1 : 0,
      update.payload === undefined ? null : JSON.stringify(update.payload),
      runId,
    );
  return result.changes > 0;
}

export function getRun(db: Database.Database, runId: string): RunRecord | null {
  const row = db
    .prepare(
      `SELECT run_id, thread_id, query, status, created_at, finished_at,
              model_available, audio_available, payload
       FROM runs WHERE run_id = ?`,
    )
    .get(runId) as RunRow | undefined;
  if (!row) return null;
  return {
    runId: row.run_id,
    threadId: row.thread_id,
    query: row.query,
    status: row.status,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    modelAvailable: fromFlag(row.model_available),
    audioAvailable: fromFlag(row.audio_available),
    payload: row.payload == null ? null : JSON.parse(row.payload),
  };
}

export interface SettledRuns {
  interrupted: number;
  cancelled: number;
}

/**
 * Finalizes the runs still recorded as `running`: at shutdown these are the runs in flight, at
 * startup the ones a stopped process left behind. A run whose thread is paused at an interrupt
 * (waiting for the user's choice) becomes `interrupted`, so retention keeps the choice open;
 * any other becomes `cancelled`, also when its thread cannot be read. A row whose status changed
 * meanwhile (the run recorded its own outcome) is left as it is.
 */
export async function settleOpenRuns(
  db: Database.Database,
  isWaiting: (threadId: string) => Promise<boolean>,
): Promise<SettledRuns> {
  const open = db
    .prepare("SELECT run_id, thread_id FROM runs WHERE status = 'running'")
    .all() as Array<Pick<RunRow, "run_id" | "thread_id">>;
  const settle = db.prepare(
    "UPDATE runs SET status = ?, finished_at = ? WHERE run_id = ? AND status = 'running'",
  );

  const settled: SettledRuns = { interrupted: 0, cancelled: 0 };
  for (const run of open) {
    let waiting = false;
    try {
      waiting = await isWaiting(run.thread_id);
    } catch (err) {
      console.error(`[Runs] Could not read thread ${run.thread_id}:`, err);
    }
    const status: RunStatus = waiting ? "interrupted" : "cancelled";
    if (settle.run(status, waiting ? null : nowSec(), run.run_id).changes > 0) settled[status]++;
  }
  return settled;
}
