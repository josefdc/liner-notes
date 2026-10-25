/**
 * The research plan of a run (research/plan.ts), end to end with every source stubbed at the
 * network and the model faked: with the track's ISRC, each source is asked once (one ISRC
 * lookup for the historian, the researcher and the composer; Last.fm once; SecondHandSongs,
 * Discogs and Genius once; the web search as planned), the planner adds at most two steps on the
 * fast tier and never repeats one, and no placeholder is kept as research or evidence. Without
 * an ISRC the research is asked by name, bounded the same way.
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
const cache = vi.hoisted(() => ({ putResearch: vi.fn() }));
vi.mock("../../store/cache.js", () => ({
  getCache: () => ({
    getAudio: () => null,
    putAudio: () => {},
    getResearch: () => null,
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
import { MusicBrainzRateLimiter } from "../../sources/musicbrainz.js";
import {
  type FetchCall,
  type FetchRoute,
  json,
  stubFetch,
} from "../../sources/testing/fetchStub.js";
import { primaryRoute } from "../../sources/testing/iceIceBaby.js";
import { buildSonicAgentGraph } from "../graph.js";
import type { TrackData } from "../schema.js";
import { type ResearchData, mergeResearch, emptyResearch } from "../state.js";
import { messagesOf, type StubCall, stubLlm, testRuntime } from "../testing/stubLlm.js";
import { isPlaceholder, lastfmBio, MAX_FOLLOW_UPS } from "./plan.js";

const MB = "https://musicbrainz.org/ws/2";
const LASTFM = "https://ws.audioscrobbler.com/2.0/";
const TAVILY = "https://api.tavily.com/search";
const LISTENBRAINZ = "https://labs.api.listenbrainz.org/similar-artists/json";
/** The recording the ISRC identifies, and the artist it credits. */
const RECORDING = "875c24bc-fe9e-4ac6-80d3-beaacb70ee43";
const ARTIST = "2d5583be-aafd-41ec-addd-df85913855ef";
/** A web result that is only a placeholder: never research, never evidence. */
const EMPTY_PAGE = "https://example.test/search?q=ice";

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
      ],
    });
  }
  if (call.url.startsWith(`${LISTENBRAINZ}?`)) {
    return json([
      { artist_mbid: "5e1e2d3c-0000-4000-8000-000000000001", name: "MC Hammer", score: 900 },
    ]);
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
  return primaryRoute(call);
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
 * of every source, and what it kept.
 */
async function runPlan(picks: ResearchAction[]) {
  let step = 0;
  const llm = stubLlm((call: StubCall) => {
    if (call.callSite !== "research_planner") return COMPOSED;
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
  const planner = llm.calls.filter((c) => c.callSite === "research_planner");
  const composer = llm.calls.find((c) => c.callSite === "composer");
  return { trackData, research, status, asked, lastfmMethods, planner, composer };
}

/** How often each item of `list` occurs. */
const counts = (list: ReadonlyArray<string | null>) => {
  const out: Record<string, number> = {};
  for (const item of list) out[String(item)] = (out[String(item)] ?? 0) + 1;
  return out;
};

describe("the research plan of a track with an ISRC", () => {
  it("asks every source once, and the planner adds at most two steps on the fast tier", async () => {
    // The planner picks two steps the plan already ran: neither is asked again.
    const run = await runPlan(["search_lastfm_tags", "search_musicbrainz"]);

    // One ISRC lookup in the run: the historian's chain, passed to the researcher and the
    // composer. No MusicBrainz request is made twice, and none searches by name.
    expect(run.asked(`${MB}/isrc/`)).toHaveLength(1);
    const mb = run.asked(MB).map((c) => c.url);
    expect(new Set(mb).size).toBe(mb.length);
    expect(mb.some((url) => /[?&]query=/.test(url))).toBe(false);
    // Last.fm once: the track's tags, the artist's tags, the similar tracks.
    expect(counts(run.lastfmMethods)).toEqual({
      "track.getTopTags": 1,
      "artist.getTopTags": 1,
      "track.getSimilar": 1,
    });
    // SecondHandSongs, Discogs and Genius (both configured) from the chain, once each.
    expect(run.asked("https://secondhandsongs.com/")).toHaveLength(1);
    const discogs = run.asked("https://api.discogs.com/").map((c) => c.url);
    expect(discogs.length).toBeGreaterThan(0);
    expect(new Set(discogs).size).toBe(discogs.length);
    expect(run.asked("https://api.genius.com/search?")).toHaveLength(1);
    // The web search as planned: the sample history, once.
    expect(run.asked(TAVILY)).toHaveLength(1);

    expect(run.planner.length).toBeLessThanOrEqual(MAX_FOLLOW_UPS);
    for (const call of run.planner) expect(call.tier).toBe("fast");
    // The planner is told what already ran and is offered only what did not.
    const prompt = messagesOf(run.planner[0]).user;
    const choices = prompt.split("Steps you can choose:\n")[1]?.split("\n")[0] ?? "";
    for (const ran of [
      "search_lastfm_tags",
      "search_lastfm_similar_tracks",
      "search_musicbrainz",
    ]) {
      expect(choices).not.toContain(ran);
    }
    expect(choices).toContain("search_production");
    expect(run.status).toContain(
      "⏭️ Not asked again: lastfm tags (read once at the start of the research)",
    );

    // The composer gets the recording the chain identified, without a lookup of its own.
    const { user } = messagesOf(run.composer as StubCall);
    expect(user).toContain(`"mbid":"${RECORDING}"`);
    expect(user).toContain('"firstReleaseDate":"1990-09-04"');
    expect(run.trackData?.evidence?.some((e) => e.source === "discogs")).toBe(true);
    expect(run.trackData?.evidence?.some((e) => e.source === "genius")).toBe(true);
  });

  it("keeps no placeholder as research or evidence", async () => {
    const run = await runPlan(["search_lastfm_artist_info"]);

    // The web result that is only "No results found." is neither research nor evidence.
    const samples = run.research?.samples ?? [];
    expect(samples.join("\n")).toContain("Under Pressure");
    expect(samples.join("\n")).not.toContain("No results found");
    expect(run.trackData?.evidence?.some((e) => e.url === EMPTY_PAGE)).toBe(false);
    // A bio that is only Last.fm's "Read more" link is no bio.
    expect(run.research?.lastfmArtistBio).toBeUndefined();
    expect(JSON.stringify(run.research)).not.toContain("Read more on Last.fm");
    // The artist's tags once: "Hip-Hop" and "rap" were read already.
    expect(run.research?.lastfmArtistTags).toEqual(["rap (80)"]);
    expect(run.research?.lastfmTags).toEqual(["hip-hop (100)", "new jack swing (60)"]);
    expect(counts(run.lastfmMethods)["artist.getInfo"]).toBe(1);
  });

  it("asks artist-level steps about the artist the recording credits, by its MBID", async () => {
    const run = await runPlan(["search_listenbrainz_similar", "search_artist_collaborators"]);

    const listenbrainz = run.asked(LISTENBRAINZ);
    expect(listenbrainz).toHaveLength(1);
    expect(new URL(listenbrainz[0].url).searchParams.get("artist_mbids")).toBe(ARTIST);
    // No artist search by name: the one artist request is the credited artist's lookup.
    const artist = run.asked(`${MB}/artist`).map((c) => new URL(c.url).pathname);
    expect(artist).toEqual([`/ws/2/artist/${ARTIST}`]);
    expect(run.research?.listenbrainzSimilarArtists?.[0]).toMatch(/^1\. MC Hammer \(similar to /);
  });
});

describe("the research plan of a track without an ISRC", () => {
  it("asks by name, Last.fm still once and the planner bounded the same way", async () => {
    track.isrc = null;
    const run = await runPlan(["search_lastfm_similar_tracks", "search_production"]);

    expect(run.asked(`${MB}/isrc/`)).toHaveLength(0);
    expect(counts(run.lastfmMethods)).toEqual({
      "track.getTopTags": 1,
      "artist.getTopTags": 1,
      "track.getSimilar": 1,
    });
    expect(run.planner.length).toBeLessThanOrEqual(MAX_FOLLOW_UPS);
    for (const call of run.planner) expect(call.tier).toBe("fast");
    // The name search of MusicBrainz is offered: no recording was identified.
    const prompt = messagesOf(run.planner[0]).user;
    expect(prompt.split("Steps you can choose:\n")[1]?.split("\n")[0]).toContain(
      "search_musicbrainz",
    );
    // The sample history, then the planner's production search.
    expect(run.asked(TAVILY)).toHaveLength(2);
  });
});

describe("placeholders", () => {
  it.each([
    "",
    "   ",
    "No results found.",
    "Nothing found",
    "No data available",
    "N/A",
    "Web search is not available (TAVILY_API_KEY is not set)",
    "[MusicBrainz Samples] []",
  ])("%j is a placeholder", (text) => {
    expect(isPlaceholder(text)).toBe(true);
  });

  it.each([
    "No Woman, No Cry was released by Bob Marley and the Wailers in 1974 on Natty Dread.",
    "hip-hop (100)",
    "1. MC Hammer (Last.fm match 1.00, relative to its closest match = 1)",
  ])("%j is research", (text) => {
    expect(isPlaceholder(text)).toBe(false);
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
});
