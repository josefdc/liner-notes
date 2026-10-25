/**
 * Typed errors of the agent's nodes, and the retry rules that go with them.
 *
 * A node either handles a failure (records it in the state as a typed entry: a source error,
 * a model call's error kind) or lets it through, and what it lets through fails the run: a
 * cancelled run, or a bug. No node has a graph retry policy: model calls are retried inside the
 * provider layer, a search at most once by its node (`withRetry`, transient errors only), so
 * retries never stack. A cancelled run is never retried.
 */

import { isLlmError } from "../llm/errors.js";
import { isSourceError } from "../sources/http.js";

/** A failure that may succeed when tried again a moment later (429, 5xx, a timeout). */
export class TransientError extends Error {
  override readonly name = "TransientError";
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
  }
}

const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
/** Error codes of a connection that failed or timed out. */
const NETWORK_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]);

/** A property of an error object, without assuming its shape. */
function field(error: unknown, key: string): unknown {
  return typeof error === "object" && error !== null ? Reflect.get(error, key) : undefined;
}

/** The HTTP status an error carries in `status` or `statusCode`, if any. */
function statusOf(error: unknown): number | undefined {
  for (const key of ["status", "statusCode"]) {
    const value = field(error, key);
    if (typeof value === "number") return value;
  }
  return undefined;
}

/** The first system error code in an error's cause chain (`ECONNREFUSED`, …). */
function codeOf(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; current !== undefined && depth < 5; depth++) {
    const code = field(current, "code");
    if (typeof code === "string") return code;
    current = field(current, "cause");
  }
  return undefined;
}

/** True for the error a cancelled call or run rejects with. */
export function isAbortError(error: unknown): boolean {
  if (isLlmError(error, "aborted") || isSourceError(error, "aborted")) return true;
  return error instanceof Error && error.name === "AbortError";
}

/** True for an error worth one more attempt. Decided by type, status and code, never by text. */
export function isTransient(error: unknown): boolean {
  if (isAbortError(error)) return false;
  if (error instanceof TransientError) return true;
  if (isLlmError(error)) return error.transient;
  if (isSourceError(error)) {
    if (error.kind === "http") return TRANSIENT_STATUSES.has(error.status ?? 0);
    return error.kind === "rate_limited" || error.kind === "timeout" || error.kind === "network";
  }
  const status = statusOf(error);
  if (status !== undefined) return TRANSIENT_STATUSES.has(status);
  const code = codeOf(error);
  return code !== undefined && NETWORK_CODES.has(code);
}

/** Waits `ms`, or rejects with the signal's reason as soon as `signal` aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * How long to wait before trying a failed call again, when the source said: a rate limit's
 * `retryAfterMs` (Retry-After) up to `maxWaitMs`. A longer wait than that is not waited out:
 * null, give up now. undefined when the source said nothing (the caller's backoff applies).
 */
export function retryAfterWait(error: unknown, maxWaitMs: number): number | null | undefined {
  if (!isSourceError(error, "rate_limited") || error.retryAfterMs === undefined) return undefined;
  return error.retryAfterMs <= maxWaitMs ? Math.max(0, error.retryAfterMs) : null;
}

/**
 * Retries `fn` on transient errors, with exponential backoff; any other error is thrown at
 * once. After maxAttempts the last error is thrown, for the caller to handle. A cancelled run
 * (`signal` aborted) starts no attempt and cuts the wait short.
 *
 * `retryDelay` may choose the wait for an error instead of the backoff (a source's
 * Retry-After): a number of milliseconds, null to give up at once, or undefined for the backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    initialInterval?: number;
    backoffFactor?: number;
    signal?: AbortSignal;
    retryDelay?: (error: unknown) => number | null | undefined;
  } = {},
): Promise<T> {
  const { maxAttempts = 3, initialInterval = 1000, backoffFactor = 2, signal } = opts;
  for (let attempt = 1; ; attempt++) {
    signal?.throwIfAborted();
    try {
      return await fn();
    } catch (error) {
      if (signal?.aborted || !isTransient(error) || attempt >= maxAttempts) throw error;
      const chosen = opts.retryDelay?.(error);
      if (chosen === null) throw error;
      if (chosen !== undefined) {
        await sleep(chosen, signal);
        continue;
      }
      const delay = initialInterval * backoffFactor ** (attempt - 1);
      await sleep(delay + Math.random() * delay * 0.1, signal); // guard-allow: random-values-api — retry backoff jitter
    }
  }
}
