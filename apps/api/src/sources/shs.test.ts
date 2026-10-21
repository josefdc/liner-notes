/**
 * SecondHandSongs originals and covers, against a stubbed API. The fixtures follow the shape of
 * the API's work and performance answers (`uri`, `title`, `performer`, `isOriginal`, `versions`,
 * `covers`, `sampledBy`) with placeholder performance ids; work 4196 is the one MusicBrainz links
 * from "Ice Ice Baby".
 */

import { Evidence as EvidenceSchema, evidenceIssues } from "@liner-notes/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import underPressure from "./fixtures/shs-performance-under-pressure.json" with { type: "json" };
import work from "./fixtures/shs-work-ice-ice-baby.json" with { type: "json" };
import type { TrackRef } from "./records.js";
import { shsLink, shsRelationships } from "./shs.js";
import { type FetchRoute, json, stubFetch } from "./testing/fetchStub.js";
import { recordThenReplay } from "./testing/roundTrip.js";

const KEY = "shs-test-key-0123456789";
const WORK = { kind: "work", id: 4196 } as const;
const now = () => new Date("2026-10-20T12:00:00.000Z");

const TRACK: TrackRef = {
  isrc: "USCA29001716",
  title: "Ice Ice Baby",
  artists: ["Vanilla Ice"],
  durationMs: 271_733,
};

const api: FetchRoute = (call) => {
  if (call.url === "https://secondhandsongs.com/work/4196") return json(work);
  if (call.url === "https://secondhandsongs.com/performance/9200010") return json(underPressure);
  return undefined;
};

beforeEach(() => {
  delete process.env.SOURCE_CASSETTE;
});
afterEach(() => {
  delete process.env.SHS_API_KEY;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("without SHS_API_KEY", () => {
  it("still reads the API, anonymously", async () => {
    delete process.env.SHS_API_KEY;
    const net = stubFetch(api);
    const result = await shsRelationships(TRACK, [WORK], { now });
    expect(result.status).toBe("found");
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].headers.accept).toBe("application/json");
    expect(net.calls[0].headers).not.toHaveProperty("x-api-key");
  });
});

describe("SecondHandSongs", () => {
  it("sends the key in the X-API-Key header when it is set", async () => {
    process.env.SHS_API_KEY = KEY;
    const net = stubFetch(api);
    await shsRelationships(TRACK, [WORK]);
    expect(net.calls[0].headers["x-api-key"]).toBe(KEY);
    expect(net.calls[0].url).not.toContain(KEY);
  });

  it("lists the covers of the track's song when the track is the original", async () => {
    stubFetch(api);
    const result = await shsRelationships(TRACK, [WORK], { now });
    if (result.status !== "found") throw new Error(result.reason);
    expect(result.records).toEqual([
      {
        kind: "covered-by",
        title: "Ice Ice Baby",
        performer: "Glee Cast",
        url: "https://secondhandsongs.com/performance/9200002",
        date: "2010",
      },
      {
        kind: "covered-by",
        title: "Ice Ice Baby",
        performer: "Richard Cheese",
        url: "https://secondhandsongs.com/performance/9200003",
        date: null,
      },
    ]);
    for (const item of result.evidence) {
      expect(evidenceIssues(EvidenceSchema.parse(item))).toEqual([]);
      expect(item).toMatchObject({
        source: "secondhandsongs",
        sourceTier: "primary-record",
        url: "https://secondhandsongs.com/work/4196",
      });
    }
    expect(result.evidence[0].excerpt).toBe(
      'SecondHandSongs: "Ice Ice Baby" by Vanilla Ice is covered by "Ice Ice Baby" by Glee Cast (2010).',
    );
  });

  it("lists the original when the track is a cover", async () => {
    stubFetch(api);
    const result = await shsRelationships({ ...TRACK, artists: ["Glee Cast"] }, [WORK]);
    if (result.status !== "found") throw new Error(result.reason);
    expect(result.records).toEqual([
      expect.objectContaining({ kind: "cover-of", performer: "Vanilla Ice", date: "1989" }),
    ]);
  });

  it("omits the work when its title is not the track's, or the artist has no version", async () => {
    stubFetch(api);
    const retitled = await shsRelationships({ ...TRACK, title: "Ninja Rap" }, [WORK]);
    expect(retitled).toMatchObject({ status: "missing", identity: { rejected: 1 } });
    // A linked work that is another song, even with a version titled like the track.
    stubFetch(() => json({ ...work, title: "Ninja Rap" }));
    const otherWork = await shsRelationships(TRACK, [WORK]);
    expect(otherWork.omitted).toEqual([
      { ref: "work/4196", reason: 'work "Ninja Rap" is not "Ice Ice Baby"' },
    ]);
    stubFetch(api);
    const stranger = await shsRelationships({ ...TRACK, artists: ["MC Hammer"] }, [WORK]);
    expect(stranger).toMatchObject({ status: "missing", identity: { rejected: 1 } });
    expect(stranger.omitted[0].reason).toBe('no version of "Ice Ice Baby" by MC Hammer among 3');
  });

  it("reads a performance: its covers and the recordings that sample it", async () => {
    stubFetch(api);
    const track = { ...TRACK, title: "Under Pressure", artists: ["Queen", "David Bowie"] };
    const links = [WORK, { kind: "performance", id: 9200010 } as const];
    const result = await shsRelationships(track, links, { now });
    if (result.status !== "found") throw new Error(result.reason);
    expect(result.records.map((r) => [r.kind, r.title, r.performer])).toEqual([
      ["covered-by", "Under Pressure", "My Chemical Romance & The Used"],
      ["sampled-by", "Ice Ice Baby", "Vanilla Ice"],
    ]);
    const other = await shsRelationships({ ...track, artists: ["Queen"] }, links);
    expect(other).toMatchObject({ status: "missing", identity: { rejected: 1 } });
  });

  it("is missing without a link, and on an API error, without throwing", async () => {
    const net = stubFetch(() => json({ error: "boom" }, { status: 500 }));
    expect(await shsRelationships(TRACK, [])).toMatchObject({
      status: "missing",
      identity: { missing: 1 },
    });
    expect(net.calls).toHaveLength(0);
    expect(await shsRelationships(TRACK, [WORK])).toMatchObject({
      status: "missing",
      error: { source: "secondhandsongs", code: "unavailable" },
    });
  });

  it("replays the recorded run with no network; the cassette keeps only the fields read", async () => {
    const live = { ...work, credits: [{ name: "Robert Van Winkle" }], language: "English" };
    const run = await recordThenReplay(
      () => json(live),
      () => shsRelationships(TRACK, [WORK], { now }),
    );
    expect(run.replayCalls).toBe(0);
    expect(run.replayed).toEqual(run.live);
    expect(run.live.status).toBe("found");
    expect(run.cassettes.secondhandsongs).not.toContain("Robert Van Winkle");
  });

  it("reads work and performance links only", () => {
    expect(shsLink("https://secondhandsongs.com/work/4196")).toEqual(WORK);
    expect(shsLink("https://secondhandsongs.com/performance/12/")).toEqual({
      kind: "performance",
      id: 12,
    });
    expect(shsLink("https://secondhandsongs.com/artist/12")).toBeNull();
    expect(shsLink("https://example.com/work/4196")).toBeNull();
  });
});
