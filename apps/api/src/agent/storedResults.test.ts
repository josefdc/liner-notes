/**
 * Stored results: served for 24 hours, and a result whose claims the verifier could not check
 * for an hour only, so a later run checks them.
 */

import { InMemoryStore } from "@langchain/langgraph";
import { describe, expect, it } from "vitest";
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
