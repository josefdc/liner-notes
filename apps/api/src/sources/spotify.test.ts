/**
 * Spotify client with a stubbed Web API: ids are checked before any request, an empty search
 * is `[]`, a 429 is reported as a rate limit, concurrent callers share one token refresh, and a
 * request that never answers times out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FetchCall, json, never, stubFetch } from "./testing/fetchStub.js";

vi.hoisted(() => {
  process.env.SPOTIFY_CLIENT_ID = "test-client";
  process.env.SPOTIFY_CLIENT_SECRET = "test-secret";
});

import {
  getArtistTopTracks,
  getTrackDetails,
  searchMultipleTracks,
  SpotifyAuthManager,
} from "./spotify.js";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const API = "https://api.spotify.com/v1";
const TRACK_ID = "3Fcfwhm8oRrBvBZ8KGhtea";

const token = () => json({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 });

const track = (id = TRACK_ID) => ({
  id,
  name: "Ice Ice Baby",
  artists: [{ id: "7GaxyUddsPok8BuhxN6OUW", name: "Vanilla Ice" }],
  album: { name: "To the Extreme", release_date: "1990", images: [] },
  popularity: 70,
  duration_ms: 271_000,
  explicit: false,
  external_urls: { spotify: `https://open.spotify.com/track/${id}` },
});

const searchAnswer = (items: unknown[]) => ({ tracks: { items, total: items.length } });

/** Answers the token request and passes everything else to `api`. */
function spotify(api: (call: FetchCall) => Response | Promise<Response> | undefined) {
  return stubFetch((call) => (call.url === TOKEN_URL ? token() : api(call)));
}

const apiCalls = (calls: FetchCall[]) => calls.filter((c) => c.url !== TOKEN_URL);

describe("Spotify client", () => {
  beforeEach(() => {
    SpotifyAuthManager.getInstance().clearToken();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.SOURCE_TIMEOUT_MS;
  });

  describe("ids are checked before any request", () => {
    it.each([
      "../artists/abc",
      "..%2Fartists%2Fabc",
      `${TRACK_ID}/../../artists/x`,
      `${TRACK_ID}?market=US`,
      "",
    ])("getTrackDetails(%j) is rejected", async (trackId) => {
      const net = stubFetch(() => undefined);

      const result = await getTrackDetails.invoke({ trackId });

      expect(net.calls, "no request, not even for a token").toHaveLength(0);
      expect(result).toMatch(/^Error: /);
    });

    it("getArtistTopTracks rejects a traversal id and a malformed market", async () => {
      const net = stubFetch(() => undefined);

      expect(await getArtistTopTracks.invoke({ artistId: "../tracks/abc" })).toMatch(/^Error: /);
      expect(
        await getArtistTopTracks.invoke({ artistId: "7GaxyUddsPok8BuhxN6OUW", market: "US&x=1" }),
      ).toMatch(/^Error: /);
      expect(net.calls).toHaveLength(0);
    });

    it("a valid id reaches exactly /v1/tracks/{id}", async () => {
      const net = spotify((call) =>
        call.url === `${API}/tracks/${TRACK_ID}` ? json(track()) : undefined,
      );

      const data = JSON.parse(await getTrackDetails.invoke({ trackId: TRACK_ID }));

      expect(apiCalls(net.calls).map((c) => c.url)).toEqual([`${API}/tracks/${TRACK_ID}`]);
      expect(data).toMatchObject({ id: TRACK_ID, title: "Ice Ice Baby", artist: "Vanilla Ice" });
    });
  });

  it("an empty search returns [] as JSON", async () => {
    spotify((call) => (call.url.startsWith(`${API}/search?`) ? json(searchAnswer([])) : undefined));

    const result = await searchMultipleTracks.invoke({ query: "zzzz no such song", limit: 5 });

    expect(result).toBe("[]");
  });

  it("a search returns the candidates as a JSON list", async () => {
    spotify((call) =>
      call.url.startsWith(`${API}/search?`) ? json(searchAnswer([track()])) : undefined,
    );

    const result = JSON.parse(await searchMultipleTracks.invoke({ query: "ice ice baby" }));

    expect(result).toEqual([
      expect.objectContaining({ id: TRACK_ID, title: "Ice Ice Baby", previewUrl: null }),
    ]);
  });

  it("a 429 is reported as a rate limit with the wait Spotify asked for", async () => {
    spotify((call) =>
      call.url.startsWith(`${API}/search?`)
        ? json(
            { error: { status: 429, message: "API rate limit exceeded" } },
            {
              status: 429,
              headers: { "Retry-After": "3" },
            },
          )
        : undefined,
    );

    const result = await searchMultipleTracks.invoke({ query: "ice ice baby" });

    expect(result).toMatch(/^Error: /);
    expect(result).toContain("429");
    expect(result).toContain("retry after 3 s");
    // The scout retries on this text (scoutNode: "Rate limit" or "429").
    expect(result.includes("Rate limit") || result.includes("429")).toBe(true);
  });

  it("concurrent callers share one token refresh", async () => {
    let releaseToken!: () => void;
    const tokenGate = new Promise<void>((r) => {
      releaseToken = r;
    });
    const net = stubFetch(async (call) => {
      if (call.url === TOKEN_URL) {
        await tokenGate;
        return token();
      }
      return call.url.startsWith(`${API}/tracks/`) ? json(track()) : undefined;
    });

    const both = Promise.all([
      getTrackDetails.invoke({ trackId: TRACK_ID }),
      getTrackDetails.invoke({ trackId: TRACK_ID }),
    ]);
    await vi.waitFor(() => expect(net.calls.length).toBeGreaterThan(0));
    releaseToken();
    const results = await both;

    expect(net.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
    for (const r of results) expect(JSON.parse(r).id).toBe(TRACK_ID);
  });

  it("a request that never answers times out", { timeout: 3000 }, async () => {
    process.env.SOURCE_TIMEOUT_MS = "50";
    spotify((call) => (call.url.startsWith(`${API}/search?`) ? never(call) : undefined));

    const result = await searchMultipleTracks.invoke({ query: "ice ice baby" });

    expect(result).toMatch(/^Error: .*no answer within 50 ms/);
  });

  it("a 401 refreshes the token once and retries", async () => {
    let searches = 0;
    const net = spotify((call) => {
      if (!call.url.startsWith(`${API}/search?`)) return undefined;
      searches++;
      return searches === 1
        ? json({ error: { status: 401, message: "The access token expired" } }, { status: 401 })
        : json(searchAnswer([track()]));
    });

    const result = JSON.parse(await searchMultipleTracks.invoke({ query: "ice ice baby" }));

    expect(result).toHaveLength(1);
    expect(net.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
  });
});
