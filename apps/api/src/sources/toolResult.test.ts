/**
 * How a research tool's result is read: by its `found`, `code` and `unavailable` fields, never
 * by its text. Text that is not a result object is the source's invalid response.
 */

import { SourceError as SourceErrorSchema } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { SourceError } from "./http.js";
import { failureWith, readToolResult, sourceErrorCode, toolFailure } from "./toolResult.js";

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
      error: { source: "lastfm", code: "rate_limited", message: "Last.fm error 29: slow down" },
    });
  });

  it.each(SourceErrorSchema.shape.code.options)("reads every contract code, here %s", (code) => {
    expect(readToolResult("lastfm", JSON.stringify({ found: false, code, error: "x" }))).toEqual({
      kind: "failed",
      error: { source: "lastfm", code, message: "x" },
    });
  });

  it("names the source the result names (a MusicBrainz failure inside a ListenBrainz tool)", () => {
    const raw = JSON.stringify(toolFailure(new SourceError("musicbrainz", "rate_limited", "503")));
    expect(readToolResult("listenbrainz", raw)).toMatchObject({
      kind: "failed",
      error: { source: "musicbrainz", code: "rate_limited" },
    });
    // A source outside the contract (the audio service) is not a research source.
    const audio = JSON.stringify({ found: false, code: "timeout", error: "x", source: "audio" });
    expect(readToolResult("listenbrainz", audio)).toMatchObject({
      error: { source: "listenbrainz" },
    });
  });

  it("reads #11's unavailable marker without a code as not configured", () => {
    const raw = JSON.stringify({ found: false, unavailable: true, error: "no key" });
    expect(readToolResult("lastfm", raw)).toEqual({
      kind: "failed",
      error: { source: "lastfm", code: "not_configured", message: "no key" },
    });
  });

  it("reads an error without a code as unavailable, never as nothing found", () => {
    const raw = JSON.stringify({ found: false, error: "boom" });
    expect(readToolResult("listenbrainz", raw)).toMatchObject({
      kind: "failed",
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
    [new SourceError("tavily", "content_type", "html"), "invalid_response", false],
    [new SourceError("tavily", "http", "500"), "unavailable", false],
    [new TypeError("bad shape"), "invalid_response", false],
  ])("%s → %s", (error, code, unavailable) => {
    const result = toolFailure(error);
    expect(sourceErrorCode(error)).toBe(code);
    expect(result).toMatchObject({ found: false, code });
    expect(result.unavailable === true).toBe(unavailable);
  });
});
