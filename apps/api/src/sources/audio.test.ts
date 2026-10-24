/**
 * Audio service client. The preview URL check uses the same rules as the audio service (https
 * only, host p.scdn.co or a subdomain of dzcdn.net, default port, no userinfo, no IP literal).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  analyzeAudioPreview,
  checkAudioServiceHealth,
  isAllowedPreviewUrl,
  resolvePreview,
} from "./audio.js";
import { json, never, stubFetch } from "./testing/fetchStub.js";

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
      if (call.url === `${SERVICE}/analyze`) {
        return json({ source: "analyzed", bpm: 116, key: "D", mode: "minor", energy: 0.7 });
      }
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
      bpm: 116,
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
      bpm: null,
      key: null,
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
    const logged = (["log", "warn", "error"] as const)
      .flatMap((method) => vi.mocked(console[method]).mock.calls.flat())
      .map((arg) => String(arg))
      .join("\n");
    expect(logged).not.toContain("dzcdn.net");
    expect(logged).not.toContain("hdnea");
  });
});
