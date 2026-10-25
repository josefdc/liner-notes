/**
 * What the research reads from its sources, end to end: the real source tools over a stubbed
 * network, a stubbed research planner that records its prompts, and an in-memory research cache.
 *
 * - A tool's result is read by its type: a failure is a source error (named after the source
 *   that failed), an empty answer is "nothing found", and a step that was not asked or could not
 *   identify the track is "not asked", never "nothing found".
 * - An unavailable source (Last.fm without a key, Tavily down) is a source error, the status says
 *   it could not be read and the prompts say it was unavailable (never "0 tags").
 * - Similar artists and tracks are given by rank with their raw score and its scale, never as a
 *   percentage.
 * - Artist-level questions are about the track's own first artist: ListenBrainz and the
 *   collaborators step take its MBID from MusicBrainz (the recording's credit, or the artist
 *   search by exact name, told apart from artists of the same name by its Spotify link), never
 *   from a similar artist and never the first of several homonyms; Last.fm gets that artist and
 *   the title without a featured-artist note, never the joined Spotify string.
 * - The research cache: v3 keys naming the configured sources; a missing key does not block the
 *   cache and is reported again on a hit; a passing failure still blocks it.
 */

import { ResearchAction } from "@liner-notes/contract";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type FetchCall, json, stubFetch } from "../sources/testing/fetchStub.js";

const store = vi.hoisted(() => ({ research: new Map<string, unknown>(), puts: [] as string[] }));
vi.mock("../store/cache.js", () => ({
  getCache: () => ({
    getResearch: (key: string) => store.research.get(key) ?? null,
    putResearch: (key: string, value: unknown) => {
      store.puts.push(key);
      store.research.set(key, JSON.parse(JSON.stringify(value)));
    },
  }),
}));

import { MusicBrainzRateLimiter } from "../sources/musicbrainz.js";
import { createFallbackTrackData } from "./fallback.js";
import { historianNode } from "./nodes/historianNode.js";
import { composerUserPrompt, RESEARCH_ACTIONS } from "./prompts.js";
import { artistFromCredit, createResearcherSubgraph } from "./researcherSubgraph.js";
import type { ResearchData, SonicAgentStateType, SpotifyData } from "./state.js";
import { messagesOf, stubLlm, testRuntime } from "./testing/stubLlm.js";

const VANILLA_ICE = "8b8a38a9-a290-4560-84f6-3d4466e8d791";
const MC_HAMMER = "11111111-1111-4111-8111-111111111111";
const RAMSEY_LEWIS = "22222222-2222-4222-8222-222222222222";
const EWF = "33333333-3333-4333-8333-333333333333";
const RECORDING = "44444444-4444-4444-8444-444444444444";
const NIRVANA_UK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const NIRVANA_US = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NIRVANA_SPOTIFY = "6olE6TJLqED3rqDCT0FyPh";

const ICE: SpotifyData = {
  id: "3Fcfwhm8oRrBvBZ8KGhtea",
  title: "Ice Ice Baby",
  artist: "Vanilla Ice",
  artistNames: ["Vanilla Ice"],
  artistIds: ["7GaxyUddsPok8BuhxN6OUW"],
  album: "To the Extreme",
} as SpotifyData;

// "Sun Goddess" is credited to two artists, one of whose names has commas: the joined Spotify
// string cannot be split back into them.
const SUN_GODDESS: SpotifyData = {
  id: "sun-goddess",
  title: "Sun Goddess",
  artist: "Ramsey Lewis, Earth, Wind & Fire",
  artistNames: ["Ramsey Lewis", "Earth, Wind & Fire"],
  artistIds: ["4lIzVkCnD6VzWRmV2Rgt7v", "4QQgXkCYTt3BlENzhyNETg"],
  album: "Sun Goddess",
} as SpotifyData;

// Two MusicBrainz artists are named exactly "Nirvana" (a 60s UK band and the 90s US band).
const LITHIUM: SpotifyData = {
  id: "lithium",
  title: "Lithium",
  artist: "Nirvana",
  artistNames: ["Nirvana"],
  artistIds: [NIRVANA_SPOTIFY],
  album: "Nevermind",
} as SpotifyData;

const MB = "https://musicbrainz.org/ws/2/";
const LABS = "https://labs.api.listenbrainz.org/similar-artists/json";
const TAVILY = "https://api.tavily.com/search";
const LASTFM = "https://ws.audioscrobbler.com/";

const param = (call: FetchCall, name: string) => new URL(call.url).searchParams.get(name);
const query = (call: FetchCall) => param(call, "query");
const labsMbid = (call: FetchCall) => param(call, "artist_mbids");
const to = (calls: FetchCall[], prefix: string) => calls.filter((c) => c.url.startsWith(prefix));

/** MusicBrainz artists by exact search phrase. */
const MB_ARTISTS: Record<string, Array<{ id: string; name: string; disambiguation?: string }>> = {
  "Vanilla Ice": [{ id: VANILLA_ICE, name: "Vanilla Ice" }],
  "Ramsey Lewis": [{ id: RAMSEY_LEWIS, name: "Ramsey Lewis" }],
  "Earth, Wind & Fire": [{ id: EWF, name: "Earth, Wind & Fire" }],
  // Both score 100; MusicBrainz's order is not popularity.
  Nirvana: [
    { id: NIRVANA_UK, name: "Nirvana", disambiguation: "60s band from the UK" },
    { id: NIRVANA_US, name: "Nirvana", disambiguation: "90s US grunge band" },
  ],
};
/** A MusicBrainz URL relationship to a Spotify artist page. */
const spotifyPage = (id: string) => ({
  type: "free streaming",
  url: { resource: `https://open.spotify.com/artist/${id}` },
});
const MB_RELATIONS: Record<string, unknown[]> = {
  [NIRVANA_UK]: [
    { type: "collaboration", artist: { id: MC_HAMMER, name: "Patrick Campbell-Lyons" } },
  ],
  [NIRVANA_US]: [
    spotifyPage(NIRVANA_SPOTIFY),
    { type: "collaboration", artist: { id: MC_HAMMER, name: "Butch Vig" } },
  ],
  [RAMSEY_LEWIS]: [
    spotifyPage("4lIzVkCnD6VzWRmV2Rgt7v"),
    { type: "collaboration", artist: { id: EWF, name: "Maurice White" } },
  ],
};

interface Network {
  tavily?: boolean | "down";
  lastfm?: boolean;
  /** Last.fm's answer to every call, instead of the default ones. */
  lastfmAnswer?: () => Response;
  /** Artists MusicBrainz does not know. */
  unknownArtists?: string[];
  /** MusicBrainz's links from Spotify artist ids to its artists. */
  spotifyLinks?: Record<string, string>;
  /** MusicBrainz answers every request with 503. */
  musicbrainzBusy?: boolean;
  /** MusicBrainz relations of the recording: one timeout. */
  musicbrainzTimeout?: boolean;
}

/** The sources' answers. Last.fm, like the real one, does not know a joined artist string. */
function network(options: Network = {}) {
  process.env.TAVILY_API_KEY = options.tavily === false ? "" : "tvly-test-key";
  process.env.LASTFM_API_KEY = options.lastfm === false ? "" : "test-lastfm-key";
  process.env.SOURCE_TIMEOUT_MS = options.musicbrainzTimeout ? "20" : "";
  return stubFetch((call) => {
    const url = call.url;
    if (url === TAVILY) {
      return options.tavily === "down"
        ? json({ detail: "internal error" }, { status: 500 })
        : json({
            results: [
              {
                title: "Ice Ice Baby on WhoSampled",
                url: "https://www.whosampled.com/Vanilla-Ice/Ice-Ice-Baby/",
                content: "Ice Ice Baby samples Under Pressure by Queen and David Bowie.",
              },
            ],
          });
    }
    if (url.startsWith(LASTFM)) {
      if (options.lastfmAnswer) return options.lastfmAnswer();
      const artist = param(call, "artist") ?? "";
      if (artist.includes(",")) return json({ error: 6, message: "Track not found" });
      const attr = { "@attr": { artist } };
      switch (param(call, "method")) {
        case "track.getTopTags":
          return json({ toptags: { tag: [{ name: "hip hop", count: 100 }], ...attr } });
        case "artist.getTopTags":
          return json({
            toptags: {
              tag: [
                { name: "hip hop", count: 100 },
                { name: "old school", count: 80 },
              ],
              ...attr,
            },
          });
        case "track.getSimilar":
          return json({
            similartracks: {
              track: [
                { name: "U Can't Touch This", match: 1, artist: { name: "MC Hammer" } },
                { name: "Jump Around", match: 0.42, artist: { name: "House of Pain" } },
              ],
              ...attr,
            },
          });
        case "artist.getSimilar":
          // The first similar artist carries its own MBID (never to be taken for the track's).
          return json({
            similarartists: {
              artist: [
                { name: "MC Hammer", match: "1", mbid: MC_HAMMER },
                { name: "Young MC", match: "0.81" },
              ],
              ...attr,
            },
          });
        default:
          return json({ error: 6, message: "The artist you supplied could not be found" });
      }
    }
    if (url.startsWith(MB) && options.musicbrainzBusy) {
      return json({ error: "slow down" }, { status: 503, headers: { "Retry-After": "0" } });
    }
    if (url.startsWith(`${MB}artist?`)) {
      const phrase = (query(call) ?? "").replace(/^artist:"(.*)"$/, "$1").replaceAll("\\", "");
      const known = options.unknownArtists?.includes(phrase) ? [] : (MB_ARTISTS[phrase] ?? []);
      return json({ count: known.length, artists: known.map((a) => ({ ...a, score: 100 })) });
    }
    if (url.startsWith(`${MB}url?`)) {
      const id = (param(call, "resource") ?? "").split("/").pop() ?? "";
      const linked = options.spotifyLinks?.[id];
      return linked
        ? json({ id: "u", relations: [{ type: "free streaming", artist: { id: linked } }] })
        : json({ error: "Not Found" }, { status: 404 });
    }
    if (url.startsWith(`${MB}artist/`)) {
      const id = new URL(url).pathname.split("/").pop() ?? "";
      const artist = Object.values(MB_ARTISTS)
        .flat()
        .find((a) => a.id === id);
      return json({ ...artist, relations: MB_RELATIONS[id] ?? [] });
    }
    if (url.startsWith(`${MB}recording?`)) {
      if (options.musicbrainzTimeout) {
        return new Promise<Response>((_resolve, reject) =>
          call.signal?.addEventListener("abort", () => reject(call.signal?.reason)),
        );
      }
      return json({
        count: 1,
        recordings: [
          {
            id: RECORDING,
            title: "Sun Goddess",
            "artist-credit": [
              {
                name: "Ramsey Lewis",
                joinphrase: " & ",
                artist: { id: RAMSEY_LEWIS, name: "Ramsey Lewis" },
              },
              { name: "Earth, Wind & Fire", artist: { id: EWF, name: "Earth, Wind & Fire" } },
            ],
            releases: [{ title: "Sun Goddess", status: "Official", "release-group": {} }],
          },
        ],
      });
    }
    if (url.startsWith(`${MB}recording/`)) {
      return json({
        id: RECORDING,
        title: "Sun Goddess",
        "artist-credit": [
          {
            name: "Ramsey Lewis",
            joinphrase: " & ",
            artist: { id: RAMSEY_LEWIS, name: "Ramsey Lewis" },
          },
          { name: "Earth, Wind & Fire", artist: { id: EWF, name: "Earth, Wind & Fire" } },
        ],
        relations: [],
      });
    }
    if (url.startsWith(`${LABS}?`)) {
      return json([
        { artist_mbid: "55555555-5555-4555-8555-555555555555", name: "Hammer fan", score: 900 },
        { artist_mbid: "66666666-6666-4666-8666-666666666666", name: "Other", score: 40 },
      ]);
    }
    return undefined;
  });
}

/** A planner that answers the queued steps, then "done"; its prompts are kept. */
function planner(...steps: string[]) {
  const llm = stubLlm(() => ({
    nextAction: steps.shift() ?? "done",
    query: null,
    reasoning: "next step",
  }));
  return { llm, runtime: testRuntime(llm), prompts: () => llm.calls.map((c) => messagesOf(c)) };
}

const research = (spotifyData: SpotifyData, ...steps: string[]) => {
  const p = planner(...steps);
  return {
    ...p,
    run: () => createResearcherSubgraph(p.runtime).invoke({ spotifyData, runId: "run-1" }),
  };
};

const historian = async (spotifyData: SpotifyData, ...steps: string[]) => {
  const p = planner(...steps);
  const out = await historianNode(
    { spotifyData } as unknown as SonicAgentStateType,
    { writer: () => {} } as never,
    p.runtime,
  );
  return { out, prompts: p.prompts(), plannerCalls: p.llm.calls.length };
};

const composerPrompt = (out: Partial<SonicAgentStateType>, track = ICE) =>
  composerUserPrompt({
    track: { title: track.title, artist: track.artist, album: null, year: null },
    recording: null,
    audio: null,
    evidence: [],
    research: out.researchData ?? null,
    sourceErrors: out.sourceErrors ?? [],
  });

/** Every string of the research, joined. */
const textOf = (data: Partial<ResearchData> | undefined) => JSON.stringify(data ?? {});

describe("research inputs", () => {
  beforeAll(() => {
    MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
  });
  beforeEach(() => {
    store.research.clear();
    store.puts = [];
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
  });
  afterEach(() => {
    delete process.env.SOURCE_TIMEOUT_MS;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("tool results are read by type", () => {
    it("a source that fails is a source error, never research", async () => {
      network({ musicbrainzBusy: true });
      const final = await research(ICE, "search_musicbrainz").run();

      expect(final.researchData.samples).toEqual([
        "Ice Ice Baby on WhoSampled\nhttps://www.whosampled.com/Vanilla-Ice/Ice-Ice-Baby/\nIce Ice Baby samples Under Pressure by Queen and David Bowie.",
      ]);
      expect(textOf(final.researchData)).not.toMatch(/busy|rate limit|503/i);
      expect(final.sourceErrors).toEqual([
        expect.objectContaining({ source: "musicbrainz", code: "rate_limited" }),
      ]);
      expect(final.statusMessages).toContain("⚠️ MusicBrainz could not be read (rate_limited)");
    });

    it("Last.fm's 'not found' is recorded as nothing found, never as a sentence", async () => {
      network({ lastfmAnswer: () => json({ error: 6, message: "Track not found" }) });
      const { out } = await historian(ICE, "search_lastfm_similar_tracks");

      expect(textOf(out.researchData)).not.toContain("Track not found");
      expect(out.researchData?.lastfmSimilarTracks).toEqual([]);
      expect(out.researchData?.noneFound).toContain("Last.fm similar tracks");
      expect(out.sourceErrors).toEqual([]);
    });

    it("the pre-fetch's empty answers and tags reach the planner", async () => {
      network({ lastfmAnswer: () => json({ error: 6, message: "Track not found" }) });
      const { prompts } = await historian(ICE, "search_lastfm_tags");

      const first = prompts[0].user;
      expect(first).toContain(
        "Steps whose source answered with nothing for this track:\n- Last.fm track tags\n" +
          "- Last.fm artist tags\n- Last.fm similar tracks",
      );
    });

    it("the planner sees the pre-fetched tags and similar tracks", async () => {
      network();
      const { prompts } = await historian(ICE);

      expect(prompts[0].user).toContain(
        '"lastfmTags":1,"lastfmArtistTags":1,"lastfmSimilarTracks":2',
      );
    });
  });

  describe("an unavailable source is reported as unavailable", () => {
    it("Last.fm without a key: a source error, a status line and 'unavailable' in the prompts", async () => {
      network({ lastfm: false });
      const { out, prompts } = await historian(ICE, "search_lastfm_tags");

      expect(out.sourceErrors).toContainEqual(
        expect.objectContaining({ source: "lastfm", code: "not_configured" }),
      );
      expect(out.statusMessages).toContain("⚠️ Last.fm could not be read (not_configured)");
      expect(out.statusMessages).not.toContain("Found lastfm tags information");
      const [first] = prompts;
      expect(first.user).toContain('"lastfmTags":"unavailable"');
      expect(first.user).not.toContain('"lastfmTags":0');
      expect(first.user).toContain("- Last.fm: unavailable (not_configured)");
      expect(composerPrompt(out)).toContain(
        "Sources that could not be read (their data is missing, not empty):\n- Last.fm: unavailable (not_configured)",
      );
    });

    it("Tavily down: a source error and a status that says so, never 'Found'", async () => {
      network({ tavily: "down" });
      const final = await research(ICE).run();

      expect(final.researchData.samples).toEqual([]);
      expect(final.sourceErrors).toEqual([
        expect.objectContaining({ source: "tavily", code: "unavailable" }),
      ]);
      expect(final.statusMessages).toContain(
        "⚠️ Web search (Tavily) could not be read (unavailable)",
      );
      expect(final.statusMessages).not.toContain("Found samples information");
    });

    it("a MusicBrainz failure while ListenBrainz resolves the name is MusicBrainz's", async () => {
      network({ musicbrainzBusy: true, tavily: false });
      const final = await research(ICE, "search_listenbrainz_similar").run();

      expect(final.sourceErrors).toContainEqual(
        expect.objectContaining({ source: "musicbrainz", code: "rate_limited" }),
      );
      expect(final.sourceErrors.map((e) => e.source)).not.toContain("listenbrainz");
    });
  });

  it("gives similar artists and tracks by rank and raw score, never as a percentage", async () => {
    network();
    const { out, prompts } = await historian(
      ICE,
      "search_lastfm_similar_artists",
      "search_listenbrainz_similar",
    );
    const data = out.researchData as ResearchData;

    expect(data.lastfmSimilarTracks).toEqual([
      "1. U Can't Touch This by MC Hammer (Last.fm match 1.00, relative to its closest match = 1)",
      "2. Jump Around by House of Pain (Last.fm match 0.42, relative to its closest match = 1)",
    ]);
    // With the artist's MusicBrainz id when Last.fm gives one: artists of one name stay apart.
    expect(data.lastfmSimilarArtists?.[0]).toBe(
      "1. MC Hammer (Last.fm match 1.00, relative to its closest match = 1, " +
        "MusicBrainz 11111111-1111-4111-8111-111111111111)",
    );
    expect(data.listenbrainzSimilarArtists?.[0]).toBe(
      "1. Hammer fan (similar to Vanilla Ice (artist matched by name only, not linked to the " +
        "Spotify artist); ListenBrainz co-listening score 900, higher is more similar, no fixed " +
        "maximum, MusicBrainz 55555555-5555-4555-8555-555555555555)",
    );
    expect(textOf(data)).not.toContain("%");
    expect(textOf(data)).not.toContain("scale 0-1");
    for (const prompt of prompts) expect(prompt.user).not.toContain("%");
    // Nothing writes the old "related artists" list any more, and the composer has no section
    // for it.
    expect(composerPrompt(out)).not.toContain("<<<SOURCE related artists>>>");
  });

  describe("ListenBrainz is asked about the track's own artist", () => {
    it("never with a similar artist's MBID", async () => {
      const net = network();
      const final = await research(
        ICE,
        "search_lastfm_similar_artists",
        "search_listenbrainz_similar",
      ).run();

      const labs = to(net.calls, LABS);
      expect(labs.map(labsMbid)).toEqual([VANILLA_ICE]);
      expect(labs.map(labsMbid)).not.toContain(MC_HAMMER);
      expect(final.researchData.listenbrainzSimilarArtists?.[0]).toContain(
        "similar to Vanilla Ice",
      );
    });

    it("from the recording's artist credit, without another artist search", async () => {
      const net = network();
      await research(SUN_GODDESS, "search_musicbrainz", "search_listenbrainz_similar").run();

      expect(to(net.calls, LABS).map(labsMbid)).toEqual([RAMSEY_LEWIS]);
      expect(to(net.calls, `${MB}artist?`)).toHaveLength(0);
      expect(net.calls.map((c) => c.url).join("\n")).not.toContain(`artist_mbids=${RECORDING}`);
    });

    it("not at all when MusicBrainz cannot identify the artist; the step is 'not asked'", async () => {
      const net = network({ unknownArtists: ["Vanilla Ice"] });
      const final = await research(ICE, "search_listenbrainz_similar").run();

      expect(to(net.calls, LABS)).toHaveLength(0);
      expect(final.researchData.listenbrainzSimilarArtists).toEqual([]);
      expect(final.researchData.notAsked).toEqual([
        "ListenBrainz similar artists (not asked: no MusicBrainz artist with exactly this name)",
      ]);
      expect(final.researchData.noneFound).toEqual([]);
      expect(final.statusMessages).toContain("Not asked or not identified: listenbrainz similar");
      expect(final.statusMessages).not.toContain("Nothing found: listenbrainz similar");
      expect(final.sourceErrors).toEqual([]);
    });
  });

  describe("artists of the same name", () => {
    it("takes the homonym MusicBrainz links to the Spotify artist, for ListenBrainz and collaborators", async () => {
      const net = network({ spotifyLinks: { [NIRVANA_SPOTIFY]: NIRVANA_US } });
      const final = await research(
        LITHIUM,
        "search_artist_collaborators",
        "search_listenbrainz_similar",
      ).run();

      expect(param(to(net.calls, `${MB}url?`)[0], "resource")).toBe(
        `https://open.spotify.com/artist/${NIRVANA_SPOTIFY}`,
      );
      expect(to(net.calls, `${MB}artist/`).map((c) => new URL(c.url).pathname)).toEqual([
        `/ws/2/artist/${NIRVANA_US}`,
      ]);
      expect(to(net.calls, LABS).map(labsMbid)).toEqual([NIRVANA_US]);
      expect(final.researchData.collaborators).toEqual(["Butch Vig (collaboration)"]);
      expect(textOf(final.researchData)).not.toContain("Patrick Campbell-Lyons");
    });

    it("asks nothing about either when no Spotify link tells them apart, and says why", async () => {
      const net = network();
      const final = await research(
        LITHIUM,
        "search_artist_collaborators",
        "search_listenbrainz_similar",
      ).run();

      expect(to(net.calls, `${MB}artist/`)).toHaveLength(0);
      expect(to(net.calls, LABS)).toHaveLength(0);
      expect(final.researchData.collaborators).toEqual([]);
      expect(final.researchData.notAsked).toEqual([
        "MusicBrainz collaborators of the artist (not asked: several MusicBrainz artists have " +
          "this name and none is linked to the Spotify artist)",
        "ListenBrainz similar artists (not asked: several MusicBrainz artists have this name " +
          "and none is linked to the Spotify artist)",
      ]);
      const fallback = await createFallbackTrackData({
        spotifyData: LITHIUM,
        researchData: final.researchData,
      } as unknown as SonicAgentStateType);
      expect(fallback.factoids.map((f) => f.title)).not.toContain("Collaboration Network");
    });
  });

  describe("a multi-artist track", () => {
    it("asks Last.fm about the first artist and the title without a featured-artist note", async () => {
      const net = network();
      const track = { ...SUN_GODDESS, title: "Sun Goddess (feat. Earth, Wind & Fire)" };
      const { out } = await historian(track, "search_lastfm_similar_artists");

      const asked = to(net.calls, LASTFM);
      expect(asked.map((c) => param(c, "artist"))).toEqual([
        "Ramsey Lewis",
        "Ramsey Lewis",
        "Ramsey Lewis",
        "Ramsey Lewis",
      ]);
      expect(asked.filter((c) => param(c, "track") !== null).map((c) => param(c, "track"))).toEqual(
        ["Sun Goddess", "Sun Goddess"],
      );
      expect(out.researchData?.noneFound).toEqual([]);
      expect(out.researchData?.lastfmTags).toEqual(["hip hop (100)"]);
    });

    it("the recording search names each artist and the album", async () => {
      const net = network();
      const final = await research(SUN_GODDESS, "search_musicbrainz").run();

      const [search] = to(net.calls, `${MB}recording?`);
      expect(query(search)).toBe(
        'recording:"Sun Goddess" AND artist:"Ramsey Lewis" AND artist:"Earth, Wind \\& Fire" ' +
          'AND release:"Sun Goddess"',
      );
      expect(final.sourceErrors).toEqual([]);
    });

    it("looks up the first artist, never the joined string, and labels the collaborators with it", async () => {
      const net = network();
      const final = await research(
        SUN_GODDESS,
        "search_artist_collaborators",
        "search_listenbrainz_similar",
      ).run();

      expect(to(net.calls, `${MB}artist?`).map(query)).toEqual(['artist:"Ramsey Lewis"']);
      expect(to(net.calls, LABS).map(labsMbid)).toEqual([RAMSEY_LEWIS]);
      expect(final.researchData.listenbrainzSimilarArtists?.[0]).toContain(
        "similar to Ramsey Lewis",
      );
      expect(final.researchData.collaboratorsOf).toBe("Ramsey Lewis");
      expect(final.researchData.productionTrivia.join("\n")).toContain(
        "[MusicBrainz Artist] Ramsey Lewis collaborators:",
      );
      expect(textOf(final.researchData)).not.toContain("Ramsey Lewis, Earth, Wind & Fire");
      const fallback = await createFallbackTrackData({
        spotifyData: SUN_GODDESS,
        researchData: final.researchData,
      } as unknown as SonicAgentStateType);
      expect(fallback.factoids.map((f) => f.content)).toContain(
        "Ramsey Lewis has worked with: Maurice White (collaboration).",
      );
    });

    it("a multi-artist track's first artist reaches ListenBrainz without an earlier step", async () => {
      const net = network();
      const final = await research(SUN_GODDESS, "search_listenbrainz_similar").run();

      expect(to(net.calls, LABS).map(labsMbid)).toEqual([RAMSEY_LEWIS]);
      expect(final.researchData.listenbrainzSimilarArtists?.[0]).toContain(
        "similar to Ramsey Lewis",
      );
    });
  });

  describe("the research cache", () => {
    it("is keyed v4 with the configured sources; research cached under v2 or v3 is not read", async () => {
      network();
      store.research.set(`v3:${ICE.id}:lastfm=1:tavily=1`, {
        samples: [],
        productionTrivia: [],
        listenbrainzSimilarArtists: ["Young MC (similarity: 100%)"],
      });
      store.research.set(`v2:${ICE.id}`, {
        samples: [],
        productionTrivia: [],
        relatedArtists: [],
        listenbrainzSimilarArtists: ["Young MC (similarity: 100%)"],
      });
      const { out, plannerCalls } = await historian(ICE);

      expect(plannerCalls).toBe(1);
      expect(textOf(out.researchData)).not.toContain("100%");
      expect(store.puts).toEqual([`v4:${ICE.id}:lastfm=1:tavily=1:discogs=0:genius=0`]);
    });

    it("without Last.fm and Tavily keys: cached, and the second analysis is a hit that reports them", async () => {
      network({ lastfm: false, tavily: false });
      const first = await historian(ICE, "search_lastfm_tags");
      const second = await historian(ICE, "search_lastfm_tags");

      const key = `v4:${ICE.id}:lastfm=0:tavily=0:discogs=0:genius=0`;
      expect(store.puts).toEqual([key]);
      expect(first.plannerCalls).toBeGreaterThan(0);
      expect(second.plannerCalls).toBe(0);
      const missing = [
        expect.objectContaining({ source: "lastfm", code: "not_configured" }),
        expect.objectContaining({ source: "tavily", code: "not_configured" }),
      ];
      expect(first.out.sourceErrors).toEqual(missing);
      expect(second.out.sourceErrors).toEqual(missing);
      expect(second.out.researchData).not.toHaveProperty("notConfigured");
      expect(composerPrompt(second.out)).toContain("- Last.fm: unavailable (not_configured)");
    });

    it("adding a key later runs the research again", async () => {
      network({ lastfm: false });
      await historian(ICE);
      network();
      const again = await historian(ICE);

      expect(again.plannerCalls).toBe(1);
      expect(store.puts).toEqual([
        `v4:${ICE.id}:lastfm=0:tavily=1:discogs=0:genius=0`,
        `v4:${ICE.id}:lastfm=1:tavily=1:discogs=0:genius=0`,
      ]);
    });

    it("a rejected Last.fm key says so and blocks the cache until it is fixed", async () => {
      network({
        lastfmAnswer: () => json({ error: 10, message: "Invalid API key" }, { status: 403 }),
      });
      const { out } = await historian(ICE);

      expect(out.sourceErrors).toEqual([
        expect.objectContaining({
          source: "lastfm",
          code: "unavailable",
          message: expect.stringContaining("Last.fm rejected the API key"),
        }),
      ]);
      expect(out.statusMessages).toContain("⚠️ Last.fm key rejected: fix the key (unavailable)");
      expect(store.puts).toEqual([]);
    });

    it("a rejected Tavily key says so and blocks the cache until it is fixed", async () => {
      const net = network();
      const route = globalThis.fetch;
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
        String(input instanceof Request ? input.url : input) === TAVILY
          ? Promise.resolve(json({ detail: { error: "Unauthorized" } }, { status: 401 }))
          : route(input, init),
      );
      const first = await historian(ICE);
      const second = await historian(ICE);

      expect(first.out.statusMessages).toContain(
        "⚠️ Web search (Tavily) key rejected: fix the key (unavailable)",
      );
      expect(store.puts).toEqual([]);
      expect(second.plannerCalls).toBe(1);
      expect(net.calls).not.toHaveLength(0);
    });

    it("a passing failure still blocks the cache", async () => {
      network({ musicbrainzTimeout: true });
      const { out } = await historian(SUN_GODDESS, "search_musicbrainz");

      expect(out.sourceErrors).toContainEqual(
        expect.objectContaining({ source: "musicbrainz", code: "timeout" }),
      );
      expect(store.puts).toEqual([]);
    });
  });

  describe("the artist's own MBID from a recording's credit", () => {
    const credit = [
      { name: "Earth, Wind & Fire", credited: "Earth, Wind & Fire", mbid: EWF },
      { name: "Ramsey Lewis", credited: "The Ramsey Lewis Trio", mbid: RAMSEY_LEWIS },
    ];

    it("is the credit named like the track's first artist, wherever it stands", () => {
      expect(artistFromCredit(credit, "Ramsey Lewis")).toEqual({
        name: "Ramsey Lewis",
        mbid: RAMSEY_LEWIS,
      });
    });

    it("matches the name as credited too (a renamed artist)", () => {
      expect(artistFromCredit(credit, "The Ramsey Lewis Trio")).toEqual({
        name: "Ramsey Lewis",
        mbid: RAMSEY_LEWIS,
      });
    });

    it("is the first credit when no credit has that name, and never an id that is not an MBID", () => {
      expect(artistFromCredit(credit, "Someone Else")).toEqual({
        name: "Earth, Wind & Fire",
        mbid: EWF,
      });
      expect(artistFromCredit([{ name: "X", mbid: "not-an-mbid" }], "X")).toBeNull();
      expect(artistFromCredit(undefined, "X")).toBeNull();
    });
  });

  describe("the track's artist is resolved once per run", () => {
    const NOVA = "77777777-7777-4777-8777-777777777777";
    const NOVA_SPOTIFY = "0123456789abcdefABCDEF";
    const NOVA_TRACK = {
      id: "nova-track",
      title: "Some Song",
      artist: "Nova",
      artistNames: ["Nova"],
      artistIds: [NOVA_SPOTIFY],
      album: "Some Album",
    } as SpotifyData;
    const counts = (calls: FetchCall[]) => ({
      search: to(calls, `${MB}artist?`).length,
      link: to(calls, `${MB}url?`).length,
      lookup: to(calls, `${MB}artist/`).length,
      labs: to(calls, LABS).length,
    });
    beforeEach(() => {
      MB_ARTISTS.Nova = [{ id: NOVA, name: "Nova" }];
    });
    afterEach(() => {
      delete MB_ARTISTS.Nova;
      delete MB_RELATIONS[NOVA];
    });

    it("a single name match whose Spotify link names another artist is not used", async () => {
      MB_RELATIONS[NOVA] = [
        spotifyPage("ZYXWVUTSRQPONMLKJIHGFE"),
        { type: "collaboration", artist: { id: MC_HAMMER, name: "Corrado Rustici" } },
      ];
      const net = network({ tavily: false });
      const final = await research(
        NOVA_TRACK,
        "search_artist_collaborators",
        "search_listenbrainz_similar",
      ).run();

      expect(final.researchData.collaborators).toEqual([]);
      expect(textOf(final.researchData)).not.toContain("Corrado Rustici");
      expect(to(net.calls, LABS)).toHaveLength(0);
      expect(final.researchData.notAsked).toEqual([
        "MusicBrainz collaborators of the artist (not asked: the MusicBrainz artist of this " +
          "name links to another Spotify artist)",
        "ListenBrainz similar artists (not asked: the MusicBrainz artist of this name links to " +
          "another Spotify artist)",
      ]);
    });

    it("a single name match without a Spotify link is marked unverified, never a card", async () => {
      MB_RELATIONS[NOVA] = [
        { type: "collaboration", artist: { id: MC_HAMMER, name: "Corrado Rustici" } },
      ];
      network({ tavily: false });
      const final = await research(
        NOVA_TRACK,
        "search_artist_collaborators",
        "search_listenbrainz_similar",
      ).run();

      expect(final.researchData.collaborators).toEqual([]);
      expect(final.researchData.productionTrivia.join("\n")).toContain(
        "[MusicBrainz Artist] Nova (artist matched by name only, not linked to the Spotify " +
          "artist) collaborators:",
      );
      expect(final.researchData.listenbrainzSimilarArtists?.[0]).toContain(
        "similar to Nova (artist matched by name only, not linked to the Spotify artist)",
      );
      const fallback = await createFallbackTrackData({
        spotifyData: NOVA_TRACK,
        researchData: final.researchData,
      } as unknown as SonicAgentStateType);
      expect(fallback.factoids.map((f) => f.title)).not.toContain("Collaboration Network");
    });

    it("artists of the same name: asked once, then both artist steps are skipped", async () => {
      const net = network({ tavily: false });
      await research(LITHIUM, "search_artist_collaborators", "search_listenbrainz_similar").run();

      expect(counts(net.calls)).toEqual({ search: 1, link: 1, lookup: 0, labs: 0 });
    });

    it("ListenBrainz's resolved artist serves the collaborators step, without another search", async () => {
      const net = network({ tavily: false, spotifyLinks: { [NIRVANA_SPOTIFY]: NIRVANA_US } });
      const final = await research(
        LITHIUM,
        "search_listenbrainz_similar",
        "search_artist_collaborators",
      ).run();

      expect(counts(net.calls)).toEqual({ search: 0, link: 1, lookup: 1, labs: 1 });
      expect(to(net.calls, `${MB}artist/`)[0].url).toContain(NIRVANA_US);
      expect(final.researchData.collaborators).toEqual(["Butch Vig (collaboration)"]);
    });

    it("the same for an artist found by name", async () => {
      const net = network({ tavily: false });
      await research(
        SUN_GODDESS,
        "search_listenbrainz_similar",
        "search_artist_collaborators",
      ).run();

      expect(counts(net.calls)).toEqual({ search: 1, link: 1, lookup: 1, labs: 1 });
    });

    it("a MusicBrainz failure while ListenBrainz resolves the name is recorded as not asked", async () => {
      network({ musicbrainzBusy: true, tavily: false });
      const final = await research(ICE, "search_listenbrainz_similar").run();

      expect(final.researchData.notAsked).toContain(
        "ListenBrainz similar artists (not asked: MusicBrainz could not be read)",
      );
    });
  });

  describe("Last.fm's artist-level data when the artist is uncertain", () => {
    it("is dropped when several artists share the name", async () => {
      network({ tavily: false });
      const { out } = await historian(
        LITHIUM,
        "search_artist_collaborators",
        "search_lastfm_similar_artists",
      );

      expect(out.researchData?.lastfmArtistTags).toEqual([]);
      expect(textOf(out.researchData)).not.toContain("old school");
      expect(out.researchData?.lastfmSimilarArtists).toEqual([]);
      expect(out.researchData?.lastfmTags).toEqual(["hip hop (100)"]);
      expect(out.researchData?.notAsked).toEqual(
        expect.arrayContaining([
          "Last.fm similar artists (not asked: several MusicBrainz artists have this name and " +
            "none is linked to the Spotify artist)",
          "Last.fm artist tags, similar artists and bio (dropped: several MusicBrainz artists " +
            "have this name and none is linked to the Spotify artist)",
        ]),
      );
    });

    it("is dropped when Last.fm keeps one page for several artists of the name", async () => {
      const net = network({ tavily: false });
      const route = globalThis.fetch;
      vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (
          url.startsWith(LASTFM) &&
          new URL(url).searchParams.get("method") === "artist.getTopTags"
        ) {
          return Promise.resolve(
            json({
              toptags: {
                tag: [{ name: "grunge", count: 100 }],
                "@attr": { artist: "Vanilla Ice" },
              },
            }),
          );
        }
        if (
          url.startsWith(LASTFM) &&
          new URL(url).searchParams.get("method") === "artist.getInfo"
        ) {
          return Promise.resolve(
            json({
              artist: {
                name: "Vanilla Ice",
                bio: { summary: "There are multiple artists with this name: 1) a rapper…" },
              },
            }),
          );
        }
        return route(input, init);
      });
      const { out } = await historian(ICE, "search_lastfm_artist_info");

      expect(out.researchData?.lastfmArtistTags).toEqual([]);
      expect(textOf(out.researchData)).not.toContain("grunge");
      expect(out.researchData?.notAsked).toContain(
        "Last.fm artist tags, similar artists and bio (dropped: Last.fm keeps one page for " +
          "several artists of this name)",
      );
      expect(net.calls).not.toHaveLength(0);
    });
  });

  it("web searches name the first artist and the title without a featured-artist note", async () => {
    const net = network();
    await research({ ...SUN_GODDESS, title: "Sun Goddess (feat. Earth, Wind & Fire)" }).run();

    const [search] = to(net.calls, TAVILY);
    expect(JSON.parse(search.body ?? "{}").query).toBe(
      '"Sun Goddess" "Ramsey Lewis" sampled by OR samples from whosampled',
    );
  });

  it("no longer offers the removed Spotify top-tracks step", () => {
    expect(ResearchAction.options).not.toContain("search_artist_top_tracks");
    expect(RESEARCH_ACTIONS.map(([action]) => action)).not.toContain("search_artist_top_tracks");
  });
});
