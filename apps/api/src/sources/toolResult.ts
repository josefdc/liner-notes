/**
 * The JSON the research tools return, and how their consumers read it.
 *
 * A research tool resolves with one of three JSON objects:
 *   - found: `{ found: true, … }` with the data;
 *   - not answered: `{ found: false, reason, message? }`. `reason` is a `ToolReason`: the source
 *     answered with nothing for the request (`NothingReason`), or the request was not made or
 *     the source could not identify the track or artist (`NotAskedReason`);
 *   - failure: `{ found: false, code, error, source?, unavailable?, keyRejected? }`: the source
 *     could not be read. `code` is the contract's SourceError code; `source` names the source that
 *     failed when it is not the tool's own (a ListenBrainz tool resolving a name on MusicBrainz);
 *     `unavailable: true` marks a source that is not configured (no key: a lasting state);
 *     `keyRejected: true` a key the source refused (an operator error to fix, code
 *     "unavailable").
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
 * A failure of our own code (a bug in a reader, such as a TypeError past its shape checks), not
 * of the source: it is reported as an internal error, never as the source's answer.
 */
export function isInternalError(error: unknown): boolean {
  return (
    error instanceof TypeError || error instanceof ReferenceError || error instanceof RangeError
  );
}

/** The prefix of an internal error's message: the status says our reader failed. */
export const INTERNAL_ERROR_PREFIX = "internal error: ";

/** A failure's message; an internal error says so. */
export function failureMessage(error: unknown): string {
  return isInternalError(error)
    ? `${INTERNAL_ERROR_PREFIX}${describeError(error)}`
    : describeError(error);
}

/**
 * The contract code of a failure. A deadline is a timeout; a request the caller cancelled is
 * "unavailable", not a timeout. An answer that is not JSON (an HTML error or bot-challenge page,
 * usually passing) is "unavailable"; JSON the reader cannot read is "invalid_response". A bug in
 * our own reader is "unavailable" with an internal-error message (failureMessage).
 */
export function sourceErrorCode(error: unknown): SourceErrorCode {
  if (isSourceError(error)) {
    if (error.kind === "timeout") return "timeout";
    if (error.kind === "rate_limited") return "rate_limited";
    if (error.kind === "parse") return "invalid_response";
    if (error.kind === "unavailable") return "not_configured";
    return "unavailable";
  }
  return "unavailable";
}

/** A failed tool call: the source could not be read. */
export interface ToolFailure {
  found: false;
  code: SourceErrorCode;
  error: string;
  /** The source that failed, when it is not the tool's own. */
  source?: SourceId;
  /** Set when the source is not configured (no key): a lasting state, nothing was requested. */
  unavailable?: true;
  /** Set when the source refused the key: an operator error, reported as "key rejected". */
  keyRejected?: true;
}

/**
 * Why a step was not asked, or why its source could not identify the track or artist: no
 * answer either way, never "nothing found".
 */
export const NOT_ASKED_REASONS = [
  /** No name to ask for (our input, not the source, is missing). */
  "no_input",
  /** Several recordings match the track and none can be picked. */
  "ambiguous",
  /** Several artists have the name and none is linked to the track's Spotify artist. */
  "ambiguous_artist",
  /** No MusicBrainz artist has exactly this name. */
  "artist_not_identified",
  /** The artist found by name links to another Spotify artist than the track's. */
  "other_spotify_artist",
  /** Last.fm refused the request's parameters. */
  "invalid_request",
  /** Last.fm's autocorrection answered for another artist. */
  "other_artist",
  /** Last.fm keeps one page for several artists of this name. */
  "shared_page",
] as const;
export type NotAskedReason = (typeof NOT_ASKED_REASONS)[number];
/** The source answered with nothing for the request. */
export type NothingReason = "not_found" | "no_results" | "no_similar_artists";
export type ToolReason = NotAskedReason | NothingReason;

/** The tool result for a request that brought nothing, with its typed reason. */
export interface NotAnswered {
  found: false;
  reason: ToolReason;
  message?: string;
}

export function notAnswered(reason: ToolReason, message?: string): NotAnswered {
  return message === undefined ? { found: false, reason } : { found: false, reason, message };
}

/** The tool result for a key the source refused: reported as "key rejected", not "not set". */
export function keyRejected(message: string): ToolFailure {
  return { found: false, code: "unavailable", error: message, keyRejected: true };
}

/** The tool result for a failure, with its code and the source that failed. */
export function toolFailure(error: unknown): ToolFailure {
  const failure = failureWith(sourceErrorCode(error), failureMessage(error));
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
  | { kind: "failed"; error: SourceErrorRecord; keyRejected: boolean };

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
    return failed(from, result.code as SourceErrorCode, message, result.keyRejected === true);
  }
  if (result.unavailable === true) return failed(from, "not_configured", message);
  if (result.error !== undefined) return failed(from, "unavailable", message);
  if (result.found === true) return { kind: "found", data: result as T };
  const reason = typeof result.reason === "string" ? result.reason : null;
  return { kind: "none", reason };
}

function failed<T>(
  source: SourceId,
  code: SourceErrorCode,
  message?: string,
  rejected = false,
): ToolOutcome<T> {
  return {
    kind: "failed",
    error: message ? { source, code, message } : { source, code },
    keyRejected: rejected,
  };
}
