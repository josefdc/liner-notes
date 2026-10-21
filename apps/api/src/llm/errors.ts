/**
 * Typed errors of the provider layer. Every failure of `llm.invoke` is an LlmError whose kind
 * says what happened; messages name variables and paths, never a key, an endpoint or a prompt.
 * The original error is never kept as `cause` (its message or properties may hold the endpoint
 * or a key); `cause` is at most a scrubbed summary.
 */

export type LlmErrorKind =
  /** The provider is not set up (missing key or endpoint, or an unimplemented provider). */
  | "not_configured"
  /** The call's arguments are invalid (tier, purpose, run id, messages, max output tokens). */
  | "invalid_input"
  /** The spend log is unset (with a live provider), missing, unreadable, unwritable or malformed. */
  | "spend_log_unavailable"
  /** The call would take spending past a cap; nothing was sent. */
  | "budget_exceeded"
  /** The run has used MAX_LLM_CALLS_PER_RUN calls. */
  | "call_cap"
  /** The schema (or its name) does not pass the strict structured-output rules. */
  | "schema_not_strict"
  /** The input is larger than the priced short-context window. */
  | "input_too_large"
  | "timeout"
  /** The caller's signal aborted the call. */
  | "aborted"
  /** 429 from the provider. */
  | "rate_limited"
  /** Connection, DNS or TLS failure. */
  | "network"
  /** 400 because the input is longer than the model's context window. */
  | "context_overflow"
  /** 400 because the content filter rejected the prompt. */
  | "content_filtered"
  /** Any other provider error; `status` holds the HTTP status when there was one. */
  | "provider"
  /** The provider answered `status: "failed"`. */
  | "response_failed"
  /** The answer stopped early (`incomplete_details.reason`: max_output_tokens, content_filter). */
  | "incomplete"
  /** The model refused to answer. */
  | "refused"
  /** A 2xx answer that is not a Responses API object (e.g. a proxy's HTML page). */
  | "invalid_response"
  /** A completed answer that is not valid JSON or does not match the schema. */
  | "invalid_output"
  /** Replay mode and no cassette entry for this call. */
  | "cassette_miss"
  /** A cassette could not be read, parsed or written. */
  | "cassette_io";

export interface LlmErrorDetails {
  status?: number;
  retryAfterMs?: number;
  /** For `incomplete`: the provider's reason. */
  incompleteReason?: string;
  /** Tokens the failed answer used, when the provider reported them. */
  usage?: { inputTokens: number; outputTokens: number; reasoningTokens: number | null };
  /** Worth a second attempt: the same request may succeed a moment later. */
  transient?: boolean;
  /** A scrubbed summary of the underlying error. */
  cause?: { name: string; code?: string; message: string };
}

export class LlmError extends Error {
  override readonly name = "LlmError";
  readonly status?: number;
  readonly retryAfterMs?: number;
  readonly incompleteReason?: string;
  readonly usage?: LlmErrorDetails["usage"];
  readonly transient: boolean;

  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    details: LlmErrorDetails = {},
  ) {
    super(message, details.cause === undefined ? {} : { cause: details.cause });
    if (details.status !== undefined) this.status = details.status;
    if (details.retryAfterMs !== undefined) this.retryAfterMs = details.retryAfterMs;
    if (details.incompleteReason !== undefined) this.incompleteReason = details.incompleteReason;
    if (details.usage !== undefined) this.usage = details.usage;
    this.transient = details.transient ?? false;
  }
}

export function isLlmError(error: unknown, kind?: LlmErrorKind): error is LlmError {
  return error instanceof LlmError && (kind === undefined || error.kind === kind);
}

export function isTransient(error: LlmError): boolean {
  return error.transient;
}
