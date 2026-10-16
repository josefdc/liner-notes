export class TransientError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "TransientError";
  }
}

export function isTransient(error: unknown): boolean {
  if (error instanceof TransientError) return true;
  const msg = error instanceof Error ? error.message : String(error);
  const code = (error as any)?.status ?? (error as any)?.statusCode;
  return (
    code === 429 ||
    code === 502 ||
    code === 503 ||
    code === 504 ||
    msg.includes("quota") ||
    msg.includes("Rate limit") ||
    msg.includes("ECONNREFUSED") ||
    msg.includes("ETIMEDOUT") ||
    msg.includes("fetch failed")
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry wrapper that preserves the caller's ability to catch and degrade.
 * Retries only on transient errors. Non-transient errors throw immediately.
 * After maxAttempts, the last transient error is thrown (caught by the node's fallback).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { maxAttempts?: number; initialInterval?: number; backoffFactor?: number } = {},
): Promise<T> {
  const { maxAttempts = 3, initialInterval = 1000, backoffFactor = 2 } = opts;
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (!isTransient(e) || attempt === maxAttempts - 1) throw lastError;
      const delay = initialInterval * backoffFactor ** attempt;
      await sleep(delay + Math.random() * delay * 0.1); // guard-allow: random-values-api — retry backoff jitter
    }
  }
  throw lastError!; // unreachable
}
