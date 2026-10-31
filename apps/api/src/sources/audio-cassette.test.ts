/**
 * The audio cassette: under SOURCE_CASSETTE=record the audio service's answers are recorded by
 * track, analyzer version and window, never by the preview clip; under replay a run with no
 * network and no clip (a recorded clip URL would have expired) carries the recorded answer, exactly
 * as the live run read it. An entry of another analyzer version is a miss, never served.
 *
 * Each test runs the engineer node live (Deezer and the audio service stubbed) while recording,
 * then again replaying with every request refused.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ANALYZER_VERSION,
  audioV2,
  ISRC_MATCH,
  keyWithheldV2,
  serviceAnswer,
} from "../agent/testing/measuredAudio.js";

// An empty audio cache: every measurement comes from the service or the cassette, and the test
// sees what is written to it.
const cache = vi.hoisted(() => ({
  getAudio: () => null,
  getNewestAudio: () => null,
  putAudio: vi.fn(),
}));
vi.mock("../store/cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../store/cache.js")>()),
  getCache: () => cache,
}));

import { engineerNode } from "../agent/nodes/engineerNode.js";
import type { SonicAgentStateType } from "../agent/state.js";
import { AUDIO_WINDOW, audioCassetteKey, HEALTH_CASSETTE_KEY } from "./audio.js";
import { type FetchRoute, json, stubFetch } from "./testing/fetchStub.js";

const AUDIO_URL = "http://audio.test";
const ISRC = "USSB29000129";
/** A signed Deezer clip, as Deezer sends it: it must never reach a cassette. */
const PREVIEW =
  "https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/clip.mp3?hdnea=exp=1761900000~acl=/api/1/1/a/b/c/clip.mp3*~hmac=0f1e2d3c4b5a69788796a5b4c3d2e1f0";

/** Deezer's entry for the ISRC: id 3366332 with the signed clip. */
const deezerEntry = {
  id: ISRC_MATCH.provider === "deezer" ? ISRC_MATCH.deezerId : 0,
  title: "Ice Ice Baby",
  preview: PREVIEW,
  readable: true,
  duration: 270,
  isrc: ISRC,
  artist: { id: 1, name: "Vanilla Ice" },
  album: { id: 1, title: "To the Extreme", cover_medium: "" },
};

/** The live network: Deezer, and the audio service's /health and /analyze. */
function liveNetwork(analyze: () => Response, version = ANALYZER_VERSION): FetchRoute {
  return (call) => {
    // The entry for the ISRC asked for, and the same entry as the one search result.
    const isrc = call.url.match(/\/track\/isrc:([A-Z0-9]+)/)?.[1];
    if (isrc) return json({ ...deezerEntry, isrc });
    if (call.url.startsWith("https://api.deezer.com/search/track")) {
      return json({ total: 1, data: [deezerEntry] });
    }
    if (call.url === `${AUDIO_URL}/health`) {
      return json({ status: "ok", analyzer_version: version, models: true });
    }
    if (call.url === `${AUDIO_URL}/analyze`) {
      // The service gets the clip; nothing it is asked is recorded.
      expect(JSON.parse(call.body ?? "{}")).toEqual({ preview_url: PREVIEW });
      return analyze();
    }
    return undefined;
  };
}

function stateFor(id: string, isrc: string | null): SonicAgentStateType {
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

let dir: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["SOURCE_CASSETTE", "SOURCE_CASSETTE_DIR", "AUDIO_ANALYSIS_URL", "NODE_ENV"];

beforeEach(() => {
  for (const key of ENV) saved[key] = process.env[key];
  dir = mkdtempSync(join(tmpdir(), "audio-cassette-"));
  process.env.SOURCE_CASSETTE_DIR = dir;
  process.env.AUDIO_ANALYSIS_URL = AUDIO_URL;
  process.env.NODE_ENV = "test";
  cache.putAudio.mockReset();
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => {
  for (const key of ENV) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** The engineer's output for the track, recorded from the live network. */
async function record(route: FetchRoute, id = "SPOTIFY0001", isrc: string | null = ISRC) {
  process.env.SOURCE_CASSETTE = "record";
  stubFetch(route);
  const out = await engineerNode(stateFor(id, isrc), {} as never);
  vi.unstubAllGlobals();
  return out;
}

/** The requests of every replay of the test (each one refused); checked after each test. */
let replayRequests: string[] = [];
afterEach(() => {
  const requests = replayRequests;
  replayRequests = [];
  expect(requests, "requests during a replay").toEqual([]);
});

/** The engineer's output for the track, replayed with every request refused. */
async function replay(id = "SPOTIFY0001", isrc: string | null = ISRC) {
  process.env.SOURCE_CASSETTE = "replay";
  const net = stubFetch(() => undefined);
  const out = await engineerNode(stateFor(id, isrc), {} as never);
  replayRequests.push(...net.calls.map((call) => `${call.method} ${call.url}`));
  return out;
}

/** Every cassette file written, as text. */
function cassetteTexts(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => [file, readFileSync(join(dir, file), "utf8")]),
  );
}

const audioEntries = () =>
  JSON.parse(readFileSync(join(dir, "audio.json"), "utf8")).entries as Record<string, unknown>;

describe("the audio cassette", () => {
  it("replays the measured block with no network and no preview URL", async () => {
    const block = audioV2();
    const live = await record(liveNetwork(() => json(serviceAnswer(block))));
    expect(live.audioFeatures).toEqual({ audio: block, previewMatch: ISRC_MATCH });
    expect(live.previewUrl).toBe(PREVIEW);
    // The live measurement is cached; a replayed one never is (the cache dates it as measured now).
    expect(cache.putAudio).toHaveBeenCalled();
    cache.putAudio.mockClear();

    const replayed = await replay();
    expect(cache.putAudio).not.toHaveBeenCalled();
    // The recorded measurement, unchanged, with how its clip was matched; no clip for the player.
    expect(replayed.audioFeatures).toEqual(live.audioFeatures);
    expect(replayed.preview).toEqual(live.preview);
    expect(replayed.previewUrl).toBeNull();
    expect(replayed.statusMessages).toEqual(live.statusMessages);
  });

  it("keys the entry by the track's ISRC, the analyzer version and the window", async () => {
    await record(liveNetwork(() => json(serviceAnswer(audioV2()))));
    const key = `POST /analyze isrc:${ISRC} analyzer:${ANALYZER_VERSION} window:preview-30s`;
    expect(AUDIO_WINDOW).toBe("preview-30s");
    expect(audioCassetteKey(`isrc:${ISRC}`, ANALYZER_VERSION)).toBe(key);
    expect(Object.keys(audioEntries()).sort()).toEqual([HEALTH_CASSETTE_KEY, key].sort());
    // A track with no ISRC is filed under its Spotify id.
    await record(
      liveNetwork(() => json(serviceAnswer(audioV2()))),
      "NOISRC0001",
      null,
    );
    expect(Object.keys(audioEntries())).toContain(
      `POST /analyze spotify:NOISRC0001 analyzer:${ANALYZER_VERSION} window:preview-30s`,
    );
    expect((await replay("NOISRC0001", null)).audioFeatures).toMatchObject({ audio: audioV2() });
  });

  it("writes no preview URL to any cassette, and nothing outside record mode", async () => {
    delete process.env.SOURCE_CASSETTE;
    stubFetch(liveNetwork(() => json(serviceAnswer(audioV2()))));
    await engineerNode(stateFor("SPOTIFY0001", ISRC), {} as never);
    vi.unstubAllGlobals();
    expect(existsSync(join(dir, "audio.json"))).toBe(false);

    // A service that echoes the clip in its answer, and a refusal that names it.
    await record(
      liveNetwork(() => json(serviceAnswer(audioV2(), { preview_url: PREVIEW, source: PREVIEW }))),
    );
    await record(
      liveNetwork(() =>
        json(
          { detail: `could not read ${PREVIEW}`, code: "unsupported_format", preview_url: PREVIEW },
          { status: 422 },
        ),
      ),
      "SPOTIFY0002",
      "GBAYE0000002",
    );
    const texts = cassetteTexts();
    expect(Object.keys(texts)).toContain("audio.json");
    for (const [file, text] of Object.entries(texts)) {
      expect(text, file).not.toContain("dzcdn");
      expect(text, file).not.toContain("hdnea");
      expect(text, file).not.toContain("clip.mp3");
      expect(text, file).not.toContain("preview_url");
    }
    // The measured entry holds the block and the clip's match, nothing else.
    const [measured] = Object.entries(audioEntries()).filter(([key]) => key.includes(ISRC));
    expect(measured[1]).toEqual({
      status: 200,
      contentType: "application/json",
      json: { v2: audioV2(), match: ISRC_MATCH },
    });
  });

  it("replays a recorded refusal as the same refusal", async () => {
    const refusal = {
      detail:
        "The preview is not analysable audio: it is an MP4 (M4A) or AAC file, a format the service does not decode",
      code: "unsupported_format",
    };
    const live = await record(liveNetwork(() => json(refusal, { status: 422 })));
    expect(live.audioFeatures).toMatchObject({
      audio: null,
      unavailableReason: "unsupported_format",
    });
    const replayed = await replay();
    expect(replayed.audioFeatures).toEqual(live.audioFeatures);
    expect(replayed.statusMessages).toEqual(live.statusMessages);
  });

  it("replays a block with withheld values as recorded", async () => {
    const block = keyWithheldV2();
    const live = await record(liveNetwork(() => json(serviceAnswer(block)), block.analyzerVersion));
    const replayed = await replay();
    expect(replayed.audioFeatures).toEqual(live.audioFeatures);
    expect(replayed.audioFeatures?.audio).toEqual(block);
  });

  it("misses an entry of another analyzer version, and serves nothing in its place", async () => {
    await record(liveNetwork(() => json(serviceAnswer(audioV2()))));
    // The service is upgraded, and another track is recorded by the new analyzer.
    const newer = "2.4.0+essentia.models-5c5c0c7f";
    await record(
      liveNetwork(() => json(serviceAnswer(audioV2({ analyzerVersion: newer }))), newer),
      "SPOTIFY0002",
      "GBAYE0000002",
    );
    expect((await replay("SPOTIFY0002", "GBAYE0000002")).audioFeatures).toMatchObject({
      audio: audioV2({ analyzerVersion: newer }),
    });

    // The first track's entry is of the older analyzer: a miss, not a stale measurement.
    const replayed = await replay();
    expect(replayed.audioFeatures).toEqual({
      audio: null,
      unavailableReason: "analysis_failed",
      unavailableDetail: `audio: no cassette entry for POST /analyze isrc:${ISRC} analyzer:${newer} window:preview-30s`,
    });
    expect(replayed.preview).toBeNull();
  });

  it("misses an entry whose block names another analyzer than its key", async () => {
    await record(liveNetwork(() => json(serviceAnswer(audioV2()))));
    const path = join(dir, "audio.json");
    const cassette = JSON.parse(readFileSync(path, "utf8"));
    const key = audioCassetteKey(`isrc:${ISRC}`, ANALYZER_VERSION) as string;
    cassette.entries[key].json.v2.analyzerVersion = "2.0.0+essentia";
    writeFileSync(path, JSON.stringify(cassette));

    const replayed = await replay();
    expect(replayed.audioFeatures).toEqual({
      audio: null,
      unavailableReason: "analysis_failed",
      unavailableDetail: `audio: the entry ${key} holds a block of analyzer 2.0.0+essentia`,
    });
  });

  it("misses a track that was never recorded", async () => {
    await record(liveNetwork(() => json(serviceAnswer(audioV2()))));
    const replayed = await replay("SPOTIFY0003", "GBAYE0000003");
    expect(replayed.audioFeatures).toMatchObject({
      audio: null,
      unavailableReason: "analysis_failed",
    });
  });
});
