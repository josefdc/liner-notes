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
 *   payload         JSON with anything else worth keeping about the run; null when none.
 *                   `resultFrom: "another_run"` marks a run that sent a result another run
 *                   composed (a cached one), which is not stored as this run's.
 *                   `replayOf: { slug, recordedAt }` names the recorded run a replayed run
 *                   served (see storeReplayOf): its result is the record's, not stored again
 *   spotify_id      Spotify id of the analysed track, once the run has a result of its own;
 *                   else null
 *   mode            how the result the run sent was produced: "live", computed by this run, or
 *                   "replay", a recorded result served again (a replayed run, or a cached
 *                   result an earlier run composed). A run that sent no result (open, failed,
 *                   cancelled) or was recorded before modes were kept reads "live", the
 *                   column's default, which then says nothing about how a result was produced
 *   analysis        JSON of the run's own result (a TrackAnalysis, as the contract reads it,
 *                   without preview URLs); null when it has none
 *
 * Columns of `run_events`:
 *   run_id          the run that sent the event
 *   stream          the number of the stream that sent it among the run's stored streams, from
 *                   0. A run started by GET /api/analyze/stream stores its first stream as 0 and
 *                   a resume's stream as 1; a run started by POST /api/analyze stores no stream,
 *                   so its resume's stream is 0. Each stream numbers its events from 0, so
 *                   (run_id, stream, seq) is the key.
 *   seq             the event's `seq`
 *   sent_at         unix milliseconds when it was sent
 *   event           the event as JSON, as the contract reads it, without preview URLs
 *
 * Rows are deleted by the retention job (retention.ts) once they are older than the run
 * retention period, a run's events with it; events also go once they are older than the shorter
 * event retention. A run that sent another run's result keeps no events (see
 * deleteRunEvents). New columns are added by later numbered migrations.
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
  /**
   * The run's own stored result, JSON-parsed; null when it has none: it has not completed, it
   * sent a result another run composed (a cached one), its result could not be stored, or it
   * completed before results were stored.
   */
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

/**
 * The runs of a track that have a result of their own (or that replayed a recorded run, see
 * storeReplayOf), latest first: by the time they finished
 * (a resumed run finishes after runs started later), then by start, then by the order they were
 * recorded. At most `limit` runs.
 */
export function latestRunsForTrack(
  db: Database.Database,
  spotifyId: string,
  limit: number,
): RunRecord[] {
  const rows = db
    .prepare(
      `SELECT ${RUN_COLUMNS} FROM runs WHERE spotify_id = ?
       ORDER BY finished_at DESC, created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(spotifyId, limit) as RunRow[];
  return rows.map(toRecord);
}

// =============================================================================
// Results and events
// =============================================================================

/**
 * Preview clips, as whole URLs: Deezer's preview hosts (cdns-preview-*, e-cdns-preview-*,
 * cdnt-preview under dzcdn.net; not its image host), Spotify's preview host, and any URL signed
 * with an expiring token (Akamai `hdnea`/`hdnts`, S3 `X-Amz-Signature`). Text that only mentions
 * such a URL or token is not one.
 */
const PREVIEW_HOST =
  /^https?:\/\/(?:[^/?#@\s]*\.)?(?:(?:e-)?cdn[st]-preview(?:-[a-z0-9]+)?\.dzcdn\.net|p\.scdn\.co)(?::\d+)?(?:[/?#]\S*)?$/i;
const SIGNED_URL = /^https?:\/\/\S*[?&;~](?:hdnea|hdnts|x-amz-signature)=\S*$/i;

/** True for a preview clip URL (see PREVIEW_HOST and SIGNED_URL). */
export function isPreviewUrl(value: string): boolean {
  return PREVIEW_HOST.test(value) || SIGNED_URL.test(value);
}

/**
 * A copy of `value` without preview URLs: `previewUrl` fields are removed, and any other string
 * that is a preview URL is blanked (it may be a required field). Preview URLs are signed and
 * expire within minutes, so a stored one would only fail later; a stored result or event never
 * keeps one.
 */
export function withoutPreviewUrls(value: unknown): unknown {
  if (typeof value === "string") return isPreviewUrl(value) ? "" : value;
  if (Array.isArray(value)) return value.map(withoutPreviewUrls);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "previewUrl")
      .map(([key, field]) => [key, withoutPreviewUrls(field)]),
  );
}

/**
 * What storeRunResult did:
 *   stored        the run's own result was stored with its track and mode
 *   another_run   the result carries another run's id, or none (a cached result): the run is
 *                 marked as having sent another run's result, with mode "replay" (it computed
 *                 nothing), and the result is not stored
 *   invalid       the result fails the contract; nothing was stored
 *   no_run        there is no such run
 */
export type StoreResultOutcome = "stored" | "another_run" | "invalid" | "no_run";

/**
 * Stores a completed run's result, as the contract reads it and without preview URLs, with the
 * Spotify id of its track (null when the result does not carry a valid one) and the run's mode:
 * replay when the caller or the result says so, else live. When the caller says replay, the
 * stored result's own run information says replay too, so the two never disagree. The result's
 * `run.id` must be this run's id (a replayed record is stamped with the new run's id first).
 *
 * Only the run's own result is stored: one whose run information names this run. A result
 * served from the cache was composed by an earlier run; storing it as this run's would present
 * it as computed now, and put it ahead of the run that composed it.
 */
export function storeRunResult(
  db: Database.Database,
  runId: string,
  analysis: unknown,
  mode: RunMode = "live",
): StoreResultOutcome {
  const parsed = TrackAnalysis.safeParse(analysis);
  if (!parsed.success) return "invalid";
  if (parsed.data.run?.id !== runId) {
    const marked = db
      .prepare(
        `UPDATE runs SET mode = 'replay',
           payload = json_set(COALESCE(payload, '{}'), '$.resultFrom', 'another_run')
         WHERE run_id = ?`,
      )
      .run(runId);
    return marked.changes > 0 ? "another_run" : "no_run";
  }
  const stored = TrackAnalysis.safeParse(withoutPreviewUrls(parsed.data));
  if (!stored.success) return "invalid";
  const spotifyId = SPOTIFY_ID_PATTERN.test(stored.data.id) ? stored.data.id : null;
  const replay = mode === "replay" || stored.data.run?.mode === "replay";
  const own =
    replay && stored.data.run
      ? { ...stored.data, run: { ...stored.data.run, mode: "replay" as const } }
      : stored.data;
  const result = db
    .prepare("UPDATE runs SET spotify_id = ?, mode = ?, analysis = ? WHERE run_id = ?")
    .run(spotifyId, replay ? "replay" : "live", JSON.stringify(own), runId);
  return result.changes > 0 ? "stored" : "no_run";
}

/** The recorded run a replayed run served: the record's slug and when it was recorded. */
export interface ReplayOf {
  slug: string;
  recordedAt: string;
}

/**
 * Records that a run replayed a recorded run: its track, mode "replay" and which record it served
 * (`payload.replayOf`). The result itself is not copied: it is the record's, with this run's
 * id, and the runs routes rebuild it from the record while that recording is still served. A
 * copy per replay would only fill the disk.
 */
export function storeReplayOf(
  db: Database.Database,
  runId: string,
  spotifyId: string,
  replayOf: ReplayOf,
): boolean {
  const result = db
    .prepare(
      `UPDATE runs SET spotify_id = ?, mode = 'replay', analysis = NULL,
         payload = json_set(COALESCE(payload, '{}'), '$.replayOf', json(?))
       WHERE run_id = ?`,
    )
    .run(
      SPOTIFY_ID_PATTERN.test(spotifyId) ? spotifyId : null,
      JSON.stringify({ slug: replayOf.slug, recordedAt: replayOf.recordedAt }),
      runId,
    );
  return result.changes > 0;
}

/** The recorded run a replayed run served (storeReplayOf), or null. */
export function replayOfRun(run: RunRecord): ReplayOf | null {
  const replayOf = (run.payload as { replayOf?: Partial<ReplayOf> } | null)?.replayOf;
  return typeof replayOf?.slug === "string" && typeof replayOf.recordedAt === "string"
    ? { slug: replayOf.slug, recordedAt: replayOf.recordedAt }
    : null;
}

/**
 * Deletes the events a run's streams sent. A run that sent a result another run composed keeps
 * none: the result belongs to the run that composed it, and a copy per cache hit would only
 * fill the disk.
 */
export function deleteRunEvents(db: Database.Database, runId: string): number {
  return db.prepare("DELETE FROM run_events WHERE run_id = ?").run(runId).changes;
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

/** True when the run has a record. */
export function runExists(db: Database.Database, runId: string): boolean {
  return db.prepare("SELECT 1 FROM runs WHERE run_id = ?").get(runId) !== undefined;
}

/**
 * How long an event write waits for another process's write lock, in milliseconds. Events are
 * written as they are sent, so a write must not hold up the stream for the connection's
 * usual busy timeout; one that cannot get the lock in time fails.
 */
export const EVENT_BUSY_TIMEOUT_MS = 50;

/**
 * Stores one event a run's stream sent (without preview URLs), waiting at most `busyTimeoutMs`
 * for the write lock. The connection's own busy timeout is restored afterwards.
 */
export function appendRunEvent(
  db: Database.Database,
  runId: string,
  stream: number,
  event: { seq: number },
  { sentAt = Date.now(), busyTimeoutMs = EVENT_BUSY_TIMEOUT_MS } = {},
): void {
  const usual = db.pragma("busy_timeout", { simple: true }) as number;
  db.pragma(`busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
  try {
    db.prepare(
      "INSERT INTO run_events (run_id, stream, seq, sent_at, event) VALUES (?, ?, ?, ?, ?)",
    ).run(runId, stream, event.seq, sentAt, JSON.stringify(withoutPreviewUrls(event)));
  } finally {
    db.pragma(`busy_timeout = ${usual}`);
  }
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
