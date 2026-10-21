/**
 * The JSON the research tools return, and how their consumers read it.
 *
 * A research tool resolves with one of three JSON objects:
 *   - found: `{ found: true, … }` with the data;
 *   - not answered: `{ found: false, reason, message? }`. `reason` is typed: the source answered
 *     with nothing for the request (`not_found`, `no_results`, …), or the request was not made or
 *     not identified (`no_input`, `ambiguous_artist`, …; see the consumers' reason lists);
 *   - failure: `{ found: false, code, error, source?, unavailable? }`: the source could not be
 *     read. `code` is the contract's SourceError code; `source` names the source that failed when
 *     it is not the tool's own (a ListenBrainz tool resolving a name on MusicBrainz);
 *     `unavailable: true` marks a source that is not configured or whose key was rejected.
 * Consumers branch on `found`, `reason` and `code` through `readToolResult`, never on the text:
 * a message such as "No … found" or "Error: …" is never research.
 */

import {
  type SourceError as SourceErrorRecord,
  SourceError as SourceErrorSchema,
  SourceId as SourceIdSchema,
  type SourceId,
} from "@liner-notes/contract";
import { describeError, isSourceError } from "./http.js";

export type SourceErrorCode = SourceErrorRecord["code"];

/** The contract's codes and sources; a code added there is read here without a change. */
const CODES: ReadonlySet<string> = new Set(SourceErrorSchema.shape.code.options);
const SOURCES: ReadonlySet<string> = new Set(SourceIdSchema.options);

const isSourceId = (value: unknown): value is SourceId =>
  typeof value === "string" && SOURCES.has(value);

/**
 * The contract code of a failure. A deadline is a timeout; a request the caller cancelled is
 * "unavailable", not a timeout; a TypeError is a payload of an unexpected shape read past a check.
 */
export function sourceErrorCode(error: unknown): SourceErrorCode {
  if (isSourceError(error)) {
    if (error.kind === "timeout") return "timeout";
    if (error.kind === "rate_limited") return "rate_limited";
    if (error.kind === "parse" || error.kind === "content_type") return "invalid_response";
    if (error.kind === "unavailable") return "not_configured";
    return "unavailable";
  }
  return error instanceof TypeError ? "invalid_response" : "unavailable";
}

/** A failed tool call: the source could not be read. */
export interface ToolFailure {
  found: false;
  code: SourceErrorCode;
  error: string;
  /** The source that failed, when it is not the tool's own. */
  source?: SourceId;
  /** Set when the source is not configured or its key was rejected (a permanent state). */
  unavailable?: true;
}

/** The tool result for a failure, with its code and the source that failed. */
export function toolFailure(error: unknown): ToolFailure {
  const failure = failureWith(sourceErrorCode(error), describeError(error));
  return isSourceError(error) && isSourceId(error.source)
    ? { ...failure, source: error.source }
    : failure;
}

/** The tool result for a failure whose code is already known (e.g. a source's own error). */
export function failureWith(code: SourceErrorCode, message: string): ToolFailure {
  return code === "not_configured"
    ? { found: false, code, error: message, unavailable: true }
    : { found: false, code, error: message };
}

/** What a consumer reads from a tool result. */
export type ToolOutcome<T> =
  | { kind: "found"; data: T }
  | { kind: "none"; reason: string | null }
  | { kind: "failed"; error: SourceErrorRecord };

/**
 * A tool result as found data, "not answered" (with its typed reason) or the source's error. A
 * result that is not one of the documented objects (text, a list, malformed JSON) is the
 * source's invalid response: never research. A failure without a known code counts as
 * "unavailable". The failure is the tool's `source` unless the result names another one.
 */
export function readToolResult<T extends object = Record<string, unknown>>(
  source: SourceId,
  raw: unknown,
): ToolOutcome<T> {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return failed(source, "invalid_response", "the tool did not return a result object");
    }
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return failed(source, "invalid_response", "the tool did not return a result object");
  }
  const result = value as Record<string, unknown>;
  const from = isSourceId(result.source) ? result.source : source;
  const message = typeof result.error === "string" ? describeError(result.error) : undefined;
  if (typeof result.code === "string" && CODES.has(result.code)) {
    return failed(from, result.code as SourceErrorCode, message);
  }
  if (result.unavailable === true) return failed(from, "not_configured", message);
  if (result.error !== undefined) return failed(from, "unavailable", message);
  if (result.found === true) return { kind: "found", data: result as T };
  const reason = typeof result.reason === "string" ? result.reason : null;
  return { kind: "none", reason };
}

function failed<T>(source: SourceId, code: SourceErrorCode, message?: string): ToolOutcome<T> {
  return { kind: "failed", error: message ? { source, code, message } : { source, code } };
}
