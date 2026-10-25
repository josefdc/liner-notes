/**
 * Replay reproduces the recorded run. Each source's real tool runs once against a stubbed API
 * with SOURCE_CASSETTE=record, then again with SOURCE_CASSETTE=replay and no network; the two
 * tool results must be byte-identical. The answers are real captures (fixtures/) or carry the
 * values a scrubber could damage: MBIDs and Spotify ids, years and dates, a phone-number-like
 * title, an e-mail address in text, and text longer than consumers read.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import earthWindFire from "./fixtures/musicbrainz-artist-search-earth-wind-fire.json" with {
  type: "json",
};
import iceLookup from "./fixtures/musicbrainz-recording-ice-ice-baby.json" with { type: "json" };
import iceToTheExtreme from "./fixtures/musicbrainz-recording-search-ice-ice-baby-to-the-extreme.json" with {
  type: "json",
};
import backInBlack from "./fixtures/musicbrainz-recording-search-back-in-black.json" with {
  type: "json",
};
import similarArtists from "./fixtures/listenbrainz-similar-artists.json" with { type: "json" };
import { type FetchRoute, json, stubFetch } from "./testing/fetchStub.js";

vi.hoisted(() => {
  process.env.SPOTIFY_CLIENT_ID = "test-client";
  process.env.SPOTIFY_CLIENT_SECRET = "test-secret";
  process.env.TAVILY_API_KEY = "tvly-test-key";
  process.env.LASTFM_API_KEY = "test-lastfm-key";
});

import { getLastfmArtistInfo, getLastfmSimilarArtists } from "./lastfm.js";
import { getListenBrainzSimilarArtists } from "./listenbrainz.js";
import {
  getMusicBrainzArtist,
  getMusicBrainzRelations,
  MusicBrainzRateLimiter,
} from "./musicbrainz.js";
import { searchSamples } from "./search.js";
import { SpotifyAuthManager, searchTracks } from "./spotify.js";

const DAFT_PUNK = "056e4f3e-d505-4dad-8ec1-d04f521cbb56";
const ICE_ICE_BABY = "875c24bc-fe9e-4ac6-80d3-beaacb70ee43";
const EWF = "535afeda-2538-435d-9dd1-5e10be586774";

let dir: string;

/** Runs `run` recording, then replaying; returns the live result after comparing the two. */
async function roundTrip(route: FetchRoute, run: () => Promise<string>): Promise<string> {
  process.env.SOURCE_CASSETTE = "record";
  stubFetch(route);
  const live = await run();

  process.env.SOURCE_CASSETTE = "replay";
  SpotifyAuthManager.getInstance().clearToken();
  const net = stubFetch(() => undefined);
  const replayed = await run();

  expect(net.calls, "network calls during replay").toHaveLength(0);
  expect(replayed).toBe(live);
  return live;
}

const cassette = (source: string) =>
  JSON.parse(readFileSync(join(dir, `${source}.json`), "utf8")).entries as Record<
    string,
    { json?: unknown }
  >;

describe("replay reproduces the recorded run", () => {
  beforeAll(() => {
    MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
  });
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "replay-"));
    process.env.SOURCE_CASSETTE_DIR = dir;
    SpotifyAuthManager.getInstance().clearToken();
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
  });
  afterEach(() => {
    delete process.env.SOURCE_CASSETTE;
    delete process.env.SOURCE_CASSETTE_DIR;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ListenBrainz: a live answer of 100 artists, every MBID kept", async () => {
    const live = await roundTrip(
      (call) =>
        call.url.startsWith("https://labs.api.listenbrainz.org/")
          ? json(similarArtists)
          : undefined,
      () => getListenBrainzSimilarArtists.invoke({ artistMbid: DAFT_PUNK }),
    );

    expect(JSON.parse(live).found).toBe(true);
    const [recorded] = Object.values(cassette("listenbrainz"));
    expect(recorded.json).toEqual(similarArtists);
  });

  it("MusicBrainz: a recording narrowed by album, and its sample relations", async () => {
    const live = await roundTrip(
      (call) => {
        if (call.url.startsWith("https://musicbrainz.org/ws/2/recording?")) {
          return json(iceToTheExtreme);
        }
        if (call.url.startsWith(`https://musicbrainz.org/ws/2/recording/${ICE_ICE_BABY}?`)) {
          return json(iceLookup);
        }
        return undefined;
      },
      () =>
        getMusicBrainzRelations.invoke({
          title: "Ice Ice Baby",
          artist: "Vanilla Ice",
          album: "To the Extreme",
        }),
    );

    expect(JSON.parse(live)).toMatchObject({ found: true, mbid: ICE_ICE_BABY });
  });

  it("MusicBrainz: an ambiguous search", async () => {
    const live = await roundTrip(
      (call) =>
        call.url.startsWith("https://musicbrainz.org/ws/2/recording?")
          ? json(backInBlack)
          : undefined,
      () => getMusicBrainzRelations.invoke({ title: "Back in Black", artist: "AC/DC" }),
    );

    expect(JSON.parse(live)).toMatchObject({ found: false, reason: "ambiguous" });
  });

  it("MusicBrainz: an artist and its collaborators", async () => {
    const live = await roundTrip(
      (call) => {
        if (call.url.startsWith("https://musicbrainz.org/ws/2/artist?")) return json(earthWindFire);
        if (call.url.startsWith(`https://musicbrainz.org/ws/2/artist/${EWF}?`)) {
          return json({
            id: EWF,
            name: "Earth, Wind & Fire",
            type: "Group",
            country: "US",
            relations: [
              {
                type: "member of band",
                artist: { id: "0aa8294b-6332-4b65-b677-e3a1f8591d3b", name: "Maurice White" },
              },
              {
                type: "producer",
                artist: { id: "23d89243-5f5a-4b7c-a1c7-9a1b2c3d4e5f", name: "Charles Stepney" },
              },
            ],
          });
        }
        return undefined;
      },
      () => getMusicBrainzArtist.invoke({ artistName: "Earth, Wind & Fire" }),
    );

    expect(JSON.parse(live)).toMatchObject({ found: true, mbid: EWF });
  });

  it("Tavily: a snippet longer than consumers read, with years, dates and numbers", async () => {
    const paragraph =
      "Recorded in 1989-1990 at Mixx Studios, the single was released on 1990-09-04 (catalogue " +
      "SBK 07335, ISRC USSB10000001). Its bass line is the one from Under Pressure (1981). " +
      'Reviewers compared it to "1-800-273-8255" by Logic, released 2017-04-28, and fans wrote ' +
      "to booking@example.org or called +1 (555) 123-4567 for tickets. ";
    const content = `${paragraph.repeat(2)}The 2008 remaster and the 2020 edition followed.`;
    expect(content.length).toBeGreaterThan(600);

    const live = await roundTrip(
      (call) =>
        call.url === "https://api.tavily.com/search"
          ? json({
              results: [
                {
                  title: "Ice Ice Baby — production history",
                  url: "https://en.wikipedia.org/wiki/Ice_Ice_Baby",
                  content,
                  score: 0.9,
                },
              ],
            })
          : undefined,
      () => searchSamples.invoke({ songTitle: "Ice Ice Baby", artistName: "Vanilla Ice" }),
    );

    expect(live).toContain("1-800-273-8255");
    expect(live).toContain("booking@example.org");
  });

  it("Spotify: a search with ids and a phone-number-like title", async () => {
    const track = (id: string, name: string, artist: string, artistId: string) => ({
      id,
      name,
      artists: [{ id: artistId, name: artist }],
      album: { name: "Everybody", release_date: "2017-05-05", images: [] },
      popularity: 71,
      duration_ms: 250_173,
      explicit: true,
      external_urls: { spotify: `https://open.spotify.com/track/${id}` },
    });
    const live = await roundTrip(
      (call) => {
        if (call.url === "https://accounts.spotify.com/api/token") {
          return json({
            access_token: "live-access-token-0123456789",
            token_type: "Bearer",
            expires_in: 3600,
          });
        }
        if (call.url.startsWith("https://api.spotify.com/v1/search?")) {
          return json({
            tracks: {
              items: [
                track(
                  "5tz69p7tJuGPeMGwNTxYuV",
                  "1-800-273-8255",
                  "Logic",
                  "4xRYI6VqpkE3UwrDrAZL8L",
                ),
                track(
                  "3Fcfwhm8oRrBvBZ8KGhtea",
                  "Ice Ice Baby",
                  "Vanilla Ice",
                  "7GaxyUddsPok8BuhxN6OUW",
                ),
              ],
              total: 2,
            },
          });
        }
        return undefined;
      },
      async () => JSON.stringify(await searchTracks("1-800-273-8255")),
    );

    expect(JSON.parse(live)[0]).toMatchObject({
      id: "5tz69p7tJuGPeMGwNTxYuV",
      title: "1-800-273-8255",
    });
  });

  it("Last.fm: similar artists with MBIDs, and an artist biography", async () => {
    const lastfm: FetchRoute = (call) => {
      if (!call.url.startsWith("https://ws.audioscrobbler.com/")) return undefined;
      const method = new URL(call.url).searchParams.get("method");
      if (method === "artist.getSimilar") {
        return json({
          similarartists: {
            artist: similarArtists.slice(0, 5).map((a, i) => ({
              name: a.name,
              mbid: a.artist_mbid,
              match: String(1 - i / 10),
            })),
          },
        });
      }
      return json({
        artist: {
          name: "Vanilla Ice",
          mbid: "f2fb0ff0-5679-42ec-a55c-15109ce6e320",
          stats: { listeners: "1203456", playcount: "9876543" },
          bio: {
            summary:
              "Robert Matthew Van Winkle (born October 31, 1967), known as Vanilla Ice, is an " +
              "American rapper. Ice Ice Baby (1990) was the first hip hop single to top the " +
              "Billboard Hot 100. Contact: 1-800-555-0199. ".repeat(3),
          },
          tags: { tag: [{ name: "hip-hop" }, { name: "90s" }] },
          similar: {
            artist: [{ name: "MC Hammer", mbid: "3aa4b5c6-0000-4000-8000-1990000005a1" }],
          },
        },
      });
    };

    await roundTrip(lastfm, () => getLastfmSimilarArtists.invoke({ artist: "Daft Punk" }));
    const info = await roundTrip(lastfm, () =>
      getLastfmArtistInfo.invoke({ artist: "Vanilla Ice" }),
    );

    expect(JSON.parse(info).bio).toContain("1967");
  });
});
