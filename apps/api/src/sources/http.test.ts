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
import { logText } from "../http/middleware/errors.js";
import { captureLogsForTests, configureLogger, scrub } from "../logger.js";
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
import {
  allStrings,
  disagreements,
  growth,
  randomStrings,
  threadCpuMs,
  timed,
} from "./testing/strings.js";

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

  it("times out on the process's timers, which a test's fake clock drives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    stubFetch((call) => never(call));
    const t0 = performance.now();
    let failedAt = -1;
    const pending = rejection(fetchJson({ source: "musicbrainz", url: URL_A })).finally(() => {
      failedAt = performance.now() - t0;
    });
    await vi.runAllTimersAsync();
    const error = await pending;

    expect(error.kind).toBe("timeout");
    expect(error.message).toContain("no answer within 10000 ms");
    expect(failedAt).toBe(10_000);
  });

  it("leaves no timer behind once the answer is in", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    stubFetch(() => json({ ok: 1 }));
    await expect(fetchJson({ source: "deezer", url: URL_A })).resolves.toEqual({ ok: 1 });
    expect(vi.getTimerCount()).toBe(0);
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
      // …and a key inside it is not read again, even where its own value would run on.
      [`{"token":"x 'secret':'y" z' w"}`, `{"token":"[redacted]" z' w"}`],
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

  it("hides with the header rule all it hid before, though a secret value held a quote", () => {
    // A quote inside a redacted value must not move the header rule's later pairs, so a value it
    // hid before ("LEAK31", "LEAK34", "sess-LEAK-1") stays hidden.
    for (const [text, hidden] of [
      ['<header></header>{"token":"a\\"b","msg":"c\\"d","session":"LEAK31"}', "LEAK31"],
      ['<header></header>{"msg":"x\\"y","token":"z\\"w","session":"LEAK34"}', "LEAK34"],
      [
        '<html><header>Sign in</header><script>var s={"note":"say \\"hi\\" back",' +
          '"password":"pa\\"ss","session":"sess-LEAK-1"}</script></html>',
        "sess-LEAK-1",
      ],
    ]) {
      expect(redactText(text), text).not.toContain(hidden);
      expect(scrubText(text), text).not.toContain(hidden);
      expect(redactText(text), text).not.toMatch(/ss"|\\"b|w"/);
    }
    // Text without a quoted secret value reads as the header rule always read it.
    const plain = '<header></header>{"msg":"x\\"y","note":"z","session":"s-1"}';
    expect(redactText(plain)).toBe(plain.replace(/"[^"]*"/g, '"[redacted]"'));
  });

  it("redacts the quoted value of a secret name= pair, escapes included", () => {
    const cases: Array<[string, string]> = [
      ['<input password="hunter 2">', '<input password="[redacted]">'],
      ["token='a b' rest", "token='[redacted]' rest"],
      // The escaped opening quote goes with the value; in scrubText the `key=` rule then takes
      // the closing backslash with "[redacted]", as it took the opening one before.
      ['{"q":"api_key=\\"esc 1\\" more"}', '{"q":"api_key=[redacted]\\" more"}'],
      ['secret="a\\"b c" next="kept"', 'secret="[redacted]" next="kept"'],
      ['client_secret="cut off', 'client_secret="[redacted]'],
      // A name= pair inside a value is not read again.
      [`password="x token='y" z' w`, `password="[redacted]" z' w`],
      // Not a secret name, or nothing to hide: left as it is.
      ['passwords="kept-1" mykey="kept-2" password=""', ""],
    ];
    for (const [text, expected] of cases) {
      expect(redactQuotedSecrets(text), text).toBe(expected || text);
      expect(scrubText(text), text).toBe(
        (expected || text).replace('[redacted]\\"', '[redacted]"'),
      );
    }
    // Data the pipeline reads loses it too, as it loses an unquoted `password=…`.
    expect(scrubReadPayload({ note: 'login password="hunter 2" failed' })).toEqual({
      note: 'login password="[redacted]" failed',
    });
  });

  it.each<[string, string, string]>([
    // An object key without quotes, as JavaScript and util.inspect write one.
    ["an object key", '{ token: "sv-1 a" }', "sv-1 a"],
    ["an object key", "{token:'sv-2'}", "sv-2"],
    ["an object key", "{ apiKey: sv-3 }", "sv-3"],
    ["an object key", "{ a: 1, client_secret: sv-4, b: 2 }", "sv-4"],
    ["an object key", "Error: boom {\n  code: 'E1',\n  accessToken: 'sv-5'\n}", "sv-5"],
    // Inside a JSON string, its escapes included.
    ["an object key", '{"error":"{ password: \\"sv-6 \\\\\\" b\\" }"}', 'sv-6 \\\\\\" b'],
    ["an object key", "{ refresh_token: `sv-7` }", "sv-7"],
    ["an object key", "{ token : sv-16 }", "sv-16"],
    // A quoted value is a value whatever it says, a status word too.
    ["an object key", "{ token: 'invalid' }", "invalid"],
    // An XML or HTML element named after a secret key, in any case, with attributes.
    ["an element", "<access_token>sv-8</access_token>", "sv-8"],
    ["an element", '<r><Access_Token type="x">sv 9</ACCESS_TOKEN ></r>', "sv 9"],
    ["an element", '<wsse:Password Type="t">sv-10</wsse:Password>', "sv-10"],
    ["an element", "<secret><![CDATA[sv-11]]></secret><b>kept</b>", "<![CDATA[sv-11]]>"],
    // A header line for an API key, the name read without an "X-" prefix.
    ["a header line", "X-Api-Key: sv-12", "sv-12"],
    ["a header line", "Accept: */*\r\nApi-Key: sv-13\r\nHost: a", "sv-13"],
    ["a header line", "> GET / HTTP/1.1\n> X-Auth-Token: sv-14\n> Host: a", "sv-14"],
    ["a header line", '  password: "sv 15"', "sv 15"],
    // curl -v writes "> " before a request header and "< " before a response header.
    ["a header line", "< HTTP/1.1 401\n< X-Api-Key: sv-17\n< Server: a", "sv-17"],
    // The value runs to the end of its line: a comma does not end it, trailing spaces are kept.
    ["a header line", "X-Api-Key: sv-18,v2", "sv-18,v2"],
    ["a header line", "X-Api-Key: sv-19 \nHost: a", "sv-19"],
    // A text that mentions a header (where the header rule runs) reads every shape too.
    ["a header line", "Invalid header\nX-Api-Key: sv-20", "sv-20"],
    // A line that ends in a bare CR, and a space before the colon.
    ["a header line", "Accept: */*\rX-Api-Key: sv-23", "sv-23"],
    ["a header line", "X-Api-Key : sv-24", "sv-24"],
    ["a header line", "API_KEY: sv-25", "sv-25"],
    ["a header line", "X-Api-Key: sv-31\u00a0\nHost: a", "sv-31"],
    // A line also ends at U+2028, U+2029, NEL, VT and FF.
    ["a header line", "Accept: */*\u2028X-Api-Key: sv-26\u2028Host: a", "sv-26"],
    ["a header line", "Accept: */*\u2029X-Api-Key: sv-27", "sv-27"],
    ["a header line", "Accept: */*\u0085X-Api-Key: sv-28\u0085Host: a", "sv-28"],
    ["a header line", "Accept: */*\vX-Api-Key: sv-29\vHost: a", "sv-29"],
    ["a header line", "Accept: */*\fX-Api-Key: sv-30\fHost: a", "sv-30"],
    ["an object key", "header rejected: { token: sv-21 }", "sv-21"],
    ["an element", "bad header <token>sv-22</token>", "sv-22"],
  ])("redacts the value of a secret key written as %s: %j", (_shape, text, value) => {
    for (const out of [redactText(text), scrubText(text)]) {
      expect(out, text).not.toContain(value);
      expect(out, text).toBe(text.replace(value, "[redacted]"));
    }
  });

  it("never hides less than the other rules next to a value without a quoted key", () => {
    // What a `name=` value, a Bearer token or the header rule hides around the value stays hidden.
    for (const [text, hidden] of [
      ["{ token: key=a,LEAK-1 }", "LEAK-1"],
      ["{ token: token=a,Bearer LEAK-2abcdefgh }", "LEAK-2"],
      ["{ token: key=abc//i.scdn.co/a.png(LEAK-8),z }", "LEAK-8"],
      // The header rule pairs quotes as it always did, as it does once the quoted secret values
      // are gone, and as it does once every secret value is gone: a quote inside an element's
      // content neither shows a later pair (LEAK-5) nor moves one the quoted values kept (LEAK-6).
      ['header<token>x"</token> "LEAK-5" ', "LEAK-5"],
      [`header<token>''x y"</token>key="{ a: \\"\\\\ }"LEAK-6"`, "LEAK-6"],
    ]) {
      expect(redactText(text), text).not.toContain(hidden);
      expect(scrubText(text), text).not.toContain(hidden);
    }
    // A media link around or inside the value is hidden whole, as before: its host, its path and
    // what follows the value (a signature) included.
    for (const [text, hidden] of [
      ["{ token: https://i.scdn.co/a,LEAK-3 }", "LEAK-3"],
      ["{ token: https:\\/\\/i.scdn.co\\/a,LEAK-4 }", "LEAK-4"],
      ["{ token: \\/\\/https://i.scdn.co/a,LEAK-7 }", "LEAK-7"],
      ["{ token: https://i.scdn.co/a,LEAK-9 } { token: key=b }", "LEAK-9"],
      ["https://cdns-preview-1.dzcdn.net/stream/c-abc,token:SEC2,hdnea=exp=1~hmac=SIG2", "SIG2"],
      ["https://x.y/p,token:SEC1,rest/img.png", "rest"],
      ["http:\\/\\/QzaaQ,token:/images/", "QzaaQ"],
    ]) {
      expect(scrubText(text), text).not.toContain(hidden);
    }
    expect(scrubText("https://cdns-preview-1.dzcdn.net/s/c,token:SEC2,hdnea=exp=1~hmac=SIG2")).toBe(
      "[redacted]",
    );
    // One mask in place of the link and the value, whatever follows them.
    expect(scrubText("see https://i.scdn.co/a,token:SEC3,b tail")).toBe("see [redacted] tail");
    // The values without quotes and the header rule's pairs are masked together, in order.
    expect(redactText('header: { token: LEAK-10 } "q"')).toBe(
      'header: { token: [redacted] } "[redacted]"',
    );
    // An escaped backquote is not a quote: the run is the value, backslashes and all.
    expect(redactText("{ token: \\`x\\` }")).toBe("{ token: [redacted] }");
    // A quoted value is redacted whatever it says; an empty pair the header rule masked is masked
    // once.
    expect(redactText('Password: "none"')).toBe('Password: "[redacted]"');
    expect(redactText('header "" { token: abc }')).toBe(
      'header "[redacted]" { token: [redacted] }',
    );
    // The rules before run in the order they always did: what they hide reads as it did.
    expect(redactText('\\"token\\":\\""token":key=x@y.co\\"a')).toBe(
      '\\"token\\":\\"[redacted]\\"a',
    );
    // A quoted header value is read once: a line inside it is not read again.
    expect(redactText('password: "a\nToken: b"\nnext')).toBe('password: "[redacted]"\nnext');
  });

  it("tells each shape from its near-misses and from prose", () => {
    // Each near-miss is kept as it is; the shape next to it is redacted.
    const pairs: Array<[near: string, shape: string]> = [
      ["tokens: 5", "token: 5"],
      ["<token-count>3</token-count>", "<token>3</token>"],
      ["Api-Keys-Allowed: yes", "Api-Key: yes"],
      ["X-Api-Key-Count: 2", "X-Api-Key: 2"],
      ["the token: a short sentence", "token: a"],
      ["Hello, token: a short sentence", "Hello, token: a"],
      ["Invalid token: abc123", "{ token: abc123 }"],
      ["Password: must be at least 8 characters", "Password: hunter22"],
      ["usage: login --token <token>\nthen go on", "<token>v</token>"],
      ["<token />v</token>", "<token >v</token>"],
      ["<token a<b>v</token>", "<token a=b>v</token>"],
      // A quote, "<", ">" or "&" in a run is not a value without quotes: they end a `name=` value.
      ["{ token: x<y> }", "{ token: xy }"],
      ["{ token: a&b, c: 1 }", "{ token: ab, c: 1 }"],
      ["{ token: { type: 'kept' } }", "{ token: 'v' }"],
      ["{ my_token: 'kept', tokenType: kept }", "{ authToken: 'v' }"],
      ["(token: kept)", "{token: kept}"],
      // A status word in place of a value is a reason a person reads, in any case.
      ["token: invalid", "token: invalid1"],
      ["Token: expired.", "Token: expiry"],
      ["Unauthorized\nToken: EXPIRED", "Unauthorized\nToken: e1"],
      ["Bad Request\nPassword: required", "Bad Request\nPassword: r1"],
      ["audio: HTTP 422: Validation failed, token: invalid", "audio: HTTP 422: x, token: in"],
      ["lastfm: rejected, api_key: missing", "lastfm: rejected, api_key: m1"],
      ["{ token: null, password: undefined, secret: none }", "{ token: n1 }"],
      ["{ token: true, apiKey: False, secret: unknown, id_token: revoked }", "{ token: t1 }"],
      ["{ token: empty }", "{ token: e1 }"],
      ["<error><token>expired</token></error>", "<error><token>expires</token></error>"],
      ["<token> expired </token>", "<token> expires </token>"],
      // Only "," or "}" ends a value without quotes.
      ["[a, token: x ]", "[a, token: x }"],
      // An empty value has nothing to hide.
      ["<token></token>", "<token>v</token>"],
      ["{ token: '' }", "{ token: 'v' }"],
      ['token: ""', 'token: "v"'],
    ];
    for (const [near, shape] of pairs) {
      expect(scrubText(near), near).toBe(near);
      expect(redactText(near), near).toBe(near);
      expect(scrubText(shape), shape).toContain("[redacted]");
    }
    // A key inside a secret value is not read again, even where its own value would run on.
    expect(redactText(`{ token: "x, secret: 'y" z' w }`)).toBe(`{ token: "[redacted]" z' w }`);
    expect(redactText("<token>a <password>b</token> c</password>")).toBe(
      "<token>[redacted]</token> c</password>",
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

describe("secret values in cookies, config text, PHP dumps, forms and escaped text", () => {
  /** Each way a text reaches a log, a cassette or an error message. */
  const outputs = (text: string) => [
    scrubText(text),
    redactText(text),
    describeError(new Error(text)),
    new SourceError("spotify", "http", text).message,
  ];
  /** A source's reason as it reaches an error message, and that message as it is stored. */
  const reasonOutputs = (text: string) => {
    const detail = plainReason(text);
    const message = new SourceError("spotify", "http", `HTTP 401 — ${detail ?? "refused"}`).message;
    return [detail ?? "", message, plainMessage(message) ?? ""];
  };

  // Each shape with made-up values planted in it; `reason`: it can also arrive as a source's own
  // reason, without markup.
  it.each<[shape: string, text: string, planted: string[], reason: boolean]>([
    [
      "curl Cookie lines",
      "> GET /v1 HTTP/1.1\n> Cookie: theme=QzcAQ; session=QzcBQ\n> Accept: */*",
      ["QzcAQ", "QzcBQ"],
      false,
    ],
    [
      "Set-Cookie lines, several cookies joined",
      "< HTTP/1.1 401\n< set-cookie: sid=QzcCQ; Path=/; HttpOnly\n" +
        "< Set-Cookie: a=QzcDQ, b=QzcEQ; Expires=Wed, 21 Oct 2015 07:28:00 GMT, c=QzcFQ; Path=/",
      ["QzcCQ", "QzcDQ", "QzcEQ", "QzcFQ"],
      false,
    ],
    [
      "a Cookie line in a reason",
      'Forbidden\nCookie: session="QzcGQ"; lang=QzcHQ',
      ["QzcGQ", "QzcHQ"],
      true,
    ],
    [
      "cookie headers as object keys",
      `{ headers: { Cookie: 'sid=QzcJQ; csrftoken=QzcKQ' } } {"set-cookie":"sid=QzcLQ; Path=/"}`,
      ["QzcJQ", "QzcKQ", "QzcLQ"],
      true,
    ],
    [
      "Authorization lines with a Token or Bot scheme",
      "Unauthorized\nAuthorization: Token QzaAQ\nProxy-Authorization: Bot QzaBQ",
      ["QzaAQ", "QzaBQ"],
      true,
    ],
    [
      "YAML mappings and list items",
      'credentials:\n  - api_key: QzyAQ\n  - name: x\n    github_token: QzyBQ\n  password: "QzyCQ"',
      ["QzyAQ", "QzyBQ", "QzyCQ"],
      true,
    ],
    [
      "TOML assignments",
      "[auth]\napi_key = \"QzyDQ\"\nclient_secret = 'QzyEQ'\ntoken = QzyFQ # rotated\n" +
        "DEPLOY_TOKEN = QzyGQ\naws_secret_access_key = QzyHQ",
      ["QzyDQ", "QzyEQ", "QzyFQ", "QzyGQ", "QzyHQ"],
      true,
    ],
    [
      "environment lines",
      'export GITHUB_TOKEN=QzeAQ\nSTRIPE_SECRET_KEY="QzeBQ"\nDB_PASSWORD=QzeCQ',
      ["QzeAQ", "QzeBQ", "QzeCQ"],
      true,
    ],
    [
      "environment variables in a command",
      "docker run -e OPENAI_API_KEY=QzeDQ -e LOG_LEVEL=debug img",
      ["QzeDQ"],
      true,
    ],
    [
      "PHP print_r output",
      "Array\n(\n    [api_key] => QzpAQ\n    [config] => Array\n        (\n" +
        "            [token:protected] => QzpBQ\n        )\n)",
      ["QzpAQ", "QzpBQ"],
      false,
    ],
    [
      "PHP var_dump output",
      'array(2) {\n  ["token"]=>\n  string(5) "QzpCQ"\n  ["password":protected]=>\n  string(8) "QzpDQ é"\n}',
      ["QzpCQ", "QzpDQ"],
      false,
    ],
    [
      "util.inspect Map entries and other => pairs",
      "Map(2) { 'authorization' => 'QzmAQ', 'x-api-key' => QzmBQ } {:token => \"QzmCQ\"}",
      ["QzmAQ", "QzmBQ", "QzmCQ"],
      false,
    ],
    [
      "quoted keys with values without quotes",
      `{ 'x-api-key': QzkAQ, "token": 98765432 }`,
      ["QzkAQ", "98765432"],
      true,
    ],
    [
      "form inputs, attributes in any order",
      '<form><input type="hidden" value="QzhAQ" name="_token">' +
        '<input name=password type=password value=QzhBQ><input type="password" id="pw" value=\'QzhCQ\'></form>',
      ["QzhAQ", "QzhBQ", "QzhCQ"],
      false,
    ],
    [
      "meta tags",
      '<meta name="csrf-token" content="QzhDQ"><meta content="QzhEQ" name="api-token">',
      ["QzhDQ", "QzhEQ"],
      false,
    ],
    [
      "vendor headers",
      "Unauthorized\nOcp-Apim-Subscription-Key: QzvAQ\nX-Functions-Key: QzvBQ\nX-Vault-Token: QzvCQ\nX-Goog-Api-Key: QzvDQ",
      ["QzvAQ", "QzvBQ", "QzvCQ", "QzvDQ"],
      true,
    ],
    [
      "S3's Token-0 element",
      "<Error><Code>InvalidToken</Code><Token-0>QzvEQ</Token-0><SessionToken>QzvFQ</SessionToken></Error>",
      ["QzvEQ", "QzvFQ"],
      false,
    ],
    [
      "entity-escaped markup and JSON",
      "&lt;error&gt;&lt;token&gt;QznAQ&lt;/token&gt;&lt;/error&gt; {&quot;password&quot;: &quot;QznBQ&quot;} " +
        "&amp;lt;token&amp;gt;QznCQ&amp;lt;/token&amp;gt; token=&quot;QznDQ QznEQ&quot;",
      ["QznAQ", "QznBQ", "QznCQ", "QznDQ", "QznEQ"],
      false,
    ],
    [
      "header lines after \\r\\n escapes inside a JSON string",
      '{"error":"Unauthorized\\r\\nX-Api-Key: QzjAQ\\r\\nAuthorization: Token QzjBQ"}',
      ["QzjAQ", "QzjBQ"],
      true,
    ],
    ["a value escaped twice", '{"detail":"{ token: \\\\"QzjCQ\\\\" }"}', ["QzjCQ"], true],
    [
      "pydantic's input_value under a secret field",
      "2 validation errors for Settings\nbody.password\n  Input should be a valid string [type=string_type, input_value=QzdAQ, input_type=int]\n" +
        "api_key\n  String too short [type=string_too_short, input_value='QzdBQ', input_type=str]",
      ["QzdAQ", "QzdBQ"],
      true,
    ],
  ])("redacts the values of %s", (_shape, text, planted, reason) => {
    for (const out of [...outputs(text), ...(reason ? reasonOutputs(text) : [])]) {
      for (const value of planted) expect(out, text).not.toContain(value);
    }
    if (reason) expect(plainReason(text), text).toContain("[redacted]");
  });

  it("tells each shape from its near-misses and from prose", () => {
    // Each near-miss is kept as it is; the shape next to it is redacted.
    const pairs: Array<[near: string, shape: string]> = [
      ["cookies: 3", "cookie: a=3"],
      ["Cookie: session=expired", "Cookie: session=e1"],
      ["Cookie: missing", "Cookie: id=m1"],
      ["Set-Cookie: Path=/; Max-Age=0; HttpOnly", "Set-Cookie: sid=1; Path=/"],
      ["token_count = 5", "token = 5"],
      ["max_tokens = 5", "github_token = 5"],
      ["the token = a word", "token = word"],
      ["token= abc", "token = abc"],
      ["pw1token = abc", "pw_token = abc"],
      ["api_key = a b", "api_key = ab"],
      ["Authorization: not allowed here", "Authorization: Token abc"],
      ["Authorization: Token expired", "Authorization: Token e1"],
      ["Authorization: Bearer of bad news", "Authorization: Bearer abc"],
      ["Idempotency-Key: k1", "X-Goog-Api-Key: k1"],
      ["Token-Count: 5", "Token-0: 5"],
      ["MAX_TOKENS=5", "API_TOKEN=5"],
      ["x sort_token=name", "x SORT_TOKEN=name"],
      ["GITHUB_TOKEN=invalid", "GITHUB_TOKEN=i1"],
      ["[name] => kept", "[token] => kept"],
      ["[token] => Array", "[token] => Arrays"],
      ['["name"]=> string(4) "kept"', '["token"]=> string(4) "kept"'],
      ["'name' => 'kept'", "'token' => 'kept'"],
      ['<input name="tokenizer" value="bert">', '<input name="token" value="bert">'],
      ['<input name="token_count" value="5">', '<input name="csrf-token" value="5">'],
      ['<input type="text" value="kept">', '<input type="password" value="kept">'],
      ['<meta name="viewport" content="width=1">', '<meta name="api-token" content="width=1">'],
      [
        "name\n  Input should be a valid string [type=string_type, input_value='kept', input_type=str]",
        "token\n  Input should be a valid string [type=string_type, input_value='kept', input_type=str]",
      ],
      [
        "token\n  Input should be a valid string [type=string_type, input_value=None, input_type=NoneType]",
        "token\n  Input should be a valid string [type=string_type, input_value=Nine, input_type=NoneType]",
      ],
      ["{ my_token: kept }", "{ x_auth_token: kept }"],
      ["&lt;token-count&gt;3&lt;/token-count&gt;", "&lt;token&gt;3&lt;/token&gt;"],
      ['{ tokenizer: \\\\"bert\\\\" }', '{ token: \\\\"bert\\\\" }'],
    ];
    for (const [near, shape] of pairs) {
      expect(scrubText(near), near).toBe(near);
      expect(redactText(near), near).toBe(near);
      const reason = plainReason(near);
      if (reason !== undefined) expect(reason, near).toBe(near.replace(/\s+/g, " "));
      expect(scrubText(shape), shape).toContain("[redacted]");
    }
  });

  it("keeps cookie names, attributes, comments and the rest of each line", () => {
    expect(
      redactText("Set-Cookie: sid=abc; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT; HttpOnly"),
    ).toBe("Set-Cookie: sid=[redacted]; Path=/; Expires=Wed, 21 Oct 2015 07:28:00 GMT; HttpOnly");
    expect(redactText('Cookie: a="q1"; b=q2')).toBe('Cookie: a="[redacted]"; b=[redacted]');
    expect(redactText('api_key = "v1" # rotated\ntoken = v2 # rotated')).toBe(
      'api_key = "[redacted]" # rotated\ntoken = [redacted] # rotated',
    );
    // A var_dump string is as long as its length in bytes says, "é" being two.
    expect(redactText('["token"]=>\n  string(8) "ab é cd"\n}')).toBe(
      '["token"]=>\n  string(8) "[redacted]"\n}',
    );
    expect(redactText("[password] => hunter2\n[user] => ana")).toBe(
      "[password] => [redacted]\n[user] => ana",
    );
    expect(redactText('<input value="a>b" name="token">')).toBe(
      '<input value="[redacted]" name="token">',
    );
    // A line of a reason is read as a line before the reason is one line.
    expect(plainReason("Unauthorized\nCookie: session=v4")).toBe(
      "Unauthorized Cookie: session=[redacted]",
    );
    expect(plainMessage("export GITHUB_TOKEN=v5\nnext")).toBe(
      "export GITHUB_TOKEN=[redacted] next",
    );
    // The header rule pairs quotes as it does once these values are gone too: a quote inside a
    // cookie value does not show the next pair.
    expect(redactText('header\nCookie: a=x"y\n "LEAK-1" z"')).not.toContain("LEAK-1");
  });

  it("cuts a reason where the other rules cut it, though a mask makes it shorter", () => {
    for (let pad = 20; pad < 50; pad++) {
      const reason = `{ token: a } GITHUB_TOKEN=${"v".repeat(30)} ${"w ".repeat(pad)}QzTAILQ`;
      const before = plainReason(reason.replace("GITHUB_TOKEN", "GITHUB_TOKEX"));
      const now = plainReason(reason);
      if (!before?.includes("Qz")) expect(now, reason).not.toContain("Qz");
      expect(now?.length ?? 0).toBeLessThanOrEqual(120);
      // The other rules' cut falls inside a mask longer than what it hides: no further.
      const masked = `GITHUB_TOKEN=${"v".repeat(30)} ${"w ".repeat(pad)}{ token: a } QzTAILQ`;
      const unmasked = plainReason(masked.replace("GITHUB_TOKEN", "GITHUB_TOKEX"));
      if (!unmasked?.includes("Qz")) expect(plainReason(masked), masked).not.toContain("Qz");
    }
    expect(plainReason(`{ token: a } GITHUB_TOKEN=${"v".repeat(30)} ${"w ".repeat(44)}`)).toBe(
      `{ token: [redacted] } GITHUB_TOKEN=[redacted] ${"w ".repeat(26)}w…`,
    );
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

  /**
   * The delays of the timers the recorder sets while `call` runs to wait for a cassette lock
   * (acquireLock polls with one), told from other timers by where each is set.
   */
  async function lockPolls(call: () => Promise<unknown>): Promise<Array<number | undefined>> {
    const realSetTimeout = globalThis.setTimeout;
    const polls: Array<number | undefined> = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((handler: () => void, ms?: number) => {
      if (new Error().stack?.includes("acquireLock")) polls.push(ms);
      return realSetTimeout(handler, ms);
    }) as typeof setTimeout);
    await call();
    return polls;
  }

  it("breaks a lock left by a recorder that is no longer running", async () => {
    // The pid of a process that has exited.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(join(dir, "deezer.json.lock"), String(dead));
    process.env.SOURCE_CASSETTE = "record";
    stubFetch(() => json({ ok: true }));
    const logs = captureLogsForTests();
    // Broken at once: the recorder sets no timer to wait for the lock, which a busy machine
    // cannot change as it can the time taken. A recorder that waited would also give up after
    // 50 ms and log an error. The next test shows lockPolls finds the timers of a wait.
    const restoreWait = setCassetteLockWaitForTests(50);
    let polls: Array<number | undefined> = [];
    try {
      polls = await lockPolls(() =>
        fetchJson({ source: "deezer", url: "https://api.deezer.test/after-crash" }),
      );
    } finally {
      restoreWait();
      logs.restore();
      vi.restoreAllMocks();
    }

    expect(polls).toEqual([]);
    expect(logs.messages("error")).toEqual([]);
    const entries = JSON.parse(readFileSync(join(dir, "deezer.json"), "utf8")).entries;
    expect(Object.keys(entries)).toEqual(["GET https://api.deezer.test/after-crash"]);
    expect(existsSync(join(dir, "deezer.json.lock"))).toBe(false);
  });

  it("waits for a lock a running recorder holds, then records nothing", async () => {
    // The pid of a running process: the one that started this test's.
    writeFileSync(join(dir, "deezer.json.lock"), String(process.ppid));
    process.env.SOURCE_CASSETTE = "record";
    stubFetch(() => json({ ok: true }));
    const logs = captureLogsForTests();
    // The wait the test above must not find: lockPolls reads its timers, so a recorder that
    // polled for a dead recorder's lock would not pass there.
    const restoreWait = setCassetteLockWaitForTests(50);
    let polls: Array<number | undefined> = [];
    try {
      polls = await lockPolls(() =>
        fetchJson({ source: "deezer", url: "https://api.deezer.test/while-held" }),
      );
    } finally {
      restoreWait();
      logs.restore();
      vi.restoreAllMocks();
    }

    expect(polls.length).toBeGreaterThan(0);
    expect(new Set(polls)).toEqual(new Set([10]));
    expect(logs.messages("error").join("\n")).toContain("deezer.json.lock is held");
    expect(readFileSync(join(dir, "deezer.json.lock"), "utf8")).toBe(String(process.ppid));
    expect(existsSync(join(dir, "deezer.json"))).toBe(false);
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

  it("hides a value whose mask a configured credential's value falls inside", () => {
    // "act" is inside "[redacted]": the mask is hidden whole, never shown in part.
    const before = process.env.GENIUS_ACCESS_TOKEN;
    process.env.GENIUS_ACCESS_TOKEN = "act";
    try {
      expect(redactText('{"token": "sv-x"}')).toBe('{"token": "[redacted]"}');
    } finally {
      if (before === undefined) delete process.env.GENIUS_ACCESS_TOKEN;
      else process.env.GENIUS_ACCESS_TOKEN = before;
    }
  });

  it.each([
    // A token on the line after "Bearer" or "Basic": the one-line reason reads them together.
    [" Authorization: Bearer\r\nQzbbQUnauthorizedQzcbQ  QzdbQX-Api-Key: k1", ["QzbbQ", "QzcbQ"]],
    ["\nX-Api-Key: Basic \r\nQzbbQQzcbQQzdbQQzfbQ", ["QzbbQ", "QzfbQ"]],
    // Cut where it was always cut, so the token after "Bearer" is whole when it is read.
    [`${"w ".repeat(40)}{ token: ab } Bearer\nQzAbCdEfGhIjKlMn`, ["QzAbCdEf"]],
  ])("keeps a token hidden in a reason whose lines are joined: %j", (reason, hidden) => {
    const detail = plainReason(reason);
    const message = new SourceError("spotify", "http", `HTTP 401 — ${detail}`).message;
    for (const value of hidden) {
      expect(detail, reason).not.toContain(value);
      expect(message, reason).not.toContain(value);
    }
  });

  it("cuts a reason where it always cut it, then redacts it", () => {
    // Cut before the token is masked: what lay past the cut stays out.
    const long = `Bearer ${"A1b2C3d4".repeat(5)} ${"w ".repeat(36)}TAILMARK end`;
    expect(plainReason(long)).toBe(`Bearer [redacted] ${"w ".repeat(35)}w…`);
    // A mask that makes the line longer is cut again.
    expect(plainReason(`key=a ${"w ".repeat(80)}`)?.length).toBe(120);
    // A header value that runs past the cut is masked up to it, and the cut's "…" is kept.
    expect(plainReason(`${"w ".repeat(45)}\nX-Api-Key: ${"k".repeat(40)}`)).toBe(
      `${"w ".repeat(45)}X-Api-Key: [redacted]…`,
    );
  });

  it("redacts a message while its lines are still lines, before it is one line", () => {
    // A header line inside a source's reason: read as a line, then flattened.
    expect(plainMessage("Unauthorized\nX-Api-Key: msg-secret-1")).toBe(
      "Unauthorized X-Api-Key: [redacted]",
    );
    expect(plainReason("Forbidden\r\nAuthorization: msg-secret-2")).toBe(
      "Forbidden Authorization: [redacted]",
    );
    // A status word stays, and a link holding a token is still one "[link]".
    expect(plainMessage("Unauthorized\nToken: expired.")).toBe("Unauthorized Token: expired.");
    expect(plainMessage("see https://example.org/x?token=abc123\nnow")).toBe("see [link] now");
    // What would be left out is left out, though its markup was inside a redacted value.
    expect(plainMessage("Unauthorized\nX-Api-Key: <b>k</b>")).toBeUndefined();
    // A line whose redacted form has an issue is left out: the header rule makes `File ""` a trace.
    expect(plainMessage('Invalid header File "", line 5')).toBeUndefined();
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

describe("a credential found escaped at the start of a token (#237)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("hides the token whole, as the credential written as it came did", () => {
    // The mask of the escaped credential splits the token run after it; the credential as it
    // came hid the run whole (a long mixed-case token), and so does every path now.
    vi.stubEnv("DISCOGS_TOKEN", "abc12345");
    const run = "XyZ9".repeat(15);
    for (const text of [
      `id \\u0061bc12345${run} end`,
      `id \\u0061bc12345${run}Q end`,
      `id abc12345${run} end`,
      `"token":"\\u0061bc12345${run}"`,
      `{"error":"bad key \\u0061bc12345${run}"}`,
    ]) {
      for (const out of [
        scrubReadPayload(text) as string,
        redactText(text),
        scrubText(text),
        plainReason(text) ?? "",
        describeError(new Error(text)),
        new SourceError("discogs", "http", text).message,
      ]) {
        expect(out, `${JSON.stringify(text)} -> ${JSON.stringify(out)}`).not.toMatch(
          /XyZ9|abc123|bc12345/,
        );
      }
    }
  });

  it("reads the gap after a run of glued values once on every path, in linear time", {
    timeout: 120_000,
  }, () => {
    // Values glued to a pair's name in one run of token characters, then a long run of spaces:
    // each value's span ends where the run ends. Reading the spaces after it again for each value
    // takes about 1.7 s on 256 kB. From 32 kB to 256 kB a single pass grows about 8-14 times in
    // CPU time, one per value about 64 times.
    const salt = "S1xS2xS3xS4xS5xS6x";
    configureLogger({ LOG_IP_SALT: salt, LOG_LEVEL: process.env.LOG_LEVEL });
    onTestFinished(() => {
      configureLogger({ LOG_LEVEL: process.env.LOG_LEVEL });
    });
    const pair = `${salt}token=`;
    const glued = (size: number) =>
      `${pair.repeat(Math.floor(size / 2 / pair.length))}${" ".repeat(size / 2)}x`;
    const factor = 8;
    for (const [name, call] of [
      ["describeError", (text: string) => describeError(new Error(text))],
      ["SourceError", (text: string) => new SourceError("discogs", "http", text).message],
      ["plainReason", (text: string) => plainReason(text) ?? ""],
      ["scrubText", scrubText],
      ["redactText", redactText],
    ] as const) {
      const { ratio, result } = growth(glued, call, { size: 1 << 15, factor, maxMs: MAX_MS });
      expect.soft(ratio / factor, name).toBeLessThan(3);
      expect(result, name).not.toContain("S1x");
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
          `${size} characters of quoted name= pairs`,
          () => redactQuotedSecrets(fill('token=\\"a\\\\')).length > 0,
          true,
        ],
        [
          `${size} characters of quotes after a header`,
          () => redactText(`header ${fill('"token":"\\"x"')}`).length > 0,
          true,
        ],
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
        // The shapes without a quoted key: each start is read once, whatever follows it.
        [
          `${size} characters of a value after an object key`,
          () => redactText(`{ token: ${fill("a")} }`),
          "{ token: [redacted] }",
        ],
        [
          `${size} characters of an unterminated value after an object key`,
          () => redactText(`{ token: "${fill("a")}`),
          '{ token: "[redacted]',
        ],
        [
          `${size} characters of object keys whose value is an object`,
          () => redactText(`${fill("{token:")} x, token: k}`).endsWith("token: [redacted]}"),
          true,
        ],
        [
          `${size} characters of object keys with prose after them`,
          () => redactText(`{token: k} ${fill(",token: a b")}`).length,
          size + 20,
        ],
        [
          `${size} characters of object keys with quoted values that hold keys`,
          () => redactText(fill(',token:"')).length,
          size + (size * 3) / 16,
        ],
        [
          `${size} characters without an object key after one`,
          () => redactText(`{token: k} ${fill("token: a ")}`).length,
          size + 20,
        ],
        [
          `${size} characters of name= pairs inside a value`,
          () => redactText(`{ token: ${fill("key=")} }`),
          "{ token: [redacted] }",
        ],
        [
          `${size} characters of links inside a value`,
          () => redactText(`{ token: ${fill("//i.scdn.co/a")} }`),
          "{ token: [redacted] }",
        ],
        [
          `${size} characters of an element's content`,
          () => redactText(`<token>${fill("a")}</token>`),
          "<token>[redacted]</token>",
        ],
        [
          `${size} characters of opening tags without a closing tag`,
          () => redactText(`<token>k</token>${fill("<token>")}`).length,
          size + 25,
        ],
        [
          `${size} characters of closing tags before opening tags`,
          () => redactText(`${fill("</token>")}<token>k</token>${fill("<token>")}`).length,
          2 * size + 25,
        ],
        [
          `${size} characters of an opening tag's attributes`,
          () => redactText(`<token>k</token><token ${fill("a=b ")}`).length,
          size + 32,
        ],
        [
          `${size} characters without a tag after one`,
          () => redactText(`<token>k</token>${fill("token a ")}`).length,
          size + 25,
        ],
        [
          `${size} characters of a header value`,
          () => redactText(`X-Api-Key: ${fill("a")}`),
          "X-Api-Key: [redacted]",
        ],
        [
          `${size} characters of header lines with prose after them`,
          () => redactText(`X-Api-Key: k\n${fill("\n token: a b")}`).length,
          size + 22,
        ],
        [
          `${size} characters without a header line after one`,
          () => redactText(`X-Api-Key: k\n${fill("Token a ")}`).length,
          size + 22,
        ],
      ];
    }),
  ])("answers quickly on %s", (_name, call, expected) => {
    // The fastest of three runs: a busy machine only adds time, and a quadratic scan stops early.
    const { ms, result } = timed(call, { runs: 3, stopAboveMs: 2_000 });
    expect(ms).toBeLessThan(400);
    expect(result).toBe(expected);
  });
});

/**
 * The tables below measure each shape's cost on a 50 kB text and on one eight times longer, in the
 * CPU time of the thread that runs it (`growth`). A single pass grows 5-14 times here, as the
 * longer text also costs more per character to build and to collect, and as much on a machine
 * with every CPU busy, since CPU time leaves out the waits for a turn on one. A scan that reads on
 * to the end of its line or of the text from each match grows 35-85 times: a print_r entry or an
 * environment value read again from each key inside it, a cookie value read to the end of its
 * line, a closing tag sought from the first one for each opening tag, or a mask's place sought
 * from the start of the text for each value. Such a scan takes 0.5-1.5 s on 200 kB, which a bound
 * on the time taken cannot tell from the waits of a busy machine. A call over MAX_MS of CPU time,
 * over ten times what a single pass takes on 400 kB, fails at once.
 */
const MAX_MS = 3_000;
const GROWTH = { size: 50_000, factor: 8, maxMs: MAX_MS };
const MAX_GROWTH = 30;
/** How many times `part` occurs in `text`, none overlapping. */
const count = (text: string, part: string) => text.split(part).length - 1;
/** `unit` repeated to `size` characters. */
const filled = (size: number) => (unit: string) =>
  unit.repeat(Math.ceil(size / unit.length)).slice(0, size);

describe("the shapes without a quoted key in linear time", { timeout: 60_000 }, () => {
  it.each<
    [
      string,
      (fill: (unit: string) => string) => string,
      (text: string) => unknown,
      (text: string) => unknown,
    ]
  >([
    [
      "object keys whose value is an object",
      (fill) => `${fill("{token:")} x, token: k}`,
      (text) => redactText(text).endsWith("token: [redacted]}"),
      () => true,
    ],
    [
      "closing tags before opening tags",
      (fill) => `${fill("</token>")}<token>k</token>${fill("<token>")}`,
      (text) => redactText(text).length,
      (text) => text.length + 9,
    ],
    [
      "opening tags without a closing tag",
      (fill) => `<token>k</token>${fill("<token>")}`,
      (text) => redactText(text).length,
      (text) => text.length + 9,
    ],
    [
      "name= pairs inside a value",
      (fill) => `{ token: ${fill("key=")} }`,
      redactText,
      () => "{ token: [redacted] }",
    ],
    [
      "links inside a value",
      (fill) => `{ token: ${fill("//i.scdn.co/a")} }`,
      redactText,
      () => "{ token: [redacted] }",
    ],
    // Every rule masks on a text that earlier rules masked many times over.
    [
      "masks after masks",
      (fill) => `{ token: k } ${fill("key=a //i.scdn.co/x x@y.co ")}`,
      (text) => scrubText(text).length,
      () => 500,
    ],
    [
      "values without quotes among masks",
      (fill) => fill("{ token: k } key=a "),
      (text) => redactText(text).length,
      (text) => text.length + 9 * (count(text, ": k") + count(text, "=a")),
    ],
    [
      "empty quote pairs after a header",
      (fill) => `header ${fill('"" ')}`,
      (text) => redactText(text).length,
      (text) => text.length + 10 * count(text, '""'),
    ],
  ])("grows linearly on %s", (_name, make, call, expected) => {
    const { ratio, result } = growth((size) => make(filled(size)), call, GROWTH);
    expect(ratio).toBeLessThan(MAX_GROWTH);
    // The result on the longer text, against what each mask adds to it.
    expect(result).toEqual(expected(make(filled(GROWTH.size * GROWTH.factor))));
  });

  it("finds where each mask goes once, on 1 MB of masks among masks", () => {
    // About 0.2 s; reading the parts of the text from its start for each mask takes seconds.
    const big = "key=a a@b.cc ".repeat(80_000);
    const { ms, result } = timed(() => scrubText(big).length, { runs: 3, stopAboveMs: 5_000 });
    expect(ms).toBeLessThan(1500);
    expect(result).toBe(500);
  });
});

describe("secret values in JSON strings, cut texts and more variants of each shape", () => {
  /** A source's reason as it reaches an error message, and that message as it is stored. */
  const reasonOutputs = (text: string) => {
    const detail = plainReason(text);
    const message = new SourceError("spotify", "http", `HTTP 401 — ${detail ?? "refused"}`).message;
    return [detail ?? "", message, plainMessage(message) ?? ""];
  };

  it.each<[layout: string, text: string, planted: string[]]>([
    ["a key after the string", '{"raw": "a\\r\\nX-Api-Key: QzlAQ", "b": 1}', ["QzlAQ"]],
    ["no space after the string", '{"raw":"a\\nX-Api-Key: QzlBQ","b":1}', ["QzlBQ"]],
    ["the first line of a string", '{"raw": "X-Api-Key: QzlCQ\\r\\nnext"}', ["QzlCQ"]],
    ["a whole string", '{"raw": "Authorization: Token QzlDQ\\n"}', ["QzlDQ"]],
    ["strings in an array", '["a\\nX-Api-Key: QzlEQ", "Cookie: sid=QzlFQ"]', ["QzlEQ", "QzlFQ"]],
    ["a config line in a string", '{"env": "export GITHUB_TOKEN=QzlGQ\\nDEBUG=1"}', ["QzlGQ"]],
  ])("redacts a header line inside a JSON string: %s", (_layout, text, planted) => {
    for (const out of [scrubText(text), redactText(text), ...reasonOutputs(text)]) {
      for (const value of planted) expect(out, text).not.toContain(value);
    }
  });

  it("ends a line inside a JSON string where the string ends", () => {
    expect(redactText('{"error":"bad\\nX-Api-Key: abc","status":401,"title":"Unauthorized"}')).toBe(
      '{"error":"bad\\nX-Api-Key: [redacted]","status":401,"title":"Unauthorized"}',
    );
    expect(redactText('{"error":"bad\\nX-Api-Key: abc", "status": 401}')).toBe(
      '{"error":"bad\\nX-Api-Key: [redacted]", "status": 401}',
    );
    // A doubled backslash before a quote is read as an escaped quote of a value escaped twice
    // too: the value runs on to the end, as the widened filter of the test below allows.
    expect(redactText('token=\\\\"v" rest')).toBe("token=[redacted]");
  });

  it("cuts a scrubbed body where the other rules cut it, though a mask makes it shorter", () => {
    for (let pad = 180; pad < 260; pad += 3) {
      const body = `GITHUB_TOKEN=${"v".repeat(120)} ${"w ".repeat(pad)}QzTAILQ`;
      const before = scrubText(body.replace("GITHUB_TOKEN", "GITHUB_TOKEX"));
      const now = scrubText(body);
      if (!before.includes("Qz")) expect(now, body).not.toContain("Qz");
      expect(now.length).toBeLessThanOrEqual(500);
    }
    // A mask longer than what it hides: the cap falls on the redacted text, as before.
    expect(scrubText(`GITHUB_TOKEN=v1 ${"w ".repeat(300)}`)).toHaveLength(500);
    // Without the new shapes, the cap falls where it always fell.
    const plain = `${"w ".repeat(300)}QzTAILQ`;
    expect(scrubText(plain)).toBe(plain.slice(0, 500));
  });

  it("leaves out a line the other rules leave with an issue, though a mask removes it", () => {
    // The header rule makes `File "[redacted]", line 4` a stack trace; a mask over `File` would
    // hide that, and show a line that was left out.
    expect(plainMessage('Invalid header GITHUB_TOKEN=File "", line 4')).toBeUndefined();
    expect(plainReason('Invalid header GITHUB_TOKEN=File "", line 4')).toBeUndefined();
  });

  it("cuts an error message where a log's cap cuts it without the new shapes", () => {
    // The HTTP error log keeps 200 characters of a message (logText), a log line 16 KiB (scrub).
    for (let pad = 20; pad < 80; pad += 3) {
      const message = `GITHUB_TOKEN=${"v".repeat(60)} ${"w ".repeat(pad)}QzTAILQ`;
      const unmasked = message.replace("GITHUB_TOKEN", "GITHUB_TOKEX");
      const logged = (text: string) => logText(new SourceError("spotify", "http", text).message);
      if (!logged(unmasked).includes("Qz")) expect(logged(message), message).not.toContain("Qz");
    }
    for (let pad = 8_150; pad < 8_220; pad += 7) {
      const message = `GITHUB_TOKEN=${"v".repeat(400)} ${"w ".repeat(pad)}QzTAILQ`;
      const unmasked = message.replace("GITHUB_TOKEN", "GITHUB_TOKEX");
      const logged = (text: string) => scrub(`Error: ${describeError(new Error(text))}`);
      if (!logged(unmasked).includes("Qz"))
        expect(logged(message), String(pad)).not.toContain("Qz");
    }
    // Without the new shapes, a message is what it always was.
    const plain = `spotify: ${"w ".repeat(150)}`;
    expect(new SourceError("spotify", "http", "w ".repeat(150)).message).toBe(plain);
  });

  it("keeps hidden in a log line what the logger's own rules hide on the other rules' text", () => {
    // A mask over the key the logger reads (`token=`, `Bearer`) must not show the value after it.
    for (const [text, hidden] of [
      ["<input name=_token value=\ntoken= QzLOGAQ", "QzLOGAQ"],
      ["Forbidden\nexport X_TOKEN=Bearer QzLOGDQ", "QzLOGDQ"],
      ["Forbidden X_TOKEN=Bearer QzLOGEQ", "QzLOGEQ"],
      // Masking the value the logger read behind `token:` takes its `Bearer`: a second round.
      ["Forbidden X_TOKEN=token: Bearer QzLOGFQ", "QzLOGFQ"],
    ]) {
      const reason = plainReason(text);
      for (const line of [
        scrub(`Error: ${describeError(new Error(text))}`),
        scrub(new SourceError("spotify", "http", text).message),
        scrub(redactText(text)),
        scrub(scrubText(text)),
        scrub(new SourceError("spotify", "http", `HTTP 401 — ${reason ?? "refused"}`).message),
        scrub(plainMessage(text) ?? ""),
      ]) {
        expect(line, text).not.toContain(hidden);
      }
    }
  });

  it("leaves no part of a host or a configured value where a log line's cut falls", () => {
    // A cut that lands inside a provider host or a configured value would leave a part the
    // logger no longer knows: the SourceError's own cut (a), and the HTTP error log's (b).
    const salt = "M9001xM9002xM9003x";
    configureLogger({ LOG_IP_SALT: salt, LOG_LEVEL: process.env.LOG_LEVEL });
    try {
      for (let pad = 50; pad < 75; pad++) {
        for (const tail of [salt, "contoso-prod.openai.azure.com"]) {
          const a = `401\nCookie: sid=${"a".repeat(40)}\n${"x ".repeat(pad)}${tail} tail`;
          const b = `token: 1\nCookie: a=1; b=2; c=3\n${"y ".repeat(pad)}${tail}`;
          const lines = [
            scrub(
              `Spotify search for "x" failed: ${describeError(new SourceError("spotify", "http", a))}`,
            ),
            scrub(logText(new SourceError("spotify", "http", b).message)),
          ];
          for (const line of lines) expect(line, `${pad} ${tail}`).not.toMatch(/M900\dx|contoso/);
        }
      }
    } finally {
      configureLogger({ LOG_LEVEL: process.env.LOG_LEVEL });
    }
  });

  it("keeps hidden a value the logger reads only once it has replaced a host", () => {
    // Scrub replaces the host first; its pair rule then reads `X-Api-Key: v` after it.
    const text =
      "QzbbQ\n  - token: contoso-prod.openai.azure.com\\n\\r\\nX-Api-Key: QzdbQcookies: QzfbQ";
    for (const endpoint of [undefined, "https://contoso-prod.openai.azure.com"]) {
      configureLogger({ AZURE_OPENAI_ENDPOINT: endpoint, LOG_LEVEL: process.env.LOG_LEVEL });
      try {
        for (const line of [
          scrub(`Error: ${describeError(new Error(text))}`),
          scrub(logText(new SourceError("spotify", "http", text).message)),
          scrub(scrubText(text)),
        ]) {
          expect(line, endpoint).not.toContain("QzdbQ");
        }
      } finally {
        configureLogger({ LOG_LEVEL: process.env.LOG_LEVEL });
      }
    }
  });

  it("keeps hidden in a stored reason what the logger reads after a scheme a line's mask takes", () => {
    // The OAuth parameter's value is the scheme word the logger reads `Bearer v` by.
    const text = "QzbbQ\nAuthorization: OAuth oauth_token=Bearer QzcbQcookie: 'QzdbQ";
    const detail = plainReason(text);
    const message = new SourceError("spotify", "http", `HTTP 401 — ${detail ?? "x"}`).message;
    for (const line of [scrub(detail ?? ""), scrub(message), scrub(plainMessage(message) ?? "")]) {
      expect(line).not.toContain("QzcbQ");
    }
  });

  it("finds what a log line hides right after a mask where it lies in the text", () => {
    // The log line's span ends on the first character after a mask: read as part of the mask, the
    // last "-" of the token run would be left out of it.
    const text = `\\t\nPassword:password=" "4${"-A1b2C3d4".repeat(7)}-`;
    expect(redactText(text)).toBe("\\t\nPassword:[redacted]");
  });

  it("keeps hidden a value the log line reads only once an earlier lost part is masked", () => {
    // The first reading masks the key "token", which the log line would lose; the line then reads
    // "[redacted] = M0019x", which the logger no longer takes for a pair, so the value is lost too.
    const text = '[token] => Bearer \ntoken = M0019x<meta content="a"';
    expect(scrub(scrubText(text))).not.toContain("M0019x");
    expect(scrub(redactText(text))).not.toContain("M0019x");
  });

  it("keeps hidden what the other rules hide when they redact their own text again", () => {
    // A network error's message is a described error, described again when it is logged: the
    // header rule pairs the quotes of the text it left, and hides more the second time.
    const text =
      '}header<input name="tokenizer" value=aa" type=password>x"{ token: \\"\\"M0008x }' +
      '&amp;lt;Token-0>\'M0013x"&lt;/Token-0>{"raw": "aCookie: Token ,M0018x", "b": 1}';
    const twice = describeError(
      new SourceError("audio", "network", describeError(new Error(text))),
    );
    expect(twice).not.toContain("M0018x");
  });

  it("never cuts a host in two: the HTTP error log's text, or a body masks make longer", () => {
    for (let pad = 80; pad < 100; pad++) {
      // Client text in the HTTP error log, cut at 200 characters.
      expect(scrub(logText(`${"x ".repeat(pad)}contoso-prod.openai.azure.com`))).not.toMatch(
        /contoso/,
      );
    }
    for (let pad = 140; pad < 165; pad++) {
      // Masks longer than the values they hide carry the body's cap into the host.
      const body = `${"X_TOKEN=a ".repeat(10)}${"y ".repeat(pad)}contoso-prod.openai.azure.com tail`;
      expect(scrub(scrubText(body)), String(pad)).not.toMatch(/contoso/);
    }
  });

  it("never cuts a source's reason through a configured value or a host", () => {
    // The reason's own cut, at 119 characters, comes before any redaction: a part of a value it
    // split was no longer known to the rules that hide it, nor to the logger.
    const key = "M7001xM7002xM7003xQQQ";
    const host = "contoso-prod.openai.azure.com";
    process.env.TEST_SERVICE_API_KEY = key;
    configureLogger({ AZURE_OPENAI_ENDPOINT: `https://${host}`, LOG_LEVEL: process.env.LOG_LEVEL });
    try {
      for (let pad = 40; pad < 60; pad++) {
        for (const value of [key, host]) {
          const reason = plainReason(`${"x ".repeat(pad)}The API key ${value} is not valid`) ?? "";
          const message = new SourceError("spotify", "http", `HTTP 401: ${reason}`).message;
          for (const shown of [reason, scrub(reason), scrub(logText(message))]) {
            for (let k = 1; k < value.length; k++) {
              expect(shown, `${pad} ${k}`).not.toContain(`${value.slice(0, k)}…`);
            }
          }
        }
      }
    } finally {
      delete process.env.TEST_SERVICE_API_KEY;
      configureLogger({ LOG_LEVEL: process.env.LOG_LEVEL });
    }
  });

  it("leaves out past a configured value a reason's cut splits, and hides what it hid before", () => {
    // The configured value ends a long token run and a Basic credential: cut at the value's
    // start, neither would be long enough for its rule, so the line is redacted as first cut.
    const key = "Zq7".repeat(23);
    process.env.TEST_SERVICE_API_KEY = key;
    try {
      for (let pad = 9; pad < 21; pad++) {
        for (const [before, hidden] of [
          ['"tokens"aB3dE6gH9jK2mN5pQ8sT1vaB3dE6gH9jK2mN5pQ8', "aB3dE6"],
          ["\nProxy-Authorization: Basic Api-Key", "Api-Key"],
        ] as const) {
          const reason = plainReason(`${"x ".repeat(pad)}${before}${key} tail`) ?? "";
          expect(reason, String(pad)).not.toContain(hidden);
          expect(reason, String(pad)).not.toContain("Zq7");
        }
      }
    } finally {
      delete process.env.TEST_SERVICE_API_KEY;
    }
  });

  it("moves a reason's cut until it splits nothing, where a configured value starts in a host", () => {
    // Moved to the start of the value, the cut would split the host the value starts in.
    process.env.TEST_SERVICE_API_KEY = "azure.com K7xQ";
    try {
      for (let pad = 38; pad < 52; pad++) {
        const reason = plainReason(`${"x ".repeat(pad)}contoso-prod.openai.azure.com K7xQ tail`);
        expect(reason, String(pad)).not.toMatch(/contoso[\w.-]*…/);
      }
    } finally {
      delete process.env.TEST_SERVICE_API_KEY;
    }
  });

  it("never cuts a reason through a host or a configured value the masks before it push across", () => {
    // `api_key=a` becomes `api_key=[redacted]`: the line grows past the cut with no new shape.
    const salt = "S1xS2xS3xS4xS5xS6x";
    const host = "contoso-prod.openai.azure.com";
    configureLogger({ LOG_IP_SALT: salt, LOG_LEVEL: process.env.LOG_LEVEL });
    try {
      for (let pairs = 4; pairs < 9; pairs++) {
        for (const value of [salt, host]) {
          const reason = plainReason(`${"api_key=a ".repeat(pairs)}${value} tail`) ?? "";
          for (const shown of [reason, scrub(reason)]) {
            for (let k = 2; k < value.length; k++) {
              expect(shown, `${pairs} ${k}`).not.toContain(`${value.slice(0, k)}…`);
            }
          }
        }
      }
    } finally {
      configureLogger({ LOG_LEVEL: process.env.LOG_LEVEL });
    }
  });

  it("never keeps part of an Authorization credential where a reason's cut falls", () => {
    for (let at = 60; at < 100; at++) {
      const bearer = plainReason(
        `${"x".repeat(at)} Authorization: Bearer abcdefghijklmnopqrstuvwx tail ${"z ".repeat(60)}`,
      );
      expect(bearer ?? "", String(at)).not.toMatch(/Bearer a[a-x]*…/);
      const basic = plainReason(
        `401\n${"x".repeat(at)} Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ== tail ${"z ".repeat(60)}`,
      );
      for (const shown of [basic ?? "", scrub(basic ?? "")]) {
        expect(shown, String(at)).not.toMatch(/Basic Q[\w+/=]*…/);
      }
    }
  });

  it("never cuts a log line or a reason through a long configured value, or before a link's @", () => {
    const userinfo = "https://u:P1xP2xP3xP4xP5xP6xP7xP8x@h.example/";
    const atSign = `${"x ".repeat(83).slice(0, 165)} ${userinfo} tail ${"x ".repeat(100)}`;
    expect(scrub(logText(atSign))).not.toContain("P1xP2");
    // A configured value longer than the window logCut reads past a cut.
    const long = "Q7".repeat(2_500);
    configureLogger({ LOG_IP_SALT: long, LOG_LEVEL: process.env.LOG_LEVEL });
    try {
      for (const before of [10, 60, 118, 150, 199]) {
        const text = `${"x".repeat(before)}${long} tail`;
        expect(scrub(logText(text)), String(before)).not.toContain("Q7Q7");
        expect(scrub(plainReason(text) ?? ""), String(before)).not.toContain("Q7Q7");
      }
    } finally {
      configureLogger({ LOG_LEVEL: process.env.LOG_LEVEL });
    }
  });

  it("never cuts a described error before a link's @, or through a long configured value", () => {
    // A new shape before the link (the Cookie line) makes describeError cut the text itself.
    const lead = `401\nCookie: sid=${"a".repeat(40)}\n`;
    const userinfo = "https://u:U1xU2xU3xU4xU5xU6xU7xU8x@h.example/x tail";
    for (let shift = -3; shift < 3; shift++) {
      const text = `${lead}${"x ".repeat(7635).slice(0, 15268 + shift)} ${userinfo}`;
      const logged = scrub(`Error: ${describeError(new Error(text))}`);
      expect(logged, String(shift)).not.toContain("U1xU2");
      // The cut moves to the link, not back to the start of the text around it.
      expect(logged.length, String(shift)).toBeGreaterThan(15_000);
    }
    // A configured value longer than the window the logger reads past a cut, at each cut.
    const long = "L7.".repeat(1_700);
    configureLogger({ LOG_IP_SALT: long, LOG_LEVEL: process.env.LOG_LEVEL });
    try {
      for (const [cut, path] of [
        [15_360, (t: string) => scrub(`Error: ${describeError(new Error(t))}`)],
        [200, (t: string) => scrub(logText(new SourceError("spotify", "http", t).message))],
        [500, (t: string) => scrub(scrubText(t))],
        [120, (t: string) => scrub(plainReason(t) ?? "")],
      ] as const) {
        for (const before of [5, 40, 150]) {
          const filler = "x ".repeat(cut).slice(0, cut - before - lead.length - 1);
          const text = `${lead}${filler} ${long} tail`;
          expect(path(text), `${cut} ${before}`).not.toContain("L7.L7.");
        }
      }
    } finally {
      configureLogger({ LOG_LEVEL: process.env.LOG_LEVEL });
    }
  });

  it("never leaves a short Basic credential where a cut moved before a value glued to it", () => {
    // `Basic M0003x=` plus the salt was one credential; cut before the salt, it is too short for
    // the logger's rule.
    const salt = "S1xS2xS3xS4xS5xS6x";
    configureLogger({ LOG_IP_SALT: salt, LOG_LEVEL: process.env.LOG_LEVEL });
    try {
      for (let before = 1; before < salt.length; before++) {
        const text = `${"x".repeat(200 - before - 14)} Basic M0003x=${salt} tail`;
        expect(scrub(logText(text)), String(before)).not.toContain("M0003x");
      }
    } finally {
      configureLogger({ LOG_LEVEL: process.env.LOG_LEVEL });
    }
  });

  it("never cuts a body's cap through a host when nothing else in it is masked", () => {
    for (let pad = 225; pad < 250; pad++) {
      const body = `<html>${"y ".repeat(pad)} upstream contoso-prod.openai.azure.com timed out</html>`;
      expect(scrub(scrubText(body)), String(pad)).not.toMatch(/contoso/);
    }
  });

  it("masks a template reference whole, and keeps an Authorization scheme on every path", () => {
    // A GitHub Actions expression, written as it is in a workflow file.
    const reference = ["deploy GITHUB_TOKEN=$", "{{ secrets.GH }} now"].join("");
    expect(redactText(reference)).toBe("deploy GITHUB_TOKEN=[redacted] now");
    expect(redactText("Unauthorized\nAuthorization: Bearer abc.def")).toBe(
      "Unauthorized\nAuthorization: Bearer [redacted]",
    );
    expect(plainReason("Unauthorized\nAuthorization: Bearer abc.def")).toBe(
      "Unauthorized Authorization: Bearer [redacted]",
    );
  });

  it("keeps hidden what a reason's error message hides when it is redacted again", () => {
    // The other rules leave M0017x in the reason, and mask it when the message made from it is
    // redacted again, by the key before it; a mask over that key must not show it.
    const reason =
      '-e A_SECRET=\'\\aa\\""password": "\u00e9\u00e9 }\r\nexport api_key=\';"\\ntoken = \u00e9\'M0017x\\" x\'set-cookie": a=;\'&quot;token&quot;:\\"\\"=&quot;["a\\nGITHUB_TOKEN: \u00e9"","status":401}';
    const detail = plainReason(reason);
    const message = new SourceError("spotify", "http", `HTTP 401 — ${detail}`).message;
    for (const out of [message, plainMessage(message) ?? ""]) expect(out).not.toContain("M0017x");
  });

  it.each<[variant: string, text: string, planted: string[]]>([
    ["print_r entries spaced any way", "[api_key]=>QzvaQ\n[token]  =>  QzvbQ", ["QzvaQ", "QzvbQ"]],
    ["var_dump references", '["token"]=>\n  &string(5) "QzvcQ"', ["QzvcQ"]],
    ["cookies in a Map", "Map(1) { 'cookie' => 'sid=QzvdQ; lang=QzveQ' }", ["QzvdQ", "QzveQ"]],
    [
      "a _csrf form field",
      '<input name="_csrf" value="QzvfQ"><meta name="_csrf" content="QzvgQ">',
      ["QzvfQ", "QzvgQ"],
    ],
    ["a last entity without ';'", "&lt;token&gt;QzvhQ&lt;/token&gt", ["QzvhQ"]],
    [
      "a cookie spaced around '='",
      "Unauthorized\nCookie: sid = QzvjQ; lang =QzvkQ",
      ["QzvjQ", "QzvkQ"],
    ],
    ["Set-Cookie values joined by ','", "Set-Cookie: a=QzvmQ,b=QzvnQ; Path=/", ["QzvmQ", "QzvnQ"]],
    [
      "Digest parameters",
      'Unauthorized\nAuthorization: Digest username="QzvpQ", realm="api", response="QzvqQ"',
      ["QzvpQ", "QzvqQ"],
    ],
    [
      "OAuth parameters",
      'Unauthorized\nAuthorization: OAuth realm="api", oauth_token="QzvrQ", oauth_signature="QzvsQ"',
      ["QzvrQ", "QzvsQ"],
    ],
    [
      "a secret key named in an environment line",
      "SECRET_KEY=QzvtQ\nexport STRIPE_SECRET_KEY=QzvuQ",
      ["QzvtQ", "QzvuQ"],
    ],
  ])("redacts the values of %s", (_variant, text, planted) => {
    for (const out of [scrubText(text), redactText(text)]) {
      for (const value of planted) expect(out, text).not.toContain(value);
    }
  });

  it("keeps the parts of each shape that are not secret", () => {
    expect(redactText("Set-Cookie: a=1,b=2; Path=/")).toBe(
      "Set-Cookie: a=[redacted],b=[redacted]; Path=/",
    );
    expect(
      redactText('Unauthorized\nAuthorization: Digest username="ana", realm="api", response="r1"'),
    ).toBe(
      'Unauthorized\nAuthorization: Digest username="[redacted]", realm="api", response="[redacted]"',
    );
    // A string over two lines is as long as its length in bytes says.
    expect(redactText('["token"]=>\n  string(6) "éé\na"\n}')).toBe(
      '["token"]=>\n  string(6) "[redacted]"\n}',
    );
    expect(redactText('["token"]=>\n  string(99) "abc"\n  ["name"]=>\n  string(4) "kept"')).toBe(
      '["token"]=>\n  string(99) "[redacted]"\n  ["name"]=>\n  string(4) "kept"',
    );
  });

  it("tells each variant from its near-misses", () => {
    const kept = [
      "IDEMPOTENCY_KEY=abc",
      "S3_KEY=uploads/a.png",
      "PRIMARY_KEY=id",
      "SORT_KEY=name",
      "CACHE_KEY=v1",
      "HASH_KEY=pk",
      "PARTITION_KEY=pk",
      "FOREIGN_KEY=user_id",
      "export IDEMPOTENCY_KEY=abc",
      "API_TOKEN=not set",
      "API_TOKEN=nil",
      "DB_PASSWORD=unset",
      "Unauthorized\nProxy-Authorization: Bearer",
      "Unauthorized\nX-Api-Key: Key please",
      "token\n  Field required [type=missing, input_value={'a': 1}, input_type=dict]",
      "next_page_token: abc",
      "pageToken: abc",
      "continuation_token = abc",
      "sync_token = abc",
      "<NextContinuationToken>abc</NextContinuationToken>",
      '<input type="checkbox" name="show_password" value="1">',
    ];
    for (const near of kept) {
      expect(scrubText(near), near).toBe(near);
      expect(redactText(near), near).toBe(near);
    }
  });
});

describe("cookies, config text, dumps, forms and escaped text in linear time", {
  timeout: 60_000,
}, () => {
  // Each text ends with a value to hide.
  it.each<[string, (fill: (unit: string) => string) => string]>([
    ["cookie pairs", (fill) => `Cookie: ${fill("a=b; ")}s=QzENDQ`],
    ["Set-Cookie dates", (fill) => `Set-Cookie: ${fill("Expires=Wed, 21 Oct ")}, s=QzENDQ`],
    ["field lines that are prose", (fill) => `${fill("\ntoken: a b")}\ntoken: QzENDQ`],
    ["field names without a colon", (fill) => `${fill(`\n${"a".repeat(70)}`)}\ntoken: QzENDQ`],
    ["environment names", (fill) => `${fill("A_TOKENA_TOKEN")} B_TOKEN=QzENDQ`],
    ["environment values holding names", (fill) => `X_TOKEN=${fill("A_TOKEN=")}QzENDQ`],
    ["quoted keys whose value is prose", (fill) => `${fill("'token': a b ")}{ 'token': QzENDQ }`],
    ["print_r entries", (fill) => `${fill("[token] => [token] => ")}\n[token] => QzENDQ`],
    [
      "var_dump lengths that do not match",
      (fill) => `${fill('["token"]=> string(1) "aé ')}"\n["token"]=> string(6) "QzENDQ"`,
    ],
    ["form tags", (fill) => `${fill("<input <meta a=b ")}<input name=token value=QzENDQ>`],
    [
      "pydantic inputs on one line",
      (fill) => `token\n${fill("[type=a, input_value=b]")}[type=a, input_value=QzENDQ]`,
    ],
    ["entities", (fill) => `${fill("&amp;lt;token&amp;gt;")}&lt;token&gt;QzENDQ&lt;/token&gt;`],
    [
      "a long input name",
      (fill) => `<input name="${fill("aB")}" value="x"><input name=token value=QzENDQ>`,
    ],
    [
      "a long input id",
      (fill) => `<input id="${fill("a-")}" value="x"><input name=token value=QzENDQ>`,
    ],
    [
      "a long meta name",
      (fill) => `<meta name="${fill("a_")}" content="x"><meta name=token content=QzENDQ>`,
    ],
    [
      "a long input name inside a JSON string",
      (fill) => `{"m":"\\u003cinput name=\\"${fill("aB")}\\"\\u003e"} X_TOKEN=QzENDQ`,
    ],
    [
      "Authorization parameters",
      (fill) => `Authorization: Digest a=b, ${fill("x")}\ntoken: QzENDQ`,
    ],
    [
      "Authorization parameters inside a JSON string",
      (fill) => `{"e":"a\\r\\nAuthorization: Digest a=b, ${fill("x")}"} X_TOKEN=QzENDQ`,
    ],
    ["OAuth parameters", (fill) => `Proxy-Authorization: OAuth k=v ${fill("a.")}\ntoken: QzENDQ`],
    ["string escapes", (fill) => `${fill('\\\\\\"token\\": ')}{"e":"a\\r\\nX-Api-Key: QzENDQ"}`],
  ])("grows linearly on %s", (_name, make) => {
    const { ratio, result } = growth((size) => make(filled(size)), redactText, GROWTH);
    expect(ratio).toBeLessThan(MAX_GROWTH);
    expect(result).not.toContain("QzENDQ");
  });

  it("describes a 1 MB error in linear time, and reads only the text near the HTTP log's cap", () => {
    const calls = [
      (text: string) => describeError(new Error(text)),
      (text: string) => new SourceError("spotify", "http", text).message,
    ];
    // Field lines whose value is prose: the end of each line is found once. From 128 kB to 1 MB
    // this grows 7-9 times in CPU time (about 50 ms on 1 MB), with every CPU busy as well. Finding
    // each line's end by searching for CR and for LF apart grows over 40 times, and searching for
    // each of the seven line breaks apart about 60 times, as a search for a break the text does not
    // hold reads on to its end. Those take 0.7-2.5 s on 1 MB, which a bound on the time taken
    // cannot tell from the waits of a busy machine.
    const prose = (size: number) => "\ntoken: a b".repeat(Math.floor(size / 11));
    for (const call of calls) {
      const { ratio } = growth(prose, call, { size: 1 << 17, factor: 8, maxMs: MAX_MS });
      expect(ratio).toBeLessThan(20);
    }
    // About 0.4 s of CPU time each. The bound only catches a scan that reads the whole text again
    // for each value, which takes minutes.
    const big = "\nX-Api-Key: k\ntoken: a b".repeat(Math.floor((1 << 20) / 24));
    for (const call of calls) {
      const cpu = { runs: 3, stopAboveMs: 2 * MAX_MS, clock: threadCpuMs };
      const { ms, result } = timed(() => call(big), cpu);
      expect(ms).toBeLessThan(MAX_MS);
      expect(result).not.toMatch(/: k\b/);
    }
    // The HTTP error log reads only the text near its cap, however many hosts follow.
    const hosts = "contoso-prod.openai.azure.com ".repeat((1 << 20) / 30);
    for (const text of [big, hosts]) {
      const cpu = { runs: 3, stopAboveMs: 2_000, clock: threadCpuMs };
      expect(timed(() => logText(text), cpu).ms).toBeLessThan(25);
    }
  });

  it("answers quickly on a long form-field name in a source's reason", () => {
    const reason = `{"m":"\\u003cinput name=\\"${filled(200_000)("aB")}\\" value=\\"x\\"\\u003e"}`;
    const { ms } = timed(() => plainReason(reason), { runs: 3, stopAboveMs: 2_000 });
    expect(ms).toBeLessThan(400);
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
    "password=",
    "token='",
    '=\\"',
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
  // A quote after a key or "=" counts escaped any number of times: text is also read as it reads
  // once its string escapes are decoded (`token=\\"v` is `token=\"v` there).
  const quotedKeyOrEscapedSlash =
    /\\\/|(?:key|token|secret|password|authorization)\\*["']|=\\*["']/i;

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

  it("differs from before on keys without quotes, elements and header lines only by masks", () => {
    const shapes = randomStrings(
      [
        "token",
        "apiKey",
        "X-Api-Key",
        "X-Auth-Token",
        "Api-Keys",
        "tokens",
        ":",
        ": ",
        "{",
        "}",
        ",",
        " ",
        "\n",
        "\r\n",
        "> ",
        "'",
        '"',
        "`",
        "\\",
        '\\"',
        "<token>",
        "</token>",
        '<Password a="b">',
        "</password>",
        "<token/>",
        "<token-count>",
        "a",
        "b c",
        "sv-1",
        "header",
        "[redacted]",
        "{ token: ",
        ", password:",
        "\nX-Api-Key: ",
        "<access_token>",
        "</ACCESS_TOKEN>",
      ],
      20_000,
      12,
      3,
    );
    const runs = shapes.map((input) => ({
      input,
      now: scrubText(input),
      old: scrubTextBefore(input),
    }));
    const changed = runs.filter(({ now, old }) => now !== old);
    expect(changed.filter(({ now, old }) => !onlyNewRedactions(now, old)).slice(0, 5)).toEqual([]);
    // Most of these hold no quoted key: the new shapes are read.
    expect(
      changed.filter(({ input }) => !quotedKeyOrEscapedSlash.test(input)).length,
    ).toBeGreaterThan(2_000);
  });

  it("differs from before on cookies, config text, dumps, forms and escaped text only by masks", () => {
    const shapes = randomStrings(
      [
        "\nCookie: ",
        "\n< Set-Cookie: ",
        "a=",
        "sid=",
        "; ",
        ", ",
        "Path=/",
        "Expires=Wed, 21 Oct 2015",
        "\nexport ",
        "GITHUB_TOKEN=",
        "STRIPE_KEY=",
        "\napi_key = ",
        "\n- github_token: ",
        "\nAuthorization: Token ",
        "[api_key] => ",
        "'token' => ",
        "{ 'x-api-key': ",
        ' string(3) "',
        '["token"]=>',
        "<input name=_token value=",
        '<meta name="csrf-token" content="',
        "&lt;token&gt;",
        "&lt;/token&gt;",
        "&quot;",
        "\\r\\n",
        "X-Vault-Token: ",
        "input_value=",
        "[type=a, ",
        "\npassword\n  ",
        "sv1",
        "a b",
        "invalid",
        '"',
        "'",
        "\\",
        "\n",
        " ",
        "}",
        ",",
        ">",
        "#",
      ],
      20_000,
      12,
      7,
    );
    const runs = shapes.map((input) => ({
      input,
      now: scrubText(input),
      old: scrubTextBefore(input),
    }));
    const changed = runs.filter(({ now, old }) => now !== old);
    expect(changed.filter(({ now, old }) => !onlyNewRedactions(now, old)).slice(0, 5)).toEqual([]);
    // About half of these texts hold a shape the rules before did not read.
    expect(changed.length).toBeGreaterThan(8_000);
  });
});
