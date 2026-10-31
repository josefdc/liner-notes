/**
 * `llm.invoke`: the one way the API calls a language model.
 *
 *   const { output, usage } = await llm.invoke("composer", "main", messages, ComposerOutput, {
 *     purpose: "dev", runId, maxOutputTokens: 4000, signal,
 *   });
 *
 * Each call:
 *   1. validates its arguments, and checks the schema's JSON Schema against the strict
 *      structured-output rules (assertAzureStrict). That exact document is what is sent;
 *   2. in replay mode answers from a cassette (cassette.ts) and stops there: no network, no
 *      spending; a missing cassette is an error;
 *   3. otherwise, per attempt (at most MAX_ATTEMPTS), in a slot of LLM_CONCURRENCY:
 *      - takes one of the run's MAX_LLM_CALLS_PER_RUN calls;
 *      - reserves the worst-case cost in the spend log (budget.ts), which refuses the call
 *        when the log is unset, unusable or a cap would be passed;
 *      - calls the Responses API (factory.ts `createResponsesClient`) under a timeout;
 *      - classifies the answer: completed, incomplete, refused, failed, malformed;
 *      - settles the cost in the spend log (table below) and writes an `llm_usage` row;
 *      - retries only transient failures, after a bounded wait;
 *   4. in record mode writes the answer to a cassette, with when and from which commit it was
 *      recorded; a replayed answer reports both (`recording`), or null where the cassette does
 *      not say.
 *
 * The caller's signal is honoured while waiting for a slot, for the spend log, for the answer
 * and between attempts. An attempt stopped before its request was sent releases its reservation
 * (settled at 0) and gives its call back to the run.
 *
 * What an attempt is settled at (never less than what may have been billed):
 *   answer with usage (input and output tokens both reported)   that usage, whatever the status
 *   answer without usage, or with part of it                     worst case, estimated
 *   HTTP 400 with code content_filter                            input bound only, estimated
 *   HTTP 400 (incl. context overflow), 401, 403, 404, 429         0: rejected before processing
 *   any other HTTP status (408, 409, 5xx, …)                     worst case, estimated
 *   no connection made and no answer (DNS failure, connection
 *   refused, network or host unreachable while connecting,
 *   connect timeout, a port fetch blocks)                         0
 *   timeout, reset connection, abort after sending (or while
 *   connecting: the two cannot be told apart), a body that is
 *   not a Responses API object                                    worst case, estimated
 *   stopped before the request was sent                           0
 * Azure's billing of a filtered prompt is not documented: its input is counted, its output not.
 * Usage that cannot be right (text answered with 0 output tokens, more reasoning than output
 * tokens) is treated as not reported. When the answer names a model outside the priced family
 * of the deployment (`response.model`), the call is charged at the fallback prices × 1.5, with
 * a warning.
 *
 * Retried once: 408, 409, 429 (not insufficient_quota, and only when Retry-After is within
 * MAX_RETRY_WAIT_MS), 5xx, timeouts, connection failures, `status: "failed"` with a server
 * error. Never retried: an incomplete answer (the same output budget would stop the same way),
 * a refusal, an invalid answer, any other error.
 */

import { randomUUID } from "node:crypto";
import { assertAzureStrict, LLM_SCHEMAS, toJsonSchema } from "@liner-notes/contract";
import type { BaseMessage } from "@langchain/core/messages";
import type OpenAI from "openai";
import type { z } from "zod";
import { runningCommit } from "../config/checkoutCommit.js";
import {
  LLM_PURPOSES,
  type LlmPurpose,
  type LlmSettings,
  type LlmTier,
  readLlmSettings,
} from "../config/settings.js";
import { type Reservation, SpendGuard } from "./budget.js";
import {
  type CassetteRecording,
  type CassetteUsage,
  cassetteDirFor,
  cassetteRecording,
  cassetteKey,
  knownSecrets,
  type LlmMessage,
  normaliseMessages,
  readCassette,
  scrubSecretsSteps,
  writeCassette,
} from "./cassette.js";
import { isLlmError, isTransient, LlmError, type LlmErrorDetails } from "./errors.js";
import {
  assertProviderConfigured,
  createResponsesClient,
  endpointHost,
  isTier,
  REASONING_EFFORT,
  type ReasoningEffort,
} from "./factory.js";
import {
  type AppliedPrice,
  costUsd,
  FALLBACK_PRICE,
  priceFor,
  SHORT_CONTEXT_MAX_INPUT_TOKENS,
  UNSOURCED_PRICE_MULTIPLIER,
} from "./prices.js";
import { type LlmUsageRow, recordToOpenDatabase } from "./usage.js";
import { hideScrubbed, knownValueSpans, logCut, logger } from "../logger.js";

const log = logger("llm");

export type { LlmMessage } from "./cassette.js";

/** Attempts per call, the first included. */
export const MAX_ATTEMPTS = 2;
/** Longest wait before the second attempt; a longer Retry-After is not retried. */
export const MAX_RETRY_WAIT_MS = 10_000;
const DEFAULT_RETRY_WAIT_MS = 1000;
/** Smallest max_output_tokens the Responses API accepts. */
export const MIN_OUTPUT_TOKENS = 16;
/**
 * Suggested smallest max_output_tokens per reasoning effort. Reasoning tokens count against
 * max_output_tokens: a call sized for its JSON alone can spend the whole budget reasoning and
 * end `incomplete` (max_output_tokens). Size a call as its largest JSON plus this much; an
 * `incomplete` error reports the reasoning tokens used, to size it from real calls.
 */
export const RECOMMENDED_MIN_OUTPUT_TOKENS: Readonly<Record<ReasoningEffort, number>> = {
  low: 1000,
  medium: 4000,
};
/** The name rule of the Responses API for `text.format.name`. */
const SCHEMA_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export type LlmInput = string | ReadonlyArray<LlmMessage | BaseMessage>;

export interface InvokeOptions {
  purpose: LlmPurpose;
  runId: string;
  /**
   * max_output_tokens, reasoning included; also the worst case the budget reserves. See
   * RECOMMENDED_MIN_OUTPUT_TOKENS.
   */
  maxOutputTokens: number;
  signal?: AbortSignal;
  /** The schema's name in cassettes and on the wire; defaults to its name in LLM_SCHEMAS. */
  schemaName?: string;
}

export interface InvokeUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  usdEst: number;
  multiplier: number;
  latencyMs: number;
  attempts: number;
}

export interface InvokeResult<T> {
  output: T;
  callId: string;
  mode: "live" | "record" | "replay";
  tier: LlmTier;
  deployment: string;
  usage: InvokeUsage;
  /** For an answer replayed from a cassette: when and from which commit it was recorded. */
  recording?: CassetteRecording;
}

export interface LlmDependencies {
  settings: LlmSettings;
  /** Replaces the HTTP client's fetch (tests). */
  fetch?: typeof fetch;
  /** Receives one row per attempt (default: the open app database, if any). */
  recordUsage?: (row: LlmUsageRow) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  /** Where credential values are looked up for scrubbing (default process.env). */
  env?: NodeJS.ProcessEnv;
  /**
   * The commit recorded with each cassette (LLM_CASSETTE=record); default: the process's
   * (runningCommit). Null when it cannot be read.
   */
  commit?: () => string | null;
}

// =============================================================================
// Helpers
// =============================================================================

const abortedError = (callSite: string) =>
  new LlmError("aborted", `${callSite}: aborted by the caller`);

function throwIfAborted(signal: AbortSignal | undefined, callSite: string): void {
  if (signal?.aborted) throw abortedError(callSite);
}

/** Rejects with LlmError aborted when `signal` aborts first. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined, callSite: string) {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortedError(callSite));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** At most `limit` tasks at once in this process; a waiter leaves the queue when aborted. */
class Semaphore {
  private active = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>, signal: AbortSignal | undefined, callSite: string) {
    throwIfAborted(signal, callSite);
    if (this.active >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          const index = this.waiting.indexOf(wake);
          if (index >= 0) this.waiting.splice(index, 1);
          reject(abortedError(callSite));
        };
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        this.waiting.push(wake);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    } else {
      this.active += 1;
    }
    try {
      return await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active -= 1;
    }
  }
}

const strictSchemas = new WeakMap<object, Record<string, unknown>>();

/** The JSON Schema sent for `schema`, after the strict check; throws schema_not_strict. */
function strictJsonSchema(schema: z.ZodType, name: string): Record<string, unknown> {
  const cached = strictSchemas.get(schema);
  if (cached) return cached;
  let json: Record<string, unknown>;
  try {
    json = toJsonSchema(schema);
    assertAzureStrict(json);
  } catch (error) {
    throw new LlmError(
      "schema_not_strict",
      `${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  strictSchemas.set(schema, json);
  return json;
}

function schemaNameOf(schema: z.ZodType, explicit?: string): string {
  const found = Object.entries(LLM_SCHEMAS).find(([, known]) => known === schema)?.[0];
  const name = explicit ?? found;
  if (!name) {
    throw new LlmError(
      "schema_not_strict",
      "schemaName is required for a schema that is not in LLM_SCHEMAS",
    );
  }
  if (!SCHEMA_NAME.test(name)) {
    throw new LlmError(
      "schema_not_strict",
      "schemaName must match ^[A-Za-z0-9_-]{1,64}$ (the Responses API's rule)",
    );
  }
  return name;
}

const LANGCHAIN_ROLES: Record<string, LlmMessage["role"]> = {
  system: "system",
  human: "user",
  ai: "assistant",
};

/** Plain messages from a string, our messages or LangChain messages; throws invalid_input. */
function toMessages(input: LlmInput, callSite: string): LlmMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  const invalid = (why: string) => new LlmError("invalid_input", `${callSite}: ${why}`);
  if (!Array.isArray(input) || input.length === 0) throw invalid("no messages to send");
  return input.map((message, index) => {
    const m = message as unknown as {
      role?: unknown;
      content?: unknown;
      getType?: () => string;
      _getType?: () => string;
    };
    let role: LlmMessage["role"] | undefined;
    if (m.role === "system" || m.role === "user" || m.role === "assistant") role = m.role;
    else {
      const type = m.getType?.() ?? m._getType?.();
      role = type ? LANGCHAIN_ROLES[type] : undefined;
    }
    if (!role) throw invalid(`message ${index} is not a system, user or assistant message`);
    let content: string | undefined;
    if (typeof m.content === "string") content = m.content;
    else if (Array.isArray(m.content)) {
      const parts = m.content as Array<{ type?: unknown; text?: unknown }>;
      if (parts.every((p) => p?.type === "text" && typeof p.text === "string")) {
        content = parts.map((p) => p.text as string).join("");
      }
    }
    if (content === undefined) throw invalid(`message ${index} has content other than text`);
    return { role, content };
  });
}

/**
 * An upper bound on the input tokens, for the reservation: byte-level BPE tokenizers never
 * produce more tokens than there are bytes, so one token per UTF-8 byte of message text and
 * schema, plus per-message and per-request overhead, is not expected to be exceeded. English
 * averages about four bytes per token, so this over-reserves input; the settled cost uses the
 * provider's count, and a settle above the reservation is reported.
 */
export function estimateInputTokens(
  messages: readonly LlmMessage[],
  jsonSchema: Record<string, unknown>,
): number {
  const bytes =
    messages.reduce((sum, m) => sum + Buffer.byteLength(m.content, "utf8"), 0) +
    Buffer.byteLength(JSON.stringify(jsonSchema), "utf8");
  return bytes + 16 * messages.length + 256;
}

type HeaderSource = { get?: (name: string) => string | null } | Record<string, string> | undefined;

function header(headers: HeaderSource, name: string): string | undefined {
  if (!headers) return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get: (n: string) => string | null }).get(name) ?? undefined;
  }
  return (headers as Record<string, string>)[name];
}

/** retry-after-ms, then Retry-After in seconds or as an HTTP date. */
export function retryAfterMs(headers: HeaderSource, now = Date.now()): number | undefined {
  const ms = Number(header(headers, "retry-after-ms"));
  if (header(headers, "retry-after-ms") && Number.isFinite(ms) && ms >= 0) return ms;
  const value = header(headers, "retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "EPIPE",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);
/**
 * Codes that mean no connection was made, so the request cannot have reached the provider: the
 * name did not resolve, the connection was refused, or the connection was not made within
 * undici's connect timeout (which covers the TLS handshake; the request is written only once it
 * is made).
 */
const UNDELIVERED_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "UND_ERR_CONNECT_TIMEOUT",
]);
/**
 * Codes that mean no connection was made only when connect() raised them (the network or host
 * was unreachable). An established socket reports them too (`read EHOSTUNREACH`), after the
 * request may have been written.
 */
const CONNECT_ONLY_CODES = new Set(["ENETUNREACH", "EHOSTUNREACH"]);
/** HTTP statuses the provider answers before processing a request: not billed. */
const UNBILLED_STATUSES = new Set([400, 401, 403, 404, 429]);

interface CodedError {
  code: string;
  syscall?: unknown;
  /** The attempts of an AggregateError (net trying each address of a name). */
  errors?: unknown;
}

/** Whether connect() raised `error`: itself, or every attempt of an AggregateError. */
function raisedByConnect(error: CodedError): boolean {
  if (Array.isArray(error.errors) && error.errors.length > 0) {
    return error.errors.every((e) => (e as { syscall?: unknown } | null)?.syscall === "connect");
  }
  return error.syscall === "connect";
}

/**
 * Whether an attempt's error shows that no connection was made: the first code in its cause
 * chain is one of UNDELIVERED_CODES, or one of CONNECT_ONLY_CODES raised by connect(); or fetch
 * refused the endpoint's port before connecting ("bad port", for the ports browsers block).
 * The caller also requires that no HTTP answer came back.
 */
function neverConnected(error: unknown): boolean {
  const coded = codedError(error);
  if (coded !== undefined) {
    if (UNDELIVERED_CODES.has(coded.code)) return true;
    return CONNECT_ONLY_CODES.has(coded.code) && raisedByConnect(coded);
  }
  let current = error as { message?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; current && depth < 5; depth++) {
    if (current.message === "bad port") return true;
    current = current.cause as typeof current;
  }
  return false;
}

/** The first error in an error's cause chain that carries an error code. */
function codedError(error: unknown): CodedError | undefined {
  let current = error as { code?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; current && depth < 5; depth++) {
    if (typeof current.code === "string" && /^[A-Z_]+$/.test(current.code)) {
      return current as CodedError;
    }
    current = current.cause as typeof current;
  }
  return undefined;
}

/** The first error code in an error's cause chain. */
function errorCode(error: unknown): string | undefined {
  return codedError(error)?.code;
}

function names(error: unknown): Set<string> {
  const e = error as { name?: unknown; constructor?: { name?: string } } | undefined;
  // The OpenAI client's error classes keep the name "Error"; their constructor names differ.
  return new Set([typeof e?.name === "string" ? e.name : "", e?.constructor?.name ?? ""]);
}

/** Names that say nothing about the error's class. */
const GENERIC_NAMES = new Set(["", "Error"]);

export interface ErrorState {
  timedOut: boolean;
  aborted: boolean;
  callSite: string;
  /** Values removed from every message (keys, the endpoint's host). */
  secrets?: readonly string[];
}

/**
 * How much of a model error's message classifyError reads: it keeps 500 characters, and the
 * logger reads 4,096 past a cut.
 */
const MODEL_ERROR_READ = 8 * 1024;

/**
 * The start of a model error's message that classifyError redacts: all of it, or, past
 * MODEL_ERROR_READ characters, up to a cut there that never splits what the logger's rules, the
 * values or scrubSecrets' steps hide in the text around it (logCut, which also looks a
 * configured value's reach past the cut); and "[redacted]" when the cut moved back to the start
 * of such a span, which the text left out then starts. A client's error can hold a whole error
 * page; the message keeps far less of it.
 */
function readOfError(
  text: string,
  secrets: readonly string[],
  steps: ReturnType<typeof scrubSecretsSteps>,
): [string, string] {
  if (text.length <= MODEL_ERROR_READ) return [text, ""];
  const window = text.slice(0, MODEL_ERROR_READ + 4096);
  const hidden = [...knownValueSpans(window, secrets), ...steps.flatMap((step) => step(window))];
  const cut = logCut(text, MODEL_ERROR_READ, hidden);
  return [text.slice(0, cut), cut < MODEL_ERROR_READ ? "[redacted]" : ""];
}

/**
 * The LlmError for an attempt that threw. `timedOut` and `aborted` say which of the attempt's
 * signals fired, since the client reports both as an abort.
 */
export function classifyError(error: unknown, state: ErrorState): LlmError {
  if (error instanceof LlmError) return error;
  const secrets = state.secrets ?? knownSecrets();
  const e = (error ?? {}) as {
    status?: unknown;
    message?: unknown;
    code?: unknown;
    type?: unknown;
    headers?: HeaderSource;
    error?: { code?: unknown; type?: unknown };
  };
  // What the logger's rules hide, the values, and what scrubSecrets' steps and then the logger
  // would hide in turn, are all found in the message as it came and hidden before it is cut
  // below: a value written escaped or folded, or a credential after a scheme, cut, is a part that
  // no rule reads when the logger gets it; one set of rules run on the other's output can lose a
  // scheme word or a pair's name that the other took, and leave the credential after it; and
  // one read alone can miss what the other's output lets it read.
  const steps = scrubSecretsSteps(secrets);
  const [text, hidden] = readOfError(
    typeof e.message === "string" ? e.message : String(error),
    secrets,
    steps,
  );
  const detail = `${hideScrubbed(text, secrets, steps)}${hidden}`;
  const message = `${state.callSite}: ${detail}`.slice(0, 500);
  const code = errorCode(error);
  const cause: LlmErrorDetails["cause"] = {
    name: [...names(error)].find((n) => !GENERIC_NAMES.has(n)) ?? "Error",
    ...(code ? { code } : {}),
    message: detail.slice(0, 300),
  };
  if (state.aborted) return abortedError(state.callSite);
  if (state.timedOut) {
    return new LlmError("timeout", `${state.callSite}: timed out`, { transient: true, cause });
  }
  const status = typeof e.status === "number" ? e.status : undefined;
  if (status !== undefined) {
    const providerCode = [e.code, e.type, e.error?.code, e.error?.type].find(
      (v): v is string => typeof v === "string",
    );
    if (status === 429) {
      const quota = providerCode === "insufficient_quota";
      return new LlmError("rate_limited", message, {
        status,
        retryAfterMs: retryAfterMs(e.headers),
        transient: !quota,
        cause,
      });
    }
    if (
      status === 400 &&
      (providerCode === "context_length_exceeded" || names(error).has("ContextOverflowError"))
    ) {
      return new LlmError("context_overflow", message, { status, cause });
    }
    if (status === 400 && providerCode === "content_filter") {
      return new LlmError("content_filtered", message, { status, cause });
    }
    if (status === 408) return new LlmError("timeout", message, { status, transient: true, cause });
    return new LlmError("provider", message, {
      status,
      transient: status === 409 || status >= 500,
      retryAfterMs: retryAfterMs(e.headers),
      cause,
    });
  }
  const kinds = names(error);
  if (kinds.has("TimeoutError") || kinds.has("APIConnectionTimeoutError")) {
    return new LlmError("timeout", message, { transient: true, cause });
  }
  if (kinds.has("APIUserAbortError") || kinds.has("AbortError")) {
    return abortedError(state.callSite);
  }
  if (
    kinds.has("APIConnectionError") ||
    (code !== undefined && NETWORK_CODES.has(code)) ||
    (error instanceof TypeError && /fetch failed/i.test(String(e.message)))
  ) {
    return new LlmError("network", message, { transient: true, cause });
  }
  if (error instanceof SyntaxError) {
    return new LlmError("invalid_response", `${state.callSite}: the answer is not valid JSON`, {
      cause,
    });
  }
  return new LlmError("provider", message, { cause });
}

interface ReportedUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number | null;
}

const UNKNOWN_USAGE: CassetteUsage = {
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
};

/** Usage only when the provider reported both counts; null means unknown. */
function reportedUsage(response: unknown): ReportedUsage | null {
  const usage = (response as { usage?: unknown } | null)?.usage as
    | {
        input_tokens?: unknown;
        output_tokens?: unknown;
        output_tokens_details?: { reasoning_tokens?: unknown };
      }
    | undefined;
  const count = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0;
  if (!usage || !count(usage.input_tokens) || !count(usage.output_tokens)) return null;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens: usage.input_tokens as number,
    outputTokens: usage.output_tokens as number,
    reasoningTokens: count(reasoning) ? (reasoning as number) : null,
  };
}

/** The answer's output text and refusal, from its message items. */
function answerText(response: unknown): { text: string; refusal: string | null } {
  let text = "";
  let refusal: string | null = null;
  const output = (response as { output?: unknown } | null)?.output;
  for (const item of Array.isArray(output) ? output : []) {
    const message = item as { type?: unknown; content?: unknown };
    if (message?.type !== "message" || !Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{
      type?: unknown;
      text?: unknown;
      refusal?: unknown;
    }>) {
      if (part?.type === "output_text" && typeof part.text === "string") text += part.text;
      if (part?.type === "refusal") refusal = typeof part.refusal === "string" ? part.refusal : "";
    }
  }
  return { text, refusal };
}

/**
 * Reported usage that cannot be right is treated as not reported (the worst case is kept):
 * more reasoning than output tokens, or answer text with 0 output tokens (a gateway that fills
 * missing counts with zeros).
 */
function consistentUsage(
  usage: ReportedUsage | null,
  response: unknown,
  callSite: string,
): ReportedUsage | null {
  if (!usage) return null;
  const tooMuchReasoning = (usage.reasoningTokens ?? 0) > usage.outputTokens;
  const silentText = usage.outputTokens === 0 && answerText(response).text.length > 0;
  if (!tooMuchReasoning && !silentText) return usage;
  log.warn(
    `${callSite}: the reported usage is inconsistent (${usage.outputTokens} output, ` +
      `${usage.reasoningTokens ?? "no"} reasoning tokens); counting the worst case instead`,
  );
  return null;
}

const modelKey = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The price for an answer: the deployment's, unless the answer names a model outside the
 * priced family of the deployment (`gpt-6-sol` prices `gpt-6-sol`, `gpt-6-sol-2026-08-01`, …),
 * then the fallback prices × 1.5. A deployment without a public price already has those.
 */
function priceForAnswer(
  price: AppliedPrice,
  deployment: string,
  response: unknown,
  callSite: string,
): AppliedPrice {
  const model = (response as { model?: unknown } | null)?.model;
  if (price.source === null || typeof model !== "string" || model === "") return price;
  if (modelKey(model).startsWith(modelKey(deployment))) return price;
  log.warn(
    `${callSite}: the answer came from a model outside the priced family of the ` +
      "deployment; charging the fallback prices × 1.5",
  );
  return { ...FALLBACK_PRICE, deployment, multiplier: UNSOURCED_PRICE_MULTIPLIER };
}

type Answer = { output: unknown } | { error: LlmError };

/** Reads a Responses API answer: its status first, then its text, then the schema. */
function readAnswer(
  response: unknown,
  usage: ReportedUsage | null,
  schema: z.ZodType,
  schemaName: string,
  callSite: string,
): Answer {
  const r = response as {
    object?: unknown;
    status?: unknown;
    incomplete_details?: { reason?: unknown } | null;
    error?: { code?: unknown } | null;
    output?: unknown;
  } | null;
  const withUsage = usage ? { usage } : {};
  if (!r || typeof r !== "object" || r.object !== "response") {
    return {
      error: new LlmError(
        "invalid_response",
        `${callSite}: the answer is not a Responses API object`,
      ),
    };
  }
  if (r.status === "incomplete") {
    const reason =
      typeof r.incomplete_details?.reason === "string" ? r.incomplete_details.reason : "unknown";
    const used = usage
      ? ` after ${usage.outputTokens} output tokens (${usage.reasoningTokens ?? "unknown"} reasoning)`
      : "";
    const hint = reason === "max_output_tokens" ? "; raise maxOutputTokens" : "";
    return {
      error: new LlmError(
        "incomplete",
        `${callSite}: the answer stopped early (${reason})${used}${hint}`,
        { incompleteReason: reason, ...withUsage },
      ),
    };
  }
  if (r.status === "failed") {
    const code = typeof r.error?.code === "string" ? r.error.code : "unknown";
    return {
      error: new LlmError("response_failed", `${callSite}: the provider failed (${code})`, {
        transient: code === "server_error",
        ...withUsage,
      }),
    };
  }
  if (r.status !== "completed") {
    return {
      error: new LlmError(
        "invalid_response",
        `${callSite}: the answer has status ${JSON.stringify(r.status).slice(0, 40)}`,
        withUsage,
      ),
    };
  }
  const { text, refusal } = answerText(r);
  if (refusal !== null) {
    return {
      error: new LlmError("refused", `${callSite}: the model refused to answer`, withUsage),
    };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return {
      error: new LlmError(
        "invalid_output",
        `${callSite}: the answer is not valid JSON for ${schemaName}`,
        withUsage,
      ),
    };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      error: new LlmError(
        "invalid_output",
        `${callSite}: the answer does not match ${schemaName}`,
        withUsage,
      ),
    };
  }
  return { output: parsed.data };
}

// =============================================================================
// The layer
// =============================================================================

export interface Llm {
  invoke<S extends z.ZodType>(
    callSite: string,
    tier: LlmTier,
    input: LlmInput,
    schema: S,
    options: InvokeOptions,
  ): Promise<InvokeResult<z.output<S>>>;
  /** Calls counted so far for a run. */
  callsForRun(runId: string): number;
  /** Forgets a finished run's count. */
  endRun(runId: string): void;
}

const MAX_TRACKED_RUNS = 10_000;

export function createLlm(deps: LlmDependencies): Llm {
  const { settings } = deps;
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const recordUsage = deps.recordUsage ?? recordToOpenDatabase;
  const cassetteDir = cassetteDirFor(settings.cassetteDir);
  const guard = new SpendGuard({
    logPath: settings.spendLog,
    caps: settings.budget,
    now,
  });
  const semaphore = new Semaphore(settings.concurrency);
  // The process's commit (runningCommit: read once per process, at server start when the
  // analysis routes are loaded), the same one stored with each run; recordings, cassettes
  // included, are not counted as changes to the code.
  const recordedCommit = settings.cassette === "record" ? (deps.commit ?? runningCommit)() : null;
  const recordingCommit = () => recordedCommit;
  const runCalls = new Map<string, number>();
  const secrets = knownSecrets(deps.env ?? process.env, [
    settings.azureApiKey,
    endpointHost(settings),
  ]);

  /** Takes one of the run's calls, or throws call_cap. */
  function takeCall(runId: string, callSite: string): void {
    const used = runCalls.get(runId) ?? 0;
    if (used >= settings.maxCallsPerRun) {
      throw new LlmError(
        "call_cap",
        `${callSite}: run ${runId} has made ${used} model calls, the MAX_LLM_CALLS_PER_RUN limit`,
      );
    }
    runCalls.delete(runId);
    runCalls.set(runId, used + 1);
    if (runCalls.size > MAX_TRACKED_RUNS) {
      const oldest = runCalls.keys().next().value;
      if (oldest !== undefined) runCalls.delete(oldest);
    }
  }

  /** Gives back a call whose request was never sent. */
  function returnCall(runId: string): void {
    const used = runCalls.get(runId) ?? 0;
    if (used > 0) runCalls.set(runId, used - 1);
  }

  function record(row: LlmUsageRow): void {
    try {
      recordUsage(row);
    } catch (error) {
      log.warn(`usage row not recorded: ${(error as Error).message}`);
    }
  }

  async function invoke<S extends z.ZodType>(
    callSite: string,
    tier: LlmTier,
    input: LlmInput,
    schema: S,
    options: InvokeOptions,
  ): Promise<InvokeResult<z.output<S>>> {
    const invalid = (why: string) => new LlmError("invalid_input", `${callSite}: ${why}`);
    throwIfAborted(options.signal, callSite);
    if (!isTier(tier)) throw invalid("unknown tier");
    if (!(LLM_PURPOSES as readonly string[]).includes(options.purpose)) {
      throw invalid("unknown purpose");
    }
    if (!options.runId) throw invalid("runId is required");
    if (!Number.isInteger(options.maxOutputTokens) || options.maxOutputTokens < MIN_OUTPUT_TOKENS) {
      throw invalid(`maxOutputTokens must be an integer of at least ${MIN_OUTPUT_TOKENS}`);
    }

    const schemaName = schemaNameOf(schema, options.schemaName);
    const jsonSchema = strictJsonSchema(schema, schemaName);
    const messages = toMessages(input, callSite);
    const deployment = settings.deployments[tier];
    const effort = REASONING_EFFORT[tier];
    const key = cassetteKey({
      tier,
      deployment,
      schemaName,
      jsonSchema,
      reasoningEffort: effort,
      maxOutputTokens: options.maxOutputTokens,
      messages,
      volatile: [options.runId],
    });

    if (settings.cassette === "replay") {
      takeCall(options.runId, callSite);
      const started = performance.now();
      const entry = await readCassette(cassetteDir, { schemaName, tier, key }, callSite);
      const parsed = schema.safeParse(entry.output);
      if (!parsed.success) {
        throw new LlmError(
          "invalid_output",
          `${callSite}: the cassette's answer no longer matches ${schemaName}; record it again`,
        );
      }
      const callId = randomUUID();
      const latencyMs = performance.now() - started;
      const multiplier = priceFor(deployment).multiplier;
      record({
        id: callId,
        runId: options.runId,
        callSite,
        tier,
        deployment,
        purpose: options.purpose,
        mode: "replay",
        status: "ok",
        ...entry.usage,
        usdEst: 0,
        priceMultiplier: multiplier,
        estimated: false,
        latencyMs,
        sent: false,
      });
      return {
        output: parsed.data,
        callId,
        mode: "replay",
        tier,
        deployment,
        usage: { ...entry.usage, usdEst: 0, multiplier, latencyMs, attempts: 1 },
        recording: cassetteRecording(entry),
      };
    }

    assertProviderConfigured(settings);
    if (settings.spendLog === null) {
      throw new LlmError(
        "spend_log_unavailable",
        `${callSite}: LLM_SPEND_LOG is not set; live model calls are refused until it names the spend log`,
      );
    }
    const inputEstimate = estimateInputTokens(messages, jsonSchema);
    if (inputEstimate > SHORT_CONTEXT_MAX_INPUT_TOKENS) {
      throw new LlmError(
        "input_too_large",
        `${callSite}: up to ${inputEstimate} input tokens, above the ${SHORT_CONTEXT_MAX_INPUT_TOKENS} the price table covers`,
      );
    }
    const price = priceFor(deployment);
    const mode = settings.cassette === "record" ? "record" : "live";
    const attempt = {
      callSite,
      tier,
      deployment,
      effort,
      schema,
      schemaName,
      jsonSchema,
      messages,
      options,
      price,
      inputEstimate,
      mode,
    } as const;

    for (let n = 1; ; n++) {
      const outcome = await semaphore.run(() => attemptOnce(attempt), options.signal, callSite);
      if ("output" in outcome) {
        if (mode === "record") {
          await writeCassette(
            cassetteDir,
            {
              version: 1,
              key,
              tier,
              deployment,
              schemaName,
              messages: normaliseMessages(messages, [options.runId]),
              output: outcome.output,
              usage: outcome.usage,
              recordedAt: now().toISOString(),
              commit: recordingCommit(),
            },
            secrets,
            settings.azureApiKey,
          ).catch((error: unknown) => {
            log.warn(`LLM_CASSETTE=record: ${(error as Error).message}`);
          });
        }
        return {
          output: outcome.output as z.output<S>,
          callId: outcome.callId,
          mode,
          tier,
          deployment,
          usage: { ...outcome.usage, ...outcome.cost, attempts: n },
        };
      }
      const { error } = outcome;
      if (n >= MAX_ATTEMPTS || !isTransient(error)) throw error;
      const wait = error.retryAfterMs ?? DEFAULT_RETRY_WAIT_MS;
      if (wait > MAX_RETRY_WAIT_MS) throw error;
      await abortable(sleep(wait), options.signal, callSite);
    }
  }

  type AttemptOutcome =
    | {
        output: unknown;
        callId: string;
        usage: CassetteUsage;
        cost: { usdEst: number; multiplier: number; latencyMs: number };
      }
    | { error: LlmError };

  async function attemptOnce(a: {
    callSite: string;
    tier: LlmTier;
    deployment: string;
    effort: ReasoningEffort;
    schema: z.ZodType;
    schemaName: string;
    jsonSchema: Record<string, unknown>;
    messages: LlmMessage[];
    options: InvokeOptions;
    price: AppliedPrice;
    inputEstimate: number;
    mode: "live" | "record";
  }): Promise<AttemptOutcome> {
    const { signal, runId } = a.options;
    throwIfAborted(signal, a.callSite);
    takeCall(runId, a.callSite);
    const worstCase = costUsd(a.price, a.inputEstimate, a.options.maxOutputTokens);
    let reservation: Reservation;
    try {
      reservation = await guard.reserve(
        {
          purpose: a.options.purpose,
          tier: a.tier,
          deployment: a.deployment,
          callSite: a.callSite,
          runId,
          inputTokensEstimate: a.inputEstimate,
          maxOutputTokens: a.options.maxOutputTokens,
          usdEst: worstCase,
          multiplier: a.price.multiplier,
        },
        signal,
      );
    } catch (error) {
      returnCall(runId);
      throw error;
    }

    // Whether a request left this process, and the HTTP status of its answer.
    let sent = false;
    let httpStatus: number | null = null;
    const baseFetch = deps.fetch ?? globalThis.fetch;
    const trackedFetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      sent = true;
      const response = await baseFetch(input, init);
      httpStatus = response.status;
      return response;
    }) as typeof fetch;

    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), settings.timeoutMs);
    const requestSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const started = performance.now();
    let usage: ReportedUsage | null = null;
    let price = a.price;
    let answer: Answer;
    let thrown: unknown = null;
    try {
      throwIfAborted(signal, a.callSite);
      const client: OpenAI = createResponsesClient(settings, {
        timeoutMs: settings.timeoutMs,
        fetch: trackedFetch,
      });
      const response = await client.responses.create(
        {
          model: a.deployment,
          input: a.messages.map((m) => ({ role: m.role, content: m.content })),
          text: {
            format: {
              type: "json_schema",
              name: a.schemaName,
              schema: a.jsonSchema,
              strict: true,
            },
          },
          reasoning: { effort: a.effort },
          max_output_tokens: a.options.maxOutputTokens,
          store: false,
        },
        { signal: requestSignal },
      );
      usage = consistentUsage(reportedUsage(response), response, a.callSite);
      price = priceForAnswer(a.price, a.deployment, response, a.callSite);
      answer = readAnswer(response, usage, a.schema, a.schemaName, a.callSite);
    } catch (caught) {
      thrown = caught;
      let error = classifyError(caught, {
        timedOut: timeout.signal.aborted && !signal?.aborted,
        aborted: signal?.aborted ?? false,
        callSite: a.callSite,
        secrets,
      });
      // A 2xx answer the client could not read (a proxy's HTML page, a truncated body).
      const status = httpStatus as number | null;
      if (status !== null && status >= 200 && status < 300 && error.kind === "provider") {
        error = new LlmError(
          "invalid_response",
          `${a.callSite}: the answer (HTTP ${status}) is not a Responses API object`,
        );
      }
      answer = { error };
    } finally {
      clearTimeout(timer);
    }
    const latencyMs = performance.now() - started;
    const error = "error" in answer ? answer.error : null;
    // Whether the request was sent to the provider (the usage row's `sent`): it left this
    // process, and an answer came back or the failure does not show that no connection was made.
    // An HTTP answer (even one whose body was then lost) means it was.
    const answered = (httpStatus as number | null) !== null;
    const undelivered = !answered && thrown !== null && neverConnected(thrown);
    const sentToProvider: boolean = (sent as boolean) && !undelivered;

    // The settlement table in the module comment.
    let usdEst: number;
    let estimated = false;
    if (!sent) {
      usdEst = 0;
      returnCall(runId);
    } else if (usage) {
      usdEst = costUsd(price, usage.inputTokens, usage.outputTokens);
    } else if (error?.kind === "content_filtered") {
      usdEst = costUsd(price, a.inputEstimate, 0);
      estimated = true;
    } else if (error?.status !== undefined && UNBILLED_STATUSES.has(error.status)) {
      usdEst = 0;
    } else if (undelivered) {
      usdEst = 0;
    } else {
      usdEst = worstCase;
      estimated = true;
    }
    if (usdEst > worstCase) {
      log.warn(
        `${a.callSite}: the reported cost (USD ${usdEst}) is above the reservation ` +
          `(USD ${worstCase}); the input bound was exceeded`,
      );
    }
    const status = error ? `error:${error.kind}` : "ok";
    await guard
      .settle(reservation, {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        reasoningTokens: usage?.reasoningTokens ?? null,
        usdEst,
        latencyMs: Math.round(latencyMs),
        status,
        estimated,
        ...(price.multiplier !== a.price.multiplier ? { multiplier: price.multiplier } : {}),
      })
      .catch((settleError: unknown) => {
        // The reservation stays in the log and keeps counting at the worst case.
        log.warn(`${a.callSite}: not settled: ${(settleError as Error).message}`);
      });
    record({
      id: reservation.id,
      runId,
      callSite: a.callSite,
      tier: a.tier,
      deployment: a.deployment,
      purpose: a.options.purpose,
      mode: a.mode,
      status,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      reasoningTokens: usage?.reasoningTokens ?? null,
      usdEst,
      priceMultiplier: price.multiplier,
      estimated,
      latencyMs,
      sent: sentToProvider,
    });
    if (error) {
      // A failed answer that reported its tokens was billed: say what it cost.
      if (usage) error.cost = { deployment: a.deployment, usdEst };
      return { error };
    }
    return {
      output: (answer as { output: unknown }).output,
      callId: reservation.id,
      usage: usage ?? UNKNOWN_USAGE,
      cost: { usdEst, multiplier: price.multiplier, latencyMs },
    };
  }

  return {
    invoke,
    callsForRun: (runId) => runCalls.get(runId) ?? 0,
    endRun: (runId) => {
      runCalls.delete(runId);
    },
  };
}

// =============================================================================
// The process-wide instance
// =============================================================================

let shared: Llm | null = null;

/** The layer configured from process.env, created on first use. */
function sharedLlm(): Llm {
  if (shared) return shared;
  const { settings, errors } = readLlmSettings(process.env);
  if (errors.length > 0) {
    throw new LlmError("not_configured", `Invalid model settings: ${errors.join("; ")}`);
  }
  shared = createLlm({ settings });
  return shared;
}

export const llm: Llm = {
  invoke: (callSite, tier, input, schema, options) =>
    sharedLlm().invoke(callSite, tier, input, schema, options),
  callsForRun: (runId) => sharedLlm().callsForRun(runId),
  endRun: (runId) => sharedLlm().endRun(runId),
};

export { isLlmError, LlmError };
