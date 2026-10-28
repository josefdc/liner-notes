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
import {
  cachedEvidenceOf,
  cachedEvidenceUse,
  RESEARCH_TTL_MS,
  runEvidence,
} from "../agent/research/runEvidence.js";
import { stubLlm, testRuntime } from "../agent/testing/stubLlm.js";
import { shownEvidence } from "../agent/prompts.js";
import { captureLogsForTests } from "../logger.js";
import { runMigrations } from "../store/migrations.js";
import { SonicCache, TTL_MUSICBRAINZ_RECORDING } from "../store/cache.js";
import {
  collectPrimarySources,
  DATES_INCOMPLETE,
  MAP_INCOMPLETE,
  type RecordingCache,
  RELEASES_INCOMPLETE,
} from "./identity.js";
import {
  getRecordingDetails,
  type MbRelationship,
  MusicBrainzRateLimiter,
  withMusicBrainzPriority,
} from "./musicbrainz.js";
import { PaceRefused } from "./pacing.js";
import { evidenceScope } from "./records.js";
import { type FetchCall, json, never, stubFetch } from "./testing/fetchStub.js";
import { queueOnFakeClock, settleOnFakeClock } from "./testing/fakeClock.js";
import { ICE_TRACK, primaryRoute } from "./testing/iceIceBaby.js";

const MB = "https://musicbrainz.org/ws/2";
const ICE = "875c24bc-fe9e-4ac6-80d3-beaacb70ee43";
const UNDER_PRESSURE = "32c7e292-14f1-4080-bddf-ef852e0a4c59";
const ICE_ICE_BACON = "6507f9c2-48c9-4648-9daa-4c9271e0f983";
const PUSHIN_ICE = "51a54bec-25d2-49de-bb9f-bfff669367cc";
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

/** The recording ids a search by recording id asks for. */
const dateIds = (call: FetchCall): string[] =>
  (new URL(call.url).searchParams.get("query") ?? "").match(
    /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g,
  ) ?? [];

/** The dates the search by recording id answers: every recording asked but the sibling. */
function dateSearch(call: FetchCall) {
  const ids = dateIds(call);
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

/** The per-recording cache on a fresh database, with the database. */
function recordingCacheWithDb() {
  const db = new Database(":memory:");
  runMigrations(db);
  onTestFinished(() => {
    db.close();
  });
  return { db, cache: new SonicCache(db) };
}

/** The per-recording cache on a fresh database. */
const recordingCache = (): SonicCache => recordingCacheWithDb().cache;

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

    // The source's details once, then one search by recording id for the dates of the
    // track's own relations and the second hop's recordings ("Under Pressure" is dated by its
    // details), both right after the recording's lookup.
    expect(net.calls.filter(isHopRead)).toHaveLength(1);
    const mapReads = net.calls.filter((c) => isHopRead(c) || isDateSearch(c));
    expect(mapReads.map(isHopRead)).toEqual([true, false]);
    expect(dateIds(mapReads[1]).sort()).toEqual(
      [ICE_ICE_BACON, PUSHIN_ICE, SIBLING, EARLIER].sort(),
    );
    expect(net.calls.indexOf(mapReads[0])).toBe(2);
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
    // Each date on the dated recording's own page, as read; the analysed recording's in its
    // own item. None for the sibling MusicBrainz does not date.
    expect(mb.evidence.find((e) => e.id === `musicbrainz:recording/${UNDER_PRESSURE}`)).toEqual(
      expect.objectContaining({
        recordRef: `recording/${UNDER_PRESSURE}`,
        url: `https://musicbrainz.org/recording/${UNDER_PRESSURE}`,
        excerpt:
          'MusicBrainz recording "Under Pressure" by Queen & David Bowie, first released 1981-10-26.',
        retrievedAt: now().toISOString(),
      }),
    );
    expect(mb.evidence.some((e) => e.id === `musicbrainz:recording/${SIBLING}`)).toBe(false);
    expect(mb.evidence[0].excerpt).toBe(
      'MusicBrainz recording "Ice Ice Baby" by Vanilla Ice (4:31), ISRC USCA29001716, first released 1990-09-04.',
    );

    // The pack takes them, last; the model is never shown them.
    const pack = new EvidencePack();
    pack.addAll(primaryRecordEvidence(sources));
    const items = pack.items();
    const mapItems = items.filter((e) => e.recordRef?.startsWith("recording/"));
    // Two relations and three dates (the source, what it samples, and a recording sampling
    // this one).
    expect(mapItems).toHaveLength(5);
    expect(items.slice(-mapItems.length)).toEqual(mapItems);
    const shown = new Set(shownEvidence(items).map((e) => e.id));
    expect(mapItems.filter((e) => shown.has(e.id))).toEqual([]);
    expect(shown.size).toBe(items.length - mapItems.length);

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
    expect(cache.getMbHop(UNDER_PRESSURE)?.hop.recording.firstReleaseDate).toBe("1981-10-26");
    // Asked and not dated: kept as such, so it is not asked again.
    const readAt = now().toISOString();
    expect(cache.getMbDate(SIBLING)).toEqual({ date: null, readAt });
    expect(cache.getMbDate(EARLIER)).toEqual({ date: "1975", readAt });

    const again = stubFetch(primaryRoute);
    const second = records(
      await collectPrimarySources(ICE_TRACK, { now, relationsMap: { cache } }),
    );
    expect(again.calls.filter((c) => isHopRead(c) || isDateSearch(c))).toEqual([]);
    expect(second.records).toEqual(first.records);
    expect(second.evidence).toEqual(first.evidence);
  });

  it("keeps a row 48 h to the second, and purges only expired rows", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    const { cache, db } = recordingCacheWithDb();
    const readAt = "2026-10-20T00:00:00.000Z";
    cache.putMbDate(EARLIER, "1975", readAt);
    cache.putMbDate(SIBLING, null, readAt, 1000);
    vi.setSystemTime(new Date("2026-10-21T23:59:59Z"));
    expect(cache.getMbDate(EARLIER)).toEqual({ date: "1975", readAt });
    expect(cache.purgeExpired().recordings).toBe(1);
    const left = () =>
      db.prepare("SELECT mbid FROM musicbrainz_recording_cache").pluck().all() as string[];
    expect(left()).toEqual([EARLIER]);
    vi.setSystemTime(new Date("2026-10-22T00:00:00Z"));
    expect(cache.getMbDate(EARLIER)).toBeNull();
    expect(cache.purgeExpired().recordings).toBe(1);
    expect(left()).toEqual([]);
    // Purged by an index on the expiry.
    const plan = db
      .prepare("EXPLAIN QUERY PLAN DELETE FROM musicbrainz_recording_cache WHERE expires_at <= ?")
      .all(0) as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toMatch(
      /musicbrainz_recording_cache_expires_at/,
    );
  });

  it("keeps a recording's reads as long as the research cache keeps research", () => {
    expect(TTL_MUSICBRAINZ_RECORDING).toBe(RESEARCH_TTL_MS);
    const cache = recordingCache();
    const readAt = now().toISOString();
    cache.putMbDate(EARLIER, "1975", readAt, -1000);
    expect(cache.getMbDate(EARLIER)).toBeNull();
    expect(cache.getMbHop("not-an-mbid")).toBeNull();
    expect(() => cache.putMbDate(EARLIER, "the seventies", readAt)).toThrow(TypeError);
    expect(() => cache.putMbDate(EARLIER, "1975", "not a time")).toThrow(TypeError);
  });

  it("reads the map first in a short budget, and the chain's last reads are cut", async () => {
    // At the real 1.1 s spacing the map's two reads are sent at 2.2 s and 3.3 s, right after
    // the recording's lookup, and the chain's own reads follow. With an 8 s deadline a map read
    // may start until 5.2 s: both are made. The chain's last reads (the work's second page of
    // recordings, then the recording's releases) come after the 6 s dating cut.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const collect = async (deadlineMs: number, relationsMap?: object) => {
      MusicBrainzRateLimiter.getInstance().resetForTests();
      const net = stubFetch(route);
      const t0 = performance.now();
      let settledAt = -1;
      const run = collectPrimarySources(ICE_TRACK, {
        now,
        deadlineMs,
        ...(relationsMap ? { relationsMap } : {}),
      }).then((sources) => {
        settledAt = performance.now() - t0;
        return sources;
      });
      await vi.runAllTimersAsync();
      const mb = records(await run);
      return { mb, settledAt, mapReads: net.calls.filter((c) => isHopRead(c) || isDateSearch(c)) };
    };
    const inTime = await collect(20_000, {});
    expect(inTime.mapReads).toHaveLength(2);
    expect(hops(inTime.mb.records)).toHaveLength(2);
    expect(inTime.mb.incomplete).not.toContain(MAP_INCOMPLETE);

    const late = await collect(8000, {});
    expect(late.mapReads.map(isDateSearch)).toEqual([false, true]);
    expect(hops(late.mb.records)).toHaveLength(2);
    expect(late.mb.error).toBeUndefined();
    const sample = late.mb.records.find((r) => r.recording?.mbid === UNDER_PRESSURE);
    expect(sample?.recording?.firstReleaseDate).toBe("1981-10-26");
    // The map is complete; the work's recordings could not all be dated and no release is
    // named, and the notes say so.
    expect(late.mb.incomplete).toContain(DATES_INCOMPLETE);
    expect(late.mb.incomplete).toContain(RELEASES_INCOMPLETE);
    expect(late.mb.incomplete).not.toContain(MAP_INCOMPLETE);
  });

  it("leaves a map it could not read in full for a later run to read again", async () => {
    unpaced();
    const cache = recordingCache();
    const logs = captureLogsForTests({ level: "warn" });
    onTestFinished(() => logs.restore());
    stubFetch((call) =>
      isDateSearch(call)
        ? new Response("busy", { status: 503, headers: { "retry-after": "0" } })
        : route(call),
    );
    const sources = await collectPrimarySources(ICE_TRACK, { now, relationsMap: { cache } });
    const evidence = await runEvidence(
      Promise.resolve({ status: "read", sources }),
      [],
      { writer: () => {} } as never,
      testRuntime(
        stubLlm(() => ({})),
        now().toISOString(),
      ),
    );
    expect(evidence.incomplete).toContainEqual({ source: "musicbrainz", part: "map" });
    expect(
      evidence.status.some((line) => line.startsWith("MusicBrainz relations map incomplete")),
    ).toBe(true);
    // One log line says what the map did not read.
    const lines = logs.messages("warn").filter((line) => /Relations map/.test(line));
    expect(lines).toEqual([
      expect.stringMatching(
        /^Relations map incomplete for recording\/.+: not read the dates of \d+ recordings/,
      ),
    ]);
    // The research cached from it is read again, not served as is.
    const cached = cachedEvidenceOf(evidence, ICE_TRACK.isrc, null, now().toISOString());
    expect(cachedEvidenceUse(cached, ICE_TRACK.isrc)).toBe("refresh");
    // The second hop read then comes from the cache: only the dates are asked again.
    const again = stubFetch(route);
    const second = records(
      await collectPrimarySources(ICE_TRACK, { now, relationsMap: { cache } }),
    );
    expect(again.calls.filter(isHopRead)).toEqual([]);
    expect(again.calls.filter(isDateSearch)).toHaveLength(1);
    expect(second.incomplete).not.toContain(MAP_INCOMPLETE);
  });

  it("has read the map when the chain's own reads end past the map's start limit", async () => {
    // With the 20 s deadline the map's reads may start until 13.5 s; the dating cut is at 15 s.
    // Here MusicBrainz answers the recording's releases (the chain's last read) only at 13.6 s:
    // a request sent then would start too late, but the map's were sent right after the
    // recording's lookup, ahead of the chain's later reads.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const t0 = performance.now();
    const net = stubFetch(async (call) => {
      if (call.url.startsWith(`${MB}/release?`)) {
        await new Promise((resolve) => setTimeout(resolve, 13_600 - (performance.now() - t0)));
      }
      return route(call);
    });
    const run = collectPrimarySources(ICE_TRACK, { now, relationsMap: {} });
    await vi.runAllTimersAsync();
    const mb = records(await run);
    expect(net.calls.filter((c) => isHopRead(c) || isDateSearch(c)).map(isDateSearch)).toEqual([
      false,
      true,
    ]);
    expect(net.calls.findIndex(isDateSearch)).toBe(3);
    expect(hops(mb.records)).toHaveLength(2);
    expect(mb.error).toBeUndefined();
    expect(mb.incomplete).not.toContain(MAP_INCOMPLETE);
  });

  it.each([
    ["the second hop's read", isHopRead],
    ["the date search", isDateSearch],
  ])("settles by the dating cut when %s never answers", async (_name, held) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const t0 = performance.now();
    stubFetch((call) => (held(call) ? never(call) : route(call)));
    let settledAt = -1;
    const run = collectPrimarySources(ICE_TRACK, { now, relationsMap: {} }).then((sources) => {
      settledAt = performance.now() - t0;
      return sources;
    });
    await vi.runAllTimersAsync();
    const mb = records(await run);
    // The 20 s deadline less the 5 s left for the other sources.
    expect(settledAt).toBeGreaterThan(0);
    expect(settledAt).toBeLessThanOrEqual(15_000);
    expect(mb.error).toBeUndefined();
  });

  it("caches only what the date search answers about", async () => {
    unpaced();
    const { cache, db } = recordingCacheWithDb();
    const answers: unknown[] = [{ count: 0, recordings: [] }, { count: 1 }];
    for (const answer of answers) {
      stubFetch((call) => (isDateSearch(call) ? json(answer) : route(call)));
      await collectPrimarySources(ICE_TRACK, { now, relationsMap: { cache } });
      const dates = db
        .prepare("SELECT COUNT(*) FROM musicbrainz_recording_cache WHERE part = 'date'")
        .pluck()
        .get();
      // An answer that lists no recording says nothing of any: nothing kept, asked again later.
      expect(dates).toBe(0);
    }
    // One that lists a recording without a date says it has none: kept as such.
    stubFetch(route);
    await collectPrimarySources(ICE_TRACK, { now, relationsMap: { cache } });
    expect(cache.getMbDate(SIBLING)).toEqual({ date: null, readAt: now().toISOString() });
  });

  it("asks a map read MusicBrainz sheds again once, and then does without it", async () => {
    unpaced();
    const net = stubFetch((call) =>
      isHopRead(call) || isDateSearch(call)
        ? new Response("busy", { status: 503, headers: { "retry-after": "0" } })
        : route(call),
    );
    const mb = records(await collectPrimarySources(ICE_TRACK, { now, relationsMap: {} }));
    expect(net.calls.filter(isHopRead)).toHaveLength(2);
    expect(net.calls.filter(isDateSearch)).toHaveLength(2);
    expect(mb.error).toBeUndefined();
    expect(mb.incomplete).toContain(MAP_INCOMPLETE);
  });

  it("refuses cached relations whose dates their items do not state", async () => {
    unpaced();
    stubFetch(route);
    const sources = await collectPrimarySources(ICE_TRACK, { now, relationsMap: {} });
    const items = primaryRecordEvidence(sources);
    const relations = primaryRelations(sources);
    expect(relationsIssue(relations, items)).toBeNull();
    const tampered = (date: string, hop: boolean) =>
      relations.map((r) =>
        hop && r.type === "hop" && r.kind === "samples"
          ? { ...r, other: { ...r.other, firstReleaseDate: date } }
          : !hop && r.type === "relation" && r.other.mbid === UNDER_PRESSURE
            ? { ...r, other: { ...r.other, firstReleaseDate: date } }
            : r,
      );
    expect(relationsIssue(tampered("1901", false), items)).toBe(
      "a first release date no item states",
    );
    expect(relationsIssue(tampered("2099", true), items)).toBe(
      "a first release date no item states",
    );
  });

  it("restores a map item only when its recording is one this one samples", async () => {
    unpaced();
    stubFetch(route);
    const items = primaryRecordEvidence(
      await collectPrimarySources(ICE_TRACK, { now, relationsMap: {} }),
    );
    const context = {
      readAt: now().toISOString(),
      recordingMbid: ICE,
      trackIsOriginal: false,
      configured: { discogs: false, genius: false },
    };
    expect(restoredEvidence(items, context)).not.toBeNull();
    // Without the item that says this recording samples "Under Pressure".
    const sample = `musicbrainz:track/recording/${ICE}/samples/recording/${UNDER_PRESSURE}`;
    const unsourced = items.filter((item) => item.id !== sample);
    expect(unsourced.length).toBe(items.length - 1);
    expect(restoredEvidence(unsourced, context)).toBeNull();
    expect(
      restoredEvidence(
        unsourced.filter((item) => !item.recordRef?.startsWith("recording/")),
        context,
      ),
    ).not.toBeNull();
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

describe("the relations map's place in the MusicBrainz queue", () => {
  const [A, B, C, D] = [ICE, UNDER_PRESSURE, SIBLING, EARLIER];
  const answer = (call: FetchCall) => {
    const id = new URL(call.url).pathname.split("/").at(-1) ?? "";
    return json({ id, title: "x", relations: [] });
  };

  it("sends a map read after every chain's own reads and before the others", async () => {
    queueOnFakeClock(100);
    const sent: string[] = [];
    stubFetch((call) => {
      sent.push(new URL(call.url).pathname.split("/").at(-1) ?? "");
      return answer(call);
    });
    // The first request is sent at once; the next three wait their turn, queued in this order.
    const first = getRecordingDetails(A);
    const research = getRecordingDetails(B);
    const map = getRecordingDetails(C, undefined, { notAfter: Number.POSITIVE_INFINITY });
    const chain = withMusicBrainzPriority(() => getRecordingDetails(D));
    await settleOnFakeClock(Promise.all([first, research, map, chain]));
    expect(sent).toEqual([A, D, C, B]);
  });

  it("keeps the chain's next read ahead of a waiting research read after a slow answer", async () => {
    // The chain's read takes 1.5 s, longer than the 1.1 s spacing; a research read has waited
    // meanwhile. The chain's next read, queued as soon as the first is answered, goes first.
    queueOnFakeClock(1100);
    const sent: Array<[string, number]> = [];
    const t0 = performance.now();
    stubFetch(async (call) => {
      const id = new URL(call.url).pathname.split("/").at(-1) ?? "";
      sent.push([id, performance.now() - t0]);
      if (id === A) await new Promise((resolve) => setTimeout(resolve, 1500));
      return answer(call);
    });
    const chain = withMusicBrainzPriority(async () => {
      await getRecordingDetails(A);
      await getRecordingDetails(D);
    });
    const research = new Promise((resolve) => setTimeout(resolve, 100)).then(() =>
      getRecordingDetails(B),
    );
    await settleOnFakeClock(Promise.all([chain, research]));
    expect(sent).toEqual([
      [A, 0],
      [D, 1500],
      [B, 2600],
    ]);
  });

  it("refuses a map read whose turn comes after its start limit, and keeps its slot free", async () => {
    queueOnFakeClock(1000);
    const sent: Array<[string, number]> = [];
    const t0 = performance.now();
    stubFetch((call) => {
      sent.push([new URL(call.url).pathname.split("/").at(-1) ?? "", performance.now() - t0]);
      return answer(call);
    });
    const first = getRecordingDetails(A);
    // Queued well before its limit (500 ms), but its turn comes at 1000 ms.
    const late = getRecordingDetails(C, undefined, { notAfter: t0 + 500 }).then(
      () => "sent",
      (error: unknown) => error,
    );
    const next = getRecordingDetails(B);
    await settleOnFakeClock(Promise.all([first, late, next]));
    expect(await late).toBeInstanceOf(PaceRefused);
    expect(sent).toEqual([
      [A, 0],
      [B, 1000],
    ]);
  });
});
