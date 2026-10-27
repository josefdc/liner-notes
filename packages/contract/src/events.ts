/**
 * Server-sent events of the analysis and factoid streams.
 *
 * Every message is a `data:` line holding one JSON event, discriminated on `type`, with the
 * run's id (`runId`) and the event's position in the stream (`seq`, from 0, one per event sent),
 * so a client can drop repeats and events of an older run. Heartbeats carry no `seq`: they are
 * sent on a timer, and counting them would make the numbering of a run depend on its timing.
 * Clients parse each event with `safeParse` and ignore types they do not know.
 *
 * The streams always answer HTTP 200 (EventSource cannot read other statuses): failures are an
 * `error` event with a code, followed by `done`.
 */

import { z } from "zod";
import { AudioFeatures } from "./audio.js";
import { Timestamp } from "./common.js";
import { Claim, Evidence } from "./evidence.js";
import { AudioUnavailableReason, Factoid, SearchCandidate, TrackAnalysis } from "./track.js";

/** Interval between heartbeat events on an open stream. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Error codes sent to clients, in `error` events and in JSON error bodies. The message that
 * comes with a code is short and generic; details stay in the server log. Producers use these;
 * readers take the code as an open string (`OpenErrorCode`), so an error with a code they do
 * not know yet is still shown, with its message.
 */
export const ErrorCode = z.enum([
  // Requests
  "invalid_input",
  "invalid_json",
  "bad_request",
  "forbidden_origin",
  "not_found",
  "payload_too_large",
  "unsupported_media_type",
  "rate_limited",
  // Resuming a run paused at the track picker
  "resume_in_progress",
  "choice_expired",
  "not_waiting",
  "run_interrupted",
  "invalid_selection",
  // Run outcomes
  "no_match",
  "upstream_unavailable",
  "timeout",
  "failed",
  "internal_error",
  // Cost and abuse controls: run token expired or missing; budget exhausted and the
  // track is not in the replay set; live analysis switched off (replay only)
  "auth_expired",
  "budget_exhausted",
  "live_disabled",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

/** An ErrorCode, or a code this reader does not know yet (kept as it is). */
export const OpenErrorCode = z.string().describe("An ErrorCode; other values are kept");

/**
 * Codes of the progress log shown in the console. Producers use these; `status` events carry
 * the code as an open string so a reader keeps an event with a code it does not know yet.
 */
export const LogCode = z.enum([
  "NET-100",
  "NET-200",
  "NET-400",
  "NET-500",
  "AUDIO-INIT",
  "AUDIO-PARSING",
  "AUDIO-COMPLETE",
  "AUDIO-ERROR",
  "GEMINI-CONNECT",
  "GEMINI-THOUGHT",
  "GEMINI-RESPONSE",
  "GEMINI-ERROR",
  "LLM-CONNECT",
  "LLM-RESPONSE",
  "LLM-ERROR",
  "SPOTIFY-SEARCH",
  "SPOTIFY-FOUND",
  "SPOTIFY-NONE",
  "RESEARCH-START",
  "RESEARCH-FOUND",
  "RESEARCH-DEEP",
  "VERIFY-START",
  "VERIFY-COMPLETE",
  "GRAPH-BUILD",
  "GRAPH-ENRICH",
  "GRAPH-COMPLETE",
  "SYS-INIT",
  "SYS-READY",
  "SYS-WARN",
  "SYS-ERROR",
]);
export type LogCode = z.infer<typeof LogCode>;

const envelope = {
  runId: z.string().min(1),
  seq: z.int().min(0),
};

const event = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...envelope, ...shape });

// =============================================================================
// Analysis stream: GET /api/analyze/stream and GET /api/analyze/stream/resume
// =============================================================================

/** The stream is open; `threadId` identifies the run for a later resume. */
export const ConnectedEvent = event("connected", {
  threadId: z.string(),
  timestamp: Timestamp.optional(),
});

/** A resume stream is open and the run continues with the chosen track. */
export const ResumingEvent = event("resuming", {
  threadId: z.string(),
  timestamp: Timestamp.optional(),
});

/** Progress of the agent. */
export const StatusEvent = event("status", {
  message: z.string(),
  code: z.string().optional().describe("A LogCode; other values are kept as they are"),
  node: z.string().optional(),
  timestamp: Timestamp.optional(),
});

/**
 * The run is paused until the user picks a track (the HITL clarification). The candidates are
 * sent once, here; resume with the thread id and the chosen candidate's id.
 */
export const InterruptEvent = event("interrupt", {
  reason: z.literal("disambiguation"),
  threadId: z.string(),
  candidates: z.array(SearchCandidate),
  message: z.string(),
});

/** An evidence item was added to the run's pack. */
export const EvidenceEvent = event("evidence", { evidence: Evidence });

/** A claim was written or its verdict changed (the latest event for a claim id wins). */
export const ClaimEvent = event("claim", { claim: Claim });

/** The audio measurement finished: features, or null with the reason. */
export const AudioEvent = event("audio", {
  audio: AudioFeatures.nullable(),
  unavailableReason: AudioUnavailableReason.nullable(),
});

/** Sent every HEARTBEAT_INTERVAL_MS while the stream is open; no `seq` (see above). */
export const HeartbeatEvent = z.object({ type: z.literal("heartbeat"), runId: envelope.runId });

/** The result. Sent exactly once per completed run. */
export const CompleteEvent = event("complete", { data: TrackAnalysis });

export const StreamErrorEvent = event("error", {
  code: OpenErrorCode,
  error: z.string().describe("Short message for the user"),
});

/** The stream is over; always the last event. */
export const DoneEvent = event("done", { timestamp: Timestamp.optional() });

export const AnalyzeStreamEvent = z.discriminatedUnion("type", [
  ConnectedEvent,
  ResumingEvent,
  StatusEvent,
  InterruptEvent,
  EvidenceEvent,
  ClaimEvent,
  AudioEvent,
  HeartbeatEvent,
  CompleteEvent,
  StreamErrorEvent,
  DoneEvent,
]);
export type AnalyzeStreamEvent = z.infer<typeof AnalyzeStreamEvent>;
export type AnalyzeStreamEventType = AnalyzeStreamEvent["type"];

// =============================================================================
// Factoid stream: GET /api/factoids/more/stream
// =============================================================================

const factoidEnvelope = {
  runId: z.string().min(1).nullable().describe("The analysis run the factoids are for, if known"),
  seq: z.int().min(0),
};

const factoidEvent = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.object({ type: z.literal(type), ...factoidEnvelope, ...shape });

export const FactoidStreamEvent = z.discriminatedUnion("type", [
  factoidEvent("connected", {
    timestamp: Timestamp.optional(),
    nextRound: z
      .int()
      .min(0)
      .optional()
      .describe("The round to ask for next (the round query parameter); absent for recorded facts"),
  }),
  factoidEvent("factoid", { data: Factoid, claim: Claim.optional() }),
  z.object({ type: z.literal("heartbeat"), runId: factoidEnvelope.runId }),
  factoidEvent("error", {
    code: OpenErrorCode,
    error: z.string(),
    index: z.int().min(0).optional().describe("Which factoid failed; absent for the stream"),
  }),
  factoidEvent("done", { timestamp: Timestamp.optional() }),
]);
export type FactoidStreamEvent = z.infer<typeof FactoidStreamEvent>;

// =============================================================================
// Wire format
// =============================================================================

/** One event as the server writes it to the stream. */
export function encodeSseEvent(event: AnalyzeStreamEvent | FactoidStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/**
 * The data of one SSE message block: its `data:` lines without the field name (and one space
 * after it), joined with "\n" as the SSE specification says. Other fields are ignored.
 */
export function sseData(block: string): string {
  return block
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""))
    .join("\n");
}

/**
 * The events of a stream body, parsed with `schema`: unknown types and malformed events are
 * skipped, as clients do. Only `data:` fields are read (a named `event:` line is ignored).
 */
export function decodeSseStream<S extends z.ZodType>(body: string, schema: S): Array<z.infer<S>> {
  const events: Array<z.infer<S>> = [];
  for (const block of body.split(/\r?\n\r?\n/)) {
    const data = sseData(block);
    if (!data) continue;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      continue;
    }
    const parsed = schema.safeParse(value);
    if (parsed.success) events.push(parsed.data);
  }
  return events;
}
