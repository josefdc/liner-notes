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

import { getMusicBrainzRelations, MusicBrainzRateLimiter } from "./musicbrainz.js";

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

  it("a 503 is reported as a rate limit", async () => {
    stubFetch((call) =>
      call.url.startsWith(`${MB}/recording?`)
        ? json({ error: "busy" }, { status: 503 })
        : undefined,
    );

    const data = JSON.parse(
      await getMusicBrainzRelations.invoke({ title: "Ice Ice Baby", artist: "Vanilla Ice" }),
    );

    expect(data.found).toBe(false);
    expect(data.error).toMatch(/rate limited/);
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
});
