/**
 * Stored results: served for 24 hours, and a result whose claims the verifier could not check
 * for an hour only, so a later run checks them.
 */

import { InMemoryStore } from "@langchain/langgraph";
import type { SourceError } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import { configuredSources, resultCacheKey, TRACKS_NAMESPACE } from "./cacheKeys.js";
import { FORUM_THREADS } from "../sources/testing/forumThreads.js";
import { createEmptyTrackData } from "./schema.js";
import {
  heldTextIssue,
  readStoredResult,
  STORED_UNCHECKED_LINE,
  storedStatus,
  STORED_RESULT_TTL_MS,
  storeResult,
  UNCHECKED_RESULT_TTL_MS,
} from "./storedResults.js";

const at = new Date("2026-01-01T00:00:00.000Z");
const later = (ms: number) => new Date(at.getTime() + ms);

describe("stored results", () => {
  it("serve a checked result for 24 hours and an unchecked one for an hour", async () => {
    const store = new InMemoryStore();
    await storeResult(store, createEmptyTrackData("checked", "T", "A"), at);
    await storeResult(
      store,
      createEmptyTrackData("unchecked", "T", "A"),
      at,
      [],
      UNCHECKED_RESULT_TTL_MS,
    );

    expect(UNCHECKED_RESULT_TTL_MS).toBeLessThan(STORED_RESULT_TTL_MS);
    const served = async (id: string, ms: number) =>
      (await readStoredResult(store, id, later(ms))) !== null;
    expect(await served("checked", STORED_RESULT_TTL_MS - 1)).toBe(true);
    expect(await served("checked", STORED_RESULT_TTL_MS)).toBe(false);
    expect(await served("unchecked", UNCHECKED_RESULT_TTL_MS - 1)).toBe(true);
    expect(await served("unchecked", UNCHECKED_RESULT_TTL_MS)).toBe(false);
  });

  it("never serves a result measured on Spotify's own clip, and serves one measured on Deezer's", async () => {
    // Stored before Spotify's clips were no longer measured: its tempo and key were measured on
    // Spotify's audio, so the track is composed again.
    const store = new InMemoryStore();
    const measured = (id: string, provider: "spotify" | "deezer") => ({
      ...createEmptyTrackData(id, "T", "A"),
      preview:
        provider === "spotify"
          ? { provider, method: "id" as const, score: null }
          : { provider, method: "isrc" as const, score: null },
    });
    await storeResult(store, measured("spotify-clip", "spotify"), at);
    await storeResult(store, measured("deezer-clip", "deezer"), at);

    expect(await readStoredResult(store, "spotify-clip", later(1000))).toBeNull();
    const served = await readStoredResult(store, "deezer-clip", later(1000));
    expect(served?.trackData.preview).toEqual({ provider: "deezer", method: "isrc", score: null });
  });

  it("never serves a result past 24 hours, whatever lifetime it was stored with", async () => {
    const store = new InMemoryStore();
    await storeResult(
      store,
      createEmptyTrackData("long", "T", "A"),
      at,
      [],
      7 * STORED_RESULT_TTL_MS,
    );
    expect(await readStoredResult(store, "long", later(STORED_RESULT_TTL_MS))).toBeNull();
  });

  it("keep what the verifier did on a copy whose check did not complete, and say so when served", async () => {
    const store = new InMemoryStore();
    const run = {
      id: "run-1",
      mode: "live" as const,
      recordedAt: null,
      commit: null,
      analyzerVersion: null,
      verifier: { judged: 0, unjudged: 2, failed: true },
    };
    await storeResult(
      store,
      { ...createEmptyTrackData("unchecked", "T", "A"), run },
      at,
      [],
      UNCHECKED_RESULT_TTL_MS,
    );
    await storeResult(
      store,
      {
        ...createEmptyTrackData("checked", "T", "A"),
        run: { ...run, verifier: { judged: 2, unjudged: 0 } },
      },
      at,
    );

    const unchecked = await readStoredResult(store, "unchecked", later(1));
    expect(unchecked?.verifier).toEqual({ judged: 0, unjudged: 2, failed: true });
    expect(storedStatus(unchecked!)).toEqual([STORED_UNCHECKED_LINE]);
    // The run information itself belongs to the run that composed it and is not served.
    expect(unchecked?.trackData).not.toHaveProperty("run");
    const checked = await readStoredResult(store, "checked", later(1));
    expect(checked?.verifier).toBeNull();
    expect(storedStatus(checked!)).toEqual([]);
  });
});

describe("held text", () => {
  const page = (url: string, excerpt: string, title = "A page about the track") => ({
    sourceTier: "web",
    url,
    title,
    excerpt,
  });
  const clean = page("https://www.example.org/news", "Released in 2000 on Virgin.");
  const forum = FORUM_THREADS[0][1];

  it("passes web pages the web tier keeps, source errors in words, and other tiers' text", () => {
    expect(heldTextIssue({})).toBeNull();
    expect(
      heldTextIssue(
        {
          evidence: [
            clean,
            // A primary record may name an account: the web tier's check is not run on it.
            { ...clean, sourceTier: "primary-record", excerpt: "Producer (@producer)" },
          ],
          run: { sourceErrors: [{ message: "the source refused the request" }, {}] },
        },
        [{ message: "not found" }],
      ),
    ).toBeNull();
  });

  it.each([
    [
      "a social platform page",
      { evidence: [clean, page("https://m.facebook.com/somepage/posts/1", "A post.")] },
      "evidence[1]: a social platform page",
    ],
    [
      "a forum thread",
      { evidence: [page("https://www.example.org/thread", forum)] },
      "evidence[0]: a comment thread",
    ],
    [
      "a forum thread as a title",
      { evidence: [page("https://www.example.org/thread", "A page.", forum)] },
      "evidence[0]: a comment thread",
    ],
    [
      "a handle that was not masked",
      { evidence: [page("https://www.example.org/news", "Thomas (@thomasbangalter) made it.")] },
      "evidence[0]: a private @handle",
    ],
    [
      "markup in the run's source errors",
      { run: { sourceErrors: [{ message: "fine" }, { message: "<html>Bad gateway</html>" }] } },
      "run.sourceErrors[1].message: markup",
    ],
    [
      "a stack trace in the run's source errors",
      { run: { sourceErrors: [{ message: "boom at handler (/srv/app/index.js:10:5)" }] } },
      "run.sourceErrors[0].message: a stack trace",
    ],
    [
      "a token parameter in the run's source errors",
      { run: { sourceErrors: [{ message: "HTTP 403 — key token=abc123 denied" }] } },
      "run.sourceErrors[0].message: a signature or token parameter",
    ],
    [
      "a link in the run's source errors",
      { run: { sourceErrors: [{ message: "HTTP 404 — see https://api.example.com/x" }] } },
      "run.sourceErrors[0].message: a link",
    ],
    [
      "entity-escaped markup in the run's source errors",
      { run: { sourceErrors: [{ message: "&amp;lt;h1&amp;gt;Bad gateway" }] } },
      "run.sourceErrors[0].message: markup",
    ],
  ])("names where %s is held, never the text", (_name, result, reason) => {
    expect(heldTextIssue(result)).toBe(reason);
  });

  it("checks source errors stored beside the result", () => {
    expect(heldTextIssue({}, [{ message: "<body>Bad gateway</body>" }])).toBe(
      "sourceErrors[0].message: markup",
    );
  });
});

describe("source errors stored beside a result", () => {
  const stored = async (sourceErrors: unknown[]) => {
    const store = new InMemoryStore();
    await store.put(TRACKS_NAMESPACE, resultCacheKey("beside", configuredSources()), {
      trackData: createEmptyTrackData("beside", "T", "A"),
      timestamp: at.getTime(),
      sourceErrors,
    });
    return readStoredResult(store, "beside", later(1));
  };
  const error = (message: string) => ({ source: "discogs", code: "unavailable", message });

  it.each([
    ["markup", "<html><body>Bad gateway</body></html>"],
    ["entity-escaped markup", "&lt;h1&gt;Bad gateway&lt;/h1&gt;"],
    ["a stack trace", "HTTP 500 — TypeError: x at handler (/srv/app/index.js:10:5)"],
    ["a token parameter", "HTTP 403 — https://api.example.com/v1?token=abc123 denied"],
    ["a link", "HTTP 404 — see https://api.example.com/v1/x"],
  ])("refuse a result whose stored source errors hold %s", async (_name, message) => {
    expect(await stored([error("the source refused the request"), error(message)])).toBeNull();
  });

  it("serve a result whose stored source errors are plain", async () => {
    const plain = [error("the source refused the request")];
    expect((await stored(plain))?.sourceErrors).toEqual(plain);
  });

  it("are stored as plain lines, so a result stored now is served", async () => {
    const store = new InMemoryStore();
    await storeResult(store, createEmptyTrackData("fresh", "T", "A"), at, [
      error("connect ECONNREFUSED https://api.discogs.com/x"),
      error("<html>Bad gateway</html>"),
      error("internal error: Cannot read properties of Map<string>"),
    ] as SourceError[]);
    expect((await readStoredResult(store, "fresh", later(1)))?.sourceErrors).toEqual([
      error("connect ECONNREFUSED [link]"),
      { source: "discogs", code: "unavailable" },
      error("internal error: the message was left out"),
    ]);
  });
});
