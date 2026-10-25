/**
 * Deezer previews with a stubbed API. A preview is used only for the requested recording: the
 * entry for its ISRC when it agrees with the track, that entry's readable alternative, or a
 * search result that strictly matches it. Missing is always better than another recording's
 * clip. Deezer reports errors (its quota included) inside an HTTP 200 answer: "no data" (800)
 * is a miss, the quota (4) an error.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CapturedLogs, captureLogsForTests } from "../logger.js";
import {
  type DeezerPreviewResult,
  findDeezerPreview,
  type PreviewRequest,
  searchDeezerPreview,
} from "./deezer.js";
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
  title_version?: string;
}

function entry({ id, title, artist, duration = 200, album = "After Hours", ...rest }: Entry) {
  return {
    id,
    title,
    duration,
    preview: clip(id),
    readable: true,
    bpm: 171.1,
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

const ISRC = "USUG11904206";
const BLINDING_LIGHTS: PreviewRequest = {
  title: "Blinding Lights",
  artist: "The Weeknd",
  artistNames: ["The Weeknd"],
  album: "After Hours",
  isrc: ISRC,
  durationMs: 200_040,
};
const weeknd = (id: number, title: string, rest: Partial<Entry> = {}) =>
  entry({ id, title, artist: "The Weeknd", ...rest });

function matched(result: DeezerPreviewResult) {
  if (!result.found) throw new Error(`no preview: ${result.message}`);
  return result;
}

function rejections(result: DeezerPreviewResult) {
  if (result.found) throw new Error(`unexpected preview of ${result.match.deezerId}`);
  return result.rejected;
}

/** The search's answer is all Deezer has: the request has no ISRC. */
async function searchOnly(request: PreviewRequest, ...entries: Array<Record<string, unknown>>) {
  deezer({ search: entries });
  return findDeezerPreview({ ...request, isrc: null });
}

const GIANT_STEPS: PreviewRequest = {
  title: "Giant Steps",
  artist: "John Coltrane",
  album: "Giant Steps",
  durationMs: 286_000,
};
const ROCK_THE_BOAT: PreviewRequest = {
  title: "Rock the Boat",
  artist: "The Hues Corporation",
  album: "Freedom for the Stallion",
  durationMs: 205_000,
};
const LET_IT_GO: PreviewRequest = {
  title: "Let It Go",
  artist: "Idina Menzel",
  album: "Frozen",
  durationMs: 224_000,
};

// Every test's log lines, for the tests that check what is logged.
let logs: CapturedLogs;
beforeEach(() => {
  logs = captureLogsForTests();
});
afterEach(() => logs.restore());

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
      const net = deezer({ isrc: weeknd(1, "Blinding Lights", { isrc: ISRC }) });

      const result = matched(await findDeezerPreview(BLINDING_LIGHTS));

      expect(result.previewUrl).toBe(clip(1));
      expect(result.match).toEqual({
        provider: "deezer",
        method: "isrc",
        deezerId: 1,
        score: null,
      });
      expect(net.calls.map((call) => call.url)).toEqual([`${API}/track/isrc:${ISRC}`]);
    });

    it("takes an ISRC entry from another album or in another script", async () => {
      deezer({
        isrc: weeknd(2, "ブラインディング・ライツ", { isrc: ISRC, album: "The Highlights" }),
      });

      const result = matched(await findDeezerPreview(BLINDING_LIGHTS));

      expect(result.match).toMatchObject({ method: "isrc", deezerId: 2 });
    });

    it.each([
      [
        "a karaoke compilation that reuses the ISRC",
        entry({
          id: 3,
          title: "Blinding Lights (Karaoke Version)",
          artist: "Ameritz Karaoke",
          album: "Karaoke Hits 2020",
          duration: 215,
          isrc: ISRC,
        }),
        "artist_differs",
      ],
      [
        "a karaoke version credited to the artist",
        weeknd(4, "Blinding Lights (Karaoke Version)", { isrc: ISRC }),
        "other_version",
      ],
      [
        "an entry 40 s longer",
        weeknd(5, "Blinding Lights", { isrc: ISRC, duration: 240 }),
        "duration_differs",
      ],
      [
        "an entry on a re-recorded album",
        weeknd(6, "Blinding Lights", { isrc: ISRC, album: "Greatest Hits (Re-Recorded)" }),
        "other_version",
      ],
    ])("turns down an ISRC entry that is %s", async (_label, isrcEntry, reason) => {
      deezer({ isrc: isrcEntry, search: [] });

      const result = await findDeezerPreview(BLINDING_LIGHTS);

      expect(rejections(result)).toEqual([{ deezerId: isrcEntry.id, method: "isrc", reason }]);
    });

    it("checks an ISRC entry without an isrc field like any other entry", async () => {
      deezer({ isrc: weeknd(7, "Save Your Tears", { duration: 215 }), search: [] });
      expect(rejections(await findDeezerPreview(BLINDING_LIGHTS))).toEqual([
        { deezerId: 7, method: "isrc", reason: "title_differs" },
      ]);

      deezer({ isrc: weeknd(8, "Blinding Lights") });
      const same = matched(await findDeezerPreview(BLINDING_LIGHTS));
      expect(same.match).toEqual({ provider: "deezer", method: "id", deezerId: 8, score: 0.99 });
    });

    it("reads the readable alternative by id when the ISRC entry is not readable", async () => {
      const net = deezer({
        isrc: weeknd(177476, "Blinding Lights", {
          isrc: ISRC,
          readable: false,
          preview: "",
          alternative: { id: 1178682 },
        }),
        tracks: { 1178682: weeknd(1178682, "Blinding Lights", { isrc: ISRC }) },
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
        `${API}/track/isrc:${ISRC}`,
        `${API}/track/1178682`,
      ]);
    });

    it("turns down an alternative with the same ISRC that is 40 s longer", async () => {
      deezer({
        isrc: weeknd(9, "Blinding Lights", {
          isrc: ISRC,
          readable: false,
          alternative: { id: 10 },
        }),
        tracks: { 10: weeknd(10, "Blinding Lights", { isrc: ISRC, duration: 240 }) },
        search: [],
      });

      const result = await findDeezerPreview(BLINDING_LIGHTS);

      expect(rejections(result)).toEqual([
        { deezerId: 9, method: "isrc", reason: "not_readable" },
        { deezerId: 10, method: "id", reason: "duration_differs" },
      ]);
    });

    it("uses an alternative with another ISRC only when it strictly matches", async () => {
      const isrcEntry = weeknd(11, "Blinding Lights", {
        isrc: ISRC,
        readable: false,
        alternative: { id: 12 },
      });
      const alternative = (title: string, album = "After Hours") =>
        weeknd(12, title, { album, isrc: "XX0000000001" });

      deezer({ isrc: isrcEntry, tracks: { 12: alternative("Blinding Lights") } });
      const same = matched(await findDeezerPreview(BLINDING_LIGHTS));
      expect(same.match).toEqual({ provider: "deezer", method: "id", deezerId: 12, score: 0.99 });

      for (const [title, album, reason] of [
        ["Blinding Lights (Chromatics Remix)", "After Hours", "other_version"],
        ["Blinding Lights (Extended Mix)", "After Hours", "other_version"],
        ["Blinding Lights", "The Highlights", "album_differs"],
      ]) {
        deezer({ isrc: isrcEntry, tracks: { 12: alternative(title, album) }, search: [] });
        expect(rejections(await findDeezerPreview(BLINDING_LIGHTS))).toEqual([
          { deezerId: 11, method: "isrc", reason: "not_readable" },
          { deezerId: 12, method: "id", reason },
        ]);
      }
    });

    it("does not read the alternative of an entry that is another recording", async () => {
      const net = deezer({
        isrc: entry({
          id: 13,
          title: "Blinding Lights",
          artist: "Ameritz Karaoke",
          isrc: ISRC,
          readable: false,
          alternative: { id: 14 },
        }),
        search: [],
      });

      await findDeezerPreview(BLINDING_LIGHTS);

      expect(net.calls.some((call) => call.url === `${API}/track/14`)).toBe(false);
    });

    it("falls back to a strict search when the ISRC entry has no preview", async () => {
      const net = deezer({
        isrc: weeknd(15, "Blinding Lights", { isrc: ISRC, preview: "" }),
        search: [weeknd(16, "Blinding Lights")],
      });

      const result = matched(await findDeezerPreview(BLINDING_LIGHTS));

      expect(result.match).toEqual({
        provider: "deezer",
        method: "search",
        deezerId: 16,
        score: 0.99,
      });
      expect(net.calls.at(-1)?.url).toMatch(/^https:\/\/api\.deezer\.com\/search\/track\?/);
    });

    it("does not trust an ISRC entry that carries another ISRC", async () => {
      deezer({ isrc: weeknd(17, "Blinding Lights", { isrc: "GBAAA0000001" }), search: [] });

      expect(rejections(await findDeezerPreview(BLINDING_LIGHTS))).toEqual([
        { deezerId: 17, method: "isrc", reason: "isrc_differs" },
      ]);
    });

    it("never takes in the search an entry the ISRC step turned down", async () => {
      deezer({
        isrc: weeknd(22, "Blinding Lights", { isrc: "USUG99999999" }),
        search: [weeknd(22, "Blinding Lights")],
      });

      expect(rejections(await findDeezerPreview(BLINDING_LIGHTS))).toEqual([
        { deezerId: 22, method: "isrc", reason: "isrc_differs" },
        { deezerId: 22, method: "search", reason: "turned_down_by_isrc" },
      ]);
    });

    it("takes a search entry that carries the requested ISRC from another album", async () => {
      deezer({
        isrc: weeknd(23, "Blinding Lights", { isrc: ISRC, readable: false }),
        search: [
          weeknd(24, "Blinding Lights", { isrc: "USXX12345678", album: "The Highlights" }),
          weeknd(25, "Blinding Lights", { isrc: ISRC, album: "Blinding Lights" }),
        ],
      });

      const result = matched(await findDeezerPreview(BLINDING_LIGHTS));

      expect(result.match).toEqual({
        provider: "deezer",
        method: "isrc",
        deezerId: 25,
        score: null,
      });
    });

    it("prefers a search entry with the requested ISRC to one that only matches strictly", async () => {
      deezer({
        search: [
          weeknd(26, "Blinding Lights", { isrc: "GBUM71029604" }),
          weeknd(27, "Blinding Lights", { isrc: ISRC, album: "The Highlights", duration: 201 }),
        ],
      });

      expect(matched(await findDeezerPreview(BLINDING_LIGHTS)).match.deezerId).toBe(27);
    });

    it("takes a strictly matching search entry that carries another ISRC (a remaster)", async () => {
      deezer({
        isrc: weeknd(28, "Blinding Lights", { isrc: ISRC, readable: false }),
        search: [weeknd(29, "Blinding Lights", { isrc: "GBUM71029604" })],
      });

      const result = matched(await findDeezerPreview(BLINDING_LIGHTS));

      expect(result.match).toEqual({
        provider: "deezer",
        method: "search",
        deezerId: 29,
        score: 0.99,
      });
    });

    it.each([
      ["on another album", { album: "The Highlights" }, "album_differs"],
      ["4 s longer", { duration: 204 }, "duration_differs"],
      ["by another artist", { artist: "Ameritz Karaoke" }, "artist_differs"],
    ])("turns down a search entry with another ISRC %s", async (_label, change, reason) => {
      const other = { ...weeknd(30, "Blinding Lights", { isrc: "GBUM71029604" }), ...change };
      if ("artist" in change) other.artist = { id: 300, name: change.artist as string };
      deezer({ search: [other] });

      expect(rejections(await findDeezerPreview(BLINDING_LIGHTS))).toEqual([
        { deezerId: 30, method: "search", reason },
      ]);
    });

    it.each([
      ["the ISRC entry", "isrc", 31],
      ["a search entry", "search", 32],
    ])(
      "turns down another song of the artist that %s carries the ISRC of",
      async (_l, method, id) => {
        for (const title of ["Save Your Tears", "Starboy"]) {
          const wrong = weeknd(id, title, { isrc: ISRC });
          deezer(method === "isrc" ? { isrc: wrong, search: [] } : { search: [wrong] });
          expect(rejections(await findDeezerPreview(BLINDING_LIGHTS))).toEqual([
            { deezerId: id, method, reason: "title_differs" },
          ]);
        }
      },
    );

    it("turns down a same-ISRC alternative that is another song", async () => {
      deezer({
        isrc: weeknd(33, "Blinding Lights", {
          isrc: ISRC,
          readable: false,
          alternative: { id: 34 },
        }),
        tracks: {
          34: weeknd(34, "In Your Eyes", { isrc: ISRC, album: "The Highlights", duration: 201 }),
        },
        search: [],
      });

      expect(rejections(await findDeezerPreview(BLINDING_LIGHTS))).toEqual([
        { deezerId: 33, method: "isrc", reason: "not_readable" },
        { deezerId: 34, method: "id", reason: "title_differs" },
      ]);
    });

    describe("titles that name another work in quotes", () => {
      const SCHINDLER: PreviewRequest = {
        title: 'Theme From "Schindler\'s List"',
        artist: "John Williams",
        album: "Greatest Hits 1969-1999",
        isrc: "USSM19900001",
        durationMs: 255_000,
      };
      const williams = (id: number, title: string, rest: Partial<Entry> = {}) =>
        entry({
          id,
          title,
          artist: "John Williams",
          album: SCHINDLER.album,
          duration: 257,
          ...rest,
        });
      const JURASSIC = 'Theme From "Jurassic Park"';

      it("gives no preview from the search for another theme on the album", async () => {
        deezer({
          isrc: williams(1, SCHINDLER.title, { isrc: "USSM19900001", readable: false }),
          search: [williams(1, SCHINDLER.title), williams(2, JURASSIC, { isrc: "USSM19900002" })],
        });

        expect(rejections(await findDeezerPreview(SCHINDLER))).toEqual([
          { deezerId: 1, method: "isrc", reason: "not_readable" },
          { deezerId: 1, method: "search", reason: "turned_down_by_isrc" },
          { deezerId: 2, method: "search", reason: "title_differs" },
        ]);
      });

      it("gives no preview from an alternative that is another theme", async () => {
        deezer({
          isrc: williams(3, SCHINDLER.title, {
            isrc: "USSM19900001",
            readable: false,
            alternative: { id: 4 },
          }),
          tracks: { 4: williams(4, JURASSIC, { isrc: "USSM19900002" }) },
          search: [],
        });

        expect(rejections(await findDeezerPreview(SCHINDLER))).toContainEqual({
          deezerId: 4,
          method: "id",
          reason: "title_differs",
        });
      });

      it("gives no preview from an ISRC entry that is another theme", async () => {
        deezer({ isrc: williams(5, JURASSIC, { isrc: "USSM19900001" }), search: [] });

        expect(rejections(await findDeezerPreview(SCHINDLER))).toEqual([
          { deezerId: 5, method: "isrc", reason: "title_differs" },
        ]);
      });

      it("still matches a title whose quoted work follows the title proper", async () => {
        const result = await searchOnly(
          LET_IT_GO,
          entry({
            id: 6,
            title: 'Let It Go - From "Frozen"',
            artist: "Idina Menzel",
            album: "Frozen",
            duration: 224,
          }),
        );

        expect(matched(result).match.deezerId).toBe(6);
      });
    });

    describe("ISRC entries of another part, movement or number", () => {
      const PIGS: PreviewRequest = {
        title: "Pigs on the Wing (Part One)",
        artist: "Pink Floyd",
        album: "Animals",
        isrc: "GBN9Y1100088",
        durationMs: 85_000,
      };
      const floyd = (id: number, title: string) =>
        entry({
          id,
          title,
          artist: "Pink Floyd",
          album: "Animals",
          duration: 83,
          isrc: PIGS.isrc ?? "",
        });

      it.each([
        ["the ISRC entry", "isrc"],
        ["a search entry", "search"],
      ])("turns down another part that %s carries the ISRC of", async (_label, method) => {
        const wrong = floyd(7, "Pigs on the Wing (Part Two)");
        deezer(method === "isrc" ? { isrc: wrong, search: [] } : { search: [wrong] });

        expect(rejections(await findDeezerPreview(PIGS))).toEqual([
          { deezerId: 7, method, reason: "title_differs" },
        ]);
      });

      it("takes the same part that carries the ISRC", async () => {
        deezer({ isrc: floyd(8, "Pigs on the Wing (Part One)") });

        expect(matched(await findDeezerPreview(PIGS)).match.method).toBe("isrc");
      });

      it("turns down another movement that carries the ISRC", async () => {
        const symphony = "Symphony No. 7 in A Major, Op. 92";
        deezer({
          isrc: entry({
            id: 9,
            title: `${symphony} - III. Presto`,
            artist: "Carlos Kleiber",
            album: "Beethoven: Symphonies Nos. 5 & 7",
            duration: 480,
            isrc: "DEF057700001",
          }),
          search: [],
        });

        const result = await findDeezerPreview({
          title: `${symphony} - II. Allegretto`,
          artist: "Carlos Kleiber",
          album: "Beethoven: Symphonies Nos. 5 & 7",
          isrc: "DEF057700001",
          durationMs: 481_000,
        });

        expect(rejections(result)).toEqual([
          { deezerId: 9, method: "isrc", reason: "title_differs" },
        ]);
      });

      it.each([
        ["505", "Arctic Monkeys", "Do Me a Favour", 253],
        ["1999", "Prince", "Little Red Corvette", 304],
      ])("compares a title of digits only: %s", async (title, artist, other, seconds) => {
        const isrc = "USXX19990001";
        deezer({
          isrc: entry({ id: 10, title: other, artist, album: "Album", duration: seconds, isrc }),
          search: [],
        });

        const result = await findDeezerPreview({
          title,
          artist,
          album: "Album",
          isrc,
          durationMs: seconds * 1000,
        });

        expect(rejections(result)).toEqual([
          { deezerId: 10, method: "isrc", reason: "title_differs" },
        ]);
      });

      it("takes an ISRC entry with an alternative title on one side only", async () => {
        deezer({
          isrc: entry({
            id: 11,
            title: "Gangnam Style (강남스타일)",
            artist: "PSY",
            album: "PSY 6甲",
            duration: 219,
            isrc: "KRA381200001",
          }),
        });

        const result = await findDeezerPreview({
          title: "Gangnam Style",
          artist: "PSY",
          album: "PSY 6甲",
          isrc: "KRA381200001",
          durationMs: 219_000,
        });

        expect(matched(result).match.method).toBe("isrc");
      });
    });

    it("takes an ISRC entry whose title is in another script", async () => {
      deezer({
        isrc: entry({
          id: 35,
          title: "Yoru ni Kakeru",
          artist: "YOASOBI",
          duration: 261,
          isrc: "JPP302000001",
        }),
      });

      const result = await findDeezerPreview({
        title: "夜に駆ける",
        artist: "YOASOBI",
        album: "夜に駆ける",
        isrc: "JPP302000001",
        durationMs: 261_000,
      });

      expect(matched(result).match).toMatchObject({ method: "isrc", deezerId: 35 });
    });
  });

  describe("errors in a 200 answer", () => {
    it("reads code 800 (no data) as a miss and goes on to the search", async () => {
      const net = deezer({ isrc: NO_DATA, search: [weeknd(24, "Blinding Lights")] });

      const result = matched(await findDeezerPreview(BLINDING_LIGHTS));

      expect(result.match.method).toBe("search");
      expect(net.calls).toHaveLength(2);
    });

    it("reports code 4 (quota) as an error and stops", async () => {
      const net = deezer({ isrc: QUOTA });

      const result = await findDeezerPreview(BLINDING_LIGHTS);

      expect(result).toMatchObject({ found: false, previewUrl: null, errorCode: "rate_limited" });
      expect(result.found === false && result.error).toContain("Quota limit exceeded");
      expect(net.calls).toHaveLength(1);
    });

    it("reports a quota error from the search as an error, not as no track", async () => {
      deezer({ search: QUOTA });

      const data = JSON.parse(
        await searchDeezerPreview.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
      );

      expect(data).toMatchObject({ found: false, previewUrl: null, errorCode: "rate_limited" });
      expect(data.error).toContain("Quota limit exceeded");
    });
  });

  describe("strict search", () => {
    const NIGHT = "A Night At The Opera (Deluxe Remastered Version)";
    const BOHEMIAN: PreviewRequest = {
      title: "Bohemian Rhapsody - Remastered 2011",
      artist: "Queen",
      album: "A Night At The Opera (2011 Remaster)",
      durationMs: 354_320,
    };
    const HURT: PreviewRequest = {
      title: "Hurt",
      artist: "Johnny Cash",
      album: "American IV: The Man Comes Around",
      durationMs: 218_000,
    };
    const queen = (id: number, title: string, album = NIGHT) =>
      entry({ id, title, artist: "Queen", album, duration: 354 });

    it.each([
      ["a live take", "Bohemian Rhapsody (Live Aid 1985)", "Queen", NIGHT, "other_version"],
      ["a live album", "Bohemian Rhapsody", "Queen", "Live at Wembley '86", "other_version"],
      ["a remix", "Bohemian Rhapsody (Kaskade Remix)", "Queen", NIGHT, "other_version"],
      ["a karaoke version", "Bohemian Rhapsody (Karaoke Version)", "Queen", NIGHT, "other_version"],
      ["a cover", "Bohemian Rhapsody", "Panic! At The Disco", NIGHT, "artist_differs"],
      ["a tribute band", "Bohemian Rhapsody", "Queen Tribute Band", NIGHT, "artist_differs"],
      ["another song by the artist", "Killer Queen", "Queen", NIGHT, "title_differs"],
      ["a longer title", "Bohemian Rhapsody Pt. 2", "Queen", NIGHT, "title_differs"],
      ["another album", "Bohemian Rhapsody", "Queen", "Greatest Hits", "album_differs"],
    ])("turns down %s", async (_label, title, artist, album, reason) => {
      const result = await searchOnly(
        BOHEMIAN,
        entry({ id: 20, title, artist, album, duration: 354 }),
      );

      expect(result).toMatchObject({ found: false, previewUrl: null });
      expect(rejections(result)).toEqual([{ deezerId: 20, method: "search", reason }]);
    });

    it("picks the original over a live take and a remix listed first", async () => {
      const result = matched(
        await searchOnly(
          BOHEMIAN,
          queen(21, "Bohemian Rhapsody (Live Aid 1985)"),
          queen(22, "Bohemian Rhapsody (Kaskade Remix)"),
          queen(23, "Bohemian Rhapsody (Remastered 2011)"),
        ),
      );

      expect(result.match.deezerId).toBe(23);
    });

    it("never takes another recording's preview: a cover-only answer gives no preview", async () => {
      const result = await searchOnly(
        HURT,
        entry({ id: 30, title: "Hurt", artist: "Nine Inch Nails", duration: 218 }),
        entry({ id: 31, title: "Hurt (Karaoke Version)", artist: "Karaoke Hits", duration: 218 }),
      );

      expect(result).toMatchObject({ found: false, previewUrl: null });
      expect(rejections(result).map((r) => r.reason)).toEqual(["artist_differs", "artist_differs"]);
    });

    it("uses the requested version when the requested track is one", async () => {
      const result = matched(
        await searchOnly(
          { ...BOHEMIAN, title: "Bohemian Rhapsody - Live Aid 1985", album: "Live Aid" },
          queen(40, "Bohemian Rhapsody", "Live Aid"),
          queen(41, "Bohemian Rhapsody (Live Aid 1985)", "Live Aid"),
        ),
      );

      expect(result.match.deezerId).toBe(41);
    });

    it("matches a Japanese title and turns down an unrelated song", async () => {
      const yoasobi = {
        title: "夜に駆ける",
        artist: "YOASOBI",
        album: "夜に駆ける",
        durationMs: 261_000,
      };
      const result = matched(
        await searchOnly(
          yoasobi,
          entry({ id: 50, title: "Unrelated Song", artist: "Other Artist", duration: 261 }),
          entry({
            id: 51,
            title: "夜に駆ける",
            artist: "YOASOBI",
            album: "夜に駆ける",
            duration: 261,
          }),
        ),
      );

      expect(result.match).toEqual({
        provider: "deezer",
        method: "search",
        deezerId: 51,
        score: 1,
      });
    });

    it("gives no preview for a Japanese title when only an unrelated song has one", async () => {
      const yoasobi = {
        title: "夜に駆ける",
        artist: "YOASOBI",
        album: "夜に駆ける",
        durationMs: 261_000,
      };
      const result = await searchOnly(
        yoasobi,
        entry({ id: 52, title: "Unrelated Song", artist: "Other Artist", duration: 261 }),
        entry({
          id: 53,
          title: "夜に駆ける",
          artist: "YOASOBI",
          album: "夜に駆ける",
          duration: 261,
          preview: "",
        }),
      );

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
      const result = await searchOnly(
        HURT,
        entry({
          id: 60,
          title: "Hurt",
          artist: "Johnny Cash",
          album: HURT.album,
          duration: seconds,
        }),
      );

      expect(result.found).toBe(accepted);
      if (!result.found) {
        expect(result.rejected).toEqual([
          { deezerId: 60, method: "search", reason: "duration_differs" },
        ]);
      }
    });

    it("turns down a match when the requested duration or album is unknown", async () => {
      const hurt = entry({
        id: 61,
        title: "Hurt",
        artist: "Johnny Cash",
        album: HURT.album,
        duration: 218,
      });

      const noDuration = await searchOnly({ ...HURT, durationMs: 0 }, hurt);
      expect(rejections(noDuration)[0]?.reason).toBe("duration_unknown");
      const noAlbum = await searchOnly({ ...HURT, album: "" }, hurt);
      expect(rejections(noAlbum)[0]?.reason).toBe("album_unknown");
    });

    it("turns down an entry that is not readable", async () => {
      const result = await searchOnly(
        HURT,
        entry({
          id: 62,
          title: "Hurt",
          artist: "Johnny Cash",
          album: HURT.album,
          duration: 218,
          readable: false,
        }),
      );

      expect(rejections(result)[0]?.reason).toBe("not_readable");
    });

    it("matches spellings that differ only in accents, case, credits and edition labels", async () => {
      const result = matched(
        await searchOnly(
          {
            title: "Déjà Vu (feat. Jay-Z)",
            artist: "Beyoncé, JAY-Z",
            artistNames: ["Beyoncé", "JAY-Z"],
            album: "B'Day",
            durationMs: 240_400,
          },
          entry({
            id: 63,
            title: "DÉJÀ VU",
            artist: "beyonce",
            album: "B'Day (Deluxe Edition)",
            duration: 240,
          }),
        ),
      );

      expect(result.match.deezerId).toBe(63);
    });

    it("reads a version Deezer gives apart from the title", async () => {
      const result = await searchOnly(
        BLINDING_LIGHTS,
        weeknd(64, "Blinding Lights", { title_version: "(Live at SoFi)" }),
      );

      expect(rejections(result)[0]?.reason).toBe("other_version");
    });

    it.each([
      ["Alive", "(Live)"],
      ["Demons", "(Demo)"],
    ])(
      "reads a version given apart that is part of a word of the title: %s %s",
      async (title, version) => {
        const result = await searchOnly(
          { title, artist: "Artist", album: "Album", durationMs: 200_000 },
          entry({ id: 66, title, artist: "Artist", album: "Album", title_version: version }),
        );

        expect(rejections(result)[0]?.reason).toBe("other_version");
      },
    );

    it("takes only the lead artist's own entry, not a featured artist's", async () => {
      const result = await searchOnly(
        {
          title: "Stay",
          artist: "Rihanna, Mikky Ekko",
          artistNames: ["Rihanna", "Mikky Ekko"],
          album: "Unapologetic",
          durationMs: 240_000,
        },
        entry({
          id: 65,
          title: "Stay",
          artist: "Mikky Ekko",
          album: "Unapologetic",
          duration: 240,
        }),
      );

      expect(rejections(result)[0]?.reason).toBe("artist_differs");
    });

    // Each of these was taken as the requested recording before: other takes, re-recordings,
    // instrumental and sing-along versions, parts and reprises, and live albums whose name does
    // not say so. The title stays the same and the duration is within 3 s.
    it.each([
      ["an alternate take", GIANT_STEPS, "Giant Steps (Alternate Take)", "Giant Steps", 284],
      [
        "an alternate version",
        GIANT_STEPS,
        "Giant Steps (Alternate Version 1)",
        "Giant Steps",
        287,
      ],
      ["an outtake", GIANT_STEPS, "Giant Steps (Outtake)", "Giant Steps", 287],
      [
        "a numbered take",
        {
          title: "Strawberry Fields Forever - Remastered 2009",
          artist: "The Beatles",
          album: "Magical Mystery Tour",
          durationMs: 247_000,
        },
        "Strawberry Fields Forever (Take 7)",
        "Magical Mystery Tour",
        249,
      ],
      ["a re-recording", ROCK_THE_BOAT, "Rock the Boat (Re-Recorded)", ROCK_THE_BOAT.album, 206],
      [
        "a one-word re-recording",
        ROCK_THE_BOAT,
        "Rock the Boat (Rerecorded)",
        ROCK_THE_BOAT.album,
        206,
      ],
      ["a new recording", ROCK_THE_BOAT, "Rock the Boat (New Recording)", ROCK_THE_BOAT.album, 206],
      ["a dated version", ROCK_THE_BOAT, "Rock the Boat (2015 Version)", ROCK_THE_BOAT.album, 206],
      [
        "a re-recorded album",
        ROCK_THE_BOAT,
        "Rock the Boat",
        "Freedom for the Stallion (Re-Recorded Versions)",
        206,
      ],
      ["a karaoke album", ROCK_THE_BOAT, "Rock the Boat", "Karaoke: Freedom for the Stallion", 205],
      [
        "an instrumental from a film",
        LET_IT_GO,
        'Let It Go - From "Frozen" / Instrumental',
        "Frozen",
        224,
      ],
      [
        "a sing-along from a film",
        LET_IT_GO,
        'Let It Go (From "Frozen"/Sing-Along)',
        "Frozen",
        224,
      ],
      ["a demo from a film", LET_IT_GO, 'Let It Go (From "Frozen" Demo)', "Frozen", 224],
      ["a sing-along album", LET_IT_GO, "Let It Go", "Frozen (Sing-Along)", 224],
      [
        "part two for part one",
        {
          title: "Pigs on the Wing (Part One)",
          artist: "Pink Floyd",
          album: "Animals",
          durationMs: 85_000,
        },
        "Pigs on the Wing (Part Two)",
        "Animals",
        83,
      ],
      [
        "the song for its reprise",
        { title: "Song (Reprise)", artist: "Artist", album: "Album", durationMs: 180_000 },
        "Song",
        "Album",
        181,
      ],
      [
        "an interlude for the song",
        { title: "Song", artist: "Artist", album: "Album", durationMs: 100_000 },
        "Song (Interlude)",
        "Album",
        101,
      ],
      [
        "a live album without the word live",
        {
          title: "Hotel California - 2013 Remaster",
          artist: "Eagles",
          album: "Hotel California (2013 Remaster)",
          durationMs: 391_000,
        },
        "Hotel California",
        "Hell Freezes Over",
        392,
      ],
      [
        "a live album named Alive!",
        {
          title: "Rock and Roll All Nite",
          artist: "KISS",
          album: "Dressed to Kill",
          durationMs: 168_000,
        },
        "Rock and Roll All Nite",
        "Alive!",
        168,
      ],
      [
        "an orchestral re-recording credited with the orchestra",
        { title: "Song", artist: "Artist", album: "Album", durationMs: 200_000 },
        "Song (with The Royal Philharmonic Orchestra)",
        "Album (Deluxe Edition)",
        201,
      ],
      [
        "a version with strings",
        { title: "Song", artist: "Artist", album: "Album", durationMs: 200_000 },
        "Song - With Strings",
        "Album",
        201,
      ],
      [
        "an unquoted sing-along from a film",
        LET_IT_GO,
        "Let It Go - From Frozen Sing Along",
        "Frozen",
        224,
      ],
      [
        "a session named in a From part",
        { title: "Song", artist: "Artist", album: "Album", durationMs: 200_000 },
        "Song - From The Basement",
        "Album",
        201,
      ],
      [
        "an album re-recorded as a dated version",
        { title: "Song", artist: "Artist", album: "Album", durationMs: 200_000 },
        "Song",
        "Album (2023 Version)",
        200,
      ],
      [
        "an album re-recorded as the artist's version",
        { title: "Love Story", artist: "Taylor Swift", album: "Fearless", durationMs: 235_000 },
        "Love Story",
        "Fearless (Taylor's Version)",
        235,
      ],
      [
        "the same generic title on another album",
        { title: "Intro", artist: "The xx", album: "xx", durationMs: 127_000 },
        "Intro",
        "I See You",
        128,
      ],
    ])("gives no preview for %s", async (_label, request, title, album, duration) => {
      const result = await searchOnly(
        request,
        entry({ id: 70, title, artist: request.artist, album, duration }),
      );

      expect(result).toMatchObject({ found: false, previewUrl: null });
    });

    it.each([
      [
        "remaster labels and an edition",
        {
          title: "Here Comes The Sun - Remastered 2009",
          artist: "The Beatles",
          album: "Abbey Road (Remastered)",
          durationMs: 185_000,
        },
        "Here Comes The Sun (Remastered)",
        "Abbey Road (Super Deluxe Edition)",
      ],
      ["a soundtrack label", LET_IT_GO, 'Let It Go (From "Frozen"/Soundtrack Version)', "Frozen"],
      [
        "the same alternative title",
        {
          title: "Gangnam Style (강남스타일)",
          artist: "PSY",
          album: "PSY 6甲",
          durationMs: 219_000,
        },
        "Gangnam Style (강남스타일)",
        "PSY 6甲",
      ],
      [
        "a featured artist named in a with part",
        {
          title: "STAY (with Justin Bieber)",
          artist: "The Kid LAROI, Justin Bieber",
          artistNames: ["The Kid LAROI", "Justin Bieber"],
          album: "F*CK LOVE 3: OVER YOU",
          durationMs: 141_000,
        },
        "STAY",
        "F*CK LOVE 3: OVER YOU",
      ],
      [
        "a deluxe version of the album",
        { title: "Song", artist: "Artist", album: "Album", durationMs: 200_000 },
        "Song",
        "Album (Deluxe Version)",
      ],
    ])("still matches the same recording with %s", async (_label, request, title, album) => {
      const duration = (request.durationMs ?? 0) / 1000;
      const result = await searchOnly(
        request,
        entry({
          id: 71,
          title,
          artist: request.artistNames?.[0] ?? request.artist,
          album,
          duration,
        }),
      );

      expect(matched(result).match.deezerId).toBe(71);
    });
  });

  describe("what a result holds", () => {
    it("holds the clip and its match, never Deezer's bpm", async () => {
      deezer({ isrc: weeknd(80, "Blinding Lights", { isrc: ISRC }) });

      const result = matched(await findDeezerPreview(BLINDING_LIGHTS));

      expect(Object.keys(result).sort()).toEqual([
        "artist",
        "found",
        "match",
        "previewUrl",
        "title",
      ]);
      expect(Object.keys(result.match).sort()).toEqual(["deezerId", "method", "provider", "score"]);
    });
  });

  describe("signed preview URLs", () => {
    it("never logs a preview URL", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      deezer({
        isrc: weeknd(90, "Blinding Lights", { preview: "" }),
        search: [weeknd(91, "Blinding Lights")],
      });

      matched(await findDeezerPreview(BLINDING_LIGHTS));

      const logged = logs.lines().join("\n");
      expect(logged).toContain("Blinding Lights");
      expect(logged).not.toContain("dzcdn.net");
      expect(logged).not.toContain("hdnea");
      expect(logged).not.toContain("[preview link]");
    });

    it("records the lookups with the fields the match reads, without preview or bpm", async () => {
      const dir = mkdtempSync(join(tmpdir(), "deezer-cassette-"));
      process.env.SOURCE_CASSETTE = "record";
      process.env.SOURCE_CASSETTE_DIR = dir;
      vi.spyOn(console, "warn").mockImplementation(() => {});
      deezer({
        isrc: weeknd(92, "Blinding Lights", { preview: "", isrc: ISRC }),
        search: [weeknd(93, "Blinding Lights")],
      });
      try {
        matched(await findDeezerPreview(BLINDING_LIGHTS));

        const text = readdirSync(dir)
          .map((file) => readFileSync(join(dir, file), "utf8"))
          .join("\n");
        expect(text).toContain(ISRC);
        expect(text).toContain("Blinding Lights");
        expect(text).not.toContain("dzcdn.net");
        expect(text).not.toContain("hdnea");
        expect(text).not.toMatch(/"bpm"|"preview"/);
      } finally {
        delete process.env.SOURCE_CASSETTE;
        delete process.env.SOURCE_CASSETTE_DIR;
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
