/**
 * The shared request helper: timeouts, typed errors, and the cassette record/replay hook
 * (SOURCE_CASSETTE=record|replay, SOURCE_CASSETTE_DIR). Fetch is stubbed throughout.
 */

import { execFile, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect, promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { captureLogsForTests } from "../logger.js";
import {
  cassetteKey,
  credential,
  describeError,
  fetchJson,
  hasStackTrace,
  isMediaUrl,
  isSecretKey,
  pick,
  plainMessage,
  plainReason,
  reasonIssue,
  redactQuotedSecrets,
  redactText,
  redactTokenRuns,
  replacePhoneLike,
  SourceError,
  scrubPayload,
  scrubReadPayload,
  scrubText,
  setCassetteLockWaitForTests,
  withoutEmails,
} from "./http.js";
import { html, json, never, stubFetch } from "./testing/fetchStub.js";
import { allStrings, disagreements, randomStrings, timed } from "./testing/strings.js";

// Pass-through, so one test can make a write fail half-way.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

const URL_A = "https://api.example.test/v1/thing?b=2&a=1";

async function rejection(promise: Promise<unknown>): Promise<SourceError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SourceError);
    return error as SourceError;
  }
  throw new Error("expected the request to fail");
}

describe("fetchJson", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves with the JSON body and sends a User-Agent", async () => {
    const net = stubFetch(() => json({ ok: 1 }));

    await expect(fetchJson({ source: "deezer", url: URL_A })).resolves.toEqual({ ok: 1 });
    expect(net.calls[0].headers["user-agent"]).toMatch(/^LinerNotes\//);
  });

  it("times out", async () => {
    stubFetch((call) => never(call));

    const error = await rejection(fetchJson({ source: "deezer", url: URL_A, timeoutMs: 20 }));

    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("no answer within 20 ms");
  });

  it("reports the caller's abort as aborted, not as a timeout", async () => {
    stubFetch((call) => never(call));
    const controller = new AbortController();

    const pending = rejection(
      fetchJson({ source: "deezer", url: URL_A, signal: controller.signal }),
    );
    controller.abort();

    expect((await pending).kind).toBe("aborted");
  });

  it("reports a connection failure as a network error", async () => {
    stubFetch(() => Promise.reject(new TypeError("fetch failed")));

    expect((await rejection(fetchJson({ source: "deezer", url: URL_A }))).kind).toBe("network");
  });

  it("reads a Retry-After given as an HTTP date", async () => {
    const at = new Date(Date.now() + 120_000).toUTCString();
    stubFetch(() => json({}, { status: 429, headers: { "Retry-After": at } }));

    const error = await rejection(fetchJson({ source: "spotify", url: URL_A }));

    expect(error.retryAfterMs).toBeGreaterThan(100_000);
    expect(error.retryAfterMs).toBeLessThanOrEqual(120_000);
  });

  it("types a 429 with the wait the source asked for", async () => {
    stubFetch(() => json({}, { status: 429, headers: { "Retry-After": "7" } }));

    const error = await rejection(fetchJson({ source: "spotify", url: URL_A }));

    expect(error).toMatchObject({ kind: "rate_limited", status: 429, retryAfterMs: 7000 });
  });

  it("treats a source's own slow-down status as a rate limit", async () => {
    stubFetch(() => json({}, { status: 503 }));

    const error = await rejection(
      fetchJson({ source: "musicbrainz", url: URL_A, rateLimitStatuses: [429, 503] }),
    );

    expect(error.kind).toBe("rate_limited");
  });

  it("keeps the status and a short detail of other HTTP errors", async () => {
    stubFetch(() => json({ error: 6, message: "Track not found" }, { status: 400 }));

    const error = await rejection(fetchJson({ source: "lastfm", url: URL_A }));

    expect(error).toMatchObject({ kind: "http", status: 400 });
    expect(error.message).toContain("Track not found");
    expect(error.body).toEqual({ error: 6, message: "Track not found" });
  });

  it("rejects an HTML answer as a content-type error", async () => {
    stubFetch(() => html("<html>challenge</html>"));

    const error = await rejection(fetchJson({ source: "listenbrainz", url: URL_A }));

    expect(error.kind).toBe("content_type");
    expect(error.message).toContain("text/html");
  });

  it("keeps an HTML error page out of the error message, and logs it at debug level only", async () => {
    const page =
      '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>' +
      `<meta http-equiv="Content-Type" content="text/html"></head><body>${"challenge ".repeat(300)}</body></html>`;
    stubFetch(() => html(page, 403));
    const logs = captureLogsForTests();

    let error: SourceError;
    try {
      error = await rejection(fetchJson({ source: "secondhandsongs", url: URL_A }));
    } finally {
      logs.restore();
    }

    expect(error).toMatchObject({ kind: "http", status: 403 });
    expect(error.message).toBe("secondhandsongs: HTTP 403 (the source refused the request)");
    expect(error.message).not.toContain("<");
    expect(describeError(error).length).toBeLessThan(100);
    const shown = logs.entries().filter((entry) => JSON.stringify(entry).includes("Just a moment"));
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.every((entry) => entry.level === "debug")).toBe(true);
  });

  it("keeps only a short plain-text reason from a JSON error body", async () => {
    stubFetch(() => json({ message: "<html><body>Forbidden</body></html>" }, { status: 403 }));
    const markup = await rejection(fetchJson({ source: "deezer", url: URL_A }));
    expect(markup.message).toBe("deezer: HTTP 403 (the source refused the request)");

    stubFetch(() => json({ message: `Too long ${"x".repeat(400)}` }, { status: 500 }));
    const long = await rejection(fetchJson({ source: "deezer", url: URL_A }));
    expect(long.message.length).toBeLessThan(150);
  });

  it("reads a JSON error body only up to 64 KiB in bytes; a success body of any size is parsed", async () => {
    // 40,000 "é" are 40,000 UTF-16 units but 80,000 bytes.
    const huge = { message: "Track not found", padding: "é".repeat(40_000) };
    const bytes = Buffer.byteLength(JSON.stringify(huge));
    stubFetch(() => json(huge, { status: 400 }));
    const logs = captureLogsForTests();
    let error: SourceError;
    try {
      error = await rejection(fetchJson({ source: "lastfm", url: URL_A }));
    } finally {
      logs.restore();
    }
    expect(error).toMatchObject({ kind: "http", status: 400 });
    expect(error.message).toBe("lastfm: HTTP 400 (the source rejected the request)");
    expect(error.body).toBeUndefined();
    const logged = logs.entries().map((entry) => JSON.stringify(entry));
    const line = `a JSON body too large to read (${bytes} bytes, over 65536 bytes)`;
    expect(logged.some((entry) => entry.includes(line))).toBe(true);
    expect(logged.some((entry) => entry.includes("not JSON") || entry.includes("é"))).toBe(false);

    // At exactly 64 KiB it is read; one byte more and it is not.
    const sized = (bytes: number) => {
      const head = { message: "Track not found", padding: "" };
      const room = bytes - Buffer.byteLength(JSON.stringify(head));
      return { ...head, padding: `${"é".repeat(Math.floor(room / 2))}${"x".repeat(room % 2)}` };
    };
    for (const [bytes, message] of [
      [64 * 1024, "lastfm: HTTP 400 — Track not found"],
      [64 * 1024 + 1, "lastfm: HTTP 400 (the source rejected the request)"],
    ] as const) {
      const body = sized(bytes);
      expect(Buffer.byteLength(JSON.stringify(body))).toBe(bytes);
      stubFetch(() => json(body, { status: 400 }));
      expect((await rejection(fetchJson({ source: "lastfm", url: URL_A }))).message).toBe(message);
    }

    stubFetch(() => json(huge));
    expect(await fetchJson({ source: "lastfm", url: URL_A })).toEqual(huge);
  });

  it("keeps no escaped markup, link or stack trace in a source's reason", () => {
    expect(plainReason("&lt;!DOCTYPE html&gt;&lt;html lang=&quot;en-US&quot;&gt;")).toBeUndefined();
    expect(plainReason("Blocked &#60;script&#62;")).toBeUndefined();
    expect(
      plainReason(
        "Error: boom at handler (/srv/app/index.js:10:5) at next (/srv/app/router.js:3:1)",
      ),
    ).toBeUndefined();
    expect(
      plainReason('Traceback (most recent call last): File "main.py", line 4'),
    ).toBeUndefined();
    const signed = plainReason(
      "Invalid signature for https://cdnt-preview.dzcdn.net/a/b.mp3?hdnts=exp=1~acl=/*~hmac=deadbeef",
    );
    expect(signed).toBe("Invalid signature for [link]");
    expect(plainReason("Blocked: &amp;lt;!DOCTYPE html&amp;gt;")).toBeUndefined();
    expect(
      plainReason("Invalid signature for cdnt-preview.dzcdn.net/a/b.mp3?hdnts=exp=1~hmac=deadbeef"),
    ).toBeUndefined();
    expect(plainReason("Expired: bucket.example/x?X-Amz-Expires=60")).toBeUndefined();
    expect(plainReason("Rejected key token=abc123")).toBeUndefined();
    expect(plainReason("Quota resets at 10:30:00 UTC")).toBe("Quota resets at 10:30:00 UTC");
    expect(plainReason("Simon & Garfunkel: Track not found")).toBe(
      "Simon & Garfunkel: Track not found",
    );
  });

  it("rejects a JSON content type with a broken body as a parse error", async () => {
    stubFetch(() => new Response("{not json", { headers: { "content-type": "application/json" } }));

    expect((await rejection(fetchJson({ source: "deezer", url: URL_A }))).kind).toBe("parse");
  });
});

describe("scrubbing", () => {
  it("pick keeps only the listed fields and reads a single object where a list is expected", () => {
    const shape = { items: [{ id: true, name: true }] } as const;

    expect(pick({ items: [{ id: 1, name: "a", extra: "x" }], total: 1 }, shape)).toEqual({
      items: [{ id: 1, name: "a" }],
    });
    expect(pick({ items: { id: 1, name: "a", extra: "x" } }, shape)).toEqual({
      items: { id: 1, name: "a" },
    });
  });

  it("drops preview and image URLs and secrets, and caps text", () => {
    const scrubbed = scrubPayload({
      preview_url: "https://p.scdn.co/mp3-preview/abc",
      images: [{ url: "https://i.scdn.co/image/abc" }],
      album: { cover_medium: "https://e-cdns-images.dzcdn.net/images/cover/x.jpg", name: "A" },
      link: "https://cdnt-preview.dzcdn.net/api/1/1/x.mp3?hdnea=1",
      access_token: "secret-token",
      bio: "x".repeat(5000),
      page: "https://www.whosampled.com/Vanilla-Ice/",
    }) as Record<string, unknown>;

    expect(scrubbed).not.toHaveProperty("preview_url");
    expect(scrubbed).not.toHaveProperty("images");
    expect(scrubbed.album).toEqual({ name: "A" });
    expect(scrubbed.link).toBeNull();
    expect(scrubbed.access_token).toBe("[redacted]");
    expect((scrubbed.bio as string).length).toBe(500);
    expect(scrubbed.page).toBe("https://www.whosampled.com/Vanilla-Ice/");
  });

  it("redacts secrets inside text values, not only under secret keys", () => {
    const text = scrubText(
      "Authorization: Bearer abc.def-123456789 then ?api_key=K1&key=K2&token=K3 and tvly-dev-XYZ123 " +
        `and BQ${"x1Y".repeat(30)} and ${"aB3".repeat(25)}`,
    );

    for (const leaked of ["abc.def-123456789", "K1", "K2", "K3", "XYZ123", "x1Y", "aB3aB3"]) {
      expect(text).not.toContain(leaked);
    }
  });

  it.each([
    ["absolute", "https://lastfm.freetls.fastly.net/i/u/300x300/abc.png"],
    ["protocol-relative", "//i.scdn.co/image/ab67616d0000b273"],
    ["Cover Art Archive", "https://coverartarchive.org/release/x/front-250"],
    ["Deezer image host", "https://e-cdns-images.dzcdn.net/images/artist/x/250x250-000000.jpg"],
    ["Deezer preview host", "https://cdnt-preview.dzcdn.net/api/1/1/a/b/c.mp3?hdnea=exp=1"],
    ["avif", "https://img.example.test/a.avif"],
    ["mp4", "https://cdn.example.test/v/clip.mp4"],
    ["flac", "https://cdn.example.test/a/track.flac"],
    ["mp3", "https://cdn.example.test/a/track.mp3"],
    ["jpg", "https://cdn.example.test/a.jpg"],
    ["png", "https://cdn.example.test/a.png"],
    ["webp", "https://cdn.example.test/a.webp"],
  ])("removes a %s media URL inside text", (_name, url) => {
    const text = scrubText(`see ${url} for the cover`);

    expect(text).not.toContain(url);
    expect(text).toContain("[media]");
    expect(scrubPayload(url)).toBeNull();
  });

  it("keeps ordinary links, dates and counts, and masks e-mails and phone numbers", () => {
    const text = scrubText(
      "Released 1990-10-02 (10016 plays), https://www.whosampled.com/Vanilla-Ice/ — " +
        "write to fan.mail@example.org or call +1 (555) 123-4567. " +
        "Artist e21857d5-3256-4547-afb3-4b6ded592596.",
    );

    expect(text).toContain("e21857d5-3256-4547-afb3-4b6ded592596");

    expect(text).toContain("1990-10-02");
    expect(text).toContain("10016");
    expect(text).toContain("https://www.whosampled.com/Vanilla-Ice/");
    expect(text).not.toContain("fan.mail@example.org");
    expect(text).not.toContain("123-4567");
  });

  // The keys the parsed path redacts (scrubPayload), each written quoted in text that was not
  // parsed. The values have no token shape, so only the quoted-key rule can catch them.
  it.each([
    "x-api-key",
    "access_token",
    "refresh_token",
    "id_token",
    "auth_token",
    "api_key",
    "apikey",
    "client_secret",
    "private_key",
    "password",
    "token",
    "secret",
    "authorization",
  ])('redacts the value of a quoted "%s" key in text, as the parsed path does', (key) => {
    expect(scrubPayload({ [key]: "plain-value-1" })).toEqual({ [key]: "[redacted]" });
    for (const written of [
      `{"${key}":"plain-value-1"}`,
      `<pre>{"error": 1, "${key}" : "plain-value-1"}</pre>`,
      `{'${key}': 'plain-value-1'}`,
      `{"${key.toUpperCase()}":"plain-value-1"}`,
    ]) {
      const text = scrubText(written);
      expect(text, written).not.toContain("plain-value-1");
      expect(text, written).toContain("[redacted]");
    }
  });

  it("reads a secret key in any case, with or without _ and -, in a parsed body and in text", () => {
    const spellings = [
      "accessToken",
      "clientSecret",
      "refreshToken",
      "api-key",
      "X_API_KEY",
      "idToken",
      "AuthToken",
      "privateKey",
      "Client-Secret",
    ];
    for (const key of spellings) {
      expect(isSecretKey(key), key).toBe(true);
      expect(scrubPayload({ [key]: "plain-value-1" }), key).toEqual({ [key]: "[redacted]" });
      expect(scrubReadPayload({ [key]: "plain-value-1" }), key).toEqual({ [key]: "[redacted]" });
      expect(scrubText(`{"${key}":"plain-value-1"}`), key).toBe(`{"${key}":"[redacted]"}`);
    }
    const kept = { tokenType: "bearer", tokens: 3, my_token: "a", secretSanta: "b", keyId: "c" };
    for (const key of Object.keys(kept)) expect(isSecretKey(key), key).toBe(false);
    expect(scrubPayload(kept)).toEqual(kept);
    expect(scrubText(JSON.stringify(kept))).toBe(JSON.stringify(kept));
  });

  it("reads a quoted value to its closing quote, escapes included, and leaves other keys alone", () => {
    const cases: Array<[string, string]> = [
      ['{"password":"a\\"b\\\\c d"}', '{"password":"[redacted]"}'],
      ['{"password" :\n "pw 1", "next":"kept"}', '{"password" :\n "[redacted]", "next":"kept"}'],
      [`{'token': "it's mine"}`, `{'token': "[redacted]"}`],
      // A JSON string inside a JSON string: the quotes are escaped, and so are its own escapes.
      [
        '{"error":"{\\"client_secret\\":\\"in \\\\\\"side\\",\\"next\\":\\"kept\\"}"}',
        '{"error":"{\\"client_secret\\":\\"[redacted]\\",\\"next\\":\\"kept\\"}"}',
      ],
      // The inner value ends in an escaped backslash, then an escaped quote of its own.
      [
        '"{\\"token\\":\\"a\\\\\\\\\\\\\\"b\\",\\"next\\":\\"kept\\"}"',
        '"{\\"token\\":\\"[redacted]\\",\\"next\\":\\"kept\\"}"',
      ],
      // A secret value that holds another quoted secret key is read past, whole.
      [`{"token":"a 'secret': 'b' tail-1"}`, '{"token":"[redacted]"}'],
      // A body cut off inside the value: the rest of it goes.
      ['<p>{"password":"hunter2 and the rest', '<p>{"password":"[redacted]'],
      // Not a secret key, or not a value to read here: left as it is.
      ['{"my_token":"kept-1","tokens":"kept-2","token_type":"kept-3"}', ""],
      ['{"token":{"type":"kept-4"},"password":"","Secret":12345678}', ""],
      ["token: kept-5 and password=", ""],
    ];
    for (const [text, expected] of cases) {
      expect(redactQuotedSecrets(text), text).toBe(expected || text);
    }
    // Read before the `key=` rule, which would end the value at its escaped quote.
    expect(scrubText('{"password":"key=abc\\" def"}')).toBe('{"password":"[redacted]"}');
  });

  it("reads quoted secret keys before the header rule, which does not read escapes", () => {
    for (const text of [
      '{"error":"bad header","body":"{\\"password\\":\\"pw-h1\\"}"}',
      '{"error":"missing Authorization header","password":"ab\\"pw-h1"}',
      '<html><header>x</header><pre>{"client_secret":"x\\"pw-h1"}</pre></html>',
    ]) {
      expect(redactText(text), text).not.toContain("pw-h1");
      expect(scrubText(text), text).not.toContain("pw-h1");
    }
    // Whether the text mentions a header is asked of the text as it came, so "header" inside a
    // redacted value still has every quoted value removed, as before.
    expect(redactText('"token" : "header", "kept":"other quoted"')).toBe(
      '"[redacted]" : "[redacted]", "[redacted]":"[redacted]"',
    );
  });

  it.each([
    ["Deezer preview", "https:\\/\\/cdns-preview-1.dzcdn.net\\/stream\\/c-1?hdnea=exp=1~hmac=abc"],
    ["protocol-relative image", "\\/\\/i.scdn.co\\/image\\/ab67616d0000b273"],
    ["http mp3", "http:\\/\\/cdn.example.test\\/a\\/track.mp3"],
  ])("removes a %s URL written with JSON-escaped slashes, as its plain form", (_name, url) => {
    const plain = url.replaceAll("\\/", "/");
    expect(scrubText(`see ${plain} now`)).toBe("see [media] now");
    expect(scrubText(`{"note":"see ${url}","next":"kept"}`)).toBe(
      '{"note":"see [media]","next":"kept"}',
    );
  });

  it("keeps an ordinary link written with JSON-escaped slashes", () => {
    const text = '{"page":"https:\\/\\/www.whosampled.com\\/Vanilla-Ice\\/"}';
    expect(scrubText(text)).toBe(text);
  });

  it("redacts a header value that fetch echoes in its error", () => {
    // Not a known key and no token shape: only the header rule can catch it.
    const error = new TypeError('Headers.append: "plain value 42\n" is an invalid header value.');

    expect(describeError(error)).not.toContain("plain value 42");
    expect(describeError(error)).toContain("invalid header value");
  });

  it("redacts the value of a configured credential wherever it appears", () => {
    process.env.TEST_SERVICE_API_KEY = "plainsecretvalue123";
    try {
      expect(redactText("request for plainsecretvalue123 failed")).not.toContain(
        "plainsecretvalue123",
      );
      expect(describeError(new Error("bad key plainsecretvalue123"))).not.toContain(
        "plainsecretvalue123",
      );
    } finally {
      delete process.env.TEST_SERVICE_API_KEY;
    }
  });

  it("never rewrites id-shaped values in data the pipeline reads", () => {
    // A configured credential that happens to be part of an MBID must not alter the MBID.
    process.env.TEST_SHORT_TOKEN = "0aa8294b";
    try {
      const ids = {
        mbid: "0aa8294b-6332-4b65-b677-e3a1f8591d3b",
        spotify: "3Fcfwhm8oRrBvBZ8KGhtea",
        isrc: "USSB10000001",
      };
      expect(scrubReadPayload(ids)).toEqual(ids);
    } finally {
      delete process.env.TEST_SHORT_TOKEN;
    }
  });

  it("keeps data the pipeline reads byte for byte: no e-mail or phone masking, long text", () => {
    const text = `"1-800-273-8255" by Logic; booking@example.org; ${"x".repeat(1500)}`;

    expect(scrubReadPayload({ content: text })).toEqual({ content: text });
  });

  it("cassette keys drop secret parameters in any case and URL user info", () => {
    const key = cassetteKey(
      "GET",
      "https://user:pass@ws.example.test/2.0/?API_KEY=S1&Token=S2&Key=S3&a=1",
    );

    expect(key).toBe("GET https://ws.example.test/2.0/?a=1");
  });

  it("cassette keys tell two POST bodies to one URL apart", () => {
    const a = cassetteKey("POST", "https://api.tavily.com/search", '{"query":"a"}');
    const b = cassetteKey("POST", "https://api.tavily.com/search", '{"query":"b"}');

    expect(a).not.toBe(b);
  });

  it("cassette keys leave out API keys and do not depend on parameter order", () => {
    const a = cassetteKey("GET", "https://ws.example.test/2.0/?api_key=SECRET&b=2&a=1");
    const b = cassetteKey("GET", "https://ws.example.test/2.0/?a=1&b=2&api_key=OTHER");

    expect(a).toBe(b);
    expect(a).not.toContain("SECRET");
  });
});

describe("cassettes", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cassettes-"));
    process.env.SOURCE_CASSETTE_DIR = dir;
  });
  afterEach(() => {
    delete process.env.SOURCE_CASSETTE;
    delete process.env.SOURCE_CASSETTE_DIR;
    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });

  const live = {
    tracks: {
      items: [
        {
          id: "3Fcfwhm8oRrBvBZ8KGhtea",
          name: "Ice Ice Baby",
          preview_url: "https://p.scdn.co/mp3-preview/abc",
          album: { name: "To the Extreme", images: [{ url: "https://i.scdn.co/image/x" }] },
          available_markets: ["US", "GB"],
        },
      ],
    },
  };
  const shape = { tracks: { items: [{ id: true, name: true, album: { name: true } }] } } as const;
  const request = {
    source: "spotify" as const,
    url: "https://api.spotify.com/v1/search?q=ice&type=track",
    headers: { Authorization: "Bearer live-token" },
    scrub: shape,
  };

  it("records a scrubbed answer, then replays it without the network", async () => {
    process.env.SOURCE_CASSETTE = "record";
    stubFetch(() => json(live));

    await expect(fetchJson(request)).resolves.toEqual(live);

    const file = readFileSync(join(dir, "spotify.json"), "utf8");
    expect(file).not.toMatch(/scdn\.co|preview|images|available_markets|live-token/);

    process.env.SOURCE_CASSETTE = "replay";
    const net = stubFetch(() => undefined);

    await expect(fetchJson(request)).resolves.toEqual({
      tracks: {
        items: [
          { id: "3Fcfwhm8oRrBvBZ8KGhtea", name: "Ice Ice Baby", album: { name: "To the Extreme" } },
        ],
      },
    });
    expect(net.calls).toHaveLength(0);
  });

  it("replays recorded errors as the same typed error", async () => {
    process.env.SOURCE_CASSETTE = "record";
    stubFetch(() => json({}, { status: 429, headers: { "Retry-After": "2" } }));
    await rejection(fetchJson(request));

    process.env.SOURCE_CASSETTE = "replay";
    const net = stubFetch(() => undefined);
    const error = await rejection(fetchJson(request));

    expect(error).toMatchObject({ kind: "rate_limited", retryAfterMs: 2000 });
    expect(net.calls).toHaveLength(0);
  });

  it("records only the size of a JSON error body over the cap, and replays the same error", async () => {
    // Secrets and an escaped signed link a parsed body would have redacted (scrubPayload); a body
    // this large is not read, so none of it may reach the cassette or the log.
    const head =
      '{"error":6,"message":"Track not found","client_secret":"shh-upstream-secret-1",' +
      '"password":"hunter2-pw","authorization":"opaque-auth-value",' +
      '"preview":"https:\\/\\/cdns-preview-1.dzcdn.net\\/stream\\/c-1?hdnea=exp=1~acl=x~hmac=abc",' +
      '"note":"see https://cdns-preview-2.dzcdn.net/stream/c-2?hdnea=exp=2~hmac=def"';
    const body = `${head},"padding":"${"x".repeat(70_000)}"}`;
    const bytes = Buffer.byteLength(body);
    const leaks = [
      "shh-upstream-secret-1",
      "hunter2-pw",
      "opaque-auth-value",
      "hdnea",
      "dzcdn",
      "xxxx",
    ];
    const lastfm = {
      source: "lastfm" as const,
      url: "https://ws.audioscrobbler.com/2.0/?method=x",
    };
    const line = `lastfm answered HTTP 400 with a JSON body too large to read (${bytes} bytes, over 65536 bytes)`;

    process.env.SOURCE_CASSETTE = "record";
    stubFetch(
      () => new Response(body, { status: 400, headers: { "content-type": "application/json" } }),
    );
    const recordLogs = captureLogsForTests();
    let recorded: SourceError;
    try {
      recorded = await rejection(fetchJson(lastfm));
    } finally {
      recordLogs.restore();
    }
    const file = readFileSync(join(dir, "lastfm.json"), "utf8");
    for (const leak of leaks) expect(file).not.toContain(leak);
    const entry = Object.values(JSON.parse(file).entries)[0];
    expect(entry).toEqual({ status: 400, contentType: "application/json", tooLarge: bytes });
    const recordedLog = JSON.stringify(recordLogs.entries());
    for (const leak of leaks) expect(recordedLog).not.toContain(leak);
    expect(recordedLog).toContain(line);

    process.env.SOURCE_CASSETTE = "replay";
    const net = stubFetch(() => undefined);
    const replayLogs = captureLogsForTests();
    let replayed: SourceError;
    try {
      replayed = await rejection(fetchJson(lastfm));
    } finally {
      replayLogs.restore();
    }
    expect(net.calls).toHaveLength(0);
    expect(replayed.message).toBe(recorded.message);
    expect(replayed.message).toBe("lastfm: HTTP 400 (the source rejected the request)");
    expect(replayed.body).toBeUndefined();
    expect(JSON.stringify(replayLogs.entries())).toContain(line);
  });

  it("a request missing from the cassette is a typed error, never a network call", async () => {
    process.env.SOURCE_CASSETTE = "replay";
    writeFileSync(join(dir, "spotify.json"), JSON.stringify({ version: 1, entries: {} }));
    const net = stubFetch(() => json(live));

    const error = await rejection(fetchJson(request));

    expect(error.kind).toBe("cassette_miss");
    expect(net.calls).toHaveLength(0);
  });

  it("a missing cassette file is a miss too", async () => {
    process.env.SOURCE_CASSETTE = "replay";
    const net = stubFetch(() => json(live));

    expect((await rejection(fetchJson(request))).kind).toBe("cassette_miss");
    expect(net.calls).toHaveLength(0);
  });

  it("records the Tavily answers for two queries to one URL as two entries", async () => {
    process.env.SOURCE_CASSETTE = "record";
    const post = (query: string) => ({
      source: "tavily" as const,
      url: "https://api.tavily.com/search",
      method: "POST" as const,
      body: JSON.stringify({ query }),
    });
    stubFetch((call) => json({ results: [{ query: JSON.parse(call.body ?? "{}").query }] }));
    await fetchJson(post("first"));
    await fetchJson(post("second"));

    process.env.SOURCE_CASSETTE = "replay";
    stubFetch(() => undefined);

    await expect(fetchJson(post("first"))).resolves.toEqual({ results: [{ query: "first" }] });
    await expect(fetchJson(post("second"))).resolves.toEqual({ results: [{ query: "second" }] });
  });

  it("caps and scrubs a recorded text answer", async () => {
    process.env.SOURCE_CASSETTE = "record";
    stubFetch(() => html(`<p>key=tvly-leak-123 ${"x".repeat(5000)}</p>`));
    await rejection(fetchJson({ source: "listenbrainz", url: URL_A }));

    const entry = Object.values(
      JSON.parse(readFileSync(join(dir, "listenbrainz.json"), "utf8")).entries,
    )[0] as { text: string };
    expect(entry.text.length).toBeLessThanOrEqual(500);
    expect(entry.text).not.toContain("tvly-leak-123");
  });

  it("scrubs a recorded JSON error body", async () => {
    process.env.SOURCE_CASSETTE = "record";
    stubFetch(() =>
      json(
        {
          error: { status: 401, message: "Invalid access token Bearer BQabc123secret" },
          image: "https://i.scdn.co/image/x",
        },
        { status: 401 },
      ),
    );
    await rejection(fetchJson({ source: "spotify", url: URL_A }));

    const file = readFileSync(join(dir, "spotify.json"), "utf8");
    expect(file).not.toContain("BQabc123secret");
    expect(file).not.toContain("scdn.co");
  });

  describe("an error body that is not parsed", () => {
    // Quoted secret keys and JSON-escaped signed preview links: what scrubPayload removes from a
    // body that parses. None of the values may reach the cassette, the error or the log.
    const pairs =
      '"client_secret":"shh-upstream-secret-1", "password" : "hunter2-pw", ' +
      '"authorization":"opaque-auth-value", "access_token":"at-value-1", ' +
      '"refresh_token":"rt-value-1", "api_key":"ak-value-1", "token":"a\\"b tk-value-1", ' +
      "'secret': 'single-quoted-value-1'";
    const links =
      "https:\\/\\/cdns-preview-1.dzcdn.net\\/stream\\/c-1?hdnea=exp=1~acl=x~hmac=abc and " +
      "\\/\\/cdns-preview-2.dzcdn.net\\/stream\\/c-2?hdnea=exp=2~hmac=def";
    const leaks = [
      "shh-upstream-secret-1",
      "hunter2-pw",
      "opaque-auth-value",
      "at-value-1",
      "rt-value-1",
      "ak-value-1",
      "tk-value-1",
      "single-quoted-value-1",
      "esc-value-1",
      "hdnea",
      "hmac",
      "dzcdn",
    ];
    const lastfm = { source: "lastfm" as const, url: "https://ws.audioscrobbler.com/2.0/?m=x" };

    /** Everything a caller or a log can see of a thrown error. */
    const shown = (error: SourceError) =>
      [
        error.message,
        String(error.body),
        inspect(error, { showHidden: true, depth: 8 }),
        JSON.stringify(error),
      ].join("\n");

    it.each([
      [
        "a text/html",
        "text/html; charset=utf-8",
        `<html><body><pre>{${pairs}, "preview":"${links}"}</pre></body></html>`,
      ],
      ["an invalid-JSON", "application/json", `{"error":6,${pairs},"preview":"${links}"`],
      [
        "a text/html (with a <header>)",
        "text/html",
        '<html><header>Sign in</header><script>var d="{\\"access_token\\":\\"esc-value-1\\"}";' +
          `</script><pre>{${pairs}, "preview":"${links}"}</pre></html>`,
      ],
    ])(
      "keeps no secret or signed link of %s 400 body, live, recorded or replayed",
      async (_name, contentType, body) => {
        expect(Buffer.byteLength(body)).toBeLessThan(64 * 1024);
        const errors: Record<string, SourceError> = {};
        for (const mode of ["off", "record", "replay"]) {
          process.env.SOURCE_CASSETTE = mode;
          const net = stubFetch(() =>
            mode === "replay"
              ? undefined
              : new Response(body, { status: 400, headers: { "content-type": contentType } }),
          );
          const logs = captureLogsForTests();
          let error: SourceError;
          try {
            error = await rejection(fetchJson(lastfm));
          } finally {
            logs.restore();
          }
          expect(net.calls).toHaveLength(mode === "replay" ? 0 : 1);
          expect(error).toMatchObject({ kind: "http", status: 400 });
          expect(error.message).toBe("lastfm: HTTP 400 (the source rejected the request)");
          const logged = JSON.stringify(logs.entries());
          expect(logged).toContain("with a body that is not JSON");
          for (const leak of leaks) {
            expect(shown(error), `${mode}: error`).not.toContain(leak);
            expect(logged, `${mode}: log`).not.toContain(leak);
          }
          expect(error.body).toContain("[redacted]");
          // In a text that mentions a header, every quoted value goes, links included.
          expect(error.body).toContain(/header/i.test(body) ? '"[redacted]"' : "[media]");
          errors[mode] = error;
        }

        const file = readFileSync(join(dir, "lastfm.json"), "utf8");
        for (const leak of leaks) expect(file).not.toContain(leak);
        const entry = Object.values(JSON.parse(file).entries)[0] as { text: string };
        // The replayed error is the recorded one, which is the live one.
        expect(entry.text).toBe(errors.record?.body);
        for (const mode of ["off", "replay"]) {
          expect(errors[mode]?.message).toBe(errors.record?.message);
          expect(errors[mode]?.body).toBe(errors.record?.body);
        }
      },
    );
  });

  it.each([
    ["back an hour", -60 * 60_000],
    ["forward 10 s", 10_000],
  ])(
    "waits for a held cassette lock on the monotonic clock when the wall clock steps %s",
    async (_label, step) => {
      process.env.SOURCE_CASSETTE = "record";
      let answeredAt = Number.NaN;
      stubFetch(() => {
        // The wait for the lock starts once the answer is in: the clock steps 50 ms into it.
        answeredAt = performance.now();
        setTimeout(() => vi.setSystemTime(Date.now() + step), 50);
        return json({ ok: true });
      });
      // Held by this process, which is alive: only the wait (500 ms here) ends it.
      writeFileSync(join(dir, "deezer.json.lock"), String(process.pid));
      onTestFinished(setCassetteLockWaitForTests(500));
      vi.useFakeTimers({ toFake: ["Date"], shouldAdvanceTime: true });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      let cap: ReturnType<typeof setTimeout> | undefined;
      const gaveUp = new Promise((resolve) => {
        cap = setTimeout(() => resolve("still waiting"), 2_000);
      });

      const outcome = await Promise.race([
        fetchJson({ source: "deezer", url: "https://api.deezer.test/x/held" }),
        gaveUp,
      ]).finally(() => clearTimeout(cap));

      // The answer is served; only its recording is lost, after the full wait.
      expect(outcome).toEqual({ ok: true });
      expect(performance.now() - answeredAt).toBeGreaterThanOrEqual(500);
      expect(existsSync(join(dir, "deezer.json"))).toBe(false);
    },
  );

  it("two recorders in one process lose no entries", async () => {
    process.env.SOURCE_CASSETTE = "record";
    stubFetch(() => json({ ok: true }));

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        fetchJson({ source: "deezer", url: `https://api.deezer.test/x/${i}` }),
      ),
    );

    const entries = JSON.parse(readFileSync(join(dir, "deezer.json"), "utf8")).entries;
    expect(Object.keys(entries)).toHaveLength(20);
  });

  it("two recorder processes lose no entries and leave a valid cassette", {
    timeout: 30_000,
  }, async () => {
    const worker = join(dirname(fileURLToPath(import.meta.url)), "testing", "recordWorker.ts");
    const run = (prefix: string) =>
      promisify(execFile)(process.execPath, ["--import", "tsx", worker, dir, prefix, "15"], {
        env: { ...process.env, SOURCE_CASSETTE: undefined, NODE_ENV: "test" },
      });

    await Promise.all([run("a"), run("b")]);

    const entries = JSON.parse(readFileSync(join(dir, "deezer.json"), "utf8")).entries;
    expect(Object.keys(entries)).toHaveLength(30);
  });

  it("a write that fails half-way leaves the previous cassette intact", async () => {
    process.env.SOURCE_CASSETTE = "record";
    stubFetch(() => json({ ok: true }));
    await fetchJson({ source: "deezer", url: "https://api.deezer.test/first" });

    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(fsPromises.writeFile).mockImplementationOnce(async (path, data) => {
      await actual.writeFile(path, String(data).slice(0, 25));
      throw new Error("ENOSPC: no space left on device");
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await fetchJson({ source: "deezer", url: "https://api.deezer.test/second" });
    } finally {
      vi.restoreAllMocks();
    }

    const entries = JSON.parse(readFileSync(join(dir, "deezer.json"), "utf8")).entries;
    expect(Object.keys(entries)).toEqual(["GET https://api.deezer.test/first"]);
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("breaks a lock left by a recorder that is no longer running", async () => {
    // The pid of a process that has exited.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(join(dir, "deezer.json.lock"), String(dead));
    process.env.SOURCE_CASSETTE = "record";
    stubFetch(() => json({ ok: true }));
    const logs = captureLogsForTests();

    const started = Date.now();
    try {
      await fetchJson({ source: "deezer", url: "https://api.deezer.test/after-crash" });
    } finally {
      logs.restore();
      vi.restoreAllMocks();
    }

    expect(logs.messages("error")).toEqual([]);
    expect(Date.now() - started).toBeLessThan(2000);
    const entries = JSON.parse(readFileSync(join(dir, "deezer.json"), "utf8")).entries;
    expect(Object.keys(entries)).toEqual(["GET https://api.deezer.test/after-crash"]);
    expect(existsSync(join(dir, "deezer.json.lock"))).toBe(false);
  });

  it("a record run that loses answers says how many when it ends", {
    timeout: 30_000,
  }, async () => {
    const worker = join(dirname(fileURLToPath(import.meta.url)), "testing", "recordWorker.ts");
    // A file where the cassette directory should be: every write fails.
    const blocked = join(dir, "not-a-dir");
    writeFileSync(blocked, "");

    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", worker, blocked, "lost", "3"],
      {
        env: {
          ...process.env,
          SOURCE_CASSETTE: undefined,
          NODE_ENV: "test",
          LOG_LEVEL: "info",
          LOG_FILE: undefined,
        },
      },
    );

    expect(stdout).toMatch(/3 answer\(s\) could not be recorded/);
    expect(stdout.match(/could not be recorded/g)).toHaveLength(1);
  });

  it("an unreadable cassette is a typed cassette_io error", async () => {
    process.env.SOURCE_CASSETTE = "replay";
    writeFileSync(join(dir, "spotify.json"), '{"version":1,"entries":{"GET ');
    const net = stubFetch(() => json(live));

    expect((await rejection(fetchJson(request))).kind).toBe("cassette_io");
    expect(net.calls).toHaveLength(0);
  });

  it("a cassette that cannot be written still returns the live answer", async () => {
    process.env.SOURCE_CASSETTE = "record";
    // A file where the directory should be: every write fails.
    const blocked = join(dir, "not-a-dir");
    writeFileSync(blocked, "");
    process.env.SOURCE_CASSETTE_DIR = blocked;
    const logs = captureLogsForTests();
    stubFetch(() => json(live));

    try {
      await expect(fetchJson(request)).resolves.toEqual(live);
      expect(logs.messages("error").some((line) => line.includes("cannot write cassette"))).toBe(
        true,
      );
    } finally {
      logs.restore();
      vi.restoreAllMocks();
    }
  });

  it("logs the active mode when it changes", async () => {
    const logs = captureLogsForTests();
    stubFetch(() => json(live));
    try {
      process.env.SOURCE_CASSETTE = "replay";
      await rejection(fetchJson(request));
      process.env.SOURCE_CASSETTE = "record";
      await fetchJson(request);
      expect(logs.messages("warn").some((line) => line.includes("SOURCE_CASSETTE=record"))).toBe(
        true,
      );
    } finally {
      logs.restore();
      vi.restoreAllMocks();
    }
  });

  it("supplies a placeholder credential under replay only", () => {
    delete process.env.TEST_MISSING_KEY;
    process.env.SOURCE_CASSETTE = "record";
    expect(credential("TEST_MISSING_KEY")).toBeUndefined();
    delete process.env.SOURCE_CASSETTE;
    expect(credential("TEST_MISSING_KEY")).toBeUndefined();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.SOURCE_CASSETTE = "replay";
    expect(credential("TEST_MISSING_KEY")).toBe("replay");
    vi.restoreAllMocks();
  });

  it("refuses an unknown SOURCE_CASSETTE value, at startup and per request", async () => {
    process.env.SOURCE_CASSETTE = "recrod";
    const net = stubFetch(() => json(live));
    try {
      await expect(fetchJson(request)).rejects.toThrow(
        /SOURCE_CASSETTE: expected "record", "replay" or "off", got "recrod"/,
      );
      vi.resetModules();
      await expect(import("./http.js")).rejects.toThrow(/SOURCE_CASSETTE/);
      expect(net.calls).toHaveLength(0);
    } finally {
      delete process.env.SOURCE_CASSETTE;
      vi.resetModules();
    }
  });

  it("refuses a cassette mode in production, at startup and per request", async () => {
    const saved = process.env.NODE_ENV;
    process.env.SOURCE_CASSETTE = "replay";
    process.env.NODE_ENV = "production";
    const net = stubFetch(() => json(live));
    try {
      await expect(fetchJson(request)).rejects.toThrow(/not allowed when NODE_ENV=production/);
      vi.resetModules();
      await expect(import("./http.js")).rejects.toThrow(/SOURCE_CASSETTE=replay is not allowed/);
      expect(net.calls).toHaveLength(0);
    } finally {
      process.env.NODE_ENV = saved;
      vi.resetModules();
    }
  });

  it("requests that opt out (local services) are never recorded or replayed", async () => {
    process.env.SOURCE_CASSETTE = "replay";
    const net = stubFetch(() => json({ status: "ok" }));

    await expect(
      fetchJson({ source: "audio", url: "http://localhost:3002/health", cassette: false }),
    ).resolves.toEqual({ status: "ok" });
    expect(net.calls).toHaveLength(1);
  });
});

describe("what an error message keeps", () => {
  it.each([
    ["<html>Bad gateway</html>", "markup"],
    ["Blocked &amp;lt;script&amp;gt;", "markup"],
    ["TypeError: x at handler (/srv/app/index.js:10:5)", "a stack trace"],
    ['Traceback (most recent call last): File "/app/main.py", line 3', "a stack trace"],
    ["Rejected key token=abc123", "a signature or token parameter"],
    ["HTTP 404 — see https://api.example.com/v1/x", "a link"],
    ["connect ECONNREFUSED //api.example.com/v1", "a link"],
    ["musicbrainz: HTTP 503 (the source could not answer)", null],
    ["Quota resets at 10:30:00 UTC", null],
    ["HTTP 400 — see [link]", null],
  ])("names what %s holds", (text, issue) => {
    expect(reasonIssue(text)).toBe(issue);
  });

  it("writes a message as a plain line that never has an issue, or leaves it out", () => {
    expect(plainMessage("connect ECONNREFUSED https://api.example.com/v1/x\n  retrying")).toBe(
      "connect ECONNREFUSED [link] retrying",
    );
    expect(plainMessage("see https://example.org/x?token=abc123 now")).toBe("see [link] now");
    expect(plainMessage("<b>Bad</b> request")).toBeUndefined();
    expect(plainMessage("boom at handler (/srv/app/index.js:10:5)")).toBeUndefined();
    expect(plainMessage("   ")).toBeUndefined();
    const long = `musicbrainz: ${"x".repeat(300)}`;
    // Not cut: only a source's own reason is (plainReason).
    expect(plainMessage(long)).toBe(long);
    for (const text of [
      "a //b //c",
      "http://a.example/x https://b.example/y",
      "x http:////y",
      "see (https://a.example/x) and <https://b.example>",
    ]) {
      const line = plainMessage(text);
      if (line !== undefined) expect(reasonIssue(line), text).toBeNull();
    }
  });
});

describe("text patterns in linear time", { timeout: 30_000 }, () => {
  // The expressions before #194, each quadratic on a long run of the characters it reads.
  const STACK_TRACE =
    /\bat\s+(?:\S+\s+\()?\S*[/\\.]\S*:\d+:\d+\)?|Traceback \(most recent call last\)|File "[^"]+", line \d+/;
  const TOKEN =
    /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{64,}\b/g;
  const PHONE_LIKE = /(?<![\w-])\+?\(?\d[\d\s().-]{7,}\d(?![\w-])/g;
  const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
  const mark = (match: string) => `<${match}>`;

  it("finds exactly the stack traces the earlier expression found", () => {
    const realistic = [
      "TypeError: x at handler (/srv/app/index.js:10:5)",
      "at Object.<anonymous> (C:\\app\\x.js:1:2)",
      "    at async Promise.all (index 0)",
      "at node:internal/modules/cjs/loader:1537:15",
      "boom at a.b:1:2",
      "Quota resets at 10:30:00 UTC",
      "failed at step 3: see logs",
      "at foo (bar baz.js:1:2)",
      "cat /etc/x:1:2",
      "(at /x.js:1:2)",
      'Traceback (most recent call last): File "main.py", line 4',
      'File "", line 4',
    ];
    const symbols = ["at", " ", "(", "/", ".", ":1", "x", "\n"];
    const parts = [
      "at",
      "at ",
      " at ",
      "(at ",
      "xat ",
      "_at ",
      "Error ",
      "(",
      ")",
      "/",
      "\\",
      ".",
      "a.js",
      ":",
      "10",
      ":5",
      ":10:5",
      " ",
      "\t",
      "\n",
      'File "',
      '"',
      ", line ",
      "4",
      "\u00a0",
    ];
    const frames = [
      "at ",
      "xat ",
      "(at ",
      "fn ",
      "(",
      ")",
      "/a.js:10:5",
      "a.b:1:2",
      "x:1:2",
      "a/b",
      ":10:5",
      ":1",
      " ",
      "\n",
    ];
    const cases = [
      ...realistic,
      ...allStrings(symbols, 5),
      ...randomStrings(parts, 20_000, 14),
      ...randomStrings(frames, 20_000, 10),
    ];

    expect(disagreements(cases, hasStackTrace, (text) => STACK_TRACE.test(text))).toEqual([]);
    expect(cases.filter((text) => STACK_TRACE.test(text)).length).toBeGreaterThan(1000);
  });

  it("redacts exactly the token-like runs the earlier expression redacted", () => {
    const parts = [
      "a",
      "A",
      "0",
      "_",
      "-",
      "--",
      " ",
      ".",
      "aB3dE6gH9jK2mN5pQ8sT1v",
      "abcdefghij",
      "ABCDEFGHIJ",
      "0123456789",
      "é",
      "=",
    ];
    const cases = [
      `key ${"aB3".repeat(25)} end`,
      `-${"aB3".repeat(25)}-`,
      ...randomStrings(parts, 20_000, 24),
    ];

    expect(
      disagreements(cases, redactTokenRuns, (text) => text.replace(TOKEN, "[redacted]")),
    ).toEqual([]);
    expect(cases.filter((text) => TOKEN.test(text)).length).toBeGreaterThan(500);
  });

  it("finds exactly the phone-like numbers and e-mails the earlier expressions found", () => {
    const phones = [
      "call +1 (555) 123-4567.",
      "Released 1990-10-02 (10016 plays)",
      "Artist e21857d5-3256-4547-afb3-4b6ded592596.",
      "tel 555.123.4567x",
      "+44 20 7946 0958",
      ...allStrings(["1", " ", "-", "(", ")", "+", "a"], 5),
      ...randomStrings(
        [
          "1",
          "23",
          "4567",
          " ",
          "-",
          "(",
          ")",
          "+",
          ".",
          "a",
          "_",
          "\n",
          "+1 (555) 123-4567",
          "2024-01-02",
        ],
        20_000,
        18,
      ),
    ];
    expect(
      disagreements(
        phones,
        (text) => replacePhoneLike(text, mark),
        (text) => text.replace(PHONE_LIKE, mark),
      ),
    ).toEqual([]);
    expect(phones.filter((text) => text.replace(PHONE_LIKE, mark) !== text).length).toBeGreaterThan(
      1000,
    );

    const emails = [
      "write to fan.mail@example.org now",
      "a@b.c+x@d.e",
      "x@y",
      ...allStrings(["a", "@", ".", "+", "-", " "], 6),
      ...randomStrings(
        ["a", "b.c", "@", ".", "+", "-", "_", " ", "x@y.z", "user.name+tag", "é", "\n"],
        20_000,
        14,
      ),
    ];
    expect(disagreements(emails, withoutEmails, (text) => text.replace(EMAIL, "[email]"))).toEqual(
      [],
    );
    expect(emails.filter((text) => text.replace(EMAIL, "") !== text).length).toBeGreaterThan(1000);
  });

  it.each<[string, () => unknown, unknown]>([
    // About 2 s each with the earlier expressions.
    ["a stack-trace look-alike", () => reasonIssue(`at x${".x".repeat(40_000)} `), null],
    ["a long token-like run", () => scrubText(`a${"-a0".repeat(20_000)}-`).length, 500],
    ["a long run of number characters", () => scrubText(`${"(0- ".repeat(15_000)}x`).length, 500],
    ["a long run before an @", () => scrubText(`${"a".repeat(60_000)}@`).length, 500],
    // 10 kB, and 60 kB: about 3 s each for a key search that reads on to the end of the text
    // from each start.
    ...[10_000, 60_000].flatMap((size): Array<[string, () => unknown, unknown]> => {
      const fill = (unit: string) => unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
      return [
        [
          `${size} characters of escaped quotes around a key`,
          () => redactQuotedSecrets(fill('\\"token\\')).length,
          size,
        ],
        [
          `${size} characters of quoted keys without a colon`,
          () => redactQuotedSecrets(fill('\\"token\\" ')).length,
          size,
        ],
        [`${size} characters of near keys`, () => scrubText(fill('\\"authorizatio')).length, 500],
        [
          `${size} characters of key-like runs longer than a key`,
          () => redactQuotedSecrets(fill(`"${"a_".repeat(40)}`)).length,
          size,
        ],
        [
          `${size} characters of keys that are not secret`,
          () => redactQuotedSecrets(fill('"a": "b", ')).length,
          size,
        ],
        [
          `${size} characters of backslashes in an unterminated value`,
          () => scrubText(`"token":"${fill("\\")}`),
          '"token":"[redacted]',
        ],
        [
          `${size} characters of escaped URL starts`,
          () => scrubText(fill("https:\\/\\/")).length,
          500,
        ],
      ];
    }),
  ])("answers quickly on %s", (_name, call, expected) => {
    const { ms, result } = timed(call);
    expect(ms).toBeLessThan(400);
    expect(result).toBe(expected);
  });
});

describe("text redaction against the rules before #202", { timeout: 30_000 }, () => {
  // scrubText as it was before quoted secret keys and JSON-escaped links were read, from the
  // parts that did not change. No credential is configured here, so knownSecrets is left out.
  const OLD_ID_SHAPED =
    /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-Za-z]{22}|[A-Z]{2}[A-Z0-9]{3}\d{7})$/i;
  const OLD_SECRET_PATTERNS: Array<[RegExp, string]> = [
    [/\b(Bearer|Basic) [A-Za-z0-9._~+/=-]{12,}/g, "$1 [redacted]"],
    [
      /\b(api_?key|key|token|access_token|refresh_token|client_secret|password|secret)=([^&\s"'<>]+)/gi,
      "$1=[redacted]",
    ],
    [/\btvly-[A-Za-z0-9_-]+/g, "tvly-[redacted]"],
    [/\bBQ[A-Za-z0-9_-]{40,}/g, "[redacted]"],
  ];
  const OLD_URL_IN_TEXT = /(?:https?:)?\/\/[^\s"'<>()[\]{}]+/gi;
  const scrubTextBefore = (text: string): string => {
    if (OLD_ID_SHAPED.test(text)) return text;
    let out = /header/i.test(text) ? text.replace(/"[^"]*"/g, '"[redacted]"') : text;
    for (const [pattern, replacement] of OLD_SECRET_PATTERNS) {
      out = out.replace(pattern, replacement);
    }
    out = redactTokenRuns(out).replace(OLD_URL_IN_TEXT, (url) =>
      isMediaUrl(url) ? "[media]" : url,
    );
    out = replacePhoneLike(withoutEmails(out), (match) => {
      const digits = match.replace(/\D/g, "").length;
      const isDate = /^\d{4}-\d{2}-\d{2}/.test(match);
      return digits >= 9 && digits <= 15 && !isDate ? "[phone]" : match;
    });
    return out.length > 500 ? out.slice(0, 500) : out;
  };

  /** True when `now` is `old` with parts of it (none or more) replaced by a mask. */
  const onlyNewRedactions = (now: string, old: string): boolean => {
    const kept = now.split(/\[(?:redacted|media|email|phone)\]/);
    const first = kept[0] ?? "";
    const last = kept.at(-1) ?? "";
    if (kept.length === 1) return now === old;
    if (!old.startsWith(first)) return false;
    let at = first.length;
    for (const part of kept.slice(1, -1)) {
      const found = old.indexOf(part, at);
      if (found === -1) return false;
      at = found + part.length;
    }
    return old.length - last.length >= at && old.endsWith(last);
  };

  const realistic = [
    "Authorization: Bearer abc.def-123456789 then ?api_key=K1&key=K2&token=K3 and tvly-dev-XYZ123",
    "Released 1990-10-02 (10016 plays), https://www.whosampled.com/Vanilla-Ice/ — " +
      "write to fan.mail@example.org or call +1 (555) 123-4567.",
    '<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title></head></html>',
    '{"error":{"status":401,"message":"Invalid access token"}}',
    'Headers.append: "plain value 42\n" is an invalid header value.',
    "see https://cdnt-preview.dzcdn.net/api/1/1/a/b/c.mp3?hdnea=exp=1 for the cover",
    "e21857d5-3256-4547-afb3-4b6ded592596",
  ];
  const parts = [
    '"token"',
    "'password'",
    '\\"api_key\\"',
    '"Client_Secret"',
    '"x-api-key"',
    '"authorization"',
    '"my_token"',
    '"tokens"',
    '"accessToken"',
    '"api-key"',
    '"id_token"',
    "<header>",
    ":",
    " : ",
    '"',
    "'",
    "\\",
    '\\"',
    "\\\\",
    "{",
    "}",
    "[",
    ",",
    "a",
    "pw-1",
    "12345",
    "null",
    " ",
    "\n",
    "[redacted]",
    "https:\\/\\/",
    "\\/\\/",
    "https://",
    "//",
    "cdns-preview-1.dzcdn.net",
    "i.scdn.co",
    "www.example.org",
    "\\/stream",
    "\\/a.mp3",
    "/a.png",
    "?hdnea=exp=1",
    "token=",
    "Bearer abcdefghijkl1",
    "header",
    "x@y.co",
    "+1 (555) 123-4567",
    "2024-01-02",
    "aB3dE6gH9jK2mN5pQ8sT1v",
    "é",
  ];
  const corpus = [
    ...realistic,
    ...allStrings(['"token"', ":", '"', "\\", "a", "\\/\\/", "i.scdn.co"], 5),
    ...randomStrings(parts, 40_000, 12),
    // The corpora of the linear-time rewrites (#198), which hold no quoted key or escaped link.
    ...randomStrings(["1", "23", "4567", " ", "-", "(", ")", "+", ".", "a", "_", "\n"], 5_000, 18),
    ...randomStrings(["a", "b.c", "@", ".", "+", "-", "_", " ", "x@y.z", "é", "\n"], 5_000, 14),
    ...randomStrings(["a", "A", "0", "_", "-", " ", "aB3dE6gH9jK2mN5pQ8sT1v", "="], 5_000, 24),
  ];
  const quotedKeyOrEscapedSlash = /\\\/|(?:key|token|secret|password|authorization)\\?["']/i;

  it("reads text without a quoted secret key or an escaped slash exactly as before", () => {
    const plain = corpus.filter((text) => !quotedKeyOrEscapedSlash.test(text));
    expect(plain.length).toBeGreaterThan(20_000);
    expect(disagreements(plain, scrubText, scrubTextBefore)).toEqual([]);
  });

  /** The text with each media link written with JSON-escaped slashes written plainly. */
  const plainLinks = (text: string) =>
    text.replace(/(?:https?:)?\\\/\\\/[^\s"'<>()[\]{}]+/gi, (url) => {
      const plain = url.replaceAll("\\/", "/");
      return isMediaUrl(plain) ? plain : url;
    });

  it("differs from before only where it redacts a secret or a link more", () => {
    const changed = corpus.filter((text) => scrubText(text) !== scrubTextBefore(text));
    // Either a pure redaction, or an escaped media link read exactly as before its plain form was
    // (the e-mail and phone rules then read the text around it as around a plain link).
    const other = changed
      .filter((text) => !onlyNewRedactions(scrubText(text), scrubTextBefore(text)))
      .filter((text) => scrubText(text) !== scrubTextBefore(plainLinks(text)))
      .slice(0, 5)
      .map((input) => ({ input, now: scrubText(input), old: scrubTextBefore(input) }));
    expect(other).toEqual([]);
    expect(changed.length).toBeGreaterThan(1_000);
    expect(changed.every((text) => quotedKeyOrEscapedSlash.test(text))).toBe(true);
  });
});
