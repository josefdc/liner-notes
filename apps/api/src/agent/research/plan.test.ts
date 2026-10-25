/**
 * The research plan of a run (research/plan.ts), end to end with every source stubbed at the
 * network and the model faked: with the track's ISRC, every source is asked exactly once, with
 * no model choosing (one ISRC lookup for the historian, the researcher and the composer; each
 * Last.fm request once; SecondHandSongs, Discogs and Genius; the credited artist's ListenBrainz
 * similar artists and MusicBrainz collaborators by its MBID; the web searches as planned), the
 * planner adds at most two steps on the fast tier and never repeats one, and no placeholder or
 * error page is kept as research or evidence. Without an ISRC the research is asked by name,
 * bounded the same way.
 */

import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import type { ResearchAction } from "@liner-notes/contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const track = vi.hoisted(() => ({
  id: "3Fcfwhm8oRrBvBZ8KGhtea",
  title: "Ice Ice Baby",
  artist: "Vanilla Ice",
  artistIds: ["7GaxyUddsPok8BuhxN6OUW"],
  album: "To the Extreme",
  releaseDate: "1990-09-10",
  coverUrl: "https://i.scdn.co/image/x",
  duration: "4:31",
  durationMs: 271_733,
  explicit: false,
  isrc: "USCA29001716" as string | null,
  spotifyUrl: "https://open.spotify.com/track/3Fcfwhm8oRrBvBZ8KGhtea",
  previewUrl: null,
}));
vi.mock("../../sources/spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sources/spotify.js")>()),
  searchTracks: async () => [track],
}));
vi.mock("../../sources/audio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sources/audio.js")>()),
  analyzeAudioPreview: {
    invoke: async () => JSON.stringify({ source: "unavailable", reason: "no_preview" }),
  },
}));
const cache = vi.hoisted(() => ({ putResearch: vi.fn(), research: null as unknown }));
vi.mock("../../store/cache.js", () => ({
  getCache: () => ({
    getAudio: () => null,
    putAudio: () => {},
    getResearch: () => cache.research,
    putResearch: cache.putResearch,
  }),
}));
vi.mock("../enricher.js", () => ({
  enrichGenealogyWithArtwork: async (genealogy: unknown) => genealogy,
}));

import geniusSearch from "../../sources/fixtures/genius-search-ice-ice-baby.json" with {
  type: "json",
};
import geniusSong from "../../sources/fixtures/genius-song-ice-ice-baby.json" with { type: "json" };
import { LlmError } from "../../llm/errors.js";
import { MusicBrainzRateLimiter } from "../../sources/musicbrainz.js";
import {
  type FetchCall,
  type FetchRoute,
  json,
  stubFetch,
} from "../../sources/testing/fetchStub.js";
import { ICE_ARTIST, runRoute } from "../../sources/testing/iceIceBaby.js";
import { buildSonicAgentGraph } from "../graph.js";
import type { TrackData } from "../schema.js";
import { emptyResearch, mergeResearch, type ResearchData } from "../state.js";
import { messagesOf, type StubCall, stubLlm, testRuntime } from "../testing/stubLlm.js";
import { webSearchEvidence } from "./evidencePack.js";
import { isErrorPage, isPlaceholder, lastfmBio } from "./plan.js";

const MB = "https://musicbrainz.org/ws/2";
const LASTFM = "https://ws.audioscrobbler.com/2.0/";
const TAVILY = "https://api.tavily.com/search";
const LISTENBRAINZ = "https://labs.api.listenbrainz.org/similar-artists/json";
/** The recording the ISRC identifies, and the artist it credits. */
const RECORDING = "875c24bc-fe9e-4ac6-80d3-beaacb70ee43";
const ARTIST = ICE_ARTIST;
/** Web results that are a placeholder and an error page: never research, never evidence. */
const EMPTY_PAGE = "https://example.test/search?q=ice";
const ERROR_PAGE = "https://example.test/gone";

const attr = { "@attr": { artist: "Vanilla Ice", track: "Ice Ice Baby" } };
const lastfm: Record<string, unknown> = {
  "track.getTopTags": {
    toptags: {
      tag: [
        { name: "hip-hop", count: 100 },
        { name: "new jack swing", count: 60 },
      ],
      ...attr,
    },
  },
  "artist.getTopTags": {
    toptags: {
      tag: [
        { name: "hip-hop", count: 100 },
        { name: "rap", count: 80 },
      ],
      ...attr,
    },
  },
  "track.getSimilar": {
    similartracks: {
      track: [{ name: "U Can't Touch This", artist: { name: "MC Hammer" }, match: 1 }],
      ...attr,
    },
  },
  "artist.getSimilar": {
    similarartists: { artist: [{ name: "MC Hammer", match: 1 }], ...attr },
  },
  "artist.getInfo": {
    artist: {
      name: "Vanilla Ice",
      // Last.fm's bio for an artist it has none for: only its "Read more" link.
      bio: { summary: ' <a href="https://www.last.fm/music/Vanilla+Ice">Read more on Last.fm</a>' },
      tags: {
        tag: [
          { name: "Hip-Hop", count: 100 },
          { name: "rap", count: 80 },
        ],
      },
      similar: { artist: [{ name: "MC Hammer" }] },
    },
  },
};

/** Every source of the run: MusicBrainz and SecondHandSongs, Discogs, Genius, Last.fm, the web. */
function route(call: FetchCall): ReturnType<FetchRoute> {
  if (call.url.startsWith(LASTFM)) {
    const method = new URL(call.url).searchParams.get("method") ?? "";
    return method in lastfm ? json(lastfm[method]) : undefined;
  }
  if (call.url === TAVILY) {
    return json({
      results: [
        {
          title: "Ice Ice Baby samples",
          url: "https://example.test/ice-ice-baby",
          content: "The bass line comes from Under Pressure by Queen and David Bowie.",
        },
        { title: "Search", url: EMPTY_PAGE, content: "No results found." },
        { title: "404 Not Found", url: ERROR_PAGE, content: "The requested URL was not found." },
      ],
    });
  }
  if (call.url === "https://api.discogs.com/releases/599648") {
    return json({
      id: 599648,
      title: "To the Extreme",
      year: 1990,
      artists: [{ id: 1, name: "Vanilla Ice", anv: "", join: "" }],
      extraartists: [{ id: 2, name: "Test Engineer", anv: "", role: "Engineer", tracks: "1" }],
      tracklist: [{ position: "1", type_: "track", title: "Ice Ice Baby", duration: "4:31" }],
    });
  }
  if (call.url.startsWith("https://api.discogs.com/releases/")) {
    return json({ id: 1, title: "Other", tracklist: [] });
  }
  if (call.url.startsWith("https://api.genius.com/search?")) return json(geniusSearch);
  if (call.url === "https://api.genius.com/songs/9000001") return json(geniusSong);
  return runRoute(call);
}

let restoreInterval: () => void;
beforeAll(() => {
  restoreInterval = MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
});
afterAll(() => restoreInterval());

let net: ReturnType<typeof stubFetch>;
const KEYS = {
  LASTFM_API_KEY: "lastfm-test-key-0123456789",
  TAVILY_API_KEY: "tavily-test-key-0123456789",
  DISCOGS_TOKEN: "discogs-test-token-0123456789",
  GENIUS_ACCESS_TOKEN: "genius-test-token-0123456789",
};
beforeEach(() => {
  for (const name of ["SHS_API_KEY", "SOURCE_CASSETTE"]) delete process.env[name];
  for (const [name, value] of Object.entries(KEYS)) vi.stubEnv(name, value);
  track.isrc = "USCA29001716";
  net = stubFetch(route);
  cache.putResearch.mockClear();
  cache.research = null;
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const COMPOSED = {
  claims: [],
  factoids: [],
  genealogyNodes: [
    {
      id: "current",
      role: "current",
      label: "Ice Ice Baby",
      trackTitle: null,
      trackArtist: null,
      year: null,
    },
  ],
  genealogyLinks: [],
};

/**
 * One run of the whole graph whose planner picks `picks` in order (then "done"); what it asked
 * of every source, and what it kept. `composerFails`: the composer's model call fails.
 */
async function runPlan(picks: ResearchAction[], options: { composerFails?: boolean } = {}) {
  let step = 0;
  const llm = stubLlm((call: StubCall) => {
    if (call.callSite !== "research_planner") {
      if (options.composerFails) throw new LlmError("provider", "composer: provider down");
      return COMPOSED;
    }
    const nextAction = picks[step++] ?? "done";
    const query = nextAction.startsWith("search_") && /samples|production|general/.test(nextAction);
    return {
      nextAction,
      query: query ? "Ice Ice Baby Vanilla Ice history" : null,
      reasoning: `pick ${nextAction}`,
    };
  });
  const graph = buildSonicAgentGraph({
    runtime: testRuntime(llm, "2026-10-20T12:00:00.000Z"),
    checkpointer: new MemorySaver(),
    store: new InMemoryStore(),
  });
  let trackData: TrackData | null = null;
  const status: string[] = [];
  const stream = await graph.stream(
    { songQuery: "Ice Ice Baby Vanilla Ice" },
    { configurable: { thread_id: "run-plan" }, streamMode: ["updates", "custom"] },
  );
  let research: ResearchData | null = null;
  for await (const [mode, chunk] of stream as AsyncIterable<[string, unknown]>) {
    if (mode === "custom") {
      const event = chunk as { type: string; message?: string };
      if (event.type === "status") status.push(event.message ?? "");
      continue;
    }
    for (const update of Object.values(chunk as Record<string, unknown>)) {
      const node = (update ?? {}) as { trackData?: TrackData; researchData?: ResearchData };
      if (node.trackData) trackData = node.trackData;
      if (node.researchData) research = node.researchData;
    }
  }
  const asked = (prefix: string) => net.calls.filter((c) => c.url.startsWith(prefix));
  const lastfmMethods = asked(LASTFM).map((c) => new URL(c.url).searchParams.get("method"));
  const tavilyQueries = asked(TAVILY).map((c) => JSON.parse(c.body ?? "{}").query as string);
  const planner = llm.calls.filter((c) => c.callSite === "research_planner");
  const composer = llm.calls.find((c) => c.callSite === "composer");
  return { trackData, research, status, asked, lastfmMethods, tavilyQueries, planner, composer };
}

/** How often each item of `list` occurs. */
const counts = (list: ReadonlyArray<string | null>) => {
  const out: Record<string, number> = {};
  for (const item of list) out[String(item)] = (out[String(item)] ?? 0) + 1;
  return out;
};

/** Every request type of the run just made, each with how often it was made. */
function requestsOf() {
  return counts(
    net.calls.map((c) => {
      const url = new URL(c.url);
      if (c.url.startsWith(LASTFM)) return `lastfm ${url.searchParams.get("method")}`;
      if (c.url === TAVILY) return `tavily ${JSON.parse(c.body ?? "{}").query}`;
      return `${url.host}${url.pathname}${url.pathname === "/ws/2/recording" ? url.search : ""}`;
    }),
  );
}

describe("the research plan of a track with an ISRC", () => {
  it("asks every source exactly once with no model choosing", async () => {
    // The planner adds nothing: the fixed plan alone.
    const run = await runPlan([]);

    const requests = requestsOf();
    // Every request type of the run is made once.
    for (const [request, n] of Object.entries(requests)) expect(n, request).toBe(1);
    const has = (start: string) => Object.keys(requests).filter((r) => r.startsWith(start));
    // MusicBrainz: one ISRC lookup (the historian's chain, passed to the researcher and the
    // composer), the recording, the work and its dating, the releases (Discogs is configured),
    // and the credited artist's collaborators by its MBID. No name search.
    expect(has("musicbrainz.org/ws/2/isrc/")).toHaveLength(1);
    expect(has(`musicbrainz.org/ws/2/artist/${ARTIST}`)).toHaveLength(1);
    expect(has("musicbrainz.org/ws/2/artist").length).toBe(1);
    expect(net.calls.some((c) => /[?&]query=/.test(c.url))).toBe(false);
    expect(has("musicbrainz.org/ws/2/release")).toHaveLength(1);
    // SecondHandSongs, Discogs and Genius from the chain.
    expect(has("secondhandsongs.com/")).toHaveLength(1);
    expect(has("api.discogs.com/releases/").length).toBeGreaterThan(0);
    expect(has("api.genius.com/search")).toHaveLength(1);
    // Last.fm: each request once, the artist's tags by the artist's MusicBrainz id.
    expect(counts(run.lastfmMethods)).toEqual({
      "track.getTopTags": 1,
      "artist.getTopTags": 1,
      "track.getSimilar": 1,
    });
    const artistTags = run.asked(LASTFM).find((c) => c.url.includes("artist.getTopTags"));
    expect(new URL(artistTags?.url ?? "").searchParams.get("mbid")).toBe(ARTIST);
    expect(new URL(artistTags?.url ?? "").searchParams.has("artist")).toBe(false);
    // ListenBrainz by the artist's MBID.
    const listenbrainz = run.asked(LISTENBRAINZ);
    expect(listenbrainz).toHaveLength(1);
    expect(new URL(listenbrainz[0].url).searchParams.get("artist_mbids")).toBe(ARTIST);
    // The web searches as planned: the sample history and the production history.
    expect(run.tavilyQueries).toHaveLength(2);
    expect(run.tavilyQueries.some((q) => /sampl/i.test(q))).toBe(true);
    expect(run.tavilyQueries.some((q) => /produc/i.test(q))).toBe(true);

    // One planner call, which chose to stop, on the fast tier.
    expect(run.planner).toHaveLength(1);
    expect(run.planner[0].tier).toBe("fast");
    // The status counts the steps that ran: the four fixed ones.
    expect(run.status).toContain("Intelligence extraction complete: 4 layers processed");
    // The research holds what they found.
    expect(run.research?.collaborators).toEqual(["Earthquake (supporting musician)"]);
    expect(run.research?.listenbrainzSimilarArtists?.[0]).toMatch(/^1\. MC Hammer \(similar to /);

    // The composer gets the recording the chain identified, without a lookup of its own.
    const { user } = messagesOf(run.composer as StubCall);
    expect(user).toContain(`"mbid":"${RECORDING}"`);
    expect(user).toContain('"firstReleaseDate":"1990-09-04"');
    expect(run.trackData?.evidence?.some((e) => e.source === "discogs")).toBe(true);
    expect(run.trackData?.evidence?.some((e) => e.source === "genius")).toBe(true);
  });

  it("offers the planner none of the fixed steps, and adds at most two steps", async () => {
    // Three picks, each a step the plan already ran: none is asked again, and the planner is
    // called twice.
    const run = await runPlan([
      "search_listenbrainz_similar",
      "search_lastfm_tags",
      "search_production",
    ]);

    expect(run.planner).toHaveLength(2);
    for (const call of run.planner) expect(call.tier).toBe("fast");
    for (const [request, n] of Object.entries(requestsOf())) expect(n, request).toBe(1);
    const prompt = messagesOf(run.planner[0]).user;
    const choices = prompt.split("Steps you can choose:\n")[1]?.split("\n")[0] ?? "";
    for (const ran of [
      "search_samples",
      "search_production",
      "search_musicbrainz",
      "search_artist_collaborators",
      "search_listenbrainz_similar",
      "search_lastfm_tags",
      "search_lastfm_similar_tracks",
    ]) {
      expect(choices).not.toContain(ran);
    }
    expect(choices).toContain("search_general");
    expect(run.status).toContain(
      "⏭️ Not asked again: listenbrainz similar (already ran in this research)",
    );
    // Skipped picks are not counted as steps that ran.
    expect(run.status).toContain("Intelligence extraction complete: 4 layers processed");
  });

  it("does not run a step the research itself ran again", async () => {
    const run = await runPlan(["search_general", "search_general"]);

    // The sample history, the production history and one lead: the second pick is not asked.
    expect(run.tavilyQueries).toHaveLength(3);
    expect(run.status).toContain("⏭️ Not asked again: general (already ran in this research)");
    expect(run.status).toContain("Intelligence extraction complete: 5 layers processed");
  });

  it("keeps no placeholder or error page as research or evidence", async () => {
    const run = await runPlan(["search_lastfm_artist_info"]);

    // The web results that are only "No results found." and a 404 page are neither.
    const samples = run.research?.samples ?? [];
    expect(samples.join("\n")).toContain("Under Pressure");
    expect(samples.join("\n")).not.toContain("No results found");
    expect(samples.join("\n")).not.toContain("404");
    for (const url of [EMPTY_PAGE, ERROR_PAGE]) {
      expect(run.trackData?.evidence?.some((e) => e.url === url)).toBe(false);
    }
    // A bio that is only Last.fm's "Read more" link is no bio.
    expect(run.research?.lastfmArtistBio).toBeUndefined();
    expect(JSON.stringify(run.research)).not.toContain("Read more on Last.fm");
    // The artist's tags once: "Hip-Hop" and "rap" were read already.
    expect(run.research?.lastfmArtistTags).toEqual(["rap (80)"]);
    expect(run.research?.lastfmTags).toEqual(["hip-hop (100)", "new jack swing (60)"]);
    expect(counts(run.lastfmMethods)["artist.getInfo"]).toBe(1);
    // Asked by the artist's MusicBrainz id too.
    const info = run.asked(LASTFM).find((c) => c.url.includes("artist.getInfo"));
    expect(new URL(info?.url ?? "").searchParams.get("mbid")).toBe(ARTIST);
  });

  it("says a Last.fm request that could not be read was not read, and does not ask it again", async () => {
    net = stubFetch((call) =>
      call.url.includes("method=track.getSimilar")
        ? new Response("busy", { status: 503 })
        : route(call),
    );
    const run = await runPlan(["search_lastfm_similar_tracks"]);

    const prompt = messagesOf(run.planner[0]).user;
    expect(prompt).toContain(
      "search_lastfm_similar_tracks: asked at the start of the research; Last.fm could not be read",
    );
    expect(prompt).toContain("search_lastfm_tags: asked once at the start of the research");
    expect(counts(run.lastfmMethods)["track.getSimilar"]).toBe(1);
  });

  it("gives the composer the recording on a research-cache hit, from the run's one ISRC lookup", async () => {
    cache.research = { samples: ["cached sample research"], productionTrivia: [] };
    const run = await runPlan([]);

    expect(run.planner).toHaveLength(0);
    expect(run.asked(`${MB}/isrc/`)).toHaveLength(1);
    const { user } = messagesOf(run.composer as StubCall);
    expect(user).toContain(`"mbid":"${RECORDING}"`);
    expect(user).toContain('"firstReleaseDate":"1990-09-04"');
  });

  it("keeps the recording's MusicBrainz samples for the result built without the model", async () => {
    const run = await runPlan([], { composerFails: true });

    expect(run.trackData?.modelUnavailable).toBe(true);
    const card = run.trackData?.factoids?.find((f) => f.title === "Sample DNA");
    expect(card?.content).toContain('"Under Pressure" by Queen & David Bowie');
    // Not cached with the research: the cache holds no primary record.
    expect(JSON.stringify(cache.putResearch.mock.calls)).not.toContain("[MusicBrainz Samples]");
  });
});

describe("the research plan of a track without an ISRC", () => {
  it("asks by name, each Last.fm request once and the planner bounded the same way", async () => {
    track.isrc = null;
    const run = await runPlan([
      "search_lastfm_similar_tracks",
      "search_production",
      "search_general",
    ]);

    expect(run.asked(`${MB}/isrc/`)).toHaveLength(0);
    expect(counts(run.lastfmMethods)).toEqual({
      "track.getTopTags": 1,
      "artist.getTopTags": 1,
      "track.getSimilar": 1,
    });
    // Not by an MBID: none is known.
    const artistTags = run.asked(LASTFM).find((c) => c.url.includes("artist.getTopTags"));
    expect(new URL(artistTags?.url ?? "").searchParams.get("artist")).toBe("Vanilla Ice");
    expect(run.planner).toHaveLength(2);
    for (const call of run.planner) expect(call.tier).toBe("fast");
    // The name search of MusicBrainz is offered: no recording was identified.
    const prompt = messagesOf(run.planner[0]).user;
    expect(prompt.split("Steps you can choose:\n")[1]?.split("\n")[0]).toContain(
      "search_musicbrainz",
    );
    // No fixed step needs an MBID: the sample history, then the planner's production search.
    expect(run.asked(LISTENBRAINZ)).toHaveLength(0);
    expect(run.tavilyQueries).toHaveLength(2);
  });
});

describe("placeholders", () => {
  it.each([
    "",
    "   ",
    "No results found.",
    'No results found for "Ice Ice Baby Vanilla Ice".',
    'No production history found for "Ice Ice Baby" by Vanilla Ice',
    "Nothing found",
    "Web search is not available. Please set TAVILY_API_KEY.",
    "Error searching: timeout",
    "[MusicBrainz Samples] []",
  ])("%j is a placeholder", (text) => {
    expect(isPlaceholder(text)).toBe(true);
  });

  it.each([
    "No Woman, No Cry was released by Bob Marley and the Wailers in 1974 on Natty Dread.",
    "No Woman, No Cry samples information",
    "Nothing Compares 2 U: sample data",
    "No data available",
    "[Intro]",
    "hip-hop (100)",
    "1. MC Hammer (Last.fm match 1.00, relative to its closest match = 1)",
  ])("%j is research", (text) => {
    expect(isPlaceholder(text)).toBe(false);
  });

  it.each([
    { title: "404 Not Found", content: "The requested URL was not found on this server." },
    { title: "Error 503: Service Unavailable", content: "Try again later." },
    { title: "Page not found | Example", content: "Sorry, we looked everywhere." },
    { title: "Just a moment...", content: "Checking your browser before accessing the site." },
    { title: "Example", content: "Please enable JavaScript to view this page." },
  ])("$title is an error page", (result) => {
    expect(isErrorPage(result)).toBe(true);
  });

  it.each([
    { title: "500 Miles - The Proclaimers", content: "The song was released in 1988." },
    { title: "Lost and Found", content: "A page about the album." },
    {
      title: "Ice Ice Baby",
      content: `The bass line comes from Under Pressure. ${"Long page text. ".repeat(20)} page not found`,
    },
  ])("$title is a page", (result) => {
    expect(isErrorPage(result)).toBe(false);
  });

  it("are never web evidence, even without the researcher's own filter", () => {
    const retrievedAt = "2026-10-20T12:00:00.000Z";
    const items = webSearchEvidence([
      { result: { title: "Search", url: EMPTY_PAGE, content: "No results found." }, retrievedAt },
      { result: { title: "404 Not Found", url: ERROR_PAGE, content: "Gone." }, retrievedAt },
      {
        result: { title: "Samples", url: "https://example.test/a", content: "Under Pressure." },
        retrievedAt,
      },
    ]);
    expect(items.map((e) => e.url)).toEqual(["https://example.test/a"]);
  });

  it("drops Last.fm's trailing link from a bio, and an empty bio", () => {
    expect(lastfmBio("Vanilla Ice is a rapper. Read more on Last.fm")).toBe(
      "Vanilla Ice is a rapper.",
    );
    expect(lastfmBio("Read more on Last.fm")).toBeNull();
  });

  it("are never kept when research is merged, and merging twice adds nothing", () => {
    const next: Partial<ResearchData> = {
      samples: ["No results found.", "Under Pressure is sampled."],
      lastfmTags: ["funk (10)", "Funk (12)"],
      lastfmSimilarTracks: ["1. A by B (Last.fm match 1.00, relative to its closest match = 1)"],
      lastfmArtistBio: "Read more on Last.fm",
    };
    const once = mergeResearch(emptyResearch(), next);
    expect(once.samples).toEqual(["Under Pressure is sampled."]);
    expect(once.lastfmTags).toEqual(["funk (10)"]);
    expect(once.lastfmArtistBio).toBeUndefined();
    expect(mergeResearch(once, once)).toEqual(once);
  });

  it("keep two similar artists of one name apart by their MusicBrainz ids", () => {
    const lines = [
      "1. Nirvana (similar to X; ListenBrainz co-listening score 900, higher is more similar, no fixed maximum, MusicBrainz 5b11f4ce-a62d-471e-81fc-a69a8278c7da)",
      "2. Nirvana (similar to X; ListenBrainz co-listening score 400, higher is more similar, no fixed maximum, MusicBrainz 9282c8b4-ca0b-4c6b-b7e3-4f7762dfc4d6)",
      "3. Nirvana (similar to X; ListenBrainz co-listening score 100, higher is more similar, no fixed maximum, MusicBrainz 5b11f4ce-a62d-471e-81fc-a69a8278c7da)",
    ];
    const merged = mergeResearch(emptyResearch(), { listenbrainzSimilarArtists: lines });
    expect(merged.listenbrainzSimilarArtists).toEqual(lines.slice(0, 2));
  });
});
