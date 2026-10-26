import { randomUUID } from "node:crypto";
import { type ReplayRecord, SPOTIFY_ID_PATTERN, TrackAnalysis } from "@liner-notes/contract";
import { type Request, type Response, Router } from "express";
import { Command } from "@langchain/langgraph";
import { createSonicAgentGraph } from "../../agent/graph.js";
import type { PickResume } from "../../agent/nodes/clarificationNode.js";
import { choiceMessage } from "../../agent/trackMatch.js";
import type { SearchCandidate, TrackData } from "../../agent/schema.js";
import type { PickedBy, ScoutFailure } from "../../agent/state.js";
import { runningCommit } from "../../config/checkoutCommit.js";
import { llm } from "../../llm/invoke.js";
import { logger, withRun } from "../../logger.js";
import { chooseReplay, liveRefused } from "../../replay/mode.js";
import { playRecord, replayedAnalysis } from "../../replay/player.js";
import { replays } from "../../replay/records.js";
import { pacingClock } from "../../sources/pacing.js";
import { getDb } from "../../store/database.js";
import {
  appendRunEvent,
  deleteRunEvents,
  getRun,
  clearRunCommitUnless,
  nextEventStream,
  type RunStatus,
  runExists,
  type StoreResultOutcome,
  startRun,
  storeReplayOf,
  storeRunResult,
  updateRun,
} from "../../store/runs.js";
import { asyncRoute, eventStreamHead, HTTP_ERRORS, markFailed } from "../middleware/errors.js";
import { nodeEvent, openAnalysisStream } from "../sse.js";

const router = Router();
const log = logger("Run");

/**
 * The commit of the code this server runs, read when the routes are loaded and stored with each
 * run, so a recording of a run names the code it ran with (null when it cannot be read).
 */
const SERVER_COMMIT = runningCommit();

// =============================================================================
// Limits and errors
// =============================================================================

/** Longest accepted query, in characters (code points). */
export const MAX_QUERY_LENGTH = 200;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;

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
 * message (shared with the other routes where the code is the same). Details stay in the server
 * log. The stream routes always answer 200 (EventSource
 * cannot read any other status) and send the code and message as an `error` message.
 */
const ERRORS = {
  invalid_input: HTTP_ERRORS.invalid_input,
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
  upstream_unavailable: HTTP_ERRORS.upstream_unavailable,
  timeout: { status: 504, message: "The analysis took too long. Please try again." },
  failed: HTTP_ERRORS.failed,
  live_disabled: HTTP_ERRORS.live_disabled,
  budget_exhausted: {
    status: 503,
    message:
      "Live analysis is paused for now: its budget is spent. Only the recorded showcase tracks can be shown.",
  },
} as const;

type ErrorCode = keyof typeof ERRORS;
type FailureCode = "no_match" | "upstream_unavailable" | "timeout" | "failed";

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

/**
 * The optional Spotify track id of an analysis request (a suggestion or a node): absent is
 * `undefined`; anything that is not a Spotify id (22 base-62 characters) is `null`, refused.
 */
function parseTrackId(value: unknown): string | null | undefined {
  if (value === undefined || value === "") return undefined;
  return typeof value === "string" && SPOTIFY_ID_PATTERN.test(value) ? value : null;
}

/** How a resume says the track was picked; absent or unknown values are `null` (not said). */
function parsePickedBy(value: unknown): PickedBy | null {
  return value === "click" || value === "countdown" ? value : null;
}

const QUERY_ERROR =
  `'query' is required: a song name of at most ${MAX_QUERY_LENGTH} characters; ` +
  "'trackId', when given, is a Spotify track id (22 letters and digits)";
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
    logger("Runs").error(`Could not ${action}`, { err });
  }
}

/**
 * Runs `body` as part of run `runId`: every line it logs, and the request's own line, carries
 * the run id (logger.ts).
 */
function asRun<T>(res: Response, runId: string, body: () => T): T {
  res.locals.runId = runId;
  return withRun(runId, body);
}

/**
 * The first line of a run: how it was asked for, and the length of the query. What the visitor
 * typed is written at debug level only.
 */
function logRunStart(runId: string, how: string, query: string): void {
  log.info(how, { runId, queryLength: [...query].length });
  log.debug(`${how}: query`, { runId, query });
}

/** Starts a new analysis: a fresh thread, claimed and recorded as an open run. */
function startAnalysis(threadId: string, query: string): void {
  activeThreads.add(threadId);
  recordRun("record a run", (db) =>
    startRun(db, { runId: threadId, threadId, query, commit: SERVER_COMMIT }),
  );
}

/**
 * Reopens the thread's run (or records one, for a thread paused before runs were recorded). The
 * time the run waited for the choice is added to its paused time, which its duration leaves out
 * (runs.ts). The rest of the run goes on with this server's code: a commit stored by a server at
 * another commit is cleared, and a run recorded here only now has none (its start ran on code
 * unknown here), nor a known duration (its start and its wait are not known here).
 */
function reopenRun(threadId: string, query: string): void {
  recordRun("reopen a run", (db) => {
    if (updateRun(db, threadId, { status: "running" })) {
      clearRunCommitUnless(db, threadId, SERVER_COMMIT);
    } else {
      startRun(db, { runId: threadId, threadId, query, commit: null, pausesKnown: false });
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

  /** When the deadline passes, on the monotonic clock; set by startDeadline. */
  deadlineAt: number | undefined;

  startDeadline(): void {
    this.deadlineAt = performance.now() + runDeadlineMs;
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
    log.warn(`${reason}; run aborted`, { runId: this.threadId });
  }
}

// =============================================================================
// Graph runner
// =============================================================================

/** A graph node's writer payload, or the result the route reports once (`complete`). */
type AgentEvent = { type: string; [field: string]: unknown };

/**
 * Where a run's events go. It returns false only for a result the client was not sent because
 * it fails the contract (the client got an error instead), so the run is not recorded as
 * completed.
 */
type Emit = (event: AgentEvent) => boolean;

/** A new run's initial state, or a Command({ resume }) that continues a paused one. */
type GraphInput = Parameters<ReturnType<typeof createSonicAgentGraph>["stream"]>[0];

type RunOutcome =
  /** `fromAnotherRun`: the result was composed by an earlier run (a cached one). */
  | { kind: "complete"; trackData: TrackData; fromAnotherRun?: boolean }
  | { kind: "interrupted"; candidates: SearchCandidate[] }
  /** `rateLimit`: Spotify kept rate limiting the run; how long it asked to wait, when it said. */
  | { kind: "failed"; code: FailureCode; rateLimit?: { retryAfterMs: number | null } }
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
 * Why a node's update ends the run, as a failure code. Only the scout says why, as a type
 * (`scoutFailure`): nothing matched is "no_match"; Spotify rate limiting or failing is
 * "upstream_unavailable". Any other error of any node is a plain failure. No text is read.
 */
export function failureOf(
  node: string,
  update: { scoutFailure?: ScoutFailure | null },
): FailureCode {
  if (node !== "scout" || !update.scoutFailure) return "failed";
  return update.scoutFailure.kind === "no_match" ? "no_match" : "upstream_unavailable";
}

/**
 * What the user is told when Spotify kept rate limiting the run: the service and, when it said,
 * how long to wait (the code stays upstream_unavailable).
 */
export function rateLimitMessage(retryAfterMs: number | null): string {
  if (retryAfterMs === null || retryAfterMs <= 0) {
    return "Spotify is limiting requests right now. Please try again in a moment.";
  }
  const seconds = Math.ceil(retryAfterMs / 1000);
  const wait = seconds < 120 ? `${seconds} s` : `${Math.ceil(seconds / 60)} min`;
  return `Spotify is limiting requests right now. Please try again in about ${wait}.`;
}

/**
 * Runs the graph on one thread until it ends or pauses at an interrupt. The nodes' writer
 * payloads go to `emit` as they are (the stream adapter translates them). `complete` is emitted
 * exactly once, from here, whichever node produced the result: nodes report it both through the
 * writer and in their state update. A result that was already sent counts as complete even if
 * the run is aborted afterwards; one refused by the contract check is a failure.
 */
async function runGraph(
  input: GraphInput,
  threadId: string,
  signal: AbortSignal,
  emit: Emit,
): Promise<RunOutcome> {
  const seen: {
    trackData: TrackData | null;
    refused: boolean;
    interrupt: DisambiguationPayload | null;
    failure: FailureCode | null;
    rateLimit: { retryAfterMs: number | null } | null;
  } = { trackData: null, refused: false, interrupt: null, failure: null, rateLimit: null };

  const completeWith = (data: TrackData) => {
    if (seen.trackData) return;
    seen.trackData = data;
    if (!emit({ type: "complete", data })) seen.refused = true;
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
        const event = data as Partial<AgentEvent> | null;
        if (event?.type === "complete") {
          if (event.data) completeWith(event.data as TrackData);
        } else {
          emit(data as AgentEvent);
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
        const state = update as {
          trackData?: TrackData;
          error?: string;
          scoutFailure?: ScoutFailure | null;
        } | null;
        if (state?.trackData) completeWith(state.trackData);
        if (state?.error) {
          log.error(`${node} reported an error: ${state.error}`, { runId: threadId, node });
          if (!seen.failure && node === "scout" && state.scoutFailure?.kind === "rate_limited") {
            seen.rateLimit = { retryAfterMs: state.scoutFailure.retryAfterMs };
          }
          seen.failure ??= failureOf(node, state);
        }
      }
    }
  } catch (err) {
    threw = err;
  }

  if (seen.refused) {
    log.error("The result fails the contract; run failed", { runId: threadId });
    return { kind: "failed", code: "failed" };
  }
  if (seen.trackData) return { kind: "complete", trackData: seen.trackData };
  if (seen.interrupt) return { kind: "interrupted", candidates: seen.interrupt.candidates ?? [] };
  if (signal.aborted) return { kind: "cancelled" };
  if (threw) log.error("Graph error", { runId: threadId, err: threw });
  else if (!seen.failure) log.error("Graph ended without a result", { runId: threadId });
  return {
    kind: "failed",
    code: seen.failure ?? "failed",
    ...(seen.rateLimit ? { rateLimit: seen.rateLimit } : {}),
  };
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
 * timeout. A result that fails the contract is a failed run on every route (the stream refuses
 * it as it is sent; here POST /api/analyze does too). A run that failed or was cancelled before
 * the choice was applied leaves the thread waiting for it, so it is recorded as interrupted:
 * retention keeps it and it can be resumed.
 */
async function executeRun(
  input: GraphInput,
  threadId: string,
  control: RunControl,
  emit: Emit = () => true,
): Promise<RunOutcome> {
  control.startDeadline();
  // The run's own signal goes with the run's context, so a node stopped by it is told apart
  // from one LangGraph stops because another node failed (agent/graph.ts); so does its
  // deadline, so the verifier's judge can take only its share of the time left.
  let outcome = await withRun(threadId, () => runGraph(input, threadId, control.signal, emit), {
    signal: control.signal,
    deadlineAt: control.deadlineAt,
  });
  if (outcome.kind === "cancelled" && control.timedOut)
    outcome = { kind: "failed", code: "timeout" };
  if (outcome.kind === "complete" && !TrackAnalysis.safeParse(outcome.trackData).success) {
    log.error("The result fails the contract; run failed", { runId: threadId });
    outcome = { kind: "failed", code: "failed" };
  }

  let status = OUTCOME_STATUS[outcome.kind];
  if (outcome.kind === "failed" || outcome.kind === "cancelled") {
    try {
      if ((await pendingChoice(threadId)).choice) status = "interrupted";
    } catch (err) {
      log.error("Could not read the thread", { runId: threadId, err });
    }
  }
  if (recordOutcome(threadId, status, outcome) && outcome.kind === "complete") {
    outcome = { ...outcome, fromAnotherRun: true };
  }
  // A finished run's model calls are no longer counted; a paused one keeps its count, so the
  // per-run cap still covers it when it is resumed.
  if (status !== "interrupted") endModelRun(threadId);
  log.info(`${outcome.kind}; recorded ${status}`, {
    runId: threadId,
    outcome: outcome.kind,
    status,
  });
  return outcome;
}

/**
 * Records a run's status and, for a completed run, its result, in one transaction, so GET
 * /api/runs can serve the result again. When the result cannot be written the status is
 * recorded on its own: the client has the result, and the run must not stay open. A run that
 * sent a result another run composed keeps no events (deleteRunEvents). Returns true for such a
 * run.
 */
function recordOutcome(runId: string, status: RunStatus, outcome: RunOutcome): boolean {
  const trackData = outcome.kind === "complete" ? outcome.trackData : null;
  let stored: StoreResultOutcome | null = null;
  try {
    getDb().transaction(() => {
      const db = getDb();
      updateRun(db, runId, { status });
      if (trackData) stored = storeRunResult(db, runId, trackData);
      if (stored === "another_run") deleteRunEvents(db, runId);
    })();
  } catch (err) {
    logger("Runs").error("Could not record the outcome of the run", { runId, err });
    recordRun("update a run", (db) => updateRun(db, runId, { status }));
    return false;
  }
  if (stored === "another_run") {
    log.info("Sent a result composed by another run; not stored as its own", { runId });
    return true;
  }
  if (stored && stored !== "stored") log.error(`Result not stored: ${stored}`, { runId });
  return false;
}

/** Forgets a finished run's call count in the provider layer. Never fails the run. */
function endModelRun(runId: string): void {
  try {
    llm.endRun(runId);
  } catch (err) {
    log.warn("Could not end the model run", { runId, err });
  }
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
    log.error("Could not read the thread", { runId: threadId, err });
    return { ok: false, code: "failed" };
  }
}

interface ResumeReply {
  refuse(code: ErrorCode): void;
  started(): void;
  emit?: Emit;
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
  pickedBy: PickedBy | null,
  reply: ResumeReply,
): Promise<void> {
  log.info(`Resuming with track ${selectedTrackId}`, { runId: threadId });
  const control = new RunControl(req, res, threadId);

  const check = await claimResume(threadId, selectedTrackId);
  if (!check.ok) {
    log.warn(`Resume refused: ${check.code}`, { runId: threadId, code: check.code });
    reply.refuse(check.code);
    return;
  }

  try {
    if (control.clientGone) {
      log.warn("Client left before the resume started; choice kept", { runId: threadId });
      return;
    }
    // Reopened first, so a run paused before runs were recorded has a record to store events in.
    reopenRun(threadId, check.query);
    reply.started();
    const outcome = await executeRun(
      new Command({
        resume: {
          trackId: selectedTrackId,
          ...(pickedBy ? { pickedBy } : {}),
        } satisfies PickResume,
      }),
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

const timestamp = () => new Date().toISOString();

/** Streams whose events stopped being stored because a write failed. */
let unstoredStreams = 0;

/** How many streams this process stopped storing because an event write failed; for tests. */
export function unstoredStreamCount(): number {
  return unstoredStreams;
}

/**
 * The analysis stream of run `runId`: status 200 with the headers flushed at once (EventSource
 * cannot read any other status, so errors are sent in the stream), a heartbeat every
 * HEARTBEAT_INTERVAL_MS that keeps proxies from closing an idle connection, and every event
 * built and checked by the stream adapter (../sse.ts).
 *
 * Once `storeEvents` is called (when the request has claimed the run, and the run has a
 * record) the events it sends are stored with the run, as the run's next stream: a resume's
 * events follow the earlier stream's instead of clashing with them, since each stream numbers
 * its events from 0. The events of a request that was refused before it claimed the run are not
 * stored. When an event cannot be stored, the stream stops storing: what is stored is always the
 * stream as it was sent up to some point, never a stream with an event missing.
 */
function openEventStream(res: Response, runId?: string) {
  let storedAs: number | null = null;
  const stream = openAnalysisStream(res, runId, {
    onSent: (event) => {
      const streamNumber = storedAs;
      if (!runId || streamNumber === null) return;
      try {
        appendRunEvent(getDb(), runId, streamNumber, event);
      } catch (err) {
        storedAs = null;
        unstoredStreams += 1;
        logger("Runs").error(
          `Could not store event ${event.seq} of the run; the rest of this stream is not ` +
            `stored (${unstoredStreams} streams cut short since start)`,
          { runId, err },
        );
      }
    },
  });
  return {
    stream,
    /** Stores no more of this stream's events. */
    stopStoringEvents(): void {
      storedAs = null;
    },
    storeEvents(): void {
      if (!runId) return;
      recordRun("number a stream", (db) => {
        if (runExists(db, runId)) storedAs = nextEventStream(db, runId);
      });
    },
    /**
     * Sends a graph node's writer payload, translated to a contract event. False when the
     * result (`complete`) failed the contract and the client was sent an error in its place; a
     * result not written because the client has gone is not a failure.
     */
    emit(payload: AgentEvent): boolean {
      if (payload?.type === "complete") {
        stream.send(payload);
        return stream.outcome !== "error";
      }
      const event = nodeEvent(payload);
      if (event) stream.send(event);
      return true;
    },
    error: (code: ErrorCode, message: string = ERRORS[code].message) => stream.error(code, message),
    done: () => stream.done(),
  };
}

type AnalysisStream = ReturnType<typeof openEventStream>;

/**
 * Sends a run's last messages (`complete` was sent as it happened). A cancelled run's client is
 * gone, so it only closes the stream.
 */
function sendStreamOutcome(
  { stream, error, done, stopStoringEvents }: AnalysisStream,
  outcome: RunOutcome,
  threadId: string,
): void {
  // Its events were deleted with the outcome; the closing `done` is not stored either.
  if (outcome.kind === "complete" && outcome.fromAnotherRun) stopStoringEvents();
  if (outcome.kind === "interrupted") {
    stream.send({
      type: "interrupt",
      reason: "disambiguation",
      threadId,
      candidates: outcome.candidates,
      message: choiceMessage(outcome.candidates.length),
    });
  } else if (outcome.kind === "failed") {
    if (outcome.rateLimit) error(outcome.code, rateLimitMessage(outcome.rateLimit.retryAfterMs));
    else error(outcome.code);
  }
  done();
}

/**
 * Runs a stream route's body; an unexpected error ends the stream with a typed `error` and
 * `done` instead of cutting the response off.
 */
async function guardStream(stream: AnalysisStream, body: () => Promise<void>): Promise<void> {
  try {
    await body();
  } catch (err) {
    log.error("Stream route failed", { runId: stream.stream.runId, err });
    stream.error("failed");
    stream.done();
  }
}

function sendJsonError(
  res: Response,
  code: ErrorCode,
  detail?: Record<string, unknown>,
  message: string = ERRORS[code].message,
): void {
  if (res.writableEnded || res.destroyed) return;
  res.status(ERRORS[code].status).json({ success: false, code, error: message, ...detail });
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
          message: choiceMessage(outcome.candidates.length),
        },
      });
      return;
    case "failed":
      if (outcome.rateLimit) {
        // Retry-After, in seconds, when Spotify said how long to wait.
        const { retryAfterMs } = outcome.rateLimit;
        if (retryAfterMs !== null && retryAfterMs > 0) {
          res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
        }
        sendJsonError(res, outcome.code, { retryAfterMs }, rateLimitMessage(retryAfterMs));
        return;
      }
      sendJsonError(res, outcome.code);
      return;
    case "cancelled":
      return;
  }
}

// =============================================================================
// Replays (REPLAY_MODE)
// =============================================================================

/** The recording a replay of `record` serves (see storeReplayOf). */
const replayOf = (record: ReplayRecord) => ({
  slug: record.slug,
  recordedAt: record.recordedAt,
  digest: replays().digest(record),
});

/**
 * Starts a replay of `record`: a fresh run, claimed and recorded as a replay from the start
 * (storeReplayOf), so it never reads as live whatever its outcome.
 */
function startReplay(runId: string, query: string, record: ReplayRecord): void {
  activeThreads.add(runId);
  recordRun("record a replay", (db) =>
    db.transaction(() => {
      startRun(db, { runId, threadId: runId, query, commit: SERVER_COMMIT });
      storeReplayOf(db, runId, replayOf(record));
    })(),
  );
}

/**
 * Records a replayed run's outcome: its status and, once it completed, its track, so GET
 * /api/runs/by-track serves it as the track's latest run. Neither the result nor the events are
 * copied: the record holds them. A failure to record is logged.
 */
function recordReplay(runId: string, status: RunStatus, record: ReplayRecord): void {
  recordRun("record a replay", (db) =>
    db.transaction(() => {
      updateRun(db, runId, { status });
      if (status === "completed") {
        storeReplayOf(db, runId, replayOf(record), record.analysis.id);
      }
    })(),
  );
}

/**
 * Serves a recorded run as a new run, with its own run id (startReplay, recordReplay). The events
 * the stream sends are not stored.
 */
async function replayStreamRun(res: Response, query: string, record: ReplayRecord): Promise<void> {
  const runId = randomUUID();
  await asRun(res, runId, () => replayStream(res, runId, query, record));
}

async function replayStream(
  res: Response,
  runId: string,
  query: string,
  record: ReplayRecord,
): Promise<void> {
  startReplay(runId, query, record);
  const stream = openEventStream(res, runId);
  logRunStart(runId, "Streaming a replay", query);
  log.info(`Replaying the recorded run ${record.slug}`, { runId, replay: record.slug });
  await guardStream(stream, async () => {
    try {
      const analysis = await playRecord(
        record,
        runId,
        (body) => (body.type === "complete" ? stream.emit(body) : stream.stream.send(body)),
        stream.stream.signal,
      );
      const outcome: RunOutcome = analysis
        ? { kind: "complete", trackData: analysis as unknown as TrackData }
        : stream.stream.closed
          ? { kind: "cancelled" }
          : { kind: "failed", code: "failed" };
      recordReplay(runId, OUTCOME_STATUS[outcome.kind], record);
      log.info(`Replay ${outcome.kind}; recorded ${OUTCOME_STATUS[outcome.kind]}`, {
        runId,
        outcome: outcome.kind,
        status: OUTCOME_STATUS[outcome.kind],
      });
      sendStreamOutcome(stream, outcome, runId);
    } finally {
      activeThreads.delete(runId);
    }
  });
}

/** POST /api/analyze for a recorded track: the recorded result as a new, completed run. */
function replayJsonRun(res: Response, query: string, record: ReplayRecord): void {
  const runId = randomUUID();
  asRun(res, runId, () => {
    startReplay(runId, query, record);
    try {
      logRunStart(runId, "Analysis of a recorded track", query);
      const analysis = replayedAnalysis(record, runId);
      const outcome: RunOutcome = { kind: "complete", trackData: analysis as unknown as TrackData };
      recordReplay(runId, "completed", record);
      log.info(`Served the recorded run ${record.slug}`, { runId, replay: record.slug });
      sendJsonOutcome(res, outcome, runId, { query, durationMs: 0 });
    } finally {
      activeThreads.delete(runId);
    }
  });
}

/**
 * A new run's input: the query, and the Spotify track it asks for when one was chosen (a
 * suggestion, a genealogy node, a picker row without a thread): the scout then reads that track
 * instead of searching the text. `pickedBy` says how a picker row was picked, as on a resume.
 */
function runInput(query: string, trackId: string | undefined, pickedBy: PickedBy | null) {
  return {
    songQuery: query,
    ...(trackId ? { requestedTrackId: trackId } : {}),
    ...(trackId && pickedBy ? { pickedBy } : {}),
  };
}

/**
 * The recording a request is answered with under REPLAY_MODE: for a request by track id the
 * recording of that very track (never another track that shares its title and artist), else
 * the recording the query names.
 */
function recordFor(
  records: {
    forQuery(query: string): ReplayRecord | null;
    forTrack(id: string): ReplayRecord | null;
  },
  query: string,
  trackId: string | undefined,
): ReplayRecord | null {
  return trackId ? records.forTrack(trackId) : records.forQuery(query);
}

// =============================================================================
// Routes
// =============================================================================

// HEAD on a stream gets its headers only; it never starts or resumes a run.
router.head(["/api/analyze/stream", "/api/analyze/stream/resume"], eventStreamHead);

/**
 * Analyze a song (non-streaming)
 *
 * POST /api/analyze
 * Body: { "query": "Song name Artist", "trackId"?: "<Spotify track id>", "pickedBy"?: "click" |
 * "countdown" }. With `trackId` that track is analysed, without searching the query; the result
 * still says how the query matches it. A Spotify rate limit is answered 502 upstream_unavailable
 * with a message naming it, `retryAfterMs` and a Retry-After header when Spotify said how long.
 * Returns { status: "complete", threadId, data } or, when the song is ambiguous,
 * { status: "interrupted", threadId, interrupt: { candidates } }; resume with
 * POST /api/analyze/resume. Errors: { code, error } with the status listed in ERRORS. Under
 * REPLAY_MODE (as for the stream below) a recorded track is answered with its recorded result
 * as a new run, and any other query with 503 live_disabled (or budget_exhausted).
 */
router.post(
  "/api/analyze",
  asyncRoute(async (req: Request, res: Response) => {
    // On the monotonic clock, so a step of the wall clock does not change the run's duration.
    const startTime = pacingClock();
    const query = parseQuery(req.body?.query);
    const trackId = parseTrackId(req.body?.trackId);
    if (!query || trackId === null) {
      sendJsonError(res, "invalid_input", {
        detail: QUERY_ERROR,
        example: { query: "Midnight City M83" },
      });
      return;
    }

    const replay = await chooseReplay((records) => recordFor(records, query, trackId));
    if (replay.kind === "refused") {
      sendJsonError(res, replay.code);
      return;
    }
    if (replay.kind === "replay") {
      replayJsonRun(res, query, replay.record);
      return;
    }

    const threadId = randomUUID();
    await asRun(res, threadId, async () => {
      startAnalysis(threadId, query);
      logRunStart(threadId, "Analysis", query);
      const control = new RunControl(req, res, threadId);
      try {
        const outcome = await executeRun(
          runInput(query, trackId, parsePickedBy(req.body?.pickedBy)),
          threadId,
          control,
        );
        sendJsonOutcome(res, outcome, threadId, {
          query,
          durationMs: Math.round(pacingClock() - startTime),
        });
      } finally {
        control.dispose();
        activeThreads.delete(threadId);
      }
    });
  }),
);

/**
 * Stream analysis with Server-Sent Events
 *
 * GET /api/analyze/stream?query=Song+Name[&trackId=<Spotify track id>] (as POST /api/analyze)
 *
 * Always answers 200. Messages: each a `data:` line holding one AnalyzeStreamEvent of
 * @liner-notes/contract, with the run id (the thread id) and `seq` (0, 1, 2…; heartbeats have none):
 * - connected { threadId }
 * - status: agent progress
 * - heartbeat: keeps the connection open; ignore it
 * - interrupt { threadId, candidates }: the user must pick a track (the candidates are sent here
 *   only); resume with the routes below
 * - complete { data }: the result, exactly once per finished run
 * - error { code, error }: a code from ERRORS and a short message
 * - done: the stream is over
 *
 * The run's result is stored with it and served by GET /api/runs/:id; the events sent are stored
 * for recording the run as a replay (not for a run that sent another run's result).
 *
 * Under REPLAY_MODE=only (or fallback while live analysis is unavailable) a query that names a
 * recorded track replays its recording as a new run (the same messages; the result says
 * `mode: "replay"` with when and from which commit it was recorded), and any other query gets
 * one `error`, then done: live_disabled, or budget_exhausted when fallback paused live analysis
 * because the model budget is spent (replay/mode.ts). Never a result made up in its place.
 */
router.get(
  "/api/analyze/stream",
  asyncRoute(async (req: Request, res: Response) => {
    const query = parseQuery(req.query.query);
    const trackId = parseTrackId(req.query.trackId);
    if (!query || trackId === null) {
      const stream = openEventStream(res);
      markFailed(res);
      stream.error("invalid_input");
      stream.done();
      return;
    }

    // Decided before anything live is built: under REPLAY_MODE=only nothing live ever runs.
    const replay = await chooseReplay((records) => recordFor(records, query, trackId));
    if (replay.kind === "refused") {
      const stream = openEventStream(res);
      stream.error(replay.code);
      stream.done();
      return;
    }
    if (replay.kind === "replay") {
      await replayStreamRun(res, query, replay.record);
      return;
    }

    // The run id is the thread id.
    const threadId = randomUUID();
    await asRun(res, threadId, async () => {
      startAnalysis(threadId, query);
      const stream = openEventStream(res, threadId);
      stream.storeEvents();
      logRunStart(threadId, "Streaming analysis", query);
      const control = new RunControl(req, res, threadId);
      await guardStream(stream, async () => {
        try {
          stream.stream.send({ type: "connected", threadId, timestamp: timestamp() });
          const outcome = await executeRun(
            runInput(query, trackId, parsePickedBy(req.query.pickedBy)),
            threadId,
            control,
            stream.emit,
          );
          sendStreamOutcome(stream, outcome, threadId);
        } finally {
          control.dispose();
          activeThreads.delete(threadId);
        }
      });
    });
  }),
);

/**
 * Resume after Human-in-the-loop selection
 *
 * POST /api/analyze/resume
 * Body: { "threadId": "...", "selectedTrackId": "spotify_track_id", "pickedBy"?: "click" | "countdown" }
 * (`pickedBy`: how the track was picked; a deliberate click is not warned about a loose match)
 * Refusals: 409 resume_in_progress; 404 choice_expired, not_waiting or run_interrupted;
 * 400 invalid_selection or invalid_input; 503 live_disabled or budget_exhausted when live services
 * may not be used (REPLAY_MODE).
 */
router.post(
  "/api/analyze/resume",
  asyncRoute(async (req: Request, res: Response) => {
    const threadId = parseId(req.body?.threadId);
    const selectedTrackId = parseId(req.body?.selectedTrackId);
    if (!threadId || !selectedTrackId) {
      sendJsonError(res, "invalid_input", {
        detail: RESUME_ERROR,
        example: { threadId: "<threadId>", selectedTrackId: "6GyFP1nfCDB8lbD2bG0Hq9" },
      });
      return;
    }
    // A recorded run never pauses; a paused live run cannot go on without live services.
    const refused = await liveRefused();
    if (refused) {
      sendJsonError(res, refused);
      return;
    }

    await asRun(res, threadId, () =>
      resumeThread(req, res, threadId, selectedTrackId, parsePickedBy(req.body?.pickedBy), {
        refuse: (code) => sendJsonError(res, code),
        started: () => {},
        finish: (outcome) => sendJsonOutcome(res, outcome, threadId, { selectedTrackId }),
      }),
    );
  }),
);

/**
 * Resume streaming after selection
 *
 * GET /api/analyze/stream/resume?threadId=...&selectedTrackId=...[&pickedBy=click|countdown]
 *
 * The messages of /api/analyze/stream, starting with `resuming`. A resume that cannot run gets
 * one error message (codes as on POST /api/analyze/resume), then done.
 */
router.get(
  "/api/analyze/stream/resume",
  asyncRoute(async (req: Request, res: Response) => {
    const threadId = parseId(req.query.threadId);
    const selectedTrackId = parseId(req.query.selectedTrackId);
    // A resume continues the thread's run, under the same run id.
    const stream = openEventStream(res, threadId ?? undefined);
    if (!threadId || !selectedTrackId) {
      markFailed(res);
      stream.error("invalid_input");
      stream.done();
      return;
    }
    const refused = await liveRefused();
    if (refused) {
      stream.error(refused);
      stream.done();
      return;
    }

    await asRun(res, threadId, () =>
      guardStream(stream, () =>
        resumeThread(req, res, threadId, selectedTrackId, parsePickedBy(req.query.pickedBy), {
          refuse: (code) => {
            stream.error(code);
            stream.done();
          },
          started: () => {
            stream.storeEvents();
            stream.stream.send({ type: "resuming", threadId, timestamp: timestamp() });
          },
          emit: stream.emit,
          finish: (outcome) => {
            sendStreamOutcome(stream, outcome, threadId);
          },
        }),
      ),
    );
  }),
);

export default router;
