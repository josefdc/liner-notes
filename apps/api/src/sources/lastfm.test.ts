/**
 * Last.fm tools without an API key
 *
 * Every Last.fm tool must report that the source is not configured instead of
 * throwing or returning made-up data, and must not touch the network.
 *
 * Run: npm run test:lastfm -w apps/api
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getLastfmArtistInfo,
  getLastfmArtistTags,
  getLastfmSimilarArtists,
  getLastfmSimilarTracks,
  getLastfmTrackTags,
} from "./lastfm.js";

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
  const fetchSpy = vi.fn(async () => {
    throw new Error("network access is not expected without an API key");
  });
  let savedKey: string | undefined;

  beforeAll(() => {
    // Importing the tools loads apps/api/.env; remove the key so the no-key path is
    // exercised regardless of local configuration.
    savedKey = process.env.LASTFM_API_KEY;
    delete process.env.LASTFM_API_KEY;
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
    if (savedKey !== undefined) process.env.LASTFM_API_KEY = savedKey;
  });

  it.each(cases)("%s reports that the source is not configured", async (_name, tool, input) => {
    const data = JSON.parse(String(await tool.invoke(input as never)));
    expect(data.error).toMatch(/not configured/);
    expect(data.found).not.toBe(true);
    for (const key of ["tags", "tracks", "artists", "name"]) {
      expect(data, `no "${key}" without a key`).not.toHaveProperty(key);
    }
  });

  it("makes no network call", () => {
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
