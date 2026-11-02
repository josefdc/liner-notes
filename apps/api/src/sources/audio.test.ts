/**
 * Audio service client. The preview URL checks use the same rules as the audio service (https
 * only, default port, no userinfo, no IP literal): a clip the player may load is on p.scdn.co or
 * a subdomain of dzcdn.net; a clip sent for analysis is on a subdomain of dzcdn.net only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CapturedLogs, captureLogsForTests } from "../logger.js";
import {
  analyzeAudioPreview,
  audioServiceHealth,
  checkAudioServiceHealth,
  isAllowedPreviewUrl,
  isAnalysablePreviewUrl,
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
    expect(isAnalysablePreviewUrl(url)).toBe(false);
  });

  it("sends only Deezer's clips for analysis, never Spotify's", () => {
    expect(isAnalysablePreviewUrl("https://cdnt-preview.dzcdn.net/api/1/1/a/b/0/x.mp3")).toBe(true);
    expect(isAnalysablePreviewUrl("https://cdnt-preview.dzcdn.net:443/api/1/x.mp3")).toBe(true);
    expect(isAnalysablePreviewUrl("https://p.scdn.co/mp3-preview/abc123?cid=1")).toBe(false);
    expect(isAnalysablePreviewUrl("https://p.scdn.co:443/mp3-preview/abc123")).toBe(false);
  });
});

/** A Deezer search answer whose one entry strictly matches TRACK_BY_SEARCH, with `clip`. */
const searchHit = (clip: string) => ({
  total: 1,
  data: [
    {
      id: 1,
      title: "Ice Ice Baby",
      preview: clip,
      duration: 270,
      artist: { id: 1, name: "Vanilla Ice" },
      album: { id: 1, title: "To the Extreme", cover_medium: "" },
    },
  ],
});
const TRACK_BY_SEARCH = {
  title: "Ice Ice Baby",
  artist: "Vanilla Ice",
  album: "To the Extreme",
  durationMs: 270_000,
};

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
  const CLIP = "https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/own.mp3?hdnea=exp=1";
  const TRACK = TRACK_BY_SEARCH;
  const MATCH = { provider: "deezer", method: "search", deezerId: 1, score: 1 } as const;

  /** The service measures the Deezer clip a search found, and answers `answer`. */
  function service(answer: unknown, health: unknown = { status: "ok" }) {
    return stubFetch((call) => {
      if (call.url.startsWith("https://api.deezer.com/search/track?")) return json(searchHit(CLIP));
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
      preview: { previewUrl: CLIP, match: MATCH },
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

  it("never sends Spotify's own clip to the service, even when the run already holds it", async () => {
    const net = service(serviceAnswer(audioV2()));
    const audioRun = {
      preview: {
        previewUrl: "https://p.scdn.co/mp3-preview/x",
        match: { provider: "deezer", method: "isrc", deezerId: 1, score: null },
      },
      serviceAvailable: true,
    };

    const data = JSON.parse(
      await analyzeAudioPreview.invoke(
        { title: "Ice Ice Baby", artist: "Vanilla Ice", isrc: "USSB29000129" },
        { configurable: { audioRun } },
      ),
    );

    expect(data).toMatchObject({
      source: "unavailable",
      reason: "preview_rejected",
      previewUrl: null,
      previewMatch: null,
    });
    expect(net.calls).toEqual([]);
  });

  it("measures nothing when the run knows the service did not answer", async () => {
    const net = service(serviceAnswer(audioV2()));
    const audioRun = {
      preview: { previewUrl: CLIP, match: MATCH },
      serviceAvailable: false,
    };
    const data = JSON.parse(
      await analyzeAudioPreview.invoke(TRACK, { configurable: { audioRun } }),
    );
    expect(data).toMatchObject({ source: "unavailable", reason: "service_unavailable" });
    expect(net.calls).toEqual([]);
  });
});

describe("a preview the service refuses for what the file is", () => {
  const SERVICE = "http://audio.test:3002";
  const CLIP = "https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/own.mp3?hdnea=exp=1";
  const TRACK = TRACK_BY_SEARCH;
  const PREFIX = "The preview is not analysable audio: ";
  const M4A = `${PREFIX}it is an MP4 (M4A) or AAC file, a format the service does not decode`;
  const TRUNCATED = `${PREFIX}the MP3 decodes to less audio than its MPEG audio frames hold`;
  const READ_FAILED = `${PREFIX}the MP3 could not be decoded to the end of its MPEG audio frames`;

  /** The service answers /analyze with `body` and `status` for the Deezer clip a search found. */
  function refusing(body: unknown, status: number) {
    return stubFetch((call) => {
      if (call.url.startsWith("https://api.deezer.com/search/track?")) return json(searchHit(CLIP));
      if (call.url.startsWith("https://api.deezer.com/")) {
        return json({ error: { code: 800, message: "no data" } });
      }
      if (call.url === `${SERVICE}/health`) return json({ status: "ok" });
      if (call.url === `${SERVICE}/analyze`) return json(body, { status });
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

  it.each([
    ["its code", { detail: M4A, code: "unsupported_format" }],
    ["the sentence alone (a service older than the code)", { detail: M4A }],
    // The code is read, not the words: a service may reword its detail.
    [
      "its code, the detail reworded",
      { detail: `${PREFIX}an M4A file`, code: "unsupported_format" },
    ],
  ])("reports an MP4 (M4A) or AAC preview as unsupported_format, by %s", async (_by, body) => {
    refusing(body, 422);
    const data = JSON.parse(await analyzeAudioPreview.invoke(TRACK));
    expect(data).toMatchObject({
      source: "unavailable",
      reason: "unsupported_format",
      audio: null,
      error: body.detail,
    });
  });

  it.each([
    ["its code", TRUNCATED, { code: "decode_incomplete" }],
    ["its code", READ_FAILED, { code: "decode_incomplete" }],
    ["its code, the detail reworded", `${PREFIX}the MP3 ends early`, { code: "decode_incomplete" }],
    // The code wins over words that name another refusal.
    ["its code over the M4A words", M4A, { code: "decode_incomplete" }],
    ["the sentence alone", TRUNCATED, {}],
  ])(
    "reports an MP3 that does not decode to its frames as decode_incomplete, by %s (%s)",
    async (_by, detail, code) => {
      refusing({ detail, ...code }, 422);
      const data = JSON.parse(await analyzeAudioPreview.invoke(TRACK));
      expect(data).toMatchObject({
        source: "unavailable",
        reason: "decode_incomplete",
        audio: null,
        error: detail,
      });
    },
  );

  it.each([
    ["a 500", { detail: "Audio analysis failed" }, 500],
    ["the service's timeout", { detail: "Audio analysis timed out" }, 504],
    ["a failed download", { detail: "Could not download the preview" }, 502],
    ["a busy service", { detail: "The analysis service is busy; try again" }, 503],
    ["another 422", { detail: `${PREFIX}the file could not be decoded as audio` }, 422],
    ["a code this client does not know", { detail: `${PREFIX}newer`, code: "a_newer_code" }, 422],
    // An older service sent these words also when its own pipe or thread could not be set up.
    ["the failed-read words without a code", { detail: READ_FAILED }, 422],
    // The refusal's words or code with another status are not the refusal.
    ["the sentence with a 500", { detail: M4A }, 500],
    ["the code with a 500", { detail: "Audio analysis failed", code: "unsupported_format" }, 500],
  ])("keeps %s as analysis_failed", async (_label, body, status) => {
    refusing(body, status);
    const data = JSON.parse(await analyzeAudioPreview.invoke(TRACK));
    expect(data).toMatchObject({ source: "unavailable", reason: "analysis_failed", audio: null });
  });
});

describe("the chosen track's preview clip", () => {
  const SERVICE = "http://audio.test:3002";
  const ISRC_CLIP = "https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/isrc.mp3?hdnea=exp=1~hmac=a";
  const SEARCH_CLIP = "https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/found.mp3?hdnea=exp=1~hmac=b";
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

  it("takes the Deezer entry for the ISRC first", async () => {
    network({
      isrc: { ...deezerEntry(1, "Ice Ice Baby", "Vanilla Ice", ISRC_CLIP), isrc: TRACK.isrc },
    });

    const preview = await resolvePreview(TRACK, undefined);

    expect(preview).toEqual({
      previewUrl: ISRC_CLIP,
      match: { provider: "deezer", method: "isrc", deezerId: 1, score: null },
    });
  });

  it("takes a strict Deezer search result when the ISRC has no Deezer preview", async () => {
    const net = network({ search: [deezerEntry(2, "Ice Ice Baby", "Vanilla Ice", SEARCH_CLIP)] });

    const preview = await resolvePreview(TRACK, undefined);

    expect(preview).toEqual({
      previewUrl: SEARCH_CLIP,
      match: { provider: "deezer", method: "search", deezerId: 2, score: 1 },
    });
    expect(net.calls.some((call) => call.url.includes("/search/track"))).toBe(true);
  });

  it("says there is no preview on Deezer when neither lookup finds one", async () => {
    network({});

    const preview = await resolvePreview(TRACK, undefined);

    expect(preview).toEqual({
      previewUrl: null,
      match: null,
      detail: "No preview of this recording on Deezer",
    });
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

  it("reports a lookup a Deezer error stopped as incomplete, never as no clip", async () => {
    const net = network({
      isrc: { error: { type: "Exception", message: "Quota limit exceeded", code: 4 } },
    });

    const data = JSON.parse(await analyzeAudioPreview.invoke(TRACK));

    expect(data).toMatchObject({
      source: "unavailable",
      reason: "preview_lookup_incomplete",
      audio: null,
      previewUrl: null,
      previewSourceError: { source: "deezer", code: "rate_limited" },
    });
    expect(net.calls.some((call) => call.url.startsWith(SERVICE))).toBe(false);
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
