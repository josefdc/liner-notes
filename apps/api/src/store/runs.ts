/**
 * Run records: one row per analysis run in the `runs` table (migration 2, extended by 5), and
 * the events each run's streams sent in `run_events` (migration 5).
 *
 * Columns of `runs`:
 *   run_id          unique id of the run
 *   thread_id       LangGraph thread the run's checkpoints are stored under
 *   query           the song query as the user typed it; never returned by the runs routes
 *   status          see RunStatus
 *   created_at      unix seconds when the run started
 *   finished_at     unix seconds when it reached a final status; null while it is open
 *   model_available 1/0 whether the language model answered; null when unknown
 *   audio_available 1/0 whether audio was measured; null when unknown
 *   payload         JSON with anything else worth keeping about the run; null when none
 *   spotify_id      Spotify id of the analysed track, once the run has a result; else null
 *   mode            "live" (computed for the request) or "replay" (a recorded run served again)
 *   analysis        JSON of the result (a TrackAnalysis) once the run completed; else null
 *
 * Columns of `run_events`:
 *   run_id          the run that sent the event
 *   stream          which of the run's streams sent it: 0 for the first, 1 for the stream of a
 *                   resume, and so on. Each stream numbers its events from 0, so
 *                   (run_id, stream, seq) is the key.
 *   seq             the event's `seq`
 *   sent_at         unix milliseconds when it was sent
 *   event           the event as JSON, with runId and seq
 *
 * Rows are deleted by the retention job (retention.ts) once they are older than the run
 * retention period, a run's events with it. New columns are added by later numbered migrations.
 */

import { SPOTIFY_ID_PATTERN, TrackAnalysis } from "@liner-notes/contract";
import type Database from "better-sqlite3";

/** "interrupted" waits for the user (e.g. to pick between candidate tracks). */
export type RunStatus = "running" | "interrupted" | "completed" | "failed" | "cancelled";

export const FINAL_RUN_STATUSES: readonly RunStatus[] = ["completed", "failed", "cancelled"];

/** "live": computed for the request; "replay": a recorded run served again. */
export type RunMode = "live" | "replay";

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
  spotifyId: string | null;
  mode: RunMode;
  /** The stored result as JSON-parsed; null until the run has completed. */
  analysis: unknown;
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
  spotify_id: string | null;
  mode: RunMode;
  analysis: string | null;
}

const toFlag = (value: boolean | null | undefined): number | null =>
  value == null ? null : value ? 1 : 0;
const fromFlag = (value: number | null): boolean | null => (value == null ? null : value === 1);
const nowSec = () => Math.floor(Date.now() / 1000);

const RUN_COLUMNS = `run_id, thread_id, query, status, created_at, finished_at, model_available,
  audio_available, payload, spotify_id, mode, analysis`;

function toRecord(row: RunRow): RunRecord {
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
    spotifyId: row.spotify_id,
    mode: row.mode,
    analysis: row.analysis == null ? null : JSON.parse(row.analysis),
  };
}

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
  const row = db.prepare(`SELECT ${RUN_COLUMNS} FROM runs WHERE run_id = ?`).get(runId) as
    | RunRow
    | undefined;
  return row ? toRecord(row) : null;
}

/** The latest run of a track that has a stored result, or null. */
export function latestRunForTrack(db: Database.Database, spotifyId: string): RunRecord | null {
  const row = db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE spotify_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(spotifyId) as RunRow | undefined;
  return row ? toRecord(row) : null;
}

// =============================================================================
// Results and events
// =============================================================================

/**
 * A copy of `value` without its `previewUrl` fields. Preview URLs are signed and expire within
 * minutes, so a stored one would only fail later; a stored result or event never keeps one.
 */
export function withoutPreviewUrls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutPreviewUrls);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "previewUrl")
      .map(([key, field]) => [key, withoutPreviewUrls(field)]),
  );
}

/**
 * Stores a completed run's result: the analysis as it was sent (without preview URLs), the
 * Spotify id of its track (null when the analysis does not carry a valid one) and the run's
 * mode. The mode is the analysis's own when it names one (a run whose model answers were
 * replayed says so), else `mode`. An analysis that fails the contract is not stored and false is
 * returned; so is a run that does not exist.
 */
export function storeRunResult(
  db: Database.Database,
  runId: string,
  analysis: unknown,
  mode: RunMode = "live",
): boolean {
  const parsed = TrackAnalysis.safeParse(analysis);
  if (!parsed.success) return false;
  const spotifyId = SPOTIFY_ID_PATTERN.test(parsed.data.id) ? parsed.data.id : null;
  const result = db
    .prepare("UPDATE runs SET spotify_id = ?, mode = ?, analysis = ? WHERE run_id = ?")
    .run(
      spotifyId,
      parsed.data.run?.mode ?? mode,
      JSON.stringify(withoutPreviewUrls(analysis)),
      runId,
    );
  return result.changes > 0;
}

export interface StoredRunEvent {
  stream: number;
  seq: number;
  sentAt: number;
  event: unknown;
}

/** The number of a run's next stream: one past the last stream that stored an event, or 0. */
export function nextEventStream(db: Database.Database, runId: string): number {
  return db
    .prepare("SELECT COALESCE(MAX(stream) + 1, 0) FROM run_events WHERE run_id = ?")
    .pluck()
    .get(runId) as number;
}

/** Stores one event a run's stream sent (without preview URLs). */
export function appendRunEvent(
  db: Database.Database,
  runId: string,
  stream: number,
  event: { seq: number },
  sentAt: number = Date.now(),
): void {
  db.prepare(
    "INSERT INTO run_events (run_id, stream, seq, sent_at, event) VALUES (?, ?, ?, ?, ?)",
  ).run(runId, stream, event.seq, sentAt, JSON.stringify(withoutPreviewUrls(event)));
}

/** A run's stored events, stream by stream, each in the order it was sent. */
export function listRunEvents(db: Database.Database, runId: string): StoredRunEvent[] {
  const rows = db
    .prepare(
      "SELECT stream, seq, sent_at, event FROM run_events WHERE run_id = ? ORDER BY stream, seq",
    )
    .all(runId) as Array<{ stream: number; seq: number; sent_at: number; event: string }>;
  return rows.map((row) => ({
    stream: row.stream,
    seq: row.seq,
    sentAt: row.sent_at,
    event: JSON.parse(row.event),
  }));
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
