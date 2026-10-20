import { randomUUID } from "node:crypto";
import { type Request, type Response, Router } from "express";
import { Command } from "@langchain/langgraph";
import { createSonicAgentGraph } from "../../agent/graph.js";
import type { SearchCandidate, TrackData } from "../../agent/schema.js";
import { getDb } from "../../store/database.js";
import { type RunStatus, startRun, updateRun } from "../../store/runs.js";

const router = Router();

// =============================================================================
// Limits and messages
// =============================================================================

export const MAX_QUERY_LENGTH = 200;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/** Interval between heartbeat messages on an open event stream. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** What the client is told; details stay in the server log. */
const MESSAGES = {
  failed: "The analysis could not be completed. Please try again.",
  resumeInProgress: "This choice is already being processed.",
  choiceExpired: "This choice has expired or was not found. Please search again.",
  notWaiting: "This analysis is not waiting for a choice.",
  invalidSelection: "The selected track is not one of the offered choices.",
  disambiguation: "Multiple songs found. Please select the correct one.",
} as const;

type ResumeErrorCode =
  | "resume_in_progress"
  | "choice_expired"
  | "not_waiting"
  | "invalid_selection";

// =============================================================================
// Input validation
// =============================================================================

function parseQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const query = value.trim();
  return query.length > 0 && query.length <= MAX_QUERY_LENGTH ? query : null;
}

function parseId(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

const QUERY_ERROR = `'query' is required: a non-empty string of at most ${MAX_QUERY_LENGTH} characters`;
const RESUME_ERROR =
  "'threadId' and 'selectedTrackId' are required: 1-100 letters, digits, '-' or '_'";

// =============================================================================
// Run bookkeeping
// =============================================================================

/**
 * Threads with a run in progress in this process. A thread is added before anything is awaited,
 * so a second resume of the same thread is refused instead of running the pipeline again.
 */
const activeThreads = new Set<string>();

/**
 * Run records: one per thread (the run id is the thread id); a resumed run is the same run,
 * reopened. A failure to record is logged and never stops the analysis.
 */
function recordRun(action: string, write: (db: ReturnType<typeof getDb>) => void): void {
  try {
    write(getDb());
  } catch (err) {
    console.error(`[Runs] Could not ${action}:`, err);
  }
}

/** Starts a new analysis: a fresh thread, claimed and recorded as an open run. */
function startAnalysis(query: string): string {
  const threadId = randomUUID();
  activeThreads.add(threadId);
  recordRun("record a run", (db) => startRun(db, { runId: threadId, threadId, query }));
  return threadId;
}

/** Reopens the thread's run (or records one, for a thread paused before runs were recorded). */
function reopenRun(threadId: string, query: string): void {
  recordRun("reopen a run", (db) => {
    if (!updateRun(db, threadId, { status: "running" })) {
      startRun(db, { runId: threadId, threadId, query });
    }
  });
}

// =============================================================================
// Graph runner
// =============================================================================

type AgentEvent = Record<string, unknown> & { type: string };

/** A new run's initial state, or a Command({ resume }) that continues a paused one. */
type GraphInput = Parameters<ReturnType<typeof createSonicAgentGraph>["stream"]>[0];

type RunOutcome =
  | { kind: "complete"; trackData: TrackData }
  | { kind: "interrupted"; candidates: SearchCandidate[] }
  /** `reported`: a node ended the run with an error (e.g. no track found), not an exception. */
  | { kind: "failed"; reported: boolean }
  | { kind: "cancelled" };

const OUTCOME_STATUS: Record<RunOutcome["kind"], RunStatus> = {
  complete: "completed",
  interrupted: "interrupted",
  failed: "failed",
  cancelled: "cancelled",
};

interface DisambiguationPayload {
  candidates?: SearchCandidate[];
}

/**
 * Runs the graph on one thread until it ends or pauses at an interrupt. Progress events go to
 * `emit`. `complete` is emitted exactly once, from here, whichever node produced the result:
 * nodes report it both through the writer and in their state update. Candidates are not
 * forwarded; the caller sends them once, with the interrupt.
 */
async function runGraph(
  input: GraphInput,
  threadId: string,
  signal: AbortSignal,
  emit: (event: AgentEvent) => void = () => {},
): Promise<RunOutcome> {
  const seen: {
    trackData: TrackData | null;
    interrupt: DisambiguationPayload | null;
    nodeError: boolean;
  } = { trackData: null, interrupt: null, nodeError: false };

  const completeWith = (data: TrackData) => {
    if (seen.trackData) return;
    seen.trackData = data;
    emit({ type: "complete", data });
  };

  try {
    const graph = createSonicAgentGraph();
    const stream = await graph.stream(input, {
      configurable: { thread_id: threadId },
      streamMode: ["updates", "custom"],
      signal,
    });

    for await (const chunk of stream) {
      const [mode, data] = chunk as unknown as [string, unknown];

      if (mode === "custom") {
        const event = data as AgentEvent;
        if (event.type === "complete") {
          if (event.data) completeWith(event.data as TrackData);
        } else if (event.type !== "candidates") {
          emit(event);
        }
        continue;
      }

      if (mode !== "updates") continue;
      for (const [node, update] of Object.entries(data as Record<string, unknown>)) {
        if (node === "__interrupt__") {
          const [first] = update as Array<{ value?: DisambiguationPayload }>;
          seen.interrupt = first?.value ?? {};
          continue;
        }
        console.log(`[Run ${threadId}] ${node} finished`);
        const state = update as { trackData?: TrackData; error?: string } | null;
        if (state?.trackData) completeWith(state.trackData);
        if (state?.error) {
          console.error(`[Run ${threadId}] ${node} reported an error:`, state.error);
          seen.nodeError = true;
        }
      }
    }
  } catch (err) {
    if (signal.aborted) return { kind: "cancelled" };
    console.error(`[Run ${threadId}] Graph error:`, err);
    return { kind: "failed", reported: false };
  }

  if (signal.aborted) return { kind: "cancelled" };
  if (seen.trackData) return { kind: "complete", trackData: seen.trackData };
  if (seen.interrupt) return { kind: "interrupted", candidates: seen.interrupt.candidates ?? [] };
  if (!seen.nodeError) console.error(`[Run ${threadId}] Graph ended without a result`);
  return { kind: "failed", reported: seen.nodeError };
}

/** Records the run's outcome and logs it. */
function finishRun(threadId: string, outcome: RunOutcome): void {
  const status = OUTCOME_STATUS[outcome.kind];
  recordRun("update a run", (db) => updateRun(db, threadId, { status }));
  console.log(`[Run ${threadId}] ${status}`);
}

// =============================================================================
// Resume checks
// =============================================================================

type ResumeCheck =
  | { ok: true; query: string }
  | { ok: false; code: ResumeErrorCode; httpStatus: number; error: string };

/**
 * Checks that a thread is paused at the clarification interrupt and that the selection is one
 * of the candidates it offered. A thread with no saved state was either never created or pruned
 * by retention; the two cannot be told apart, so both are reported as an expired choice.
 */
async function checkResumable(threadId: string, selectedTrackId: string): Promise<ResumeCheck> {
  const graph = createSonicAgentGraph();
  const snapshot = await graph.getState({ configurable: { thread_id: threadId } });

  if (!snapshot.config?.configurable?.checkpoint_id) {
    return { ok: false, code: "choice_expired", httpStatus: 404, error: MESSAGES.choiceExpired };
  }

  const pending = snapshot.tasks.find(
    (task) => task.name === "clarification" && task.interrupts.length > 0,
  );
  if (!pending) {
    return { ok: false, code: "not_waiting", httpStatus: 404, error: MESSAGES.notWaiting };
  }

  const payload = pending.interrupts[0].value as DisambiguationPayload | undefined;
  if (!payload?.candidates?.some((candidate) => candidate.id === selectedTrackId)) {
    return {
      ok: false,
      code: "invalid_selection",
      httpStatus: 400,
      error: MESSAGES.invalidSelection,
    };
  }

  const values = snapshot.values as { songQuery?: string };
  return { ok: true, query: values.songQuery ?? "" };
}

/**
 * Claims the thread, then checks it can be resumed. On success the caller owns the claim and
 * must release it; on failure it is already released.
 */
async function claimResume(threadId: string, selectedTrackId: string): Promise<ResumeCheck> {
  if (activeThreads.has(threadId)) {
    return {
      ok: false,
      code: "resume_in_progress",
      httpStatus: 409,
      error: MESSAGES.resumeInProgress,
    };
  }
  activeThreads.add(threadId);
  try {
    const check = await checkResumable(threadId, selectedTrackId);
    if (!check.ok) activeThreads.delete(threadId);
    return check;
  } catch (err) {
    activeThreads.delete(threadId);
    throw err;
  }
}

// =============================================================================
// Responses
// =============================================================================

/**
 * Aborts the run if the client goes away before the response is finished. Listens on the
 * response: a request's own "close" event also fires once its body has been read.
 */
function abortOnDisconnect(res: Response, controller: AbortController, threadId: string): void {
  res.on("close", () => {
    if (res.writableEnded || controller.signal.aborted) return;
    controller.abort();
    console.warn(`[Run ${threadId}] Client disconnected; run aborted`);
  });
}

interface EventStream {
  send(event: AgentEvent): void;
  end(): void;
}

/**
 * Starts a server-sent event stream with status 200. Every message is a plain `data:` line, so
 * EventSource delivers it to `onmessage`: progress, errors (EventSource cannot read the body of
 * any other status) and a heartbeat every HEARTBEAT_INTERVAL_MS that keeps proxies from closing
 * an idle connection.
 */
function openEventStream(res: Response): EventStream {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event: AgentEvent) => {
    if (!res.writableEnded && !res.destroyed) res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  const heartbeat = setInterval(() => send({ type: "heartbeat" }), HEARTBEAT_INTERVAL_MS);
  const stop = () => clearInterval(heartbeat);
  res.on("close", stop);

  return {
    send,
    end() {
      stop();
      if (!res.writableEnded) res.end();
    },
  };
}

const timestamp = () => new Date().toISOString();

function sendDone(stream: EventStream): void {
  stream.send({ type: "done", timestamp: timestamp() });
  stream.end();
}

/** Sends a run's last messages (`complete` was sent as it happened). */
function sendStreamOutcome(stream: EventStream, outcome: RunOutcome, threadId: string): void {
  if (outcome.kind === "cancelled") {
    stream.end();
    return;
  }
  if (outcome.kind === "interrupted") {
    stream.send({
      type: "interrupt",
      reason: "disambiguation",
      threadId,
      candidates: outcome.candidates,
      message: MESSAGES.disambiguation,
    });
  } else if (outcome.kind === "failed") {
    stream.send({ type: "error", error: MESSAGES.failed });
  }
  sendDone(stream);
}

function sendJsonOutcome(
  res: Response,
  outcome: RunOutcome,
  threadId: string,
  meta: Record<string, unknown>,
): void {
  if (res.writableEnded || res.destroyed) return;
  switch (outcome.kind) {
    case "complete":
      res.json({
        success: true,
        status: "complete",
        threadId,
        data: outcome.trackData,
        meta: { ...meta, timestamp: timestamp() },
      });
      return;
    case "interrupted":
      res.json({
        success: true,
        status: "interrupted",
        threadId,
        interrupt: {
          reason: "disambiguation",
          candidates: outcome.candidates,
          message: MESSAGES.disambiguation,
        },
      });
      return;
    case "failed":
      res.status(outcome.reported ? 404 : 500).json({ success: false, error: MESSAGES.failed });
      return;
    case "cancelled":
      return;
  }
}

// =============================================================================
// Routes
// =============================================================================

/**
 * Analyze a song (non-streaming)
 *
 * POST /api/analyze
 * Body: { "query": "Song name Artist" }
 * Returns { status: "complete", threadId, data } or, when the song is ambiguous,
 * { status: "interrupted", threadId, interrupt: { candidates } }; resume with
 * POST /api/analyze/resume.
 */
router.post("/api/analyze", async (req: Request, res: Response) => {
  const startTime = Date.now();
  const query = parseQuery(req.body?.query);
  if (!query) {
    res.status(400).json({ error: QUERY_ERROR, example: { query: "Midnight City M83" } });
    return;
  }

  const threadId = startAnalysis(query);
  console.log(`[API] Analysis ${threadId}: "${query}"`);
  const controller = new AbortController();
  abortOnDisconnect(res, controller, threadId);

  try {
    const outcome = await runGraph({ songQuery: query }, threadId, controller.signal);
    finishRun(threadId, outcome);
    sendJsonOutcome(res, outcome, threadId, { query, durationMs: Date.now() - startTime });
  } finally {
    activeThreads.delete(threadId);
  }
});

/**
 * Stream analysis with Server-Sent Events
 *
 * GET /api/analyze/stream?query=Song+Name
 *
 * Messages (each a `data:` line with a `type`):
 * - connected { threadId }
 * - status: agent progress
 * - heartbeat: keeps the connection open; ignore it
 * - interrupt { threadId, candidates }: the user must pick a track; resume with the routes below
 * - complete { data }: the result, exactly once per finished run
 * - error { error }: a short message
 * - done: the stream is over
 */
router.get("/api/analyze/stream", async (req: Request, res: Response) => {
  const query = parseQuery(req.query.query);
  if (!query) {
    res
      .status(400)
      .json({ error: QUERY_ERROR, example: "/api/analyze/stream?query=Midnight+City+M83" });
    return;
  }

  const threadId = startAnalysis(query);
  console.log(`[SSE] Analysis ${threadId}: "${query}"`);
  const stream = openEventStream(res);
  const controller = new AbortController();
  abortOnDisconnect(res, controller, threadId);
  stream.send({ type: "connected", threadId, timestamp: timestamp() });

  try {
    const outcome = await runGraph({ songQuery: query }, threadId, controller.signal, stream.send);
    finishRun(threadId, outcome);
    sendStreamOutcome(stream, outcome, threadId);
  } finally {
    activeThreads.delete(threadId);
  }
});

/**
 * Resume after Human-in-the-loop selection
 *
 * POST /api/analyze/resume
 * Body: { "threadId": "...", "selectedTrackId": "spotify_track_id" }
 * 409 while the thread is being resumed, 404 when it is not waiting for a choice or the choice
 * expired, 400 when the track was not offered. Error bodies carry a `code` (see the stream route).
 */
router.post("/api/analyze/resume", async (req: Request, res: Response) => {
  const threadId = parseId(req.body?.threadId);
  const selectedTrackId = parseId(req.body?.selectedTrackId);
  if (!threadId || !selectedTrackId) {
    res.status(400).json({
      error: RESUME_ERROR,
      example: { threadId: "<threadId>", selectedTrackId: "6GyFP1nfCDB8lbD2bG0Hq9" },
    });
    return;
  }

  console.log(`[API] Resuming ${threadId} with track ${selectedTrackId}`);
  let check: ResumeCheck;
  try {
    check = await claimResume(threadId, selectedTrackId);
  } catch (err) {
    console.error(`[Run ${threadId}] Could not read the thread:`, err);
    res.status(500).json({ success: false, error: MESSAGES.failed });
    return;
  }
  if (!check.ok) {
    console.warn(`[Run ${threadId}] Resume refused: ${check.code}`);
    res.status(check.httpStatus).json({ success: false, code: check.code, error: check.error });
    return;
  }

  const controller = new AbortController();
  abortOnDisconnect(res, controller, threadId);
  try {
    reopenRun(threadId, check.query);
    const outcome = await runGraph(
      new Command({ resume: selectedTrackId }),
      threadId,
      controller.signal,
    );
    finishRun(threadId, outcome);
    sendJsonOutcome(res, outcome, threadId, { selectedTrackId });
  } finally {
    activeThreads.delete(threadId);
  }
});

/**
 * Resume streaming after selection
 *
 * GET /api/analyze/stream/resume?threadId=...&selectedTrackId=...
 *
 * The messages of /api/analyze/stream, starting with `resuming`. A resume that cannot run gets
 * one error message with a `code` (resume_in_progress, choice_expired, not_waiting,
 * invalid_selection), then done.
 */
router.get("/api/analyze/stream/resume", async (req: Request, res: Response) => {
  const threadId = parseId(req.query.threadId);
  const selectedTrackId = parseId(req.query.selectedTrackId);
  if (!threadId || !selectedTrackId) {
    res.status(400).json({
      error: RESUME_ERROR,
      example:
        "/api/analyze/stream/resume?threadId=<threadId>&selectedTrackId=6GyFP1nfCDB8lbD2bG0Hq9",
    });
    return;
  }

  console.log(`[SSE] Resuming ${threadId} with track ${selectedTrackId}`);
  const stream = openEventStream(res);

  let check: ResumeCheck;
  try {
    check = await claimResume(threadId, selectedTrackId);
  } catch (err) {
    console.error(`[Run ${threadId}] Could not read the thread:`, err);
    stream.send({ type: "error", error: MESSAGES.failed });
    sendDone(stream);
    return;
  }
  if (!check.ok) {
    console.warn(`[Run ${threadId}] Resume refused: ${check.code}`);
    stream.send({ type: "error", code: check.code, error: check.error });
    sendDone(stream);
    return;
  }

  const controller = new AbortController();
  abortOnDisconnect(res, controller, threadId);
  stream.send({ type: "resuming", threadId, timestamp: timestamp() });
  try {
    reopenRun(threadId, check.query);
    const outcome = await runGraph(
      new Command({ resume: selectedTrackId }),
      threadId,
      controller.signal,
      stream.send,
    );
    finishRun(threadId, outcome);
    sendStreamOutcome(stream, outcome, threadId);
  } finally {
    activeThreads.delete(threadId);
  }
});

export default router;
