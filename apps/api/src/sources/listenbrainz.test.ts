/**
 * ListenBrainz similar artists with a stubbed API. The labs `similar-artists/json` answer
 * (fixtures/listenbrainz-similar-artists.json: a live answer, all 100 rows, cut to the fields
 * the client reads) is parsed; an HTML or other non-JSON answer is a typed error, and so is
 * any API error: these tests fail on an error instead of passing over it.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import earthWindFire from "./fixtures/musicbrainz-artist-search-earth-wind-fire.json" with {
  type: "json",
};
import fixture from "./fixtures/listenbrainz-similar-artists.json" with { type: "json" };
import { type FetchCall, html, json, stubFetch } from "./testing/fetchStub.js";

vi.hoisted(() => {
  process.env.MUSICBRAINZ_USER_AGENT = "";
  process.env.SOURCE_USER_AGENT = "";
});

import { getListenBrainzSimilarArtists } from "./listenbrainz.js";
import { MusicBrainzRateLimiter } from "./musicbrainz.js";

const LABS = "https://labs.api.listenbrainz.org/similar-artists/json";
const MB_ARTIST_SEARCH = "https://musicbrainz.org/ws/2/artist?";
const DAFT_PUNK = "056e4f3e-d505-4dad-8ec1-d04f521cbb56";

const isLabs = (call: FetchCall) => call.method === "GET" && call.url.startsWith(`${LABS}?`);

describe("ListenBrainz similar artists", () => {
  let restoreInterval: (() => void) | undefined;

  beforeAll(() => {
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
  });

  it("parses the labs similar-artists answer", async () => {
    const net = stubFetch((call) => (isLabs(call) ? json(fixture) : undefined));

    const data = JSON.parse(await getListenBrainzSimilarArtists.invoke({ artistMbid: DAFT_PUNK }));

    expect(data.found).toBe(true);
    expect(data.artists).toHaveLength(5);
    expect(data.artists[0]).toEqual({
      name: "Nile Rodgers",
      mbid: "c6d571dd-c0ae-4ac8-9500-780b1b9b25e5",
      score: 10016,
    });
    // Only the raw score: a share of the top score made the top artist "100%" every time.
    for (const a of data.artists) expect(a).not.toHaveProperty("similarity");

    const url = new URL(net.calls[0].url);
    expect(url.searchParams.get("artist_mbids")).toBe(DAFT_PUNK);
    expect(url.searchParams.get("algorithm")).toMatch(/^session_based_/);
    expect(net.calls).toHaveLength(1);
  });

  it.each([
    ["an HTML page", () => html("<!doctype html><title>Checking your browser</title>")],
    [
      "plain text",
      () => new Response("rate limited", { headers: { "content-type": "text/plain" } }),
    ],
  ])("%s is a typed content-type error", async (_name, reply) => {
    stubFetch((call) => (call.url.includes("listenbrainz.org") ? reply() : undefined));

    const data = JSON.parse(await getListenBrainzSimilarArtists.invoke({ artistMbid: DAFT_PUNK }));

    expect(data).toMatchObject({ found: false, code: "invalid_response" });
    expect(data.error).toMatch(/expected JSON, got text\//);
  });

  it("a JSON answer that is not a list is a typed parse error", async () => {
    stubFetch((call) => (isLabs(call) ? json({ error: "unknown algorithm" }) : undefined));

    const data = JSON.parse(await getListenBrainzSimilarArtists.invoke({ artistMbid: DAFT_PUNK }));

    expect(data).toMatchObject({
      found: false,
      code: "invalid_response",
      error: expect.stringMatching(/not a list/),
    });
  });

  it("an API error is reported, not counted as a result", async () => {
    stubFetch((call) => (isLabs(call) ? json({ error: "boom" }, { status: 500 }) : undefined));

    const data = JSON.parse(await getListenBrainzSimilarArtists.invoke({ artistMbid: DAFT_PUNK }));

    expect(data).toMatchObject({
      found: false,
      code: "unavailable",
      error: expect.stringMatching(/HTTP 500/),
    });
  });

  it("an MBID that is not a UUID never reaches a URL", async () => {
    const net = stubFetch(() => undefined);

    const data = JSON.parse(
      await getListenBrainzSimilarArtists.invoke({ artistMbid: "../../1/user/x" }),
    );

    expect(data.found).toBe(false);
    expect(net.calls).toHaveLength(0);
  });

  it("resolves a name through the MusicBrainz client", async () => {
    const net = stubFetch((call) => {
      if (call.url.startsWith(MB_ARTIST_SEARCH)) {
        return json({
          count: 2,
          artists: [
            { id: "00000000-0000-4000-8000-000000000001", name: "Daft Punk Tribute", score: 100 },
            { id: DAFT_PUNK, name: "Daft Punk", score: 98 },
          ],
        });
      }
      return isLabs(call) ? json(fixture) : undefined;
    });

    const data = JSON.parse(
      await getListenBrainzSimilarArtists.invoke({ artistName: "Daft Punk" }),
    );

    expect(data.found).toBe(true);
    const [search, labs] = net.calls;
    expect(new URL(search.url).searchParams.get("query")).toBe('artist:"Daft Punk"');
    expect(search.headers["user-agent"]).not.toContain("example.com");
    expect(new URL(labs.url).searchParams.get("artist_mbids")).toBe(DAFT_PUNK);
  });

  it("a name MusicBrainz does not know is not resolved to another artist", async () => {
    const net = stubFetch((call) =>
      call.url.startsWith(MB_ARTIST_SEARCH)
        ? json({ count: 1, artists: [{ id: DAFT_PUNK, name: "Daft Punk", score: 40 }] })
        : undefined,
    );

    const data = JSON.parse(
      await getListenBrainzSimilarArtists.invoke({ artistName: "Daft Punks Revenge" }),
    );

    expect(data).toMatchObject({ found: false, reason: "artist_not_identified" });
    expect(data).not.toHaveProperty("code");
    expect(net.calls.filter((c) => c.url.includes("listenbrainz.org"))).toHaveLength(0);
  });

  it("orders by score and drops rows without a usable score", async () => {
    const rows = [
      { artist_mbid: "00000000-0000-4000-8000-000000000001", name: "Low", score: 10 },
      { artist_mbid: "00000000-0000-4000-8000-000000000002", name: "Zero", score: 0 },
      { artist_mbid: "00000000-0000-4000-8000-000000000003", name: "High", score: 500 },
      { artist_mbid: "00000000-0000-4000-8000-000000000004", name: "Text", score: "900" },
      { artist_mbid: "00000000-0000-4000-8000-000000000005", name: "Negative", score: -4 },
      { artist_mbid: "not-an-mbid", name: "Broken", score: 800 },
    ];
    stubFetch((call) => (isLabs(call) ? json(rows) : undefined));

    const data = JSON.parse(await getListenBrainzSimilarArtists.invoke({ artistMbid: DAFT_PUNK }));

    expect(data.artists.map((a: { name: string }) => a.name)).toEqual(["High", "Low"]);
    expect(data.artists.map((a: { score: number }) => a.score)).toEqual([500, 10]);
  });

  it("resolves the real Earth, Wind & Fire, not the band Earth", async () => {
    const net = stubFetch((call) => {
      if (call.url.startsWith(MB_ARTIST_SEARCH)) {
        const query = new URL(call.url).searchParams.get("query");
        return json(
          query === 'artist:"Earth, Wind \\& Fire"'
            ? earthWindFire
            : {
                count: 1,
                artists: [
                  { id: "60dd41cf-8f9d-46d8-bc19-dc7e5acb24c8", name: "Earth", score: 100 },
                ],
              },
        );
      }
      return isLabs(call) ? json(fixture) : undefined;
    });

    await getListenBrainzSimilarArtists.invoke({ artistName: "Earth, Wind & Fire" });

    const labs = net.calls.find(isLabs);
    expect(new URL(labs?.url ?? "https://x").searchParams.get("artist_mbids")).toBe(
      "535afeda-2538-435d-9dd1-5e10be586774",
    );
  });
});
