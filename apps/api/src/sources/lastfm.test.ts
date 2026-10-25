/**
 * Last.fm tools.
 *
 * Without an API key every tool reports the source as unavailable (not as "0 results"),
 * without throwing, returning made-up data or touching the network, and the missing key is
 * logged once. With a key (stubbed API): names are autocorrected, a single tag sent as an
 * object is read, and Last.fm's error message is kept.
 *
 * Run: npm run test:lastfm -w apps/api
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type CapturedLogs, captureLogsForTests } from "../logger.js";
import {
  getLastfmArtistInfo,
  getLastfmArtistTags,
  getLastfmSimilarArtists,
  getLastfmSimilarTracks,
  getLastfmTrackTags,
} from "./lastfm.js";
import { json, stubFetch } from "./testing/fetchStub.js";

const cases: Array<
  [string, { invoke: (input: never) => Promise<unknown> }, Record<string, string>]
> = [
  ["track tags", getLastfmTrackTags, { title: "Bohemian Rhapsody", artist: "Queen" }],
  ["artist tags", getLastfmArtistTags, { artist: "Queen" }],
  ["similar tracks", getLastfmSimilarTracks, { title: "Bohemian Rhapsody", artist: "Queen" }],
  ["similar artists", getLastfmSimilarArtists, { artist: "Queen" }],
  ["artist info", getLastfmArtistInfo, { artist: "Queen" }],
];

describe("Last.fm tools without an API key", () => {
  // A plain counter, not a vi.fn(): Vitest clears mock call history between tests.
  let networkCalls = 0;
  let savedKey: string | undefined;
  let savedFetch: typeof fetch;
  // Captured for the whole block: the warning is logged once per process.
  let logs: CapturedLogs;
  const warnings = () => logs.messages("warn");

  beforeAll(() => {
    logs = captureLogsForTests();
    // Importing the tools loads apps/api/.env; remove the key so the no-key path is
    // exercised regardless of local configuration.
    savedKey = process.env.LASTFM_API_KEY;
    delete process.env.LASTFM_API_KEY;
    savedFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      networkCalls++;
      throw new Error("network access is not expected without an API key");
    }) as typeof fetch;
  });

  afterAll(() => {
    logs.restore();
    globalThis.fetch = savedFetch;
    if (savedKey !== undefined) process.env.LASTFM_API_KEY = savedKey;
  });

  it.each(cases)("%s reports that the source is not configured", async (_name, tool, input) => {
    const callsBefore = networkCalls;
    const data = JSON.parse(String(await tool.invoke(input as never)));
    expect(networkCalls - callsBefore, "network calls").toBe(0);
    expect(data.error).toMatch(/not configured/);
    expect(data.found).not.toBe(true);
    expect(data.unavailable, "marked unavailable, not empty").toBe(true);
    expect(data.code).toBe("not_configured");
    for (const key of ["tags", "tracks", "artists", "name"]) {
      expect(data, `no "${key}" without a key`).not.toHaveProperty(key);
    }
  });

  it("made no network call in any case", () => {
    expect(networkCalls).toBe(0);
  });

  it("reports the missing key once", async () => {
    // Runs tools itself, so it holds in any test order.
    await getLastfmTrackTags.invoke({ title: "Bohemian Rhapsody", artist: "Queen" });
    await getLastfmArtistTags.invoke({ artist: "Queen" });
    expect(warnings().filter((line) => line.includes("LASTFM_API_KEY"))).toHaveLength(1);
  });
});

describe("Last.fm tools with a key", () => {
  const API = "https://ws.audioscrobbler.com/2.0/";
  let savedKey: string | undefined;

  beforeEach(() => {
    savedKey = process.env.LASTFM_API_KEY;
    process.env.LASTFM_API_KEY = "test-lastfm-key";
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.LASTFM_API_KEY;
    else process.env.LASTFM_API_KEY = savedKey;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const method = (url: string) => new URL(url).searchParams.get("method");

  describe("an artist the run identified by its MusicBrainz id", () => {
    const MBID = "0383dadf-2a4e-4d10-a46a-e9e041da8eb3";

    it("asks Last.fm for that artist, whatever name it answers with", async () => {
      const net = stubFetch((call) =>
        call.url.startsWith(API)
          ? json({ toptags: { tag: [{ name: "rock", count: 100 }], "@attr": { artist: "QUEEN" } } })
          : undefined,
      );

      const data = JSON.parse(await getLastfmArtistTags.invoke({ artist: "Queen", mbid: MBID }));

      expect(data).toEqual({ found: true, tags: [{ name: "rock", count: 100 }] });
      const asked = new URL(net.calls[0].url).searchParams;
      expect(asked.get("mbid")).toBe(MBID);
      expect(asked.has("artist")).toBe(false);
      expect(net.calls).toHaveLength(1);
    });

    const MB_SEARCH = "https://musicbrainz.org/ws/2/artist?";
    /** Last.fm knows no artist with the id; MusicBrainz has `artists` named "Queen". */
    const unknownId = (artists: Array<{ id: string; name: string }>, byName: unknown) =>
      stubFetch((call) => {
        if (call.url.startsWith(MB_SEARCH)) return json({ count: artists.length, artists });
        if (!call.url.startsWith(API)) return undefined;
        return new URL(call.url).searchParams.has("mbid")
          ? json({ error: 6, message: "The artist you supplied could not be found" })
          : json(byName);
      });
    const similar = {
      similarartists: { artist: [{ name: "Other", match: "1" }], "@attr": { artist: "Queen" } },
    };

    it("asks by name when Last.fm knows no artist with that id and the name is this artist's alone", async () => {
      const net = unknownId([{ id: MBID, name: "Queen" }], similar);

      const data = JSON.parse(
        await getLastfmSimilarArtists.invoke({ artist: "Queen", mbid: MBID }),
      );

      expect(data).toEqual({ found: true, artists: [{ name: "Other", match: 1 }] });
      const lastfm = net.calls.filter((c) => c.url.startsWith(API));
      expect(lastfm.map((c) => new URL(c.url).searchParams.get("artist"))).toEqual([null, "Queen"]);
    });

    it("does not ask by name when MusicBrainz has another artist of that name", async () => {
      const net = unknownId(
        [
          { id: MBID, name: "Queen" },
          { id: "11111111-1111-4111-8111-111111111111", name: "Queen" },
        ],
        similar,
      );

      const data = JSON.parse(
        await getLastfmSimilarArtists.invoke({ artist: "Queen", mbid: MBID }),
      );

      expect(data).toMatchObject({ found: false, reason: "lastfm_unknown_mbid" });
      // One request by id, none by name.
      const lastfm = net.calls.filter((c) => c.url.startsWith(API));
      expect(lastfm).toHaveLength(1);
      expect(new URL(lastfm[0].url).searchParams.has("mbid")).toBe(true);
    });

    it("drops artist info asked by name that Last.fm files under another MusicBrainz id", async () => {
      unknownId([{ id: MBID, name: "Queen" }], {
        artist: {
          name: "Queen",
          mbid: "22222222-2222-4222-8222-222222222222",
          bio: { summary: "Another band called Queen." },
          tags: { tag: [{ name: "rock", count: 1 }] },
        },
      });

      const data = JSON.parse(await getLastfmArtistInfo.invoke({ artist: "Queen", mbid: MBID }));

      expect(data).toMatchObject({ found: false, reason: "other_artist" });
    });

    it("does not ask again by name when Last.fm could not be read", async () => {
      const net = stubFetch((call) =>
        call.url.startsWith(API) ? new Response("busy", { status: 503 }) : undefined,
      );

      const data = JSON.parse(await getLastfmArtistInfo.invoke({ artist: "Queen", mbid: MBID }));

      expect(data).toMatchObject({ found: false, code: "unavailable" });
      expect(net.calls.length).toBeGreaterThan(0);
      for (const call of net.calls) expect(new URL(call.url).searchParams.has("mbid")).toBe(true);
    });
  });

  it("reads a single tag sent as an object", async () => {
    stubFetch((call) =>
      call.url.startsWith(API) && method(call.url) === "track.getTopTags"
        ? json({ toptags: { tag: { name: "new jack swing", count: 100 }, "@attr": {} } })
        : undefined,
    );

    const data = JSON.parse(
      await getLastfmTrackTags.invoke({ title: "Rare Song", artist: "Someone" }),
    );

    expect(data).toEqual({ found: true, tags: [{ name: "new jack swing", count: 100 }] });
  });

  it("reads a single similar artist sent as an object", async () => {
    stubFetch((call) =>
      call.url.startsWith(API)
        ? json({ similarartists: { artist: { name: "Other", match: "0.5", mbid: "" } } })
        : undefined,
    );

    const data = JSON.parse(await getLastfmSimilarArtists.invoke({ artist: "Someone" }));

    expect(data).toEqual({ found: true, artists: [{ name: "Other", match: 0.5 }] });
  });

  it.each(cases)("%s asks Last.fm to autocorrect names", async (_name, tool, input) => {
    const net = stubFetch((call) => (call.url.startsWith(API) ? json({}) : undefined));

    await tool.invoke(input as never);

    expect(net.calls).toHaveLength(1);
    expect(new URL(net.calls[0].url).searchParams.get("autocorrect")).toBe("1");
  });

  it("reads Last.fm's 'not found' (error 6, sent with HTTP 400) as nothing found", async () => {
    stubFetch((call) =>
      call.url.startsWith(API)
        ? json({ error: 6, message: "Track not found", links: [] }, { status: 400 })
        : undefined,
    );

    const data = JSON.parse(await getLastfmTrackTags.invoke({ title: "Nope", artist: "Nobody" }));

    expect(data).toEqual({
      found: false,
      reason: "not_found",
      message: "Last.fm error 6: Track not found",
    });
  });

  it("reads Last.fm's 'not found' sent with HTTP 200 as nothing found", async () => {
    stubFetch((call) =>
      call.url.startsWith(API)
        ? json({ error: 6, message: "The artist you supplied could not be found" })
        : undefined,
    );

    const data = JSON.parse(await getLastfmArtistInfo.invoke({ artist: "Nobody At All" }));

    expect(data).toMatchObject({ found: false, reason: "not_found" });
    expect(data.message).toContain("could not be found");
    expect(data).not.toHaveProperty("name");
    expect(data).not.toHaveProperty("code");
  });

  it.each([
    [29, "Rate Limit Exceeded", "rate_limited"],
    [11, "Service Offline", "unavailable"],
  ])("keeps Last.fm's error %s as a failure with its code", async (error, message, code) => {
    stubFetch((call) =>
      call.url.startsWith(API) ? json({ error, message }, { status: 400 }) : undefined,
    );

    const data = JSON.parse(await getLastfmTrackTags.invoke({ title: "Nope", artist: "Nobody" }));

    expect(data).toEqual({ found: false, code, error: `Last.fm error ${error}: ${message}` });
  });
  it.each([
    [10, "Invalid API key - You must be granted a valid key by last.fm"],
    [26, "Suspended API key - Access for your account has been suspended"],
    [4, "Authentication Failed"],
  ])(
    "reads Last.fm's error %s as a rejected key (an operator error, not 'not configured')",
    async (error, message) => {
      stubFetch((call) =>
        call.url.startsWith(API) ? json({ error, message }, { status: 403 }) : undefined,
      );

      const data = JSON.parse(await getLastfmArtistTags.invoke({ artist: "Queen" }));

      expect(data).toEqual({
        found: false,
        code: "unavailable",
        error: `Last.fm rejected the API key (Last.fm error ${error}: ${message})`,
        keyRejected: true,
      });
    },
  );

  it("reads error 6 without 'not found' as a refused request, not as nothing there", async () => {
    stubFetch((call) =>
      call.url.startsWith(API)
        ? json({ error: 6, message: "Invalid parameters - Your request is missing a parameter" })
        : undefined,
    );

    const data = JSON.parse(await getLastfmArtistTags.invoke({ artist: "Queen" }));

    expect(data).toMatchObject({ found: false, reason: "invalid_request" });
    expect(data).not.toHaveProperty("code");
  });

  it.each([
    ["track tags", () => getLastfmTrackTags.invoke({ title: "Song", artist: " " })],
    ["similar tracks", () => getLastfmSimilarTracks.invoke({ title: "", artist: "Queen" })],
    ["artist info", () => getLastfmArtistInfo.invoke({ artist: "" })],
  ])("%s: an empty name is not sent and is not the source's failure", async (_name, run) => {
    const net = stubFetch(() => undefined);

    const data = JSON.parse(await run());

    expect(net.calls).toHaveLength(0);
    expect(data).toMatchObject({ found: false, reason: "no_input" });
    expect(data).not.toHaveProperty("code");
  });

  it("drops an answer Last.fm's autocorrection gave for another artist", async () => {
    stubFetch((call) =>
      call.url.startsWith(API)
        ? json({
            similarartists: {
              artist: [{ name: "Other", match: "1" }],
              "@attr": { artist: "Ramsey Lewis Trio" },
            },
          })
        : undefined,
    );

    const data = JSON.parse(await getLastfmSimilarArtists.invoke({ artist: "Ramsey Lewis" }));

    expect(data).toMatchObject({ found: false, reason: "other_artist" });
    expect(data).not.toHaveProperty("artists");
  });

  it("keeps an answer for the artist asked for, whatever its case or punctuation", async () => {
    stubFetch((call) =>
      call.url.startsWith(API)
        ? json({
            toptags: {
              tag: [{ name: "funk", count: 90 }],
              "@attr": { artist: "EARTH WIND AND FIRE" },
            },
          })
        : undefined,
    );

    const data = JSON.parse(await getLastfmArtistTags.invoke({ artist: "Earth, Wind & Fire" }));

    expect(data).toEqual({ found: true, tags: [{ name: "funk", count: 90 }] });
  });

  it("uses nothing of a page Last.fm shares between artists of the same name", async () => {
    stubFetch((call) =>
      call.url.startsWith(API)
        ? json({
            artist: {
              name: "Nirvana",
              bio: { summary: "There are multiple artists with this name: 1) a 60s band…" },
              tags: { tag: [{ name: "grunge", count: 100 }] },
            },
          })
        : undefined,
    );

    const data = JSON.parse(await getLastfmArtistInfo.invoke({ artist: "Nirvana" }));

    // Its tags and similar artists mix the artists too: nothing of the page is used.
    expect(data).toMatchObject({ found: false, reason: "shared_page" });
    expect(data).not.toHaveProperty("tags");
  });

  it("reads artist info with no bio, tags or similar artists as nothing found", async () => {
    stubFetch((call) =>
      call.url.startsWith(API) ? json({ artist: { name: "Queen" } }) : undefined,
    );

    const data = JSON.parse(await getLastfmArtistInfo.invoke({ artist: "Queen" }));

    expect(data).toMatchObject({ found: false, reason: "not_found" });
  });
});
