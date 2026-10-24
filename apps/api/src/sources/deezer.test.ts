/**
 * Deezer previews with a stubbed API. A preview is used only for the requested recording: the
 * entry for its ISRC, that entry's readable alternative, or a search result that strictly
 * matches it. Deezer reports errors (its quota included) inside an HTTP 200 answer: "no data"
 * (800) is a miss, the quota (4) an error.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type DeezerPreviewResult, findDeezerPreview, searchDeezerPreview } from "./deezer.js";
import { json, stubFetch } from "./testing/fetchStub.js";

const API = "https://api.deezer.com";
const clip = (id: number) =>
  `https://cdnt-preview.dzcdn.net/api/1/1/a/b/0/${id}.mp3?hdnea=exp=1761300000~acl=/api/1/*~hmac=abc`;

interface Entry {
  id: number;
  title: string;
  artist: string;
  duration?: number;
  album?: string;
  preview?: string;
  readable?: boolean;
  isrc?: string;
  alternative?: { id: number };
}

function entry({ id, title, artist, duration = 300, album = "Album", ...rest }: Entry) {
  return {
    id,
    title,
    duration,
    preview: clip(id),
    readable: true,
    artist: { id: id * 10, name: artist },
    album: { id: id * 100, title: album, cover_medium: "https://e-cdns-images.dzcdn.net/x.jpg" },
    ...rest,
  };
}

const NO_DATA = { error: { type: "DataException", message: "no data", code: 800 } };
const QUOTA = { error: { type: "Exception", message: "Quota limit exceeded", code: 4 } };

/** Stubs Deezer: the ISRC endpoint, tracks by id and the search answer. */
function deezer(routes: {
  isrc?: Record<string, unknown>;
  tracks?: Record<number, Record<string, unknown>>;
  search?: Array<Record<string, unknown>> | Record<string, unknown>;
}) {
  return stubFetch((call) => {
    const url = new URL(call.url);
    if (url.origin !== API) return undefined;
    if (url.pathname.startsWith("/track/isrc:")) return json(routes.isrc ?? NO_DATA);
    const byId = url.pathname.match(/^\/track\/(\d+)$/);
    if (byId) return json(routes.tracks?.[Number(byId[1])] ?? NO_DATA);
    if (url.pathname === "/search/track") {
      const search = routes.search ?? [];
      return json(Array.isArray(search) ? { data: search, total: search.length } : search);
    }
    return undefined;
  });
}

const BLINDING_LIGHTS = {
  title: "Blinding Lights",
  artist: "The Weeknd",
  isrc: "USUG11904206",
  durationMs: 200_040,
};

function matched(result: DeezerPreviewResult) {
  if (!result.found) throw new Error(`no preview: ${result.message}`);
  return result;
}

function rejections(result: DeezerPreviewResult) {
  if (result.found) throw new Error(`unexpected preview of ${result.match.deezerId}`);
  return result.rejected;
}

describe("Deezer preview of one recording", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("by ISRC", () => {
    it("uses the ISRC entry's preview and makes no other request", async () => {
      const net = deezer({
        isrc: entry({
          id: 1,
          title: "Blinding Lights",
          artist: "The Weeknd",
          isrc: "USUG11904206",
        }),
      });

      const result = matched(await findDeezerPreview(BLINDING_LIGHTS));

      expect(result.previewUrl).toBe(clip(1));
      expect(result.match).toEqual({
        provider: "deezer",
        method: "isrc",
        deezerId: 1,
        score: null,
      });
      expect(net.calls.map((call) => call.url)).toEqual([`${API}/track/isrc:USUG11904206`]);
    });

    it("reads the readable alternative by id when the ISRC entry is not readable", async () => {
      const net = deezer({
        isrc: entry({
          id: 177476,
          title: "Blinding Lights",
          artist: "The Weeknd",
          isrc: "USUG11904206",
          readable: false,
          preview: "",
          alternative: { id: 1178682 },
        }),
        tracks: {
          1178682: entry({
            id: 1178682,
            title: "Blinding Lights",
            artist: "The Weeknd",
            isrc: "USUG11904206",
          }),
        },
      });

      const result = matched(await findDeezerPreview(BLINDING_LIGHTS));

      expect(result.match).toEqual({
        provider: "deezer",
        method: "id",
        deezerId: 1178682,
        score: null,
      });
      expect(result.previewUrl).toBe(clip(1178682));
      expect(net.calls.map((call) => call.url)).toEqual([
        `${API}/track/isrc:USUG11904206`,
        `${API}/track/1178682`,
      ]);
    });

    it("uses an alternative with another ISRC only when it strictly matches", async () => {
      const isrcEntry = entry({
        id: 5,
        title: "Blinding Lights",
        artist: "The Weeknd",
        isrc: "USUG11904206",
        readable: false,
        alternative: { id: 6 },
      });
      const alternative = (title: string) =>
        entry({ id: 6, title, artist: "The Weeknd", duration: 200, isrc: "XX0000000001" });

      deezer({ isrc: isrcEntry, tracks: { 6: alternative("Blinding Lights") } });
      const same = matched(await findDeezerPreview(BLINDING_LIGHTS));
      expect(same.match).toEqual({ provider: "deezer", method: "id", deezerId: 6, score: 0.99 });

      deezer({
        isrc: isrcEntry,
        tracks: { 6: alternative("Blinding Lights (Chromatics Remix)") },
        search: [],
      });
      const remix = await findDeezerPreview(BLINDING_LIGHTS);
      expect(rejections(remix)).toEqual([
        { deezerId: 5, method: "isrc", reason: "not_readable" },
        { deezerId: 6, method: "id", reason: "other_version" },
      ]);
    });

    it("falls back to a strict search when the ISRC entry has no preview", async () => {
      const net = deezer({
        isrc: entry({
          id: 7,
          title: "Blinding Lights",
          artist: "The Weeknd",
          isrc: "USUG11904206",
          preview: "",
        }),
        search: [entry({ id: 8, title: "Blinding Lights", artist: "The Weeknd", duration: 200 })],
      });

      const result = matched(await findDeezerPreview(BLINDING_LIGHTS));

      expect(result.match).toEqual({
        provider: "deezer",
        method: "search",
        deezerId: 8,
        score: 0.99,
      });
      expect(net.calls.at(-1)?.url).toMatch(/^https:\/\/api\.deezer\.com\/search\/track\?/);
    });

    it("does not trust an ISRC entry that carries another ISRC", async () => {
      deezer({
        isrc: entry({
          id: 9,
          title: "Blinding Lights",
          artist: "The Weeknd",
          isrc: "GBAAA0000001",
        }),
        search: [],
      });

      const result = await findDeezerPreview(BLINDING_LIGHTS);

      expect(rejections(result)).toEqual([{ deezerId: 9, method: "isrc", reason: "isrc_differs" }]);
    });
  });

  describe("errors in a 200 answer", () => {
    it("reads code 800 (no data) as a miss and goes on to the search", async () => {
      const net = deezer({
        isrc: NO_DATA,
        search: [entry({ id: 10, title: "Blinding Lights", artist: "The Weeknd", duration: 200 })],
      });

      const result = matched(await findDeezerPreview(BLINDING_LIGHTS));

      expect(result.match.method).toBe("search");
      expect(net.calls).toHaveLength(2);
    });

    it("reports code 4 (quota) as an error and stops", async () => {
      const net = deezer({ isrc: QUOTA });

      const result = await findDeezerPreview(BLINDING_LIGHTS);

      expect(result).toMatchObject({ found: false, previewUrl: null });
      expect(result.found === false && result.error).toContain("Quota limit exceeded");
      expect(net.calls).toHaveLength(1);
    });

    it("reports a quota error from the search as an error, not as no track", async () => {
      deezer({ search: QUOTA });

      const data = JSON.parse(
        await searchDeezerPreview.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
      );

      expect(data).toMatchObject({ found: false, previewUrl: null });
      expect(data.error).toContain("Quota limit exceeded");
    });
  });

  describe("strict search", () => {
    const BOHEMIAN = {
      title: "Bohemian Rhapsody - Remastered 2011",
      artist: "Queen",
      album: "A Night At The Opera (2011 Remaster)",
      durationMs: 354_320,
    };
    const HURT = { title: "Hurt", artist: "Johnny Cash", durationMs: 218_000 };

    it.each([
      ["a live take", "Bohemian Rhapsody (Live Aid 1985)", "Queen", "Album", "other_version"],
      ["a live album", "Bohemian Rhapsody", "Queen", "Live at Wembley '86", "other_version"],
      ["a remix", "Bohemian Rhapsody (Kaskade Remix)", "Queen", "Album", "other_version"],
      [
        "a karaoke version",
        "Bohemian Rhapsody (Karaoke Version)",
        "Queen",
        "Album",
        "other_version",
      ],
      ["a cover", "Bohemian Rhapsody", "Panic! At The Disco", "Album", "artist_differs"],
      ["a tribute band", "Bohemian Rhapsody", "Queen Tribute Band", "Album", "artist_differs"],
      ["another song by the artist", "Killer Queen", "Queen", "Album", "title_differs"],
      ["a longer title", "Bohemian Rhapsody Pt. 2", "Queen", "Album", "title_differs"],
    ])("turns down %s", async (_label, title, artist, album, reason) => {
      deezer({ search: [entry({ id: 20, title, artist, album, duration: 354 })] });

      const result = await findDeezerPreview(BOHEMIAN);

      expect(result).toMatchObject({ found: false, previewUrl: null });
      expect(rejections(result)).toEqual([{ deezerId: 20, method: "search", reason }]);
    });

    it("picks the original over a live take and a remix listed first", async () => {
      deezer({
        search: [
          entry({
            id: 21,
            title: "Bohemian Rhapsody (Live Aid 1985)",
            artist: "Queen",
            duration: 354,
          }),
          entry({
            id: 22,
            title: "Bohemian Rhapsody (Kaskade Remix)",
            artist: "Queen",
            duration: 354,
          }),
          entry({
            id: 23,
            title: "Bohemian Rhapsody (Remastered 2011)",
            artist: "Queen",
            duration: 354,
          }),
        ],
      });

      const result = matched(await findDeezerPreview(BOHEMIAN));

      expect(result.match.deezerId).toBe(23);
    });

    it("never takes another recording's preview: a cover-only answer gives no preview", async () => {
      deezer({
        search: [
          entry({ id: 30, title: "Hurt", artist: "Nine Inch Nails", duration: 218 }),
          entry({ id: 31, title: "Hurt (Karaoke Version)", artist: "Karaoke Hits", duration: 218 }),
        ],
      });

      const result = await findDeezerPreview(HURT);

      expect(result).toMatchObject({ found: false, previewUrl: null });
      expect(rejections(result).map((r) => r.reason)).toEqual(["artist_differs", "artist_differs"]);
    });

    it("uses the requested version when the requested track is one", async () => {
      deezer({
        search: [
          entry({ id: 40, title: "Bohemian Rhapsody", artist: "Queen", duration: 355 }),
          entry({
            id: 41,
            title: "Bohemian Rhapsody (Live Aid 1985)",
            artist: "Queen",
            duration: 355,
          }),
        ],
      });

      const result = matched(
        await findDeezerPreview({
          title: "Bohemian Rhapsody - Live Aid 1985",
          artist: "Queen",
          durationMs: 355_000,
        }),
      );

      expect(result.match.deezerId).toBe(41);
    });

    it("matches a Japanese title and turns down an unrelated song", async () => {
      deezer({
        search: [
          entry({ id: 50, title: "Unrelated Song", artist: "Other Artist", duration: 261 }),
          entry({ id: 51, title: "夜に駆ける", artist: "YOASOBI", duration: 261 }),
        ],
      });

      const result = matched(
        await findDeezerPreview({ title: "夜に駆ける", artist: "YOASOBI", durationMs: 261_000 }),
      );

      expect(result.match).toEqual({
        provider: "deezer",
        method: "search",
        deezerId: 51,
        score: 1,
      });
    });

    it("gives no preview for a Japanese title when only an unrelated song has one", async () => {
      deezer({
        search: [
          entry({ id: 52, title: "Unrelated Song", artist: "Other Artist", duration: 261 }),
          entry({ id: 53, title: "夜に駆ける", artist: "YOASOBI", duration: 261, preview: "" }),
        ],
      });

      const result = await findDeezerPreview({
        title: "夜に駆ける",
        artist: "YOASOBI",
        durationMs: 261_000,
      });

      expect(rejections(result)).toEqual([
        { deezerId: 52, method: "search", reason: "artist_differs" },
        { deezerId: 53, method: "search", reason: "no_preview" },
      ]);
    });

    it.each([
      ["3 s longer", 221, true],
      ["3 s shorter", 215, true],
      ["4 s longer", 222, false],
      ["4 s shorter", 214, false],
    ])("takes a duration %s: %s", async (_label, seconds, accepted) => {
      deezer({
        search: [entry({ id: 60, title: "Hurt", artist: "Johnny Cash", duration: seconds })],
      });

      const result = await findDeezerPreview(HURT);

      expect(result.found).toBe(accepted);
      if (!result.found) {
        expect(result.rejected).toEqual([
          { deezerId: 60, method: "search", reason: "duration_differs" },
        ]);
      }
    });

    it("turns down a match when the requested duration is unknown", async () => {
      deezer({ search: [entry({ id: 61, title: "Hurt", artist: "Johnny Cash", duration: 218 })] });

      const result = await findDeezerPreview({ ...HURT, durationMs: 0 });

      expect(rejections(result)[0]?.reason).toBe("duration_unknown");
    });

    it("turns down an entry that is not readable", async () => {
      deezer({
        search: [
          entry({ id: 62, title: "Hurt", artist: "Johnny Cash", duration: 218, readable: false }),
        ],
      });

      const result = await findDeezerPreview(HURT);

      expect(rejections(result)[0]?.reason).toBe("not_readable");
    });

    it("matches spellings that differ only in accents, case and credits", async () => {
      deezer({ search: [entry({ id: 63, title: "DÉJÀ VU", artist: "beyonce", duration: 240 })] });

      const result = matched(
        await findDeezerPreview({
          title: "Déjà Vu (feat. Jay-Z)",
          artist: "Beyoncé, JAY-Z",
          artistNames: ["Beyoncé", "JAY-Z"],
          durationMs: 240_400,
        }),
      );

      expect(result.match.deezerId).toBe(63);
    });
  });

  describe("signed preview URLs", () => {
    it("never logs a preview URL", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      deezer({
        isrc: entry({ id: 70, title: "Blinding Lights", artist: "The Weeknd", preview: "" }),
        search: [entry({ id: 71, title: "Blinding Lights", artist: "The Weeknd", duration: 200 })],
      });

      matched(await findDeezerPreview(BLINDING_LIGHTS));

      const logged = (["log", "warn", "error"] as const)
        .flatMap((method) => vi.mocked(console[method]).mock.calls.flat())
        .map((arg) => String(arg))
        .join("\n");
      expect(logged).toContain("Blinding Lights");
      expect(logged).not.toContain("dzcdn.net");
      expect(logged).not.toContain("hdnea");
    });

    it("records the lookups without the preview", async () => {
      const dir = mkdtempSync(join(tmpdir(), "deezer-cassette-"));
      process.env.SOURCE_CASSETTE = "record";
      process.env.SOURCE_CASSETTE_DIR = dir;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      deezer({
        isrc: entry({
          id: 72,
          title: "Blinding Lights",
          artist: "The Weeknd",
          preview: "",
          isrc: "USUG11904206",
        }),
        search: [entry({ id: 73, title: "Blinding Lights", artist: "The Weeknd", duration: 200 })],
      });
      try {
        matched(await findDeezerPreview(BLINDING_LIGHTS));

        const recorded = readdirSync(dir)
          .map((file) => readFileSync(join(dir, file), "utf8"))
          .join("\n");
        expect(recorded).toContain("USUG11904206");
        expect(recorded).toContain("Blinding Lights");
        expect(recorded).not.toContain("dzcdn.net");
        expect(recorded).not.toContain("hdnea");
      } finally {
        delete process.env.SOURCE_CASSETTE;
        delete process.env.SOURCE_CASSETTE_DIR;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
