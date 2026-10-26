/**
 * Artwork enricher: it searches through the Spotify source (timeouts, typed errors), its
 * requests carry the run's signal, a run cancelled while an answer arrives caches no artwork,
 * no preview URL is cached or logged, and a node gets a cover, a Spotify id and a preview only
 * for a track that strictly matches the title and artist the model named: the preview is
 * Spotify's own clip, else the Deezer entry for the track's ISRC when it passes the same checks
 * as the analysed track's. The answer holds one entry per node id and no links. The network
 * (Spotify and Deezer) and the cache are stubbed.
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
  marksOtherRecording,
  PREVIEW_BUDGET_MS,
  releaseYearFits,
  START_MARGIN_MS,
  strictlyMatches,
} from "./enricher.js";
import type { Genealogy } from "./schema.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolvePreview } from "../sources/audio.js";
import {
  DEEZER_MAX_PER_WINDOW,
  DEEZER_NODE_MAX_PER_WINDOW,
  DEEZER_WINDOW_MS,
  deezerPreviewByIsrc,
} from "../sources/deezer.js";
import { PaceRefused, pacingClock, setUnpacedForTests } from "../sources/pacing.js";
import { captureLogsForTests } from "../logger.js";

const TOKEN_URL = "https://accounts.spotify.com/api/token";
const SEARCH_URL = "https://api.spotify.com/v1/search";
const PREVIEW = "https://p.scdn.co/mp3-preview/under-pressure";
const COVER = "https://i.scdn.co/image/x";

const genealogy = {
  nodes: [
    { id: "current", group: 1, label: "Song", size: 40 },
    {
      id: "n1",
      group: 4,
      label: "Other - Artist",
      size: 22,
      trackTitle: "Other",
      trackArtist: "Artist",
    },
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

/** The track details this code caches, without an ISRC (so a hit makes no Deezer lookup). */
const NO_ISRC_DETAILS = {
  isrc: null,
  durationMs: 248000,
  album: "Hot Space",
  releaseDate: "1982-05-21",
};

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
    expect(node).toEqual({ id: "n1" });
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

describe("enrichGenealogyWithArtwork's covers", () => {
  it.each([
    ["the same title by another artist", "Under Pressure", ["My Chemical Romance"], {}],
    ["another song by the named artist", "Another One Bites the Dust", ["Queen"], {}],
    ["a remix of the named recording", "Under Pressure (Rah Mix)", ["Queen"], {}],
    [
      "a credit naming an artist the track lacks",
      "Under Pressure",
      ["Queen"],
      { trackArtist: "Queen & David Bowie" },
    ],
  ])("gives no cover, Spotify id or preview for %s", async (_label, title, artists, named) => {
    spotifyAnswers(() => json(found(title, artists, PREVIEW)));

    const node = await enrichOne({ ...underPressure, ...named });

    expect(node.id).toBe("n1");
    expect(node.img).toBeUndefined();
    expect(node.spotifyId).toBeUndefined();
    expect(node.previewUrl).toBeUndefined();
  });

  it.each([
    ["accents", "Deja Vu", "Beyonce", "Déjà Vu", ["Beyoncé"]],
    ["case", "crazy in love", "BEYONCÉ", "Crazy In Love", ["Beyoncé"]],
    [
      "featured artist",
      "Crazy in Love (feat. Jay-Z)",
      "Beyoncé",
      "Crazy In Love",
      ["Beyoncé", "JAY-Z"],
    ],
    ["credit", "Crazy In Love", "Beyoncé feat. JAY-Z", "Crazy In Love", ["Beyoncé", "JAY-Z"]],
  ])(
    "gives the cover of the named recording whatever its %s",
    async (_label, trackTitle, trackArtist, title, artists) => {
      spotifyAnswers(() => json(found(title, artists)));

      const node = await enrichOne({ id: "n1", group: 4, label: "x", trackTitle, trackArtist });

      expect(node).toMatchObject({ img: COVER, spotifyId: "x" });
    },
  );

  it("searches nothing for a node that names no title or artist: no cover could be checked", async () => {
    const net = spotifyAnswers(() => json(found("Under Pressure", ["Queen"])));

    const node = await enrichOne({ id: "n1", group: 4, label: "Under Pressure - Queen" });

    expect(node.img).toBeUndefined();
    expect(net.calls).toHaveLength(0);
    expect(cache.getArtwork).not.toHaveBeenCalled();
  });

  it("gives the analysed track's node its cover and returns no other fields", async () => {
    spotifyAnswers(() => json(found("Under Pressure", ["Queen"])));

    const out = await enrichGenealogyWithArtwork(
      {
        nodes: [
          { id: "current", group: 1, label: "Song", size: 40 },
          { size: 22, ...underPressure },
        ],
      },
      "https://i.scdn.co/image/c",
    );

    expect(out.nodes).toEqual([
      { id: "current", img: "https://i.scdn.co/image/c" },
      { id: "n1", img: COVER, spotifyId: "x" },
    ]);
  });
});

describe("the recording a node names", () => {
  const studio = { trackTitle: "Hotel California", trackArtist: "Eagles" };
  const onAlbum = (album: string, title = "Hotel California", artistNames = ["Eagles"]) => ({
    title,
    artist: artistNames.join(", "),
    artistNames,
    album,
  });

  it.each([
    "Eagles Live",
    "Live",
    "Live 1975-85",
    "Live Aid",
    "En Vivo",
    "Ao Vivo",
    "Concert in Central Park",
    "BBC Sessions",
    "The Demos",
    "Instrumentals",
    "Live Killers",
  ])(
    "is not a plain title on the album %j: a live, session, demo or instrumental release",
    (album) => {
      expect(strictlyMatches(studio, onAlbum(album))).toBe(false);
    },
  );

  it.each([
    "Hotel California (2013 Remaster)",
    "Hotel California",
    "Their Greatest Hits 1971-1975",
  ])("is a plain title on the album %j", (album) => {
    expect(strictlyMatches(studio, onAlbum(album))).toBe(true);
  });

  // Honest misses: studio albums whose names carry a live or session word give no cover.
  it.each(["Live Through This", "Long Live the Kane", "The Sun Sessions"])(
    "gives up the studio album %j rather than risk a live one",
    (album) => {
      expect(strictlyMatches(studio, onAlbum(album))).toBe(false);
    },
  );

  it("gives no cover, id or preview for a plain title on an unmarked live album", async () => {
    spotifyAnswers(() => {
      const answer = found("Hotel California", ["Eagles"], PREVIEW);
      answer.tracks.items[0].album = {
        name: "Eagles Live",
        release_date: "1980-11-07",
        images: [{ url: COVER }],
      };
      return json(answer);
    });

    const node = await enrichOne({
      id: "n1",
      group: 4,
      label: "Hotel California - Eagles",
      ...studio,
    });

    expect(node).toEqual({ id: "n1" });
  });

  const stayWithMe = {
    id: "n1",
    group: 4,
    label: "Stay With Me - Sam Smith (2014)",
    trackTitle: "Stay With Me",
    trackArtist: "Sam Smith",
  };

  it("gives no cover, id or preview for a later duet the node does not name", async () => {
    spotifyAnswers(() => {
      const answer = found(
        "Stay With Me (feat. Mary J. Blige)",
        ["Sam Smith", "Mary J. Blige"],
        PREVIEW,
      );
      answer.tracks.items[0].album = {
        name: "Stay With Me (feat. Mary J. Blige)",
        release_date: "2015-02-08",
        images: [{ url: COVER }],
      };
      return json(answer);
    });

    const node = await enrichOne(stayWithMe);

    expect(node).toEqual({ id: "n1" });
  });

  it.each([
    [
      "the guest only in the title",
      "Stay With Me (feat. Mary J. Blige)",
      ["Sam Smith"],
      stayWithMe,
      false,
    ],
    ["a co-credit", "Under Pressure", ["Queen", "David Bowie"], underPressure, false],
    [
      "the guest named in the node's credit",
      "Stay With Me (feat. Mary J. Blige)",
      ["Sam Smith", "Mary J. Blige"],
      { ...stayWithMe, trackArtist: "Sam Smith feat. Mary J. Blige" },
      true,
    ],
    [
      "the guest named in the node's title",
      "Stay With Me (feat. Mary J. Blige)",
      ["Sam Smith", "Mary J. Blige"],
      { ...stayWithMe, trackTitle: "Stay With Me (feat. Mary J. Blige)" },
      true,
    ],
  ])("judges a track that credits another artist, %s: %s", (_label, title, names, node, strict) => {
    expect(strictlyMatches(node, onAlbum("In the Lonely Hour", title, names))).toBe(strict);
  });

  it.each([
    ["Hotel California - Radio Edit", false],
    ["Hotel California (Radio Edit)", false],
    ["Hotel California - Single Edit", false],
    ["Hotel California - Single Version", false],
    ["Hotel California - Mono", false],
    ["Hotel California - Mono Version", false],
    ["Hotel California - Radio Mix", false],
    ["Hotel California - Single Mix", false],
    ["Hotel California - Stereo Mix", false],
    ["Hotel California - Remastered 2013", true],
    ["Hotel California - 2013 Remaster", true],
  ])("takes %j as the named recording: %s", (title, strict) => {
    expect(strictlyMatches(studio, onAlbum("Hotel California", title))).toBe(strict);
  });

  /** A cached row for `title` by `artistNames` on `album`, as this code caches it. */
  const rowFor = (title: string, artistNames: string[], album: string) => ({
    coverUrl: COVER,
    spotifyUrl: "https://open.spotify.com/track/x",
    spotifyId: "x",
    trackTitle: title,
    trackArtist: artistNames[0],
    trackArtists: artistNames,
    trackDetails: { isrc: null, durationMs: 200_000, album, releaseDate: "2014-05-26" },
  });

  // The node names a guest or an edit the record found lacks: another recording.
  const lacking = [
    [
      "a duet against the solo record",
      { trackTitle: "Stay With Me (feat. Mary J. Blige)", trackArtist: "Sam Smith" },
      ["Stay With Me", ["Sam Smith"], "In the Lonely Hour"],
    ],
    [
      "a remix with a guest against the solo record",
      { trackTitle: "Old Town Road (feat. Billy Ray Cyrus)", trackArtist: "Lil Nas X" },
      ["Old Town Road", ["Lil Nas X"], "7 EP"],
    ],
    [
      "a radio edit against the album take",
      { trackTitle: "Hotel California (Radio Edit)", trackArtist: "Eagles" },
      ["Hotel California", ["Eagles"], "Hotel California"],
    ],
  ] as const;

  it.each(lacking)("refuses %s", (_label, named, [title, artists, album]) => {
    expect(strictlyMatches(named, onAlbum(album, title, [...artists]))).toBe(false);
  });

  it.each(lacking)(
    "gives no cover, id or preview for %s, from a fresh search",
    async (_label, named, [title, artists, album]) => {
      spotifyAnswers(() => {
        const answer = found(title, [...artists], PREVIEW);
        answer.tracks.items[0].album = {
          name: album,
          release_date: "2014-05-26",
          images: [{ url: COVER }],
        };
        return json(answer);
      });

      const node = await enrichOne({ id: "n1", group: 4, label: "x", ...named });

      expect(node).toEqual({ id: "n1" });
    },
  );

  it.each(lacking)(
    "gives no cover, id or preview for %s, from the cache",
    async (_label, named, [title, artists, album]) => {
      const net = spotifyAnswers(() => json(hit));
      cache.getArtwork.mockReturnValue(rowFor(title, [...artists], album));

      const node = await enrichOne({ id: "n1", group: 4, label: "x", ...named });

      expect(node).toEqual({ id: "n1" });
      expect(net.calls).toHaveLength(0);
    },
  );

  it.each([
    ["the guest credited", "Crazy In Love", ["Beyoncé", "JAY-Z"]],
    ["the guest in the record's title", "Crazy In Love (feat. JAY-Z)", ["Beyoncé"]],
  ])("accepts a node naming its guest, %s", (_label, title, artists) => {
    const node = { trackTitle: "Crazy in Love (feat. Jay-Z)", trackArtist: "Beyoncé" };
    expect(strictlyMatches(node, onAlbum("Dangerously in Love", title, artists))).toBe(true);
  });

  it("accepts a credit read whole when it cannot be split into the record's artists", () => {
    const node = {
      trackTitle: "Boogie Wonderland",
      trackArtist: "Earth, Wind & Fire, The Emotions",
    };
    const record = onAlbum("I Am", "Boogie Wonderland", ["Earth, Wind & Fire", "The Emotions"]);
    expect(strictlyMatches(node, record)).toBe(true);
  });

  it.each([
    "Acoustic",
    "Jagged Little Pill Acoustic",
    "Greatest Hits - Newly Recorded",
    "Newly Recorded Versions",
    "Newly Re-Recorded Hits",
    "Re-Recordings",
    "The Remixes",
    "Remixed",
    "Orchestral Hits",
    "Symphonica",
    "Piano Versions",
  ])(
    "is not a plain title on the album %j: an acoustic, remix, orchestral, piano or re-recorded release",
    (album) => {
      expect(strictlyMatches(studio, onAlbum(album))).toBe(false);
    },
  );

  it.each([
    ["Piano Man", "Billy Joel", "Piano Man"],
    ["Remix to Ignition", "R. Kelly", "Chocolate Factory"],
    ["Remix to Ignition", "R. Kelly", "Remix to Ignition"],
  ])("still takes %j by %j on %j as the named recording", (title, artist, album) => {
    const node = { trackTitle: title, trackArtist: artist };
    expect(strictlyMatches(node, onAlbum(album, title, [artist]))).toBe(true);
  });

  it("takes an edit the node names itself as the named recording", () => {
    const node = { ...studio, trackTitle: "Hotel California (Radio Edit)" };
    expect(
      strictlyMatches(node, onAlbum("Hotel California", "Hotel California - Radio Edit")),
    ).toBe(true);
  });

  it('gives the analysed track\'s cover only to the node "current"', async () => {
    const out = await enrichGenealogyWithArtwork(
      {
        nodes: [
          { id: "current", group: 1, label: "Song", size: 40 },
          { id: "other", group: 1, label: "Other", size: 40 },
        ],
      },
      "https://i.scdn.co/image/c",
    );

    expect(out.nodes).toEqual([
      { id: "current", img: "https://i.scdn.co/image/c" },
      { id: "other" },
    ]);
  });
});

describe("enrichGenealogyWithArtwork's cache key", () => {
  const row = (artist: string) => ({
    coverUrl: COVER,
    spotifyUrl: "https://open.spotify.com/track/x",
    spotifyId: "x",
    trackTitle: "Under Pressure",
    trackArtist: artist,
    trackArtists: [artist],
    trackDetails: NO_ISRC_DETAILS,
  });

  it("keys the search by the node's label, title and artist", async () => {
    spotifyAnswers(() => json(found("Under Pressure", ["Queen"])));

    await enrichOne(underPressure);
    await enrichOne({ ...underPressure, trackArtist: "David Bowie" });

    const keys = cache.putArtwork.mock.calls.map(([key]) => key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) {
      expect(key).toContain("under pressure");
      expect(key).not.toBe("under pressure - queen");
    }
    expect(keys[0]).toContain("queen");
    expect(keys[1]).toContain("david bowie");
    expect(cache.getArtwork.mock.calls.map(([key]) => key)).toEqual(keys);
  });

  it("keys every row under the v2 prefix, never under the label alone", async () => {
    spotifyAnswers(() => json(found("Under Pressure", ["Queen"])));

    await enrichOne(underPressure);

    const [key] = cache.putArtwork.mock.calls[0];
    expect(key).toBe("v2|under pressure queen|under pressure|queen");
    expect(cache.getArtwork).toHaveBeenCalledWith(key);
  });

  it("normalises the key: accents, case and spacing make no other row", async () => {
    spotifyAnswers(() => json(found("Déjà Vu", ["Beyoncé"])));

    await enrichOne({
      id: "n1",
      group: 4,
      label: "Déjà Vu - Beyoncé",
      trackTitle: "Déjà Vu",
      trackArtist: "Beyoncé",
    });
    await enrichOne({
      id: "n1",
      group: 4,
      label: " deja vu -  BEYONCE",
      trackTitle: "DEJA VU",
      trackArtist: "beyonce ",
    });

    const [[first], [second]] = cache.putArtwork.mock.calls;
    expect(first).toBe(second);
  });

  it("never serves a row older code keyed by the label alone", async () => {
    // Older code keyed the row by the label only, so a node of another artist could read it.
    const net = spotifyAnswers(() => json({ tracks: { items: [], total: 0 } }));
    cache.getArtwork.mockImplementation((key: string) =>
      key === "under pressure - queen" ? row("Queen") : null,
    );

    const node = await enrichOne({ ...underPressure, trackArtist: "My Chemical Romance" });

    expect(node.img).toBeUndefined();
    expect(node.spotifyId).toBeUndefined();
    expect(cache.getArtwork).not.toHaveBeenCalledWith("under pressure - queen");
    expect(net.calls.filter((call) => call.url.startsWith(SEARCH_URL))).toHaveLength(1);
  });

  it("gives no cover from a cached row whose track is another artist's", async () => {
    const net = spotifyAnswers(() => json(hit));
    cache.getArtwork.mockReturnValue(row("My Chemical Romance"));

    const node = await enrichOne(underPressure);

    expect(node.img).toBeUndefined();
    expect(node.spotifyId).toBeUndefined();
    expect(net.calls).toHaveLength(0);
  });
});

describe("enrichGenealogyWithArtwork's answer", () => {
  /** The analysed track, two nodes with one id, two without an id, and a link to no node. */
  const messy = {
    nodes: [
      { id: "current", group: 1, label: "Song", size: 40 },
      { size: 22, ...underPressure },
      { size: 22, ...underPressure, label: "Under Pressure - Queen (again)" },
      { id: "", group: 4, label: "No id A", size: 20 },
      { id: "", group: 4, label: "No id B", size: 20 },
    ],
    links: [
      { source: "n1", target: "current", value: 3 },
      { source: "ghost", target: "current", value: 2 },
    ],
  } as Partial<Genealogy>;

  it("returns one entry per node id, never an invented or repeated id", async () => {
    spotifyAnswers(() => json(found("Under Pressure", ["Queen"])));

    const out = await enrichGenealogyWithArtwork(messy, "https://i.scdn.co/image/c");

    const ids = out.nodes.map((node) => node.id);
    expect(ids).toEqual(["current", "n1"]);
  });

  it("returns no links, so none can point to a node that is not there", async () => {
    spotifyAnswers(() => json(found("Under Pressure", ["Queen"])));

    const out = await enrichGenealogyWithArtwork(messy, "https://i.scdn.co/image/c");

    expect(out).not.toHaveProperty("links");
  });

  it("returns nothing for no nodes, never a node of its own", async () => {
    const net = spotifyAnswers(() => json(hit));

    for (const input of [undefined, {}, { nodes: [] }]) {
      const out = await enrichGenealogyWithArtwork(
        input as Partial<Genealogy> | undefined,
        "https://i.scdn.co/image/c",
      );
      expect(out.nodes).toEqual([]);
    }
    expect(net.calls).toHaveLength(0);
  });

  it("keeps every other node's artwork when one node's lookup fails unexpectedly", async () => {
    spotifyAnswers(() => json(found("Under Pressure", ["Queen"])));
    const logs = captureLogsForTests();

    const out = await enrichGenealogyWithArtwork(
      {
        nodes: [
          { id: "current", group: 1, label: "Song", size: 40 },
          // Malformed, as an untyped caller could send it: its lookup throws.
          { id: "bad", group: 4, label: "Bad", size: 22, trackTitle: 42, trackArtist: "Queen" },
          { size: 22, ...underPressure },
        ],
      } as unknown as Partial<Genealogy>,
      "https://i.scdn.co/image/c",
    ).finally(() => logs.restore());

    expect(out.nodes.map((node) => node.id)).toEqual(["current", "bad", "n1"]);
    expect(out.nodes.find((node) => node.id === "bad")?.img).toBeUndefined();
    expect(out.nodes.find((node) => node.id === "n1")).toMatchObject({
      img: COVER,
      spotifyId: "x",
    });
    expect(JSON.stringify(out)).not.toContain("Current Track");
    // A bug, not a source failure: logged as an error, with its stack.
    const errors = logs.entries().filter((entry) => String(entry.msg).includes('"bad"'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ level: "error", err: { type: "TypeError" } });
    expect(errors[0].err).toHaveProperty("stack");
  });
});

describe("enrichGenealogyWithArtwork's Spotify requests", () => {
  /** `count` nodes "Song n - Queen", each named, none cached. */
  const named = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `n${i + 1}`,
      group: 4,
      size: 22,
      label: `Song ${i + 1} - Queen`,
      trackTitle: `Song ${i + 1}`,
      trackArtist: "Queen",
    }));
  const searches = (net: { calls: FetchCall[] }) =>
    net.calls.filter((call) => call.url.startsWith(SEARCH_URL));

  it("gives no batch slot to a node that makes no request", async () => {
    let inFlight = 0;
    let most = 0;
    spotifyAnswers(async () => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 20));
      inFlight--;
      return json({ tracks: { items: [], total: 0 } });
    });
    const unnamed = Array.from({ length: 6 }, (_, i) => ({
      id: `u${i + 1}`,
      group: 4,
      size: 22,
      label: `Unnamed ${i + 1}`,
    }));

    await enrichGenealogyWithArtwork(
      { nodes: [{ id: "current", group: 1, label: "Song", size: 40 }, ...unnamed, ...named(5)] },
      "https://i.scdn.co/image/c",
    );

    // The five searches go out together: the analysed track and the unnamed nodes take no turn.
    expect(most).toBe(5);
  });

  it("says the pass is complete when every search was made, found or not", async () => {
    spotifyAnswers(() => json({ error: { status: 503 } }, { status: 503 }));

    const out = await enrichGenealogyWithArtwork({ nodes: named(3) }, "https://i.scdn.co/image/c");

    expect(out.complete).toBe(true);
  });

  it.each([
    [
      "a rate limit",
      () => json({ error: { status: 429 } }, { status: 429, headers: { "retry-after": "30" } }),
    ],
    ["a timeout", never],
  ])(
    "makes no more Spotify searches in the run after %s",
    async (label, answer) => {
      if (label === "a timeout") process.env.SOURCE_TIMEOUT_MS = "50";
      const net = spotifyAnswers(answer);
      const logs = captureLogsForTests();

      const out = await enrichGenealogyWithArtwork(
        { nodes: named(8) },
        "https://i.scdn.co/image/c",
      ).finally(() => logs.restore());

      // The first batch was under way; the three nodes after it are not searched.
      expect(searches(net)).toHaveLength(5);
      expect(out.nodes.map((node) => node.id)).toEqual(named(8).map((node) => node.id));
      expect(out.nodes.every((node) => node.img === undefined)).toBe(true);
      // Cut short: the result is not to be kept for later runs.
      expect(out.complete).toBe(false);
      expect(
        logs.messages().filter((msg) => msg.includes("no more Spotify searches")),
      ).toHaveLength(1);
    },
    2000,
  );
});

describe("enrichGenealogyWithArtwork's previews", () => {
  it("gives the preview of a track that is the title and artist the model named", async () => {
    spotifyAnswers(() => json(found("Under Pressure - Remastered 2011", ["Queen"], PREVIEW)));

    const node = await enrichOne(underPressure);

    expect(node).toMatchObject({ img: COVER, previewUrl: PREVIEW, spotifyId: "x" });
  });

  it.each([
    ["the model named another title", { trackTitle: "Another One Bites the Dust" }],
    ["another artist's track (a cover)", { trackArtist: "David Bowie" }],
  ])("gives no cover, Spotify id or preview when %s", async (_label, named) => {
    spotifyAnswers(() => json(found("Under Pressure", ["My Chemical Romance"], PREVIEW)));

    const node = await enrichOne({ ...underPressure, ...named });

    expect(node.img).toBeUndefined();
    expect(node.spotifyId).toBeUndefined();
    expect(node.previewUrl).toBeUndefined();
  });

  it.each([
    ["a strict match", "Under Pressure", "Queen", true],
    ["another artist's track", "Under Pressure", "My Chemical Romance", false],
    ["another version", "Under Pressure (Rah Mix)", "Queen", false],
  ])("takes the cached cover and Spotify id only for %s", async (_label, title, artist, strict) => {
    const net = spotifyAnswers(() => json(hit));
    cache.getArtwork.mockReturnValue({
      coverUrl: COVER,
      spotifyUrl: "https://open.spotify.com/track/x",
      spotifyId: "x",
      trackTitle: title,
      trackArtist: artist,
      trackDetails: NO_ISRC_DETAILS,
    });

    const node = await enrichOne(underPressure);

    expect(node.img).toBe(strict ? COVER : undefined);
    expect(node.spotifyId).toBe(strict ? "x" : undefined);
    expect(net.calls.filter((call) => call.url.startsWith(SEARCH_URL))).toHaveLength(0);
  });

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

  it("gives no preview from the cache, even from a row that holds one", async () => {
    const net = spotifyAnswers(() => json(hit));
    cache.getArtwork.mockReturnValue({
      coverUrl: COVER,
      spotifyUrl: "https://open.spotify.com/track/x",
      previewUrl: PREVIEW,
      spotifyId: "x",
      trackTitle: "Under Pressure",
      trackArtist: "Queen",
      trackDetails: NO_ISRC_DETAILS,
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
    /** How long each Spotify search takes, in ms (none when unset). */
    spotifyMs?: number;
  }) {
    const noData = { error: { type: "DataException", message: "no data", code: 800 } };
    return stubFetch(async (call: FetchCall) => {
      if (call.url === TOKEN_URL) {
        return json({ access_token: "t", token_type: "Bearer", expires_in: 3600 });
      }
      if (call.url.startsWith(SEARCH_URL)) {
        const query = new URL(call.url).searchParams.get("q") ?? "";
        if (routes.spotifyMs) await new Promise((resolve) => setTimeout(resolve, routes.spotifyMs));
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

  it("searches again for a row cached with a Spotify id and no details, and rewrites it", async () => {
    // A row whose details are missing or not valid: its release cannot be checked.
    const net = stub({ spotify: spotifyTrack(), byIsrc: () => entry() });
    cache.getArtwork.mockReturnValue({
      coverUrl: COVER,
      spotifyUrl: "https://open.spotify.com/track/live",
      spotifyId: "live",
      trackTitle: "Under Pressure",
      trackArtist: "Queen",
    });

    const node = await enrichOne(underPressure);

    expect(net.calls.filter((call) => call.url.startsWith(SEARCH_URL))).toHaveLength(1);
    expect(node).toMatchObject({ img: COVER, spotifyId: "x", previewUrl: deezerClip(7) });
    expect(cache.putArtwork).toHaveBeenCalledTimes(1);
    const [key, rewritten] = cache.putArtwork.mock.calls[0];
    expect(key).toBe(cache.getArtwork.mock.calls[0][0]);
    expect(rewritten).toMatchObject({
      spotifyId: "x",
      trackDetails: {
        isrc: ISRC,
        durationMs: 248000,
        album: "Hot Space",
        releaseDate: "1982-05-21",
      },
    });
    expect(JSON.stringify(rewritten)).not.toMatch(/dzcdn|hdnea|previewUrl|mp3-preview/);
  });

  it("serves a row cached without a Spotify id as no cover, with no search", async () => {
    const net = stub({ spotify: spotifyTrack(), byIsrc: () => entry() });
    cache.getArtwork.mockReturnValue({
      coverUrl: COVER,
      spotifyUrl: "https://open.spotify.com/track/x",
      spotifyId: null,
      trackTitle: null,
      trackArtist: null,
    });

    const node = await enrichOne(underPressure);

    // A row without the track's identity cannot be checked against the node.
    expect(node.img).toBeUndefined();
    expect(node.spotifyId).toBeUndefined();
    expect(node.previewUrl).toBeUndefined();
    expect(net.calls).toHaveLength(0);
    expect(cache.putArtwork).not.toHaveBeenCalled();
  });

  /** A row with the cover and the id of a track, and no details. */
  const oldRow = {
    coverUrl: COVER,
    spotifyUrl: "https://open.spotify.com/track/live",
    spotifyId: "live",
    trackTitle: "Under Pressure",
    trackArtist: "Queen",
  };

  it.each([
    ["fails", () => json({ error: { status: 503 } }, { status: 503 })],
    ["finds nothing", () => json({ tracks: { items: [], total: 0 } })],
  ])(
    "gives no cover from a row without details when the search again %s",
    async (_label, answer) => {
      const net = spotifyAnswers(answer);
      cache.getArtwork.mockReturnValue(oldRow);

      const node = await enrichOne(underPressure);

      expect(net.calls.filter((call) => call.url.startsWith(SEARCH_URL))).toHaveLength(1);
      expect(node.img).toBeUndefined();
      expect(node.spotifyId).toBeUndefined();
      expect(node.previewUrl).toBeUndefined();
      // The row is kept as it is, not overwritten with nothing.
      expect(cache.putArtwork).not.toHaveBeenCalled();
    },
  );

  /** An artwork row for Under Pressure by Queen, as this code caches it. */
  const cachedRow = (
    details: Record<string, unknown> = {},
    fields: Record<string, unknown> = {},
  ) => ({
    coverUrl: COVER,
    spotifyUrl: "https://open.spotify.com/track/x",
    spotifyId: "x",
    trackTitle: "Under Pressure",
    trackArtist: "Queen",
    trackArtists: ["Queen"],
    trackDetails: {
      isrc: ISRC,
      durationMs: 248000,
      album: "Hot Space",
      releaseDate: "1982-05-21",
      ...details,
    },
    ...fields,
  });

  it("gives a node served from the artwork cache the Deezer entry for its ISRC", async () => {
    const net = stub({ spotify: spotifyTrack(), byIsrc: () => entry() });
    cache.getArtwork.mockReturnValue(cachedRow());

    const node = await enrichOne(underPressure);

    expect(node).toMatchObject({ img: COVER, spotifyId: "x", previewUrl: deezerClip(7) });
    expect(net.calls.filter((call) => call.url.startsWith(SEARCH_URL))).toHaveLength(0);
    expect(deezerCalls(net).map((call) => call.url)).toEqual([`${DEEZER}/track/isrc:${ISRC}`]);
    expect(cache.putArtwork).not.toHaveBeenCalled();
  });

  it("gives a node the same preview from the row its fresh search cached", async () => {
    const net = stub({ spotify: spotifyTrack(), byIsrc: () => entry() });

    const fresh = await enrichOne(underPressure);
    const [, cached] = cache.putArtwork.mock.calls[0];
    expect(JSON.stringify(cached)).not.toMatch(/dzcdn|hdnea|previewUrl|mp3-preview/);
    cache.getArtwork.mockReturnValue(cached);
    const again = await enrichOne(underPressure);

    expect(fresh.previewUrl).toBe(deezerClip(7));
    expect(again).toEqual(fresh);
    expect(net.calls.filter((call) => call.url.startsWith(SEARCH_URL))).toHaveLength(1);
    expect(deezerCalls(net)).toHaveLength(2);
    // The two lookups ask Deezer the same: the cached row gives the request a fresh search gives.
    expect(deezerCalls(net)[0].url).toBe(deezerCalls(net)[1].url);
  });

  it.each([
    ["carries another ISRC", { isrc: "USXX19990001" }],
    ["is a live take", { title: "Under Pressure (Live at Wembley '86)" }],
    ["is credited to another artist (a cover)", { artist: { id: 1, name: "Karaoke Stars" } }],
    ["is 5 s longer", { duration: 253 }],
    ["has a preview on a host the player may not load", { preview: "https://example.com/x.mp3" }],
  ])("gives a cached node no preview when the entry for its ISRC %s", async (_label, fields) => {
    stub({ spotify: spotifyTrack(), byIsrc: () => entry(fields) });
    cache.getArtwork.mockReturnValue(cachedRow());

    const node = await enrichOne(underPressure);

    expect(node).toMatchObject({ img: COVER, spotifyId: "x" });
    expect(node.previewUrl).toBeUndefined();
  });

  it.each([
    ["a live album", { album: "Live at Wembley '86", releaseDate: "1992-05-26" }],
    ["a karaoke album", { album: "Karaoke Hits", releaseDate: "2010" }],
    ["a re-recorded album", { album: "Greatest Hits (Re-Recorded Versions)", releaseDate: "2004" }],
  ])("gives no cover from a row cached for a plain title on %s", async (_label, details) => {
    const net = stub({ spotify: spotifyTrack(), byIsrc: () => entry() });
    cache.getArtwork.mockReturnValue(cachedRow(details));

    const node = await enrichOne(underPressure);

    expect(node.img).toBeUndefined();
    expect(node.spotifyId).toBeUndefined();
    expect(node.previewUrl).toBeUndefined();
    expect(net.calls).toHaveLength(0);
  });

  it("gives no cover from a row whose details keep no album (its release cannot be checked)", async () => {
    const net = stub({ spotify: spotifyTrack(), byIsrc: () => entry() });
    cache.getArtwork.mockReturnValue(cachedRow({ album: null }));

    const node = await enrichOne(underPressure);

    expect(node.img).toBeUndefined();
    expect(node.spotifyId).toBeUndefined();
    expect(node.previewUrl).toBeUndefined();
    expect(net.calls).toHaveLength(0);
  });

  it.each([
    ["the release dates from years after the label's year", { releaseDate: "1992" }],
    ["the release date is not known", { releaseDate: null }],
    ["the track has no ISRC", { isrc: null }],
  ])("keeps a cached node's id but makes no lookup when %s", async (_label, details) => {
    const net = stub({ spotify: spotifyTrack(), byIsrc: () => entry() });
    cache.getArtwork.mockReturnValue(cachedRow(details));

    const node = await enrichOne({ ...underPressure, label: "Under Pressure - Queen (1981)" });

    expect(node).toMatchObject({ img: COVER, spotifyId: "x" });
    expect(node.previewUrl).toBeUndefined();
    expect(net.calls).toHaveLength(0);
  });

  it.each([
    ["a cover (another artist's track)", { trackArtist: "David Bowie" }],
    ["a loose match (no title or artist named)", { trackTitle: undefined }],
    ["another version", { trackTitle: "Under Pressure (Rah Mix)" }],
  ])("makes no Deezer lookup for %s served from the cache", async (_label, named) => {
    const net = stub({ spotify: spotifyTrack(), byIsrc: () => entry() });
    cache.getArtwork.mockReturnValue(cachedRow());

    const node = await enrichOne({ ...underPressure, ...named });

    expect(node.spotifyId).toBeUndefined();
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
      "a live album named so",
      "Under Pressure - Queen (1981)",
      ["Under Pressure", "Queen", "Live at Wembley '86", "1992-05-26"],
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
  ])(
    "gives no cover, Spotify id or preview for a plain title on %s",
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

      expect(node.img).toBeUndefined();
      expect(node.spotifyId).toBeUndefined();
      expect(node.previewUrl).toBeUndefined();
      expect(deezerCalls(net)).toHaveLength(0);
      // Cached without the track's identity, so a later run cannot take its id from the cache.
      const [, cached] = cache.putArtwork.mock.calls[0];
      expect(cached).toMatchObject({ coverUrl: COVER, spotifyId: null, trackTitle: null });
    },
  );

  it.each([
    [
      "a compilation",
      "Funky Drummer - James Brown (1970)",
      ["Funky Drummer", "James Brown", "In the Jungle Groove", "1986-08-01"],
    ],
    [
      "a greatest hits album",
      "Bohemian Rhapsody - Queen (1975)",
      ["Bohemian Rhapsody", "Queen", "Greatest Hits", "1981-10-26"],
    ],
    [
      "a live album whose name says nothing of it",
      "Respect - Aretha Franklin (1967)",
      ["Respect", "Aretha Franklin", "Aretha at Fillmore West", "1971-05-19"],
    ],
  ])(
    "keeps the Spotify id but plays no clip of %s from years after the label's year",
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

      expect(node).toMatchObject({ img: COVER, spotifyId: "x" });
      expect(node.previewUrl).toBeUndefined();
      expect(deezerCalls(net)).toHaveLength(0);
      const [, cached] = cache.putArtwork.mock.calls[0];
      expect(cached).toMatchObject({ spotifyId: "x", trackTitle: title });
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

  it("takes the node's year for the preview when its label names none", async () => {
    const net = stub({
      spotify: onRelease("Respect", "Aretha Franklin", "Aretha Now", "1971-05-19"),
      byIsrc: () => entryOn("Respect", "Aretha Franklin", "Aretha Now"),
    });

    const node = await enrichOne({
      id: "n1",
      group: 4,
      label: "Respect - Aretha Franklin",
      trackTitle: "Respect",
      trackArtist: "Aretha Franklin",
      year: "1967",
    });

    expect(node).toMatchObject({ img: COVER, spotifyId: "x" });
    expect(node.previewUrl).toBeUndefined();
    expect(deezerCalls(net)).toHaveLength(0);
  });

  it("takes the node's year for a cached node's preview when its label names none", async () => {
    const net = stub({ spotify: spotifyTrack(), byIsrc: () => entry() });
    cache.getArtwork.mockReturnValue(cachedRow());

    const node = await enrichOne({ ...underPressure, year: "1975" });

    expect(node).toMatchObject({ img: COVER, spotifyId: "x" });
    expect(node.previewUrl).toBeUndefined();
    expect(net.calls).toHaveLength(0);
  });

  it("rejects, and leaves no rejection unhandled, when the run is cancelled with cached and searched nodes under way", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const net = stubFetch((call: FetchCall) => {
        if (call.url === TOKEN_URL) {
          return json({ access_token: "t", token_type: "Bearer", expires_in: 3600 });
        }
        if (call.url.startsWith(SEARCH_URL) || call.url.startsWith(DEEZER)) return never(call);
        return undefined;
      });
      cache.getArtwork.mockImplementation((key: string) =>
        key.includes("queen") ? cachedRow() : null,
      );
      const controller = new AbortController();

      const pending = enrichGenealogyWithArtwork(
        {
          nodes: [
            { size: 22, ...underPressure },
            {
              id: "n2",
              group: 4,
              size: 22,
              label: "Other - X",
              trackTitle: "Other",
              trackArtist: "X",
            },
          ],
        },
        "https://i.scdn.co/image/c",
        controller.signal,
      );
      await vi.waitFor(() => {
        expect(net.calls.some((call) => call.url.startsWith(SEARCH_URL))).toBe(true);
        expect(deezerCalls(net)).toHaveLength(1);
      });
      controller.abort();

      await expect(pending).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
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
      { nodes: nodes as Genealogy["nodes"] },
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

  const previews = (out: { nodes: Array<{ previewUrl?: string }> }) =>
    out.nodes.filter((node) => node.previewUrl).length;

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

  /** The artwork row a fresh search of strictNodes' node `n` caches, read back from the cache. */
  const cachedSong = (n: number) => ({
    coverUrl: COVER,
    spotifyUrl: "https://open.spotify.com/track/x",
    spotifyId: `id${n}`,
    trackTitle: `Song ${n}`,
    trackArtist: "Queen",
    trackArtists: ["Queen"],
    trackDetails: {
      isrc: `GBXXX99${String(n).padStart(5, "0")}`,
      durationMs: 248000,
      album: "Hot Space",
      releaseDate: "1982-05-21",
    },
  });
  /** The cache holds the odd songs of strictNodes; the even ones are searched afresh. */
  const oddSongsCached = (label: string) => {
    const n = Number(label.match(/song (\d+)/)?.[1]);
    return n % 2 === 1 ? cachedSong(n) : null;
  };

  it(`counts the nodes served from the cache against the ${MAX_DEEZER_LOOKUPS} lookups of a run`, async () => {
    const { nodes, spotify, isrcEntry } = strictNodes(MAX_DEEZER_LOOKUPS + 6);
    cache.getArtwork.mockImplementation(oddSongsCached);
    const net = stub({ spotify, byIsrc: (isrc) => isrcEntry(isrc) });

    const out = await enrichAll(nodes);

    expect(net.calls.filter((call) => call.url.startsWith(SEARCH_URL))).toHaveLength(13);
    expect(deezerCalls(net)).toHaveLength(MAX_DEEZER_LOOKUPS);
    expect(previews(out)).toBe(MAX_DEEZER_LOOKUPS);
    expect(out.nodes.every((node) => node.img === COVER && node.spotifyId)).toBe(true);
  });

  it("stops the lookups of cached nodes at Deezer's rate limit too, and reports it once", async () => {
    const { nodes, spotify } = strictNodes(6);
    cache.getArtwork.mockImplementation((label: string) =>
      cachedSong(Number(label.match(/song (\d+)/)?.[1])),
    );
    const quota = { error: { type: "Exception", message: "Quota limit exceeded", code: 4 } };
    const net = stub({ spotify, byIsrc: () => quota });
    const report = vi.fn();

    const out = await enrichAll(nodes, undefined, report);

    expect(out.nodes.every((node) => node.img === COVER && node.spotifyId)).toBe(true);
    expect(previews(out)).toBe(0);
    expect(net.calls.filter((call) => call.url.startsWith(SEARCH_URL))).toHaveLength(0);
    expect(deezerCalls(net).length).toBeGreaterThanOrEqual(1);
    expect(deezerCalls(net).length).toBeLessThanOrEqual(2);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toMatchObject({ source: "deezer", code: "rate_limited" });
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
      const report = vi.fn();
      const logs = captureLogsForTests();

      const { out, elapsed, run } = await timed(nodes, report).finally(() => logs.restore());

      expect(run.aborted).toBe(false);
      expect(out.nodes).toHaveLength(10);
      expect(out.nodes.every((node) => node.img === COVER && node.spotifyId)).toBe(true);
      expect(previews(out)).toBe(4);
      expect(deezerCalls(net)).toHaveLength(5);
      expect(elapsed).toBeLessThan(PREVIEW_BUDGET_MS + 1_000);
      // A spent budget is not a Deezer failure: it is said once, in the log only.
      expect(report).not.toHaveBeenCalled();
      const said = logs
        .messages("info")
        .filter((message) => message.includes("budget for Deezer lookups"));
      expect(said).toHaveLength(1);
    });

    it("holds the lookups of cached nodes to the same budget", async () => {
      const { nodes, spotify, isrcEntry } = strictNodes(10);
      cache.getArtwork.mockImplementation((label: string) =>
        cachedSong(Number(label.match(/song (\d+)/)?.[1])),
      );
      const net = stub({ spotify, byIsrc: (isrc, call) => slowly(call, 3_000, isrcEntry(isrc)) });
      const report = vi.fn();

      const { out, elapsed, run } = await timed(nodes, report);

      expect(run.aborted).toBe(false);
      expect(net.calls.filter((call) => call.url.startsWith(SEARCH_URL))).toHaveLength(0);
      expect(out.nodes.every((node) => node.img === COVER && node.spotifyId)).toBe(true);
      expect(previews(out)).toBe(4);
      // Cached nodes wait for no Spotify batch, so the third round starts two lookups (not one):
      // the budget cuts both off.
      expect(deezerCalls(net)).toHaveLength(6);
      expect(elapsed).toBeLessThan(PREVIEW_BUDGET_MS + 1_000);
      expect(report).not.toHaveBeenCalled();
    });

    it("does not count the Spotify searches against the previews' budget", async () => {
      const { nodes, spotify, isrcEntry } = strictNodes(15);
      // Each batch of Spotify searches takes 4.5 s; Deezer answers at once.
      stub({ spotify, spotifyMs: 4_500, byIsrc: (isrc) => isrcEntry(isrc) });
      const report = vi.fn();

      const { out, elapsed } = await timed(nodes, report);

      expect(elapsed).toBeGreaterThan(PREVIEW_BUDGET_MS);
      expect(previews(out)).toBe(15);
      expect(report).not.toHaveBeenCalled();
    });
  });

  const FAKE_CLOCK = ["setTimeout", "clearTimeout", "Date", "performance"] as const;

  it.each([
    ["a node searched afresh", false],
    ["a node served from the cache", true],
  ])(
    "rejects at once when the run is cancelled during the Deezer lookup of %s, and stops it",
    async (_label, cached) => {
      vi.useFakeTimers({ toFake: [...FAKE_CLOCK] });
      try {
        const controller = new AbortController();
        const net = stub({ spotify: spotifyTrack(), byIsrc: (_isrc, call) => never(call) });
        if (cached) cache.getArtwork.mockReturnValue(cachedRow());
        let settledAt = Number.NaN;
        const pending = enrichAll([{ size: 22, ...underPressure }], controller.signal)
          .then(
            () => "resolved",
            () => "rejected",
          )
          .finally(() => {
            settledAt = pacingClock();
          });
        await vi.advanceTimersByTimeAsync(50);
        expect(deezerCalls(net)).toHaveLength(1);

        const abortedAt = pacingClock();
        controller.abort();
        await vi.advanceTimersByTimeAsync(100);

        // At once, not when the lookup's own time runs out.
        expect(settledAt - abortedAt).toBeLessThan(100);
        expect(await pending).toBe("rejected");
        expect(deezerCalls(net)[0].signal?.aborted).toBe(true);
        const searches = net.calls.filter((call) => call.url.startsWith(SEARCH_URL));
        expect(searches).toHaveLength(cached ? 0 : 1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  describe("with Deezer paced for the whole process", () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: [...FAKE_CLOCK] });
      setUnpacedForTests(false);
    });
    afterEach(() => {
      setUnpacedForTests(true);
      vi.useRealTimers();
      delete process.env.SOURCE_CASSETTE;
      delete process.env.SOURCE_CASSETTE_DIR;
    });

    /** The most of `starts` (ms) inside any window of Deezer's quota. */
    const most = (starts: number[]) =>
      Math.max(
        0,
        ...starts.map((t) => starts.filter((u) => u >= t && u < t + DEEZER_WINDOW_MS).length),
      );

    const OTHER = { title: "Song 99", artist: "Queen", isrc: "GBXXX9900099", durationMs: 248_000 };
    /** `count` node lookups of other runs, now: each takes a slot of the node previews' share. */
    async function otherNodeLookups(count: number) {
      for (let i = 0; i < count; i++) {
        await deezerPreviewByIsrc(OTHER, undefined, { lane: "nodes" });
      }
    }

    /** Runs the clock in 100 ms steps until `pending` settles (at most 20 s). */
    async function settle<T>(pending: Promise<T>): Promise<T> {
      let settled = false;
      const watched = pending.finally(() => {
        settled = true;
      });
      for (let i = 0; i < 200 && !settled; i++) await vi.advanceTimersByTimeAsync(100);
      return watched;
    }

    const cachedSongs = () =>
      cache.getArtwork.mockImplementation((label: string) =>
        cachedSong(Number(label.match(/song (\d+)/)?.[1])),
      );

    it("serves the analysed tracks' requests first, and keeps the process under Deezer's quota", async () => {
      const { nodes, spotify, isrcEntry } = strictNodes(2 * MAX_DEEZER_LOOKUPS);
      cachedSongs();
      const analysedIsrc = (n: number) => `GBXXX98${String(n).padStart(5, "0")}`;
      const isAnalysed = (isrc: string) => isrc.startsWith("GBXXX98");
      const t0 = pacingClock();
      const starts: Array<{ at: number; isrc: string }> = [];
      const net = stub({
        spotify,
        byIsrc: (isrc) => {
          starts.push({ at: pacingClock() - t0, isrc });
          return isAnalysed(isrc)
            ? entry({ id: 900 + Number(isrc.slice(-5)), title: "Analysed", isrc })
            : isrcEntry(isrc);
        },
      });
      // The engineer's own lookup of an analysed track's preview.
      const analyse = (n: number) =>
        resolvePreview(
          { title: "Analysed", artist: "Queen", isrc: analysedIsrc(n), durationMs: 248_000 },
          undefined,
        );
      const report = vi.fn();

      // Twelve runs' analysed tracks, then two runs whose genealogies are all in the cache.
      const first = Array.from({ length: 12 }, (_, i) => analyse(i + 1));
      const runs = Promise.all([
        enrichAll(nodes.slice(0, MAX_DEEZER_LOOKUPS), undefined, report),
        enrichAll(nodes.slice(MAX_DEEZER_LOOKUPS), undefined, report),
      ]);
      await vi.advanceTimersByTimeAsync(1_000);
      // Three more while node lookups wait for room in the window.
      const later = Array.from({ length: 3 }, (_, i) => analyse(13 + i));
      const [a, b] = await settle(runs);
      const analysed = await settle(Promise.all([...first, ...later]));

      expect(analysed.map((result) => result.previewUrl)).toEqual(
        Array.from({ length: 15 }, (_, i) => deezerClip(901 + i)),
      );
      // No window holds more than the process may send, nor more node requests than their share.
      expect(most(starts.map((start) => start.at))).toBeLessThanOrEqual(DEEZER_MAX_PER_WINDOW);
      const nodeStarts = starts.filter((start) => !isAnalysed(start.isrc));
      expect(most(nodeStarts.map((start) => start.at))).toBeLessThanOrEqual(
        DEEZER_NODE_MAX_PER_WINDOW,
      );
      // The first twelve started at once; the three later ones as soon as the window had room,
      // ahead of every node request that was waiting for it.
      const analysedStarts = starts.filter((start) => isAnalysed(start.isrc));
      expect(analysedStarts.slice(0, 12).every((start) => start.at < 50)).toBe(true);
      expect(analysedStarts.slice(12).every((start) => start.at <= DEEZER_WINDOW_MS + 50)).toBe(
        true,
      );
      let lastAnalysed = -1;
      starts.forEach((start, i) => {
        if (isAnalysed(start.isrc)) lastAnalysed = i;
      });
      // The node requests that started after the later three were made (at 1 s) were waiting.
      const waited = starts.flatMap((start, i) =>
        !isAnalysed(start.isrc) && start.at >= 1_000 ? [i] : [],
      );
      expect(waited.length).toBeGreaterThan(0);
      expect(waited.every((i) => i > lastAnalysed)).toBe(true);
      // Every node still got its preview, within its run's budget.
      expect(net.calls.filter((call) => call.url.startsWith(SEARCH_URL))).toHaveLength(0);
      expect(previews(a) + previews(b)).toBe(2 * MAX_DEEZER_LOOKUPS);
      expect(report).not.toHaveBeenCalled();
    });

    it("says the preview lookup could not be finished, with no source error, when the pace has no slot for an analysed track in time", async () => {
      stub({ spotify: spotifyTrack(), byIsrc: (isrc) => entry({ isrc }) });
      const request = { title: "Under Pressure", artist: "Queen", durationMs: 248_000 };
      // A full window, and as many requests again waiting for the next one.
      const ahead = Array.from({ length: 2 * DEEZER_MAX_PER_WINDOW }, () =>
        deezerPreviewByIsrc({ ...request, isrc: "GBUM71029601" }),
      );

      const result = await resolvePreview({ ...request, isrc: "GBUM71029601" }, undefined);

      expect(result).toMatchObject({ previewUrl: null, incomplete: true });
      expect(result).not.toHaveProperty("sourceError");
      expect(result.previewUrl === null && result.detail).toMatch(
        /preview lookup on Deezer could not be finished/,
      );
      await settle(Promise.all(ahead));
    });

    it("gives a node lookup a slot that comes within its time", async () => {
      const { nodes, spotify, isrcEntry } = strictNodes(3);
      cachedSongs();
      const net = stub({ spotify, byIsrc: (isrc) => isrcEntry(isrc) });
      // Other runs took the node previews' share 2.5 s ago: the next slot is in 2.5 s.
      await otherNodeLookups(DEEZER_NODE_MAX_PER_WINDOW);
      await vi.advanceTimersByTimeAsync(2_500);
      const before = deezerCalls(net).length;

      const out = await settle(enrichAll(nodes));

      expect(deezerCalls(net).length - before).toBe(3);
      expect(previews(out)).toBe(3);
    });

    it("starts a lookup's own time when its request gets its slot, not while it waits", async () => {
      const { nodes, spotify, isrcEntry } = strictNodes(3);
      cachedSongs();
      let slow = false;
      const net = stub({
        spotify,
        byIsrc: (isrc, call) => (slow ? slowly(call, 1_500, isrcEntry(isrc)) : isrcEntry(isrc)),
      });
      await otherNodeLookups(DEEZER_NODE_MAX_PER_WINDOW);
      slow = true;
      await vi.advanceTimersByTimeAsync(2_100);
      const before = deezerCalls(net).length;
      const report = vi.fn();

      // Two lookups wait 2.9 s for their slots, then Deezer answers in 1.5 s: 4.4 s in all.
      const out = await settle(enrichAll(nodes, undefined, report));

      expect(deezerCalls(net).length - before).toBe(3);
      expect(previews(out)).toBe(3);
      expect(report).not.toHaveBeenCalled();
    });

    /**
     * Strict cached nodes; the first's ISRC entry cannot be played and names a readable
     * alternative (id 8).
     */
    function firstWithAlternative(count: number) {
      const { nodes, spotify, isrcEntry } = strictNodes(count);
      cachedSongs();
      const net = stub({
        spotify,
        byIsrc: (isrc) =>
          isrc === "GBXXX9900001"
            ? entry({ id: 1, title: "Song 1", isrc, readable: false, alternative: { id: 8 } })
            : isrcEntry(isrc),
        byId: (id) => (id === 8 ? entry({ id: 8, title: "Song 1", isrc: "GBXXX9900001" }) : null),
      });
      return { nodes, net };
    }
    const alternativeCalls = (calls: FetchCall[]) =>
      calls.filter(
        (call) => call.url.startsWith(DEEZER) && /^\/track\/\d+$/.test(new URL(call.url).pathname),
      );

    it("counts a lookup whose alternative the pace refused after its ISRC request was sent", async () => {
      const { nodes, net } = firstWithAlternative(MAX_DEEZER_LOOKUPS + 1);
      // 29 node requests of other runs: the first node's ISRC request takes the share's last
      // slot, and its alternative's would come after its own time (less the margin).
      await otherNodeLookups(DEEZER_NODE_MAX_PER_WINDOW - 1);
      const before = deezerCalls(net).length;
      const logs = captureLogsForTests();

      const out = await settle(enrichAll(nodes)).finally(() => logs.restore());

      const sent = deezerCalls(net).slice(before);
      // The first node's lookup was made (its ISRC request was sent): it counts against the
      // cap, so 19 more are made and the 21st node gets none.
      expect(sent.filter((call) => call.url.includes("/track/isrc:"))).toHaveLength(
        MAX_DEEZER_LOOKUPS,
      );
      expect(alternativeCalls(sent)).toHaveLength(0);
      expect(out.nodes[0].previewUrl).toBeUndefined();
      expect(previews(out)).toBe(MAX_DEEZER_LOOKUPS - 1);
      // Nor is it said to be skipped.
      expect(logs.messages("info").some((line) => line.includes("no slot in time"))).toBe(false);
    });

    it.each([
      [`less than ${START_MARGIN_MS} ms of the lookup's own time`, 1_500, 0],
      [`${START_MARGIN_MS} ms of it or more`, 2_500, 1],
    ])("refuses a request whose slot would leave %s", async (_label, after, made) => {
      // 29 node requests of other runs, `after` ms before the lookup: its ISRC request takes the
      // share's last slot, and its alternative's is free when those leave the window (at 5 s).
      const { nodes, net } = firstWithAlternative(1);
      await otherNodeLookups(DEEZER_NODE_MAX_PER_WINDOW - 1);
      await vi.advanceTimersByTimeAsync(after);
      const before = deezerCalls(net).length;

      const out = await settle(enrichAll(nodes));

      expect(alternativeCalls(deezerCalls(net).slice(before))).toHaveLength(made);
      expect(previews(out)).toBe(made);
    });

    it("rejects at once when the run is cancelled while a lookup waits for its slot, and takes no slot", async () => {
      const { nodes, spotify, isrcEntry } = strictNodes(1);
      cachedSongs();
      const net = stub({ spotify, byIsrc: (isrc) => isrcEntry(isrc) });
      await otherNodeLookups(DEEZER_NODE_MAX_PER_WINDOW);
      await vi.advanceTimersByTimeAsync(2_500);
      const before = deezerCalls(net).length;
      const controller = new AbortController();
      let settledAt = Number.NaN;
      const pending = enrichAll(nodes, controller.signal)
        .then(
          () => "resolved",
          () => "rejected",
        )
        .finally(() => {
          settledAt = pacingClock();
        });
      await vi.advanceTimersByTimeAsync(500);

      const abortedAt = pacingClock();
      controller.abort();
      await vi.advanceTimersByTimeAsync(10);

      expect(settledAt - abortedAt).toBeLessThan(100);
      expect(await pending).toBe("rejected");
      expect(deezerCalls(net).length - before).toBe(0);
      // It took no slot: a node lookup now gets the next one, in 2 s.
      const next = deezerPreviewByIsrc(OTHER, undefined, {
        lane: "nodes",
        notAfter: () => pacingClock() + 2_100,
      });
      await vi.advanceTimersByTimeAsync(2_100);
      await next;
      expect(deezerCalls(net).length - before).toBe(1);
    });

    it("rejects at once when the run is cancelled while an analysed track's lookup waits for its slot", async () => {
      const net = stub({ spotify: spotifyTrack(), byIsrc: (isrc) => entry({ isrc }) });
      const request = { title: "Under Pressure", artist: "Queen", durationMs: 248_000 };
      for (let i = 0; i < DEEZER_MAX_PER_WINDOW; i++) {
        await deezerPreviewByIsrc({ ...request, isrc: "GBUM71029601" });
      }
      const before = deezerCalls(net).length;
      const controller = new AbortController();
      let settledAt = Number.NaN;
      const pending = resolvePreview({ ...request, isrc: "GBUM71029601" }, controller.signal)
        .then(
          () => "resolved",
          () => "rejected",
        )
        .finally(() => {
          settledAt = pacingClock();
        });
      await vi.advanceTimersByTimeAsync(500);

      const abortedAt = pacingClock();
      controller.abort();
      await vi.advanceTimersByTimeAsync(10);

      expect(settledAt - abortedAt).toBeLessThan(100);
      expect(await pending).toBe("rejected");
      expect(deezerCalls(net).length - before).toBe(0);
    });

    it("does not pace replayed answers: nothing reaches Deezer", async () => {
      const dir = mkdtempSync(join(tmpdir(), "liner-notes-replay-"));
      process.env.SOURCE_CASSETTE = "replay";
      process.env.SOURCE_CASSETTE_DIR = dir;
      try {
        const outcomes = await Promise.all(
          Array.from({ length: DEEZER_MAX_PER_WINDOW + 5 }, (_, i) =>
            deezerPreviewByIsrc(
              { ...OTHER, isrc: `GBXXX97${String(i).padStart(5, "0")}` },
              undefined,
              { lane: "nodes", notAfter: () => pacingClock() },
            ).then(
              () => "answered",
              (error: unknown) => (error instanceof PaceRefused ? "refused" : "missed"),
            ),
          ),
        );

        // Every lookup is answered from the cassette (here: none recorded) at once.
        expect(outcomes.every((outcome) => outcome === "missed")).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("keeps a link a Deezer error echoes out of the warning and the source error", async () => {
    const echoed = deezerClip(9);
    stub({
      spotify: spotifyTrack(),
      byIsrc: () => ({ error: { type: "Exception", message: `bad link ${echoed}`, code: 100 } }),
    });
    const report = vi.fn();
    const logs = captureLogsForTests();

    const out = await enrichAll([{ size: 22, ...underPressure }], undefined, report).finally(() =>
      logs.restore(),
    );

    expect(out.nodes[0].previewUrl).toBeUndefined();
    const warned = JSON.stringify(logs.messages("warn"));
    expect(warned).toContain("Deezer");
    expect(warned).not.toMatch(/dzcdn|hdnea/);
    expect(report).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(report.mock.calls)).not.toMatch(/dzcdn|hdnea/);
  });

  it("keeps the Deezer preview out of the artwork cache and the logs", async () => {
    stub({ spotify: spotifyTrack(), byIsrc: () => entry() });
    const lines = captureLogsForTests({ level: "debug" });

    const node = await enrichOne(underPressure).finally(() => lines.restore());

    expect(node.previewUrl).toBe(deezerClip(7));
    expect(cache.putArtwork).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(cache.putArtwork.mock.calls)).not.toMatch(/dzcdn|hdnea|previewUrl/);
    const logged = JSON.stringify([
      ...(["log", "warn", "error", "info", "debug"] as const).flatMap((method) =>
        vi.isMockFunction(console[method]) ? vi.mocked(console[method]).mock.calls : [],
      ),
      ...lines.lines(),
    ]);
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

describe("marksOtherRecording", () => {
  it.each([
    ["Live at Wembley '86", "Under Pressure", true],
    ["Live in Paris", "Respect", true],
    ["Alive (Live)", "Alive", true],
    ["Greatest Hits - Live", "Respect", true],
    ["MTV Unplugged In New York", "About A Girl", true],
    ["Elvis in Concert", "Hound Dog", true],
    ["Greatest Hits (Re-Recorded Versions)", "Rock the Boat", true],
    ["Karaoke Hits", "Rock the Boat", true],
    ["A Tribute to Queen", "Under Pressure", true],
    ["Covers", "Respect", true],
    // A bare "live" or "sessions" in a studio album's name.
    ["Long Live the Kane", "Ain't No Half-Steppin'", false],
    ["Live Through This", "Doll Parts", false],
    ["Long Live Rock 'n' Roll", "Kill the King", false],
    ["The Sun Sessions", "That's All Right", false],
    ["Live Killers", "Bohemian Rhapsody", false],
    // A phrase the title itself carries, in an album named after the title.
    ["Live in the Moment", "Live in the Moment", false],
    ["Live and Let Die", "Live and Let Die - 2018 Remaster", false],
    // A title's word does not excuse another phrase of the album.
    ["Live in Paris", "Live in the Moment", true],
    ["Covers", "Cover Me", true],
    [undefined, "Respect", false],
  ])("%j for %j: %s", (album, title, marked) => {
    expect(marksOtherRecording(album, title)).toBe(marked);
  });
});

describe("releaseYearFits", () => {
  it.each([
    ["no year named", "Respect - Aretha Franklin", "1971", true],
    ["the named year", "Respect - Aretha Franklin (1967)", "1967-03-10", true],
    ["a year after the named one", "Respect - Aretha Franklin (1967)", "1968", true],
    ["four years after", "Respect - Aretha Franklin (1967)", "1971-05-19", false],
    ["years before", "Respect - Aretha Franklin (1967)", "1960", false],
    ["an unknown release date", "Respect - Aretha Franklin (1967)", "", false],
    ["a release date of zeros", "Respect - Aretha Franklin (1967)", "0000", false],
    ["the last of two years named", "1999 (1982) - Prince (1983)", "1983", true],
    ["not the first of two years named", "1999 (1982) - Prince (1990)", "1982", false],
    ["a year in square brackets", "Hotel California - Eagles [1976]", "1994", false],
    ["a year with a note", "Respect - Aretha Franklin (1967 single)", "1971", false],
    ["a span of years", "Respect - Aretha Franklin (1967–68)", "1971", false],
  ])("for %s: %j released %j: %s", (_label, label, released, fits) => {
    expect(releaseYearFits(label, released)).toBe(fits);
  });

  it.each([
    [
      "the node's year when the label names none",
      "Respect - Aretha Franklin",
      "1967",
      "1971",
      false,
    ],
    ["the node's year, a release within a year", "Respect - Aretha Franklin", "1967", "1968", true],
    [
      "the label's year before the node's",
      "Respect - Aretha Franklin (1971)",
      "1967",
      "1971",
      true,
    ],
    ["no year at all", "Respect - Aretha Franklin", null, "1971", true],
  ])("takes %s: %j, year %j, released %j: %s", (_label, label, year, released, fits) => {
    expect(releaseYearFits(label, released, year)).toBe(fits);
  });
});

describe("strictlyMatches", () => {
  const track = (title: string, artistNames: string[]) => ({
    title,
    artist: artistNames.join(", "),
    artistNames,
  });

  it("accepts the named title by the named credit, release labels aside", () => {
    expect(strictlyMatches(underPressure, track("Under Pressure", ["Queen"]))).toBe(true);
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
      "Daft Punk feat. Pharrell Williams & Nile Rodgers",
      "Get Lucky (feat. Pharrell Williams & Nile Rodgers)",
      ["Daft Punk", "Pharrell Williams", "Nile Rodgers"],
      true,
    ],
    // A credited artist the node does not name: taken for another recording.
    [
      "Daft Punk feat. Pharrell Williams",
      "Get Lucky (feat. Pharrell Williams & Nile Rodgers)",
      ["Daft Punk", "Pharrell Williams", "Nile Rodgers"],
      false,
    ],
    ["Earth, Wind & Fire", "September", ["Earth, Wind & Fire"], true],
    // The credit's first artist must be the lead, and every one of them credited.
    ["David Bowie & Queen", "Under Pressure", ["Queen", "David Bowie"], false],
    ["Queen & Freddie Mercury", "Under Pressure", ["Queen", "David Bowie"], false],
  ])("matches the credit %j against %j by %j: %s", (artist, title, names, expected) => {
    const node = { trackTitle: title.replace(/ \(feat\..*\)$/, ""), trackArtist: artist };
    expect(strictlyMatches(node, track(title, names))).toBe(expected);
  });

  it("refuses a plain title on an album named as other recordings", () => {
    const found = { ...track("Bohemian Rhapsody", ["Queen"]), album: "Live at Wembley '86" };
    const node = { trackTitle: "Bohemian Rhapsody", trackArtist: "Queen" };
    expect(strictlyMatches(node, found)).toBe(false);
    expect(strictlyMatches(node, { ...found, album: "A Night at the Opera" })).toBe(true);
    // A studio album with a live word in its name: an honest miss.
    expect(strictlyMatches(node, { ...found, album: "Long Live Queen" })).toBe(false);
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
