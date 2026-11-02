/**
 * The audio cassette: under SOURCE_CASSETTE=record each track's audio step is recorded by track,
 * analyzer version and window, never by the preview clip; under replay a run with no network,
 * no preview lookup and no clip (a recorded clip URL would have expired) gives what the live run
 * gave, exactly. An entry of another analyzer version is a miss, never served, and the audio
 * cache answers in neither mode.
 *
 * Each test runs the engineer node live (Deezer and the audio service stubbed) while recording,
 * then again replaying with every request refused, and compares the two.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AudioMeasurement } from "../agent/state.js";
import { captureLogsForTests } from "../logger.js";
import {
  ANALYZER_VERSION,
  audioV2,
  ISRC_MATCH,
  keyWithheldV2,
  serviceAnswer,
} from "../agent/testing/measuredAudio.js";

/**
 * An audio cache that keeps what it is given, by key and analyzer version, as the real one does
 * (store/cache.ts); `rows` is cleared before each test.
 */
const cache = vi.hoisted(() => {
  const rows = new Map<string, { measurement: unknown; measuredAt: Date }>();
  const version = (measurement: unknown) =>
    (measurement as { audio: { analyzerVersion: string } }).audio.analyzerVersion;
  return {
    rows,
    getAudio: (key: string, analyzer: string) =>
      rows.get(`${key}|${analyzer}`)?.measurement ?? null,
    getNewestAudio: (key: string) =>
      [...rows.entries()]
        .filter(([row]) => row.startsWith(`${key}|`))
        .map(([, row]) => row)
        .sort((a, b) => b.measuredAt.getTime() - a.measuredAt.getTime())[0] ?? null,
    putAudio: vi.fn((key: string, _spotifyId: string, measurement: unknown) => {
      rows.set(`${key}|${version(measurement)}`, { measurement, measuredAt: new Date() });
    }),
  };
});
vi.mock("../store/cache.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../store/cache.js")>()),
  getCache: () => cache,
}));
// The engineer's own preview lookup and health probe, watched: a replay makes neither.
vi.mock("./audio.js", async (importOriginal) => {
  const audio = await importOriginal<typeof import("./audio.js")>();
  return {
    ...audio,
    resolvePreview: vi.fn(audio.resolvePreview),
    audioServiceHealth: vi.fn(audio.audioServiceHealth),
  };
});

import { engineerNode } from "../agent/nodes/engineerNode.js";
import type { SonicAgentStateType } from "../agent/state.js";
import {
  AUDIO_WINDOW,
  audioCassetteKey,
  audioServiceHealth,
  HEALTH_CASSETTE_KEY,
  resolvePreview,
  withoutUrlLike,
} from "./audio.js";
import { type FetchRoute, json, stubFetch } from "./testing/fetchStub.js";

const AUDIO_URL = "http://audio.test";
const ISRC = "USSB29000129";
const SPOTIFY_ID = "SPOTIFY0001";
const HMAC = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
const SIGNED = `hdnea=exp=1761900000~acl=/api/1/1/a/b/c/clip.mp3*~hmac=${HMAC}`;
/** A signed Deezer clip, as Deezer sends it: it must never reach a cassette. */
const PREVIEW = `https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/clip.mp3?${SIGNED}`;
/** Pieces of the clip that must not reach a cassette, in any form. */
const CLIP_PIECES = ["dzcdn", "hdnea", "hmac", HMAC, "clip.mp3", "preview_url", "%2F", "%3A"];

/** Deezer's entry for an ISRC: id 3366332 with the signed clip. */
const deezerEntry = (isrc: string, preview = PREVIEW) => ({
  id: ISRC_MATCH.provider === "deezer" ? ISRC_MATCH.deezerId : 0,
  title: "Ice Ice Baby",
  preview,
  readable: true,
  duration: 270,
  isrc,
  artist: { id: 1, name: "Vanilla Ice" },
  album: { id: 1, title: "To the Extreme", cover_medium: "" },
});

interface Network {
  /** The /analyze answer; null: the request fails. */
  analyze?: (() => Response) | null;
  /** The /health answer; null: the service does not answer. */
  health?: (() => Response) | null;
  /** Deezer's answer to the ISRC lookup; null: Deezer cannot be reached. */
  deezer?: ((isrc: string) => Response) | null;
  search?: () => Response;
}

/** The live network: Deezer, and the audio service's /health and /analyze. */
function liveNetwork({
  analyze = () => json(serviceAnswer(audioV2())),
  health = () => json({ status: "ok", analyzer_version: ANALYZER_VERSION, models: true }),
  deezer = (isrc) => json(deezerEntry(isrc)),
  search = () => json({ total: 1, data: [deezerEntry(ISRC)] }),
}: Network = {}): FetchRoute {
  return (call) => {
    const isrc = call.url.match(/\/track\/isrc:([A-Z0-9]+)/)?.[1];
    if (call.url.startsWith("https://api.deezer.com/") && deezer === null) {
      throw new TypeError("fetch failed");
    }
    if (isrc && deezer) return deezer(isrc);
    if (call.url.startsWith("https://api.deezer.com/search/track")) return search();
    if (call.url === `${AUDIO_URL}/health`) {
      if (health === null) throw new TypeError("fetch failed");
      return health();
    }
    if (call.url === `${AUDIO_URL}/analyze`) {
      // The service gets the clip; nothing it is asked is recorded.
      expect(JSON.parse(call.body ?? "{}")).toEqual({ preview_url: PREVIEW });
      if (analyze === null) throw new TypeError("fetch failed");
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
  cache.rows.clear();
  cache.putAudio.mockClear();
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

/** The engineer's output for the track and the status events it wrote (code and text). */
async function runEngineer(id: string, isrc: string | null) {
  const events: string[] = [];
  const writer = (event: { code?: string; message?: string }) =>
    events.push(`${event.code}: ${event.message}`);
  const out = await engineerNode(stateFor(id, isrc), { writer } as never);
  return { out, events };
}

/** The engineer's run for the track on the live network, in `mode` (default: recording). */
async function live(
  network: Network = {},
  id = SPOTIFY_ID,
  isrc: string | null = ISRC,
  mode = "record",
) {
  process.env.SOURCE_CASSETTE = mode;
  stubFetch(liveNetwork(network));
  const run = await runEngineer(id, isrc);
  vi.unstubAllGlobals();
  return run;
}

/** The requests of every replay of the test (each one refused); checked after each test. */
let replayRequests: string[] = [];
afterEach(() => {
  const requests = replayRequests;
  replayRequests = [];
  expect(requests, "requests during a replay").toEqual([]);
});

/** The engineer's run for the track, replayed with every request refused. */
async function replay(id = SPOTIFY_ID, isrc: string | null = ISRC) {
  process.env.SOURCE_CASSETTE = "replay";
  const net = stubFetch(() => undefined);
  vi.mocked(resolvePreview).mockClear();
  vi.mocked(audioServiceHealth).mockClear();
  const run = await runEngineer(id, isrc);
  replayRequests.push(...net.calls.map((call) => `${call.method} ${call.url}`));
  // Not even from the cassettes: the recorded step holds what the lookup found.
  expect(resolvePreview, "preview lookups during a replay").not.toHaveBeenCalled();
  expect(audioServiceHealth, "health probes during a replay").not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  return run;
}

type Run = Awaited<ReturnType<typeof runEngineer>>;

/**
 * A replay gives what the live run gave: its whole output (the measurement, how its clip was
 * matched, the source errors the prompts read, the status lines) and its events, with no clip for
 * the player.
 */
function expectSameRun(recorded: Run, replayed: Run) {
  const { previewUrl: _clip, ...rest } = recorded.out;
  expect(replayed.out).toEqual({ ...rest, previewUrl: null });
  expect(replayed.events).toEqual(recorded.events);
}

/** Every cassette file written, as text. */
function cassetteTexts(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((file) => file.endsWith(".json"))
      .map((file) => [file, readFileSync(join(dir, file), "utf8")]),
  );
}

type Entries = Record<string, { json?: Record<string, unknown> }>;
const audioPath = () => join(dir, "audio.json");
const audioEntries = () => JSON.parse(readFileSync(audioPath(), "utf8")).entries as Entries;
/** Rewrites the audio cassette's entries. */
function editAudioEntries(edit: (entries: Entries) => void) {
  const entries = audioEntries();
  edit(entries);
  writeFileSync(audioPath(), JSON.stringify({ version: 1, entries }));
}

const keyOf = (track = `isrc:${ISRC}`, version: string | null = ANALYZER_VERSION) =>
  audioCassetteKey(track, version);

/** No cassette holds any piece of the clip. */
function expectClean() {
  const texts = cassetteTexts();
  expect(Object.keys(texts)).toContain("audio.json");
  for (const [file, text] of Object.entries(texts)) {
    for (const piece of CLIP_PIECES) expect(text, `${file} holds ${piece}`).not.toContain(piece);
  }
}

describe("the audio cassette", () => {
  it("replays the measured block with no network, no preview lookup and no preview URL", async () => {
    const recorded = await live();
    expect(recorded.out.audioFeatures).toEqual({ audio: audioV2(), previewMatch: ISRC_MATCH });
    expect(recorded.out.previewUrl).toBe(PREVIEW);
    expect(recorded.events.map((event) => event.split(":")[0])).toEqual([
      "AUDIO-INIT",
      "AUDIO-COMPLETE",
    ]);
    // The live measurement is cached; a replayed one never is (the cache dates it as measured now).
    expect(cache.putAudio).toHaveBeenCalled();
    cache.rows.clear();
    cache.putAudio.mockClear();

    // The same output, events and source errors (none: the replay looks nothing up on Deezer).
    expectSameRun(recorded, await replay());
    expect(cache.putAudio).not.toHaveBeenCalled();
  });

  it("keys the entry by the track's ISRC, the analyzer version and the window", async () => {
    await live();
    const key = `audio isrc:${ISRC} analyzer:${ANALYZER_VERSION} window:preview-30s`;
    expect(AUDIO_WINDOW).toBe("preview-30s");
    expect(keyOf()).toBe(key);
    expect(Object.keys(audioEntries()).sort()).toEqual([HEALTH_CASSETTE_KEY, key].sort());
    expect(audioEntries()[key]).toEqual({
      status: 200,
      contentType: "application/json",
      json: { audio: audioV2(), sent: true, match: ISRC_MATCH },
    });
    // A track with no ISRC is filed under its Spotify id.
    const recorded = await live({}, "NOISRC0001", null);
    expect(Object.keys(audioEntries())).toContain(
      `audio spotify:NOISRC0001 analyzer:${ANALYZER_VERSION} window:preview-30s`,
    );
    expectSameRun(recorded, await replay("NOISRC0001", null));
  });

  it("records the measurement with a warm audio cache, and replays it on a cold one", async () => {
    // An earlier live run left the measurement in the cache.
    await live({}, SPOTIFY_ID, ISRC, "off");
    expect(cache.rows.size).toBeGreaterThan(0);
    expect(existsSync(audioPath())).toBe(false);

    const recorded = await live();
    cache.rows.clear();
    const replayed = await replay();
    expect(replayed.out.audioFeatures).toEqual({ audio: audioV2(), previewMatch: ISRC_MATCH });
    expectSameRun(recorded, replayed);
  });

  it("misses a step that was not recorded, whatever the audio cache holds", async () => {
    await live();
    // The cache holds the measurement (the recording's own live run wrote it).
    expect(cache.rows.size).toBeGreaterThan(0);
    editAudioEntries((entries) => {
      for (const key of Object.keys(entries)) if (key !== HEALTH_CASSETTE_KEY) delete entries[key];
    });
    expect((await replay()).out.audioFeatures).toEqual({
      audio: null,
      unavailableReason: "analysis_failed",
      unavailableDetail: `audio: no cassette entry for ${keyOf()}`,
    });
  });

  it("misses with no recorded /health, and never serves an older cached measurement", async () => {
    await live();
    editAudioEntries((entries) => {
      delete entries[HEALTH_CASSETTE_KEY];
    });
    // A measurement of an older analyzer in the cache.
    cache.rows.clear();
    cache.putAudio(`spotify:${SPOTIFY_ID}`, SPOTIFY_ID, {
      audio: audioV2({ analyzerVersion: "2.0.0+essentia" }),
      previewMatch: ISRC_MATCH,
    });
    expect((await replay()).out.audioFeatures).toEqual({
      audio: null,
      unavailableReason: "analysis_failed",
      unavailableDetail: `audio: no recorded analysis for isrc:${ISRC}: no /health with an analyzer version was recorded`,
    });
  });

  it("records neither /health nor the measurement when /health names no analyzer version", async () => {
    const recorded = await live({ health: () => json({ status: "ok" }) });
    // Measured live, but not recorded: no version to file the measurement under.
    expect(recorded.out.audioFeatures).toMatchObject({ audio: audioV2() });
    expect(existsSync(audioPath())).toBe(false);
    expect((await replay()).out.audioFeatures).toEqual({
      audio: null,
      unavailableReason: "analysis_failed",
      unavailableDetail: `audio: no recorded analysis for isrc:${ISRC}: no /health with an analyzer version was recorded`,
    });
  });

  it("keeps the recorded /health when a later probe fails, so earlier steps still replay", async () => {
    const first = await live();
    // A second track is recorded while /health answers an error: the service is unavailable.
    const second = await live(
      { health: () => json({ detail: "Service Unavailable" }, { status: 503 }) },
      "SPOTIFY0002",
      "USSB29000130",
    );
    expect(second.out.audioFeatures).toMatchObject({ unavailableReason: "service_unavailable" });
    expect(audioEntries()[HEALTH_CASSETTE_KEY]?.json).toEqual({
      analyzer_version: ANALYZER_VERSION,
    });
    expectSameRun(first, await replay());
    expectSameRun(second, await replay("SPOTIFY0002", "USSB29000130"));
  });

  it.each([
    [
      "an error",
      { status: 503, contentType: "application/json", json: { detail: "Service Unavailable" } },
      "the recorded /health is an error (HTTP 503)",
    ],
    [
      "no analyzer version",
      { status: 200, contentType: "application/json", json: { status: "ok" } },
      "the recorded /health names no analyzer version",
    ],
  ])("says why it misses when the recorded /health is %s", async (_label, health, why) => {
    await live();
    editAudioEntries((entries) => {
      entries[HEALTH_CASSETTE_KEY] = health;
    });
    expect((await replay()).out.audioFeatures).toEqual({
      audio: null,
      unavailableReason: "analysis_failed",
      unavailableDetail: `audio: no recorded analysis for isrc:${ISRC}: ${why}`,
    });
  });

  it("replays the mood heads the API dropped as out of range", async () => {
    const block = audioV2();
    const moods = block.fingerprint!.moods!;
    const answer = serviceAnswer({
      ...block,
      fingerprint: {
        ...block.fingerprint!,
        moods: { ...moods, danceability: { ...moods.danceability!, value: 1.3 } },
      },
    });
    const recorded = await live({ analyze: () => json(answer) });
    expect(recorded.out.audioFeatures).toMatchObject({ outOfRange: ["danceability"] });
    expect(audioEntries()[keyOf()]?.json).toMatchObject({ outOfRange: ["danceability"] });
    expectSameRun(recorded, await replay());
  });

  it("records the preview lookup's error without anything like a link", async () => {
    const link = "cdnt-preview.dzcdn.net/api/1/1/a/b/c/clip.mp3";
    const recorded = await live({
      // A form the source layer's own scrub keeps: a link without a scheme.
      deezer: () => json({ detail: `see ${link}` }, { status: 500 }),
      search: () => json({ detail: `see ${link}` }, { status: 500 }),
    });
    const lookup = (recorded.out.sourceErrors ?? []) as Array<{ message: string }>;
    expect(lookup.map((error) => error.message).join(" ")).toContain(link);
    // The audio step's entry holds the error with the link masked.
    const text = cassetteTexts()["audio.json"];
    expect(text).toContain("[url]");
    for (const piece of CLIP_PIECES) expect(text, `audio.json holds ${piece}`).not.toContain(piece);
    const replayed = await replay();
    // The same run, with the words of the error and the detail kept and any link masked.
    const { previewUrl: _clip, ...rest } = recorded.out;
    const measured = recorded.out.audioFeatures as AudioMeasurement;
    expect(replayed.out).toEqual({
      ...rest,
      audioFeatures: {
        ...measured,
        unavailableDetail: withoutUrlLike(measured.unavailableDetail ?? ""),
      },
      previewUrl: null,
      sourceErrors: lookup.map((error) => ({ ...error, message: withoutUrlLike(error.message) })),
    });
    expect(JSON.stringify(replayed.out)).not.toContain(link);
    expect(replayed.events).toEqual(recorded.events);
  });

  it("writes no preview URL to any cassette, and nothing outside record mode", async () => {
    await live({}, SPOTIFY_ID, ISRC, "off");
    expect(existsSync(audioPath())).toBe(false);

    // A service that echoes the clip around its block and inside it, in every form.
    const echoed = {
      preview_url: PREVIEW,
      source: PREVIEW,
      encoded: encodeURIComponent(PREVIEW),
      bare: PREVIEW.replace("https://", ""),
      signed: SIGNED,
      [SIGNED]: true,
      hdnea: "exp=1761900000",
    };
    const recorded = await live({
      analyze: () => json({ ...echoed, v2: { ...audioV2(), ...echoed } }),
    });
    expect(recorded.out.audioFeatures).toMatchObject({ audio: audioV2() });
    expectClean();
    expect(audioEntries()[keyOf()]?.json).toEqual({
      audio: audioV2(),
      sent: true,
      match: ISRC_MATCH,
    });
    expectSameRun(recorded, await replay());
  });

  it("does not record a block whose text looks like a link, and replays a miss", async () => {
    const block = audioV2({
      keyMoments: [
        {
          time: 3.2,
          type: "onset",
          intensity: 0.8,
          description: `cdnt-preview.dzcdn.net/api/1/1/a/b/c/clip.mp3?${SIGNED}`,
        },
      ],
    });
    const recorded = await live({ analyze: () => json(serviceAnswer(block)) });
    expect(recorded.out.audioFeatures).toMatchObject({ audio: block });
    expect(Object.keys(audioEntries())).toEqual([HEALTH_CASSETTE_KEY]);
    expectClean();
    expect((await replay()).out.audioFeatures).toMatchObject({
      audio: null,
      unavailableReason: "analysis_failed",
    });
  });

  it("keeps only the code and the words of a refusal, without anything like a link", async () => {
    const detail =
      "The preview is not analysable audio: it is an MP4 (M4A) or AAC file, a format the service does not decode";
    const echo = `${encodeURIComponent(PREVIEW)} ${PREVIEW.replace("https://", "")} ${SIGNED}`;
    const recorded = await live({
      analyze: () =>
        json(
          {
            detail: `${detail} (${echo})`,
            code: "unsupported_format",
            preview_url: PREVIEW,
            input: { url: PREVIEW },
          },
          { status: 422 },
        ),
    });
    expect(recorded.out.audioFeatures).toMatchObject({
      audio: null,
      unavailableReason: "unsupported_format",
    });
    expectClean();
    const entry = audioEntries()[keyOf()]?.json ?? {};
    expect(Object.keys(entry).sort()).toEqual(["code", "detail", "match", "sent", "unavailable"]);
    expect(entry).toMatchObject({
      unavailable: "unsupported_format",
      code: "unsupported_format",
      detail: (recorded.out.audioFeatures as AudioMeasurement).unavailableDetail,
    });
    expectSameRun(recorded, await replay());
  });

  it("replays a recorded refusal as the same refusal", async () => {
    const refusal = {
      detail:
        "The preview is not analysable audio: it is an MP4 (M4A) or AAC file, a format the service does not decode",
      code: "unsupported_format",
    };
    const recorded = await live({ analyze: () => json(refusal, { status: 422 }) });
    expect(recorded.out.audioFeatures).toMatchObject({
      audio: null,
      unavailableReason: "unsupported_format",
    });
    expectSameRun(recorded, await replay());
  });

  it("replays a block with withheld values as recorded", async () => {
    const block = keyWithheldV2();
    const recorded = await live({
      analyze: () => json(serviceAnswer(block)),
      health: () => json({ status: "ok", analyzer_version: block.analyzerVersion }),
    });
    const replayed = await replay();
    expectSameRun(recorded, replayed);
    expect((replayed.out.audioFeatures as AudioMeasurement).audio).toEqual(block);
  });

  const outcomes: Array<[string, Network]> = [
    [
      "no_preview",
      {
        deezer: () => json({ error: { type: "DataException", message: "no data", code: 800 } }),
        search: () => json({ total: 0, data: [] }),
      },
    ],
    ["preview_lookup_incomplete", { deezer: null }],
    [
      "preview_rejected",
      { deezer: (isrc) => json(deezerEntry(isrc, "https://evil.example/clip.mp3")) },
    ],
    ["service_unavailable", { health: null }],
    ["analysis_failed", { analyze: () => json({ detail: "decode error" }, { status: 500 }) }],
  ];
  it.each(outcomes)("records and replays %s as the live run gave it", async (reason, network) => {
    const recorded = await live(network);
    expect(recorded.out.audioFeatures).toMatchObject({ audio: null, unavailableReason: reason });
    // The same reason, detail, source errors (the lookup's, as recorded) and events.
    expectSameRun(recorded, await replay());
    expect(cassetteTexts()["audio.json"]).not.toContain("evil.example");
  });

  it("misses an entry of another analyzer version, and serves nothing in its place", async () => {
    await live();
    const logs = captureLogsForTests({ level: "warn" });
    // The service is upgraded, and another track is recorded by the new analyzer.
    const newer = "2.4.0+essentia.models-5c5c0c7f";
    const other = await live(
      {
        analyze: () => json(serviceAnswer(audioV2({ analyzerVersion: newer }))),
        health: () => json({ status: "ok", analyzer_version: newer }),
      },
      "SPOTIFY0002",
      "GBAYE0000002",
    );
    expectSameRun(other, await replay("SPOTIFY0002", "GBAYE0000002"));
    // The recording said the directory's earlier steps now miss.
    logs.restore();
    expect(logs.messages().join("\n")).toContain(
      `The recorded /health changes from analyzer ${ANALYZER_VERSION} to ${newer}`,
    );

    // The first track's entry is of the older analyzer: a miss, not a stale measurement.
    const replayed = await replay();
    expect(replayed.out.audioFeatures).toEqual({
      audio: null,
      unavailableReason: "analysis_failed",
      unavailableDetail: `audio: no cassette entry for ${keyOf(`isrc:${ISRC}`, newer)}`,
    });
    expect(replayed.out.preview).toBeNull();
  });

  it.each([
    ["another analyzer", { analyzerVersion: "2.0.0+essentia" }, "holds a block of analyzer"],
    ["another window", { window: { kind: "full-track", durationSeconds: 240 } }, "holds no"],
  ])("misses an entry whose block names %s than its key", async (_label, change, named) => {
    await live();
    editAudioEntries((entries) => {
      Object.assign((entries[keyOf()].json as { audio: object }).audio, change);
    });
    const replayed = await replay();
    expect(replayed.out.audioFeatures).toMatchObject({
      audio: null,
      unavailableReason: "analysis_failed",
    });
    expect((replayed.out.audioFeatures as AudioMeasurement).unavailableDetail).toContain(named);
  });

  it("misses an entry recorded from Spotify's own clip, and serves no measurement of it", async () => {
    // Recorded before Spotify's clips were no longer measured (Spotify's terms restrict using
    // its content for machine learning): a miss, never a measurement without its provenance.
    await live();
    editAudioEntries((entries) => {
      (entries[keyOf()].json as { match: unknown }).match = {
        provider: "spotify",
        method: "id",
        score: null,
      };
    });
    const replayed = await replay();
    expect(replayed.out.audioFeatures).toEqual({
      audio: null,
      unavailableReason: "analysis_failed",
      unavailableDetail: `audio: the entry ${keyOf()} was recorded from Spotify's own clip, which is no longer measured`,
    });
    expect(replayed.out.preview).toBeNull();
    expect(replayed.events.join("\n")).not.toMatch(/\d+(\.\d+)? BPM/);
  });

  it("misses a measurement filed under no analyzer version", async () => {
    await live();
    editAudioEntries((entries) => {
      entries[keyOf(`isrc:${ISRC}`, null)] = entries[keyOf()];
      delete entries[keyOf()];
    });
    expect((await replay()).out.audioFeatures).toEqual({
      audio: null,
      unavailableReason: "analysis_failed",
      unavailableDetail: `audio: the entry ${keyOf(`isrc:${ISRC}`, null)} holds a measurement of no named analyzer`,
    });
  });

  it("misses a track that was never recorded", async () => {
    await live();
    expect((await replay("SPOTIFY0003", "GBAYE0000003")).out.audioFeatures).toEqual({
      audio: null,
      unavailableReason: "analysis_failed",
      unavailableDetail: `audio: no cassette entry for ${keyOf("isrc:GBAYE0000003")}`,
    });
  });

  it("masks text that looks like a link", () => {
    expect(withoutUrlLike(`see ${PREVIEW} or ${encodeURIComponent(PREVIEW)}`)).toBe(
      "see [url] or [url]",
    );
    expect(withoutUrlLike("cdnt-preview.dzcdn.net/api/1/x.mp3 failed")).toBe("[url] failed");
    expect(withoutUrlLike(`token ${SIGNED} exp=1 hmac=2`)).toBe("token [url] [url] [url]");
    const words = "The MP3 decodes to less audio than its MPEG audio frames hold";
    expect(withoutUrlLike(words)).toBe(words);
  });
});
