/**
 * The agent's retry rules: an error is retried by type, status or code, never by its text,
 * and a cancelled call or run is never retried.
 */

import { describe, expect, it } from "vitest";
import { LlmError } from "../llm/errors.js";
import { SourceError } from "../sources/http.js";
import { isAbortError, isTransient, TransientError, withRetry } from "./errors.js";

describe("isTransient", () => {
  it.each([
    ["a TransientError", new TransientError("busy", 503)],
    ["a transient model error", new LlmError("rate_limited", "429", { transient: true })],
    ["a source rate limit", new SourceError("lastfm", "rate_limited", "slow down")],
    ["a source timeout", new SourceError("musicbrainz", "timeout", "timed out")],
    ["a source 503", new SourceError("tavily", "http", "unavailable", { status: 503 })],
    ["an error with status 429", Object.assign(new Error("x"), { status: 429 })],
    ["a refused connection", Object.assign(new Error("x"), { code: "ECONNREFUSED" })],
    [
      "a fetch failure caused by a reset",
      new TypeError("fetch failed", {
        cause: Object.assign(new Error("x"), { code: "ECONNRESET" }),
      }),
    ],
  ])("retries %s", (_label, error) => {
    expect(isTransient(error)).toBe(true);
  });

  it.each([
    ["an insufficient-quota 429", new LlmError("rate_limited", "quota", { transient: false })],
    ["a budget refusal", new LlmError("budget_exceeded", "cap")],
    ["the per-run call cap", new LlmError("call_cap", "cap")],
    ["an invalid answer", new LlmError("invalid_output", "bad")],
    ["a source 404", new SourceError("musicbrainz", "http", "not found", { status: 404 })],
    ["a source that is not configured", new SourceError("tavily", "unavailable", "no key")],
    ["an error whose text mentions a quota", new Error("Rate limit: quota exceeded (429)")],
    ["a bug", new TypeError("x is not a function")],
  ])("does not retry %s", (_label, error) => {
    expect(isTransient(error)).toBe(false);
  });

  it("never retries a cancelled call or run", () => {
    const cancelled = [
      new LlmError("aborted", "aborted", { transient: true }),
      new SourceError("lastfm", "aborted", "aborted"),
      Object.assign(new Error("aborted"), { name: "AbortError", status: 503 }),
    ];
    for (const error of cancelled) {
      expect(isAbortError(error)).toBe(true);
      expect(isTransient(error)).toBe(false);
    }
  });
});

describe("withRetry", () => {
  it("throws a non-transient error at once", async () => {
    let calls = 0;
    await expect(
      withRetry(async () => {
        calls++;
        throw new Error("Rate limit");
      }),
    ).rejects.toThrow("Rate limit");
    expect(calls).toBe(1);
  });

  it("retries a transient error up to maxAttempts", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new TransientError("busy", 503);
        },
        { maxAttempts: 2, initialInterval: 1 },
      ),
    ).rejects.toThrow("busy");
    expect(calls).toBe(2);
  });
});
