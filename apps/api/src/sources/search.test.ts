/**
 * Web research searches with a stubbed Tavily API: each search returns the typed JSON the
 * researcher reads (title, URL and text per result), lyric sites are excluded, an answer with
 * nothing usable is "nothing found", and a failed search is a failure with its code.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { html, json, stubFetch } from "./testing/fetchStub.js";

vi.hoisted(() => {
  // Set before the module loads, so a local .env does not supply a real key.
  process.env.TAVILY_API_KEY = "tvly-test-key";
});

import * as search from "./search.js";
import { EXCLUDED_DOMAINS, isLyricPage, isSocialPage, webTextIssue } from "./search.js";
import { recordThenReplay } from "./testing/roundTrip.js";
import { readToolResult } from "./toolResult.js";

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

/** The researcher keeps a search result only when it reads as found. */
const researcherKeeps = (result: unknown) => readToolResult("tavily", result).kind === "found";

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

  it.each(searches)("%s returns results the researcher keeps", async (_name, run) => {
    stubFetch((call) =>
      call.url === TAVILY ? json(answer([WHOSAMPLED, LYRICS_PAGE])) : undefined,
    );

    const result = await run();

    expect(typeof result).toBe("string");
    expect(researcherKeeps(result)).toBe(true);
    expect(JSON.parse(result as string)).toEqual({
      found: true,
      results: [{ title: WHOSAMPLED.title, url: WHOSAMPLED.url, content: WHOSAMPLED.content }],
    });
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

  it.each(searches)(
    "%s excludes social platforms from the request and the answer",
    async (_n, run) => {
      const social = (url: string) => ({
        ...WHOSAMPLED,
        url,
        content: "SOCIAL_TEXT_SHOULD_NOT_APPEAR",
      });
      const net = stubFetch((call) =>
        call.url === TAVILY
          ? json(
              answer([
                social("https://www.instagram.com/p/abc123/"),
                social("https://www.tiktok.com/@someone/video/123"),
                social("https://m.facebook.com/somepage/posts/1"),
                social("https://x.com/someone/status/1"),
                social("https://www.reddit.com/r/music/comments/abc/"),
                WHOSAMPLED,
              ]),
            )
          : undefined,
      );

      const text = String(await run());

      const body = JSON.parse(net.calls[0].body ?? "{}");
      expect(body.exclude_domains).toEqual(
        expect.arrayContaining([
          "instagram.com",
          "tiktok.com",
          "facebook.com",
          "twitter.com",
          "threads.net",
          "reddit.com",
        ]),
      );
      expect(body.exclude_domains).not.toContain("youtube.com");
      // x.com is left out by the answer's filter only (see SOCIAL_SITES).
      expect(body.exclude_domains).not.toContain("x.com");
      expect(text).not.toContain("SOCIAL_TEXT_SHOULD_NOT_APPEAR");
      expect(JSON.parse(text).results).toHaveLength(1);
    },
  );

  it("drops a result whose text is profile or handle boilerplate", async () => {
    const comments = {
      ...WHOSAMPLED,
      url: "https://example.org/post/1",
      content:
        "dj_someone's profile picture dj_someone 2w Love this track! another.person's profile picture another.person 1w so good",
    };
    const handles = {
      ...WHOSAMPLED,
      url: "https://example.org/post/2",
      content: "@first_user @second.user @third_user @fourth_user this one",
    };
    stubFetch((call) =>
      call.url === TAVILY ? json(answer([comments, handles, WHOSAMPLED])) : undefined,
    );

    const text = await searchSamples.invoke({
      songTitle: "Ice Ice Baby",
      artistName: "Vanilla Ice",
    });

    expect(JSON.parse(text).results.map((r: { url: string }) => r.url)).toEqual([WHOSAMPLED.url]);
  });

  it("excludes the other social platforms and short links, on any subdomain or translate proxy", async () => {
    const pages = [
      "https://www.threads.com/@someone/post/1",
      "https://bsky.app/profile/someone.bsky.social/post/1",
      "https://www.pinterest.com/pin/123/",
      "https://instagr.am/p/abc123/",
      "https://fb.watch/abc123/",
      "https://redd.it/abc123",
      "https://t.co/abc123",
      "https://vm.tiktok.com/abc123/",
      "https://old.reddit.com/r/music/comments/abc/",
      "https://m.facebook.com/somepage/posts/1",
      "https://www-threads-com.translate.goog/@someone/post/1",
      "https://bsky-app.translate.goog/profile/someone",
    ];
    const net = stubFetch((call) =>
      call.url === TAVILY
        ? json(answer([...pages.map((url) => ({ ...WHOSAMPLED, url })), WHOSAMPLED]))
        : undefined,
    );

    const text = await searchSamples.invoke({
      songTitle: "Ice Ice Baby",
      artistName: "Vanilla Ice",
    });

    expect(JSON.parse(text).results.map((r: { url: string }) => r.url)).toEqual([WHOSAMPLED.url]);
    expect(JSON.parse(net.calls[0].body ?? "{}").exclude_domains).toEqual(
      expect.arrayContaining([
        "threads.com",
        "bsky.app",
        "pinterest.com",
        "instagr.am",
        "fb.watch",
        "redd.it",
        "vm.tiktok.com",
        "threads-com.translate.goog",
      ]),
    );
    for (const url of pages) expect(isSocialPage(url), url).toBe(true);
    expect(isSocialPage("https://www.youtube.com/watch?v=abc")).toBe(false);
    expect(isSocialPage("https://www.toscana.com/")).toBe(false);
  });

  it("excludes forum comment pages: Hacker News, on any subdomain or translate proxy", async () => {
    const pages = [
      "https://news.ycombinator.com/item?id=26214151",
      "https://m.news.ycombinator.com/item?id=26214151",
      "https://news-ycombinator-com.translate.goog/item?id=26214151",
      "https://translate.google.com/translate?u=https://news.ycombinator.com/item?id=26214151",
    ];
    const net = stubFetch((call) =>
      call.url === TAVILY
        ? json(
            answer([
              ...pages.map((url) => ({
                ...WHOSAMPLED,
                url,
                content: "One More Time is still the best house record ever made.",
              })),
              WHOSAMPLED,
            ]),
          )
        : undefined,
    );

    const text = await searchSamples.invoke({
      songTitle: "Ice Ice Baby",
      artistName: "Vanilla Ice",
    });

    expect(JSON.parse(text).results.map((r: { url: string }) => r.url)).toEqual([WHOSAMPLED.url]);
    expect(JSON.parse(net.calls[0].body ?? "{}").exclude_domains).toEqual(
      expect.arrayContaining(["news.ycombinator.com", "news-ycombinator-com.translate.goog"]),
    );
    for (const url of pages) expect(isSocialPage(url), url).toBe(true);
    // Y Combinator's own pages are not its forum.
    expect(isSocialPage("https://www.ycombinator.com/companies")).toBe(false);
  });

  it("excludes Quora and Gearspace, and leaves out Discogs' forum and group pages only", async () => {
    const pages = [
      "https://www.quora.com/What-does-One-More-Time-by-Daft-Punk-sample",
      "https://fr.quora.com/Quel-sample-Daft-Punk",
      "https://www-quora-com.translate.goog/What-does-Daft-Punk-sample",
      "https://gearspace.com/board/so-much-gear-so-little-time/123-daft-punk-vocoder.html",
      "https://www.gearspace.com/board/electronic-music-instruments/456-one-more-time.html",
      "https://gearspace-com.translate.goog/board/123-daft-punk.html",
      "https://www.discogs.com/forum/thread/123456",
      "https://www.discogs.com/group/thread/654321",
      "https://www.discogs.com/de/forum/thread/123456",
      "https://www-discogs-com.translate.goog/forum/thread/123456",
      "https://translate.google.com/translate?u=https://www.discogs.com/group/thread/654321",
    ];
    const RELEASE = {
      ...WHOSAMPLED,
      url: "https://www.discogs.com/release/1289-Daft-Punk-One-More-Time",
      content: "Daft Punk – One More Time, 12-inch single, Virgin, 2000.",
    };
    const net = stubFetch((call) =>
      call.url === TAVILY
        ? json(answer([...pages.map((url) => ({ ...WHOSAMPLED, url })), RELEASE, WHOSAMPLED]))
        : undefined,
    );

    const text = await searchSamples.invoke({
      songTitle: "Ice Ice Baby",
      artistName: "Vanilla Ice",
    });

    expect(JSON.parse(text).results.map((r: { url: string }) => r.url)).toEqual([
      RELEASE.url,
      WHOSAMPLED.url,
    ]);
    const excluded: string[] = JSON.parse(net.calls[0].body ?? "{}").exclude_domains;
    expect(excluded).toEqual(
      expect.arrayContaining([
        "quora.com",
        "gearspace.com",
        "quora-com.translate.goog",
        "gearspace-com.translate.goog",
      ]),
    );
    // Discogs is a primary source: only its forum pages are left out, by path.
    expect(excluded).not.toContain("discogs.com");
    for (const url of pages) expect(isSocialPage(url), url).toBe(true);
    for (const url of [
      "https://www.discogs.com/master/1289-Daft-Punk-One-More-Time",
      "https://www.discogs.com/artist/1289-Daft-Punk",
      "https://www.discogs.com/de/release/1289-Daft-Punk-One-More-Time",
      "https://www.discogs.com/release/1289-forum-edition",
    ]) {
      expect(isSocialPage(url), url).toBe(false);
    }
  });

  it("excludes Gearspace's former host and Hacker News' search, on any subdomain or translate proxy", async () => {
    const pages = [
      "https://gearslutz.com/board/so-much-gear-so-little-time/123-daft-punk-vocoder.html",
      "https://www.gearslutz.com/board/electronic-music-instruments/456-one-more-time.html",
      "https://gearslutz-com.translate.goog/board/123-daft-punk.html",
      "https://hn.algolia.com/?q=daft+punk+one+more+time",
      "https://hn-algolia-com.translate.goog/?q=daft+punk",
    ];
    const net = stubFetch((call) =>
      call.url === TAVILY
        ? json(answer([...pages.map((url) => ({ ...WHOSAMPLED, url })), WHOSAMPLED]))
        : undefined,
    );

    const text = await searchSamples.invoke({
      songTitle: "Ice Ice Baby",
      artistName: "Vanilla Ice",
    });

    expect(JSON.parse(text).results.map((r: { url: string }) => r.url)).toEqual([WHOSAMPLED.url]);
    expect(JSON.parse(net.calls[0].body ?? "{}").exclude_domains).toEqual(
      expect.arrayContaining([
        "gearslutz.com",
        "hn.algolia.com",
        "gearslutz-com.translate.goog",
        "hn-algolia-com.translate.goog",
      ]),
    );
    for (const url of pages) expect(isSocialPage(url), url).toBe(true);
    expect(isSocialPage("https://www.algolia.com/doc/")).toBe(false);
  });

  it("leaves out Discogs' forum after an underscore locale or a doubled slash, and keeps its releases", () => {
    for (const url of [
      "https://www.discogs.com/pt_BR/forum/thread/123456",
      "https://www.discogs.com/zh_CN/group/thread/654321",
      "https://www.discogs.com//forum/thread/123456",
      "https://www.discogs.com/pt_BR//forum/thread/123456",
    ]) {
      expect(isSocialPage(url), url).toBe(true);
    }
    for (const url of [
      "https://www.discogs.com/pt_BR/release/1289-Daft-Punk-One-More-Time",
      "https://www.discogs.com//release/1289-Daft-Punk-One-More-Time",
      "https://www.discogs.com/zh_CN/master/1289-forum",
    ]) {
      expect(isSocialPage(url), url).toBe(false);
    }
  });

  it.each([
    ["spaces", `share${" ".repeat(40_000)}x`],
    ["tabs, no-break spaces and newlines", `share${"\t\u00a0\n ".repeat(10_000)}x`],
    ["spaces around a pipe", `share${" ".repeat(20_000)}|${" ".repeat(19_993)}x`],
    ["spaces before cite", `share | cite${" ".repeat(40_000)}x`],
  ])("checks a stored text of 40,000 characters of %s in linear time", (_name, text) => {
    expect(text.length).toBeGreaterThanOrEqual(40_000);
    const start = performance.now();
    expect(webTextIssue(text)).toBeNull();
    expect(performance.now() - start).toBeLessThan(50);
  });

  it("counts a forum quote only when its expander follows the quote closely", () => {
    const story = " One More Time opened Discovery and topped the French chart.".repeat(7);
    // An interview: a quote, a long story, a panel, then a quote right before another panel.
    const article = `Bangalter said: 'We wanted it to feel like a party.'${story} Tracklist Click to expand... Pharrell said: 'we jammed.' Credits Click to expand...`;
    // A thread: each quote right before its expander.
    const thread = `${story} RecordFan said: The vocal. Click to expand... DiscoHead said: The drop. Click to expand...`;

    expect(article.length).toBeLessThanOrEqual(800);
    expect(webTextIssue(article)).toBeNull();
    expect(webTextIssue(thread)).toBe("a comment thread");
  });

  it("excludes forums whose pages are threads, on any subdomain or translate proxy, and KVR's and Steve Hoffman's forums by path", async () => {
    const pages = [
      "https://forums.stevehoffman.tv/threads/daft-punk-discovery.123456/",
      "https://forums-stevehoffman-tv.translate.goog/threads/daft-punk.123456/",
      "https://www.stevehoffman.tv/forums/threads/daft-punk-discovery.123456/",
      "https://www.metafilter.com/190000/Daft-Punk-split",
      "https://music.metafilter.com/1234/One-More-Time-cover",
      "https://ask.metafilter.com/350000/What-does-One-More-Time-sample",
      "https://www-metafilter-com.translate.goog/190000/Daft-Punk-split",
      "https://music.stackexchange.com/questions/12345/what-does-one-more-time-sample",
      "https://music-stackexchange-com.translate.goog/questions/12345/",
      "https://translate.google.com/translate?u=https://music.stackexchange.com/questions/12345",
      "https://www.ilxor.com/ILX/ThreadSelectedControllerServlet?boardid=41&threadid=12345",
      "https://www.elektronauts.com/t/daft-punk-vocoder/12345",
      "https://www.modwiggler.com/forum/viewtopic.php?t=12345",
      "https://www.muffwiggler.com/forum/viewtopic.php?t=12345",
      "https://www.kvraudio.com/forum/viewtopic.php?t=12345",
      "https://www-kvraudio-com.translate.goog/forum/viewtopic.php?t=12345",
    ];
    const net = stubFetch((call) =>
      call.url === TAVILY
        ? json(answer([...pages.map((url) => ({ ...WHOSAMPLED, url })), WHOSAMPLED]))
        : undefined,
    );

    const text = await searchSamples.invoke({
      songTitle: "Ice Ice Baby",
      artistName: "Vanilla Ice",
    });

    expect(JSON.parse(text).results.map((r: { url: string }) => r.url)).toEqual([WHOSAMPLED.url]);
    const excluded: string[] = JSON.parse(net.calls[0].body ?? "{}").exclude_domains;
    expect(excluded).toEqual(
      expect.arrayContaining([
        "forums.stevehoffman.tv",
        "metafilter.com",
        "stackexchange.com",
        "ilxor.com",
        "elektronauts.com",
        "modwiggler.com",
        "muffwiggler.com",
        "forums-stevehoffman-tv.translate.goog",
        "metafilter-com.translate.goog",
        "stackexchange-com.translate.goog",
      ]),
    );
    // KVR's product pages and the rest of stevehoffman.tv are not forums: left out by path only.
    for (const name of ["kvraudio.com", "stevehoffman.tv"]) expect(excluded).not.toContain(name);
    for (const url of pages) expect(isSocialPage(url), url).toBe(true);
    for (const url of [
      "https://www.kvraudio.com/product/vocoder-by-some-company",
      "https://www.kvraudio.com/news/daft-punk-vocoder-12345",
      "https://www.stevehoffman.tv/",
      "https://www.notmetafilter.com/daft-punk",
      "https://www.mystackexchange.com/music",
    ]) {
      expect(isSocialPage(url), url).toBe(false);
    }
  });

  it("masks every @handle in a result's text and title", async () => {
    const page = {
      ...WHOSAMPLED,
      title: "Interview with @vanillaice",
      content: "Rob Van Winkle (@vanillaice) recorded it in 1989.",
    };
    stubFetch((call) => (call.url === TAVILY ? json(answer([page])) : undefined));

    const text = await searchSamples.invoke({
      songTitle: "Ice Ice Baby",
      artistName: "Vanilla Ice",
    });

    expect(JSON.parse(text).results).toEqual([
      {
        title: "Interview with @…",
        url: WHOSAMPLED.url,
        content: "Rob Van Winkle (@…) recorded it in 1989.",
      },
    ]);
  });

  it("leaves out Tumblr and fb.com, and sends no short or suffix-ambiguous name in the request", async () => {
    const pages = [
      "https://www.tumblr.com/daftpunkfan/123",
      "https://daftpunkfan.tumblr.com/post/1",
      "https://fb.com/daftpunk",
      "https://x.com/someone/status/1",
      "https://t.co/abc123",
    ];
    const net = stubFetch((call) =>
      call.url === TAVILY
        ? json(answer([...pages.map((url) => ({ ...WHOSAMPLED, url })), WHOSAMPLED]))
        : undefined,
    );

    const text = await searchSamples.invoke({
      songTitle: "Ice Ice Baby",
      artistName: "Vanilla Ice",
    });

    expect(JSON.parse(text).results.map((r: { url: string }) => r.url)).toEqual([WHOSAMPLED.url]);
    const excluded: string[] = JSON.parse(net.calls[0].body ?? "{}").exclude_domains;
    expect(excluded).toEqual(expect.arrayContaining(["tumblr.com", "tumblr-com.translate.goog"]));
    for (const name of ["x.com", "t.co", "fb.com", "x-com.translate.goog", "t-co.translate.goog"]) {
      expect(excluded, name).not.toContain(name);
    }
    // Hosts that only end like a short name are not social pages.
    for (const url of ["https://www.vox.com/a", "https://www.complex.com/b", "https://kfb.com/c"]) {
      expect(isSocialPage(url), url).toBe(false);
    }
  });

  it("replays a result cut at 800 characters as it was live, also when the cut lands on a space", async () => {
    const head = `${"x".repeat(10)} ${"Daft Punk recorded One More Time in Paris. ".repeat(20)}`;
    const content = `${head.slice(0, 799)} and the rest of the page goes on for a while.`;
    expect(content[799]).toBe(" ");
    const page = { ...WHOSAMPLED, content };
    const run = await recordThenReplay(
      (call) => (call.url === TAVILY ? json(answer([page])) : undefined),
      () => searchSamples.invoke({ songTitle: "Ice Ice Baby", artistName: "Vanilla Ice" }),
    );

    expect(run.replayCalls).toBe(0);
    expect(run.replayed).toEqual(run.live);
  });

  it("records only what it keeps: no social page or handle reaches a cassette", async () => {
    const page = {
      ...WHOSAMPLED,
      content: "Rob Van Winkle (@vanillaice) recorded it in 1989.",
    };
    const instagram = {
      ...WHOSAMPLED,
      url: "https://www.instagram.com/p/abc123/",
      content: "SOCIAL_TEXT",
    };
    const thread = {
      ...WHOSAMPLED,
      url: "https://example.org/post/1",
      content: "some_one's profile picture some_one 2w Love it",
    };
    const run = await recordThenReplay(
      (call) => (call.url === TAVILY ? json(answer([instagram, thread, page])) : undefined),
      () => searchSamples.invoke({ songTitle: "Ice Ice Baby", artistName: "Vanilla Ice" }),
    );

    expect(run.replayCalls).toBe(0);
    expect(run.replayed).toEqual(run.live);
    const cassette = run.cassettes.tavily;
    expect(cassette).toContain("recorded it in 1989");
    expect(cassette).not.toContain("instagram.com");
    expect(cassette).not.toContain("profile picture");
    expect(cassette).not.toContain("@vanillaice");
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

    expect(JSON.parse(text)).toEqual({ found: false, reason: "no_results" });
    expect(readToolResult("tavily", text)).toEqual({ kind: "none", reason: "no_results" });
  });

  it.each([
    [
      "an HTTP error",
      () => json({ detail: { error: "Unauthorized: invalid API key" } }, { status: 401 }),
      "unavailable",
    ],
    ["an HTML answer", () => html("<html>bad gateway</html>"), "unavailable"],
    ["a body without results", () => json({ detail: "something else" }), "invalid_response"],
  ])("%s is a failure with its code that the researcher drops", async (_name, reply, code) => {
    stubFetch((call) => (call.url === TAVILY ? reply() : undefined));

    const text = await searchSamples.invoke({
      songTitle: "Ice Ice Baby",
      artistName: "Vanilla Ice",
    });

    expect(JSON.parse(text)).toMatchObject({ found: false, code });
    expect(researcherKeeps(text)).toBe(false);
    expect(readToolResult("tavily", text)).toMatchObject({
      kind: "failed",
      error: { source: "tavily", code },
    });
  });

  it.each([401, 403])("HTTP %s is a rejected key, reported as such", async (status) => {
    stubFetch((call) =>
      call.url === TAVILY ? json({ detail: { error: "Unauthorized" } }, { status }) : undefined,
    );

    const text = await searchSamples.invoke({
      songTitle: "Ice Ice Baby",
      artistName: "Vanilla Ice",
    });

    expect(JSON.parse(text)).toMatchObject({
      found: false,
      code: "unavailable",
      keyRejected: true,
      source: "tavily",
      error: expect.stringMatching(/^Tavily rejected the API key/),
    });
    expect(readToolResult("tavily", text)).toMatchObject({ kind: "failed", keyRejected: true });
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
