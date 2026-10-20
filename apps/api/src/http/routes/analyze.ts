import { randomUUID } from "node:crypto";
import { type Request, type Response, Router } from "express";
import { Command } from "@langchain/langgraph";
import { createSonicAgentGraph } from "../../agent/graph.js";
import type { SearchCandidate, TrackData } from "../../agent/schema.js";
import { getDb } from "../../store/database.js";
import { getRun, type RunStatus, startRun, updateRun } from "../../store/runs.js";

const router = Router();

// =============================================================================
// Limits and errors
// =============================================================================

/** Longest accepted query, in characters (code points). */
export const MAX_QUERY_LENGTH = 200;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

/** Interval between heartbeat messages on an open event stream. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** Longest a run may take; past it the route aborts the run and reports a timeout. */
export const RUN_DEADLINE_MS = 3 * 60_000;
let runDeadlineMs = RUN_DEADLINE_MS;

/** For tests: sets the run deadline. Returns a function that restores the previous one. */
export function setRunDeadlineForTests(ms: number): () => void {
  const previous = runDeadlineMs;
  runDeadlineMs = ms;
  return () => {
    runDeadlineMs = previous;
  };
}

/**
 * Errors the client can see: a code, the HTTP status the POST routes answer with, and a short
 * message. Details stay in the server log. The stream routes always answer 200 (EventSource
 * cannot read any other status) and send the code and message as an `error` message.
 */
const ERRORS = {
  invalid_input: { status: 400, message: "The request is not valid. Please search again." },
  resume_in_progress: { status: 409, message: "This choice is already being processed." },
  choice_expired: {
    status: 404,
    message: "This choice has expired or was not found. Please search again.",
  },
  not_waiting: { status: 404, message: "This analysis is not waiting for a choice." },
  run_interrupted: { status: 404, message: "The analysis was interrupted. Please search again." },
  invalid_selection: {
    status: 400,
    message: "The selected track is not one of the offered choices.",
  },
  no_match: { status: 422, message: "No song matched that search." },
  upstream_unavailable: {
    status: 502,
    message: "The music service is not responding right now. Please try again later.",
  },
  timeout: { status: 504, message: "The analysis took too long. Please try again." },
  failed: { status: 500, message: "The analysis could not be completed. Please try again." },
} as const;

type ErrorCode = keyof typeof ERRORS;
type FailureCode = "no_match" | "upstream_unavailable" | "timeout" | "failed";

const DISAMBIGUATION_MESSAGE = "Multiple songs found. Please select the correct one.";

// =============================================================================
// Input validation
// =============================================================================

const CONTROL_CHARACTER = /\p{Cc}/u;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const INVISIBLE = /[\s\p{Cf}]/gu;

/**
 * A query is a string of 1 to MAX_QUERY_LENGTH characters once runs of whitespace (tabs and
 * newlines included) are collapsed to one space and the ends trimmed, with no other control
 * characters or unpaired surrogates, and at least one visible character.
 */
function parseQuery(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const query = value.replace(/\s+/g, " ").trim();
  if (CONTROL_CHARACTER.test(query) || LONE_SURROGATE.test(query)) return null;
  if (query.replace(INVISIBLE, "") === "") return null;
  return [...query].length <= MAX_QUERY_LENGTH ? query : null;
}

function parseId(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null;
}

const QUERY_ERROR = `'query' is required: a song name of at most ${MAX_QUERY_LENGTH} characters`;
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
// Run control: disconnect and deadline
// =============================================================================

/**
 * Owns a run's AbortController. The run is aborted when the client goes away before the
 * response is finished (listening on the response: a request's own "close" event also fires
 * once its body has been read) or when the run deadline passes.
 */
class RunControl {
  private readonly controller = new AbortController();
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private disconnected = false;
  timedOut = false;

  constructor(
    private readonly req: Request,
    private readonly res: Response,
    private readonly threadId: string,
  ) {
    res.on("close", () => {
      if (res.writableEnded) return;
      this.disconnected = true;
      this.abort("Client disconnected");
    });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /** True once the client has gone, even if the close event has not been handled yet. */
  get clientGone(): boolean {
    return this.disconnected || this.res.destroyed || this.req.socket.destroyed;
  }

  startDeadline(): void {
    this.deadline = setTimeout(() => {
      this.timedOut = true;
      this.abort(`No result after ${runDeadlineMs / 1000} s`);
    }, runDeadlineMs);
  }

  dispose(): void {
    clearTimeout(this.deadline);
  }

  private abort(reason: string): void {
    if (this.controller.signal.aborted) return;
    this.controller.abort();
    console.warn(`[Run ${this.threadId}] ${reason}; run aborted`);
  }
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
  | { kind: "failed"; code: FailureCode }
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
 * Reads why the scout ended a run from the error it put in the state: Spotify found nothing,
 * or Spotify could not be reached (its tools return "Error …" strings; a thrown error becomes
 * "Scout error: …"). Anything else is a plain failure. This reads the scout's text because its
 * tools return strings; it goes once they return typed results (#11).
 */
function classifyNodeError(node: string, error: string): FailureCode {
  if (node !== "scout") return "failed";
  if (/^No tracks? (found|data)/i.test(error)) return "no_match"; // guard-allow: string-sentinel-tool-results — until #11
  if (/^Error\b|^Scout error\b/.test(error)) return "upstream_unavailable"; // guard-allow: string-sentinel-tool-results — until #11
  return "failed";
}

/**
 * Runs the graph on one thread until it ends or pauses at an interrupt. Progress events go to
 * `emit`. `complete` is emitted exactly once, from here, whichever node produced the result:
 * nodes report it both through the writer and in their state update. Candidates are not
 * forwarded; the caller sends them once, with the interrupt. A result that was already sent
 * counts as complete even if the run is aborted afterwards.
 */
async function runGraph(
  input: GraphInput,
  threadId: string,
  signal: AbortSignal,
  emit: (event: AgentEvent) => void,
): Promise<RunOutcome> {
  const seen: {
    trackData: TrackData | null;
    interrupt: DisambiguationPayload | null;
    failure: FailureCode | null;
  } = { trackData: null, interrupt: null, failure: null };

  const completeWith = (data: TrackData) => {
    if (seen.trackData) return;
    seen.trackData = data;
    emit({ type: "complete", data });
  };

  let threw: unknown = null;
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
          seen.failure ??= classifyNodeError(node, state.error);
        }
      }
    }
  } catch (err) {
    threw = err;
  }

  if (seen.trackData) return { kind: "complete", trackData: seen.trackData };
  if (seen.interrupt) return { kind: "interrupted", candidates: seen.interrupt.candidates ?? [] };
  if (signal.aborted) return { kind: "cancelled" };
  if (threw) console.error(`[Run ${threadId}] Graph error:`, threw);
  else if (!seen.failure) console.error(`[Run ${threadId}] Graph ended without a result`);
  return { kind: "failed", code: seen.failure ?? "failed" };
}

/** The clarification interrupt the thread is paused at, or null. */
async function pendingChoice(threadId: string) {
  const snapshot = await createSonicAgentGraph().getState({
    configurable: { thread_id: threadId },
  });
  const task = snapshot.tasks.find(
    (task) => task.name === "clarification" && task.interrupts.length > 0,
  );
  return { snapshot, choice: (task?.interrupts[0].value ?? null) as DisambiguationPayload | null };
}

/**
 * Runs the graph under `control` and records the outcome. A deadline abort is reported as a
 * timeout. A run that failed or was cancelled before the choice was applied leaves the thread
 * waiting for it, so it is recorded as interrupted: retention keeps it and it can be resumed.
 */
async function executeRun(
  input: GraphInput,
  threadId: string,
  control: RunControl,
  emit: (event: AgentEvent) => void = () => {},
): Promise<RunOutcome> {
  control.startDeadline();
  let outcome = await runGraph(input, threadId, control.signal, emit);
  if (outcome.kind === "cancelled" && control.timedOut)
    outcome = { kind: "failed", code: "timeout" };

  let status = OUTCOME_STATUS[outcome.kind];
  if (outcome.kind === "failed" || outcome.kind === "cancelled") {
    try {
      if ((await pendingChoice(threadId)).choice) status = "interrupted";
    } catch (err) {
      console.error(`[Run ${threadId}] Could not read the thread:`, err);
    }
  }
  recordRun("update a run", (db) => updateRun(db, threadId, { status }));
  console.log(`[Run ${threadId}] ${outcome.kind}; recorded ${status}`);
  return outcome;
}

// =============================================================================
// Resume checks
// =============================================================================

type ResumeCheck = { ok: true; query: string } | { ok: false; code: ErrorCode };

/**
 * Checks that a thread is paused at the clarification interrupt and that the selection is one
 * of the candidates it offered. A thread with no saved state was either never created or pruned
 * by retention; the two cannot be told apart, so both are reported as an expired choice. A
 * thread past its choice whose last run was cancelled or failed cannot be continued either.
 */
async function checkResumable(threadId: string, selectedTrackId: string): Promise<ResumeCheck> {
  const { snapshot, choice } = await pendingChoice(threadId);

  if (!snapshot.config?.configurable?.checkpoint_id) return { ok: false, code: "choice_expired" };

  if (!choice) {
    let status: RunStatus | undefined;
    recordRun("read a run", (db) => {
      status = getRun(db, threadId)?.status;
    });
    const interrupted = status === "cancelled" || status === "failed";
    return { ok: false, code: interrupted ? "run_interrupted" : "not_waiting" };
  }

  if (!choice.candidates?.some((candidate) => candidate.id === selectedTrackId)) {
    return { ok: false, code: "invalid_selection" };
  }

  const values = snapshot.values as { songQuery?: string };
  return { ok: true, query: values.songQuery ?? "" };
}

/**
 * Claims the thread, then checks it can be resumed. On success the caller owns the claim and
 * must release it; otherwise it is already released.
 */
async function claimResume(threadId: string, selectedTrackId: string): Promise<ResumeCheck> {
  if (activeThreads.has(threadId)) return { ok: false, code: "resume_in_progress" };
  activeThreads.add(threadId);
  try {
    const check = await checkResumable(threadId, selectedTrackId);
    if (!check.ok) activeThreads.delete(threadId);
    return check;
  } catch (err) {
    activeThreads.delete(threadId);
    console.error(`[Run ${threadId}] Could not read the thread:`, err);
    return { ok: false, code: "failed" };
  }
}

interface ResumeReply {
  refuse(code: ErrorCode): void;
  started(): void;
  emit?: (event: AgentEvent) => void;
  finish(outcome: RunOutcome): void;
}

/**
 * Resumes a paused thread with the selected track. The disconnect listener is registered
 * before anything is awaited; a client that left during the checks gets no run, and the choice
 * stays open.
 */
async function resumeThread(
  req: Request,
  res: Response,
  threadId: string,
  selectedTrackId: string,
  reply: ResumeReply,
): Promise<void> {
  console.log(`[Run ${threadId}] Resuming with track ${selectedTrackId}`);
  const control = new RunControl(req, res, threadId);

  const check = await claimResume(threadId, selectedTrackId);
  if (!check.ok) {
    console.warn(`[Run ${threadId}] Resume refused: ${check.code}`);
    reply.refuse(check.code);
    return;
  }

  try {
    if (control.clientGone) {
      console.warn(`[Run ${threadId}] Client left before the resume started; choice kept`);
      return;
    }
    reply.started();
    reopenRun(threadId, check.query);
    const outcome = await executeRun(
      new Command({ resume: selectedTrackId }),
      threadId,
      control,
      reply.emit,
    );
    reply.finish(outcome);
  } finally {
    control.dispose();
    activeThreads.delete(threadId);
  }
}

// =============================================================================
// Responses
// =============================================================================

interface EventStream {
  send(event: AgentEvent): void;
  error(code: ErrorCode): void;
  done(): void;
}

const timestamp = () => new Date().toISOString();

/**
 * Starts a server-sent event stream with status 200. Every message is a plain `data:` line, so
 * EventSource delivers it to `onmessage`: progress, errors (EventSource cannot read the body of
 * any other status) and a heartbeat every HEARTBEAT_INTERVAL_MS that keeps proxies from closing
 * an idle connection. Headers are flushed at once, before the first message.
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
    error: (code) => send({ type: "error", code, error: ERRORS[code].message }),
    done() {
      send({ type: "done", timestamp: timestamp() });
      stop();
      if (!res.writableEnded) res.end();
    },
  };
}

/**
 * Sends a run's last messages (`complete` was sent as it happened). A cancelled run's client is
 * gone, so it only closes the stream.
 */
function sendStreamOutcome(stream: EventStream, outcome: RunOutcome, threadId: string): void {
  if (outcome.kind === "interrupted") {
    stream.send({
      type: "interrupt",
      reason: "disambiguation",
      threadId,
      candidates: outcome.candidates,
      message: DISAMBIGUATION_MESSAGE,
    });
  } else if (outcome.kind === "failed") {
    stream.error(outcome.code);
  }
  stream.done();
}

function sendJsonError(res: Response, code: ErrorCode, detail?: Record<string, unknown>): void {
  if (res.writableEnded || res.destroyed) return;
  const { status, message } = ERRORS[code];
  res.status(status).json({ success: false, code, error: message, ...detail });
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
          message: DISAMBIGUATION_MESSAGE,
        },
      });
      return;
    case "failed":
      sendJsonError(res, outcome.code);
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
 * POST /api/analyze/resume. Errors: { code, error } with the status listed in ERRORS.
 */
router.post("/api/analyze", async (req: Request, res: Response) => {
  const startTime = Date.now();
  const query = parseQuery(req.body?.query);
  if (!query) {
    sendJsonError(res, "invalid_input", {
      detail: QUERY_ERROR,
      example: { query: "Midnight City M83" },
    });
    return;
  }

  const threadId = startAnalysis(query);
  console.log(`[Run ${threadId}] Analysis: "${query}"`);
  const control = new RunControl(req, res, threadId);
  try {
    const outcome = await executeRun({ songQuery: query }, threadId, control);
    sendJsonOutcome(res, outcome, threadId, { query, durationMs: Date.now() - startTime });
  } finally {
    control.dispose();
    activeThreads.delete(threadId);
  }
});

/**
 * Stream analysis with Server-Sent Events
 *
 * GET /api/analyze/stream?query=Song+Name
 *
 * Always answers 200. Messages (each a `data:` line with a `type`):
 * - connected { threadId }
 * - status: agent progress
 * - heartbeat: keeps the connection open; ignore it
 * - interrupt { threadId, candidates }: the user must pick a track; resume with the routes below
 * - complete { data }: the result, exactly once per finished run
 * - error { code, error }: a code from ERRORS and a short message
 * - done: the stream is over
 */
router.get("/api/analyze/stream", async (req: Request, res: Response) => {
  const stream = openEventStream(res);
  const query = parseQuery(req.query.query);
  if (!query) {
    stream.error("invalid_input");
    stream.done();
    return;
  }

  const threadId = startAnalysis(query);
  console.log(`[Run ${threadId}] Streaming analysis: "${query}"`);
  const control = new RunControl(req, res, threadId);
  stream.send({ type: "connected", threadId, timestamp: timestamp() });
  try {
    const outcome = await executeRun({ songQuery: query }, threadId, control, stream.send);
    sendStreamOutcome(stream, outcome, threadId);
  } finally {
    control.dispose();
    activeThreads.delete(threadId);
  }
});

/**
 * Resume after Human-in-the-loop selection
 *
 * POST /api/analyze/resume
 * Body: { "threadId": "...", "selectedTrackId": "spotify_track_id" }
 * Refusals: 409 resume_in_progress; 404 choice_expired, not_waiting or run_interrupted;
 * 400 invalid_selection or invalid_input.
 */
router.post("/api/analyze/resume", async (req: Request, res: Response) => {
  const threadId = parseId(req.body?.threadId);
  const selectedTrackId = parseId(req.body?.selectedTrackId);
  if (!threadId || !selectedTrackId) {
    sendJsonError(res, "invalid_input", {
      detail: RESUME_ERROR,
      example: { threadId: "<threadId>", selectedTrackId: "6GyFP1nfCDB8lbD2bG0Hq9" },
    });
    return;
  }

  await resumeThread(req, res, threadId, selectedTrackId, {
    refuse: (code) => sendJsonError(res, code),
    started: () => {},
    finish: (outcome) => sendJsonOutcome(res, outcome, threadId, { selectedTrackId }),
  });
});

/**
 * Resume streaming after selection
 *
 * GET /api/analyze/stream/resume?threadId=...&selectedTrackId=...
 *
 * The messages of /api/analyze/stream, starting with `resuming`. A resume that cannot run gets
 * one error message (codes as on POST /api/analyze/resume), then done.
 */
router.get("/api/analyze/stream/resume", async (req: Request, res: Response) => {
  const stream = openEventStream(res);
  const threadId = parseId(req.query.threadId);
  const selectedTrackId = parseId(req.query.selectedTrackId);
  if (!threadId || !selectedTrackId) {
    stream.error("invalid_input");
    stream.done();
    return;
  }

  await resumeThread(req, res, threadId, selectedTrackId, {
    refuse: (code) => {
      stream.error(code);
      stream.done();
    },
    started: () => stream.send({ type: "resuming", threadId, timestamp: timestamp() }),
    emit: stream.send,
    finish: (outcome) => {
      sendStreamOutcome(stream, outcome, threadId);
    },
  });
});

export default router;
