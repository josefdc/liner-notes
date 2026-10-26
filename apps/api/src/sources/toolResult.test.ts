/**
 * How a research tool's result is read: by its `found`, `code` and `unavailable` fields, never
 * by its text. Text that is not a result object is the source's invalid response.
 */

import { SourceError as SourceErrorSchema } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { sourceErrorLine } from "../agent/statusText.js";
import { SourceError } from "./http.js";
import { errorRecord } from "./records.js";
import {
  failureWith,
  keyRejected,
  NOT_ASKED_REASONS,
  notAnswered,
  plainSourceError,
  readToolResult,
  sourceErrorCode,
  toolFailure,
} from "./toolResult.js";

describe("readToolResult", () => {
  it("reads found data", () => {
    expect(readToolResult("lastfm", JSON.stringify({ found: true, tags: ["x"] }))).toEqual({
      kind: "found",
      data: { found: true, tags: ["x"] },
    });
  });

  it("reads 'nothing found' with its typed reason, not its message", () => {
    const raw = JSON.stringify({ found: false, reason: "ambiguous", message: "No recording" });
    expect(readToolResult("musicbrainz", raw)).toEqual({ kind: "none", reason: "ambiguous" });
    expect(readToolResult("lastfm", JSON.stringify({ found: false }))).toEqual({
      kind: "none",
      reason: null,
    });
  });

  it("reads a failure by its code", () => {
    const raw = JSON.stringify(failureWith("rate_limited", "Last.fm error 29: slow down"));
    expect(readToolResult("lastfm", raw)).toEqual({
      kind: "failed",
      keyRejected: false,
      error: { source: "lastfm", code: "rate_limited", message: "Last.fm error 29: slow down" },
    });
  });

  it.each(SourceErrorSchema.shape.code.options)("reads every contract code, here %s", (code) => {
    expect(readToolResult("lastfm", JSON.stringify({ found: false, code, error: "x" }))).toEqual({
      kind: "failed",
      keyRejected: false,
      error: { source: "lastfm", code, message: "x" },
    });
  });

  it("names the source the result names (a MusicBrainz failure inside a ListenBrainz tool)", () => {
    const raw = JSON.stringify(toolFailure(new SourceError("musicbrainz", "rate_limited", "503")));
    expect(readToolResult("listenbrainz", raw)).toMatchObject({
      kind: "failed",
      keyRejected: false,
      error: { source: "musicbrainz", code: "rate_limited" },
    });
    // A source outside the contract (the audio service) is not a research source.
    const audio = JSON.stringify({ found: false, code: "timeout", error: "x", source: "audio" });
    expect(readToolResult("listenbrainz", audio)).toMatchObject({
      error: { source: "listenbrainz" },
    });
  });

  it("reads a rejected key as a failure the consumers can tell apart", () => {
    const raw = JSON.stringify(keyRejected("Last.fm rejected the API key"));
    expect(readToolResult("lastfm", raw)).toEqual({
      kind: "failed",
      keyRejected: true,
      error: { source: "lastfm", code: "unavailable", message: "Last.fm rejected the API key" },
    });
  });

  it.each(NOT_ASKED_REASONS)("passes the typed reason %s on", (reason) => {
    expect(readToolResult("lastfm", JSON.stringify(notAnswered(reason)))).toEqual({
      kind: "none",
      reason,
    });
  });

  it("reads #11's unavailable marker without a code as not configured", () => {
    const raw = JSON.stringify({ found: false, unavailable: true, error: "no key" });
    expect(readToolResult("lastfm", raw)).toEqual({
      kind: "failed",
      keyRejected: false,
      error: { source: "lastfm", code: "not_configured", message: "no key" },
    });
  });

  it("reads an error without a code as unavailable, never as nothing found", () => {
    const raw = JSON.stringify({ found: false, error: "boom" });
    expect(readToolResult("listenbrainz", raw)).toMatchObject({
      kind: "failed",
      keyRejected: false,
      error: { source: "listenbrainz", code: "unavailable" },
    });
  });

  it.each([
    ["Error: text", "Error: MusicBrainz is unavailable"],
    ["a 'No … found' sentence", "No similar tracks found"],
    ["a list", "[]"],
    ["null", "null"],
  ])("reads %s as an invalid response", (_name, raw) => {
    expect(readToolResult("musicbrainz", raw)).toEqual({
      kind: "failed",
      keyRejected: false,
      error: {
        source: "musicbrainz",
        code: "invalid_response",
        message: "the tool did not return a result object",
      },
    });
  });
});

describe("toolFailure", () => {
  it.each([
    [new SourceError("tavily", "unavailable", "no key"), "not_configured", true],
    [new SourceError("tavily", "timeout", "slow"), "timeout", false],
    [new SourceError("tavily", "rate_limited", "429"), "rate_limited", false],
    // An HTML or bot-challenge page is usually passing: unavailable, not a lasting answer.
    [new SourceError("tavily", "content_type", "html"), "unavailable", false],
    [new SourceError("tavily", "parse", "not a list"), "invalid_response", false],
    [new SourceError("tavily", "http", "500"), "unavailable", false],
    // A bug in our reader: an internal error, never the source's answer.
    [new TypeError("bad shape"), "unavailable", false],
  ])("%s → %s", (error, code, unavailable) => {
    const result = toolFailure(error);
    expect(sourceErrorCode(error)).toBe(code);
    expect(result).toMatchObject({ found: false, code });
    expect(result.unavailable === true).toBe(unavailable);
  });

  it("says a reader's bug is an internal error", () => {
    expect(toolFailure(new TypeError("rel.type is undefined"))).toMatchObject({
      code: "unavailable",
      error: "internal error: rel.type is undefined",
    });
  });
});

describe("plainSourceError", () => {
  const error = (message?: string) => ({
    source: "musicbrainz" as const,
    code: "unavailable" as const,
    ...(message === undefined ? {} : { message }),
  });

  it("keeps a plain message as it is", () => {
    const plain = error("musicbrainz: HTTP 503 (the source could not answer)");
    expect(plainSourceError(plain)).toBe(plain);
    expect(plainSourceError(error())).toEqual(error());
  });

  it("writes links as [link], and leaves out a message with markup, a stack trace or a token", () => {
    expect(plainSourceError(error("connect ECONNREFUSED https://musicbrainz.org/ws/2"))).toEqual(
      error("connect ECONNREFUSED [link]"),
    );
    expect(plainSourceError(error("<html>Bad gateway</html>"))).toEqual(error());
    expect(plainSourceError(error("boom at handler (/srv/app/index.js:10:5)"))).toEqual(error());
    expect(plainSourceError(error("Rejected key token=abc123"))).toEqual(error());
  });

  it("keeps an internal error's prefix, so its status line still says our reader failed", () => {
    expect(
      plainSourceError(error("internal error: Cannot read properties of Map<string>")),
    ).toEqual(error("internal error: the message was left out"));
    expect(
      plainSourceError(error("internal error: Failed to parse URL from https://example.org/a")),
    ).toEqual(error("internal error: Failed to parse URL from [link]"));
  });

  it.each([
    ["an empty message", ""],
    ["a message of spaces", "   "],
    ["a message of a line break", "\n"],
  ])("keeps an internal error with %s an internal error", (_name, text) => {
    const plain = plainSourceError(errorRecord("lastfm", new TypeError(text)));
    expect(plain).toEqual({
      source: "lastfm",
      code: "unavailable",
      message: "internal error: the message was left out",
    });
    expect(sourceErrorLine(plain)).toBe("Last.fm: our reader failed on its answer");
  });
});
