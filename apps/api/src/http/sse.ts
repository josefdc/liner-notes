/**
 * The server side of the event streams: every message the analysis and factoid streams send is
 * built here, as an event of the contract's union (`AnalyzeStreamEvent`, `FactoidStreamEvent`).
 *
 * A stream stamps each event with its run's id (`runId`) and its position in the stream (`seq`,
 * from 0, one per event written; heartbeats carry none), checks it against the contract and
 * writes it with `encodeSseEvent`. An event that fails the check is a bug: it is logged and a
 * typed `error` (code `failed`) is sent in its place, so nothing unchecked reaches a client.
 * Once the client has gone nothing more is written, and `done` is always the last event.
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
}

const ANALYSIS: StreamKind = {
  name: "analysis",
  schema: AnalyzeStreamEvent,
  outcomes: new Set(["complete", "interrupt", "error"]),
};
// On the factoid stream an error is one factoid's: the others still follow.
const FACTOIDS: StreamKind = { name: "factoids", schema: FactoidStreamEvent, outcomes: new Set() };

export interface EventStream {
  readonly runId: string | null;
  /** True once the client has gone (the response closed before it was ended). */
  readonly closed: boolean;
  /** Aborts when the client goes away. */
  readonly signal: AbortSignal;
  /** Sends one event; false when it was not written (client gone, after the outcome, invalid). */
  send(event: EventBody): boolean;
  /** Sends an `error` event with a code and a short message for the user. */
  error(code: ErrorCode, message: string, detail?: Record<string, unknown>): boolean;
  /** Sends `done` (once) and ends the response. */
  done(): void;
}

export interface EventStreamOptions {
  /** Interval between heartbeat events; 0 sends none. */
  heartbeatMs?: number;
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
  { heartbeatMs = HEARTBEAT_INTERVAL_MS }: EventStreamOptions = {},
): EventStream {
  writeHead(res);

  let seq = 0;
  let outcome: string | null = null;
  let ended = false;
  const disconnect = new AbortController();
  const writable = () =>
    !ended && !disconnect.signal.aborted && !res.writableEnded && !res.destroyed;

  /** Checks an event against the contract and writes it; false when it was not written. */
  const write = (event: Record<string, unknown> & { type: string }): boolean => {
    const checked = kind.schema.safeParse(event);
    let line: string | null = null;
    if (checked.success) {
      try {
        line = encodeSseEvent(event as AnalyzeStreamEvent);
      } catch (err) {
        console.error(
          `[SSE ${kind.name}] ${event.type} event could not be encoded; not sent:`,
          err,
        );
        return false;
      }
    } else {
      console.error(
        `[SSE ${kind.name}] ${event.type} event fails the contract; not sent:`,
        checked.error.issues.map(
          (issue) => `${issue.path.join(".") || "(event)"}: ${issue.message}`,
        ),
      );
      return false;
    }
    res.write(line);
    return true;
  };

  const sendNumbered = (body: EventBody): boolean => {
    const event = { ...body, runId, seq };
    if (!write(event)) {
      // A bug, not the run's outcome: the client is told the request failed.
      if (body.type !== "error") sendError("failed", INVALID_EVENT_MESSAGE);
      return false;
    }
    seq += 1;
    if (kind.outcomes.has(body.type)) outcome = body.type;
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
    if (writable()) write({ type: "done", runId, seq: seq++, timestamp: new Date().toISOString() });
    ended = true;
    clearInterval(heartbeat);
    if (!res.writableEnded && !res.destroyed) res.end();
  };

  return {
    runId,
    get closed() {
      return disconnect.signal.aborted;
    },
    signal: disconnect.signal,
    send(body) {
      if (!writable()) return false;
      if (body.type === "done") {
        done();
        return true;
      }
      if (body.type === "error") {
        const { code, error, ...detail } = body;
        return sendError(code as ErrorCode, String(error), detail);
      }
      if (outcome) {
        console.log(`[SSE ${kind.name}] ${body.type} event after ${outcome}; not sent`);
        return false;
      }
      return sendNumbered(body);
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

/** Writer events of the contract that the nodes may send as they are. */
const PASSED_ON = new Set(["status", "evidence", "claim", "audio"]);

/**
 * The stream event for one payload a graph node wrote (LangGraph's custom stream mode), or
 * null for one the route sends otherwise: `complete` (sent once, by the route) and
 * `candidates` (sent once, in the `interrupt`). A `status` keeps only the fields the contract
 * names. Any other payload is passed on as it is and fails the contract check, which reports
 * the bug.
 */
export function nodeEvent(payload: unknown): EventBody | null {
  if (typeof payload !== "object" || payload === null) {
    return { type: "invalid", payload };
  }
  const { type } = payload as { type?: unknown };
  if (type === "complete" || type === "candidates") return null;
  if (type === "status") {
    const { message, code, node, timestamp } = payload as Record<string, unknown>;
    return { type, message, code, node, timestamp };
  }
  if (typeof type === "string" && PASSED_ON.has(type)) return payload as EventBody;
  return { ...(payload as Record<string, unknown>), type: String(type) };
}
