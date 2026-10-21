/**
 * Artwork enricher: its Spotify requests carry the run's signal, and a run cancelled while an
 * answer arrives caches no artwork. The network and the cache are stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ getArtwork: vi.fn(), putArtwork: vi.fn() }));
vi.mock("../store/cache.js", () => ({ getCache: () => cache }));

import { type FetchCall, json, stubFetch } from "../sources/testing/fetchStub.js";
import { enrichGenealogyWithArtwork } from "./enricher.js";

const genealogy = {
  nodes: [
    { id: "current", group: 1, label: "Song", size: 40 },
    { id: "n1", group: 4, label: "Other - Artist", size: 22 },
  ],
  links: [],
};

const hit = {
  tracks: {
    items: [
      {
        id: "x",
        name: "Other",
        preview_url: null,
        album: { images: [{ url: "https://i.scdn.co/image/x" }] },
        external_urls: { spotify: "https://open.spotify.com/track/x" },
        artists: [{ name: "Artist" }],
      },
    ],
  },
};

/** Spotify answers the search with `answer`, after the run is cancelled. */
function cancelledWhileAnswering(answer: unknown) {
  const controller = new AbortController();
  const net = stubFetch((call: FetchCall) => {
    if (call.url === "https://accounts.spotify.com/api/token") {
      return json({ access_token: "t", token_type: "Bearer", expires_in: 3600 });
    }
    if (call.url.startsWith("https://api.spotify.com/v1/search")) {
      controller.abort();
      return json(answer);
    }
    return undefined;
  });
  return { controller, net };
}

beforeEach(() => {
  process.env.SPOTIFY_CLIENT_ID = "test-client";
  process.env.SPOTIFY_CLIENT_SECRET = "test-secret";
  cache.getArtwork.mockReset();
  cache.putArtwork.mockReset();
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("enrichGenealogyWithArtwork when the run is cancelled", () => {
  it.each([
    ["a track was found", hit],
    ["no track was found", { tracks: { items: [] } }],
  ])("caches no artwork when %s after the cancel", async (_label, answer) => {
    const { controller, net } = cancelledWhileAnswering(answer);

    await enrichGenealogyWithArtwork(genealogy, "https://i.scdn.co/image/c", controller.signal);

    expect(cache.putArtwork).not.toHaveBeenCalled();
    const search = net.calls.find((call) => call.url.startsWith("https://api.spotify.com/"));
    expect(search?.signal).toBe(controller.signal);
  });

  it("caches the artwork of a run that goes on", async () => {
    stubFetch((call: FetchCall) =>
      call.url === "https://accounts.spotify.com/api/token"
        ? json({ access_token: "t", token_type: "Bearer", expires_in: 3600 })
        : json(hit),
    );

    await enrichGenealogyWithArtwork(
      genealogy,
      "https://i.scdn.co/image/c",
      new AbortController().signal,
    );

    expect(cache.putArtwork).toHaveBeenCalledTimes(1);
  });
});
