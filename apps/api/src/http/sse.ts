/**
 * The server side of the event streams: every message the analysis and factoid streams send is
 * built here, as an event of the contract's union (`AnalyzeStreamEvent`, `FactoidStreamEvent`).
 *
 * A stream stamps each event with its run's id (`runId`) and its position in the stream (`seq`,
 * from 0, one per event written; heartbeats carry none), checks it against the contract and
 * writes it with `encodeSseEvent`. An event that fails the check is a bug and is never sent.
 * When it is the run's outcome (`complete`, `interrupt`) or a factoid, a typed `error` (code
 * `failed`) takes its place, so the client is not left waiting; any other event (progress) is
 * logged, counted and dropped, and the run goes on. Once the client has gone nothing more is
 * written, and `done` is always the last event.
 */

import { randomUUID } from "node:crypto";
import {
  AnalyzeStreamEvent,
  encodeSseEvent,
  type ErrorCode,
  FactoidStreamEvent,
  HEARTBEAT_INTERVAL_MS,
} from "@liner-notes/contract";
import type { Response } from "express";
import type { z } from "zod";

/** An event as a route builds it: its type and fields, without `runId` and `seq`. */
export type EventBody = { type: string; [field: string]: unknown };

/** The message sent in place of an event that failed the contract check. */
export const INVALID_EVENT_MESSAGE = "The request could not be completed. Please try again.";

interface StreamKind {
  /** Name for log lines. */
  name: string;
  schema: z.ZodType;
  /**
   * Events after which the stream only ends: on the analysis stream the run's outcome
   * (`complete`, `interrupt` or `error`), so a client sees exactly one of them.
   */
  outcomes: ReadonlySet<string>;
  /**
   * Events that are replaced by an `error` (code `failed`) when they fail the contract: the
   * client is waiting for them. Any other event that fails is dropped.
   */
  replaced: ReadonlySet<string>;
}

const ANALYSIS: StreamKind = {
  name: "analysis",
  schema: AnalyzeStreamEvent,
  outcomes: new Set(["complete", "interrupt", "error"]),
  replaced: new Set(["complete", "interrupt"]),
};
// On the factoid stream an error is one factoid's: the others still follow.
const FACTOIDS: StreamKind = {
  name: "factoids",
  schema: FactoidStreamEvent,
  outcomes: new Set(),
  replaced: new Set(["factoid"]),
};

/** Events dropped because they failed the contract (or a node may not send them). */
let droppedEvents = 0;

/** How many events this process has dropped instead of sending; for logs and tests. */
export function droppedEventCount(): number {
  return droppedEvents;
}

function dropEvent(stream: string, type: string, reason: string, detail?: unknown): void {
  droppedEvents += 1;
  console.error(
    `[SSE ${stream}] ${type} event dropped: ${reason} (${droppedEvents} dropped since start)`,
    detail ?? "",
  );
}

export interface EventStream {
  readonly runId: string | null;
  /**
   * The outcome event the client was sent (`complete`, `interrupt` or `error`), or null. An
   * outcome that failed the contract reads `error`: the client got the error in its place.
   */
  readonly outcome: string | null;
  /** True once the client has gone (the response closed before it was ended). */
  readonly closed: boolean;
  /** Aborts when the client goes away. */
  readonly signal: AbortSignal;
  /**
   * Sends one event; false when it was not written (client gone, after the outcome, invalid).
   * `replacedWith` is added to the `error` sent in place of an event that fails the contract
   * (a factoid's `index`).
   */
  send(event: EventBody, replacedWith?: Record<string, unknown>): boolean;
  /** Sends an `error` event with a code and a short message for the user. */
  error(code: ErrorCode, message: string, detail?: Record<string, unknown>): boolean;
  /** Sends `done` (once) and ends the response. */
  done(): void;
}

/** An event the stream wrote, with its run id and seq. */
export type SentEvent = EventBody & { runId: string | null; seq: number };

export interface EventStreamOptions {
  /** Interval between heartbeat events; 0 sends none. */
  heartbeatMs?: number;
  /**
   * Called with each event written that carries a seq (every event but heartbeats), once it is
   * written: the event as the contract reads it (fields the contract does not name are left
   * out). An error it throws is logged and does not affect the stream.
   */
  onSent?: (event: SentEvent) => void;
}

/** Writes the headers of an event stream (status 200) and flushes them at once. */
function writeHead(res: Response): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

function openStream(
  kind: StreamKind,
  res: Response,
  runId: string | null,
  { heartbeatMs = HEARTBEAT_INTERVAL_MS, onSent }: EventStreamOptions = {},
): EventStream {
  writeHead(res);

  const sent = (event: SentEvent) => {
    try {
      onSent?.(event);
    } catch (err) {
      console.error(`[SSE ${kind.name}] ${event.type} event sent but not observed:`, err);
    }
  };

  let seq = 0;
  let outcome: string | null = null;
  let ended = false;
  const disconnect = new AbortController();
  const writable = () =>
    !ended && !disconnect.signal.aborted && !res.writableEnded && !res.destroyed;

  /**
   * The event as one SSE message, or the reason it cannot be sent: it fails the contract, or
   * it cannot be encoded.
   */
  const encode = (
    event: Record<string, unknown> & { type: string },
  ): { line: string; checked: SentEvent } | { problem: string; detail: unknown } => {
    const checked = kind.schema.safeParse(event);
    if (!checked.success) {
      return {
        problem: "it fails the contract",
        detail: checked.error.issues.map(
          (issue) => `${issue.path.join(".") || "(event)"}: ${issue.message}`,
        ),
      };
    }
    try {
      return {
        line: encodeSseEvent(event as AnalyzeStreamEvent),
        checked: checked.data as SentEvent,
      };
    } catch (err) {
      return { problem: "it cannot be encoded", detail: err };
    }
  };

  /**
   * Writes a control event built here (`done`, `heartbeat`). Returns the event as the contract
   * reads it, or null when it was not written.
   */
  const write = (event: Record<string, unknown> & { type: string }): SentEvent | null => {
    const encoded = encode(event);
    if ("problem" in encoded) {
      console.error(
        `[SSE ${kind.name}] ${event.type} event not sent: ${encoded.problem}`,
        encoded.detail,
      );
      return null;
    }
    res.write(encoded.line);
    return encoded.checked;
  };

  const sendNumbered = (body: EventBody, replacedWith?: Record<string, unknown>): boolean => {
    const encoded = encode({ ...body, runId, seq });
    if ("problem" in encoded) {
      if (kind.replaced.has(body.type)) {
        // The client is waiting for this event: it is told the request failed instead.
        console.error(
          `[SSE ${kind.name}] ${body.type} event not sent: ${encoded.problem}; sending an error`,
          encoded.detail,
        );
        sendError("failed", INVALID_EVENT_MESSAGE, replacedWith);
      } else {
        // Progress the client can do without: the run goes on, and the event takes no seq.
        dropEvent(kind.name, body.type, encoded.problem, encoded.detail);
      }
      return false;
    }
    res.write(encoded.line);
    seq += 1;
    if (kind.outcomes.has(body.type)) outcome = body.type;
    sent(encoded.checked);
    return true;
  };

  const sendError = (code: ErrorCode, message: string, detail?: Record<string, unknown>) => {
    if (!writable() || outcome) return false;
    return sendNumbered({ ...detail, type: "error", code, error: message });
  };

  const heartbeat =
    heartbeatMs > 0
      ? setInterval(() => {
          if (writable()) write({ type: "heartbeat", runId });
        }, heartbeatMs)
      : undefined;
  // Listen on the response: the request's own "close" also fires once its body has been read.
  res.on("close", () => {
    clearInterval(heartbeat);
    if (!res.writableEnded) disconnect.abort();
  });

  const done = () => {
    if (writable()) {
      const written = write({
        type: "done",
        runId,
        seq: seq++,
        timestamp: new Date().toISOString(),
      });
      if (written) sent(written);
    }
    ended = true;
    clearInterval(heartbeat);
    if (!res.writableEnded && !res.destroyed) res.end();
  };

  return {
    runId,
    get outcome() {
      return outcome;
    },
    get closed() {
      return disconnect.signal.aborted;
    },
    signal: disconnect.signal,
    send(body, replacedWith) {
      if (!writable()) return false;
      if (body.type === "done") {
        done();
        return true;
      }
      if (body.type === "error") {
        const { code, error, ...detail } = body;
        return sendError(code as ErrorCode, String(error), detail);
      }
      if (body.type === "heartbeat") {
        // Heartbeats come from the stream's own timer and never take a seq.
        dropEvent(kind.name, body.type, "only the stream sends heartbeats");
        return false;
      }
      if (outcome) {
        console.log(`[SSE ${kind.name}] ${body.type} event after ${outcome}; not sent`);
        return false;
      }
      return sendNumbered(body, replacedWith);
    },
    error: sendError,
    done,
  };
}

/** Opens the analysis stream of run `runId` (the thread id; a fresh id when there is no run). */
export function openAnalysisStream(
  res: Response,
  runId: string = randomUUID(),
  options?: EventStreamOptions,
): EventStream {
  return openStream(ANALYSIS, res, runId, options);
}

/** Opens a factoid stream; `runId` is the analysis run the factoids are for, when known. */
export function openFactoidStream(
  res: Response,
  runId: string | null = null,
  options?: EventStreamOptions,
): EventStream {
  return openStream(FACTOIDS, res, runId, options);
}

/**
 * A whole stream that only refuses the request: one `error` with the code, then `done`. Used by
 * the middleware (rate limit, origin) for the stream routes, before any run exists. A resume
 * request names its run, so its refusal carries that run's id.
 */
export function refuseStream(
  res: Response,
  path: string,
  code: ErrorCode,
  message: string,
  runId?: string,
): void {
  const stream = path.startsWith("/api/factoids/")
    ? openFactoidStream(res, null, { heartbeatMs: 0 })
    : openAnalysisStream(res, runId ?? randomUUID(), { heartbeatMs: 0 });
  stream.error(code, message);
  stream.done();
}

// =============================================================================
// Node writer events
// =============================================================================

/** Writer events of the contract that the nodes may send (`status` is narrowed first). */
const NODE_EVENTS = new Set(["status", "evidence", "claim", "audio"]);

/**
 * The stream event for one payload a graph node wrote (LangGraph's custom stream mode), or
 * null for one that is not sent as it is. `complete` and `candidates` are sent by the route
 * (the result once, the candidates in the `interrupt`). A `status` keeps only the fields the
 * contract names. Nodes report progress only: any other payload (a stream's own events such as
 * `connected`, `heartbeat`, `error` or `done`, an outcome, a type the contract does not know)
 * is a bug in the node; it is logged, counted and dropped, and the run goes on.
 */
export function nodeEvent(payload: unknown): EventBody | null {
  const type =
    typeof payload === "object" && payload !== null
      ? (payload as { type?: unknown }).type
      : undefined;
  if (type === "complete" || type === "candidates") return null;
  if (type === "status") {
    const { message, code, node, timestamp } = payload as Record<string, unknown>;
    return { type, message, code, node, timestamp };
  }
  if (typeof type === "string" && NODE_EVENTS.has(type)) return payload as EventBody;
  dropEvent(ANALYSIS.name, String(type), "a node may not send this event");
  return null;
}
