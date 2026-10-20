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
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cassetteKey,
  credential,
  describeError,
  fetchJson,
  pick,
  redactText,
  SourceError,
  scrubPayload,
  scrubReadPayload,
  scrubText,
} from "./http.js";
import { html, json, never, stubFetch } from "./testing/fetchStub.js";

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
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    const started = Date.now();
    try {
      await fetchJson({ source: "deezer", url: "https://api.deezer.test/after-crash" });
    } finally {
      vi.restoreAllMocks();
    }

    expect(errors).toEqual([]);
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

    const { stderr } = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", worker, blocked, "lost", "3"],
      { env: { ...process.env, SOURCE_CASSETTE: undefined, NODE_ENV: "test" } },
    );

    expect(stderr).toMatch(/3 answer\(s\) could not be recorded/);
    expect(stderr.match(/could not be recorded/g)).toHaveLength(1);
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
    const logged: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    stubFetch(() => json(live));

    try {
      await expect(fetchJson(request)).resolves.toEqual(live);
      expect(logged.some((line) => line.includes("cannot write cassette"))).toBe(true);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("logs the active mode when it changes", async () => {
    const logged: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
    stubFetch(() => json(live));
    try {
      process.env.SOURCE_CASSETTE = "replay";
      await rejection(fetchJson(request));
      process.env.SOURCE_CASSETTE = "record";
      await fetchJson(request);
      expect(logged.some((line) => line.includes("SOURCE_CASSETTE=record"))).toBe(true);
    } finally {
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
