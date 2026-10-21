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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retries `fn` on transient errors, with exponential backoff; any other error is thrown at
 * once. After maxAttempts the last error is thrown, for the caller to handle.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; initialInterval?: number; backoffFactor?: number } = {},
): Promise<T> {
  const { maxAttempts = 3, initialInterval = 1000, backoffFactor = 2 } = opts;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isTransient(error) || attempt >= maxAttempts) throw error;
      const delay = initialInterval * backoffFactor ** (attempt - 1);
      await sleep(delay + Math.random() * delay * 0.1); // guard-allow: random-values-api — retry backoff jitter
    }
  }
}
