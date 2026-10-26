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
  keyWithheldV2,
  SEARCH_MATCH,
  serviceAnswer,
  signalOnlyV2,
  v1Answer,
} from "../testing/measuredAudio.js";

const cache = vi.hoisted(() => ({
  getAudio: vi.fn((..._args: unknown[]): unknown => null),
  getNewestAudio: vi.fn((..._args: unknown[]): unknown => null),
  putAudio: vi.fn(),
  /** A real cache, for the tests that run two tracks through it; the stub when unset. */
  real: null as unknown,
}));
vi.mock("../../store/cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../store/cache.js")>()),
  getCache: () => cache.real ?? cache,
}));

import Database from "better-sqlite3";
import { SonicCache } from "../../store/cache.js";
import { runMigrations } from "../../store/migrations.js";
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
    cache.getNewestAudio.mockReset();
    cache.getNewestAudio.mockReturnValue(null);
    cache.putAudio.mockReset();
    cache.real = null;
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
    // Without the service's analyzer version only the newest rows are looked at: none here.
    expect(cache.getAudio).not.toHaveBeenCalled();
    expect(cache.getNewestAudio).toHaveBeenCalledWith("spotify:A");
    expect(cache.putAudio).not.toHaveBeenCalled();
    // One health probe for the run, passed on to the analysis.
    expect(stub.calls.filter((url) => url === `${AUDIO_URL}/health`)).toHaveLength(1);
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
    expect(text).toContain("Measuring tempo and key from the preview clip");
    expect(text).toContain(
      "Measured from the preview: 116 BPM, D Minor (some perceptual features not measured)",
    );
    expect(text).not.toMatch(/verified/i);
  });

  it("reads nothing of the v1 fields an older service sends next to the block", async () => {
    stubNetwork("up", PREVIEW, v1Answer(audioV2(), { bpm: 58, key: "C", mode: "Major" }));
    const { out, text } = await run("D");
    expect(out.audioFeatures?.audio).toEqual(audioV2());
    expect(out.audioFeatures).not.toHaveProperty("bpm");
    expect(text).toContain("Measured from the preview: 116 BPM, D Minor");
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
    const ISRC = "USSB29000129";
    const healthCalls = (stub: Stub) => stub.calls.filter((url) => url === `${AUDIO_URL}/health`);
    /** A measurement of the track's own clip (a search match), filed under its Spotify id. */
    const ownRow = { audio: SIGNAL_ONLY, previewMatch: SEARCH_MATCH };
    /** A measurement of the Deezer entry for the ISRC (id 3366332), filed under the ISRC. */
    const isrcRow = { audio: SIGNAL_ONLY, previewMatch: ISRC_MATCH };
    /** Deezer's entry for the ISRC: the one isrcRow was measured on. */
    const isrcEntry = (id = 3366332) => ({
      ...deezerEntry(id, "Ice Ice Baby", "Vanilla Ice", PREVIEW),
      isrc: ISRC,
    });
    /** The stub cache answers `rows[key]` for the service's version. */
    const rowsByKey = (rows: Record<string, unknown>) =>
      cache.getAudio.mockImplementation((key) => rows[key as string] ?? null);

    /** The key of a measurement of Deezer's ISRC entry 3366332 (isrcRow). */
    const ISRC_KEY = `isrc:${ISRC}:3366332`;

    it("looks the track up under the entry its resolution took by ISRC, then its own key", async () => {
      stubNetwork("up", PREVIEW, serviceAnswer(audioV2()), {
        status: "ok",
        analyzer_version: ANALYZER_VERSION,
        models: true,
      });
      deezer.isrc = isrcEntry();
      await run("L", ISRC);
      expect(cache.getAudio.mock.calls).toEqual([
        [ISRC_KEY, ANALYZER_VERSION],
        ["spotify:L", ANALYZER_VERSION],
      ]);
    });

    it("looks under no ISRC key when its resolution took no entry by ISRC", async () => {
      stubNetwork("up");
      await run("NOISRC", ISRC);
      expect(cache.getAudio.mock.calls).toEqual([["spotify:NOISRC", "2.1.0+essentia"]]);
    });

    it("measures again when the cache has nothing for the service's analyzer version, with one health probe", async () => {
      // The stub cache serves only for an older version.
      cache.getAudio.mockImplementation((_key, version) =>
        version === "2.0.0+essentia" ? ownRow : null,
      );
      const stub = stubNetwork("up");
      const { out } = await run("V");
      expect(cache.getAudio).toHaveBeenCalledWith("spotify:V", "2.1.0+essentia");
      expect(out.audioFeatures).toEqual(searchMeasured(SIGNAL_ONLY));
      expect(stub.calls).toContain(`${AUDIO_URL}/analyze`);
      expect(healthCalls(stub)).toHaveLength(1);
      // Deezer is asked once for the run, not again by the analysis.
      expect(stub.calls.filter((url) => url.includes("/search/track"))).toHaveLength(1);
    });

    it("reuses a cached measurement with one health probe, and gives the player this run's clip", async () => {
      const stub = stubNetwork("up");
      rowsByKey({ "spotify:NEW": ownRow });
      const { out, text } = await run("NEW");
      expect(out.audioFeatures).toEqual(ownRow);
      expect(out.preview).toEqual({ provider: "deezer", method: "search", score: 1 });
      expect(out.previewUrl).toBe(PREVIEW);
      expect(stub.calls).not.toContain(`${AUDIO_URL}/analyze`);
      expect(healthCalls(stub)).toHaveLength(1);
      expect(cache.putAudio).not.toHaveBeenCalled();
      expect(text).toContain("Measured in an earlier run: 116 BPM, D Minor");
    });

    it("serves the newest measurement when the service is down, saying it is down and which analyzer made it", async () => {
      const stub = stubNetwork("down");
      cache.getNewestAudio.mockImplementation((key) =>
        key === "spotify:DOWN"
          ? { measurement: ownRow, measuredAt: new Date("2026-10-20T08:00:00.000Z") }
          : null,
      );
      const { out, text } = await run("DOWN");
      // Marked, so the result built on it is not stored.
      expect(out.audioFeatures).toEqual({ ...ownRow, servedUnversioned: true });
      expect(cache.getAudio).not.toHaveBeenCalled();
      expect(stub.calls).not.toContain(`${AUDIO_URL}/analyze`);
      expect(healthCalls(stub)).toHaveLength(1);
      expect(text).toContain(
        "The audio service is unavailable. Showing an earlier measurement by analyzer 2.1.0 from 2026-10-20: 116 BPM, D Minor",
      );
    });

    it("names no build or model ids, and no date it does not know, for an earlier measurement", async () => {
      stubNetwork("down");
      cache.getNewestAudio.mockImplementation((key) =>
        key === "spotify:OLD"
          ? {
              measurement: { audio: audioV2(), previewMatch: SEARCH_MATCH },
              measuredAt: new Date(0),
            }
          : null,
      );
      const { text } = await run("OLD");
      expect(text).toContain(
        "The audio service is unavailable. Showing an earlier measurement by analyzer 2.1.0: 116 BPM, D Minor",
      );
      expect(text).not.toMatch(/essentia|models-|1970/);
    });

    it("serves the newest measurement when the service names no analyzer version, and says so", async () => {
      const stub = stubNetwork("up", PREVIEW, serviceAnswer(SIGNAL_ONLY), { status: "ok" });
      cache.getNewestAudio.mockReturnValue({
        measurement: ownRow,
        measuredAt: new Date("2026-10-21T00:00:00.000Z"),
      });
      const { out, text } = await run("NV");
      expect(out.audioFeatures).toEqual({ ...ownRow, servedUnversioned: true });
      expect(stub.calls).not.toContain(`${AUDIO_URL}/analyze`);
      expect(text).toContain(
        "The audio service did not name its analyzer version. Showing an earlier measurement by analyzer 2.1.0 from 2026-10-21",
      );
    });

    it("serves the newer of the rows the track may be served when the service is down", async () => {
      stubNetwork("down");
      deezer.isrc = isrcEntry();
      const older = { measurement: ownRow, measuredAt: new Date("2026-10-01T00:00:00.000Z") };
      const newer = { measurement: isrcRow, measuredAt: new Date("2026-10-22T00:00:00.000Z") };
      cache.getNewestAudio.mockImplementation((key) =>
        key === ISRC_KEY ? newer : key === "spotify:NEWER" ? older : null,
      );
      const { out } = await run("NEWER", ISRC);
      expect(out.audioFeatures).toEqual({ ...isrcRow, servedUnversioned: true });
    });

    it("measures when the service names no version and nothing is cached", async () => {
      const stub = stubNetwork("up", PREVIEW, serviceAnswer(SIGNAL_ONLY), { status: "ok" });
      const { out } = await run("NV2");
      expect(out.audioFeatures).toEqual(searchMeasured(SIGNAL_ONLY));
      expect(stub.calls).toContain(`${AUDIO_URL}/analyze`);
      expect(healthCalls(stub)).toHaveLength(1);
    });

    it("gives the player no clip from a host the service would refuse", async () => {
      stubNetwork("up", "http://cdnt-preview.dzcdn.net/api/1/x.mp3");
      rowsByKey({ "spotify:HOST": ownRow });
      const { out } = await run("HOST");
      expect(out.audioFeatures).toEqual(ownRow);
      expect(out.previewUrl).toBeNull();
    });

    it("serves an ISRC row when this run's own resolution took the same Deezer entry by ISRC", async () => {
      stubNetwork("up");
      deezer.isrc = isrcEntry();
      rowsByKey({ [ISRC_KEY]: isrcRow });
      const { out } = await run("SAME", ISRC);
      expect(out.audioFeatures).toEqual(isrcRow);
      expect(out.preview).toEqual({ provider: "deezer", method: "isrc", score: null });
    });

    it("does not serve an ISRC row of another Deezer entry, and measures", async () => {
      const stub = stubNetwork("up");
      deezer.isrc = isrcEntry(4242);
      rowsByKey({ [ISRC_KEY]: isrcRow });
      const { out } = await run("OTHER", ISRC);
      expect(out.audioFeatures?.previewMatch).toMatchObject({ method: "isrc", deezerId: 4242 });
      expect(stub.calls).toContain(`${AUDIO_URL}/analyze`);
    });

    it("keeps the track's own measurement when no clip matches now, but no ISRC row", async () => {
      stubNetwork("up");
      deezer.search = [deezerEntry(2, "Ice Ice Baby (Live)", "Vanilla Ice", PREVIEW)];
      rowsByKey({ "spotify:NOW": ownRow });
      const { out } = await run("NOW", ISRC);
      expect(out.audioFeatures).toEqual(ownRow);
      expect(out.previewUrl).toBeNull();

      rowsByKey({ [ISRC_KEY]: isrcRow });
      const { out: none } = await run("NOW2", ISRC);
      expect(none.audioFeatures).toMatchObject({ audio: null, unavailableReason: "no_preview" });
    });

    it("never lets a partial ISRC row hide a complete row of the track's own", async () => {
      stubNetwork("up");
      deezer.isrc = isrcEntry();
      const completeOwn = {
        audio: { ...audioV2(), analyzerVersion: "2.1.0+essentia" },
        previewMatch: SEARCH_MATCH,
      };
      rowsByKey({ [ISRC_KEY]: isrcRow, "spotify:BOTH": completeOwn });
      const { out } = await run("BOTH", ISRC);
      expect(out.audioFeatures).toEqual(completeOwn);
    });

    it("files a clip taken by the ISRC under its entry's ISRC key and under the track's own", async () => {
      const clip = "https://cdnt-preview.dzcdn.net/api/1/isrc.mp3?hdnea=exp=1";
      deezer.isrc = { ...deezerEntry(9, "Ice Ice Baby", "Vanilla Ice", clip), isrc: ISRC };
      stubNetwork("up");
      await run("I", ISRC);
      const filed = expect.objectContaining({
        audio: SIGNAL_ONLY,
        previewMatch: expect.objectContaining({ method: "isrc", deezerId: 9 }),
      });
      expect(cache.putAudio.mock.calls).toEqual([
        [`isrc:${ISRC}:9`, "I", filed],
        ["spotify:I", "I", filed],
      ]);
    });

    describe("with a real cache, two tracks that share an ISRC", () => {
      // Deezer's entry for the ISRC is the original: "Ice Ice Baby" by Vanilla Ice, 270 s.
      const original = stateFor("ORIGINAL", ISRC);
      const other = (title: string, artist: string, durationMs: number) => {
        const state = stateFor("OTHER", ISRC);
        state.spotifyData = { ...state.spotifyData!, title, artist, durationMs };
        return state;
      };
      const karaoke = other("Ice Ice Baby (Karaoke Version)", "Ameritz Karaoke", 200_000);
      const radioEdit = other("Ice Ice Baby (Radio Edit)", "Vanilla Ice", 200_000);
      const writer = { writer: () => {} } as never;
      const analyses = (stub: Stub) => stub.calls.filter((url) => url === `${AUDIO_URL}/analyze`);

      beforeEach(() => {
        const db = new Database(":memory:");
        runMigrations(db);
        cache.real = new SonicCache(db);
        deezer.isrc = isrcEntry();
        // No search result either: the other track has no clip of its own.
        deezer.search = [];
      });

      it.each([
        ["a karaoke version", karaoke],
        ["a 200 s radio edit", radioEdit],
      ])(
        "never serves the original's ISRC row to %s its own checks turn down",
        async (_name, state) => {
          const stub = stubNetwork("up");
          const first = await engineerNode(original, writer);
          expect(first.audioFeatures?.previewMatch).toMatchObject({
            method: "isrc",
            deezerId: 3366332,
          });

          stub.calls.length = 0;
          const out = await engineerNode(state, writer);

          expect(out.audioFeatures).toMatchObject({ audio: null, unavailableReason: "no_preview" });
          expect(out.preview).toBeNull();
          expect(analyses(stub)).toEqual([]);
          // The original is still served its own row.
          stub.calls.length = 0;
          const again = await engineerNode(original, writer);
          expect(again.audioFeatures).toEqual(first.audioFeatures);
          expect(analyses(stub)).toEqual([]);
        },
      );

      it.each([
        ["down", "a karaoke version", karaoke],
        ["down", "a 200 s radio edit", radioEdit],
        ["naming no analyzer version", "a karaoke version", karaoke],
        ["naming no analyzer version", "a 200 s radio edit", radioEdit],
      ])(
        "never serves the original's ISRC row while the service is %s: %s",
        async (mode, _name, state) => {
          stubNetwork("up");
          const first = await engineerNode(original, writer);
          const stub =
            mode === "down"
              ? stubNetwork("down")
              : stubNetwork("up", PREVIEW, serviceAnswer(SIGNAL_ONLY), { status: "ok" });

          const out = await engineerNode(state, writer);

          expect(out.audioFeatures?.audio ?? null).toBeNull();
          expect(out.preview).toBeNull();
          expect(analyses(stub)).toEqual([]);
          // The original is served its own measurement, saying the service could not say its
          // version.
          const again = await engineerNode(original, writer);
          expect(again.audioFeatures).toEqual({ ...first.audioFeatures, servedUnversioned: true });
        },
      );

      it("serves a track its own measurement while Deezer cannot be read", async () => {
        stubNetwork("up");
        const first = await engineerNode(original, writer);
        deezer.isrc = { error: { type: "Exception", message: "Quota limit exceeded", code: 4 } };
        const stub = stubNetwork("up");

        const out = await engineerNode(original, writer);

        expect(out.audioFeatures).toEqual(first.audioFeatures);
        expect(out.previewUrl).toBeNull();
        expect(out.sourceErrors).toEqual([
          { source: "deezer", code: "rate_limited", message: expect.stringContaining("Quota") },
        ]);
        expect(analyses(stub)).toEqual([]);
      });

      it("keeps two Deezer entries of one ISRC in rows of their own, and serves each its own", async () => {
        // The edit is turned down for the ISRC entry (270 s) and takes a search hit that
        // carries the ISRC (entry 200, 200 s): also taken by ISRC.
        deezer.search = [
          {
            ...deezerEntry(200, "Ice Ice Baby (Radio Edit)", "Vanilla Ice", PREVIEW),
            duration: 200,
            isrc: ISRC,
          },
        ];
        const stub = stubNetwork("up");
        const orig1 = await engineerNode(original, writer);
        const edit1 = await engineerNode(radioEdit, writer);
        expect(orig1.audioFeatures?.previewMatch).toMatchObject({
          method: "isrc",
          deezerId: 3366332,
        });
        expect(edit1.audioFeatures?.previewMatch).toMatchObject({ method: "isrc", deezerId: 200 });

        const orig2 = await engineerNode(original, writer);
        const edit2 = await engineerNode(radioEdit, writer);
        expect(orig2.audioFeatures).toEqual(orig1.audioFeatures);
        expect(edit2.audioFeatures).toEqual(edit1.audioFeatures);
        // Each recording measured once.
        expect(analyses(stub)).toHaveLength(2);

        // While the service is down, each is still served its own entry's row.
        stubNetwork("down");
        const orig3 = await engineerNode(original, writer);
        expect(orig3.audioFeatures?.previewMatch).toMatchObject({ deezerId: 3366332 });
      });
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
      const { out, text } = await run("Q", "USSB29000129");
      // Deezer could not be read: that is why there is no clip, not that none was found.
      expect(text).toContain(
        "Tempo and key not measured: Deezer could not be read to find a preview clip",
      );
      expect(text).not.toContain("no preview clip of this recording was found");
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
      const { v2: _block, ...v1Only } = v1Answer(SIGNAL_ONLY);
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
      expect(text).toContain("Measured 116 BPM; key not given: not detected");
      expect(text).not.toMatch(/C Major|D Major|D Minor/);
    });

    it("keeps a measured key without a tempo, and caches nothing", async () => {
      stubNetwork("up", PREVIEW, serviceAnswer(signalOnlyV2({ tempo: null, beats: null })));
      const { text } = await run("T");
      expect(cache.putAudio).not.toHaveBeenCalled();
      expect(text).toContain("Tempo not given: not detected; measured D Minor");
      expect(text).not.toMatch(/\d+ BPM/);
    });

    it("names the reason for a withheld key in its own words, not the service's text", async () => {
      stubNetwork("up", PREVIEW, serviceAnswer(keyWithheldV2()));
      const { text } = await run("KW");
      expect(text).toContain("Measured 116 BPM; key not given: one pitched source, not a key");
      expect(text).not.toContain("the partials hold still");
      expect(text).not.toMatch(/not detected|not_detected/);
    });

    it("names the service's reasons for a withheld tempo and key", async () => {
      const block = audioV2({
        analyzerVersion: "2.3.0+essentia",
        tempo: null,
        beats: null,
        key: null,
        fingerprint: null,
        withheld: {
          tempo: { code: "unsteady_tempo", reason: "the tempo does not hold over the window" },
          beats: { code: "unsteady_tempo", reason: "the tempo does not hold over the window" },
          key: { code: "speech_like", reason: "one pitch line without stable notes" },
          fingerprint: { code: "models_not_loaded", reason: "the models are not loaded" },
        },
      });
      stubNetwork("up", PREVIEW, serviceAnswer(block));
      const { text } = await run("TKW");
      expect(text).toContain(
        "Tempo not given: the tempo does not hold across the preview; key not given: one pitch line without stable notes",
      );
    });

    it("names the gate's reason when the service measured nothing", async () => {
      const block = {
        ...gatedV2("silence"),
        analyzerVersion: "2.3.0+essentia",
        withheld: {
          tempo: { code: "gate_silence" as const, reason: "silent window (rms 0.0001)" },
        },
      };
      stubNetwork("up", PREVIEW, serviceAnswer(block));
      const { text } = await run("GS");
      expect(text).toContain("Nothing measured on the preview: the preview is silent");
    });

    it("keeps a block whose gate measured nothing, and caches nothing", async () => {
      stubNetwork("up", PREVIEW, serviceAnswer(gatedV2("noise")));
      const { out, text } = await run("G0");
      expect(out.audioFeatures?.audio).toEqual(gatedV2("noise"));
      expect(cache.putAudio).not.toHaveBeenCalled();
      expect(text).toContain(
        "Nothing measured on the preview: no beat and no musical pitch in the preview",
      );
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
    const { out, text } = await run("F");
    expect(out.audioFeatures).toMatchObject({ audio: null, unavailableReason: "no_preview" });
    // No clip, so no line says one is being measured.
    expect(text).toContain(
      "Tempo and key not measured: no preview clip of this recording was found",
    );
    expect(text).not.toContain("Measuring tempo and key");
    expect(stub.calls).not.toContain(`${AUDIO_URL}/analyze`);
    expect(cache.putAudio).not.toHaveBeenCalled();
  });

  it("says it measures only when it asks the service: not while the service is down", async () => {
    const stub = stubNetwork("down");
    const { text } = await run("DOWN2");
    expect(stub.calls).not.toContain(`${AUDIO_URL}/analyze`);
    expect(text).not.toContain("Measuring tempo and key");
    expect(text).toContain("Tempo and key not measured: the audio service is unavailable");
  });

  it("reports preview_rejected for a preview the service would refuse", async () => {
    const stub = stubNetwork("up", "http://cdnt-preview.dzcdn.net/api/1/x.mp3");
    const { out, text } = await run("G");
    expect(text).not.toContain("Measuring tempo and key");
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
