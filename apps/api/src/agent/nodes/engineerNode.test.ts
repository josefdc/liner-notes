/**
 * Engineer node: it leaves the audio service's v2 block (or why there is none) and never
 * estimates a value; the audio cache is read and written by track key and analyzer version.
 *
 * The network is stubbed: Deezer returns a preview clip and the audio analysis service is
 * either down, failing, or returns a measurement. The audio cache is a stub so the test can
 * check what is read from and written to it.
 */

import type { AudioFeatures } from "@liner-notes/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioMeasurement } from "../state.js";
import {
  ANALYZER_VERSION,
  audioV2,
  gatedV2,
  ISRC_MATCH,
  serviceAnswer,
  signalOnlyV2,
} from "../testing/measuredAudio.js";

const cache = vi.hoisted(() => ({
  getAudio: vi.fn((..._args: unknown[]): unknown => null),
  putAudio: vi.fn(),
}));
vi.mock("../../store/cache.js", () => ({ getCache: () => cache }));

import { engineerNode } from "./engineerNode.js";
import type { SonicAgentStateType } from "../state.js";

const AUDIO_URL = "http://audio.test";
const PREVIEW = "https://cdnt-preview.dzcdn.net/api/1/x.mp3";

type ServiceMode = "down" | "error" | "up";

/** Tempo and key without the models (the service's degraded state). */
const SIGNAL_ONLY = signalOnlyV2();

interface Stub {
  calls: string[];
  analyzeHeaders: Array<Record<string, string>>;
}

/** What Deezer answers for the ISRC lookup and the search (by default "no data" and one hit). */
const deezer: { isrc: unknown; search: unknown[] | null } = { isrc: null, search: null };

const deezerEntry = (id: number, title: string, artist: string, preview: string) => ({
  id,
  title,
  preview,
  readable: true,
  duration: 270,
  artist: { id: 1, name: artist },
  album: { id: 1, title: "To the Extreme", cover_medium: "" },
});

/** The network: Deezer, and the service's /health (with its version) and /analyze. */
function stubNetwork(
  mode: ServiceMode,
  preview: string | null = PREVIEW,
  answer: unknown = serviceAnswer(SIGNAL_ONLY),
  health: unknown = { status: "degraded", analyzer_version: "2.1.0+essentia", models: false },
): Stub {
  const stub: Stub = { calls: [], analyzeHeaders: [] };
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    stub.calls.push(url);
    if (url.startsWith("https://api.deezer.com/track/isrc:")) {
      return Response.json(deezer.isrc ?? { error: { code: 800, message: "no data" } });
    }
    if (url.startsWith("https://api.deezer.com/search/track")) {
      const data =
        deezer.search ?? (preview ? [deezerEntry(1, "Ice Ice Baby", "Vanilla Ice", preview)] : []);
      return Response.json({ total: data.length, data });
    }
    if (url === `${AUDIO_URL}/health`) {
      if (mode === "down") throw new TypeError("fetch failed");
      return Response.json(health);
    }
    if (url === `${AUDIO_URL}/analyze`) {
      stub.analyzeHeaders.push({ ...(init?.headers as Record<string, string>) });
      if (mode === "error") return Response.json({ detail: "decode error" }, { status: 500 });
      return Response.json(answer);
    }
    throw new TypeError(`unexpected fetch in test: ${url}`);
  });
  return stub;
}

/** The measurement the engineer leaves for `block`, measured on the search-matched clip. */
const searchMeasured = (block: AudioFeatures): AudioMeasurement => ({
  audio: block,
  previewMatch: { provider: "deezer", method: "search", deezerId: 1, score: 1 },
});

function stateFor(id: string, isrc: string | null = null): SonicAgentStateType {
  return {
    isrc,
    spotifyData: {
      id,
      title: "Ice Ice Baby",
      artist: "Vanilla Ice",
      artistIds: [],
      album: "To the Extreme",
      releaseDate: "1990-09-10",
      coverUrl: "",
      duration: "4:30",
      durationMs: 270000,
      explicit: false,
      spotifyUrl: "",
      previewUrl: null,
    },
  } as unknown as SonicAgentStateType;
}

/** Runs the node and collects the status text it writes and returns. */
async function run(id: string, isrc: string | null = null) {
  const written: string[] = [];
  const config = {
    writer: (event: { message?: string }) => written.push(event.message ?? ""),
  } as never;
  const out = await engineerNode(stateFor(id, isrc), config);
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
    deezer.isrc = null;
    deezer.search = null;
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

  it("leaves no measurement and a reason when the audio service is down, and caches nothing", async () => {
    const stub = stubNetwork("down");
    const { out, text } = await run("A");

    expect(out.audioFeatures).toEqual({
      audio: null,
      unavailableReason: "service_unavailable",
      unavailableDetail: "Audio analysis service did not respond",
    });
    // Without the service's analyzer version the cache is not read.
    expect(cache.getAudio).not.toHaveBeenCalled();
    expect(cache.putAudio).not.toHaveBeenCalled();
    expect(stub.calls.filter((url) => url === `${AUDIO_URL}/health`)).toHaveLength(2);
    expect(text).not.toMatch(/verified|analy[sz]ed|\d+ BPM/i);
  });

  it("gives identical output for the same input across runs", async () => {
    stubNetwork("down");
    const down1 = await engineerNode(stateFor("A"), { writer: () => {} } as never);
    const down2 = await engineerNode(stateFor("A"), { writer: () => {} } as never);
    expect(down2).toEqual(down1);

    stubNetwork("up");
    const up1 = await engineerNode(stateFor("C"), { writer: () => {} } as never);
    const up2 = await engineerNode(stateFor("C"), { writer: () => {} } as never);
    expect(up2).toEqual(up1);
  });

  it("leaves the service's v2 block as measured and caches it under the track's own key", async () => {
    stubNetwork("up");
    const { out, text } = await run("C");

    expect(out.audioFeatures).toEqual(searchMeasured(SIGNAL_ONLY));
    expect(cache.putAudio).toHaveBeenCalledTimes(1);
    // Matched by search: filed under the Spotify id, not under an ISRC.
    expect(cache.putAudio).toHaveBeenCalledWith("spotify:C", "C", searchMeasured(SIGNAL_ONLY));
    expect(text).toContain("116 BPM // D Minor (some perceptual features not measured)");
    expect(text).not.toMatch(/verified/i);
  });

  it("reads nothing of the v1 fields the service sends next to the block", async () => {
    stubNetwork("up", PREVIEW, serviceAnswer(audioV2(), { bpm: 58, key: "C", mode: "Major" }));
    const { out, text } = await run("D");
    expect(out.audioFeatures?.audio).toEqual(audioV2());
    expect(out.audioFeatures).not.toHaveProperty("bpm");
    expect(text).toContain("116 BPM // D Minor");
    expect(text).not.toMatch(/58 BPM|C Major/);
    expect(text).not.toMatch(/verified|some perceptual features/i);
  });

  it("finishes the run when the cache write fails, and does not claim it cached", async () => {
    stubNetwork("up");
    cache.putAudio.mockImplementation(() => {
      throw new Error("write failed");
    });
    const { out, text } = await run("C");
    expect(out.audioFeatures).toEqual(searchMeasured(SIGNAL_ONLY));
    expect(text).not.toMatch(/cache/i);
  });

  describe("cache", () => {
    const cachedRow = { audio: SIGNAL_ONLY, previewMatch: ISRC_MATCH };

    it("looks the track up by its ISRC's key, then its own, for the service's analyzer version", async () => {
      stubNetwork("up", PREVIEW, serviceAnswer(audioV2()), {
        status: "ok",
        analyzer_version: ANALYZER_VERSION,
        models: true,
      });
      await run("L", "USSB29000129");
      expect(cache.getAudio).toHaveBeenCalledWith(
        ["isrc:USSB29000129", "spotify:L"],
        ANALYZER_VERSION,
      );
    });

    it("measures again when the cache has nothing for the service's analyzer version", async () => {
      // The stub cache serves only for an older version.
      cache.getAudio.mockImplementation((_keys, version) =>
        version === "2.0.0+essentia" ? cachedRow : null,
      );
      const stub = stubNetwork("up");
      const { out } = await run("V");
      expect(cache.getAudio).toHaveBeenCalledWith(["spotify:V"], "2.1.0+essentia");
      expect(out.audioFeatures).toEqual(searchMeasured(SIGNAL_ONLY));
      expect(stub.calls).toContain(`${AUDIO_URL}/analyze`);
    });

    it("does not read the cache when the service names no analyzer version", async () => {
      cache.getAudio.mockReturnValue(cachedRow);
      const stub = stubNetwork("up", PREVIEW, serviceAnswer(SIGNAL_ONLY), { status: "ok" });
      const { out } = await run("NV");
      expect(cache.getAudio).not.toHaveBeenCalled();
      expect(out.audioFeatures).toEqual(searchMeasured(SIGNAL_ONLY));
      expect(stub.calls).toContain(`${AUDIO_URL}/analyze`);
    });

    it("reuses a cached measurement and looks up a fresh clip for the player", async () => {
      const stub = stubNetwork("up");
      cache.getAudio.mockReturnValue(cachedRow);
      const { out, text } = await run("NEW");
      expect(out.audioFeatures).toEqual(cachedRow);
      expect(out.preview).toEqual({ provider: "deezer", method: "isrc", score: null });
      expect(out.previewUrl).toBe(PREVIEW);
      expect(stub.calls).not.toContain(`${AUDIO_URL}/analyze`);
      expect(cache.putAudio).not.toHaveBeenCalled();
      expect(text).toContain("Audio cache hit: 116 BPM // D Minor");
    });

    it("gives the player no fresh clip from a host the service would refuse", async () => {
      stubNetwork("up", "http://cdnt-preview.dzcdn.net/api/1/x.mp3");
      cache.getAudio.mockReturnValue(cachedRow);
      const { out } = await run("HOST");
      expect(out.audioFeatures).toEqual(cachedRow);
      expect(out.previewUrl).toBeNull();
    });

    it("reports a Deezer outage on a cache hit as a source error", async () => {
      stubNetwork("up");
      deezer.isrc = { error: { type: "Exception", message: "Quota limit exceeded", code: 4 } };
      cache.getAudio.mockReturnValue(cachedRow);
      const { out } = await run("HITQ", "USSB29000129");
      expect(out.audioFeatures).toEqual(cachedRow);
      expect(out.previewUrl).toBeNull();
      expect(out.sourceErrors).toEqual([
        { source: "deezer", code: "rate_limited", message: expect.stringContaining("Quota") },
      ]);
    });

    it("keeps the cached measurement but gives the player no clip when none matches now", async () => {
      stubNetwork("up");
      deezer.search = [deezerEntry(2, "Ice Ice Baby (Live)", "Vanilla Ice", PREVIEW)];
      cache.getAudio.mockReturnValue(cachedRow);
      const { out } = await run("NEW");
      expect(out.audioFeatures).toEqual(cachedRow);
      expect(out.previewUrl).toBeNull();
    });

    it("files a clip found by the ISRC under the ISRC, so tracks sharing it share the row", async () => {
      const clip = "https://cdnt-preview.dzcdn.net/api/1/isrc.mp3?hdnea=exp=1";
      deezer.isrc = {
        ...deezerEntry(9, "Ice Ice Baby", "Vanilla Ice", clip),
        isrc: "USSB29000129",
      };
      stubNetwork("up");
      await run("I", "USSB29000129");
      expect(cache.putAudio).toHaveBeenCalledWith(
        "isrc:USSB29000129",
        "I",
        expect.objectContaining({ audio: SIGNAL_ONLY }),
      );
    });
  });

  describe("the preview clip", () => {
    it("writes the measured clip for the player and how it was matched", async () => {
      stubNetwork("up");
      const { out } = await run("P");
      expect(out.previewUrl).toBe(PREVIEW);
      expect(out.preview).toEqual({ provider: "deezer", method: "search", score: 1 });
    });

    it("looks the clip up by the track's ISRC first", async () => {
      const stub = stubNetwork("up");
      const clip = "https://cdnt-preview.dzcdn.net/api/1/isrc.mp3?hdnea=exp=1";
      deezer.isrc = {
        ...deezerEntry(9, "Ice Ice Baby", "Vanilla Ice", clip),
        isrc: "USSB29000129",
      };
      const { out } = await run("I", "USSB29000129");
      const deezerCalls = stub.calls.filter((url) => url.startsWith("https://api.deezer.com/"));
      expect(deezerCalls[0]).toBe("https://api.deezer.com/track/isrc:USSB29000129");
      expect(stub.calls.some((url) => url.includes("/search/track"))).toBe(false);
      expect(out.previewUrl).toBe(clip);
      expect(out.preview).toEqual({ provider: "deezer", method: "isrc", score: null });
      expect(out.audioFeatures?.previewMatch).toEqual({
        provider: "deezer",
        method: "isrc",
        deezerId: 9,
        score: null,
      });
    });

    it("gives no clip and no measurement when only other recordings have previews", async () => {
      const stub = stubNetwork("up");
      deezer.search = [
        deezerEntry(3, "Ice Ice Baby (Karaoke Version)", "Vanilla Ice", PREVIEW),
        deezerEntry(4, "Ice Ice Baby", "Ice Ice Baby Tribute Band", PREVIEW),
        deezerEntry(5, "Ninja Rap", "Vanilla Ice", PREVIEW),
      ];
      const { out, text } = await run("U", "USSB29000129");
      expect(out.audioFeatures).toMatchObject({ audio: null, unavailableReason: "no_preview" });
      expect(out.previewUrl).toBeNull();
      expect(out.preview).toBeNull();
      expect(stub.calls).not.toContain(`${AUDIO_URL}/analyze`);
      expect(cache.putAudio).not.toHaveBeenCalled();
      expect(text).not.toMatch(/\d+ BPM/);
    });

    it("still gives the player the matched clip when the service is down, with no provenance", async () => {
      stubNetwork("down");
      const { out } = await run("D2");
      expect(out.audioFeatures).toMatchObject({ unavailableReason: "service_unavailable" });
      expect(out.previewUrl).toBe(PREVIEW);
      expect(out.preview).toBeNull();
    });

    it("records Spotify's own clip as matched by id", async () => {
      stubNetwork("up", null);
      const spotifyClip = "https://p.scdn.co/mp3-preview/own";
      const state = stateFor("S", "USSB29000129");
      state.spotifyData = { ...state.spotifyData, previewUrl: spotifyClip } as never;
      const out = await engineerNode(state, { writer: () => {} } as never);
      expect(out.previewUrl).toBe(spotifyClip);
      expect(out.preview).toEqual({ provider: "spotify", method: "id", score: null });
    });

    it("reports a Deezer outage as a source error, apart from the missing clip", async () => {
      const stub = stubNetwork("up");
      deezer.isrc = { error: { type: "Exception", message: "Quota limit exceeded", code: 4 } };
      const { out } = await run("Q", "USSB29000129");
      expect(out.audioFeatures).toMatchObject({ audio: null, unavailableReason: "no_preview" });
      expect(out.sourceErrors).toEqual([
        { source: "deezer", code: "rate_limited", message: expect.stringContaining("Quota") },
      ]);
      // After the quota error no search is made.
      expect(stub.calls.filter((url) => url.startsWith("https://api.deezer.com/"))).toHaveLength(1);
    });

    it("records no source error when Deezer only has no clip of the recording", async () => {
      stubNetwork("up", null);
      const { out } = await run("N2", "USSB29000129");
      expect(out.audioFeatures).toMatchObject({ unavailableReason: "no_preview" });
      expect(out.sourceErrors).toBeUndefined();
    });
  });

  describe("service answers without a full measurement", () => {
    it("treats an answer without a v2 block as no measurement, whatever its v1 fields say", async () => {
      const { v2: _block, ...v1Only } = serviceAnswer(SIGNAL_ONLY);
      stubNetwork("up", PREVIEW, v1Only);
      const { out, text } = await run("V1");
      expect(out.audioFeatures).toMatchObject({
        audio: null,
        unavailableReason: "analysis_failed",
        unavailableDetail: expect.stringMatching(/no v2 measurement/),
      });
      expect(out.preview).toBeNull();
      expect(cache.putAudio).not.toHaveBeenCalled();
      expect(text).not.toMatch(/116 BPM|D Minor/);
    });

    it("keeps a measured tempo without a key, and caches nothing", async () => {
      stubNetwork("up", PREVIEW, serviceAnswer(signalOnlyV2({ key: null })));
      const { out, text } = await run("K");
      expect(out.audioFeatures?.audio?.tempo?.bpm).toBe(115.8);
      expect(out.audioFeatures?.audio?.key).toBeNull();
      expect(out.preview).toEqual({ provider: "deezer", method: "search", score: 1 });
      expect(cache.putAudio).not.toHaveBeenCalled();
      expect(text).toContain("The analysis found no key (not_detected)");
      expect(text).not.toMatch(/C Major|D Major|D Minor/);
    });

    it("keeps a measured key without a tempo, and caches nothing", async () => {
      stubNetwork("up", PREVIEW, serviceAnswer(signalOnlyV2({ tempo: null, beats: null })));
      const { text } = await run("T");
      expect(cache.putAudio).not.toHaveBeenCalled();
      expect(text).toContain("The analysis found no tempo (not_detected)");
      expect(text).not.toMatch(/\d+ BPM/);
    });

    it("keeps a block whose gate measured nothing, and caches nothing", async () => {
      stubNetwork("up", PREVIEW, serviceAnswer(gatedV2("noise")));
      const { out, text } = await run("G0");
      expect(out.audioFeatures?.audio).toEqual(gatedV2("noise"));
      expect(cache.putAudio).not.toHaveBeenCalled();
      expect(text).toContain("measured nothing on the preview (noise)");
    });

    it("drops a mood head outside its range and names it", async () => {
      const block = audioV2();
      const moods = block.fingerprint!.moods!;
      stubNetwork(
        "up",
        PREVIEW,
        serviceAnswer({
          ...block,
          fingerprint: {
            ...block.fingerprint!,
            moods: { ...moods, danceability: { ...moods.danceability!, value: 1.3 } },
          },
        }),
      );
      const { out } = await run("S");
      expect(out.audioFeatures?.audio?.fingerprint?.moods?.danceability).toBeNull();
      expect(out.audioFeatures?.outOfRange).toEqual(["danceability"]);
    });
  });

  it("reports analysis_failed when the service returns an error", async () => {
    stubNetwork("error");
    const { out } = await run("E");
    expect(out.audioFeatures).toMatchObject({
      audio: null,
      unavailableReason: "analysis_failed",
      unavailableDetail: "decode error",
    });
    expect(cache.putAudio).not.toHaveBeenCalled();
  });

  it("reports no_preview when neither Deezer nor Spotify has a preview", async () => {
    const stub = stubNetwork("up", null);
    const { out } = await run("F");
    expect(out.audioFeatures).toMatchObject({ audio: null, unavailableReason: "no_preview" });
    expect(stub.calls).not.toContain(`${AUDIO_URL}/analyze`);
    expect(cache.putAudio).not.toHaveBeenCalled();
  });

  it("reports preview_rejected for a preview the service would refuse", async () => {
    const stub = stubNetwork("up", "http://cdnt-preview.dzcdn.net/api/1/x.mp3");
    const { out } = await run("G");
    expect(out.audioFeatures).toMatchObject({ audio: null, unavailableReason: "preview_rejected" });
    expect(stub.calls).not.toContain(`${AUDIO_URL}/analyze`);
  });

  it("sends the service token only when it is configured", async () => {
    let stub = stubNetwork("up");
    await run("H");
    expect(stub.analyzeHeaders[0]).not.toHaveProperty("X-Audio-Token");

    process.env.AUDIO_SERVICE_TOKEN = "test-token";
    stub = stubNetwork("up");
    await run("H");
    expect(stub.analyzeHeaders[0]).toMatchObject({ "X-Audio-Token": "test-token" });
  });
});
