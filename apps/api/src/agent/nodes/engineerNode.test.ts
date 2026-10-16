/**
 * Engineer node: audio values are measured or null, never estimated.
 *
 * The network is stubbed: Deezer returns a preview clip and the audio analysis service is
 * either down, failing, or returns a measurement. The audio cache is a stub so the test can
 * check what is written to it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({
  getAudio: vi.fn(() => null),
  putAudio: vi.fn(),
}));
vi.mock("../../store/cache.js", () => ({ getCache: () => cache }));

import { engineerNode } from "./engineerNode.js";
import type { SonicAgentStateType } from "../state.js";

const AUDIO_URL = "http://audio.test";
const PREVIEW = "https://cdnt-preview.dzcdn.net/api/1/x.mp3";

type ServiceMode = "down" | "error" | "librosa-only" | "full";

function stubNetwork(mode: ServiceMode, preview: string | null = PREVIEW) {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    if (url.startsWith("https://api.deezer.com/search/track")) {
      return Response.json({
        total: preview ? 1 : 0,
        data: preview
          ? [
              {
                id: 1,
                title: "Ice Ice Baby",
                preview,
                duration: 270,
                artist: { id: 1, name: "Vanilla Ice" },
                album: { id: 1, title: "To the Extreme", cover_medium: "" },
              },
            ]
          : [],
      });
    }
    if (url === `${AUDIO_URL}/health`) {
      if (mode === "down") throw new TypeError("fetch failed");
      return Response.json({ status: "ok" });
    }
    if (url === `${AUDIO_URL}/analyze`) {
      if (mode === "error") return Response.json({ detail: "decode error" }, { status: 500 });
      const perceptual =
        mode === "full"
          ? { valence: 0.21, danceability: 0.64, acousticness: 0.05, instrumentalness: 0.01 }
          : { valence: null, danceability: null, acousticness: null, instrumentalness: null };
      return Response.json({
        bpm: 116,
        key: "D",
        mode: "Minor",
        energy: 0.72,
        duration: 30,
        source: "analyzed",
        keyMoments: [],
        ...perceptual,
      });
    }
    throw new TypeError(`unexpected fetch in test: ${url}`);
  });
  return calls;
}

function stateFor(id: string): SonicAgentStateType {
  return {
    spotifyData: {
      id,
      title: "Ice Ice Baby",
      artist: "Vanilla Ice",
      artistIds: [],
      album: "To the Extreme",
      releaseDate: "1990-09-10",
      coverUrl: "",
      popularity: 70,
      duration: "4:30",
      durationMs: 270000,
      explicit: false,
      spotifyUrl: "",
      previewUrl: null,
    },
  } as unknown as SonicAgentStateType;
}

const config = { writer: () => {} } as never;

describe("engineerNode", () => {
  let savedUrl: string | undefined;

  beforeEach(() => {
    savedUrl = process.env.AUDIO_ANALYSIS_URL;
    process.env.AUDIO_ANALYSIS_URL = AUDIO_URL;
    cache.getAudio.mockClear();
    cache.putAudio.mockClear();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.env.AUDIO_ANALYSIS_URL = savedUrl;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns nulls with a reason when the audio service is down, and caches nothing", async () => {
    stubNetwork("down");
    const out = await engineerNode(stateFor("A"), config);

    expect(out.audioFeatures).toMatchObject({
      bpm: null,
      key: null,
      energy: null,
      valence: null,
      danceability: null,
      acousticness: null,
      instrumentalness: null,
      unavailableReason: "service_unavailable",
    });
    expect(cache.putAudio).not.toHaveBeenCalled();
    expect(out.statusMessages?.join(" ")).not.toMatch(/verified|analy[sz]ed|BPM, /i);
  });

  it("gives identical output for the same input across runs", async () => {
    stubNetwork("down");
    const down1 = await engineerNode(stateFor("A"), config);
    const down2 = await engineerNode(stateFor("A"), config);
    expect(down2).toEqual(down1);

    stubNetwork("librosa-only");
    const up1 = await engineerNode(stateFor("C"), config);
    const up2 = await engineerNode(stateFor("C"), config);
    expect(up2).toEqual(up1);
  });

  it("keeps measured tempo and key and leaves unmeasured perceptual features null", async () => {
    stubNetwork("librosa-only");
    const out = await engineerNode(stateFor("C"), config);

    expect(out.audioFeatures).toEqual({
      bpm: 116,
      key: "D Minor",
      energy: 0.72,
      valence: null,
      danceability: null,
      acousticness: null,
      instrumentalness: null,
      confidence: "low",
      keyMoments: [],
    });
    expect(cache.putAudio).toHaveBeenCalledTimes(1);
    expect(cache.putAudio).toHaveBeenCalledWith("C", out.audioFeatures);
  });

  it("marks a complete measurement as high confidence", async () => {
    stubNetwork("full");
    const out = await engineerNode(stateFor("D"), config);
    expect(out.audioFeatures).toMatchObject({
      bpm: 116,
      key: "D Minor",
      valence: 0.21,
      danceability: 0.64,
      acousticness: 0.05,
      instrumentalness: 0.01,
      confidence: "high",
    });
  });

  it("reports analysis_failed when the service returns an error", async () => {
    stubNetwork("error");
    const out = await engineerNode(stateFor("E"), config);
    expect(out.audioFeatures).toMatchObject({
      bpm: null,
      key: null,
      unavailableReason: "analysis_failed",
    });
    expect(cache.putAudio).not.toHaveBeenCalled();
  });

  it("reports no_preview when neither Deezer nor Spotify has a preview", async () => {
    const calls = stubNetwork("full", null);
    const out = await engineerNode(stateFor("F"), config);
    expect(out.audioFeatures).toMatchObject({ bpm: null, unavailableReason: "no_preview" });
    expect(calls.some((url) => url.startsWith(AUDIO_URL))).toBe(false);
    expect(cache.putAudio).not.toHaveBeenCalled();
  });

  it("does not send a preview from an unknown host to the analysis service", async () => {
    const calls = stubNetwork("full", "http://127.0.0.1:8080/clip.mp3?x=dzcdn.net");
    const out = await engineerNode(stateFor("G"), config);
    expect(out.audioFeatures).toMatchObject({ bpm: null, unavailableReason: "preview_rejected" });
    expect(calls.some((url) => url.startsWith(AUDIO_URL))).toBe(false);
  });
});
