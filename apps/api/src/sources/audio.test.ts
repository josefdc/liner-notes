/**
 * Preview URL check: the same rules as the audio service (https only, host p.scdn.co or a
 * subdomain of dzcdn.net, default port, no userinfo, no IP literal).
 */

import { describe, expect, it } from "vitest";
import { isAllowedPreviewUrl } from "./audio.js";

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
