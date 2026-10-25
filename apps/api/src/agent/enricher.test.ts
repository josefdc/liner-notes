/**
 * Artwork enricher: it searches through the Spotify source (timeouts, typed errors), its
 * requests carry the run's signal, a run cancelled while an answer arrives caches no artwork,
 * no preview URL is cached, and a node gets a preview only for a track that strictly matches
 * the title and artist the model named. The network and the cache are stubbed.
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
