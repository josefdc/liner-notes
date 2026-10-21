/**
 * What the research reads from its sources, end to end: the real source tools over a stubbed
 * network, a stubbed research planner that records its prompts.
 *
 * - A tool's failure is read by its type: "Error: …" or "No … found" text is never research;
 *   an unavailable source (Last.fm without a key, Tavily down) is a source error, the status
 *   says it could not be read and the prompts say it was unavailable (never "0 tags").
 * - Similar artists and tracks are given by rank with the raw score and its scale, never as a
 *   percentage (the top artist was always "100%").
 * - ListenBrainz is asked about the track's own artist only: its MBID comes from MusicBrainz
 *   (the artist search by exact name, or the recording's artist credit), never from a similar
 *   artist; when MusicBrainz cannot identify the artist, ListenBrainz is not asked.
 * - The album and the separate artist names reach MusicBrainz and ListenBrainz.
 */

import { ResearchAction } from "@liner-notes/contract";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type FetchCall, json, stubFetch } from "../sources/testing/fetchStub.js";

vi.mock("../store/cache.js", () => ({
  getCache: () => ({ getResearch: () => null, putResearch: () => {} }),
}));

import { getLastfmSimilarTracks } from "../sources/lastfm.js";
import { getMusicBrainzRelations, MusicBrainzRateLimiter } from "../sources/musicbrainz.js";
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
  artistIds: ["a", "b"],
  album: "Sun Goddess",
} as SpotifyData;

const MB = "https://musicbrainz.org/ws/2/";
const LABS = "https://labs.api.listenbrainz.org/similar-artists/json";
const TAVILY = "https://api.tavily.com/search";
const LASTFM = "https://ws.audioscrobbler.com/";

const query = (call: FetchCall) => new URL(call.url).searchParams.get("query");
const lastfmMethod = (call: FetchCall) => new URL(call.url).searchParams.get("method");
const labsMbid = (call: FetchCall) => new URL(call.url).searchParams.get("artist_mbids");

/** MusicBrainz artists by exact search phrase. */
const MB_ARTISTS: Record<string, { id: string; name: string }> = {
  "Vanilla Ice": { id: VANILLA_ICE, name: "Vanilla Ice" },
  "Ramsey Lewis": { id: RAMSEY_LEWIS, name: "Ramsey Lewis" },
  "Earth, Wind & Fire": { id: EWF, name: "Earth, Wind & Fire" },
};

interface Network {
  tavily?: "down" | "results";
  lastfm?: boolean;
  /** Artists MusicBrainz does not know. */
  unknownArtists?: string[];
}

/** The sources' answers. */
function network(options: Network = {}) {
  process.env.TAVILY_API_KEY = "tvly-test-key";
  process.env.LASTFM_API_KEY = options.lastfm === false ? "" : "test-lastfm-key";
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
      switch (lastfmMethod(call)) {
        case "track.getTopTags":
        case "artist.getTopTags":
          return json({ toptags: { tag: [{ name: "hip hop", count: 100 }] } });
        case "track.getSimilar":
          return json({
            similartracks: {
              track: [
                { name: "U Can't Touch This", match: 1, artist: { name: "MC Hammer" } },
                { name: "Jump Around", match: 0.42, artist: { name: "House of Pain" } },
              ],
            },
          });
        case "artist.getSimilar":
          // Probe R1: the first similar artist carries its own MBID.
          return json({
            similarartists: {
              artist: [
                { name: "MC Hammer", match: "1", mbid: MC_HAMMER },
                { name: "Young MC", match: "0.81" },
              ],
            },
          });
        default:
          return json({ error: 6, message: "The artist you supplied could not be found" });
      }
    }
    if (url.startsWith(`${MB}artist?`)) {
      const phrase = (query(call) ?? "").replace(/^artist:"(.*)"$/, "$1").replaceAll("\\", "");
      const known = options.unknownArtists?.includes(phrase) ? undefined : MB_ARTISTS[phrase];
      return json({ count: known ? 1 : 0, artists: known ? [{ ...known, score: 100 }] : [] });
    }
    if (url.startsWith(`${MB}artist/`)) {
      const id = new URL(url).pathname.split("/").pop();
      const artist = Object.values(MB_ARTISTS).find((a) => a.id === id);
      return json({ ...artist, relations: [] });
    }
    if (url.startsWith(`${MB}recording?`)) {
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
  return { out, prompts: p.prompts() };
};

/** Every string of the research, joined. */
const textOf = (data: Partial<ResearchData> | undefined) => JSON.stringify(data ?? {});

describe("research inputs", () => {
  beforeAll(() => {
    MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
  });
  beforeEach(() => {
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("tool failures are read by type, not by text", () => {
    it("an `Error: …` result is not stored as research", async () => {
      network();
      vi.spyOn(getMusicBrainzRelations, "invoke").mockResolvedValue(
        "Error: MusicBrainz is unavailable",
      );
      const final = await research(ICE, "search_musicbrainz").run();

      expect(textOf(final.researchData)).not.toContain("MusicBrainz is unavailable");
      expect(final.researchData.samples.join("\n")).not.toMatch(/error/i);
      expect(final.sourceErrors).toContainEqual(
        expect.objectContaining({ source: "musicbrainz", code: "invalid_response" }),
      );
    });

    it("a `No … found` sentence is not stored as a fact", async () => {
      network();
      vi.spyOn(getLastfmSimilarTracks, "invoke").mockResolvedValue(
        "No similar tracks found for Ice Ice Baby",
      );
      const { out } = await historian(ICE, "search_lastfm_similar_tracks");

      expect(textOf(out.researchData)).not.toContain("No similar tracks found");
      expect(out.researchData?.relatedArtists).toEqual([]);
    });

    it("a source that answers with nothing is recorded as such, never as a sentence", async () => {
      network();
      vi.spyOn(getMusicBrainzRelations, "invoke").mockResolvedValue(
        JSON.stringify({
          found: false,
          reason: "not_found",
          message: "No recording identified on MusicBrainz for Ice Ice Baby",
        }),
      );
      const final = await research(ICE, "search_musicbrainz").run();

      expect(textOf(final.researchData)).not.toContain("No recording identified");
      expect(final.researchData.noneFound).toContain("MusicBrainz relationships of the recording");
      expect(final.statusMessages).toContain("Nothing found: musicbrainz");
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

      const composer = composerUserPrompt({
        track: { title: ICE.title, artist: ICE.artist, album: null, year: null },
        recording: null,
        audio: null,
        evidence: [],
        research: out.researchData ?? null,
        sourceErrors: out.sourceErrors,
      });
      expect(composer).toContain(
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
      "1. U Can't Touch This by MC Hammer (Last.fm match 1.00, scale 0-1)",
      "2. Jump Around by House of Pain (Last.fm match 0.42, scale 0-1)",
    ]);
    expect(data.lastfmSimilarArtists?.[0]).toBe("1. MC Hammer (Last.fm match 1.00, scale 0-1)");
    expect(data.listenbrainzSimilarArtists?.[0]).toMatch(
      /^1\. Hammer fan \(similar to Vanilla Ice; ListenBrainz score 900, /,
    );
    expect(textOf(data)).not.toContain("%");
    for (const prompt of prompts) expect(prompt.user).not.toContain("%");
  });

  describe("ListenBrainz is asked about the track's own artist", () => {
    it("never with a similar artist's MBID (probe R1)", async () => {
      const net = network();
      const final = await research(
        ICE,
        "search_lastfm_similar_artists",
        "search_listenbrainz_similar",
      ).run();

      const labs = net.calls.filter((c) => c.url.startsWith(LABS));
      expect(labs.map(labsMbid)).toEqual([VANILLA_ICE]);
      expect(labs.map(labsMbid)).not.toContain(MC_HAMMER);
      expect(final.researchData.listenbrainzSimilarArtists?.[0]).toContain(
        "similar to Vanilla Ice",
      );
    });

    it("from the recording's artist credit, without another artist search", async () => {
      const net = network();
      await research(SUN_GODDESS, "search_musicbrainz", "search_listenbrainz_similar").run();

      expect(net.calls.filter((c) => c.url.startsWith(LABS)).map(labsMbid)).toEqual([RAMSEY_LEWIS]);
      expect(net.calls.filter((c) => c.url.startsWith(`${MB}artist?`))).toHaveLength(0);
      expect(net.calls.map((c) => c.url).join("\n")).not.toContain(`artist_mbids=${RECORDING}`);
    });

    it("not at all when MusicBrainz cannot identify the artist; the skip is recorded", async () => {
      const net = network({ unknownArtists: ["Vanilla Ice"] });
      const final = await research(ICE, "search_listenbrainz_similar").run();

      expect(net.calls.filter((c) => c.url.startsWith(LABS))).toHaveLength(0);
      expect(final.researchData.listenbrainzSimilarArtists).toEqual([]);
      expect(final.researchData.noneFound).toContain(
        "ListenBrainz similar artists (skipped: no MusicBrainz artist with exactly this name)",
      );
      expect(final.sourceErrors).toEqual([]);
    });
  });

  describe("the album and the separate artists reach MusicBrainz and ListenBrainz", () => {
    it("the recording search names each artist and the album", async () => {
      const net = network();
      const final = await research(SUN_GODDESS, "search_musicbrainz").run();

      const [search] = net.calls.filter((c) => c.url.startsWith(`${MB}recording?`));
      expect(query(search)).toBe(
        'recording:"Sun Goddess" AND artist:"Ramsey Lewis" AND artist:"Earth, Wind \\& Fire" ' +
          'AND release:"Sun Goddess"',
      );
      expect(final.sourceErrors).toEqual([]);
    });

    it("a multi-artist track resolves its first artist for collaborators and ListenBrainz", async () => {
      const net = network();
      const final = await research(
        SUN_GODDESS,
        "search_artist_collaborators",
        "search_listenbrainz_similar",
      ).run();

      // The joined name is not an artist; the first credited artist is.
      expect(net.calls.filter((c) => c.url.startsWith(`${MB}artist?`)).map(query)).toEqual([
        'artist:"Ramsey Lewis, Earth, Wind \\& Fire"',
        'artist:"Ramsey Lewis"',
      ]);
      expect(net.calls.filter((c) => c.url.startsWith(LABS)).map(labsMbid)).toEqual([RAMSEY_LEWIS]);
      expect(final.researchData.listenbrainzSimilarArtists?.[0]).toContain(
        "similar to Ramsey Lewis",
      );
    });

    it("a multi-artist track's first artist reaches ListenBrainz without an earlier step", async () => {
      const net = network();
      const final = await research(SUN_GODDESS, "search_listenbrainz_similar").run();

      expect(net.calls.filter((c) => c.url.startsWith(LABS)).map(labsMbid)).toEqual([RAMSEY_LEWIS]);
      expect(final.researchData.listenbrainzSimilarArtists?.[0]).toContain(
        "similar to Ramsey Lewis",
      );
    });
  });

  describe("the artist's own MBID from a recording's credit", () => {
    const credit = [
      { name: "Earth, Wind & Fire", mbid: EWF },
      { name: "Ramsey Lewis", mbid: RAMSEY_LEWIS },
    ];

    it("is the credit named like the track's first artist, wherever it stands", () => {
      expect(artistFromCredit(credit, "Ramsey Lewis")).toEqual({
        name: "Ramsey Lewis",
        mbid: RAMSEY_LEWIS,
      });
    });

    it("is the first credit when no credit has that name, and never an id that is not an MBID", () => {
      expect(artistFromCredit(credit, "Ramsey Lewis Trio")).toEqual(credit[0]);
      expect(artistFromCredit([{ name: "X", mbid: "not-an-mbid" }], "X")).toBeNull();
      expect(artistFromCredit(undefined, "X")).toBeNull();
    });
  });

  it("no longer offers the removed Spotify top-tracks step", () => {
    expect(ResearchAction.options).not.toContain("search_artist_top_tracks");
    expect(RESEARCH_ACTIONS.map(([action]) => action)).not.toContain("search_artist_top_tracks");
  });
});
