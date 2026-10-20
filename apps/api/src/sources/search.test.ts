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
import { EXCLUDED_DOMAINS, isLyricPage } from "./search.js";

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
    expect(body.exclude_domains).toEqual(
      expect.arrayContaining([
        "genius.com",
        "azlyrics.com",
        "songtexte.com",
        "tekstowo.pl",
        "genius-com.translate.goog",
      ]),
    );
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

    expect(text).toMatch(/^Error: no web results: no sample information found/);
    expect(researcherKeeps(text)).toBe(false);
    // historianNode keeps any search text that does not start with "Error".
    expect(text.startsWith("Error")).toBe(true);
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

  describe("lyric filter", () => {
    it.each([
      "https://genius.com/Vanilla-ice-ice-ice-baby-lyrics",
      "https://genius.com/Vanilla-ice-ice-ice-baby-annotated",
      "https://www.lyricsondemand.com/v/vanillaice/iceicebaby.html",
      "https://www.azlyrics.com/lyrics/vanillaice/iceicebaby.html",
      "https://www.songtexte.com/songtext/vanilla-ice/ice-ice-baby-1bd6a5f4.html",
      "https://www.songtexte.bz/vanilla-ice/ice-ice-baby.html",
      "https://www.tekstowo.pl/piosenka,vanilla_ice,ice_ice_baby.html",
      "https://www.paroles-musique.com/paroles-Vanilla_Ice-Ice_Ice_Baby-lyrics,p1.html",
      "https://www.musica.com/letras.asp?letra=123",
      "https://www.letras.mus.br/vanilla-ice/ice-ice-baby/",
    ])("blocks the lyric site %s", (url) => {
      expect(isLyricPage(url)).toBe(true);
    });

    it.each([
      ["no scheme", "genius.com/Vanilla-ice-ice-ice-baby-annotated"],
      ["no scheme, www", "www.genius.com/Vanilla-ice-ice-ice-baby-annotated"],
      ["protocol-relative", "//genius.com/Vanilla-ice-ice-ice-baby-annotated"],
    ])("parses a URL with %s", (_name, url) => {
      expect(isLyricPage(url)).toBe(true);
    });

    it.each([
      "https://genius-com.translate.goog/Vanilla-ice-ice-ice-baby?_x_tr_sl=en",
      "https://www-azlyrics-com.translate.goog/lyrics/vanillaice/iceicebaby.html",
      "https://translate.google.com/translate?u=https://genius.com/Vanilla-ice-ice-ice-baby",
    ])("sees through the translate proxy %s", (url) => {
      expect(isLyricPage(url)).toBe(true);
    });

    it.each([
      ["lyrics", "https://news.example.test/music/ice-ice-baby-lyrics"],
      ["songtext", "https://www.example.de/songtext/vanilla-ice/ice-ice-baby"],
      ["paroles", "https://www.example.fr/paroles/vanilla-ice"],
      ["letras", "https://www.example.es/letras/vanilla-ice"],
      ["tekst", "https://www.example.pl/tekst-piosenki/ice-ice-baby"],
    ])("blocks a page whose path says %s", (_word, url) => {
      expect(isLyricPage(url)).toBe(true);
    });

    it.each([
      "https://www.rollingstone.com/music/music-news/vanilla-ice-lyric-video-123456/",
      "https://www.whosampled.com/Vanilla-Ice/Ice-Ice-Baby/",
      "https://en.wikipedia.org/wiki/Ice_Ice_Baby",
      "https://www.soundonsound.com/people/making-of-ice-ice-baby",
    ])("does not block %s", (url) => {
      expect(isLyricPage(url)).toBe(false);
    });

    it("excludes the new lyric sites and their translate proxies in the request", () => {
      expect(EXCLUDED_DOMAINS).toEqual(
        expect.arrayContaining([
          "songtexte.com",
          "songtexte.bz",
          "tekstowo.pl",
          "paroles-musique.com",
          "musica.com",
          "genius-com.translate.goog",
          "paroles--musique-com.translate.goog",
        ]),
      );
    });
  });
});
