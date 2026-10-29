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
import { collectPrimarySources, MAP_INCOMPLETE, type RecordingCache } from "./identity.js";
import {
  getMusicBrainzArtist,
  type MbRelationship,
  MusicBrainzRateLimiter,
  withMusicBrainzPriority,
} from "./musicbrainz.js";
import { type FetchCall, type FetchRoute, json, never, stubFetch } from "./testing/fetchStub.js";
import type { TrackRef } from "./records.js";

const MB = "https://musicbrainz.org/ws/2";
const ISRC = "USTB10400128";
const GANGSTAS = "2f7a6735-2e09-4ce2-81e4-b148e6c39a55";
const WORK = "5efe152c-3104-3226-9084-d71efc6356af";
const PASTIME = "e97bedfc-b0ee-4cb6-8343-03a714caab15";
const COOLIO = "cc30e630-8c75-4d78-b205-8e2edc6bdaa7";
const LV = "773c48db-eb0c-491f-9a36-633d72dcee8d";
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
          artist: { id: LV, name: "L.V." },
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
  if (call.url.startsWith(`${MB}/artist/${COOLIO}?`)) {
    return json({ id: COOLIO, name: "Coolio", type: "Person", country: "US", relations: [] });
  }
  if (call.url.startsWith(`${MB}/artist/${LV}?`)) {
    return json({ id: LV, name: "L.V.", type: "Person", country: "US", relations: [] });
  }
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
 * How long MusicBrainz took to answer each kind of request when this track's reads were made
 * from the server on 2026-10-28 (383–670 ms): faster than the client's own spacing, so the
 * spacing (a request at most every 1.1 s, one at a time) sets the pace.
 */
const LIVE_MS: Array<[RegExp, number]> = [
  [/\/ws\/2\/isrc\//, 383],
  [/\/ws\/2\/work\//, 645],
  [/\/ws\/2\/recording\?work=/, 602],
  [/\/ws\/2\/release\?/, 635],
  [/\/ws\/2\/recording\?query=/, 670],
  [/\/ws\/2\/recording\/[0-9a-f-]{36}\?/, 452],
  [/\/ws\/2\/artist\//, 450],
];
const liveMs = (call: FetchCall) => LIVE_MS.find(([re]) => re.test(call.url))?.[1] ?? 500;

/** Live latencies, but `ms` for the `nth` request (from 1) that `matches`: a stalled answer. */
function stalledAt(matches: (call: FetchCall) => boolean, ms: number, nth = 1) {
  let seen = 0;
  return (call: FetchCall) => (matches(call) && ++seen === nth ? ms : liveMs(call));
}

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

/**
 * The research running alongside, as in a real run: it asks MusicBrainz for the credited
 * artist (a request in the queue's last lane) at `at` ms after the chain starts.
 */
function researcher(at: readonly number[]) {
  for (const ms of at) {
    setTimeout(() => {
      void getMusicBrainzArtist
        .invoke({ artistName: "Coolio", artistMbid: COOLIO })
        .catch(() => undefined);
    }, ms);
  }
}
const RESEARCH_AT = [300, 2_000, 5_000, 8_000];

/** Another run's chain, at the same time: one of its own reads (the chain's lane) at `at` ms. */
function otherRun(at: readonly number[]) {
  for (const ms of at) {
    setTimeout(() => {
      void withMusicBrainzPriority(() =>
        getMusicBrainzArtist.invoke({ artistName: "L.V.", artistMbid: LV }),
      ).catch(() => undefined);
    }, ms);
  }
}

/**
 * The chain on the fake clock, at the client's real spacing (the real MusicBrainz queue, with its
 * lanes, its 1.1 s spacing and the 10 s request timeout): its result, and when it settled.
 */
async function onFakeClock(
  options: {
    deadlineMs?: number;
    cache?: RecordingCache;
    research?: readonly number[];
    otherRun?: readonly number[];
  } = {},
) {
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
  researcher(options.research ?? []);
  otherRun(options.otherRun ?? []);
  await vi.runAllTimersAsync();
  return { mb: records(await run), settledAt };
}

/** A cache that holds nothing and records what is written to it. */
function writesCache() {
  const writes: Array<[string, string | null]> = [];
  const cache: RecordingCache = {
    getMbHop: () => null,
    putMbHop: () => {},
    getMbDate: () => null,
    putMbDate: (mbid, date) => {
      writes.push([mbid, date]);
    },
  };
  return { cache, writes };
}

const shed = () => new Response("busy", { status: 503, headers: { "retry-after": "0" } });
const isWorkBrowse = (call: FetchCall) => call.url.startsWith(`${MB}/recording?work=`);
const NONE_DATED = Object.fromEntries(DIRECT_IDS.map((id) => [id, null]));
const HOP_DATED = { [SIBLING]: "2005-05-05", [UNDATED_SIBLING]: null, [EARLIER]: "1970" };
const NONE_OF_HOP_DATED = { [SIBLING]: null, [UNDATED_SIBLING]: null, [EARLIER]: null };

/**
 * The recordings the map's one search asks for: the nine but "Pastime Paradise" (dated by its
 * own lookup, the second hop's), then the second hop's three.
 */
const ASKED_IDS = [...DIRECT_IDS, ...HOP_IDS].filter((id) => id !== PASTIME);
const ASKED_DATED: Record<string, string | null> = Object.fromEntries(
  Object.entries({ ...EXPECTED_DIRECT, ...HOP_DATED }).filter(([id]) => id !== PASTIME),
);
const PASTIME_ONLY = { ...NONE_DATED, [PASTIME]: "1976-09-28" };
/** The chain's own MusicBrainz requests and the map's, in the order they were sent. */
const mbOrder = (calls: readonly FetchCall[]) =>
  calls
    .filter((c) => c.url.startsWith(MB))
    .map((c) =>
      c.url.includes(`/artist/${LV}`)
        ? "other run"
        : c.url.includes("/artist/")
          ? "research"
          : isHopRead(c)
            ? "hop"
            : isDateSearch(c)
              ? "dates"
              : (new URL(c.url).pathname.split("/")[3] ?? ""),
    );

describe("the relations map's years in the runs that left them undated", () => {
  it("dates every recording when the second hop's lookup stalls (run 3a385be1)", async () => {
    // Live answers, the research alongside, and the lookup of "Pastime Paradise" answered
    // after 7.95 s, as in the run that dated 1 of the 9.
    const log = warnings();
    const { cache, writes } = writesCache();
    const net = stubFetch(slow(route, stalledAt(isHopRead, 7_950)));
    const { mb, settledAt } = await onFakeClock({ cache, research: RESEARCH_AT });

    expect(settledAt).toBeLessThanOrEqual(15_000);
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(hopDates(mb.records)).toEqual(HOP_DATED);
    // The recordings MusicBrainz lists without a date stay undated, with no date item, and are
    // kept as having none.
    expect(Object.fromEntries(writes)).toEqual(ASKED_DATED);
    const dateItems = mb.evidence.filter((e) =>
      /^musicbrainz:recording\/[0-9a-f-]{36}$/.test(e.id),
    );
    expect(dateItems.map((e) => e.recordRef).sort()).toEqual(
      [...DATED.map((r) => r.id), SIBLING, EARLIER].map((id) => `recording/${id}`).sort(),
    );
    // The map's reads came right after the recording's lookup, before the work's.
    expect(mbOrder(net.calls).slice(0, 5)).toEqual(["isrc", "recording", "hop", "dates", "work"]);
    expect(log()).toEqual([]);
  });

  it("dates every recording when the work's recordings are slow to browse (run 9a9fd810)", async () => {
    // The first page of the work's recordings answered after 9.64 s, as in the run that dated
    // none of the 9.
    const log = warnings();
    stubFetch(slow(route, stalledAt(isWorkBrowse, 9_640)));
    const { mb, settledAt } = await onFakeClock({ research: RESEARCH_AT });

    expect(settledAt).toBeLessThanOrEqual(15_000);
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(hopDates(mb.records)).toEqual(HOP_DATED);
    expect(log()).toEqual([]);
  });

  it("asks a shed date search again once, while there is time", async () => {
    let shedOnce = false;
    const net = stubFetch(
      slow((call) => {
        if (isDateSearch(call) && !shedOnce) {
          shedOnce = true;
          return shed();
        }
        return route(call);
      }, liveMs),
    );
    const log = warnings();
    const { mb } = await onFakeClock({ research: RESEARCH_AT });

    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(hopDates(mb.records)).toEqual(HOP_DATED);
    expect(net.calls.filter(isDateSearch).map((c) => idsOf(c).length)).toEqual([11, 11]);
    expect(log()).toEqual([]);
  });

  it("does not ask a shed search again when it could not start in time", async () => {
    // With a 7 s deadline the map's reads may start until 4.55 s. The search, sent at 3.3 s, is
    // shed at 3.97 s with a Retry-After of 2 s: asked again it would start too late.
    const log = warnings();
    const net = stubFetch(
      slow(
        (call) =>
          isDateSearch(call)
            ? new Response("busy", { status: 503, headers: { "retry-after": "2" } })
            : route(call),
        liveMs,
      ),
    );
    const { mb } = await onFakeClock({ deadlineMs: 7_000 });

    expect(net.calls.filter(isDateSearch)).toHaveLength(1);
    // "Pastime Paradise" is dated by its own lookup.
    expect(directDates(mb.records)).toEqual(PASTIME_ONLY);
    expect(log()).toEqual([
      expect.stringMatching(/: not read the dates of 11 recordings \(.*503.*\)$/),
    ]);
  });

  it("takes turns with another run's chain: the map's reads are not left behind it", async () => {
    // The chain waits for the map's reads, so they wait in the chain's lane, in turn with
    // another run's: here one of its reads, queued at 1.6 s, just after the second hop's lookup.
    const net = stubFetch(slow(route, liveMs));
    const { mb } = await onFakeClock({ otherRun: [1_600] });

    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(mbOrder(net.calls).slice(0, 6)).toEqual([
      "isrc",
      "recording",
      "hop",
      "other run",
      "dates",
      "work",
    ]);
  });

  it("keeps the chain's reads ahead of the research after a slow answer", async () => {
    // Each of the chain's answers takes 1.5 s, longer than the spacing; the research asks every
    // second. The chain's next read still goes first each time.
    const net = stubFetch(slow(route, (call) => (call.url.includes("/artist/") ? 450 : 1_500)));
    const { mb } = await onFakeClock({ research: [300, 1_300, 2_300, 3_300, 4_300, 5_300] });

    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(mbOrder(net.calls).slice(0, 9)).toEqual([
      "isrc",
      "recording",
      "hop",
      "dates",
      "work",
      "recording",
      "recording",
      "release",
      "research",
    ]);
  });
});

describe("the relations map's years on a track with many relations", () => {
  it("reads the second hop, then dates every recording in one search, before the work", async () => {
    unpaced();
    const log = warnings();
    const net = stubFetch(route);
    const { mb } = await onFakeClock();

    expect(mbOrder(net.calls).slice(0, 5)).toEqual(["isrc", "recording", "hop", "dates", "work"]);
    const searches = net.calls.filter(isDateSearch);
    expect(searches).toHaveLength(1);
    expect(idsOf(searches[0]).sort()).toEqual([...ASKED_IDS].sort());
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(hopDates(mb.records)).toEqual(HOP_DATED);
    expect(log()).toEqual([]);
    expect(mb.incomplete ?? "").not.toContain(MAP_INCOMPLETE);
  });

  it("reads the map in a short budget, since it comes before the chain's later reads", async () => {
    // At the client's spacing with answers at once, the hop's lookup is sent at 2.2 s and the
    // search at 3.3 s. With an 11 s deadline a map read may start until 7.15 s: both are made.
    const log = warnings();
    const net = stubFetch(route);
    const { mb } = await onFakeClock({ deadlineMs: 11_000 });

    expect(net.calls.filter(isMapRead).map(isDateSearch)).toEqual([false, true]);
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(hopDates(mb.records)).toEqual(HOP_DATED);
    expect(log()).toEqual([]);
  });

  it("reports a date search shed twice: nothing cached, the map incomplete", async () => {
    unpaced();
    const log = warnings();
    const { cache, writes } = writesCache();
    const net = stubFetch((call) => (isDateSearch(call) ? shed() : route(call)));
    const { mb } = await onFakeClock({ cache });

    // Asked again once, then not again once the chain has resolved.
    expect(net.calls.filter(isDateSearch).map((c) => idsOf(c).length)).toEqual([11, 11]);
    expect(directDates(mb.records)).toEqual(PASTIME_ONLY);
    expect(hopDates(mb.records)).toEqual(NONE_OF_HOP_DATED);
    expect(writes).toEqual([]);
    expect(log()).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Relations map incomplete for recording/${GANGSTAS}: not read the dates of 11 recordings \\(.*503.*\\)$`,
        ),
      ),
    ]);
    expect(mb.error).toBeUndefined();
    expect(mb.incomplete).toContain(MAP_INCOMPLETE);
  });

  it("looks a second hop up once in a run, after it failed", async () => {
    unpaced();
    const log = warnings();
    const net = stubFetch((call) => (isHopRead(call) ? shed() : route(call)));
    const { mb } = await onFakeClock();

    // Asked again once, then not again once the chain has resolved.
    expect(net.calls.filter(isHopRead)).toHaveLength(2);
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(hopDates(mb.records)).toEqual({});
    expect(log()).toEqual([
      expect.stringMatching(
        new RegExp(`: not read the second hop from recording/${PASTIME} \\(.*503.*\\)$`),
      ),
    ]);
  });

  it("dates a second hop's source by its own lookup when the search for it failed", async () => {
    // "Pastime Paradise" lists only this recording as sampling it: its lookup adds no relation,
    // and it is dated by that lookup alone.
    unpaced();
    const onlyThis = { ...pastime, relations: pastime.relations.slice(0, 1) };
    stubFetch((call) => {
      if (isHopRead(call)) return json(onlyThis);
      if (isDateSearch(call)) return shed();
      return route(call);
    });
    const { mb } = await onFakeClock();

    expect(directDates(mb.records)).toEqual(PASTIME_ONLY);
  });

  it("reports a search with no time left: nothing cached, the map incomplete", async () => {
    // An 8 s deadline: a map read may start until 5.2 s. The hop's lookup, sent at 2.2 s,
    // answers at 5.7 s: its relations are drawn, but the search has no time left.
    const log = warnings();
    const { cache, writes } = writesCache();
    const net = stubFetch(slow(route, stalledAt(isHopRead, 3_500)));
    const { mb } = await onFakeClock({ cache, deadlineMs: 8_000 });

    expect(net.calls.filter(isDateSearch)).toEqual([]);
    expect(directDates(mb.records)).toEqual(PASTIME_ONLY);
    expect(hopDates(mb.records)).toEqual(NONE_OF_HOP_DATED);
    expect(writes).toEqual([]);
    expect(log()).toEqual([
      expect.stringMatching(/: not read the dates of 11 recordings \(no time left\)$/),
    ]);
    expect(mb.incomplete).toContain(MAP_INCOMPLETE);
  });

  it("reports a second hop with no time left: nothing read, the map incomplete", async () => {
    // An 8 s deadline: a map read may start until 5.2 s. The recording's lookup, sent at 1.1 s,
    // answers at 5.6 s: too late for the map's reads.
    const log = warnings();
    const { cache, writes } = writesCache();
    const net = stubFetch(
      slow(
        route,
        stalledAt((call) => call.url.startsWith(`${MB}/recording/${GANGSTAS}?`), 4_500),
      ),
    );
    const { mb } = await onFakeClock({ cache, deadlineMs: 8_000 });

    expect(net.calls.filter(isMapRead)).toEqual([]);
    expect(directDates(mb.records)).toEqual(NONE_DATED);
    expect(writes).toEqual([]);
    expect(log()).toEqual([
      expect.stringMatching(
        new RegExp(
          `: not read the second hop from recording/${PASTIME} \\(no time left\\); the dates of 9 recordings \\(no time left\\)$`,
        ),
      ),
    ]);
    expect(mb.incomplete).toContain(MAP_INCOMPLETE);
  });

  it("reports a date search that never answers, cut by the request timeout", async () => {
    const log = warnings();
    stubFetch((call) => (isDateSearch(call) ? never(call) : route(call)));
    const { mb, settledAt } = await onFakeClock();

    expect(settledAt).toBeLessThanOrEqual(15_000);
    expect(directDates(mb.records)).toEqual(PASTIME_ONLY);
    expect(log()).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Relations map incomplete for recording/${GANGSTAS}: not read the dates of 11 recordings \\(.*10000 ms.*\\)$`,
        ),
      ),
    ]);
    expect(mb.error).toBeUndefined();
  });
});
