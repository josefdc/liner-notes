/**
 * A cancelled run stops the HTTP requests its tools started: every tool on a graph path reads
 * the run's signal from LangChain's config and passes it to its requests, and a tool called
 * for a cancelled run rejects instead of reporting a source failure. The network is stubbed:
 * the request under test never answers until its signal aborts.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type FetchCall, json, never, stubFetch } from "./testing/fetchStub.js";

vi.hoisted(() => {
  process.env.SPOTIFY_CLIENT_ID = "test-client";
  process.env.SPOTIFY_CLIENT_SECRET = "test-secret";
});

import { analyzeAudioPreview } from "./audio.js";
import { searchDeezerPreview } from "./deezer.js";
import { getLastfmTrackTags } from "./lastfm.js";
import { getListenBrainzSimilarArtists } from "./listenbrainz.js";
import { getMusicBrainzRelations, MusicBrainzRateLimiter } from "./musicbrainz.js";
import { searchProductionHistory, searchSamples } from "./search.js";
import { getTrackDetails, SpotifyAuthManager, searchMultipleTracks } from "./spotify.js";

const SERVICE = "http://audio.test:3002";
const PREVIEW_CLIP = "https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/clip.mp3?hdnea=exp=1";
const MBID = "5441c29d-3602-4898-b1a1-b77fa23b8e50";

const deezerHit = () =>
  json({
    total: 1,
    data: [
      {
        id: 1,
        title: "Ice Ice Baby",
        preview: PREVIEW_CLIP,
        duration: 270,
        artist: { id: 1, name: "Vanilla Ice" },
        album: { id: 1, title: "To the Extreme", cover_medium: "" },
      },
    ],
  });

const deezerNoData = () =>
  json({ error: { type: "DataException", message: "no data", code: 800 } });

const ICE_ICE_BABY = {
  title: "Ice Ice Baby",
  artist: "Vanilla Ice",
  isrc: "USSB29000129",
  durationMs: 270_000,
};

/**
 * Starts `run` with a fresh signal; the request matching `target` hangs, and the signal is
 * aborted once it was sent. Returns that request and how `run` settled.
 */
async function cancelDuring(
  target: (url: string) => boolean,
  run: (signal: AbortSignal) => Promise<unknown>,
  answer: (call: FetchCall) => Response | undefined = () => undefined,
) {
  const controller = new AbortController();
  let sent: FetchCall | undefined;
  stubFetch((call) => {
    if (target(call.url)) {
      sent = call;
      setTimeout(() => controller.abort(), 0);
      return never(call);
    }
    return answer(call);
  });
  const outcome = await run(controller.signal).then(
    (value) => ({ resolved: value }),
    (error: unknown) => ({ rejected: error }),
  );
  return { sent, outcome };
}

describe("tools stop their requests when the run is cancelled", () => {
  beforeAll(() => {
    MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
  });
  beforeEach(() => {
    process.env.TAVILY_API_KEY = "tvly-test-key";
    process.env.LASTFM_API_KEY = "test-lastfm-key";
    process.env.AUDIO_ANALYSIS_URL = SERVICE;
    SpotifyAuthManager.getInstance().clearToken();
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
  });
  afterEach(() => {
    delete process.env.TAVILY_API_KEY;
    delete process.env.LASTFM_API_KEY;
    delete process.env.AUDIO_ANALYSIS_URL;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each([
    ["searchSamples", searchSamples],
    ["searchProductionHistory", searchProductionHistory],
  ])("%s: the web search request", async (_name, tool) => {
    const { sent, outcome } = await cancelDuring(
      (url) => url === "https://api.tavily.com/search",
      (signal) => tool.invoke({ songTitle: "Ice Ice Baby", artistName: "Vanilla Ice" }, { signal }),
    );
    expect(sent?.signal?.aborted).toBe(true);
    expect(outcome).toHaveProperty("rejected");
  });

  it("analyzeAudioPreview: the audio service's analysis request", async () => {
    const { sent, outcome } = await cancelDuring(
      (url) => url === `${SERVICE}/analyze`,
      (signal) => analyzeAudioPreview.invoke(ICE_ICE_BABY, { signal }),
      (call) => {
        if (call.url.startsWith("https://api.deezer.com/track/isrc:")) return deezerNoData();
        if (call.url.startsWith("https://api.deezer.com/search/track?")) return deezerHit();
        if (call.url === `${SERVICE}/health`) return json({ status: "ok" });
        return undefined;
      },
    );
    expect(sent?.signal?.aborted).toBe(true);
    expect(outcome).toHaveProperty("rejected");
    // Not reported as a failed analysis: the run is gone.
    await new Promise((resolve) => setTimeout(resolve, 20));
    const logged = vi.mocked(console.error).mock.calls.map((args) => String(args[0]));
    expect(logged.some((line) => line.includes("Analysis failed"))).toBe(false);
  });

  it.each([
    ["the lookup by ISRC", "https://api.deezer.com/track/isrc:"],
    ["the search", "https://api.deezer.com/search/track?"],
  ])("analyzeAudioPreview: the Deezer preview, %s", async (_label, target) => {
    const { sent, outcome } = await cancelDuring(
      (url) => url.startsWith(target),
      (signal) => analyzeAudioPreview.invoke(ICE_ICE_BABY, { signal }),
      (call) =>
        call.url.startsWith("https://api.deezer.com/track/isrc:") ? deezerNoData() : undefined,
    );
    expect(sent?.signal?.aborted).toBe(true);
    expect(outcome).toHaveProperty("rejected");
  });

  it.each([
    ["the lookup by ISRC", "https://api.deezer.com/track/isrc:"],
    ["the lookup by id", "https://api.deezer.com/track/2"],
    ["the search", "https://api.deezer.com/search/track?"],
  ])("searchDeezerPreview: %s", async (_label, target) => {
    const { sent, outcome } = await cancelDuring(
      (url) => url.startsWith(target),
      (signal) => searchDeezerPreview.invoke(ICE_ICE_BABY, { signal }),
      (call) =>
        call.url.startsWith("https://api.deezer.com/track/isrc:")
          ? json({ id: 1, title: "Ice Ice Baby", readable: false, alternative: { id: 2 } })
          : call.url === "https://api.deezer.com/track/2"
            ? deezerNoData()
            : undefined,
    );
    expect(sent?.url.startsWith(target)).toBe(true);
    expect(sent?.signal?.aborted).toBe(true);
    expect(outcome).toHaveProperty("rejected");
  });

  it.each([
    [
      "searchMultipleTracks",
      (signal: AbortSignal) =>
        searchMultipleTracks.invoke({ query: "ice ice baby", limit: 5 }, { signal }),
    ],
    [
      "getTrackDetails",
      (signal: AbortSignal) =>
        getTrackDetails.invoke({ trackId: "3Fcfwhm8oRrBvBZ8KGhtea" }, { signal }),
    ],
  ])("%s: the Spotify Web API request", async (_name, run) => {
    const { sent, outcome } = await cancelDuring(
      (url) => url.startsWith("https://api.spotify.com/v1/"),
      run,
      (call) =>
        call.url === "https://accounts.spotify.com/api/token"
          ? json({ access_token: "test-token", token_type: "Bearer", expires_in: 3600 })
          : undefined,
    );
    expect(sent?.signal?.aborted).toBe(true);
    expect(outcome).toHaveProperty("rejected");
  });

  it("getLastfmTrackTags: the Last.fm request", async () => {
    const { sent, outcome } = await cancelDuring(
      (url) => url.startsWith("https://ws.audioscrobbler.com/2.0/"),
      (signal) => getLastfmTrackTags.invoke({ title: "Ice", artist: "Vanilla Ice" }, { signal }),
    );
    expect(sent?.signal?.aborted).toBe(true);
    expect(outcome).toHaveProperty("rejected");
  });

  it("getListenBrainzSimilarArtists: the ListenBrainz request", async () => {
    const { sent, outcome } = await cancelDuring(
      (url) => url.startsWith("https://labs.api.listenbrainz.org/"),
      (signal) => getListenBrainzSimilarArtists.invoke({ artistMbid: MBID }, { signal }),
    );
    expect(sent?.signal?.aborted).toBe(true);
    expect(outcome).toHaveProperty("rejected");
  });

  it("getMusicBrainzRelations: the MusicBrainz request", async () => {
    const { sent, outcome } = await cancelDuring(
      (url) => url.startsWith("https://musicbrainz.org/ws/2/"),
      (signal) =>
        getMusicBrainzRelations.invoke(
          { title: "Ice Ice Baby", artist: "Vanilla Ice" },
          { signal },
        ),
    );
    expect(sent?.signal?.aborted).toBe(true);
    expect(outcome).toHaveProperty("rejected");
  });
});
