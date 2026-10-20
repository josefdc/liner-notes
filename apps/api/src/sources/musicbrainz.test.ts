/**
 * MusicBrainz client with a stubbed API: queries are Lucene-escaped, a search without a
 * matching recording is "not found" (never the first hit), requests carry a real User-Agent,
 * and a request that never answers times out instead of stalling the queue.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type FetchCall, json, never, stubFetch } from "./testing/fetchStub.js";

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
import {
  escapeLucene,
  findArtist,
  getMusicBrainzArtist,
  getMusicBrainzRelations,
  MusicBrainzRateLimiter,
} from "./musicbrainz.js";

const MB = "https://musicbrainz.org/ws/2";
const RECORDING_ID = "5b11f4ce-a62d-471e-81fc-a69a8278c7da";
const SAMPLED_ID = "32c7e292-14f1-4080-bddf-ef852e0a4c59";

const recording = (title: string, artist: string, id = RECORDING_ID) => ({
  id,
  title,
  score: 100,
  "artist-credit": [
    { name: artist, artist: { id: "f2fb0ff0-5679-42ec-a55c-15109ce6e320", name: artist } },
  ],
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
      expect.objectContaining({ title: "Under Pressure", mbid: SAMPLED_ID, direction: "derived" }),
    ]);
  });

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

    expect(data.found).toBe(false);
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
    const bobby = mcgee.recordings[0].id;
    stubFetch((call) => {
      if (call.url.startsWith(`${MB}/recording?`)) {
        query = searchQuery(call);
        return json(mcgee);
      }
      if (call.url.startsWith(`${MB}/recording/${bobby}?`)) {
        return json({ ...mcgee.recordings[0], relations: [] });
      }
      return undefined;
    });

    const data = JSON.parse(
      await getMusicBrainzRelations.invoke({ title: "Me & Bobby McGee", artist: "Janis Joplin" }),
    );

    expect(data).toMatchObject({ found: true, mbid: bobby });
    expect(query).toContain('recording:"Me \\& Bobby McGee"');
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
  });

  it("sends one request at a time, spaced by the queue", async () => {
    const restore = MusicBrainzRateLimiter.getInstance().setIntervalForTests(60);
    let inFlight = 0;
    let maxInFlight = 0;
    const starts: number[] = [];
    stubFetch(async (call) => {
      if (!call.url.startsWith(`${MB}/`)) return undefined;
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      starts.push(Date.now());
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return call.url.startsWith(`${MB}/artist?`)
        ? json({ count: 0, artists: [] })
        : json({ count: 0, recordings: [] });
    });
    try {
      await Promise.all([
        findArtist("Vanilla Ice"),
        findArtist("Queen"),
        getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
      ]);
    } finally {
      restore();
    }

    expect(starts).toHaveLength(3);
    expect(maxInFlight).toBe(1);
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(55);
    }
  });
});
