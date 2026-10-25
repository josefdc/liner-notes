/**
 * MusicBrainz client with a stubbed API: queries are Lucene-escaped, a search without a
 * matching recording is "not found" (never the first hit), requests carry a real User-Agent,
 * and a request that never answers times out instead of stalling the queue.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type FetchCall, json, never, stubFetch } from "./testing/fetchStub.js";
import { queueOnFakeClock, settleOnFakeClock } from "./testing/fakeClock.js";

vi.hoisted(() => {
  // So a local .env cannot set the User-Agent under test.
  process.env.MUSICBRAINZ_USER_AGENT = "";
  process.env.SOURCE_USER_AGENT = "";
});

import earthWindFire from "./fixtures/musicbrainz-artist-search-earth-wind-fire.json" with {
  type: "json",
};
import tylerTheCreator from "./fixtures/musicbrainz-artist-search-tyler-the-creator.json" with {
  type: "json",
};
import mcgee from "./fixtures/musicbrainz-recording-search-me-and-bobby-mcgee.json" with {
  type: "json",
};
import iceDetails from "./fixtures/musicbrainz-recording-details-ice-ice-baby.json" with {
  type: "json",
};
import underPressureDetails from "./fixtures/musicbrainz-recording-details-under-pressure.json" with {
  type: "json",
};
import iceLookup from "./fixtures/musicbrainz-recording-ice-ice-baby.json" with { type: "json" };
import iceSearch from "./fixtures/musicbrainz-recording-search-ice-ice-baby.json" with {
  type: "json",
};
import iceToTheExtreme from "./fixtures/musicbrainz-recording-search-ice-ice-baby-to-the-extreme.json" with {
  type: "json",
};
import backInBlack from "./fixtures/musicbrainz-recording-search-back-in-black.json" with {
  type: "json",
};
import {
  escapeLucene,
  findArtist,
  getMusicBrainzArtist,
  getMusicBrainzRelations,
  MusicBrainzRateLimiter,
} from "./musicbrainz.js";
import { getListenBrainzSimilarArtists } from "./listenbrainz.js";

const MB = "https://musicbrainz.org/ws/2";
const RECORDING_ID = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
const SAMPLED_ID = "32c7e292-14f1-4080-bddf-ef852e0a4c59";

const ORIGINAL_RELEASE = {
  title: "To the Extreme",
  date: "1990",
  status: "Official",
  "release-group": { "primary-type": "Album", "secondary-types": [] as string[] },
};

const recording = (title: string, artist: string, id = RECORDING_ID) => ({
  id,
  title,
  score: 100,
  "artist-credit": [
    { name: artist, artist: { id: "f2fb0ff0-5679-42ec-a55c-15109ce6e320", name: artist } },
  ],
  // An original release (an album, not a compilation or live release).
  releases: [ORIGINAL_RELEASE],
});

const lookup = {
  ...recording("Ice Ice Baby", "Vanilla Ice"),
  relations: [
    {
      type: "samples material",
      "type-id": "9efd9ce9-e702-448b-8e76-641515e8fe62",
      direction: "forward",
      recording: { id: SAMPLED_ID, title: "Under Pressure" },
      "target-credit": "Queen & David Bowie",
    },
  ],
};

/** Answers recording searches with `found` and the lookup with `lookup`. */
function musicbrainz(found: unknown[], onSearch?: (call: FetchCall) => void) {
  return stubFetch((call) => {
    if (call.url.startsWith(`${MB}/recording?`)) {
      onSearch?.(call);
      return json({ count: found.length, recordings: found });
    }
    if (call.url.startsWith(`${MB}/recording/${RECORDING_ID}?`)) return json(lookup);
    return undefined;
  });
}

const searchQuery = (call: FetchCall) => new URL(call.url).searchParams.get("query");

describe("MusicBrainz client", () => {
  let restoreInterval: (() => void) | undefined;

  beforeAll(() => {
    // Keeps the tests fast; the spacing itself is MusicBrainz policy, not under test here.
    const limiter = MusicBrainzRateLimiter.getInstance() as unknown as {
      setIntervalForTests?: (ms: number) => () => void;
    };
    restoreInterval = limiter.setIntervalForTests?.(0);
  });
  afterAll(() => restoreInterval?.());
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete process.env.SOURCE_TIMEOUT_MS;
  });

  it("finds the recording and its sample relations", async () => {
    musicbrainz([recording("Ice Ice Baby", "Vanilla Ice")]);

    const data = JSON.parse(
      await getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
    );

    expect(data).toMatchObject({ found: true, mbid: RECORDING_ID });
    expect(data.genealogy.samples).toEqual([
      expect.objectContaining({ title: "Under Pressure", mbid: SAMPLED_ID, direction: "source" }),
    ]);
  });

  it.each([
    "Ice Ice Baby - Radio Edit",
    "Ice Ice Baby - Remastered 2011",
    "Ice Ice Baby - 2009 Remaster",
    "Ice Ice Baby (Remastered)",
    "Ice Ice Baby - Single Version",
    "Ice Ice Baby - Mono",
  ])("searches and matches %j as the recording without its release label", async (title) => {
    let query: string | null = null;
    musicbrainz([recording("Ice Ice Baby", "Vanilla Ice")], (call) => {
      query = searchQuery(call);
    });

    const data = JSON.parse(await getMusicBrainzRelations.invoke({ title, artist: "Vanilla Ice" }));

    expect(query).toContain('recording:"Ice Ice Baby"');
    expect(data).toMatchObject({ found: true, mbid: RECORDING_ID });
  });

  it.each([
    ["(radio edit)", 5],
    ["(single version)", 1],
  ])(
    "for a plain title, picks the recording filed without a label over one titled %s",
    async (label, releases) => {
      const EDIT_ID = "6c22f4ce-a62d-471e-81fc-a69a8278c7db";
      const edit = {
        ...recording(`Ice Ice Baby ${label}`, "Vanilla Ice", EDIT_ID),
        // On more releases (compilations) than the original, or as many.
        releases: Array.from({ length: releases }, () => ORIGINAL_RELEASE),
      };
      musicbrainz([recording("Ice Ice Baby", "Vanilla Ice"), edit]);

      const data = JSON.parse(
        await getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
      );

      expect(data).toMatchObject({ found: true, mbid: RECORDING_ID });
    },
  );

  it.each(["Ice Ice Baby - Live", "Ice Ice Baby - Remix", "Ice Ice Baby (Extended Mix)"])(
    "keeps %j, another recording, from matching the original",
    async (title) => {
      musicbrainz([recording("Ice Ice Baby", "Vanilla Ice")]);

      const data = JSON.parse(
        await getMusicBrainzRelations.invoke({ title, artist: "Vanilla Ice" }),
      );

      expect(data.found).toBe(false);
    },
  );

  it("escapes Lucene syntax in titles and names", async () => {
    const title = 'Don\'t Stop (Live): "A/B"';
    let query: string | null = null;
    musicbrainz([recording(title, "AC/DC")], (call) => {
      query = searchQuery(call);
    });

    const data = JSON.parse(await getMusicBrainzRelations.invoke({ title, artist: "AC/DC" }));

    expect(query).toBe('recording:"Don\'t Stop \\(Live\\)\\: \\"A\\/B\\"" AND artist:"AC\\/DC"');
    expect(data.found).toBe(true);
  });

  it("does not fall back to an unrelated first hit", async () => {
    const net = musicbrainz([
      recording("Ice Ice Baby (Live in Miami)", "Some Cover Band"),
      recording("Under Pressure", "Queen"),
    ]);

    const data = JSON.parse(
      await getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
    );

    expect(data.found).toBe(false);
    expect(net.calls.filter((c) => c.url.startsWith(`${MB}/recording/`))).toHaveLength(0);
  });

  it("identifies itself with a real User-Agent", async () => {
    const net = musicbrainz([recording("Ice Ice Baby", "Vanilla Ice")]);

    await getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" });

    for (const call of net.calls) {
      expect(call.headers["user-agent"]).toMatch(/^LinerNotes\/\S+ \( https:\/\/\S+ \)$/);
      expect(call.headers["user-agent"]).not.toContain("example.com");
    }
  });

  // The answer MusicBrainz sheds load with (real/mb5b.json): 503, Retry-After: 0.
  const busy = () =>
    json(
      { error: "The MusicBrainz web server is currently busy. Please try again later." },
      { status: 503, headers: { "Retry-After": "0" } },
    );

  it("a 503 is retried once, then reported as a rate limit", async () => {
    const net = stubFetch((call) => (call.url.startsWith(`${MB}/recording?`) ? busy() : undefined));

    const data = JSON.parse(
      await getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
    );

    expect(data).toMatchObject({ found: false, code: "rate_limited" });
    expect(data.error).toMatch(/rate limited/);
    expect(net.calls).toHaveLength(2);
  });

  it("a shed request succeeds on its one retry", async () => {
    let searches = 0;
    const net = stubFetch((call) => {
      if (call.url.startsWith(`${MB}/recording?`)) {
        searches++;
        return searches === 1
          ? busy()
          : json({ count: 1, recordings: [recording("Ice Ice Baby", "Vanilla Ice")] });
      }
      if (call.url.startsWith(`${MB}/recording/${RECORDING_ID}?`)) return json(lookup);
      return undefined;
    });

    const data = JSON.parse(
      await getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
    );

    expect(data.found).toBe(true);
    expect(net.calls.filter((c) => c.url.startsWith(`${MB}/recording?`))).toHaveLength(2);
  });

  it("waits at most 2 s for a long Retry-After before the retry", { timeout: 6000 }, async () => {
    const at: number[] = [];
    stubFetch((call) => {
      if (!call.url.startsWith(`${MB}/recording?`)) return undefined;
      at.push(Date.now());
      return json({ error: "busy" }, { status: 503, headers: { "Retry-After": "30" } });
    });

    await getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" });

    expect(at).toHaveLength(2);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(1900);
    expect(at[1] - at[0]).toBeLessThan(3000);
  });

  it("a request that never answers times out and the queue moves on", {
    timeout: 4000,
  }, async () => {
    process.env.SOURCE_TIMEOUT_MS = "50";
    let searches = 0;
    stubFetch((call) => {
      if (call.url.startsWith(`${MB}/recording?`)) {
        searches++;
        return searches === 1
          ? never(call)
          : json({ count: 1, recordings: [recording("Ice Ice Baby", "Vanilla Ice")] });
      }
      if (call.url.startsWith(`${MB}/recording/${RECORDING_ID}?`)) return json(lookup);
      return undefined;
    });

    const [stuck, next] = await Promise.all([
      getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
      getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
    ]);

    expect(JSON.parse(stuck)).toMatchObject({
      found: false,
      code: "timeout",
      error: expect.stringMatching(/no answer within 50 ms/),
    });
    expect(JSON.parse(next)).toMatchObject({ found: true });
  });

  it.each([...'+-&|!(){}[]^"~*?:\\/'])("escapes the Lucene character %s", (char) => {
    expect(escapeLucene(`a${char}b`)).toBe(`a\\${char}b`);
  });

  it("matches the title exactly, not a longer title by a different credit", async () => {
    const net = musicbrainz([
      {
        ...recording("Love of My Life", "Queen"),
        "artist-credit": [
          { name: "Queen", joinphrase: " + ", artist: { id: RECORDING_ID, name: "Queen" } },
          { name: "Paul Rodgers", artist: { id: SAMPLED_ID, name: "Paul Rodgers" } },
        ],
      },
      recording("Love of My Life", "Queen"),
    ]);

    const data = JSON.parse(
      await getMusicBrainzRelations.invoke({ title: "Love", artist: "Queen" }),
    );

    expect(data.found).toBe(false);
    expect(net.calls.filter((c) => c.url.startsWith(`${MB}/recording/`))).toHaveLength(0);
  });

  it("requires the credited artist to be exactly the requested one", async () => {
    musicbrainz([
      {
        ...recording("Love", "Queen"),
        "artist-credit": [
          { name: "Queen", joinphrase: " + ", artist: { id: RECORDING_ID, name: "Queen" } },
          { name: "Paul Rodgers", artist: { id: SAMPLED_ID, name: "Paul Rodgers" } },
        ],
      },
    ]);

    const data = JSON.parse(
      await getMusicBrainzRelations.invoke({ title: "Love", artist: "Queen" }),
    );

    expect(data.found).toBe(false);
  });

  it("reads & and and as the same word (real search answer)", async () => {
    let query: string | null = null;
    const net = stubFetch((call) => {
      if (!call.url.startsWith(`${MB}/recording?`)) return undefined;
      query = searchQuery(call);
      return json(mcgee);
    });

    const data = JSON.parse(
      await getMusicBrainzRelations.invoke({ title: "Me & Bobby McGee", artist: "Janis Joplin" }),
    );

    // The titles match ("&" is "and"); every match is on a compilation, so none is picked.
    expect(data).toMatchObject({ found: false, reason: "ambiguous" });
    expect(query).toContain('recording:"Me \\& Bobby McGee"');
    expect(net.calls).toHaveLength(1);
  });

  it("picks a recording whose title differs only by & and and", async () => {
    musicbrainz([recording("Ice and Ice Baby", "Vanilla Ice")]);

    const data = JSON.parse(
      await getMusicBrainzRelations.invoke({ title: "Ice & Ice Baby", artist: "Vanilla Ice" }),
    );

    expect(data).toMatchObject({ found: true, mbid: RECORDING_ID });
  });

  it("drops a featured-artist suffix and matches a credit of several artists", async () => {
    let query: string | null = null;
    const credit = [
      { name: "Daft Punk", joinphrase: " feat. ", artist: { id: SAMPLED_ID, name: "Daft Punk" } },
      { name: "Pharrell Williams", artist: { id: RECORDING_ID, name: "Pharrell Williams" } },
    ];
    musicbrainz([{ ...recording("Get Lucky", "Daft Punk"), "artist-credit": credit }], (call) => {
      query = searchQuery(call);
    });

    const data = JSON.parse(
      await getMusicBrainzRelations.invoke({
        title: "Get Lucky (feat. Pharrell Williams)",
        artist: "Daft Punk, Pharrell Williams",
      }),
    );

    expect(data.found).toBe(true);
    expect(query).toBe(
      'recording:"Get Lucky" AND artist:"Daft Punk" AND artist:"Pharrell Williams"',
    );
  });

  it("does not take a part of a comma name for the artist", async () => {
    musicbrainz([recording("September", "Earth")]);

    const data = JSON.parse(
      await getMusicBrainzRelations.invoke({ title: "September", artist: "Earth, Wind & Fire" }),
    );

    expect(data.found).toBe(false);
  });

  it("never looks up a match whose id is not an MBID", async () => {
    const net = musicbrainz([recording("Ice Ice Baby", "Vanilla Ice", "../../artist/x")]);

    const data = JSON.parse(
      await getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
    );

    expect(data.found).toBe(false);
    // Reported as not found, not as a failed lookup of a bad id.
    expect(data.error).toBeUndefined();
    expect(net.calls.filter((c) => !c.url.startsWith(`${MB}/recording?`))).toHaveLength(0);
  });

  it.each([
    ["a title", { title: "!!!", artist: "Vanilla Ice" }],
    ["an artist", { title: "Ice Ice Baby", artist: " — " }],
  ])("%s with nothing to compare sends no request", async (_name, input) => {
    const net = stubFetch(() => undefined);

    const data = JSON.parse(await getMusicBrainzRelations.invoke(input));

    expect(data.found).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  describe("artists by name (real search answers)", () => {
    const artistSearch = (answers: Record<string, unknown>) =>
      stubFetch((call) => {
        if (call.url.startsWith(`${MB}/artist?`)) {
          return json(answers[searchQuery(call) ?? ""] ?? { count: 0, artists: [] });
        }
        if (call.url.startsWith(`${MB}/artist/`)) {
          const id = new URL(call.url).pathname.split("/").pop();
          return json({ id, name: "resolved", relations: [] });
        }
        return undefined;
      });

    it.each([
      [
        "Earth, Wind & Fire",
        'artist:"Earth, Wind \\& Fire"',
        earthWindFire,
        "535afeda-2538-435d-9dd1-5e10be586774",
      ],
      [
        "Tyler, The Creator",
        'artist:"Tyler, The Creator"',
        tylerTheCreator,
        "f6beac20-5dfe-4d1f-ae02-0b0a740aafd6",
      ],
    ])("%s resolves to itself", async (name, query, answer, mbid) => {
      artistSearch({
        [query]: answer,
        // What a search for the first part alone returns: an artist named exactly that.
        'artist:"Earth"': {
          count: 1,
          artists: [{ id: "60dd41cf-0000-4000-8000-000000000000", name: "Earth", score: 100 }],
        },
        'artist:"Tyler"': {
          count: 1,
          artists: [{ id: "00000000-0000-4000-8000-000000000007", name: "Tyler", score: 100 }],
        },
      });

      const data = JSON.parse(await getMusicBrainzArtist.invoke({ artistName: name }));

      expect(data).toMatchObject({ found: true, mbid });
    });

    it("an artist string without an exact match is not split into a different artist", async () => {
      const net = artistSearch({
        'artist:"Daft Punk"': {
          count: 1,
          artists: [{ id: SAMPLED_ID, name: "Daft Punk", score: 100 }],
        },
      });

      const data = JSON.parse(
        await getMusicBrainzArtist.invoke({ artistName: "Daft Punk, Pharrell Williams" }),
      );

      expect(data.found).toBe(false);
      expect(net.calls).toHaveLength(1);
    });

    it("with the artists listed, falls back to the first one", async () => {
      artistSearch({
        'artist:"Daft Punk"': {
          count: 1,
          artists: [{ id: SAMPLED_ID, name: "Daft Punk", score: 100 }],
        },
      });

      const data = JSON.parse(
        await getMusicBrainzArtist.invoke({
          artistName: "Daft Punk, Pharrell Williams",
          artistNames: ["Daft Punk", "Pharrell Williams"],
        }),
      );

      expect(data).toMatchObject({ found: true, mbid: SAMPLED_ID });
    });

    it("with the artists listed, never searches the joined string as one artist", async () => {
      const net = artistSearch({
        'artist:"Daft Punk, Pharrell Williams"': {
          count: 1,
          artists: [
            {
              id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
              name: "Daft Punk, Pharrell Williams",
              score: 100,
            },
          ],
        },
        'artist:"Daft Punk"': {
          count: 1,
          artists: [{ id: SAMPLED_ID, name: "Daft Punk", score: 100 }],
        },
      });

      const data = JSON.parse(
        await getMusicBrainzArtist.invoke({
          artistName: "Daft Punk, Pharrell Williams",
          artistNames: ["Daft Punk", "Pharrell Williams"],
        }),
      );

      expect(data).toMatchObject({ found: true, mbid: SAMPLED_ID });
      expect(net.calls.filter((c) => c.url.startsWith(`${MB}/artist?`)).map(searchQuery)).toEqual([
        'artist:"Daft Punk"',
      ]);
    });

    describe("artists of the same name", () => {
      const UK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const US = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const SPOTIFY = "6olE6TJLqED3rqDCT0FyPh";
      const homonyms = (linked: string | null) =>
        stubFetch((call) => {
          if (call.url.startsWith(`${MB}/artist?`)) {
            return json({
              count: 2,
              artists: [
                { id: UK, name: "Nirvana", score: 100, disambiguation: "60s band from the UK" },
                { id: US, name: "Nirvana", score: 100, disambiguation: "90s US grunge band" },
              ],
            });
          }
          if (call.url.startsWith(`${MB}/url?`)) {
            return linked
              ? json({ id: "u", relations: [{ type: "free streaming", artist: { id: linked } }] })
              : json({ error: "Not Found" }, { status: 404 });
          }
          if (call.url.startsWith(`${MB}/artist/`)) {
            const id = new URL(call.url).pathname.split("/").pop();
            return json({ id, name: "Nirvana", relations: [] });
          }
          return undefined;
        });

      it("takes the one MusicBrainz links to the Spotify artist", async () => {
        const net = homonyms(US);

        const match = await findArtist("Nirvana", { spotifyArtistId: SPOTIFY });

        expect(match).toMatchObject({ artist: { id: US }, via: "spotify" });
        const [lookup] = net.calls.filter((c) => c.url.startsWith(`${MB}/url?`));
        expect(new URL(lookup.url).searchParams.get("resource")).toBe(
          `https://open.spotify.com/artist/${SPOTIFY}`,
        );
      });

      it.each([
        ["no Spotify link on MusicBrainz", null, SPOTIFY],
        ["no Spotify id", US, undefined],
      ])("is ambiguous with %s, never the first match", async (_name, linked, id) => {
        homonyms(linked);

        const match = await findArtist("Nirvana", { spotifyArtistId: id });

        expect(match).toMatchObject({ artist: null, reason: "ambiguous" });
      });

      it("the collaborators tool asks nothing more and says why", async () => {
        const net = homonyms(null);

        const data = JSON.parse(
          await getMusicBrainzArtist.invoke({ artistName: "Nirvana", spotifyArtistId: SPOTIFY }),
        );

        expect(data).toMatchObject({ found: false, reason: "ambiguous_artist" });
        expect(net.calls.filter((c) => c.url.startsWith(`${MB}/artist/`))).toHaveLength(0);
      });
    });

    describe("one artist of the name, checked against the track's Spotify artist", () => {
      const NOVA = "77777777-7777-4777-8777-777777777777";
      const OURS = "0123456789abcdefABCDEF";
      const THEIRS = "ZYXWVUTSRQPONMLKJIHGFE";
      const spotifyPage = (id: string) => ({
        type: "free streaming",
        url: { resource: `https://open.spotify.com/artist/${id}` },
      });
      const single = (urlRels: unknown[], link: "404" | "503" | "never" | string = "404") =>
        stubFetch((call) => {
          if (call.url.startsWith(`${MB}/url?`)) {
            if (link === "404") return json({ error: "Not Found" }, { status: 404 });
            if (link === "503") {
              return json({ error: "busy" }, { status: 503, headers: { "Retry-After": "0" } });
            }
            if (link === "never") return never(call);
            return json({ relations: [{ artist: { id: link, name: "Nova" } }] });
          }
          if (call.url.startsWith(`${MB}/artist?`)) {
            return json({ count: 1, artists: [{ id: NOVA, name: "Nova", score: 100 }] });
          }
          if (call.url.startsWith(`${MB}/artist/`)) {
            return json({
              id: NOVA,
              name: "Nova",
              relations: [
                ...urlRels,
                { type: "collaboration", artist: { id: SAMPLED_ID, name: "Corrado Rustici" } },
                { type: "supporting musician", artist: { id: SAMPLED_ID, name: "Session Player" } },
                { type: "member of band", artist: { id: SAMPLED_ID, name: "A Member" } },
                { type: "is person", artist: { id: SAMPLED_ID, name: "Legal Name" } },
                { type: "tribute", artist: { id: SAMPLED_ID, name: "Tribute Act" } },
              ],
            });
          }
          return undefined;
        });
      const collaborators = () =>
        getMusicBrainzArtist
          .invoke({ artistName: "Nova", spotifyArtistId: OURS })
          .then((raw) => JSON.parse(raw));

      it("MusicBrainz's link to the Spotify artist decides, without a name search", async () => {
        const net = single([], NOVA);

        expect(await findArtist("Nova", { spotifyArtistId: OURS })).toMatchObject({
          artist: { id: NOVA },
          via: "spotify",
        });
        expect(net.calls.filter((c) => c.url.startsWith(`${MB}/artist?`))).toHaveLength(0);
      });

      it("a name match whose own Spotify link names another artist is not used", async () => {
        single([spotifyPage(THEIRS)]);

        expect(await collaborators()).toMatchObject({
          found: false,
          reason: "other_spotify_artist",
        });
      });

      it("a name match that links to the track's Spotify artist is verified", async () => {
        single([spotifyPage(OURS)]);

        expect(await collaborators()).toMatchObject({ found: true, mbid: NOVA, verified: true });
      });

      it("a name match without any Spotify link is kept, marked unverified", async () => {
        single([]);

        expect(await collaborators()).toMatchObject({ found: true, mbid: NOVA, verified: false });
      });

      it("keeps only collaborations and supporting musicians as collaborators", async () => {
        single([spotifyPage(OURS)]);

        expect((await collaborators()).collaborators).toEqual([
          { name: "Corrado Rustici", relationship: "collaboration" },
          { name: "Session Player", relationship: "supporting musician" },
        ]);
      });

      it.each([
        ["a rate limit", "503", "rate_limited"],
        ["no answer", "never", "timeout"],
      ])(
        "%s on the Spotify link lookup is MusicBrainz's failure, not 'ambiguous'",
        async (_n, link, code) => {
          process.env.SOURCE_TIMEOUT_MS = "50";
          single([], link);

          expect(await collaborators()).toMatchObject({
            found: false,
            code,
            source: "musicbrainz",
          });
          expect(
            JSON.parse(
              await getListenBrainzSimilarArtists.invoke({
                artistName: "Nova",
                spotifyArtistId: OURS,
              }),
            ),
          ).toMatchObject({ found: false, code, source: "musicbrainz" });
        },
      );
    });

    it("an empty name is not looked up and is not the source's failure", async () => {
      const net = stubFetch(() => undefined);

      const data = JSON.parse(await getMusicBrainzArtist.invoke({ artistName: " " }));

      expect(data).toMatchObject({ found: false, reason: "no_input" });
      expect(net.calls).toHaveLength(0);
    });
  });

  it("sends one request at a time, spaced by the queue", async () => {
    // On a fake clock a start is the time the queue released the request, however late the
    // machine got round to it: only the queue's and the stub's timers move the clock.
    queueOnFakeClock(60);
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: number[] = [];
    stubFetch(async (call) => {
      if (!call.url.startsWith(`${MB}/`)) return undefined;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      starts.push(Date.now());
      // The second answer outlasts the interval, so a queue that did not wait for it would
      // overlap the third request. The others are quick: only the queue spaces requests 1→2
      // and 3→4.
      await new Promise((r) => setTimeout(r, starts.length === 2 ? 100 : 5));
      inFlight--;
      return call.url.startsWith(`${MB}/artist?`)
        ? json({ count: 0, artists: [] })
        : json({ count: 0, recordings: [] });
    });
    await settleOnFakeClock(
      Promise.all([
        findArtist("Vanilla Ice"),
        findArtist("Queen"),
        getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
        findArtist("David Bowie"),
      ]),
    );

    expect(starts).toHaveLength(4);
    expect(maxInFlight).toBe(1);
    const gaps = starts.slice(1).map((start, i) => start - starts[i]);
    for (const gap of gaps) expect(gap, `gaps ${gaps}`).toBeGreaterThanOrEqual(60);
  });

  describe("choosing among exact matches (real search answers)", () => {
    const ICE_ICE_BABY = "875c24bc-fe9e-4ac6-80d3-beaacb70ee43";

    /** Answers a search narrowed to the album with `narrowed`, any other with `plain`. */
    const searches = (plain: unknown, narrowed: unknown = plain) =>
      stubFetch((call) => {
        if (call.url.startsWith(`${MB}/recording?`)) {
          return json(searchQuery(call)?.includes(" AND release:") ? narrowed : plain);
        }
        if (call.url.startsWith(`${MB}/recording/${ICE_ICE_BABY}?`)) return json(iceLookup);
        return undefined;
      });
    const lookups = (calls: FetchCall[]) =>
      calls.filter((c) => c.url.startsWith(`${MB}/recording/`));

    it("Ice Ice Baby: only compilation recordings match, so none is picked", async () => {
      const net = searches(iceSearch);

      const data = JSON.parse(
        await getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
      );

      expect(data).toMatchObject({ found: false, reason: "ambiguous" });
      expect(lookups(net.calls)).toHaveLength(0);
    });

    it("Ice Ice Baby on To the Extreme: the original recording and its samples", async () => {
      let query: string | null = null;
      const net = stubFetch((call) => {
        if (call.url.startsWith(`${MB}/recording?`)) {
          query = searchQuery(call);
          return json(query?.includes(" AND release:") ? iceToTheExtreme : iceSearch);
        }
        if (call.url.startsWith(`${MB}/recording/${ICE_ICE_BABY}?`)) return json(iceLookup);
        return undefined;
      });

      const data = JSON.parse(
        await getMusicBrainzRelations.invoke({
          title: "Ice Ice Baby",
          artist: "Vanilla Ice",
          album: "To the Extreme",
        }),
      );

      expect(query).toBe(
        'recording:"Ice Ice Baby" AND artist:"Vanilla Ice" AND release:"To the Extreme"',
      );
      expect(data).toMatchObject({ found: true, mbid: ICE_ICE_BABY });
      expect(data.genealogy.samples.map((s: { title: string }) => s.title)).toContain(
        "Under Pressure",
      );
      expect(lookups(net.calls)).toHaveLength(1);
    });

    it("an album's edition suffix is left out of the release filter", async () => {
      let query: string | null = null;
      stubFetch((call) => {
        if (!call.url.startsWith(`${MB}/recording?`)) return undefined;
        query = searchQuery(call);
        return json({ count: 0, recordings: [] });
      });

      await getMusicBrainzRelations.invoke({
        title: "Ice Ice Baby",
        artist: "Vanilla Ice",
        album: "To the Extreme (Remastered 2009)",
      });

      expect(query).toContain(' AND release:"To the Extreme"');
    });

    it("Back in Black: never the 1991 Paris live recording", async () => {
      const net = searches(backInBlack);

      const data = JSON.parse(
        await getMusicBrainzRelations.invoke({ title: "Back in Black", artist: "AC/DC" }),
      );

      expect(data).toMatchObject({ found: false, reason: "ambiguous" });
      expect(lookups(net.calls)).toHaveLength(0);
    });

    const candidate = (
      id: string,
      releases: number,
      first: string,
      disambiguation = "",
      secondary: string[] = [],
    ) => ({
      ...recording("Ice Ice Baby", "Vanilla Ice", id),
      disambiguation,
      "first-release-date": first,
      releases: Array.from({ length: releases }, () => ({
        ...ORIGINAL_RELEASE,
        "release-group": { "primary-type": "Album", "secondary-types": secondary },
      })),
    });
    const A = "00000000-0000-4000-8000-00000000000a";
    const B = "00000000-0000-4000-8000-00000000000b";

    it.each([
      [
        "no disambiguation over a disambiguated one",
        [candidate(A, 1, "1995", "radio edit"), candidate(B, 1, "1995")],
        B,
      ],
      ["more releases over fewer", [candidate(A, 2, "1990"), candidate(B, 5, "1990")], B],
      [
        "the earlier release on equal counts",
        [candidate(A, 3, "1991-02-01"), candidate(B, 3, "1990-09-04")],
        B,
      ],
      [
        "an original over a compilation with more releases",
        [candidate(A, 1, "1990"), candidate(B, 9, "1989", "", ["Compilation"])],
        A,
      ],
      [
        "an original over a live recording",
        [candidate(A, 1, "1992"), candidate(B, 4, "1990", "", ["Live"])],
        A,
      ],
    ])("prefers %s", async (_name, found, expected) => {
      stubFetch((call) => {
        if (call.url.startsWith(`${MB}/recording?`))
          return json({ count: found.length, recordings: found });
        if (call.url.startsWith(`${MB}/recording/${expected}?`)) {
          return json({ ...recording("Ice Ice Baby", "Vanilla Ice", expected), relations: [] });
        }
        return undefined;
      });

      const data = JSON.parse(
        await getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
      );

      expect(data).toMatchObject({ found: true, mbid: expected });
    });

    it("two originals that cannot be told apart are ambiguous", async () => {
      const net = searches({
        count: 2,
        recordings: [candidate(A, 3, "1990"), candidate(B, 3, "1990")],
      });

      const data = JSON.parse(
        await getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
      );

      expect(data).toMatchObject({ found: false, reason: "ambiguous" });
      expect(lookups(net.calls)).toHaveLength(0);
    });

    it("a match only on bootleg releases is not an original", async () => {
      const bootleg = candidate(A, 2, "1990");
      for (const release of bootleg.releases) release.status = "Bootleg";

      const net = searches({ count: 1, recordings: [bootleg] });
      const data = JSON.parse(
        await getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
      );

      expect(data).toMatchObject({ found: false, reason: "ambiguous" });
      expect(lookups(net.calls)).toHaveLength(0);
    });
  });
  describe("relation direction, on relations captured from MusicBrainz", () => {
    const ICE = "875c24bc-fe9e-4ac6-80d3-beaacb70ee43";
    const UNDER_PRESSURE = "32c7e292-14f1-4080-bddf-ef852e0a4c59";

    /** Runs the tool for a track whose search finds `id` and whose lookup answers `details`. */
    async function relationsOf(title: string, artist: string, id: string, details: unknown) {
      stubFetch((call) => {
        if (call.url.startsWith(`${MB}/recording?`)) {
          return json({ count: 1, recordings: [recording(title, artist, id)] });
        }
        if (call.url.startsWith(`${MB}/recording/${id}?`)) return json(details);
        return undefined;
      });
      const data = JSON.parse(await getMusicBrainzRelations.invoke({ title, artist }));
      expect(data).toMatchObject({ found: true, mbid: id });
      return data.genealogy;
    }

    it("lists what Ice Ice Baby samples as a source and what samples it as derived", async () => {
      const { samples, remixes, djMixes } = await relationsOf(
        "Ice Ice Baby",
        "Vanilla Ice",
        ICE,
        iceDetails,
      );
      expect(samples).toEqual([
        expect.objectContaining({
          title: "Under Pressure",
          mbid: UNDER_PRESSURE,
          direction: "source",
        }),
        expect.objectContaining({ title: "Ice Ice Bacon", direction: "derived" }),
        expect.objectContaining({ title: "Pushin' Ice", direction: "derived" }),
      ]);
      // A DJ mix that includes the track is derived from it, and is not a remix.
      expect(djMixes).toEqual([
        expect.objectContaining({
          type: "dj-mix",
          relationshipType: "DJ-mix",
          direction: "derived",
        }),
      ]);
      expect(remixes).toEqual([]);
    });

    it("lists the recordings that sample or remix Under Pressure as derived", async () => {
      const { samples, remixes } = await relationsOf(
        "Under Pressure",
        "Queen & David Bowie",
        UNDER_PRESSURE,
        underPressureDetails,
      );
      expect(samples.map((s: { title: string }) => s.title)).toEqual([
        "Come Again",
        "Ice Ice Baby",
      ]);
      expect(samples.every((s: { direction: string }) => s.direction === "derived")).toBe(true);
      expect(samples.find((s: { mbid: string }) => s.mbid === ICE)).toBeDefined();
      expect(remixes).toHaveLength(3);
      expect(remixes.every((r: { direction: string }) => r.direction === "derived")).toBe(true);
    });

    it("reads a performance of a work with the cover attribute as a cover of that work", async () => {
      const cover = {
        ...iceDetails,
        relations: [
          {
            type: "performance",
            direction: "forward",
            "target-type": "work",
            attributes: ["cover"],
            work: { id: "e0ebb61d-7f69-3667-a2b1-dcd447d80f3d", title: "Ice Ice Baby" },
          },
          ...iceDetails.relations.filter((r) => r.type !== "performance"),
        ],
      };
      const { covers } = await relationsOf("Ice Ice Baby", "Vanilla Ice", ICE, cover);
      expect(covers).toEqual([
        expect.objectContaining({ title: "Ice Ice Baby", type: "cover", direction: "source" }),
      ]);
      // The original performance (no cover attribute) is not a cover.
      const { covers: none } = await relationsOf("Ice Ice Baby", "Vanilla Ice", ICE, iceDetails);
      expect(none).toEqual([]);
    });
  });
});
