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
import { enrichGenealogyWithArtwork, strictlyMatches } from "./enricher.js";
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
        external_ids: { isrc: `GBXXX990000${n}` },
      });
    };
    const isrcEntry = (isrc: string) => {
      const n = Number(isrc.slice(-5));
      return entry({ id: n, title: `Song ${n}`, isrc });
    };
    return { nodes, spotify, isrcEntry };
  }

  const enrichAll = (nodes: object[], signal = new AbortController().signal) =>
    enrichGenealogyWithArtwork(
      { nodes: nodes as Genealogy["nodes"], links: [] },
      "https://i.scdn.co/image/c",
      signal,
    );

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

  it("stops looking up Deezer once it fails, and keeps every node's artwork", async () => {
    const { nodes, spotify } = strictNodes(5);
    const quota = { error: { type: "Exception", message: "Quota limit exceeded", code: 4 } };
    const net = stub({ spotify, byIsrc: () => quota });

    const out = await enrichAll(nodes);

    expect(out.nodes.every((node) => node.img === COVER && node.spotifyId)).toBe(true);
    expect(out.nodes.every((node) => node.previewUrl === undefined)).toBe(true);
    // Only the lookups already under way when the first failed (at most two) were made.
    expect(deezerCalls(net).length).toBeGreaterThanOrEqual(1);
    expect(deezerCalls(net).length).toBeLessThanOrEqual(2);
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
