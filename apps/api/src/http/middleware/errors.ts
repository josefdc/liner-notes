import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Errors the client can see: a code, a status and a short generic message. Details (stack,
 * paths, upstream messages) stay in the server log.
 */
export const HTTP_ERRORS = {
  invalid_input: { status: 400, message: "The request is not valid." },
  invalid_json: { status: 400, message: "The request body is not valid JSON." },
  bad_request: { status: 400, message: "The request could not be read." },
  not_found: { status: 404, message: "Not found." },
  payload_too_large: { status: 413, message: "The request body is too large." },
  unsupported_media_type: { status: 415, message: "The request body encoding is not supported." },
  rate_limited: { status: 429, message: "Too many requests. Please try again later." },
  failed: { status: 500, message: "The request could not be completed. Please try again." },
  internal_error: { status: 500, message: "Something went wrong. Please try again." },
  upstream_unavailable: {
    status: 502,
    message: "A music service is not responding right now. Please try again later.",
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
 * Wraps an async route so a rejection reaches the error handler. Express 4 does not await route
 * handlers: without this, a rejection is unhandled and the request never gets an answer.
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
  const where = `${req.method} ${req.path}`;

  if (type === "request.aborted") {
    console.warn(`[HTTP] ${where}: client aborted the request body`);
    return;
  }

  if (res.headersSent) {
    // Too late for a status: close the response so the client is not left waiting.
    console.error(`[HTTP] ${where}: error after the response started`, err);
    if (!res.writableEnded) res.end();
    return;
  }

  const bodyCode = typeof type === "string" ? BODY_ERRORS[type] : undefined;
  const clientError = typeof status === "number" && status >= 400 && status < 500;

  if (bodyCode || clientError) {
    const code = bodyCode ?? "bad_request";
    console.warn(`[HTTP] ${where}: ${code} (${err instanceof Error ? err.message : String(err)})`);
    sendError(res, code);
    return;
  }

  console.error(`[HTTP] ${where}: unhandled error`, err);
  sendError(res, "internal_error");
};
