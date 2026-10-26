/**
 * Words for the status lines the run sends: what happened to a source or to a model call, in
 * plain English. Error codes and provider text stay in the server log and in the run's
 * `sourceErrors`; a status line says what the code means.
 */

import type { SourceError } from "@liner-notes/contract";
import { isLlmError } from "../llm/errors.js";
import { INTERNAL_ERROR_PREFIX } from "../sources/toolResult.js";
import { SOURCE_NAMES } from "./prompts.js";

/** What happened to a source, by its error code, after the source's name. */
const SOURCE_ERROR_TEXT: Record<SourceError["code"], string> = {
  not_configured: "not asked: no key is configured for it",
  unavailable: "could not be read: it gave no usable answer",
  timeout: "could not be read: it did not answer in time",
  rate_limited: "could not be read: it is limiting requests",
  invalid_response: "answered in a form the reader does not know",
};

/**
 * The status line of a source error: "Genius not asked: no key is configured for it",
 * "Last.fm refused the configured key" for a key the source rejected, or, for a bug in our own
 * reader, that the reader failed (the source is not to blame).
 */
export function sourceErrorLine(error: SourceError, keyRejected = false): string {
  const name = SOURCE_NAMES[error.source];
  if (keyRejected) return `${name} refused the configured key`;
  if (error.message?.startsWith(INTERNAL_ERROR_PREFIX)) {
    return `${name}: our reader failed on its answer`;
  }
  return `${name} ${SOURCE_ERROR_TEXT[error.code]}`;
}

/** What happened to the request that lost records, by its error code. */
const LOST_REQUEST_TEXT: Record<SourceError["code"], string> = {
  not_configured: "was not sent: no key is configured",
  unavailable: "got no usable answer",
  timeout: "got no answer in time",
  rate_limited: "was refused: the source is limiting requests",
  invalid_response: "got an answer the reader does not know",
};

/**
 * The status line of a source that answered but lost records to a failed request: what
 * happened, in words, never the request's error text (it can hold URLs or response bodies).
 */
export function lostRecordsLine(error: SourceError): string {
  return `${SOURCE_NAMES[error.source]} records are incomplete: a request ${LOST_REQUEST_TEXT[error.code]}; a later run reads them again`;
}

/** Why the language model gave the run nothing it could use, as a category. */
export type ModelUnavailableReason =
  | "no_output"
  | "rate_limited"
  | "timeout"
  | "auth"
  | "error"
  | "budget_exhausted";

/**
 * The category sent to clients when the model call fails, from the error's kind. Provider
 * text stays in the server log: it can name keys, deployments or quotas.
 */
export function modelErrorCategory(error: unknown): ModelUnavailableReason {
  if (!isLlmError(error)) return "error";
  switch (error.kind) {
    case "budget_exceeded":
    case "call_cap":
      return "budget_exhausted";
    case "rate_limited":
      return "rate_limited";
    case "timeout":
      return "timeout";
    case "not_configured":
      return "auth";
    case "provider":
      return error.status === 401 || error.status === 403 ? "auth" : "error";
    case "incomplete":
    case "refused":
    case "invalid_output":
    case "invalid_response":
    case "content_filtered":
      return "no_output";
    default:
      return "error";
  }
}

/**
 * What happened to a model call, by its category: "unavailable" only where the model could not
 * be reached; an answer that came back unusable says so.
 */
export const MODEL_FAILURE_TEXT: Record<ModelUnavailableReason, string> = {
  no_output: "the model's answer could not be used",
  rate_limited: "the model is unavailable: it is limiting requests",
  timeout: "the model is unavailable: it did not answer in time",
  auth: "the model is unavailable: no working key is configured",
  error: "the model request failed",
  budget_exhausted: "the model budget is used up, so the model was not asked",
};
