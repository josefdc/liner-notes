import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";
import { FACTOIDS_STREAM_PATH } from "../routes/factoidPaths.js";
import { refuseStream } from "../sse.js";
import { logger } from "../../logger.js";

const log = logger("HTTP");

/**
 * Errors the client can see: a code, a status and a short generic message. Details (stack,
 * paths, upstream messages) stay in the server log.
 */
export const HTTP_ERRORS = {
  invalid_input: { status: 400, message: "The request is not valid." },
  invalid_json: { status: 400, message: "The request body is not valid JSON." },
  bad_request: { status: 400, message: "The request could not be read." },
  // A run token that is missing, not this server's, used up or expired (middleware/
  // requireRunToken.ts); the client gets a new one and asks again.
  auth_expired: {
    status: 401,
    message: "This page needs to check the request again. Please try again.",
  },
  forbidden_origin: { status: 403, message: "Requests from this site are not allowed." },
  not_found: { status: 404, message: "Not found." },
  payload_too_large: { status: 413, message: "The request body is too large." },
  unsupported_media_type: { status: 415, message: "The request body encoding is not supported." },
  rate_limited: { status: 429, message: "Too many requests. Please try again later." },
  failed: { status: 500, message: "The request could not be completed. Please try again." },
  internal_error: { status: 500, message: "Something went wrong. Please try again." },
  budget_exhausted: {
    status: 503,
    message: "Live model calls are paused for now. Please try again later.",
  },
  upstream_unavailable: {
    status: 502,
    message: "A music service is not responding right now. Please try again later.",
  },
  live_disabled: {
    status: 503,
    message: "Live analysis is not available here. Only the recorded showcase tracks can be shown.",
  },
} as const;

export type HttpErrorCode = keyof typeof HTTP_ERRORS;

export function sendError(
  res: Response,
  code: HttpErrorCode,
  detail?: Record<string, unknown>,
): void {
  if (res.headersSent || res.destroyed) return;
  const { status, message } = HTTP_ERRORS[code];
  res.status(status).json({ success: false, code, error: message, ...detail });
}

/**
 * Marks a request as failed although its status is 200: an event stream that reports invalid
 * input inside the stream. The limit shared by all clients does not count failed requests.
 */
export function markFailed(res: Response): void {
  res.locals.requestFailed = true;
}

/** True when the request failed: an error status, or marked with markFailed. */
export function requestFailed(res: Response): boolean {
  return res.statusCode >= 400 || res.locals.requestFailed === true;
}

/** The event-stream routes, which always answer 200 and report errors inside the stream. */
const EVENT_STREAM_PATHS = new Set([
  "/api/analyze/stream",
  "/api/analyze/stream/resume",
  FACTOIDS_STREAM_PATH,
]);

/**
 * True for a request an EventSource makes, or one to an event-stream route: an EventSource
 * cannot read the status or body of a failed response, so such requests get their errors inside
 * a 200 stream. Routing ignores case and a trailing slash, and so does this check.
 */
export function isEventStreamRequest(req: Request): boolean {
  if (req.headers.accept?.includes("text/event-stream")) return true;
  return EVENT_STREAM_PATHS.has(routedPath(req).replace(/\/+$/, ""));
}

/**
 * The path Express routes the request by, in lower case, whichever form its target took
 * (`/api/x` or `http://host/api/x`): the mount path and the rest of it, never the raw target.
 */
function routedPath(req: Request): string {
  return `${req.baseUrl}${req.path}`.toLowerCase();
}

/**
 * HEAD on an event-stream route: the stream's headers and no body. Express would otherwise
 * answer HEAD with the GET handler, which starts a run or asks the model for a stream nobody
 * reads. Mounted before the GET route.
 */
export const eventStreamHead: RequestHandler = (_req, res) => {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("X-Accel-Buffering", "no");
  res.end();
};

const STREAM_ID = /^[A-Za-z0-9_-]{1,100}$/;

/** What a refusal adds to its stream `error` event: how long to wait, when it says. */
export interface RefusalDetail {
  retryAfterMs?: number;
}

/**
 * Answers with a 200 event stream that carries one typed `error` event, then `done` (see
 * ../sse.ts). A refused resume names its run (the thread id), so the refusal carries that id.
 */
export function sendStreamError(
  req: Request,
  res: Response,
  code: HttpErrorCode,
  detail?: RefusalDetail,
): void {
  if (res.headersSent || res.destroyed) return;
  const path = routedPath(req);
  const threadId = req.query?.threadId;
  const runId = typeof threadId === "string" && STREAM_ID.test(threadId) ? threadId : undefined;
  refuseStream(res, path, code, HTTP_ERRORS[code].message, runId, detail);
}

/**
 * Refuses a request: in the stream for event-stream requests, as a JSON error otherwise.
 * `detail` goes with the stream's `error` event; a JSON refusal says the same in its headers
 * (Retry-After).
 */
export function refuse(
  req: Request,
  res: Response,
  code: HttpErrorCode,
  detail?: RefusalDetail,
): void {
  if (isEventStreamRequest(req)) sendStreamError(req, res, code, detail);
  else sendError(res, code);
}

const CONTROL_OR_LINE_BREAK = /[\p{Cc}\u2028\u2029]/gu;
const MAX_LOGGED_LENGTH = 200;

/** Client-supplied text made safe for a log line: no line breaks or control characters, capped. */
export function logText(value: unknown): string {
  const text = String(value).replace(CONTROL_OR_LINE_BREAK, " ");
  return text.length > MAX_LOGGED_LENGTH ? `${text.slice(0, MAX_LOGGED_LENGTH)}…` : text;
}

/**
 * Wraps an async route so a rejection reaches the error handler. Express 5 forwards a rejected
 * promise itself too; the wrapper returns nothing, so each rejection is passed on exactly once.
 */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next);
  };
}

/** Answers unknown routes with a JSON 404 instead of Express's HTML page. */
export const notFound: RequestHandler = (_req, res) => sendError(res, "not_found");

/**
 * Routes whose body holds a credential (POST /api/runs: a Turnstile token): a body-parser error
 * there is logged by its code only, since its message can quote the body.
 */
const CREDENTIAL_BODY_PATHS = new Set(["/api/runs"]);

// body-parser marks its errors with a `type`; the status alone does not tell them apart.
const BODY_ERRORS: Record<string, HttpErrorCode> = {
  "entity.parse.failed": "invalid_json",
  "entity.too.large": "payload_too_large",
  "encoding.unsupported": "unsupported_media_type",
  "charset.unsupported": "unsupported_media_type",
};

/**
 * The last middleware: every error becomes a JSON `{ success: false, code, error }` with a
 * generic message. Client errors are logged in one line; anything else with its stack.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const { type, status } = (err ?? {}) as { type?: unknown; status?: unknown };
  const where = `${req.method} ${logText(req.path)}`;

  if (type === "request.aborted") {
    log.warn(`${where}: client aborted the request body`);
    return;
  }

  if (res.headersSent) {
    // Too late for a status: close the response so the client is not left waiting.
    log.error(`${where}: error after the response started`, { err });
    if (!res.writableEnded) res.end();
    return;
  }

  const bodyCode = typeof type === "string" ? BODY_ERRORS[type] : undefined;
  const clientError = typeof status === "number" && status >= 400 && status < 500;

  if (bodyCode || clientError) {
    const code = bodyCode ?? "bad_request";
    const path = req.path.toLowerCase().replace(/\/+$/, "");
    if (CREDENTIAL_BODY_PATHS.has(path)) log.warn(`${where}: ${code}`);
    else log.warn(`${where}: ${code} (${logText(err instanceof Error ? err.message : err)})`);
    sendError(res, code);
    return;
  }

  log.error(`${where}: unhandled error`, { err });
  sendError(res, "internal_error");
};
