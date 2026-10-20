/**
 * Audio service client. The preview URL check uses the same rules as the audio service (https
 * only, host p.scdn.co or a subdomain of dzcdn.net, default port, no userinfo, no IP literal).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { analyzeAudioPreview, checkAudioServiceHealth, isAllowedPreviewUrl } from "./audio.js";
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
      await analyzeAudioPreview.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
    );

    expect(data).toMatchObject({ source: "unavailable", reason: "analysis_failed" });
    expect(data.error).toBe("could not decode the clip");
  });
});
