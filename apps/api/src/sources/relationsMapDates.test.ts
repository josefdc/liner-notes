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
import {
  collectPrimarySources,
  DATES_INCOMPLETE,
  MAP_INCOMPLETE,
  type RecordingCache,
  RELEASES_INCOMPLETE,
} from "./identity.js";
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
const hops = (list: MbRelationship[]) => list.filter((r) => r.about === "hop");
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
  const sources = await run;
  return { mb: records(sources), identity: sources.identity, settledAt };
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

const PASTIME_ONLY = { ...NONE_DATED, [PASTIME]: "1976-09-28" };
const isDetails = (call: FetchCall) => call.url.startsWith(`${MB}/recording/${GANGSTAS}?`);
const isRelease = (call: FetchCall) => call.url.startsWith(`${MB}/release?`);
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
/** The chain's reads, then the map's after them: the order of a run with nothing in the way. */
const IN_ORDER = [
  "isrc",
  "recording",
  "dates",
  "work",
  "recording",
  "recording",
  "release",
  "hop",
  "dates",
];
/** The ids each date search asked for, in the order they were sent. */
const searchIds = (calls: readonly FetchCall[]) => calls.filter(isDateSearch).map(idsOf);
/** `inner`, recording when (fake clock, ms) each date search was sent. */
function searchTimes(inner: FetchRoute) {
  const at: number[] = [];
  const t0 = performance.now();
  const route: FetchRoute = (call) => {
    if (isDateSearch(call)) at.push(performance.now() - t0);
    return inner(call);
  };
  return { route, at };
}

describe("the relations map's years in the runs that left them undated", () => {
  it("dates every relation and keeps the track's own facts when the second hop's lookup stalls (run 3a385be1)", async () => {
    // Live answers, the research alongside, and the lookup of "Pastime Paradise" answered
    // after 7.95 s, as in the run that dated 1 of the 9.
    const log = warnings();
    const { cache, writes } = writesCache();
    const net = stubFetch(slow(route, stalledAt(isHopRead, 7_950)));
    const { mb, identity, settledAt } = await onFakeClock({ cache, research: RESEARCH_AT });

    expect(settledAt).toBeLessThanOrEqual(15_000);
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    // The recordings MusicBrainz lists without a date stay undated, with no date item, and are
    // kept as having none.
    expect(Object.fromEntries(writes)).toEqual(EXPECTED_DIRECT);
    const dateItems = mb.evidence.filter((e) =>
      /^musicbrainz:recording\/[0-9a-f-]{36}$/.test(e.id),
    );
    expect(dateItems.map((e) => e.recordRef).sort()).toEqual(
      DATED.map((r) => `recording/${r.id}`).sort(),
    );
    // The search came right after the recording's lookup; the second hop after the chain.
    expect(mbOrder(net.calls).slice(0, 8)).toEqual(IN_ORDER.slice(0, 8));
    // The track's own facts are all read: its release, and its work's dates (the original).
    expect(mb.incomplete).not.toContain(RELEASES_INCOMPLETE);
    expect(mb.incomplete).not.toContain(DATES_INCOMPLETE);
    expect(identity?.coverRelease).toBeTruthy();
    expect(identity?.original.original).toBe(true);
    // The second hop is what the stall costs, and a later run reads it.
    expect(hops(mb.records)).toEqual([]);
    expect(mb.incomplete).toContain(MAP_INCOMPLETE);
    expect(log()).toEqual([
      expect.stringMatching(new RegExp(`: not read the second hop from recording/${PASTIME} \\(`)),
    ]);
  });

  it("dates every relation and the work when the work's recordings are slow to browse (run 9a9fd810)", async () => {
    // The first page of the work's recordings answered after 9.64 s, as in the run that dated
    // none of the 9.
    stubFetch(slow(route, stalledAt(isWorkBrowse, 9_640)));
    const { mb, identity, settledAt } = await onFakeClock({ research: RESEARCH_AT });

    expect(settledAt).toBeLessThanOrEqual(15_000);
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    // The work is dated: the recording is shown to be the original.
    expect(mb.incomplete).not.toContain(DATES_INCOMPLETE);
    expect(identity?.original.original).toBe(true);
    // The release, the chain's last read, comes after the dating cut, as it does without the
    // map; the second hop has no time left.
    expect(mb.incomplete).toContain(RELEASES_INCOMPLETE);
    expect(mb.incomplete).toContain(MAP_INCOMPLETE);
  });

  it("asks a shed search once more after the chain, not while the chain waits", async () => {
    // The first search is shed with a Retry-After of 120 s (waited at most 2 s): the chain reads
    // on at once, and the search is asked again after the chain's reads, in the map's lane.
    let shedOnce = false;
    const net = stubFetch(
      slow((call) => {
        if (isDateSearch(call) && !shedOnce) {
          shedOnce = true;
          return new Response("busy", { status: 503, headers: { "retry-after": "120" } });
        }
        return route(call);
      }, liveMs),
    );
    const log = warnings();
    const { mb } = await onFakeClock({ research: RESEARCH_AT });

    expect(mbOrder(net.calls).slice(0, 10)).toEqual([
      ...IN_ORDER.slice(0, 7),
      "dates",
      "hop",
      "dates",
    ]);
    expect(searchIds(net.calls).map((ids) => ids.length)).toEqual([9, 9, 3]);
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(hopDates(mb.records)).toEqual(HOP_DATED);
    expect(log()).toEqual([]);
  });

  it("waits out a shed search's Retry-After before asking it again", async () => {
    // A recording of no work: the chain's reads end before the 2 s Retry-After does.
    const noWork = { ...details, relations: details.relations.filter((r) => !("work" in r)) };
    let shedOnce = false;
    const { route: timed, at } = searchTimes((call) => {
      if (isDetails(call)) return json(noWork);
      if (isDateSearch(call) && !shedOnce) {
        shedOnce = true;
        return new Response("busy", { status: 503, headers: { "retry-after": "2" } });
      }
      return route(call);
    });
    const net = stubFetch(slow(timed, liveMs));
    const { mb } = await onFakeClock();

    expect(mbOrder(net.calls).slice(0, 5)).toEqual([
      "isrc",
      "recording",
      "dates",
      "release",
      "dates",
    ]);
    // Shed at 2.2 s + 670 ms; asked again 2 s later, not at the next free slot (4.4 s).
    expect(at[1] - at[0]).toBeCloseTo(670 + 2_000, 0);
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
  });

  it("does not ask a shed search again when its Retry-After ends past the map's start limit", async () => {
    // With a 7 s deadline the map's reads may start until 4.55 s. The search, sent at 2.2 s, is
    // shed at 2.87 s with a Retry-After of 2 s: asked again it would start too late.
    const log = warnings();
    const { cache, writes } = writesCache();
    const net = stubFetch(
      slow(
        (call) =>
          isDateSearch(call)
            ? new Response("busy", { status: 503, headers: { "retry-after": "2" } })
            : route(call),
        liveMs,
      ),
    );
    const { mb } = await onFakeClock({ cache, deadlineMs: 7_000 });

    expect(net.calls.filter(isDateSearch)).toHaveLength(1);
    expect(directDates(mb.records)).toEqual(NONE_DATED);
    expect(writes).toEqual([]);
    expect(log()).toEqual([
      expect.stringMatching(
        new RegExp(
          `: not read the dates of 9 recordings \\(.*503.*\\); the second hop from recording/${PASTIME} \\(no time left\\)$`,
        ),
      ),
    ]);
    expect(mb.incomplete).toContain(MAP_INCOMPLETE);
  });

  it("takes turns with another run's chain: the map's search is not left behind it", async () => {
    // The chain waits for the search, so it waits in the chain's lane, in turn with another
    // run's reads: here one of them, queued at 1.6 s, just after the search.
    const net = stubFetch(slow(route, liveMs));
    const { mb } = await onFakeClock({ otherRun: [1_600] });

    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(mbOrder(net.calls).slice(0, 5)).toEqual([
      "isrc",
      "recording",
      "dates",
      "other run",
      "work",
    ]);
  });

  it("reads the second hop after the chain's reads of every run", async () => {
    // Two runs of the track, the second 0.5 s after the first, with a 30 s deadline: the first
    // run's second hop waits in the map's lane until the second run's chain has read its release.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
    const net = stubFetch(slow(route, liveMs));
    const run = () =>
      collectPrimarySources(TRACK, { now, deadlineMs: 30_000, relationsMap: { cache: null } });
    const runs = [run(), new Promise((resolve) => setTimeout(resolve, 500)).then(run)];
    await vi.runAllTimersAsync();
    const [first, second] = (await Promise.all(runs)).map(records);

    expect(mbOrder(net.calls).filter((r) => r === "release" || r === "hop")).toEqual([
      "release",
      "release",
      "hop",
      "hop",
    ]);
    for (const mb of [first, second]) {
      expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
      expect(hopDates(mb.records)).toEqual(HOP_DATED);
    }
  });

  it("keeps the chain's reads and the map's ahead of the research after a slow answer", async () => {
    // Each of the chain's answers takes 1.5 s, longer than the spacing; the research asks every
    // second. The chain's next read, then the map's, still go first each time.
    const net = stubFetch(slow(route, (call) => (call.url.includes("/artist/") ? 450 : 1_500)));
    const { mb } = await onFakeClock({ research: [300, 1_300, 2_300, 3_300, 4_300, 5_300] });

    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(mbOrder(net.calls).slice(0, 10)).toEqual([...IN_ORDER, "research"]);
  });
});

describe("the relations map's years on a track with many relations", () => {
  it("dates the recording's own relations ahead of the chain, and the second hop after it", async () => {
    unpaced();
    const log = warnings();
    const net = stubFetch(route);
    const { mb } = await onFakeClock();

    expect(mbOrder(net.calls)).toEqual(IN_ORDER);
    expect(searchIds(net.calls).map((ids) => ids.sort())).toEqual([
      [...DIRECT_IDS].sort(),
      [...HOP_IDS].sort(),
    ]);
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(hopDates(mb.records)).toEqual(HOP_DATED);
    expect(log()).toEqual([]);
    expect(mb.incomplete ?? "").not.toContain(MAP_INCOMPLETE);
  });

  it("keeps the track's own facts in a short budget, and leaves the second hop", async () => {
    // At the client's spacing with answers at once, the chain's last read (the release) is sent
    // at 6.6 s. With an 11 s deadline a map read may start until 7.15 s: the second hop's
    // lookup, whose turn comes at 7.7 s, is not sent.
    const log = warnings();
    const net = stubFetch(route);
    const { mb } = await onFakeClock({ deadlineMs: 11_000 });

    expect(mbOrder(net.calls)).toEqual(IN_ORDER.slice(0, 7));
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(mb.incomplete ?? "").not.toContain(RELEASES_INCOMPLETE);
    expect(mb.incomplete ?? "").not.toContain(DATES_INCOMPLETE);
    expect(log()).toEqual([
      expect.stringMatching(new RegExp(`: not read the second hop from recording/${PASTIME} \\(`)),
    ]);
    expect(mb.incomplete).toContain(MAP_INCOMPLETE);
  });

  it("reports searches shed again: nothing cached, the map incomplete", async () => {
    unpaced();
    const log = warnings();
    const { cache, writes } = writesCache();
    const net = stubFetch((call) => (isDateSearch(call) ? shed() : route(call)));
    const { mb } = await onFakeClock({ cache });

    // The relations' search, shed while the chain waits, is asked once more after it; the
    // second hop's search is asked again once.
    expect(searchIds(net.calls).map((ids) => ids.length)).toEqual([9, 9, 3, 3]);
    // "Pastime Paradise" is dated by its own lookup, the second hop's.
    expect(directDates(mb.records)).toEqual(PASTIME_ONLY);
    expect(hopDates(mb.records)).toEqual(NONE_OF_HOP_DATED);
    expect(writes).toEqual([]);
    expect(log()).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Relations map incomplete for recording/${GANGSTAS}: not read the dates of 9 recordings \\(.*503.*\\); the dates of 3 recordings \\(.*503.*\\)$`,
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

    // Asked again once, then not again.
    expect(net.calls.filter(isHopRead)).toHaveLength(2);
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(hopDates(mb.records)).toEqual({});
    expect(log()).toEqual([
      expect.stringMatching(
        new RegExp(`: not read the second hop from recording/${PASTIME} \\(.*503.*\\)$`),
      ),
    ]);
  });

  it("does not look a shed second hop up again when it could not start in time", async () => {
    // With a 13 s deadline a map read may start until 8.45 s. The second hop's lookup, sent at
    // 7.7 s after the chain's reads, is shed at 8.15 s with a Retry-After of 2 s: asked again
    // it would start too late.
    const log = warnings();
    const net = stubFetch(
      slow(
        (call) =>
          isHopRead(call)
            ? new Response("busy", { status: 503, headers: { "retry-after": "2" } })
            : route(call),
        liveMs,
      ),
    );
    const { mb } = await onFakeClock({ deadlineMs: 13_000 });

    expect(net.calls.filter(isHopRead)).toHaveLength(1);
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
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

  it("reports the second hop's search with no time left: nothing cached, the map incomplete", async () => {
    // A map read may start until 13.5 s. The hop's lookup, sent at 7.7 s, answers at 13.7 s:
    // its relations are drawn, but its recordings' search has no time left.
    const log = warnings();
    const { cache, writes } = writesCache();
    const net = stubFetch(slow(route, stalledAt(isHopRead, 6_000)));
    const { mb } = await onFakeClock({ cache });

    expect(searchIds(net.calls)).toHaveLength(1);
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(hopDates(mb.records)).toEqual(NONE_OF_HOP_DATED);
    expect(Object.fromEntries(writes)).toEqual(EXPECTED_DIRECT);
    expect(log()).toEqual([
      expect.stringMatching(/: not read the dates of 3 recordings \(no time left\)$/),
    ]);
    expect(mb.incomplete).toContain(MAP_INCOMPLETE);
  });

  it("reports the relations' search and the second hop with no time left", async () => {
    // An 8 s deadline: a map read may start until 5.2 s. The recording's lookup, sent at 1.1 s,
    // answers at 5.6 s: too late for the map's reads.
    const log = warnings();
    const { cache, writes } = writesCache();
    const net = stubFetch(slow(route, stalledAt(isDetails, 4_500)));
    const { mb } = await onFakeClock({ cache, deadlineMs: 8_000 });

    expect(net.calls.filter(isMapRead)).toEqual([]);
    expect(directDates(mb.records)).toEqual(NONE_DATED);
    expect(writes).toEqual([]);
    expect(log()).toEqual([
      expect.stringMatching(
        new RegExp(
          `: not read the dates of 9 recordings \\(no time left\\); the second hop from recording/${PASTIME} \\(no time left\\)$`,
        ),
      ),
    ]);
    expect(mb.incomplete).toContain(MAP_INCOMPLETE);
  });

  it("drops a search slower than the chain waits for, and asks it again after the chain", async () => {
    // The search for the relations' dates, sent at 2.2 s, would answer after 9.99 s: the chain
    // waits for it 2 s, then reads on, and the search is asked again after the chain's reads.
    const log = warnings();
    const net = stubFetch(slow(route, stalledAt(isDateSearch, 9_990)));
    const { mb, identity, settledAt } = await onFakeClock({ research: RESEARCH_AT });

    expect(settledAt).toBeLessThanOrEqual(15_000);
    expect(mbOrder(net.calls).slice(0, 10)).toEqual([
      ...IN_ORDER.slice(0, 7),
      "dates",
      "hop",
      "dates",
    ]);
    expect(searchIds(net.calls).map((ids) => ids.length)).toEqual([9, 9, 3]);
    expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
    expect(hopDates(mb.records)).toEqual(HOP_DATED);
    // The track's own facts are all read.
    expect(mb.incomplete ?? "").not.toContain(RELEASES_INCOMPLETE);
    expect(mb.incomplete ?? "").not.toContain(DATES_INCOMPLETE);
    expect(identity?.original.original).toBe(true);
    expect(log()).toEqual([]);
  });

  it.each([
    // The second hop's search answers in time: the map is complete.
    [2_500, HOP_DATED, []],
    // The relations' re-ask answers at 12.6 s; the second hop's search would start after the
    // map's start limit (13.5 s), so it is not sent: its recordings are drawn undated.
    [4_000, NONE_OF_HOP_DATED, ["the dates of 3 recordings"]],
  ])(
    "re-asks after the chain when every search answers in %i ms, slower than the chain waits",
    async (ms, hopDated, notRead) => {
      // Every date search answers after `ms`, the rest at live latencies. The chain waits 2 s
      // for the first, then reads on; the search is asked again after the chain's reads, and
      // that answer dates the relations.
      const sent: Array<[string, number]> = [];
      let t0: number | null = null;
      const answer = slow(route, (call) => (isDateSearch(call) ? ms : liveMs(call)));
      const net = stubFetch((call) => {
        t0 ??= performance.now();
        sent.push([mbOrder([call])[0] ?? "", performance.now() - t0]);
        return answer(call);
      });
      const log = warnings();
      const { mb, identity, settledAt } = await onFakeClock();

      expect(settledAt).toBeLessThanOrEqual(15_000);
      // The track's own facts are all read.
      expect(mb.incomplete ?? "").not.toContain(RELEASES_INCOMPLETE);
      expect(mb.incomplete ?? "").not.toContain(DATES_INCOMPLETE);
      expect(identity?.coverRelease).toBeTruthy();
      expect(identity?.original.original).toBe(true);
      // The chain read on 2 s after the search was sent (2.2 s), not when it was answered.
      const at = (label: string, nth = 1) => sent.filter(([l]) => l === label)[nth - 1]?.[1];
      expect(at("dates")).toBeCloseTo(2_200, 0);
      expect(at("work")).toBeCloseTo(4_200, 0);
      // The relations' search asked once more after the chain's last read; no id asked a third
      // time.
      const searches = searchIds(net.calls);
      expect(searches.slice(0, 2).map((ids) => ids.sort())).toEqual([
        [...DIRECT_IDS].sort(),
        [...DIRECT_IDS].sort(),
      ]);
      expect(at("dates", 2)).toBeGreaterThan(at("release") ?? Number.POSITIVE_INFINITY);
      const asks = new Map<string, number>();
      for (const id of searches.flat()) asks.set(id, (asks.get(id) ?? 0) + 1);
      expect(Math.max(...asks.values())).toBeLessThanOrEqual(2);
      expect(directDates(mb.records)).toEqual(EXPECTED_DIRECT);
      expect(hopDates(mb.records)).toEqual(hopDated);
      expect(log()).toEqual(
        notRead.map((what) => expect.stringMatching(new RegExp(`: not read ${what} \\(`))),
      );
      if (notRead.length > 0) expect(mb.incomplete).toContain(MAP_INCOMPLETE);
    },
  );

  it("reports a date search that never answers, and still reads the track's own facts", async () => {
    // The chain waits 2 s for the search, then reads on; asked again after the chain, the search
    // is cut with the work's dating at 15 s, and the second hop has no time left.
    const log = warnings();
    stubFetch((call) => (isDateSearch(call) ? never(call) : route(call)));
    const { mb, settledAt } = await onFakeClock();

    expect(settledAt).toBeLessThanOrEqual(15_000);
    expect(directDates(mb.records)).toEqual(NONE_DATED);
    expect(mb.incomplete ?? "").not.toContain(RELEASES_INCOMPLETE);
    expect(mb.incomplete ?? "").not.toContain(DATES_INCOMPLETE);
    expect(log()).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Relations map incomplete for recording/${GANGSTAS}: not read the dates of 9 recordings \\(.*\\); the second hop from recording/${PASTIME} \\(no time left\\)$`,
        ),
      ),
    ]);
    expect(mb.error).toBeUndefined();
    expect(mb.incomplete).toContain(MAP_INCOMPLETE);
  });
});

/** Two covers of the song in the work: one its recordings date, one they leave out. */
const COVER_DATED = "88888888-8888-4888-8888-888888888888";
const COVER_UNDATED = "99999999-9999-4999-8999-999999999999";
const coverOf = (id: string, title: string) => ({
  type: "performance",
  direction: "backward",
  "target-type": "recording",
  attributes: ["cover"],
  recording: { id, title, "artist-credit": credit("Cover Artist", COOLIO) },
});
const workWithCovers = {
  ...work,
  relations: [
    ...work.relations,
    coverOf(COVER_DATED, "Gangsta’s Paradise (dated cover)"),
    coverOf(COVER_UNDATED, "Gangsta’s Paradise (undated cover)"),
  ],
};
const recordingsWithCover = [
  ...workRecordings,
  {
    id: COVER_DATED,
    title: "Gangsta’s Paradise (dated cover)",
    "first-release-date": "2010-01-01",
  },
];
const coverDates: Record<string, string> = { [COVER_UNDATED]: "2015-05-05" };
/** `route`, with the work's two covers; `search` answers the search that asks for a cover. */
const withCovers =
  (search: FetchRoute = () => undefined): FetchRoute =>
  async (call) => {
    if (call.url.startsWith(`${MB}/work/${WORK}?`)) return json(workWithCovers);
    if (isWorkBrowse(call)) {
      const offset = Number(new URL(call.url).searchParams.get("offset"));
      return json({
        "recording-count": recordingsWithCover.length,
        "recording-offset": offset,
        recordings: recordingsWithCover.slice(offset, offset + 100),
      });
    }
    if (isDateSearch(call) && idsOf(call).includes(COVER_UNDATED)) {
      const answer = await search(call);
      if (answer) return answer;
      return json({
        count: 1,
        offset: 0,
        recordings: [{ id: COVER_UNDATED, "first-release-date": coverDates[COVER_UNDATED] }],
      });
    }
    return route(call);
  };

describe("a cover of the song known only from the work", () => {
  it("is dated by the work's recordings, or by a search after the chain", async () => {
    unpaced();
    const log = warnings();
    const net = stubFetch(withCovers());
    const { mb, identity } = await onFakeClock();

    expect(identity?.original.original).toBe(true);
    // The relations' search, then one for the cover the work's recordings leave undated (the
    // other is dated by them), then the second hop's.
    expect(searchIds(net.calls).map((ids) => ids.sort())).toEqual([
      [...DIRECT_IDS].sort(),
      [COVER_UNDATED],
      [...HOP_IDS].sort(),
    ]);
    expect(directDates(mb.records)).toEqual({
      ...EXPECTED_DIRECT,
      [COVER_DATED]: "2010-01-01",
      [COVER_UNDATED]: "2015-05-05",
    });
    expect(log()).toEqual([]);
  });

  it("is reported when its search is shed: nothing cached, the map incomplete", async () => {
    unpaced();
    const log = warnings();
    const { cache, writes } = writesCache();
    const net = stubFetch(withCovers(() => shed()));
    const { mb } = await onFakeClock({ cache });

    // Asked again once.
    expect(searchIds(net.calls).filter((ids) => ids.includes(COVER_UNDATED))).toHaveLength(2);
    expect(directDates(mb.records)).toEqual({
      ...EXPECTED_DIRECT,
      [COVER_DATED]: "2010-01-01",
      [COVER_UNDATED]: null,
    });
    expect(writes.filter(([id]) => id === COVER_UNDATED)).toEqual([]);
    expect(log()).toEqual([
      expect.stringMatching(/: not read the dates of 1 recordings \(.*503.*\)$/),
    ]);
    expect(mb.incomplete).toContain(MAP_INCOMPLETE);
  });

  it("is reported when its search has no time left", async () => {
    // A map read may start until 13.5 s. The release, the chain's last read, sent at 6.6 s,
    // answers at 13.6 s: the cover's search and the second hop have no time left.
    const log = warnings();
    const { cache, writes } = writesCache();
    const net = stubFetch(slow(withCovers(), stalledAt(isRelease, 7_000)));
    const { mb } = await onFakeClock({ cache });

    expect(searchIds(net.calls)).toHaveLength(1);
    expect(directDates(mb.records)).toEqual({
      ...EXPECTED_DIRECT,
      [COVER_DATED]: "2010-01-01",
      [COVER_UNDATED]: null,
    });
    expect(writes.filter(([id]) => id === COVER_UNDATED)).toEqual([]);
    expect(log()).toEqual([
      expect.stringMatching(
        new RegExp(
          `: not read the dates of 1 recordings \\(no time left\\); the second hop from recording/${PASTIME} \\(no time left\\)$`,
        ),
      ),
    ]);
    expect(mb.incomplete).toContain(MAP_INCOMPLETE);
  });
});
