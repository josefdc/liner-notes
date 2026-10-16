/**
 * Engineer node: audio values are measured or null, never estimated.
 *
 * The network is stubbed: Deezer returns a preview clip and the audio analysis service is
 * either down, failing, or returns a measurement. The audio cache is a stub so the test can
 * check what is read from and written to it.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioFeatures } from "../state.js";

const cache = vi.hoisted(() => ({
  getAudio: vi.fn((): unknown => null),
  putAudio: vi.fn(),
}));
vi.mock("../../store/cache.js", () => ({ getCache: () => cache }));

import { engineerNode } from "./engineerNode.js";
import type { SonicAgentStateType } from "../state.js";

const AUDIO_URL = "http://audio.test";
const PREVIEW = "https://cdnt-preview.dzcdn.net/api/1/x.mp3";

type ServiceMode = "down" | "error" | "librosa-only" | "full";
type Reply = Record<string, unknown>;

const LIBROSA_ONLY: Reply = {
  bpm: 116,
  key: "D",
  mode: "Minor",
  energy: 0.72,
  duration: 30,
  source: "analyzed",
  keyMoments: [],
  valence: null,
  danceability: null,
  acousticness: null,
  instrumentalness: null,
};

interface Stub {
  calls: string[];
  analyzeHeaders: Array<Record<string, string>>;
}

function stubNetwork(
  mode: ServiceMode,
  preview: string | null = PREVIEW,
  reply: Reply = LIBROSA_ONLY,
): Stub {
  const stub: Stub = { calls: [], analyzeHeaders: [] };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    stub.calls.push(url);
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
      stub.analyzeHeaders.push({ ...(init?.headers as Record<string, string>) });
      if (mode === "error") return Response.json({ detail: "decode error" }, { status: 500 });
      if (mode === "full") {
        return Response.json({
          ...reply,
          valence: 0.21,
          danceability: 0.64,
          acousticness: 0.05,
          instrumentalness: 0.01,
        });
      }
      return Response.json(reply);
    }
    throw new TypeError(`unexpected fetch in test: ${url}`);
  });
  return stub;
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

/** Runs the node and collects the status text it writes and returns. */
async function run(id: string) {
  const written: string[] = [];
  const config = {
    writer: (event: { message?: string }) => written.push(event.message ?? ""),
  } as never;
  const out = await engineerNode(stateFor(id), config);
  return { out, text: [...written, ...(out.statusMessages ?? [])].join("\n") };
}

const ENV_KEYS = ["AUDIO_ANALYSIS_URL", "AUDIO_SERVICE_TOKEN"] as const;

describe("engineerNode", () => {
  const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) saved[key] = process.env[key];
    process.env.AUDIO_ANALYSIS_URL = AUDIO_URL;
    delete process.env.AUDIO_SERVICE_TOKEN;
    cache.getAudio.mockReset();
    cache.getAudio.mockReturnValue(null);
    cache.putAudio.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    // Restore by deleting keys that were unset, so they do not become the string "undefined".
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns nulls with a reason when the audio service is down, and caches nothing", async () => {
    stubNetwork("down");
    const { out, text } = await run("A");

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
    expect(out.audioFeatures?.measured).toBeUndefined();
    expect(cache.putAudio).not.toHaveBeenCalled();
    expect(text).not.toMatch(/verified|analy[sz]ed|\d+ BPM/i);
  });

  it("gives identical output for the same input across runs", async () => {
    stubNetwork("down");
    const down1 = await engineerNode(stateFor("A"), { writer: () => {} } as never);
    const down2 = await engineerNode(stateFor("A"), { writer: () => {} } as never);
    expect(down2).toEqual(down1);

    stubNetwork("librosa-only");
    const up1 = await engineerNode(stateFor("C"), { writer: () => {} } as never);
    const up2 = await engineerNode(stateFor("C"), { writer: () => {} } as never);
    expect(up2).toEqual(up1);
  });

  it("keeps measured tempo and key, leaves unmeasured features null, and marks the row", async () => {
    stubNetwork("librosa-only");
    const { out, text } = await run("C");

    const expected: AudioFeatures = {
      bpm: 116,
      key: "D Minor",
      energy: 0.72,
      valence: null,
      danceability: null,
      acousticness: null,
      instrumentalness: null,
      confidence: "low",
      keyMoments: [],
      measured: true,
      analyzer: "audio-service",
    };
    expect(out.audioFeatures).toEqual(expected);
    expect(cache.putAudio).toHaveBeenCalledTimes(1);
    expect(cache.putAudio).toHaveBeenCalledWith("C", expected);
    expect(text).not.toMatch(/verified/i);
  });

  it("marks a complete measurement as high confidence, without claiming it is verified", async () => {
    stubNetwork("full");
    const { out, text } = await run("D");
    expect(out.audioFeatures).toMatchObject({
      bpm: 116,
      key: "D Minor",
      valence: 0.21,
      danceability: 0.64,
      acousticness: 0.05,
      instrumentalness: 0.01,
      confidence: "high",
    });
    expect(text).not.toMatch(/verified/i);
  });

  it("finishes the run when the cache write fails, and does not claim it cached", async () => {
    stubNetwork("librosa-only");
    cache.putAudio.mockImplementation(() => {
      throw new Error("NOT NULL constraint failed: audio_cache.energy");
    });
    const { out, text } = await run("C");
    expect(out.audioFeatures).toMatchObject({ bpm: 116, key: "D Minor", measured: true });
    expect(text).not.toMatch(/cache/i);
  });

  describe("cache", () => {
    const oldRandomRow = {
      bpm: 129,
      key: "C Minor",
      energy: 0.6,
      valence: 0.701,
      danceability: 0.553,
      acousticness: 0.2,
      instrumentalness: 0.1,
      confidence: "low",
      keyMoments: [],
    };

    it("ignores a cached row without the measured marker and measures again", async () => {
      const stub = stubNetwork("librosa-only");
      cache.getAudio.mockReturnValue(oldRandomRow);
      const { out } = await run("OLD");
      expect(out.audioFeatures).toMatchObject({ bpm: 116, key: "D Minor", measured: true });
      expect(stub.calls).toContain(`${AUDIO_URL}/analyze`);
    });

    it("ignores an old row even when the service is down", async () => {
      stubNetwork("down");
      cache.getAudio.mockReturnValue(oldRandomRow);
      const { out } = await run("OLD");
      expect(out.audioFeatures).toMatchObject({ bpm: null, key: null });
    });

    it("reuses a cached row that carries the marker", async () => {
      const stub = stubNetwork("down");
      const row = {
        ...oldRandomRow,
        bpm: 116,
        key: "D Minor",
        measured: true,
        analyzer: "audio-service",
      };
      cache.getAudio.mockReturnValue(row);
      const { out } = await run("NEW");
      expect(out.audioFeatures).toEqual(row);
      expect(stub.calls).toEqual([]);
    });
  });

  describe("service replies without a measurement", () => {
    it.each([
      ["bpm 0", { bpm: 0 }],
      ["negative bpm", { bpm: -5 }],
      ["null bpm", { bpm: null }],
      ["missing bpm", { bpm: undefined }],
    ])("treats %s as no tempo", async (_label, change) => {
      stubNetwork("librosa-only", PREVIEW, { ...LIBROSA_ONLY, ...change });
      const { out, text } = await run("T");
      expect(out.audioFeatures).toMatchObject({ bpm: null, unavailableReason: "not_detected" });
      expect(out.audioFeatures?.measured).toBeUndefined();
      expect(cache.putAudio).not.toHaveBeenCalled();
      expect(text).not.toMatch(/\b0 BPM|120 BPM/);
      expect(text).toContain("found no tempo");
      expect(text).not.toContain("BPM and key unavailable");
    });

    it.each([
      ["null key and mode", { key: null, mode: null }],
      ["missing key", { key: undefined }],
      ["empty key", { key: "" }],
      ["key without a mode", { mode: null }],
      ["key with a missing mode", { mode: undefined }],
      ["mode without a key", { key: null, mode: "Minor" }],
      ["an unknown mode", { mode: "Dorian" }],
    ])("treats %s as no key", async (_label, change) => {
      stubNetwork("librosa-only", PREVIEW, { ...LIBROSA_ONLY, ...change });
      const { out, text } = await run("K");
      expect(out.audioFeatures).toMatchObject({
        bpm: 116,
        key: null,
        unavailableReason: "not_detected",
      });
      expect(cache.putAudio).not.toHaveBeenCalled();
      expect(text).not.toMatch(/C Major|D Major/);
      expect(text).toContain("found no key");
      expect(text).not.toContain("BPM and key unavailable");
    });

    it.each([
      ["null energy", { energy: null }, []],
      ["missing energy", { energy: undefined }, []],
      ["energy above 1", { energy: 1.7 }, ["energy"]],
      ["negative energy", { energy: -0.1 }, ["energy"]],
    ])("keeps %s as null", async (_label, change, outOfRange) => {
      stubNetwork("librosa-only", PREVIEW, { ...LIBROSA_ONLY, ...change });
      const { out } = await run("N");
      expect(out.audioFeatures).toMatchObject({ bpm: 116, key: "D Minor", energy: null });
      expect(out.audioFeatures?.outOfRange ?? []).toEqual(outOfRange);
    });

    it("drops audio model scores outside 0..1", async () => {
      stubNetwork("librosa-only", PREVIEW, {
        ...LIBROSA_ONLY,
        valence: 1.2,
        danceability: -0.3,
        acousticness: 0.4,
        instrumentalness: 2,
      });
      const { out } = await run("S");
      expect(out.audioFeatures).toMatchObject({
        valence: null,
        danceability: null,
        acousticness: 0.4,
        instrumentalness: null,
        outOfRange: ["valence", "danceability", "instrumentalness"],
      });
    });

    it.each([
      ["source estimated", { source: "estimated" }],
      ["source missing", { source: undefined }],
    ])("does not treat a reply with %s as a measurement", async (_label, change) => {
      stubNetwork("librosa-only", PREVIEW, { ...LIBROSA_ONLY, ...change });
      const { out } = await run("X");
      expect(out.audioFeatures).toMatchObject({
        bpm: null,
        key: null,
        energy: null,
        unavailableReason: "analysis_failed",
      });
      expect(out.audioFeatures?.measured).toBeUndefined();
      expect(cache.putAudio).not.toHaveBeenCalled();
    });
  });

  it("reports analysis_failed when the service returns an error", async () => {
    stubNetwork("error");
    const { out } = await run("E");
    expect(out.audioFeatures).toMatchObject({
      bpm: null,
      key: null,
      unavailableReason: "analysis_failed",
    });
    expect(cache.putAudio).not.toHaveBeenCalled();
  });

  it("reports no_preview when neither Deezer nor Spotify has a preview", async () => {
    const stub = stubNetwork("full", null);
    const { out } = await run("F");
    expect(out.audioFeatures).toMatchObject({ bpm: null, unavailableReason: "no_preview" });
    expect(stub.calls.some((url) => url.startsWith(AUDIO_URL))).toBe(false);
    expect(cache.putAudio).not.toHaveBeenCalled();
  });

  it("reports preview_rejected for a preview the service would refuse", async () => {
    const stub = stubNetwork("full", "http://cdnt-preview.dzcdn.net/api/1/x.mp3");
    const { out } = await run("G");
    expect(out.audioFeatures).toMatchObject({ bpm: null, unavailableReason: "preview_rejected" });
    expect(stub.calls.some((url) => url.startsWith(AUDIO_URL))).toBe(false);
  });

  it("sends the service token only when it is configured", async () => {
    let stub = stubNetwork("librosa-only");
    await run("H");
    expect(stub.analyzeHeaders[0]).not.toHaveProperty("X-Audio-Token");

    process.env.AUDIO_SERVICE_TOKEN = "test-token";
    stub = stubNetwork("librosa-only");
    await run("H");
    expect(stub.analyzeHeaders[0]).toMatchObject({ "X-Audio-Token": "test-token" });
  });
});
