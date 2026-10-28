/**
 * The relations map's years on a track with many relations, shaped like "Gangsta's Paradise"
 * (Coolio feat. L.V.) as MusicBrainz answered for it on 2026-10-28: nine recordings it samples,
 * is sampled by or is remixed by, seven of them with a first release date in MusicBrainz's
 * search, and one source ("Pastime Paradise") whose second hop the map reads. Ids, titles,
 * credits and dates are MusicBrainz's; what "Pastime Paradise" samples and the other
 * recordings that sample it are written for these tests, as are the work's other recordings
 * and the single the recording is on.
 */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { captureLogsForTests } from "../logger.js";
import { collectPrimarySources, type RecordingCache } from "./identity.js";
import { type MbRelationship, MusicBrainzRateLimiter } from "./musicbrainz.js";
import { type FetchCall, type FetchRoute, json, never, stubFetch } from "./testing/fetchStub.js";
import type { TrackRef } from "./records.js";

const MB = "https://musicbrainz.org/ws/2";
const ISRC = "USTB10400128";
const GANGSTAS = "2f7a6735-2e09-4ce2-81e4-b148e6c39a55";
const WORK = "5efe152c-3104-3226-9084-d71efc6356af";
const PASTIME = "e97bedfc-b0ee-4cb6-8343-03a714caab15";
const COOLIO = "cc30e630-8c75-4d78-b205-8e2edc6bdaa7";
const now = () => new Date("2026-10-28T12:00:00.000Z");

const TRACK: TrackRef = {
  isrc: ISRC,
  title: "Gangsta's Paradise",
  artists: ["Coolio", "L.V."],
  durationMs: 241_306,
};

const credit = (name: string, id: string) => [{ name, joinphrase: "", artist: { id, name } }];

/** The recording's nine relations the map draws, with the date MusicBrainz's search gives. */
const DIRECT = [
  {
    type: "samples material",
    direction: "forward",
    id: PASTIME,
    title: "Pastime Paradise",
    artist: ["Stevie Wonder", "1ee18fb3-18a6-4c7f-8ba0-bc41cdd0462e"],
    date: "1976-09-28",
  },
  {
    type: "samples material",
    direction: "backward",
    id: "dc240d13-1dc8-4f90-bdb5-620fdcf88cd2",
    title: "Age",
    artist: ["Contopp nd #Sloppit#", "475a613f-6be7-4225-b246-2ad87db9cb8d"],
    date: "2022-11-08",
  },
  {
    type: "samples material",
    direction: "backward",
    id: "eb932b77-c9cd-4e26-a6f0-cb88bfb880b1",
    title: "Caramella’s Paradise",
    artist: ["Holo Bass", "29d67fea-28a7-4856-84f5-7af4c1c03baa"],
    date: "2021-04-01",
  },
  {
    type: "samples material",
    direction: "backward",
    id: "b1737dd2-627b-469a-b040-7f5fe39cca7d",
    title: "Driven",
    artist: ["Contopp nd #Sloppit#", "475a613f-6be7-4225-b246-2ad87db9cb8d"],
    date: "2022-10-20",
  },
  {
    type: "samples material",
    direction: "backward",
    id: "186b8f79-e9bb-46cb-8f73-09772eeea9af",
    title: "Zabaci domaćine",
    artist: ["Bad Copy", "b8b63c66-8277-40f3-9424-2a8f07acccb4"],
    date: "1996",
  },
  {
    type: "samples material",
    direction: "backward",
    id: "46b390a2-da0e-4964-bda0-280909cabf74",
    title: "Пей пиво!",
    artist: ["Дискотека Авария", "8a0efc57-d9ea-452a-b2ce-55cffc7a9784"],
    date: "2000",
  },
  {
    type: "remix",
    direction: "backward",
    id: "a13974fa-cf9d-413d-ade3-147f56a64958",
    title:
      "Gangsta’s Paradise (Candyland OG Version) (Tarraxa Remixed By DJ RADIKAL Feat Cristian Kizomba Paredes Leiva)",
    artist: ["Coolio", COOLIO],
    date: null,
  },
  {
    type: "remix",
    direction: "backward",
    id: "bb60fbdc-8bb5-4af8-b81e-a703867cccbc",
    title: "Gangsta's Paradise (Cj Borika Remix)",
    artist: ["Cj Borika", "407a30b4-190b-4ef0-b65b-f07756f30b82"],
    date: "2021-10-22",
  },
  {
    type: "remix",
    direction: "backward",
    id: "ae6a6e5d-0f82-49d6-9947-6691ca53cd89",
    title: "Gangsters Paradise (Candyland's OG Remix)",
    artist: ["Coolio", COOLIO],
    date: null,
  },
] as const;
const DIRECT_IDS = DIRECT.map((r) => r.id);
/** The direct relations MusicBrainz dates (all but the two Candyland remixes). */
const DATED = DIRECT.filter((r) => r.date !== null);

/** Made-up recordings of the second hop: two that sample "Pastime Paradise", one it samples. */
const SIBLING = "33333333-3333-4333-8333-333333333333";
const UNDATED_SIBLING = "44444444-4444-4444-8444-444444444444";
const EARLIER = "55555555-5555-4555-8555-555555555555";
const HOP_IDS = [SIBLING, UNDATED_SIBLING, EARLIER];

/** What MusicBrainz's search by recording id dates; anything else is listed without a date. */
const DATES: Record<string, string> = {
  ...Object.fromEntries(DATED.map((r) => [r.id, r.date])),
  [SIBLING]: "2005-05-05",
  [EARLIER]: "1970",
};

const isrcAnswer = {
  isrc: ISRC,
  recordings: [
    {
      id: GANGSTAS,
      title: "Gangsta’s Paradise",
      "first-release-date": "1995-07-11",
      length: 241_306,
      disambiguation: "",
      "artist-credit": [
        { name: "Coolio", joinphrase: " featuring ", artist: { id: COOLIO, name: "Coolio" } },
        {
          name: "L.V.",
          joinphrase: "",
          artist: { id: "773c48db-eb0c-491f-9a36-633d72dcee8d", name: "L.V." },
        },
      ],
    },
  ],
};

const details = {
  ...isrcAnswer.recordings[0],
  relations: [
    ...DIRECT.map((r) => ({
      type: r.type,
      direction: r.direction,
      "target-type": "recording",
      attributes: [],
      recording: {
        id: r.id,
        title: r.title,
        length: 240_000,
        disambiguation: "",
        "artist-credit": credit(r.artist[0], r.artist[1]),
      },
    })),
    {
      type: "performance",
      direction: "forward",
      "target-type": "work",
      attributes: [],
      work: { id: WORK, title: "Gangsta’s Paradise", relations: [] },
    },
  ],
};

const work = {
  id: WORK,
  title: "Gangsta’s Paradise",
  relations: [
    {
      type: "performance",
      direction: "backward",
      "target-type": "recording",
      attributes: [],
      recording: { id: GANGSTAS, title: "Gangsta’s Paradise" },
    },
  ],
};

/** The work's 108 recordings: this one, and 107 later ones. */
const workRecordings = [
  isrcAnswer.recordings[0],
  ...Array.from({ length: 107 }, (_, i) => ({
    id: `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`,
    title: "Gangsta’s Paradise (live)",
    "first-release-date": "2001",
    "artist-credit": credit("Coolio", COOLIO),
  })),
];

const pastime = {
  id: PASTIME,
  title: "Pastime Paradise",
  "first-release-date": "1976-09-28",
  length: 207_693,
  "artist-credit": credit("Stevie Wonder", "1ee18fb3-18a6-4c7f-8ba0-bc41cdd0462e"),
  relations: [
    {
      type: "samples material",
      direction: "backward",
      "target-type": "recording",
      attributes: [],
      recording: {
        id: GANGSTAS,
        title: "Gangsta’s Paradise",
        "artist-credit": credit("Coolio", COOLIO),
      },
    },
    ...[
      [SIBLING, "backward", "Sibling Song"],
      [UNDATED_SIBLING, "backward", "Undated Sibling"],
      [EARLIER, "forward", "Earlier Song"],
    ].map(([id, direction, title]) => ({
      type: "samples material",
      direction,
      "target-type": "recording",
      attributes: [],
      recording: { id, title, "artist-credit": credit("Test Artist", COOLIO) },
    })),
  ],
};

const isHopRead = (call: FetchCall) => call.url.startsWith(`${MB}/recording/${PASTIME}?`);
const isDateSearch = (call: FetchCall) => call.url.startsWith(`${MB}/recording?query=`);
const isMapRead = (call: FetchCall) => isHopRead(call) || isDateSearch(call);
const idsOf = (call: FetchCall): string[] =>
  (new URL(call.url).searchParams.get("query") ?? "").match(
    /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/g,
  ) ?? [];

const route: FetchRoute = (call) => {
  const url = new URL(call.url);
  if (call.url.startsWith(`${MB}/isrc/${ISRC}?`)) return json(isrcAnswer);
  if (call.url.startsWith(`${MB}/recording/${GANGSTAS}?`)) return json(details);
  if (isHopRead(call)) return json(pastime);
  if (call.url.startsWith(`${MB}/work/${WORK}?`)) return json(work);
  if (call.url.startsWith(`${MB}/recording?work=${WORK}&`)) {
    const offset = Number(url.searchParams.get("offset"));
    return json({
      "recording-count": workRecordings.length,
      "recording-offset": offset,
      recordings: workRecordings.slice(offset, offset + 100),
    });
  }
  if (call.url.startsWith(`${MB}/release?recording=${GANGSTAS}&`)) {
    return json({
      "release-count": 1,
      "release-offset": 0,
      releases: [
        {
          id: "77777777-7777-4777-8777-777777777777",
          title: "Gangsta’s Paradise",
          date: "1995-07-11",
          status: "Official",
          "release-group": { "primary-type": "Single", "secondary-types": [] },
          "cover-art-archive": { front: true },
          relations: [],
        },
      ],
    });
  }
  if (isDateSearch(call)) {
    const ids = idsOf(call);
    return json({
      count: ids.length,
      offset: 0,
      recordings: ids.map((id) => ({
        id,
        ...(DATES[id] ? { "first-release-date": DATES[id] } : {}),
      })),
    });
  }
  return undefined;
};

/**
 * MusicBrainz under load: a lookup or a search answers in 1.7 s, a browse of up to 100 entities
 * in 2.5 s. With the client's own spacing (a request at most every 1.1 s, one at a time), the
 * chain's six reads end at 12.6 s; the map's reads may start until 13.5 s.
 */
const LOOKUP_MS = 1700;
const BROWSE_MS = 2500;
const latencyOf = (call: FetchCall) =>
  /\/ws\/2\/(?:release\?recording=|recording\?work=)/.test(call.url) ? BROWSE_MS : LOOKUP_MS;

/** `inner`, answered after `ms` (or rejected when the request's signal aborts first). */
const slow =
  (inner: FetchRoute, ms: (call: FetchCall) => number): FetchRoute =>
  (call) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(inner(call)), ms(call));
      call.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(call.signal?.reason);
      });
    });

const records = (sources: Awaited<ReturnType<typeof collectPrimarySources>>) => {
  if (sources.musicbrainz.status !== "found") throw new Error(sources.musicbrainz.reason);
  return sources.musicbrainz;
};
const direct = (list: MbRelationship[]) =>
  list.filter((r) => r.about === "track" && r.recording !== null);
/** Each direct relation's recording and the year the map gives it (null: undated). */
const directDates = (list: MbRelationship[]) =>
  Object.fromEntries(
    direct(list).map((r) => [r.recording?.mbid, r.recording?.firstReleaseDate ?? null]),
  );
const hopDates = (list: MbRelationship[]) =>
  Object.fromEntries(
    list
      .filter((r) => r.about === "hop")
      .map((r) => [r.recording?.mbid, r.recording?.firstReleaseDate ?? null]),
  );
const EXPECTED_DIRECT = Object.fromEntries(DIRECT.map((r) => [r.id, r.date]));

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

function warnings() {
  const logs = captureLogsForTests({ level: "warn" });
  onTestFinished(() => logs.restore());
  return () => logs.messages("warn").filter((line) => /Relations map/.test(line));
}

function unpaced() {
  const restore = MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
  onTestFinished(restore);
}

/** The chain on the fake clock, at the client's real spacing: its result, and when it settled. */
async function onFakeClock(options: { deadlineMs?: number; cache?: RecordingCache } = {}) {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  const t0 = performance.now();
  let settledAt = -1;
  const run = collectPrimarySources(TRACK, {
    now,
    ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
    relationsMap: { cache: options.cache ?? null },
  }).then((sources) => {
    settledAt = performance.now() - t0;
    return sources;
  });
  await vi.runAllTimersAsync();
  return { mb: records(await run), settledAt };
}

describe("the relations map's years on a track with many relations", () => {
  it("dates every direct relation MusicBrainz dates within the budget, on a slow MusicBrainz", async () => {
    const log = warnings();
    const net = stubFetch(slow(route, latencyOf));
    const { mb, settledAt } = await onFakeClock();

    // Within the 20 s budget, by the dating cut.
    expect(settledAt).toBeLessThanOrEqual(15_000);
    expect(direct(mb.records)).toHaveLength(9);
    // Every direct relation MusicBrainz dates has its year; the two it does not stay undated.
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    // One search for the nine, sent first; no time was left for the second hop, and the log
    // says so.
    const mapReads = net.calls.filter(isMapRead);
    expect(mapReads).toHaveLength(1);
    expect(idsOf(mapReads[0]).sort()).toEqual([...DIRECT_IDS].sort());
    expect(log()).toEqual([
      `Relations map incomplete for recording/${GANGSTAS}: not read the second hop from recording/${PASTIME} (no time left)`,
    ]);
    expect(mb.incomplete).toMatch(/map incomplete: /);
  });

  it("reads the direct relations' dates before the second hop, and the hop's after it", async () => {
    unpaced();
    const log = warnings();
    const net = stubFetch(route);
    const { mb } = await onFakeClock();

    const mapReads = net.calls.filter(isMapRead);
    expect(mapReads.map((c) => (isHopRead(c) ? "hop" : "dates"))).toEqual([
      "dates",
      "hop",
      "dates",
    ]);
    // The nine first; then only the second hop's recordings, none asked twice.
    expect(idsOf(mapReads[0]).sort()).toEqual([...DIRECT_IDS].sort());
    expect(idsOf(mapReads[2]).sort()).toEqual([...HOP_IDS].sort());
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(hopDates(mb.records)).toEqual({
      [SIBLING]: "2005-05-05",
      [UNDATED_SIBLING]: null,
      [EARLIER]: "1970",
    });
    expect(log()).toEqual([]);
    expect(mb.incomplete ?? "").not.toMatch(/map incomplete: /);
  });

  it("spends a short budget on the direct relations' dates, not the second hop", async () => {
    // At the client's spacing with answers at once, the chain's six reads are sent by 5.5 s.
    // With an 11 s deadline a map read may start until 7.15 s: one is made, at 6.6 s.
    const log = warnings();
    const net = stubFetch(route);
    const { mb } = await onFakeClock({ deadlineMs: 11_000 });

    const mapReads = net.calls.filter(isMapRead);
    expect(mapReads).toHaveLength(1);
    expect(isDateSearch(mapReads[0])).toBe(true);
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    // The hop read was queued in time but its turn came after the start limit: not sent.
    expect(log()).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Relations map incomplete for recording/${GANGSTAS}: not read the second hop from recording/${PASTIME} \\(.+\\)$`,
        ),
      ),
    ]);
  });

  it("asks for the recordings MusicBrainz does not date, and keeps them undated, on a slow MusicBrainz", async () => {
    const writes: Array<[string, string | null]> = [];
    const cache: RecordingCache = {
      getMbHop: () => null,
      putMbHop: () => {},
      getMbDate: () => null,
      putMbDate: (mbid, date) => {
        writes.push([mbid, date]);
      },
    };
    stubFetch(slow(route, latencyOf));
    const { mb } = await onFakeClock({ cache });
    const undated = DIRECT.filter((r) => r.date === null).map((r) => r.id);
    expect(undated).toHaveLength(2);
    for (const id of undated) {
      const record = mb.records.find((r) => r.recording?.mbid === id);
      expect(record?.recording).not.toHaveProperty("firstReleaseDate");
      expect(mb.evidence.some((e) => e.id === `musicbrainz:recording/${id}`)).toBe(false);
    }
    // Asked, and answered: the dated ones with their dates, the two without as having none.
    expect(Object.fromEntries(writes)).toEqual(EXPECTED_DIRECT);
    // Each date MusicBrainz gave is stated on its recording's page; none for the undated.
    const dateItems = mb.evidence.filter((e) =>
      /^musicbrainz:recording\/[0-9a-f-]{36}$/.test(e.id),
    );
    expect(dateItems.map((e) => e.recordRef).sort()).toEqual(
      DATED.map((r) => `recording/${r.id}`).sort(),
    );
  });

  it("reports a failed date search and still reads the second hop and dates it", async () => {
    unpaced();
    const log = warnings();
    const net = stubFetch((call) =>
      isDateSearch(call) && idsOf(call).includes(DIRECT_IDS[1])
        ? new Response("busy", { status: 503, headers: { "retry-after": "0" } })
        : route(call),
    );
    const { mb } = await onFakeClock();

    const searches = net.calls.filter(isDateSearch);
    // Not asked again: the second search asks only the second hop's recordings.
    expect(searches).toHaveLength(2);
    expect(idsOf(searches[1]).sort()).toEqual([...HOP_IDS].sort());
    // "Pastime Paradise" is dated by its own lookup; the other eight stay undated.
    expect(directDates(mb.records)).toEqual({
      ...Object.fromEntries(DIRECT_IDS.map((id) => [id, null])),
      [PASTIME]: "1976-09-28",
    });
    expect(hopDates(mb.records)).toEqual({
      [SIBLING]: "2005-05-05",
      [UNDATED_SIBLING]: null,
      [EARLIER]: "1970",
    });
    expect(log()).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Relations map incomplete for recording/${GANGSTAS}: not read the dates of 9 recordings \\(.*503.*\\)$`,
        ),
      ),
    ]);
    expect(mb.error).toBeUndefined();
    expect(mb.incomplete).toMatch(/map incomplete: /);
  });

  it("asks no recording twice in a run, after a failed date search", async () => {
    // "Pastime Paradise" answered here without its own date: it ends the second hop's
    // relations too, and the second search does not ask it again.
    unpaced();
    const log = warnings();
    const { "first-release-date": _date, ...undatedPastime } = pastime;
    const net = stubFetch((call) => {
      if (isHopRead(call)) return json(undatedPastime);
      if (isDateSearch(call) && idsOf(call).includes(PASTIME)) {
        return new Response("busy", { status: 503, headers: { "retry-after": "0" } });
      }
      return route(call);
    });
    const { mb } = await onFakeClock();

    const searches = net.calls.filter(isDateSearch);
    expect(searches).toHaveLength(2);
    expect(idsOf(searches[0])).toContain(PASTIME);
    expect(idsOf(searches[1]).sort()).toEqual([...HOP_IDS].sort());
    expect(directDates(mb.records)[PASTIME]).toBeNull();
    expect(log()).toEqual([
      expect.stringMatching(/: not read the dates of 9 recordings \(.*503.*\)$/),
    ]);
  });

  it("reports a date search that never answers, and settles by the dating cut", async () => {
    const log = warnings();
    stubFetch((call) => (isDateSearch(call) ? never(call) : route(call)));
    const { mb, settledAt } = await onFakeClock();

    expect(settledAt).toBeGreaterThan(0);
    expect(settledAt).toBeLessThanOrEqual(15_000);
    expect(directDates(mb.records)).toEqual(Object.fromEntries(DIRECT_IDS.map((id) => [id, null])));
    expect(log()).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Relations map incomplete for recording/${GANGSTAS}: not read the dates of 9 recordings \\(.+\\); the second hop from recording/${PASTIME} \\(no time left\\)$`,
        ),
      ),
    ]);
    expect(mb.error).toBeUndefined();
  });
});
