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
  const savedWarn = console.warn;
  const warnings: string[] = [];

  beforeAll(() => {
    console.warn = (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    };
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
    console.warn = savedWarn;
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
    for (const key of ["tags", "tracks", "artists", "name"]) {
      expect(data, `no "${key}" without a key`).not.toHaveProperty(key);
    }
  });

  it("made no network call in any case", () => {
    expect(networkCalls).toBe(0);
  });

  it("reported the missing key once", () => {
    expect(warnings.filter((line) => line.includes("LASTFM_API_KEY"))).toHaveLength(1);
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

  it("keeps Last.fm's error message from an HTTP error", async () => {
    stubFetch((call) =>
      call.url.startsWith(API)
        ? json({ error: 6, message: "Track not found", links: [] }, { status: 400 })
        : undefined,
    );

    const data = JSON.parse(await getLastfmTrackTags.invoke({ title: "Nope", artist: "Nobody" }));

    expect(data.found).toBe(false);
    expect(data.error).toContain("Track not found");
    expect(data).not.toHaveProperty("tags");
  });
});
