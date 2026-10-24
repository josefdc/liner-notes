/**
 * Spotify client with a stubbed Web API: ids are checked before any request, an empty search
 * is `[]`, a 429 is reported as a rate limit, concurrent callers share one token refresh, and a
 * request that never answers times out.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

    it("a valid id reaches exactly /v1/tracks/{id}", async () => {
      const net = spotify((call) =>
        call.url === `${API}/tracks/${TRACK_ID}` ? json(track()) : undefined,
      );

      const data = JSON.parse(await getTrackDetails.invoke({ trackId: TRACK_ID }));

      expect(apiCalls(net.calls).map((c) => c.url)).toEqual([`${API}/tracks/${TRACK_ID}`]);
      expect(data).toMatchObject({ id: TRACK_ID, title: "Ice Ice Baby", artist: "Vanilla Ice" });
    });
  });

  it("keeps a multi-artist track's artists one by one beside the joined name", async () => {
    spotify((call) =>
      call.url === `${API}/tracks/${TRACK_ID}`
        ? json({
            ...track(),
            artists: [
              { id: "a1", name: "Ramsey Lewis" },
              { id: "a2", name: "Earth, Wind & Fire" },
            ],
          })
        : undefined,
    );

    const data = JSON.parse(await getTrackDetails.invoke({ trackId: TRACK_ID }));

    expect(data).toMatchObject({
      artist: "Ramsey Lewis, Earth, Wind & Fire",
      artistNames: ["Ramsey Lewis", "Earth, Wind & Fire"],
      artistIds: ["a1", "a2"],
    });
  });

  describe("identity", () => {
    const withIdentity = () => ({
      ...track(),
      external_ids: { isrc: "USAT29900609" },
      preview_url: "https://p.scdn.co/mp3-preview/abc",
    });

    it("a search keeps the ISRC and the preview Spotify gave", async () => {
      spotify((call) =>
        call.url.startsWith(`${API}/search?`) ? json(searchAnswer([withIdentity()])) : undefined,
      );

      const [result] = JSON.parse(await searchMultipleTracks.invoke({ query: "ice ice baby" }));

      expect(result).toMatchObject({
        id: TRACK_ID,
        isrc: "USAT29900609",
        previewUrl: "https://p.scdn.co/mp3-preview/abc",
      });
    });

    it("the track details keep the ISRC", async () => {
      spotify((call) =>
        call.url === `${API}/tracks/${TRACK_ID}` ? json(withIdentity()) : undefined,
      );

      const data = JSON.parse(await getTrackDetails.invoke({ trackId: TRACK_ID }));

      expect(data).toMatchObject({ id: TRACK_ID, isrc: "USAT29900609" });
    });

    it("an ISRC that is missing or malformed is null, never guessed", async () => {
      spotify((call) =>
        call.url.startsWith(`${API}/search?`)
          ? json(
              searchAnswer([
                track("0000000000000000000001"),
                { ...track("0000000000000000000002"), external_ids: { isrc: "not an isrc" } },
                { ...track("0000000000000000000003"), external_ids: { isrc: "us-at2-99-00609" } },
              ]),
            )
          : undefined,
      );

      const results = JSON.parse(await searchMultipleTracks.invoke({ query: "ice ice baby" }));

      expect(results.map((r: { isrc: unknown }) => r.isrc)).toEqual([null, null, "USAT29900609"]);
    });

    it.each([
      ["null", { popularity: null }],
      ["missing", {}],
      ["a number", { popularity: 70 }],
    ])(
      "a search whose results have popularity %s keeps every result and reports no popularity",
      async (_label, popularity) => {
        const { popularity: _given, ...base } = track();
        spotify((call) =>
          call.url.startsWith(`${API}/search?`)
            ? json(
                searchAnswer([
                  { ...base, ...popularity },
                  { ...base, ...popularity, id: "0000000000000000000002" },
                ]),
              )
            : undefined,
        );

        const result = await searchMultipleTracks.invoke({ query: "ice ice baby" });

        const tracks = JSON.parse(result);
        expect(tracks).toHaveLength(2);
        for (const t of tracks) expect(t).not.toHaveProperty("popularity");
      },
    );

    it("a recorded search keeps the ISRC but neither the preview nor the popularity", async () => {
      const dir = mkdtempSync(join(tmpdir(), "spotify-cassette-"));
      process.env.SOURCE_CASSETTE = "record";
      process.env.SOURCE_CASSETTE_DIR = dir;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      spotify((call) =>
        call.url.startsWith(`${API}/search?`) ? json(searchAnswer([withIdentity()])) : undefined,
      );
      try {
        await searchMultipleTracks.invoke({ query: "ice ice baby" });

        const recorded = readdirSync(dir)
          .map((f) => readFileSync(join(dir, f), "utf8"))
          .join("\n");
        expect(recorded).toContain("USAT29900609");
        expect(recorded).not.toContain("mp3-preview");
        expect(recorded).not.toContain("popularity");
      } finally {
        delete process.env.SOURCE_CASSETTE;
        delete process.env.SOURCE_CASSETTE_DIR;
        rmSync(dir, { recursive: true, force: true });
      }
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

  it("artist top tracks (removed by Spotify) makes no request and reports unavailable", async () => {
    const net = stubFetch(() => undefined);

    const data = JSON.parse(
      await getArtistTopTracks.invoke({ artistId: "7GaxyUddsPok8BuhxN6OUW" }),
    );

    expect(net.calls).toHaveLength(0);
    expect(data).toMatchObject({ topTracks: [], found: false, unavailable: true });
  });

  it("caches the token while it is valid", async () => {
    const net = spotify((call) =>
      call.url.startsWith(`${API}/tracks/`) ? json(track()) : undefined,
    );

    await getTrackDetails.invoke({ trackId: TRACK_ID });
    await getTrackDetails.invoke({ trackId: TRACK_ID });

    expect(net.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
  });

  it("refreshes a token that expires within a minute", async () => {
    const net = stubFetch((call) => {
      if (call.url === TOKEN_URL) {
        return json({ access_token: "short-lived", token_type: "Bearer", expires_in: 30 });
      }
      return call.url.startsWith(`${API}/tracks/`) ? json(track()) : undefined;
    });

    await getTrackDetails.invoke({ trackId: TRACK_ID });
    await getTrackDetails.invoke({ trackId: TRACK_ID });

    expect(net.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
  });

  it.each([
    [50, "10"],
    [0, "1"],
    [-3, "1"],
    [3, "3"],
  ])("a search limit of %i is sent as %s", async (limit, sent) => {
    const net = spotify((call) =>
      call.url.startsWith(`${API}/search?`) ? json(searchAnswer([])) : undefined,
    );

    await searchMultipleTracks.invoke({ query: "ice ice baby", limit });

    const search = apiCalls(net.calls)[0];
    expect(new URL(search.url).searchParams.get("limit")).toBe(sent);
  });

  it("a 401 that arrives after a refresh keeps the fresh token", async () => {
    let tokens = 0;
    let releaseLate!: () => void;
    const late = new Promise<void>((r) => {
      releaseLate = r;
    });
    let staleCalls = 0;
    const net = stubFetch(async (call) => {
      if (call.url === TOKEN_URL) {
        tokens++;
        return json({ access_token: `token-${tokens}`, token_type: "Bearer", expires_in: 3600 });
      }
      if (!call.url.startsWith(`${API}/tracks/`)) return undefined;
      if (call.headers.authorization === "Bearer token-1") {
        staleCalls++;
        // The first request is refused at once; the second one's refusal arrives late.
        if (staleCalls === 2) await late;
        return json({ error: { status: 401, message: "expired" } }, { status: 401 });
      }
      return json(track());
    });

    const first = getTrackDetails.invoke({ trackId: TRACK_ID });
    const second = getTrackDetails.invoke({ trackId: TRACK_ID });
    await first;
    releaseLate();
    await second;

    expect(net.calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(2);
  });

  it("a recorded token exchange keeps neither the access token nor the client secret", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spotify-cassette-"));
    process.env.SOURCE_CASSETTE = "record";
    process.env.SOURCE_CASSETTE_DIR = dir;
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch((call) => {
      if (call.url === TOKEN_URL) {
        return json({
          access_token: "live-access-token-0123456789",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      return call.url.startsWith(`${API}/search?`) ? json(searchAnswer([track()])) : undefined;
    });
    try {
      await searchMultipleTracks.invoke({ query: "ice ice baby" });

      const recorded = readdirSync(dir)
        .map((f) => readFileSync(join(dir, f), "utf8"))
        .join("\n");
      expect(recorded).toContain("accounts.spotify.com/api/token");
      expect(recorded).not.toContain("live-access-token-0123456789");
      expect(recorded).not.toContain("test-secret");
      expect(recorded).not.toContain(Buffer.from("test-client:test-secret").toString("base64"));
    } finally {
      delete process.env.SOURCE_CASSETTE;
      delete process.env.SOURCE_CASSETTE_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
