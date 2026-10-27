/**
 * The relations map on "Ice Ice Baby" (the captured MusicBrainz fixtures), which samples "Under
 * Pressure": the chain reads the second hop from that source (what it samples, and the other
 * recordings that sample it) and the related recordings' first release dates, within its time,
 * through the per-recording MusicBrainz cache. The second hop's details below are written for
 * these tests (two made-up recordings), not captured.
 */

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  EvidencePack,
  primaryRecordEvidence,
  restoredEvidence,
} from "../agent/research/evidencePack.js";
import { primaryRelations, relationsIssue } from "../agent/research/relations.js";
import { RESEARCH_TTL_MS } from "../agent/research/runEvidence.js";
import { shownEvidence } from "../agent/prompts.js";
import { runMigrations } from "../store/migrations.js";
import { SonicCache, TTL_MUSICBRAINZ_RECORDING } from "../store/cache.js";
import { collectPrimarySources, type RecordingCache } from "./identity.js";
import { type MbRelationship, MusicBrainzRateLimiter } from "./musicbrainz.js";
import { evidenceScope } from "./records.js";
import { type FetchCall, json, stubFetch } from "./testing/fetchStub.js";
import { ICE_TRACK, primaryRoute } from "./testing/iceIceBaby.js";

const MB = "https://musicbrainz.org/ws/2";
const ICE = "875c24bc-fe9e-4ac6-80d3-beaacb70ee43";
const UNDER_PRESSURE = "32c7e292-14f1-4080-bddf-ef852e0a4c59";
const ICE_ICE_BACON = "6507f9c2-48c9-4648-9daa-4c9271e0f983";
/** Made-up recordings of the second hop. */
const SIBLING = "11111111-1111-4111-8111-111111111111";
const EARLIER = "22222222-2222-4222-8222-222222222222";
const now = () => new Date("2026-10-20T12:00:00.000Z");

const credit = (name: string) => [{ name, joinphrase: "", artist: { id: SIBLING, name } }];

/** "Under Pressure" with its sample relationships: sampled by this track and a sibling, and
 * sampling an earlier recording. */
const underPressure = {
  id: UNDER_PRESSURE,
  title: "Under Pressure",
  "first-release-date": "1981-10-26",
  length: 243_000,
  "artist-credit": [
    { name: "Queen", joinphrase: " & ", artist: { id: EARLIER, name: "Queen" } },
    { name: "David Bowie", joinphrase: "", artist: { id: SIBLING, name: "David Bowie" } },
  ],
  relations: [
    {
      type: "samples material",
      direction: "backward",
      "target-type": "recording",
      attributes: [],
      recording: { id: ICE, title: "Ice Ice Baby", "artist-credit": credit("Vanilla Ice") },
    },
    {
      type: "samples material",
      direction: "backward",
      "target-type": "recording",
      attributes: [],
      recording: { id: SIBLING, title: "Sibling Song", "artist-credit": credit("Sibling Artist") },
    },
    {
      type: "samples material",
      direction: "forward",
      "target-type": "recording",
      attributes: [],
      recording: { id: EARLIER, title: "Earlier Song", "artist-credit": credit("Earlier Artist") },
    },
  ],
};

const isHopRead = (call: FetchCall) => call.url.startsWith(`${MB}/recording/${UNDER_PRESSURE}?`);
const isDateSearch = (call: FetchCall) => call.url.startsWith(`${MB}/recording?query=`);

/** The dates the search by recording id answers: every recording asked but the sibling. */
function dateSearch(call: FetchCall) {
  const query = new URL(call.url).searchParams.get("query") ?? "";
  const ids = query.match(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g) ?? [];
  const dates: Record<string, string> = { [EARLIER]: "1975", [ICE_ICE_BACON]: "2004-02-10" };
  return json({
    count: ids.length,
    recordings: ids.map((id) => ({
      id,
      ...(dates[id] ? { "first-release-date": dates[id] } : {}),
    })),
  });
}

const route = (call: FetchCall) => {
  if (isHopRead(call)) return json(underPressure);
  if (isDateSearch(call)) return dateSearch(call);
  return primaryRoute(call);
};

/** The per-recording cache on a fresh database. */
function recordingCache(): SonicCache {
  const db = new Database(":memory:");
  runMigrations(db);
  onTestFinished(() => {
    db.close();
  });
  return new SonicCache(db);
}

const records = (sources: Awaited<ReturnType<typeof collectPrimarySources>>) => {
  if (sources.musicbrainz.status !== "found") throw new Error(sources.musicbrainz.reason);
  return sources.musicbrainz;
};
const hops = (list: MbRelationship[]) => list.filter((r) => r.about === "hop");

beforeEach(() => {
  for (const name of ["DISCOGS_TOKEN", "GENIUS_ACCESS_TOKEN", "SHS_API_KEY", "SOURCE_CASSETTE"]) {
    delete process.env[name];
  }
  for (const method of ["log", "warn", "error", "info"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
  MusicBrainzRateLimiter.getInstance().resetForTests();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  MusicBrainzRateLimiter.getInstance().resetForTests();
});

/** No spacing between MusicBrainz requests, for the tests that do not time them. */
function unpaced() {
  const restore = MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
  onTestFinished(restore);
}

describe("the relations map", () => {
  it("reads the second hop and dates the related recordings from MusicBrainz", async () => {
    unpaced();
    const net = stubFetch(route);
    const sources = await collectPrimarySources(ICE_TRACK, { now, relationsMap: {} });
    const mb = records(sources);

    // The source's details once, and one search by recording id for the dates.
    expect(net.calls.filter(isHopRead)).toHaveLength(1);
    expect(net.calls.filter(isDateSearch)).toHaveLength(1);
    expect(mb.error).toBeUndefined();

    // The sibling and what the source samples, never this track itself.
    expect(hops(mb.records).map((r) => [r.kind, r.recording?.mbid, r.via?.mbid])).toEqual([
      ["sampled-by", SIBLING, UNDER_PRESSURE],
      ["samples", EARLIER, UNDER_PRESSURE],
    ]);
    // Dated by MusicBrainz: the source by its own details, the others by the search; the
    // sibling MusicBrainz does not date stays undated.
    const sample = mb.records.find((r) => r.recording?.mbid === UNDER_PRESSURE);
    expect(sample?.recording?.firstReleaseDate).toBe("1981-10-26");
    const bacon = mb.records.find((r) => r.recording?.mbid === ICE_ICE_BACON);
    expect(bacon?.recording?.firstReleaseDate).toBe("2004-02-10");
    const [sibling, earlier] = hops(mb.records);
    expect(sibling.recording).not.toHaveProperty("firstReleaseDate");
    expect(earlier.recording?.firstReleaseDate).toBe("1975");
    expect(earlier.via?.firstReleaseDate).toBe("1981-10-26");

    // Each hop record's item: about two other recordings, with no scope, on the source's page.
    const item = mb.evidence.find((e) => e.id === sibling.evidenceId);
    expect(item).toMatchObject({
      id: `musicbrainz:recording/${UNDER_PRESSURE}/sampled-by/recording/${SIBLING}`,
      recordRef: `recording/${UNDER_PRESSURE}/sampled-by/recording/${SIBLING}`,
      url: `https://musicbrainz.org/recording/${UNDER_PRESSURE}`,
      excerpt:
        'MusicBrainz: "Under Pressure" by Queen & David Bowie is sampled in "Sibling Song" by Sibling Artist.',
    });
    expect(item && evidenceScope(item)).toBeNull();

    // The pack takes them, last; the model is never shown them.
    const pack = new EvidencePack();
    pack.addAll(primaryRecordEvidence(sources));
    const items = pack.items();
    const mapItems = items.filter((e) => e.recordRef?.startsWith("recording/"));
    expect(mapItems).toHaveLength(2);
    expect(items.slice(-2)).toEqual(mapItems);
    const shown = new Set(shownEvidence(items).map((e) => e.id));
    expect(mapItems.filter((e) => shown.has(e.id))).toEqual([]);
    expect(shown.size).toBe(items.length - 2);

    // The relations carry the dates, and the cache's check accepts what it wrote.
    const relations = primaryRelations(sources);
    expect(relations.filter((r) => r.type === "hop")).toEqual([
      expect.objectContaining({
        kind: "sampled-by",
        scope: null,
        via: expect.objectContaining({ mbid: UNDER_PRESSURE, firstReleaseDate: "1981-10-26" }),
        other: expect.not.objectContaining({ firstReleaseDate: expect.anything() }),
      }),
      expect.objectContaining({
        kind: "samples",
        other: expect.objectContaining({ mbid: EARLIER, firstReleaseDate: "1975" }),
      }),
    ]);
    expect(relations).toContainEqual(
      expect.objectContaining({
        type: "relation",
        kind: "samples",
        other: expect.objectContaining({ mbid: UNDER_PRESSURE, firstReleaseDate: "1981-10-26" }),
      }),
    );
    expect(relationsIssue(relations, items)).toBeNull();
    // The research cache gives them back as its other items.
    const restored = restoredEvidence(
      items.map((e) => ({ ...e })),
      {
        readAt: now().toISOString(),
        recordingMbid: ICE,
        trackIsOriginal: false,
        configured: { discogs: false, genius: false },
      },
    );
    expect(restored?.map((e) => e.id)).toEqual(items.map((e) => e.id));
    // Not one stated about another recording's page.
    const moved = items.map((e) =>
      e.id === sibling.evidenceId ? { ...e, url: `https://musicbrainz.org/recording/${ICE}` } : e,
    );
    expect(
      restoredEvidence(moved, {
        readAt: now().toISOString(),
        recordingMbid: ICE,
        trackIsOriginal: false,
        configured: { discogs: false, genius: false },
      }),
    ).toBeNull();
  });

  it("is not read unless asked for", async () => {
    unpaced();
    const net = stubFetch(route);
    const mb = records(await collectPrimarySources(ICE_TRACK, { now }));
    expect(net.calls.filter((c) => isHopRead(c) || isDateSearch(c))).toEqual([]);
    expect(hops(mb.records)).toEqual([]);
  });

  it("makes no request for what the cache holds", async () => {
    unpaced();
    const cache = recordingCache();
    stubFetch(route);
    const first = records(await collectPrimarySources(ICE_TRACK, { now, relationsMap: { cache } }));
    expect(cache.getMbHop(UNDER_PRESSURE)?.recording.firstReleaseDate).toBe("1981-10-26");
    // Asked and not dated: kept as such, so it is not asked again.
    expect(cache.getMbDate(SIBLING)).toEqual({ date: null });
    expect(cache.getMbDate(EARLIER)).toEqual({ date: "1975" });

    const again = stubFetch(primaryRoute);
    const second = records(
      await collectPrimarySources(ICE_TRACK, { now, relationsMap: { cache } }),
    );
    expect(again.calls.filter((c) => isHopRead(c) || isDateSearch(c))).toEqual([]);
    expect(second.records).toEqual(first.records);
    expect(second.evidence).toEqual(first.evidence);
  });

  it("keeps a recording's reads as long as the research cache keeps research", () => {
    expect(TTL_MUSICBRAINZ_RECORDING).toBe(RESEARCH_TTL_MS);
    const cache = recordingCache();
    cache.putMbDate(EARLIER, "1975", -1000);
    expect(cache.getMbDate(EARLIER)).toBeNull();
    expect(cache.getMbHop("not-an-mbid")).toBeNull();
    expect(() => cache.putMbDate(EARLIER, "the seventies")).toThrow(TypeError);
  });

  it("drops the second hop quietly when the chain's time is nearly out", async () => {
    // At the real 1.1 s spacing the chain's own reads take until 5.5 s. With the 20 s deadline
    // the map's reads start by 13.5 s and are made; with an 8 s deadline they would have to
    // start by 5.2 s, and are not.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const collect = async (deadlineMs: number) => {
      const net = stubFetch(route);
      const run = collectPrimarySources(ICE_TRACK, { now, deadlineMs, relationsMap: {} });
      await vi.runAllTimersAsync();
      const mb = records(await run);
      return { mb, mapReads: net.calls.filter((c) => isHopRead(c) || isDateSearch(c)) };
    };
    const inTime = await collect(20_000);
    expect(inTime.mapReads).toHaveLength(2);
    expect(hops(inTime.mb.records)).toHaveLength(2);

    MusicBrainzRateLimiter.getInstance().resetForTests();
    const late = await collect(8000);
    expect(late.mapReads).toEqual([]);
    expect(hops(late.mb.records)).toEqual([]);
    // Nothing lost and no error: the track's own records are all there, undated.
    expect(late.mb.error).toBeUndefined();
    const sample = late.mb.records.find((r) => r.recording?.mbid === UNDER_PRESSURE);
    expect(sample?.recording).not.toHaveProperty("firstReleaseDate");
    expect(late.mb.incomplete).toBe(inTime.mb.incomplete);
  });

  it("drops a hop read that fails, and still dates what it can", async () => {
    unpaced();
    const net = stubFetch((call) =>
      isHopRead(call) ? new Response("bad gateway", { status: 502 }) : route(call),
    );
    const sources = await collectPrimarySources(ICE_TRACK, { now, relationsMap: {} });
    const mb = records(sources);
    expect(net.calls.filter(isHopRead).length).toBeGreaterThan(0);
    expect(hops(mb.records)).toEqual([]);
    expect(mb.error).toBeUndefined();
    const bacon = mb.records.find((r) => r.recording?.mbid === ICE_ICE_BACON);
    expect(bacon?.recording?.firstReleaseDate).toBe("2004-02-10");
  });

  it("reads as if there were no cache when the cache is broken", async () => {
    unpaced();
    const broken: RecordingCache = {
      getMbHop: () => {
        throw new Error("disk I/O error");
      },
      putMbHop: () => {
        throw new Error("disk I/O error");
      },
      getMbDate: () => {
        throw new Error("disk I/O error");
      },
      putMbDate: () => {
        throw new Error("disk I/O error");
      },
    };
    const net = stubFetch(route);
    const mb = records(
      await collectPrimarySources(ICE_TRACK, { now, relationsMap: { cache: broken } }),
    );
    expect(net.calls.filter(isHopRead)).toHaveLength(1);
    expect(hops(mb.records)).toHaveLength(2);
  });
});

describe("the relations map's pacing", () => {
  it("keeps every MusicBrainz request of the chain and the map 1.1 s or more apart", async () => {
    // A fake clock at the queue's own spacing: the gaps are what the queue enforces.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const at: number[] = [];
    const net = stubFetch((call) => {
      if (call.url.startsWith(MB)) at.push(performance.now());
      return route(call);
    });
    const run = collectPrimarySources(ICE_TRACK, { now, relationsMap: {} });
    await vi.runAllTimersAsync();
    const mb = records(await run);

    expect(hops(mb.records)).toHaveLength(2);
    expect(net.calls.filter(isHopRead)).toHaveLength(1);
    expect(net.calls.filter(isDateSearch)).toHaveLength(1);
    expect(at.length).toBeGreaterThanOrEqual(7);
    const gaps = at.slice(1).map((t, i) => t - at[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(1100);
  });
});
