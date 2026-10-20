/**
 * Web research searches with a stubbed Tavily API: each search returns a string the researcher
 * keeps (title, URL and text per result), lyric sites are excluded, and a failed search is text
 * starting "Error:" that the researcher's filter drops.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, json, stubFetch } from "./testing/fetchStub.js";

vi.hoisted(() => {
  // Set before the module loads, so a local .env does not supply a real key.
  process.env.TAVILY_API_KEY = "tvly-test-key";
});

import * as search from "./search.js";

const { searchMusicInfo, searchProductionHistory, searchSamples } = search;
const TAVILY = "https://api.tavily.com/search";

// The shape Tavily's /search answers with (fields the pipeline does not read included).
const answer = (results: unknown[]) => ({
  query: "q",
  follow_up_questions: null,
  answer: null,
  images: [],
  results,
  response_time: 0.8,
});

const WHOSAMPLED = {
  title: "Ice Ice Baby by Vanilla Ice on WhoSampled",
  url: "https://www.whosampled.com/Vanilla-Ice/Ice-Ice-Baby/",
  content: "Ice Ice Baby samples Under Pressure by Queen and David Bowie.",
  score: 0.91,
  raw_content: null,
};
const LYRICS_PAGE = {
  title: "Vanilla Ice – Ice Ice Baby Lyrics",
  url: "https://genius.com/Vanilla-ice-ice-ice-baby-lyrics",
  content: "LYRIC_TEXT_SHOULD_NOT_APPEAR",
  score: 0.88,
  raw_content: null,
};

/** The researcher keeps a search result unless it starts with one of these. */
const researcherKeeps = (result: string) =>
  !["Error", "No sample", "No production", "No results"].some((p) => result.startsWith(p));

const searches: Array<[string, () => Promise<unknown>]> = [
  ["samples", () => searchSamples.invoke({ songTitle: "Ice Ice Baby", artistName: "Vanilla Ice" })],
  [
    "production",
    () => searchProductionHistory.invoke({ songTitle: "Ice Ice Baby", artistName: "Vanilla Ice" }),
  ],
  ["general", () => searchMusicInfo.invoke({ query: "Ice Ice Baby Vanilla Ice history" })],
];

describe("web research searches", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(searches)("%s returns a string the researcher keeps", async (_name, run) => {
    stubFetch((call) =>
      call.url === TAVILY ? json(answer([WHOSAMPLED, LYRICS_PAGE])) : undefined,
    );

    const result = await run();

    expect(typeof result).toBe("string");
    const text = result as string;
    expect(researcherKeeps(text)).toBe(true);
    expect(text).toContain(WHOSAMPLED.title);
    expect(text).toContain(WHOSAMPLED.url);
    expect(text).toContain("samples Under Pressure");
  });

  it.each(searches)("%s excludes lyric sites from the request and the answer", async (_n, run) => {
    const net = stubFetch((call) =>
      call.url === TAVILY ? json(answer([LYRICS_PAGE, WHOSAMPLED])) : undefined,
    );

    const text = String(await run());

    expect(net.calls).toHaveLength(1);
    const body = JSON.parse(net.calls[0].body ?? "{}");
    expect(body.exclude_domains).toEqual(expect.arrayContaining(["genius.com", "azlyrics.com"]));
    expect(text).not.toContain("LYRIC_TEXT_SHOULD_NOT_APPEAR");
    expect(text).not.toContain("genius.com");
  });

  it("sends the key as a bearer token, never in the body", async () => {
    const net = stubFetch((call) => (call.url === TAVILY ? json(answer([WHOSAMPLED])) : undefined));

    await searchSamples.invoke({ songTitle: "Ice Ice Baby", artistName: "Vanilla Ice" });

    expect(net.calls[0].headers.authorization).toBe("Bearer tvly-test-key");
    expect(net.calls[0].body).not.toContain("tvly-test-key");
  });

  it("only lyric pages in the answer count as no results", async () => {
    stubFetch((call) => (call.url === TAVILY ? json(answer([LYRICS_PAGE])) : undefined));

    const text = await searchSamples.invoke({
      songTitle: "Ice Ice Baby",
      artistName: "Vanilla Ice",
    });

    expect(text).toMatch(/^No sample information found/);
    expect(researcherKeeps(text)).toBe(false);
  });

  it.each([
    [
      "an HTTP error",
      () => json({ detail: { error: "Unauthorized: invalid API key" } }, { status: 401 }),
    ],
    ["an HTML answer", () => html("<html>bad gateway</html>")],
    ["a body without results", () => json({ detail: "something else" })],
  ])("%s is text starting Error: that the researcher drops", async (_name, reply) => {
    stubFetch((call) => (call.url === TAVILY ? reply() : undefined));

    const text = await searchSamples.invoke({
      songTitle: "Ice Ice Baby",
      artistName: "Vanilla Ice",
    });

    expect(typeof text).toBe("string");
    expect(text).toMatch(/^Error: /);
    expect(researcherKeeps(text)).toBe(false);
  });

  it("no longer offers a song-meaning search or mentions lyrics", () => {
    expect(search).not.toHaveProperty("searchSongMeaning");
    for (const t of search.searchTools) {
      expect(t.description).not.toMatch(/lyric/i);
    }
  });
});
