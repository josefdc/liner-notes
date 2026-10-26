/**
 * Audio service client. The preview URL check uses the same rules as the audio service (https
 * only, host p.scdn.co or a subdomain of dzcdn.net, default port, no userinfo, no IP literal).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CapturedLogs, captureLogsForTests } from "../logger.js";
import {
  analyzeAudioPreview,
  audioServiceHealth,
  checkAudioServiceHealth,
  isAllowedPreviewUrl,
  readServiceMeasurement,
  resolvePreview,
} from "./audio.js";
import { json, never, stubFetch } from "./testing/fetchStub.js";
import {
  ANALYZER_VERSION,
  audioV2,
  gatedV2,
  keyWithheldV2,
  serviceAnswer,
  v1Answer,
} from "../agent/testing/measuredAudio.js";

// Every test's log lines, for the tests that check what is logged.
let logs: CapturedLogs;
beforeEach(() => {
  logs = captureLogsForTests();
});
afterEach(() => logs.restore());

describe("isAllowedPreviewUrl", () => {
  it.each([
    "https://p.scdn.co/mp3-preview/abc123?cid=1",
    "https://cdnt-preview.dzcdn.net/api/1/1/a/b/0/x.mp3?hdnea=exp=1",
    "https://cdns-preview-d.dzcdn.net/stream/c-abc-1.mp3",
    "https://cdnt-preview.dzcdn.net:443/api/1/x.mp3",
  ])("accepts %s", (url) => {
    expect(isAllowedPreviewUrl(url)).toBe(true);
  });

  it.each([
    ["plain http", "http://cdnt-preview.dzcdn.net/api/1/x.mp3"],
    ["plain http to Spotify", "http://p.scdn.co/mp3-preview/abc"],
    ["allowed name in the query", "https://evil.example/clip.mp3?x=dzcdn.net"],
    ["allowed name in the path", "https://evil.example/p.scdn.co/clip.mp3"],
    ["allowed name as a prefix", "https://cdnt-preview.dzcdn.net.evil.example/x.mp3"],
    ["allowed name inside a label", "https://evildzcdn.net/x.mp3"],
    ["bare dzcdn.net", "https://dzcdn.net/x.mp3"],
    ["other scdn.co host", "https://i.scdn.co/image/x"],
    ["userinfo", "https://p.scdn.co@evil.example/x.mp3"],
    ["userinfo before an allowed host", "https://user:pw@p.scdn.co/x.mp3"],
    ["non-default port", "https://cdnt-preview.dzcdn.net:8443/x.mp3"],
    ["IPv4 literal", "https://127.0.0.1/x.mp3"],
    ["IPv6 literal", "https://[::1]/x.mp3"],
    ["uppercase host", "https://P.SCDN.CO/x.mp3"],
    ["whitespace", "https://p.scdn.co/x .mp3"],
    ["backslash", "https://p.scdn.co\\@evil.example/x.mp3"],
    ["punycode label", "https://xn--e1afmkfd.dzcdn.net/x.mp3"],
    ["not a URL", "dzcdn.net"],
    ["empty", ""],
  ])("rejects %s", (_label, url) => {
    expect(isAllowedPreviewUrl(url)).toBe(false);
  });
});

describe("audio service client", () => {
  const SERVICE = "http://audio.test:3002";
  const PREVIEW_CLIP = "https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/clip.mp3?hdnea=exp=1";

  beforeEach(() => {
    process.env.AUDIO_ANALYSIS_URL = SERVICE;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    delete process.env.AUDIO_ANALYSIS_URL;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("gives up on a health check after 5 s", { timeout: 9000 }, async () => {
    stubFetch((call) => (call.url === `${SERVICE}/health` ? never(call) : undefined));

    const data = JSON.parse(await checkAudioServiceHealth.invoke({}));

    expect(data.available).toBe(false);
    expect(data.error).toMatch(/no answer within 5000 ms/);
  });

  it("reads the analyzer version the service reports", async () => {
    stubFetch((call) =>
      call.url === `${SERVICE}/health`
        ? json({ status: "degraded", analyzer_version: "1.1.0", models: false })
        : undefined,
    );

    const data = JSON.parse(await checkAudioServiceHealth.invoke({}));

    expect(data).toMatchObject({ available: true, version: "1.1.0" });
  });

  it("reports the service's own explanation of a failed analysis", async () => {
    stubFetch((call) => {
      if (call.url.startsWith("https://api.deezer.com/search/track?")) {
        return json({
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
      }
      if (call.url === `${SERVICE}/health`) return json({ status: "ok" });
      if (call.url === `${SERVICE}/analyze`) {
        return json({ detail: "could not decode the clip" }, { status: 422 });
      }
      return undefined;
    });

    const data = JSON.parse(
      await analyzeAudioPreview.invoke({
        title: "Ice Ice Baby",
        artist: "Vanilla Ice",
        album: "To the Extreme",
        durationMs: 270_000,
      }),
    );

    expect(data).toMatchObject({ source: "unavailable", reason: "analysis_failed" });
    expect(data.error).toBe("could not decode the clip");
  });
});

describe("what Node reads of the service's answer: the v2 block only", () => {
  const SERVICE = "http://audio.test:3002";
  const CLIP = "https://p.scdn.co/mp3-preview/own";
  const TRACK = { title: "Ice Ice Baby", artist: "Vanilla Ice", previewUrl: CLIP };

  /** The service measures Spotify's own clip and answers `answer`. */
  function service(answer: unknown, health: unknown = { status: "ok" }) {
    return stubFetch((call) => {
      if (call.url.startsWith("https://api.deezer.com/")) {
        return json({ error: { code: 800, message: "no data" } });
      }
      if (call.url === `${SERVICE}/health`) return json(health);
      if (call.url === `${SERVICE}/analyze`) return json(answer);
      return undefined;
    });
  }

  beforeEach(() => {
    process.env.AUDIO_ANALYSIS_URL = SERVICE;
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
  });
  afterEach(() => {
    delete process.env.AUDIO_ANALYSIS_URL;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("measures from the v2 block and ignores an older service's v1 fields next to it", async () => {
    // v1 fields that disagree with the block: none of them is read.
    service(v1Answer(audioV2(), { bpm: 58, key: "C", mode: "Major", energy: 1 }));

    const data = JSON.parse(await analyzeAudioPreview.invoke(TRACK));

    expect(data.source).toBe("analyzed");
    expect(data.audio).toEqual(audioV2());
    for (const v1 of ["bpm", "key", "mode", "energy", "valence", "duration"]) {
      expect(data).not.toHaveProperty(v1);
    }
  });

  it("measures from a v2-only answer (the service without its v1 fields)", async () => {
    service({ v2: audioV2() });
    const data = JSON.parse(await analyzeAudioPreview.invoke(TRACK));
    expect(data).toMatchObject({ source: "analyzed", audio: audioV2() });
  });

  it("keeps why the service withheld a value in the block, and nowhere else", async () => {
    service(serviceAnswer(keyWithheldV2()));

    const data = JSON.parse(await analyzeAudioPreview.invoke(TRACK));

    expect(data).toMatchObject({ source: "analyzed", audio: keyWithheldV2() });
    expect(data.audio.key).toBeNull();
    expect(data.audio.withheld).toEqual({
      key: {
        code: "one_pitched_source",
        reason: "the partials hold still, rise and fall together and spell no chord",
      },
    });
    expect(Object.keys(data).sort()).toEqual(["audio", "previewMatch", "previewUrl", "source"]);
  });

  it("drops a reason it cannot read, and keeps the measurement and the other reasons", () => {
    const block = keyWithheldV2();
    const read = readServiceMeasurement(
      serviceAnswer({
        ...block,
        withheld: {
          ...block.withheld,
          tempo: { code: "a_reason_from_a_newer_service", reason: "newer" },
          beats: "not a reason",
        },
      } as unknown as typeof block),
    );
    expect(read.audio?.tempo).toEqual(block.tempo);
    expect(read.audio?.withheld).toEqual(block.withheld);
    // Dropped, not kept as an undefined entry.
    expect(Object.keys(read.audio?.withheld ?? {})).toEqual(["key"]);
  });

  it("treats an answer with only the v1 fields as no measurement, and says why", async () => {
    const { v2: _block, ...v1Only } = v1Answer(audioV2());
    service(v1Only);

    const data = JSON.parse(await analyzeAudioPreview.invoke(TRACK));

    expect(data).toMatchObject({ source: "unavailable", reason: "analysis_failed", audio: null });
    expect(data.error).toMatch(/no v2 measurement/);
    expect(data).not.toHaveProperty("bpm");
  });

  it.each([
    ["a block of another version", { ...audioV2(), version: 1 }],
    ["a block without its window", { ...audioV2(), window: undefined }],
    [
      "a gate that did not pass with a tempo",
      { ...audioV2(), gate: { passed: false, reason: "noise" } },
    ],
    ["a passed gate with a reason", { ...audioV2(), gate: { passed: true, reason: "noise" } }],
  ])("treats %s as no measurement", async (_label, block) => {
    service(serviceAnswer(null, { v2: block }));
    const data = JSON.parse(await analyzeAudioPreview.invoke(TRACK));
    expect(data).toMatchObject({ source: "unavailable", reason: "analysis_failed", audio: null });
    expect(data.error).toMatch(/v2 block/);
  });

  it("keeps a block whose gate measured nothing, as the service sent it", async () => {
    service(serviceAnswer(gatedV2("silence")));
    const data = JSON.parse(await analyzeAudioPreview.invoke(TRACK));
    expect(data).toMatchObject({ source: "analyzed", audio: gatedV2("silence") });
  });

  it("drops a mood head outside its own range and names it", () => {
    const block = audioV2();
    const moods = block.fingerprint!.moods!;
    const answer = serviceAnswer({
      ...block,
      fingerprint: {
        ...block.fingerprint!,
        moods: { ...moods, valence: { ...moods.valence!, value: 9.4 } },
      },
    });

    const read = readServiceMeasurement(answer);

    expect(read.audio?.fingerprint?.moods?.valence).toBeNull();
    expect(read.audio?.fingerprint?.moods?.danceability).toEqual(moods.danceability);
    expect(read).toMatchObject({ outOfRange: ["valence"] });
    expect(read.audio?.withheld?.moods).toEqual({
      valence: {
        code: "out_of_range",
        reason: "the valence head gave a value outside the range its model produces",
      },
    });
  });

  it("reads the analyzer version the service reports on /health, or none", async () => {
    service(null, { status: "ok", analyzer_version: ANALYZER_VERSION, models: true });
    expect(await audioServiceHealth(undefined)).toEqual({ analyzerVersion: ANALYZER_VERSION });

    service(null, { status: "ok" });
    expect(await audioServiceHealth(undefined)).toEqual({ analyzerVersion: null });

    stubFetch((call) => (call.url === `${SERVICE}/health` ? json({}, { status: 503 }) : undefined));
    expect(await audioServiceHealth(undefined)).toBeNull();
  });

  it("asks neither Deezer nor /health again for what the run already knows", async () => {
    const net = service(serviceAnswer(audioV2()));
    const audioRun = {
      preview: { previewUrl: CLIP, match: { provider: "spotify", method: "id", score: null } },
      serviceAvailable: true,
    };

    const data = JSON.parse(
      await analyzeAudioPreview.invoke(
        { title: "Ice Ice Baby", artist: "Vanilla Ice", isrc: "USSB29000129" },
        { configurable: { audioRun } },
      ),
    );

    expect(data).toMatchObject({ source: "analyzed", previewUrl: CLIP });
    expect(net.calls.map((call) => call.url)).toEqual([`${SERVICE}/analyze`]);
  });

  it("measures nothing when the run knows the service did not answer", async () => {
    const net = service(serviceAnswer(audioV2()));
    const audioRun = {
      preview: { previewUrl: CLIP, match: { provider: "spotify", method: "id", score: null } },
      serviceAvailable: false,
    };
    const data = JSON.parse(
      await analyzeAudioPreview.invoke(TRACK, { configurable: { audioRun } }),
    );
    expect(data).toMatchObject({ source: "unavailable", reason: "service_unavailable" });
    expect(net.calls).toEqual([]);
  });
});

describe("the chosen track's preview clip", () => {
  const SERVICE = "http://audio.test:3002";
  const ISRC_CLIP = "https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/isrc.mp3?hdnea=exp=1~hmac=a";
  const SEARCH_CLIP = "https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/found.mp3?hdnea=exp=1~hmac=b";
  const SPOTIFY_CLIP = "https://p.scdn.co/mp3-preview/own";
  const TRACK = {
    title: "Ice Ice Baby",
    artist: "Vanilla Ice",
    album: "To the Extreme",
    isrc: "USSB29000129",
    durationMs: 271_000,
  };
  const deezerEntry = (id: number, title: string, artist: string, preview: string) => ({
    id,
    title,
    preview,
    readable: true,
    duration: 271,
    artist: { id, name: artist },
    album: { id, title: "To the Extreme" },
  });

  /** Deezer answers by ISRC and search, and the audio service measures. */
  function network(deezer: { isrc?: unknown; search?: unknown[] }) {
    return stubFetch((call) => {
      if (call.url.startsWith("https://api.deezer.com/track/isrc:")) {
        return json(deezer.isrc ?? { error: { code: 800, message: "no data" } });
      }
      if (call.url.startsWith("https://api.deezer.com/search/track?")) {
        return json({ data: deezer.search ?? [], total: deezer.search?.length ?? 0 });
      }
      if (call.url === `${SERVICE}/health`) return json({ status: "ok" });
      if (call.url === `${SERVICE}/analyze`) return json(serviceAnswer(audioV2()));
      return undefined;
    });
  }

  beforeEach(() => {
    process.env.AUDIO_ANALYSIS_URL = SERVICE;
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
  });
  afterEach(() => {
    delete process.env.AUDIO_ANALYSIS_URL;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("takes the Deezer entry for the ISRC first, before Spotify's own clip", async () => {
    network({
      isrc: { ...deezerEntry(1, "Ice Ice Baby", "Vanilla Ice", ISRC_CLIP), isrc: TRACK.isrc },
    });

    const preview = await resolvePreview({ ...TRACK, spotifyPreviewUrl: SPOTIFY_CLIP }, undefined);

    expect(preview).toEqual({
      previewUrl: ISRC_CLIP,
      match: { provider: "deezer", method: "isrc", deezerId: 1, score: null },
    });
  });

  it("takes Spotify's own clip before a search result when the ISRC has no Deezer preview", async () => {
    const net = network({ search: [deezerEntry(2, "Ice Ice Baby", "Vanilla Ice", SEARCH_CLIP)] });

    const preview = await resolvePreview({ ...TRACK, spotifyPreviewUrl: SPOTIFY_CLIP }, undefined);

    expect(preview).toEqual({
      previewUrl: SPOTIFY_CLIP,
      match: { provider: "spotify", method: "id", score: null },
    });
    expect(net.calls.some((call) => call.url.includes("/search/track"))).toBe(false);
  });

  it("measures a strictly matched search result and returns its clip and match", async () => {
    const net = network({ search: [deezerEntry(3, "Ice Ice Baby", "Vanilla Ice", SEARCH_CLIP)] });

    const data = JSON.parse(await analyzeAudioPreview.invoke(TRACK));

    expect(data).toMatchObject({
      source: "analyzed",
      audio: audioV2(),
      previewUrl: SEARCH_CLIP,
      previewMatch: { provider: "deezer", method: "search", deezerId: 3, score: 1 },
    });
    const analyze = net.calls.find((call) => call.url === `${SERVICE}/analyze`);
    expect(JSON.parse(analyze?.body ?? "{}")).toEqual({ preview_url: SEARCH_CLIP });
  });

  it("measures nothing and gives no clip when only other recordings have previews", async () => {
    const net = network({
      search: [
        deezerEntry(4, "Ninja Rap", "Vanilla Ice", SEARCH_CLIP),
        deezerEntry(5, "Ice Ice Baby (Karaoke Version)", "Vanilla Ice", SEARCH_CLIP),
        deezerEntry(6, "Ice Ice Baby", "Ice Ice Baby Tribute", SEARCH_CLIP),
      ],
    });

    const data = JSON.parse(await analyzeAudioPreview.invoke(TRACK));

    expect(data).toMatchObject({
      source: "unavailable",
      reason: "no_preview",
      audio: null,
      previewUrl: null,
      previewMatch: null,
    });
    expect(data.error).toContain("1 title_differs, 1 other_version, 1 artist_differs");
    expect(net.calls.some((call) => call.url.startsWith(SERVICE))).toBe(false);
  });

  it("makes no search after a Deezer error and reports the error apart from the missing clip", async () => {
    const net = network({
      isrc: { error: { type: "Exception", message: "Quota limit exceeded", code: 4 } },
    });

    const preview = await resolvePreview(TRACK, undefined);

    expect(preview).toMatchObject({
      previewUrl: null,
      match: null,
      sourceError: { source: "deezer", code: "rate_limited" },
    });
    expect(net.calls.map((call) => call.url)).toEqual([
      "https://api.deezer.com/track/isrc:USSB29000129",
    ]);
  });

  it("still uses Spotify's own clip after a Deezer error, and reports the error", async () => {
    network({ isrc: { error: { type: "Exception", message: "Quota limit exceeded", code: 4 } } });

    const preview = await resolvePreview({ ...TRACK, spotifyPreviewUrl: SPOTIFY_CLIP }, undefined);

    expect(preview).toMatchObject({
      previewUrl: SPOTIFY_CLIP,
      sourceError: { source: "deezer", code: "rate_limited" },
    });
  });

  it("gives the player no clip from a host the service would refuse", async () => {
    const net = network({
      isrc: {
        ...deezerEntry(8, "Ice Ice Baby", "Vanilla Ice", "http://cdnt-preview.dzcdn.net/x.mp3"),
        isrc: TRACK.isrc,
      },
    });

    const data = JSON.parse(await analyzeAudioPreview.invoke(TRACK));

    expect(data).toMatchObject({
      reason: "preview_rejected",
      previewUrl: null,
      previewMatch: null,
    });
    expect(net.calls.some((call) => call.url.startsWith(SERVICE))).toBe(false);
  });

  it("never logs the preview URL it measures", async () => {
    network({
      isrc: { ...deezerEntry(7, "Ice Ice Baby", "Vanilla Ice", ISRC_CLIP), isrc: TRACK.isrc },
    });

    const data = JSON.parse(await analyzeAudioPreview.invoke(TRACK));

    expect(data).toMatchObject({ source: "analyzed", previewUrl: ISRC_CLIP });
    const logged = logs.lines().join("\n");
    expect(logs.entries().some((entry) => entry.component === "Audio")).toBe(true);
    expect(logged).not.toContain("dzcdn.net");
    expect(logged).not.toContain("hdnea");
    expect(logged).not.toContain("[preview link]");
  });
});
