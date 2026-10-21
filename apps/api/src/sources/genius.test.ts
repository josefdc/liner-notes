/**
 * Genius song relationships, against a stubbed API. The fixtures follow the Genius API's
 * response shape (`meta` + `response`, song `song_relationships`) with placeholder ids; they
 * hold no lyrics, and the tests check that no lyric-bearing field is requested or recorded.
 */

import { Evidence as EvidenceSchema, evidenceIssues } from "@liner-notes/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import search from "./fixtures/genius-search-ice-ice-baby.json" with { type: "json" };
import song from "./fixtures/genius-song-ice-ice-baby.json" with { type: "json" };
import { geniusPage, geniusRelationships, geniusSongIdFromUrl } from "./genius.js";
import type { TrackRef } from "./records.js";
import { type FetchRoute, json, stubFetch } from "./testing/fetchStub.js";
import { recordThenReplay } from "./testing/roundTrip.js";

const TOKEN = "genius-test-token-0123456789";
const LINKED = "https://genius.com/Vanilla-ice-ice-ice-baby-lyrics";
const now = () => new Date("2026-10-20T12:00:00.000Z");

const TRACK: TrackRef = {
  isrc: "USCA29001716",
  title: "Ice Ice Baby",
  artists: ["Vanilla Ice"],
  durationMs: 271_733,
};

const api: FetchRoute = (call) => {
  if (call.url.startsWith("https://api.genius.com/search?")) return json(search);
  if (call.url === "https://api.genius.com/songs/9000001") return json(song);
  return undefined;
};

beforeEach(() => {
  delete process.env.SOURCE_CASSETTE;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.GENIUS_ACCESS_TOKEN;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("without GENIUS_ACCESS_TOKEN", () => {
  it("is missing, requests nothing and does not throw", async () => {
    delete process.env.GENIUS_ACCESS_TOKEN;
    const net = stubFetch(api);
    const result = await geniusRelationships(TRACK, LINKED);
    expect(result).toMatchObject({
      status: "missing",
      reason: "GENIUS_ACCESS_TOKEN is not set",
      error: { source: "genius", code: "not_configured" },
    });
    expect(net.calls).toHaveLength(0);
  });
});

describe("with GENIUS_ACCESS_TOKEN", () => {
  beforeEach(() => {
    process.env.GENIUS_ACCESS_TOKEN = TOKEN;
  });

  it("reads the linked song's relationships, never its lyrics", async () => {
    const net = stubFetch(api);
    const result = await geniusRelationships(TRACK, LINKED, { now, trackIsOriginal: true });
    if (result.status !== "found") throw new Error(result.reason);

    expect(result.records).toEqual([
      {
        kind: "samples",
        about: "track",
        songId: 9000003,
        title: "Under Pressure",
        artist: "Queen & David Bowie",
        url: "https://genius.com/Queen-and-david-bowie-under-pressure-lyrics",
      },
      {
        kind: "covered-by",
        about: "track",
        songId: 9000004,
        title: "Ice Ice Baby",
        artist: "Glee Cast",
        url: "https://genius.com/Glee-cast-ice-ice-baby-lyrics",
      },
    ]);
    // Only the API: a search and the song, with the token in the header.
    expect(net.calls.map((c) => new URL(c.url).pathname)).toEqual(["/search", "/songs/9000001"]);
    for (const call of net.calls) {
      expect(new URL(call.url).host).toBe("api.genius.com");
      expect(call.url).not.toContain(TOKEN);
      expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    }
    for (const item of result.evidence) {
      expect(evidenceIssues(EvidenceSchema.parse(item))).toEqual([]);
      expect(item).toMatchObject({ source: "genius", sourceTier: "primary-record", url: LINKED });
    }
    expect(result.evidence[0].excerpt).toBe(
      'Genius: the song "Ice Ice Baby" by Vanilla Ice samples "Under Pressure" by Queen & David Bowie.',
    );
  });

  it("takes the search result that is the linked page, not the first one", async () => {
    // The first hit is the remix; taking it would read another song's relationships.
    expect(search.response.hits[0].result.id).toBe(9000002);
    const net = stubFetch(api);
    await geniusRelationships(TRACK, LINKED);
    expect(net.calls[1].url).toBe("https://api.genius.com/songs/9000001");
  });

  it("is missing when no search result is the linked page", async () => {
    stubFetch(api);
    const result = await geniusRelationships(TRACK, "https://genius.com/Some-other-page-lyrics");
    expect(result).toMatchObject({ status: "missing", identity: { missing: 1 } });
  });

  it("omits the linked song when its title or artist is not the track's", async () => {
    stubFetch(api);
    const retitled = await geniusRelationships({ ...TRACK, title: "Ice Ice Baby (Remix)" }, LINKED);
    expect(retitled).toMatchObject({ status: "missing", identity: { rejected: 1 } });
    const reattributed = await geniusRelationships({ ...TRACK, artists: ["Glee Cast"] }, LINKED);
    expect(reattributed).toMatchObject({ status: "missing", identity: { rejected: 1 } });
    expect(reattributed.omitted[0].reason).toContain('credited to "Vanilla Ice"');
  });

  it("uses the id of a /songs/<id> link without searching", async () => {
    const net = stubFetch(api);
    await geniusRelationships(TRACK, "https://genius.com/songs/9000001");
    expect(net.calls.map((c) => new URL(c.url).pathname)).toEqual(["/songs/9000001"]);
  });

  it("is missing without a linked page, and on an API error, with no token in the reason", async () => {
    const none = stubFetch(api);
    expect(await geniusRelationships(TRACK, null)).toMatchObject({ status: "missing" });
    expect(await geniusRelationships(TRACK, "https://example.com/x")).toMatchObject({
      status: "missing",
    });
    expect(none.calls).toHaveLength(0);

    stubFetch(() =>
      json({ meta: { status: 401, message: `Invalid token ${TOKEN}` } }, { status: 401 }),
    );
    const denied = await geniusRelationships(TRACK, LINKED);
    expect(denied).toMatchObject({ status: "missing", error: { code: "unavailable" } });
    expect(JSON.stringify(denied)).not.toContain(TOKEN);
  });

  it("replays the recorded run; the cassette holds no lyric-bearing field", async () => {
    const withText = {
      ...song,
      response: {
        song: {
          ...song.response.song,
          description: { plain: "A note about the song." },
          embed_content: "<div id='rg_embed_link_9000001'>Read the lyrics</div>",
          lyrics_state: "complete",
          song_art_image_url: "https://images.genius.com/x.jpg",
        },
      },
    };
    const run = await recordThenReplay(
      (call) => (call.url.includes("/songs/") ? json(withText) : api(call)),
      () => geniusRelationships(TRACK, LINKED, { now }),
    );
    expect(run.replayCalls).toBe(0);
    expect(run.replayed).toEqual(run.live);
    expect(run.live.status).toBe("found");
    for (const field of ["description", "embed_content", "lyrics_state", "song_art_image_url"]) {
      expect(run.cassettes.genius).not.toContain(field);
    }
    expect(run.cassettes.genius).not.toContain(TOKEN);
  });
});

describe("Genius links", () => {
  it("normalises a page URL and reads a song id", () => {
    expect(geniusPage("http://www.genius.com/Vanilla-ice-ice-ice-baby-lyrics/?x=1")).toBe(LINKED);
    expect(geniusPage("https://genius.com.evil.example/x")).toBeNull();
    expect(geniusSongIdFromUrl("https://genius.com/songs/123")).toBe(123);
    expect(geniusSongIdFromUrl(LINKED)).toBeNull();
  });
});

describe("review findings", () => {
  beforeEach(() => {
    process.env.GENIUS_ACCESS_TOKEN = TOKEN;
  });

  it("does not claim the song's relationships for a recording that is not its original", async () => {
    stubFetch(api);
    const result = await geniusRelationships(TRACK, LINKED, { now });
    if (result.status !== "found") throw new Error(result.reason);
    expect(result.records.map((r) => [r.kind, r.about])).toEqual([
      ["samples", "work"],
      ["covered-by", "work"],
    ]);
    expect(result.incomplete).toBe(
      "relationships of the song, not claimed for this recording: it is not the song's original recording",
    );
    // A cover of another song is the performer's version: it holds for the track either way.
    const cover = {
      ...song,
      response: {
        song: {
          ...song.response.song,
          song_relationships: [
            {
              relationship_type: "cover_of",
              songs: [song.response.song.song_relationships[0].songs[0]],
            },
          ],
        },
      },
    };
    stubFetch((call) => (call.url.includes("/songs/") ? json(cover) : api(call)));
    const covered = await geniusRelationships(TRACK, LINKED, { now });
    expect(covered.status === "found" && covered.records[0].about).toBe("track");
  });

  it("matches the linked page whatever the case of its path", async () => {
    const net = stubFetch(api);
    const result = await geniusRelationships(TRACK, LINKED.toLowerCase(), { now });
    expect(result.status).toBe("found");
    expect(net.calls[1].url).toBe("https://api.genius.com/songs/9000001");
  });

  it("lists each related song once per kind, at most 25, and says how many more", async () => {
    const other = (i: number) => ({
      id: 9500000 + i,
      title: `Sampler ${i}`,
      url: `https://genius.com/Sampler-${i}-lyrics`,
      artist_names: `Artist ${i}`,
    });
    const many = {
      ...song,
      response: {
        song: {
          ...song.response.song,
          song_relationships: [
            {
              relationship_type: "sampled_in",
              songs: [...Array.from({ length: 30 }, (_, i) => other(i)), other(0)],
            },
          ],
        },
      },
    };
    stubFetch((call) => (call.url.includes("/songs/") ? json(many) : api(call)));
    const result = await geniusRelationships(TRACK, LINKED, { now, trackIsOriginal: true });
    if (result.status !== "found") throw new Error(result.reason);
    expect(result.records).toHaveLength(25);
    expect(result.incomplete).toBe("5 more not listed");
    expect(new Set(result.evidence.map((e) => e.id)).size).toBe(25);
  });

  it("keeps the token out of the cassette even when the answer echoes it", async () => {
    const echoed = {
      ...search,
      response: {
        hits: search.response.hits.map((h) => ({
          ...h,
          result: { ...h.result, title: `${h.result.title} access_token=${TOKEN}` },
        })),
      },
    };
    const run = await recordThenReplay(
      (call) => (call.url.includes("/search") ? json(echoed) : api(call)),
      () => geniusRelationships(TRACK, LINKED, { now }),
    );
    expect(run.cassettes.genius).toContain("access_token=[redacted]");
    expect(run.cassettes.genius).not.toContain(TOKEN);
  });
});
