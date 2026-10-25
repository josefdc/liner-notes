/**
 * Artwork enricher: it searches through the Spotify source (timeouts, typed errors), its
 * requests carry the run's signal, a run cancelled while an answer arrives caches no artwork,
 * no preview URL is cached or logged, and a node gets a preview only for a track that strictly
 * matches the title and artist the model named: Spotify's own clip, else the Deezer entry for
 * the track's ISRC when it passes the same checks as the analysed track's. The network (Spotify
 * and Deezer) and the cache are stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ getArtwork: vi.fn(), putArtwork: vi.fn() }));
vi.mock("../store/cache.js", () => ({ getCache: () => cache }));

import { type FetchCall, json, never, stubFetch } from "../sources/testing/fetchStub.js";
import type { SourceError } from "@liner-notes/contract";
import {
  enrichGenealogyWithArtwork,
  LOOKUP_TIMEOUT_MS,
  limiter,
  MAX_DEEZER_LOOKUPS,
  PREVIEW_BUDGET_MS,
  releaseFits,
  strictlyMatches,
} from "./enricher.js";
import type { Genealogy } from "./schema.js";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const SEARCH_URL = "https://api.spotify.com/v1/search";
const PREVIEW = "https://p.scdn.co/mp3-preview/under-pressure";
const COVER = "https://i.scdn.co/image/x";

const genealogy = {
  nodes: [
    { id: "current", group: 1, label: "Song", size: 40 },
    { id: "n1", group: 4, label: "Other - Artist", size: 22 },
  ],
  links: [],
};

/** A Spotify search answer with one track. */
function found(name: string, artists: string[], preview: string | null = null) {
  return {
    tracks: {
      items: [
        {
          id: "x",
          name,
          preview_url: preview,
          duration_ms: 248000,
          explicit: false,
          album: { name: "Hot Space", release_date: "1982-05-21", images: [{ url: COVER }] },
          external_urls: { spotify: "https://open.spotify.com/track/x" },
          external_ids: { isrc: "GBUM71029601" },
          artists: artists.map((artist, i) => ({ id: `a${i}`, name: artist })),
        },
      ],
      total: 1,
    },
  };
}

const hit = found("Other", ["Artist"]);

/** Spotify answers every search with `answer`. */
function spotifyAnswers(answer: (call: FetchCall) => Response | Promise<Response>) {
  return stubFetch((call: FetchCall) => {
    if (call.url === TOKEN_URL) {
      return json({ access_token: "t", token_type: "Bearer", expires_in: 3600 });
    }
    if (call.url.startsWith(SEARCH_URL)) return answer(call);
    return undefined;
  });
}

/** Spotify answers the search with `answer`, after the run is cancelled. */
function cancelledWhileAnswering(answer: unknown) {
  const controller = new AbortController();
  const net = spotifyAnswers(() => {
    controller.abort();
    return json(answer);
  });
  return { controller, net };
}

/** One node the model proposed, enriched; returns the enriched node. */
async function enrichOne(node: Record<string, unknown>) {
  const out = await enrichGenealogyWithArtwork(
    {
      nodes: [
        { id: "current", group: 1, label: "Song", size: 40 },
        { size: 22, ...node },
      ],
      links: [],
    } as Partial<Genealogy>,
    "https://i.scdn.co/image/c",
    new AbortController().signal,
  );
  return out.nodes[1];
}

const underPressure = {
  id: "n1",
  group: 4,
  label: "Under Pressure - Queen",
  trackTitle: "Under Pressure",
  trackArtist: "Queen",
};

beforeEach(() => {
  process.env.SPOTIFY_CLIENT_ID = "test-client";
  process.env.SPOTIFY_CLIENT_SECRET = "test-secret";
  cache.getArtwork.mockReset();
  cache.putArtwork.mockReset();
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => {
  delete process.env.SOURCE_TIMEOUT_MS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("enrichGenealogyWithArtwork when the run is cancelled", () => {
  it.each([
    ["a track was found", hit],
    ["no track was found", { tracks: { items: [], total: 0 } }],
  ])("rejects and caches no artwork when %s after the cancel", async (_label, answer) => {
    const { controller, net } = cancelledWhileAnswering(answer);

    await expect(
      enrichGenealogyWithArtwork(genealogy, "https://i.scdn.co/image/c", controller.signal),
    ).rejects.toThrow();

    expect(cache.putArtwork).not.toHaveBeenCalled();
    const search = net.calls.find((call) => call.url.startsWith(SEARCH_URL));
    // The request's signal follows the run's (with the source's own timeout).
    expect(search?.signal?.aborted).toBe(true);
  });

  it("caches the artwork of a run that goes on", async () => {
    spotifyAnswers(() => json(hit));

    await enrichGenealogyWithArtwork(
      genealogy,
      "https://i.scdn.co/image/c",
      new AbortController().signal,
    );

    expect(cache.putArtwork).toHaveBeenCalledTimes(1);
  });
});

describe("enrichGenealogyWithArtwork's Spotify searches", () => {
  it("gives up on a search that does not answer in time, and caches nothing", async () => {
    process.env.SOURCE_TIMEOUT_MS = "50";
    const net = spotifyAnswers(never);

    const node = await enrichOne(underPressure);

    expect(net.calls.filter((call) => call.url.startsWith(SEARCH_URL))).toHaveLength(1);
    expect(node).toMatchObject({ id: "n1", label: "Under Pressure - Queen" });
    expect(node.img).toBeUndefined();
    expect(cache.putArtwork).not.toHaveBeenCalled();
  }, 2000);

  it("leaves a node without artwork when Spotify fails, and caches nothing", async () => {
    spotifyAnswers(() => json({ error: { status: 503 } }, { status: 503 }));

    const node = await enrichOne(underPressure);

    expect(node.img).toBeUndefined();
    expect(cache.putArtwork).not.toHaveBeenCalled();
  });
});

describe("enrichGenealogyWithArtwork's previews", () => {
  it("gives the preview of a track that is the title and artist the model named", async () => {
    spotifyAnswers(() => json(found("Under Pressure - Remastered 2011", ["Queen"], PREVIEW)));

    const node = await enrichOne(underPressure);

    expect(node).toMatchObject({ img: COVER, previewUrl: PREVIEW, spotifyId: "x" });
  });

  it.each([
    ["the model named no title or artist", { trackTitle: undefined, trackArtist: undefined }],
    ["another artist's track (a cover)", { trackArtist: "David Bowie" }],
  ])("keeps the cover but gives no Spotify id or preview when %s", async (_label, named) => {
    spotifyAnswers(() => json(found("Under Pressure", ["My Chemical Romance"], PREVIEW)));

    const node = await enrichOne({ ...underPressure, ...named });

    expect(node.img).toBe(COVER);
    expect(node.spotifyId).toBeUndefined();
    expect(node.previewUrl).toBeUndefined();
    // The search's answer is still cached, so the next run does not search again.
    expect(cache.putArtwork).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a strict match", "Under Pressure", "Queen", true],
    ["another artist's track", "Under Pressure", "My Chemical Romance", false],
    ["another version", "Under Pressure (Rah Mix)", "Queen", false],
  ])(
    "takes the cached cover always, its Spotify id only for %s",
    async (_label, title, artist, strict) => {
      const net = spotifyAnswers(() => json(hit));
      cache.getArtwork.mockReturnValue({
        coverUrl: COVER,
        spotifyUrl: "https://open.spotify.com/track/x",
        spotifyId: "x",
        trackTitle: title,
        trackArtist: artist,
      });

      const node = await enrichOne(underPressure);

      expect(node.img).toBe(COVER);
      expect(node.spotifyId).toBe(strict ? "x" : undefined);
      expect(net.calls.filter((call) => call.url.startsWith(SEARCH_URL))).toHaveLength(0);
    },
  );

  it("judges a cached answer on the track's whole credit, as a fresh search does", async () => {
    const collaboration = { ...underPressure, trackArtist: "Queen, David Bowie" };
    spotifyAnswers(() => json(found("Under Pressure", ["Queen", "David Bowie"], PREVIEW)));

    const fresh = await enrichOne(collaboration);
    const [, cached] = cache.putArtwork.mock.calls[0];
    expect(cached).toMatchObject({ trackArtists: ["Queen", "David Bowie"] });
    cache.getArtwork.mockReturnValue(cached);
    const again = await enrichOne(collaboration);

    expect(fresh.spotifyId).toBe("x");
    expect(again.spotifyId).toBe("x");
  });

  it.each([
    ["a live take", "Under Pressure - Live at Wembley '86"],
    ["a remix", "Under Pressure (Rah Mix)"],
    ["another song", "Another One Bites the Dust"],
  ])("gives no preview for %s of the named artist", async (_label, title) => {
    spotifyAnswers(() => json(found(title, ["Queen"], PREVIEW)));

    const node = await enrichOne(underPressure);

    expect(node.previewUrl).toBeUndefined();
  });

  it("caches the artwork without the preview", async () => {
    spotifyAnswers(() => json(found("Under Pressure", ["Queen"], PREVIEW)));

    await enrichOne(underPressure);

    expect(cache.putArtwork).toHaveBeenCalledTimes(1);
    const [, cached] = cache.putArtwork.mock.calls[0];
    expect(cached).not.toHaveProperty("previewUrl");
    expect(JSON.stringify(cached)).not.toContain("mp3-preview");
  });

  it("gives no preview from the cache, even a row older code wrote with one", async () => {
    const net = spotifyAnswers(() => json(hit));
    cache.getArtwork.mockReturnValue({
      coverUrl: COVER,
      spotifyUrl: "https://open.spotify.com/track/x",
      previewUrl: PREVIEW,
      spotifyId: "x",
      trackTitle: "Under Pressure",
      trackArtist: "Queen",
    });

    const node = await enrichOne(underPressure);

    expect(node.img).toBe(COVER);
    expect(node.previewUrl).toBeUndefined();
    expect(net.calls.filter((call) => call.url.startsWith(SEARCH_URL))).toHaveLength(0);
  });
});

describe("enrichGenealogyWithArtwork's Deezer previews by ISRC", () => {
  const DEEZER = "https://api.deezer.com";
  const ISRC = "GBUM71029601";
  const deezerClip = (id: number) =>
    `https://cdnt-preview.dzcdn.net/api/1/1/a/b/0/${id}.mp3?hdnea=exp=1761300000~hmac=abc`;

  /** Deezer's entry for a recording; Under Pressure by Queen (248 s) unless told otherwise. */
  const entry = (fields: Record<string, unknown> = {}) => ({
    id: 7,
    title: "Under Pressure",
    duration: 248,
    preview: deezerClip(Number(fields.id ?? 7)),
    readable: true,
    isrc: ISRC,
    artist: { id: 70, name: "Queen" },
    album: { id: 700, title: "Hot Space" },
    ...fields,
  });

  /** A Spotify track: Under Pressure by Queen, no clip, with an ISRC unless told otherwise. */
  const spotifyTrack = (fields: Record<string, unknown> = {}) => {
    const answer = found("Under Pressure", ["Queen"]);
    answer.tracks.items[0] = { ...answer.tracks.items[0], ...fields };
    return answer;
  };

  /**
   * Spotify answers every search with `spotify` (or `spotify(q)`), Deezer by ISRC with
   * `byIsrc(isrc)` and by id with `byId(id)`; Deezer's "no data" when those give nothing.
   */
  function stub(routes: {
    spotify: unknown | ((query: string) => unknown);
    byIsrc?: (isrc: string, call: FetchCall) => unknown | Promise<unknown>;
    byId?: (id: number) => unknown;
  }) {
    const noData = { error: { type: "DataException", message: "no data", code: 800 } };
    return stubFetch(async (call: FetchCall) => {
      if (call.url === TOKEN_URL) {
        return json({ access_token: "t", token_type: "Bearer", expires_in: 3600 });
      }
      if (call.url.startsWith(SEARCH_URL)) {
        const query = new URL(call.url).searchParams.get("q") ?? "";
        return json(typeof routes.spotify === "function" ? routes.spotify(query) : routes.spotify);
      }
      const url = new URL(call.url);
      if (url.origin !== DEEZER) return undefined;
      const isrc = url.pathname.match(/^\/track\/isrc:(.+)$/);
      if (isrc) {
        const answer = await routes.byIsrc?.(decodeURIComponent(isrc[1]), call);
        return answer instanceof Response ? answer : json(answer ?? noData);
      }
      const id = url.pathname.match(/^\/track\/(\d+)$/);
      if (id) return json(routes.byId?.(Number(id[1])) ?? noData);
      return undefined;
    });
  }

  const deezerCalls = (net: { calls: FetchCall[] }) =>
    net.calls.filter((call) => call.url.startsWith(DEEZER));

  it("gives a strictly matched node without a Spotify clip the Deezer entry for its ISRC", async () => {
    const net = stub({ spotify: spotifyTrack(), byIsrc: () => entry() });

    const node = await enrichOne(underPressure);

    expect(node).toMatchObject({ img: COVER, spotifyId: "x", previewUrl: deezerClip(7) });
    expect(deezerCalls(net).map((call) => call.url)).toEqual([`${DEEZER}/track/isrc:${ISRC}`]);
  });

  it("takes the readable alternative Deezer names for an entry that cannot be played", async () => {
    const net = stub({
      spotify: spotifyTrack(),
      byIsrc: () => entry({ readable: false, alternative: { id: 8 } }),
      byId: (id) => (id === 8 ? entry({ id: 8 }) : undefined),
    });

    const node = await enrichOne(underPressure);

    expect(node.previewUrl).toBe(deezerClip(8));
    expect(deezerCalls(net)).toHaveLength(2);
  });

  it.each([
    ["carries another ISRC", { isrc: "USXX19990001" }],
    ["is another song by the artist", { title: "Another One Bites the Dust" }],
    ["is a live take", { title: "Under Pressure (Live at Wembley '86)" }],
    ["is a karaoke version", { title: "Under Pressure (Karaoke Version)" }],
    ["is credited to another artist (a cover)", { artist: { id: 1, name: "Karaoke Stars" } }],
    ["is 5 s longer", { duration: 253 }],
    ["has no duration", { duration: 0 }],
    ["has no preview", { preview: "" }],
    ["cannot be played and names no alternative", { readable: false }],
    ["has a preview on a host the player may not load", { preview: "https://example.com/x.mp3" }],
  ])("gives no preview when the entry for the ISRC %s", async (_label, fields) => {
    const net = stub({ spotify: spotifyTrack(), byIsrc: () => entry(fields) });

    const node = await enrichOne(underPressure);

    expect(node).toMatchObject({ img: COVER, spotifyId: "x" });
    expect(node.previewUrl).toBeUndefined();
    // Never a search for "a track with a preview": the lookup is by ISRC only.
    expect(deezerCalls(net).every((call) => call.url.includes("/track/"))).toBe(true);
  });

  it("gives no preview when Deezer has no entry for the ISRC", async () => {
    const net = stub({ spotify: spotifyTrack() });

    const node = await enrichOne(underPressure);

    expect(node.previewUrl).toBeUndefined();
    expect(deezerCalls(net)).toHaveLength(1);
  });

  it.each([
    ["a cover (another artist's track)", { trackArtist: "David Bowie" }, spotifyTrack()],
    ["a loose match (no title or artist named)", { trackTitle: undefined }, spotifyTrack()],
    ["a remix", {}, spotifyTrack({ name: "Under Pressure (Rah Mix)" })],
    ["a strict match without an ISRC", {}, spotifyTrack({ external_ids: {} })],
  ])("makes no Deezer lookup for %s", async (_label, named, answer) => {
    const net = stub({ spotify: answer, byIsrc: () => entry() });

    const node = await enrichOne({ ...underPressure, ...named });

    expect(node.previewUrl).toBeUndefined();
    expect(deezerCalls(net)).toHaveLength(0);
  });

  it("uses Spotify's own clip and makes no Deezer lookup for it", async () => {
    const net = stub({ spotify: spotifyTrack({ preview_url: PREVIEW }), byIsrc: () => entry() });

    const node = await enrichOne(underPressure);

    expect(node.previewUrl).toBe(PREVIEW);
    expect(deezerCalls(net)).toHaveLength(0);
  });

  it("looks up Deezer when Spotify's clip is on a host the player may not load", async () => {
    const net = stub({
      spotify: spotifyTrack({ preview_url: "https://example.com/clip.mp3" }),
      byIsrc: () => entry(),
    });

    const node = await enrichOne(underPressure);

    expect(node.previewUrl).toBe(deezerClip(7));
    expect(deezerCalls(net)).toHaveLength(1);
  });

  it("makes no Deezer lookup for a node served from the cache", async () => {
    const net = stub({ spotify: spotifyTrack(), byIsrc: () => entry() });
    cache.getArtwork.mockReturnValue({
      coverUrl: COVER,
      spotifyUrl: "https://open.spotify.com/track/x",
      spotifyId: "x",
      trackTitle: "Under Pressure",
      trackArtist: "Queen",
    });

    const node = await enrichOne(underPressure);

    expect(node).toMatchObject({ spotifyId: "x" });
    expect(node.previewUrl).toBeUndefined();
    expect(net.calls).toHaveLength(0);
  });

  /** A Spotify track `title` by `artist` on `album`, released `released`, 200 s long. */
  const onRelease = (title: string, artist: string, album: string, released: string) =>
    spotifyTrack({
      name: title,
      artists: [{ id: "a0", name: artist }],
      duration_ms: 200_000,
      album: { name: album, release_date: released, images: [{ url: COVER }] },
    });
  const entryOn = (title: string, artist: string, album: string) =>
    entry({
      title,
      duration: 200,
      artist: { id: 1, name: artist },
      album: { id: 1, title: album },
    });

  it.each([
    [
      "a re-recorded album",
      "Rock the Boat - The Hues Corporation (1973)",
      ["Rock the Boat", "The Hues Corporation", "Greatest Hits (Re-Recorded Versions)", "2004"],
    ],
    [
      "a live album",
      "Bohemian Rhapsody - Queen (1975)",
      ["Bohemian Rhapsody", "Queen", "Live Killers", "1979-06-22"],
    ],
    [
      "an unplugged album",
      "About a Girl - Nirvana (1989)",
      ["About A Girl", "Nirvana", "MTV Unplugged In New York", "1994-11-01"],
    ],
    [
      "a karaoke album credited to the artist",
      "Rock the Boat - The Hues Corporation",
      ["Rock the Boat", "The Hues Corporation", "Karaoke Hits", "2010"],
    ],
    [
      "a live album whose name says nothing of it, years after the label's",
      "Respect - Aretha Franklin (1967)",
      ["Respect", "Aretha Franklin", "Aretha at Fillmore West", "1971-05-19"],
    ],
  ])(
    "gives no Spotify id or preview for a plain title on %s, and keeps the cover",
    async (_label, label, release) => {
      const [title, artist, album, released] = release;
      const net = stub({
        spotify: onRelease(title, artist, album, released),
        byIsrc: () => entryOn(title, artist, album),
      });

      const node = await enrichOne({
        id: "n1",
        group: 4,
        label,
        trackTitle: title,
        trackArtist: artist,
      });

      expect(node.img).toBe(COVER);
      expect(node.spotifyId).toBeUndefined();
      expect(node.previewUrl).toBeUndefined();
      expect(deezerCalls(net)).toHaveLength(0);
      // Cached without the track's identity, so a later run cannot take its id from the cache.
      const [, cached] = cache.putArtwork.mock.calls[0];
      expect(cached).toMatchObject({ coverUrl: COVER, spotifyId: null, trackTitle: null });
    },
  );

  it.each([
    ["Under Pressure - Queen (1981)", ["Under Pressure", "Queen", "Hot Space", "1982-05-21"]],
    ["Live and Let Die - Wings (1973)", ["Live And Let Die", "Wings", "Live And Let Die", "1973"]],
    [
      "Bohemian Rhapsody - Queen",
      [
        "Bohemian Rhapsody - Remastered 2011",
        "Queen",
        "A Night At The Opera (2011 Remaster)",
        "1975-11-21",
      ],
    ],
    ["Alive - Pearl Jam (1991)", ["Alive", "Pearl Jam", "Ten", "1991-08-27"]],
  ])("keeps the id and the preview of the studio recording for %j", async (label, release) => {
    const [title, artist, album, released] = release;
    stub({
      spotify: onRelease(title, artist, album, released),
      byIsrc: () => entryOn(title, artist, album),
    });
    const named = label.split(" - ")[0];

    const node = await enrichOne({
      id: "n1",
      group: 4,
      label,
      trackTitle: named,
      trackArtist: artist,
    });

    expect(node.spotifyId).toBe("x");
    expect(node.previewUrl).toBe(deezerClip(7));
  });

  /** Nodes "Song n - Queen" (n = 1..count), each strictly matched by a track with its own ISRC. */
  function strictNodes(count: number) {
    const nodes = Array.from({ length: count }, (_, i) => ({
      id: `n${i + 1}`,
      group: 4,
      size: 22,
      label: `Song ${i + 1} - Queen`,
      trackTitle: `Song ${i + 1}`,
      trackArtist: "Queen",
    }));
    const spotify = (query: string) => {
      const n = Number(query.match(/Song (\d+)/)?.[1]);
      return spotifyTrack({
        id: `id${n}`,
        name: `Song ${n}`,
        external_ids: { isrc: `GBXXX99${String(n).padStart(5, "0")}` },
      });
    };
    const isrcEntry = (isrc: string) => {
      const n = Number(isrc.slice(-5));
      return entry({ id: n, title: `Song ${n}`, isrc });
    };
    return { nodes, spotify, isrcEntry };
  }

  const enrichAll = (
    nodes: object[],
    signal = new AbortController().signal,
    report?: (error: SourceError) => void,
  ) =>
    enrichGenealogyWithArtwork(
      { nodes: nodes as Genealogy["nodes"], links: [] },
      "https://i.scdn.co/image/c",
      signal,
      report,
    );

  /** Deezer's entry for `isrc` after `ms`, or the request's abort. */
  const slowly = (call: FetchCall, ms: number, answer: unknown) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(json(answer)), ms);
      call.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(call.signal?.reason);
      });
    });

  const previews = (out: Genealogy) => out.nodes.filter((node) => node.previewUrl).length;

  it("makes one lookup per node, at most two at once", async () => {
    const { nodes, spotify, isrcEntry } = strictNodes(7);
    let inFlight = 0;
    let most = 0;
    const net = stub({
      spotify,
      byIsrc: async (isrc) => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 20));
        inFlight--;
        return isrcEntry(isrc);
      },
    });

    const out = await enrichAll(nodes);

    expect(out.nodes.map((node) => node.previewUrl)).toEqual(
      nodes.map((_, i) => deezerClip(i + 1)),
    );
    expect(deezerCalls(net)).toHaveLength(7);
    expect(new Set(deezerCalls(net).map((call) => call.url)).size).toBe(7);
    expect(most).toBe(2);
  });

  it("stops looking up Deezer at its rate limit, keeps every node's artwork, and reports it once", async () => {
    const { nodes, spotify } = strictNodes(5);
    const quota = { error: { type: "Exception", message: "Quota limit exceeded", code: 4 } };
    const net = stub({ spotify, byIsrc: () => quota });
    const report = vi.fn();

    const out = await enrichAll(nodes, undefined, report);

    expect(out.nodes.every((node) => node.img === COVER && node.spotifyId)).toBe(true);
    expect(out.nodes.every((node) => node.previewUrl === undefined)).toBe(true);
    // Only the lookups already under way when the first failed (at most two) were made.
    expect(deezerCalls(net).length).toBeGreaterThanOrEqual(1);
    expect(deezerCalls(net).length).toBeLessThanOrEqual(2);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ source: "deezer", code: "rate_limited" });
  });

  it("goes on after one failure of another kind, and stops after the second", async () => {
    const { nodes, spotify, isrcEntry } = strictNodes(6);
    const failing = new Set(["GBXXX9900001"]);
    const once = stub({
      spotify,
      byIsrc: (isrc) =>
        failing.has(isrc) ? json({ error: "bad gateway" }, { status: 502 }) : isrcEntry(isrc),
    });
    const report = vi.fn();

    const out = await enrichAll(nodes, undefined, report);

    expect(out.nodes.find((node) => node.id === "n1")?.previewUrl).toBeUndefined();
    expect(previews(out)).toBe(5);
    expect(deezerCalls(once)).toHaveLength(6);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ source: "deezer", code: "unavailable" });

    vi.unstubAllGlobals();
    const always = stub({ spotify, byIsrc: () => json({ error: "bad gateway" }, { status: 502 }) });
    const after = await enrichAll(nodes);
    expect(previews(after)).toBe(0);
    // The two lookups under way, and at most one that started between their failures.
    expect(deezerCalls(always).length).toBeLessThanOrEqual(3);
  });

  it("does not count an ISRC Deezer has no usable entry for as a failure", async () => {
    const { nodes, spotify, isrcEntry } = strictNodes(8);
    const net = stub({
      spotify,
      // Odd songs: no entry, or one that cannot be used; even songs: their entry.
      byIsrc: (isrc) => {
        const n = Number(isrc.slice(-5));
        if (n % 4 === 1) return undefined;
        if (n % 4 === 3) return { ...isrcEntry(isrc), duration: 400 };
        return isrcEntry(isrc);
      },
    });
    const report = vi.fn();

    const out = await enrichAll(nodes, undefined, report);

    expect(out.nodes.filter((node) => node.previewUrl).map((node) => node.id)).toEqual([
      "n2",
      "n4",
      "n6",
      "n8",
    ]);
    expect(deezerCalls(net)).toHaveLength(8);
    expect(report).not.toHaveBeenCalled();
  });

  it(`looks up at most ${MAX_DEEZER_LOOKUPS} nodes of one run`, async () => {
    const { nodes, spotify, isrcEntry } = strictNodes(MAX_DEEZER_LOOKUPS + 5);
    const net = stub({ spotify, byIsrc: (isrc) => isrcEntry(isrc) });

    const out = await enrichAll(nodes);

    expect(deezerCalls(net)).toHaveLength(MAX_DEEZER_LOOKUPS);
    expect(previews(out)).toBe(MAX_DEEZER_LOOKUPS);
    expect(out.nodes.every((node) => node.img === COVER && node.spotifyId)).toBe(true);
  });

  describe("with the clock run by the test", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    /** Enriches `nodes`, running the clock until it is done; the elapsed time with the result. */
    async function timed(nodes: object[], report?: (error: SourceError) => void) {
      const controller = new AbortController();
      const started = Date.now();
      let settled = false;
      const pending = enrichAll(nodes, controller.signal, report).finally(() => {
        settled = true;
      });
      for (let i = 0; i < 600 && !settled; i++) await vi.advanceTimersByTimeAsync(100);
      return { out: await pending, elapsed: Date.now() - started, run: controller.signal };
    }

    it("gives up a lookup that does not answer in time, and makes no more", async () => {
      const { nodes, spotify } = strictNodes(3);
      const net = stub({ spotify, byIsrc: (_isrc, call) => never(call) });
      const report = vi.fn();

      const { out, elapsed, run } = await timed(nodes, report);

      expect(run.aborted).toBe(false);
      expect(out.nodes.every((node) => node.img === COVER && node.spotifyId)).toBe(true);
      expect(previews(out)).toBe(0);
      expect(deezerCalls(net)).toHaveLength(2);
      expect(elapsed).toBeLessThan(LOOKUP_TIMEOUT_MS + 500);
      expect(report).toHaveBeenCalledTimes(1);
      expect(report.mock.calls[0][0]).toMatchObject({ source: "deezer", code: "timeout" });
    });

    it("stops the previews when their budget is spent, and the enrichment still completes", async () => {
      const { nodes, spotify, isrcEntry } = strictNodes(10);
      // Each answer takes 3 s: within a lookup's time, but two rounds of two fill most of the
      // budget, and the third is cut off by it.
      const net = stub({ spotify, byIsrc: (isrc, call) => slowly(call, 3_000, isrcEntry(isrc)) });

      const { out, elapsed, run } = await timed(nodes);

      expect(run.aborted).toBe(false);
      expect(out.nodes).toHaveLength(10);
      expect(out.nodes.every((node) => node.img === COVER && node.spotifyId)).toBe(true);
      expect(previews(out)).toBe(4);
      expect(deezerCalls(net)).toHaveLength(5);
      expect(elapsed).toBeLessThan(PREVIEW_BUDGET_MS + 1_000);
    });
  });

  it("rejects when the run is cancelled during a Deezer lookup, and stops the request", async () => {
    const controller = new AbortController();
    const net = stub({
      spotify: spotifyTrack(),
      byIsrc: (_isrc, call) => {
        setTimeout(() => controller.abort(), 0);
        return never(call);
      },
    });

    await expect(enrichAll([{ size: 22, ...underPressure }], controller.signal)).rejects.toThrow();

    const lookup = deezerCalls(net)[0];
    expect(lookup?.signal?.aborted).toBe(true);
  });

  it("keeps a link a Deezer error echoes out of the warning and the source error", async () => {
    const echoed = deezerClip(9);
    stub({
      spotify: spotifyTrack(),
      byIsrc: () => ({ error: { type: "Exception", message: `bad link ${echoed}`, code: 100 } }),
    });
    const report = vi.fn();

    const out = await enrichAll([{ size: 22, ...underPressure }], undefined, report);

    expect(out.nodes[0].previewUrl).toBeUndefined();
    const warned = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(warned).toContain("Deezer");
    expect(warned).not.toMatch(/dzcdn|hdnea/);
    expect(report).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report.mock.calls)).not.toMatch(/dzcdn|hdnea/);
  });

  it("keeps the Deezer preview out of the artwork cache and the logs", async () => {
    stub({ spotify: spotifyTrack(), byIsrc: () => entry() });

    const node = await enrichOne(underPressure);

    expect(node.previewUrl).toBe(deezerClip(7));
    expect(cache.putArtwork).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(cache.putArtwork.mock.calls)).not.toMatch(/dzcdn|hdnea|previewUrl/);
    const logged = JSON.stringify(
      (["log", "warn", "error", "info", "debug"] as const).flatMap((method) =>
        vi.isMockFunction(console[method]) ? vi.mocked(console[method]).mock.calls : [],
      ),
    );
    expect(logged).toContain("Deezer");
    expect(logged).not.toMatch(/dzcdn|hdnea/);
  });
});

describe("limiter", () => {
  it("frees the slot of a task that throws, and runs the waiting ones in turn", async () => {
    const run = limiter(1);
    const order: string[] = [];
    const failing = run(async () => {
      order.push("a");
      throw new Error("a failed");
    });
    const next = run(async () => {
      order.push("b");
      return "b";
    });
    const last = run(async () => {
      order.push("c");
      return "c";
    });

    await expect(failing).rejects.toThrow("a failed");
    await expect(next).resolves.toBe("b");
    await expect(last).resolves.toBe("c");
    expect(order).toEqual(["a", "b", "c"]);
  });

  it("never runs more than its limit at once", async () => {
    const run = limiter(2);
    let active = 0;
    let most = 0;
    const task = (fails: boolean) =>
      run(async () => {
        active++;
        most = Math.max(most, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        if (fails) throw new Error("failed");
      });

    await Promise.allSettled([task(true), task(false), task(true), task(false), task(false)]);

    expect(most).toBe(2);
    expect(active).toBe(0);
  });
});

describe("releaseFits", () => {
  const release = (album: string, releaseDate: string, title = "Respect") => ({
    title,
    album,
    releaseDate,
  });

  it.each([
    [
      "no year named, a plain album",
      "Respect - Aretha Franklin",
      release("I Never Loved a Man", "1967"),
      true,
    ],
    [
      "the named year",
      "Respect - Aretha Franklin (1967)",
      release("I Never Loved a Man", "1967-03-10"),
      true,
    ],
    [
      "a year after the named one",
      "Respect - Aretha Franklin (1967)",
      release("Singles", "1968"),
      true,
    ],
    [
      "four years after",
      "Respect - Aretha Franklin (1967)",
      release("Aretha at Fillmore West", "1971-05-19"),
      false,
    ],
    ["years before", "Respect - Aretha Franklin (1967)", release("Early Takes", "1960"), false],
    ["an unknown release date", "Respect - Aretha Franklin (1967)", release("Singles", ""), false],
    [
      "a live album, no year named",
      "Respect - Aretha Franklin",
      release("Live in Paris", "1968"),
      false,
    ],
    [
      "an album named like the song",
      "Live And Let Die - Wings",
      release("Live And Let Die", "1973", "Live And Let Die"),
      true,
    ],
  ])("for %s: %s", (_label, label, found, fits) => {
    expect(releaseFits(label, found)).toBe(fits);
  });
});

describe("strictlyMatches", () => {
  const track = (title: string, artistNames: string[]) => ({
    title,
    artist: artistNames.join(", "),
    artistNames,
  });

  it("accepts the named title by the named lead artist, release labels aside", () => {
    expect(strictlyMatches(underPressure, track("Under Pressure", ["Queen", "David Bowie"]))).toBe(
      true,
    );
    expect(
      strictlyMatches(
        { trackTitle: "Under Pressure", trackArtist: "Queen, David Bowie" },
        track("Under Pressure - Remastered 2011", ["Queen", "David Bowie"]),
      ),
    ).toBe(true);
  });

  it.each([
    ["Queen & David Bowie", "Under Pressure", ["Queen", "David Bowie"], true],
    ["Queen and David Bowie", "Under Pressure", ["Queen", "David Bowie"], true],
    [
      "Daft Punk feat. Pharrell Williams",
      "Get Lucky (feat. Pharrell Williams & Nile Rodgers)",
      ["Daft Punk", "Pharrell Williams", "Nile Rodgers"],
      true,
    ],
    ["Earth, Wind & Fire", "September", ["Earth, Wind & Fire"], true],
    // The credit's first artist must be the lead, and every one of them credited.
    ["David Bowie & Queen", "Under Pressure", ["Queen", "David Bowie"], false],
    ["Queen & Freddie Mercury", "Under Pressure", ["Queen", "David Bowie"], false],
  ])("matches the credit %j against %j by %j: %s", (artist, title, names, expected) => {
    const node = { trackTitle: title.replace(/ \(feat\..*\)$/, ""), trackArtist: artist };
    expect(strictlyMatches(node, track(title, names))).toBe(expected);
  });

  it("refuses a plain title on an album that marks another recording", () => {
    const found = { ...track("Bohemian Rhapsody", ["Queen"]), album: "Live Killers" };
    const node = { trackTitle: "Bohemian Rhapsody", trackArtist: "Queen" };
    expect(strictlyMatches(node, found)).toBe(false);
    expect(strictlyMatches(node, { ...found, album: "A Night at the Opera" })).toBe(true);
  });

  it("refuses a featured artist's track, another version and a missing title or artist", () => {
    expect(
      strictlyMatches(
        { trackTitle: "Under Pressure", trackArtist: "David Bowie" },
        track("Under Pressure", ["Queen", "David Bowie"]),
      ),
    ).toBe(false);
    expect(strictlyMatches(underPressure, track("Under Pressure (Acoustic)", ["Queen"]))).toBe(
      false,
    );
    expect(
      strictlyMatches({ trackTitle: "Under Pressure" }, track("Under Pressure", ["Queen"])),
    ).toBe(false);
  });
});
