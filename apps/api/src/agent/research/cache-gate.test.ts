/**
 * The research cache's gate (A4), with the real cache over a fresh database, every source
 * stubbed at the network and the model faked: research is cached with the run's evidence only
 * when the run is complete; a primary source that could not be read (an outage, a rate limit, a
 * deadline, records lost to a failed request) blocks it, a source that is not configured or an
 * answer of a shape its reader does not know does not, and both are reported again on a hit. A
 * hit gives the cached run's evidence (web-tier items included), recording and errors back and
 * asks no primary source; the key names the configured primary sources; research cached by older
 * code, or whose stored evidence fails its checks, is read again.
 */

import type { Evidence } from "@liner-notes/contract";
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLogsForTests } from "../../logger.js";
import { MusicBrainzRateLimiter } from "../../sources/musicbrainz.js";
import { setUnpacedForTests } from "../../sources/pacing.js";
import {
  type FetchCall,
  type FetchRoute,
  json,
  never,
  stubFetch,
} from "../../sources/testing/fetchStub.js";
import { shsRelationships } from "../../sources/shs.js";
import { ICE_TRACK, runRoute } from "../../sources/testing/iceIceBaby.js";
import {
  type CachedEvidence,
  type CachedResearch,
  initCache,
  type SonicCache,
} from "../../store/cache.js";
import { runMigrations } from "../../store/migrations.js";
import { configuredSources, researchCacheKey } from "../cacheKeys.js";
import { historianNode } from "../nodes/historianNode.js";
import { CACHED_EVIDENCE_FORMAT } from "./runEvidence.js";
import type { SonicAgentStateType, SpotifyData } from "../state.js";
import { type StubCall, stubLlm, testRuntime } from "../testing/stubLlm.js";

const AT = "2026-10-20T12:00:00.000Z";
const LATER = "2026-10-21T08:00:00.000Z";
const MB = "https://musicbrainz.org/ws/2";
const SHS_WORK = "https://secondhandsongs.com/work/4196";
const WORK = `${MB}/work/e0ebb61d-7f69-3667-a2b1-dcd447d80f3d?`;
const WEB_ID = "tavily:https://example.test/ice-ice-baby";
/** The timers a test drives: the deadlines, the pacers' clock and MusicBrainz's queue. */
const FAKE = ["setTimeout", "clearTimeout", "Date", "performance"] as const;

const spotifyData = {
  id: "3Fcfwhm8oRrBvBZ8KGhtea",
  title: "Ice Ice Baby",
  artist: "Vanilla Ice",
  artistIds: ["7GaxyUddsPok8BuhxN6OUW"],
  album: "To the Extreme",
  releaseDate: "1990-09-10",
  coverUrl: "https://i.scdn.co/image/x",
  duration: "4:31",
  durationMs: 271_733,
  explicit: false,
  isrc: "USCA29001716",
  spotifyUrl: "https://open.spotify.com/track/3Fcfwhm8oRrBvBZ8KGhtea",
  previewUrl: null,
} as unknown as SpotifyData;
const state = { spotifyData, isrc: "USCA29001716" } as SonicAgentStateType;

/** Last.fm, the web search and every request about the track (MusicBrainz, SecondHandSongs). */
function route(call: FetchCall) {
  if (call.url.startsWith("https://ws.audioscrobbler.com/")) {
    return json({ error: 6, message: "Track not found" });
  }
  if (call.url === "https://api.tavily.com/search") {
    return json({
      results: [
        {
          title: "Ice Ice Baby samples",
          url: "https://example.test/ice-ice-baby",
          content: "The bass line comes from Under Pressure by Queen and David Bowie.",
        },
      ],
    });
  }
  return runRoute(call);
}

const primaryRequests = (calls: readonly FetchCall[]) =>
  calls.filter((c) =>
    /^https:\/\/(musicbrainz\.org|secondhandsongs\.com|api\.discogs\.com|api\.genius\.com)\//.test(
      c.url,
    ),
  );

let restoreInterval: () => void;
beforeAll(() => {
  restoreInterval = MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
});
afterAll(() => restoreInterval());

let db: Database.Database;
let cache: SonicCache;
let net: ReturnType<typeof stubFetch>;
beforeEach(() => {
  for (const name of ["DISCOGS_TOKEN", "GENIUS_ACCESS_TOKEN", "SHS_API_KEY", "SOURCE_CASSETTE"]) {
    delete process.env[name];
  }
  vi.stubEnv("LASTFM_API_KEY", "lastfm-test-key-0123456789");
  vi.stubEnv("TAVILY_API_KEY", "tavily-test-key-0123456789");
  db = new Database(":memory:");
  runMigrations(db);
  cache = initCache(db);
  net = stubFetch(route);
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const planner = (call: StubCall) =>
  call.callSite === "research_planner"
    ? { nextAction: "done", query: null, reasoning: "enough for this track" }
    : {};

/** One historian run at `at`; its answer, its status events and the requests it made. */
async function historian(at = AT) {
  const before = net.calls.length;
  const events: Array<{ type: string; message?: string; evidence?: Evidence }> = [];
  const llm = stubLlm(planner);
  const out = await historianNode(
    state,
    { writer: (event: never) => events.push(event) } as never,
    testRuntime(llm, at),
  );
  return { out, events, llm, requests: net.calls.slice(before) };
}

const key = () => researchCacheKey(spotifyData.id, configuredSources());
const ids = (items: readonly Evidence[] | undefined) => (items ?? []).map((e) => e.id);
const statusOf = (events: ReadonlyArray<{ type: string; message?: string }>) =>
  events.filter((e) => e.type === "status").map((e) => e.message ?? "");

describe("research is cached with the run's evidence only when the run is complete", () => {
  it("caches it, and a hit gives the same evidence back without asking a primary source", async () => {
    const fresh = await historian();
    expect(new Set(fresh.out.evidence?.map((e) => e.source))).toEqual(
      new Set(["musicbrainz", "secondhandsongs", "tavily"]),
    );
    expect(cache.getResearch(key())?.evidence?.items.map((e) => e.id)).toEqual(
      ids(fresh.out.evidence),
    );

    const hit = await historian(LATER);
    expect(primaryRequests(hit.requests)).toEqual([]);
    expect(hit.requests).toEqual([]);
    expect(hit.llm.calls).toEqual([]);
    // The same pack, web page included, with the dates the sources were read.
    expect(hit.out.evidence).toEqual(fresh.out.evidence);
    expect(ids(hit.out.evidence)).toContain(WEB_ID);
    for (const item of hit.out.evidence ?? []) expect(item.retrievedAt).toBe(AT);
    expect(hit.events.filter((e) => e.type === "evidence").map((e) => e.evidence)).toEqual(
      fresh.out.evidence,
    );
    // The composer gets the recording, and the result built without the model its samples.
    expect(hit.out.isrcRecording).toEqual(fresh.out.isrcRecording);
    expect(hit.out.isrcRecording?.mbid).toBe("875c24bc-fe9e-4ac6-80d3-beaacb70ee43");
    expect(hit.out.researchData?.samples).toEqual(fresh.out.researchData?.samples);
    // Discogs and Genius were not configured then, and still are not: reported again.
    expect(hit.out.sourceErrors).toEqual(fresh.out.sourceErrors);
    expect(hit.out.sourceErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "discogs", code: "not_configured" }),
        expect.objectContaining({ source: "genius", code: "not_configured" }),
      ]),
    );
    // The status says where the records come from, and that they were not asked again.
    const records = (fresh.out.evidence ?? []).filter((e) => e.sourceTier === "primary-record");
    const mb = records.filter((e) => e.source === "musicbrainz").length;
    expect(statusOf(hit.events)).toContain(
      `📇 Primary sources: ${records.length} records (MusicBrainz ${mb}, SecondHandSongs ${
        records.length - mb
      }), from the research cache (read 2026-10-20; not asked again)`,
    );
    expect(statusOf(hit.events)).not.toContain(
      "📇 Reading primary sources (MusicBrainz, SecondHandSongs)...",
    );
  });

  const failures: Array<[string, FetchRoute]> = [
    [
      "SecondHandSongs is down (503)",
      (call) => (call.url === SHS_WORK ? new Response("busy", { status: 503 }) : route(call)),
    ],
    [
      "SecondHandSongs answers 429 twice",
      (call) =>
        call.url === SHS_WORK
          ? new Response("slow down", { status: 429, headers: { "retry-after": "0" } })
          : route(call),
    ],
    [
      "MusicBrainz loses the work to a 503 (lost records)",
      (call) => (call.url.startsWith(WORK) ? new Response("busy", { status: 503 }) : route(call)),
    ],
    [
      "MusicBrainz cannot be read at all",
      (call) =>
        call.url.startsWith(`${MB}/`) ? new Response("bad gateway", { status: 502 }) : route(call),
    ],
    [
      "SecondHandSongs answers an HTML page",
      (call) =>
        call.url === SHS_WORK
          ? new Response("<html>are you a robot?</html>", {
              headers: { "content-type": "text/html" },
            })
          : route(call),
    ],
  ];
  for (const [name, failing] of failures) {
    it(`does not cache it when ${name}`, async () => {
      net = stubFetch(failing);
      const { out } = await historian();
      expect(
        (out.sourceErrors ?? []).filter((e) => e.code !== "not_configured").length,
      ).toBeGreaterThan(0);
      expect(cache.getResearch(key())).toBeNull();
    });
  }

  it("does not cache it when a primary source runs out of time", async () => {
    vi.stubEnv("SOURCE_TIMEOUT_MS", "50");
    net = stubFetch((call) => (call.url === SHS_WORK ? never(call) : route(call)));
    const { out } = await historian();
    expect(out.sourceErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "secondhandsongs", code: "timeout" }),
      ]),
    );
    expect(cache.getResearch(key())).toBeNull();
  });

  it("caches it past an answer of a shape the reader does not know, and reports it on a hit", async () => {
    net = stubFetch((call) => (call.url === SHS_WORK ? json({ unexpected: true }) : route(call)));
    const fresh = await historian();
    const shape = expect.objectContaining({ source: "secondhandsongs", code: "invalid_response" });
    expect(fresh.out.lastingSourceErrors).toEqual([shape]);
    expect(cache.getResearch(key())?.evidence?.lasting).toEqual([shape]);

    // SecondHandSongs answers now; the hit asks nothing and says what the cached run missed.
    net = stubFetch(route);
    const hit = await historian(LATER);
    expect(hit.requests).toEqual([]);
    expect(hit.out.evidence).toEqual(fresh.out.evidence);
    expect(hit.out.sourceErrors).toEqual(expect.arrayContaining([shape]));
    expect(hit.out.lastingSourceErrors).toEqual([shape]);
    expect(statusOf(hit.events)).toContain(
      "⚠️ SecondHandSongs could not be read (invalid_response)",
    );
  });
});

describe("the research key and what a hit trusts", () => {
  it("names Discogs and Genius: adding a token never serves research cached without it", () => {
    const none = { lastfm: true, tavily: true, discogs: false, genius: false };
    const keys = new Set([
      researchCacheKey("x", none),
      researchCacheKey("x", { ...none, discogs: true }),
      researchCacheKey("x", { ...none, genius: true }),
      researchCacheKey("x", { ...none, discogs: true, genius: true }),
    ]);
    expect(keys.size).toBe(4);
    expect([...keys][0]).toBe("v4:x:lastfm=1:tavily=1:discogs=0:genius=0");
  });

  it("reads the research again once a Discogs token is set", async () => {
    await historian();
    expect(cache.getResearch(key())).not.toBeNull();

    vi.stubEnv("DISCOGS_TOKEN", "discogs-test-token-0123456789");
    expect(cache.getResearch(key())).toBeNull();
    const again = await historian(LATER);
    expect(primaryRequests(again.requests).length).toBeGreaterThan(0);
    expect(again.llm.calls.length).toBeGreaterThan(0);
  });

  it("does not read research cached by older code (key v3)", async () => {
    const v3 = `v3:${spotifyData.id}:lastfm=1:tavily=1`;
    cache.putResearch(v3, { samples: ["old research"], productionTrivia: [] });
    const run = await historian();
    expect(run.out.researchData?.samples).not.toContain("old research");
    expect(run.llm.calls.length).toBeGreaterThan(0);
  });

  it("reads the research again when the cached evidence holds an item no source built", async () => {
    await historian();
    const stored = cache.getResearch(key()) as CachedResearch;
    const forged: Evidence = {
      id: "tavily:summary",
      source: "tavily",
      sourceTier: "primary-record",
      url: null,
      title: "A summary",
      retrievedAt: AT,
      excerpt: "Ice Ice Baby was the first hip-hop single to top the Billboard Hot 100.",
      recordRef: "track/summary",
    };
    const evidence = stored.evidence;
    if (!evidence) throw new Error("no cached evidence");
    cache.putResearch(key(), { ...stored, evidence: { ...evidence, items: [forged] } });

    const again = await historian(LATER);
    expect(ids(again.out.evidence)).not.toContain("tavily:summary");
    expect(primaryRequests(again.requests).length).toBeGreaterThan(0);
    expect(again.llm.calls.length).toBeGreaterThan(0);
  });

  it("does not use cached evidence of another ISRC: the research is made again and replaces it", async () => {
    await historian();
    const stored = cache.getResearch(key()) as CachedResearch;
    const evidence = stored.evidence;
    if (!evidence) throw new Error("no cached evidence");
    cache.putResearch(key(), {
      ...stored,
      collaboratorsOf: "OLD ARTIST",
      evidence: { ...evidence, isrc: "USXX00000001" },
    });

    const again = await historian(LATER);
    expect(again.llm.calls.length).toBeGreaterThan(0);
    expect(again.out.researchData?.collaboratorsOf).not.toBe("OLD ARTIST");
    expect(cache.getResearch(key())?.evidence?.isrc).toBe("USCA29001716");
  });

  const crafted: Array<[string, (row: CachedResearch) => CachedResearch]> = [
    ["of another format", (row) => withEvidence(row, { format: CACHED_EVIDENCE_FORMAT + 1 })],
    // Written before the pack named the recording's release: read again, so it can name one.
    ["of the format before releases were read", (row) => withEvidence(row, { format: 2 })],
    [
      "holding a timeout as lasting",
      (row) =>
        withEvidence(row, {
          errors: [{ source: "secondhandsongs", code: "timeout" }],
          lasting: [{ source: "secondhandsongs", code: "timeout" }],
        }),
    ],
    [
      "holding an error that blocks caching",
      (row) => withEvidence(row, { errors: [{ source: "secondhandsongs", code: "unavailable" }] }),
    ],
    [
      "whose recording is not its records' recording",
      (row) =>
        withEvidence(row, {
          recording: {
            ...(row.evidence?.recording as NonNullable<CachedEvidence["recording"]>),
            mbid: "00000000-0000-4000-8000-000000000000",
          },
        }),
    ],
    [
      "saying Discogs was not configured, while it is now",
      (row) => {
        vi.stubEnv("DISCOGS_TOKEN", "discogs-test-token-0123456789");
        // The key names Discogs: the row is put where this run looks.
        cache.putResearch(key(), row);
        return row;
      },
    ],
  ];
  for (const [what, craft] of crafted) {
    it(`does not use a cached row ${what}`, async () => {
      await historian();
      const row = cache.getResearch(key()) as CachedResearch;
      cache.putResearch(key(), craft(row));
      expect(cache.getResearch(key())).not.toBeNull();
      const again = await historian(LATER);
      expect(again.llm.calls.length).toBeGreaterThan(0);
    });
  }
});

/** A cached row with fields of its evidence replaced. */
function withEvidence(row: CachedResearch, patch: Partial<CachedEvidence>): CachedResearch {
  const evidence = row.evidence;
  if (!evidence) throw new Error("no cached evidence");
  return { ...row, evidence: { ...evidence, ...patch } };
}

describe("what is not cached, or cached for a later run to complete", () => {
  it("does not cache research from a run that could not read the track's details", async () => {
    const degraded = {
      spotifyData: { ...spotifyData, isrc: null, durationMs: 0, duration: "" },
      isrc: null,
      sourceErrors: [{ source: "spotify", code: "unavailable", message: "spotify: HTTP 503" }],
    } as unknown as SonicAgentStateType;
    const llm = stubLlm(planner);
    await historianNode(degraded, { writer: () => {} } as never, testRuntime(llm, AT));
    expect(llm.calls.length).toBeGreaterThan(0);
    expect(cache.getResearch(key())).toBeNull();

    // The next run, with the details, makes the research and caches it.
    const next = await historian(LATER);
    expect(next.llm.calls.length).toBeGreaterThan(0);
    expect(cache.getResearch(key())?.evidence?.isrc).toBe("USCA29001716");
  });

  it("does not cache it when SecondHandSongs answers a JSON error at 200, and does not call it lasting", async () => {
    net = stubFetch((call) =>
      call.url === SHS_WORK ? json({ error: "Too many requests, slow down" }) : route(call),
    );
    const { out } = await historian();
    expect(out.sourceErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "secondhandsongs", code: "rate_limited" }),
      ]),
    );
    expect(out.lastingSourceErrors ?? []).toEqual([]);
    expect(cache.getResearch(key())).toBeNull();
  });

  it("caches research whose work could not be dated in time, and a hit reads the primary sources again", async () => {
    vi.useFakeTimers({ toFake: [...FAKE] });
    let first: Awaited<ReturnType<typeof historian>>;
    try {
      net = stubFetch((call) =>
        call.url.startsWith(`${MB}/recording?work=`) ? never(call) : route(call),
      );
      const run = historian();
      await vi.advanceTimersByTimeAsync(25_000);
      first = await run;
    } finally {
      vi.useRealTimers();
    }
    expect((first.out.sourceErrors ?? []).filter((e) => e.code !== "not_configured")).toEqual([]);
    // The releases are read last, on the dating signal: cut with the dating.
    expect(cache.getResearch(key())?.evidence?.incomplete).toEqual([
      { source: "musicbrainz", part: "dates" },
      { source: "musicbrainz", part: "releases" },
    ]);

    // The dating answers now: the hit asks no model, reads the primary sources and completes the row.
    net = stubFetch(route);
    const hit = await historian(LATER);
    expect(hit.llm.calls).toEqual([]);
    expect(primaryRequests(hit.requests).length).toBeGreaterThan(0);
    expect(ids(hit.out.evidence)).toContain(WEB_ID);
    expect(cache.getResearch(key())?.evidence?.incomplete).toEqual([]);
    // Then a hit asks nothing.
    expect((await historian(LATER)).requests).toEqual([]);
  });
});

describe("a run whose MusicBrainz releases could not be read", () => {
  const releaseRead = (call: FetchCall) => call.url.startsWith(`${MB}/release?`);

  it("is cached for a later run to complete, with no source error, and a hit names the release", async () => {
    net = stubFetch((call) =>
      releaseRead(call) ? json({ error: "boom" }, { status: 500 }) : route(call),
    );
    const first = await historian();
    expect((first.out.sourceErrors ?? []).filter((e) => e.code !== "not_configured")).toEqual([]);
    expect(ids(first.out.evidence).some((id) => id.startsWith("musicbrainz:release/"))).toBe(false);
    expect(statusOf(first.events)).toContain(
      "MusicBrainz: releases incomplete, the recording's releases could not be read, so no release is named for it; a later run reads them",
    );
    expect(cache.getResearch(key())?.evidence?.incomplete).toEqual([
      { source: "musicbrainz", part: "releases" },
    ]);

    // The releases answer now: the hit reads the primary sources again and names the release.
    net = stubFetch(route);
    const hit = await historian(LATER);
    expect(hit.llm.calls).toEqual([]);
    expect(hit.requests.filter(releaseRead)).toHaveLength(1);
    expect(ids(hit.out.evidence)).toContain(
      "musicbrainz:release/ae103b0a-b932-4009-acb6-388db1cf890b",
    );
    expect(cache.getResearch(key())?.evidence?.incomplete).toEqual([]);
    expect((await historian(LATER)).requests).toEqual([]);
  });
});

/** Runs `run` on timers the test drives, `ms` of them. */
async function onFakeTimers<T>(run: () => Promise<T>, ms = 25_000): Promise<T> {
  vi.useFakeTimers({ toFake: [...FAKE] });
  try {
    const result = run();
    await vi.advanceTimersByTimeAsync(ms);
    return await result;
  } finally {
    vi.useRealTimers();
  }
}

/** The work's recordings never answer: the dating is cut, and the row is left incomplete. */
const undated = (call: FetchCall) =>
  call.url.startsWith(`${MB}/recording?work=`) ? never(call) : route(call);

/**
 * SecondHandSongs held by our own pacing: one 429 asking for 120 s, longer than a request may
 * wait, so the next request is refused by the pacer and not sent.
 */
async function holdSecondHandSongs() {
  setUnpacedForTests(false);
  stubFetch((call) =>
    call.url === SHS_WORK
      ? new Response("slow down", { status: 429, headers: { "retry-after": "120" } })
      : undefined,
  );
  await shsRelationships(ICE_TRACK, [{ kind: "work", id: 4196, from: "work" }]);
  net = stubFetch(route);
}

describe("a row left for a later run", () => {
  afterEach(() => setUnpacedForTests(true));

  it("is never served past the research's own time, however often a hit reads it again", async () => {
    net = stubFetch(undated);
    await onFakeTimers(() => historian(AT));
    // The releases are read last, on the dating signal: cut with the dating.
    expect(cache.getResearch(key())?.evidence?.incomplete).toEqual([
      { source: "musicbrainz", part: "dates" },
      { source: "musicbrainz", part: "releases" },
    ]);
    // At +47 h a hit reads the primary sources again (the dating still fails) and asks no model.
    const late = await onFakeTimers(() => historian("2026-10-22T11:00:00.000Z"));
    expect(late.llm.calls).toEqual([]);
    const row = cache.getResearch(key());
    expect(row?.evidence?.researchedAt).toBe(AT);
    // The row keeps its own expiry: about an hour is left, not another 48 h.
    const { expires_at } = db.prepare("SELECT expires_at FROM research_cache").get() as {
      expires_at: number;
    };
    expect(expires_at - Date.now() / 1000).toBeLessThanOrEqual(3600 + 60);
    // At +48 h the research is made again.
    const expired = await onFakeTimers(() => historian("2026-10-22T12:00:00.000Z"));
    expect(expired.llm.calls.length).toBeGreaterThan(0);
    expect(cache.getResearch(key())?.evidence?.researchedAt).toBe("2026-10-22T12:00:00.000Z");
  });

  it("is not written again when the re-read fails", async () => {
    net = stubFetch(undated);
    await onFakeTimers(() => historian(AT));
    const before = JSON.stringify(cache.getResearch(key()));
    net = stubFetch((call) =>
      call.url === SHS_WORK ? new Response("busy", { status: 503 }) : route(call),
    );
    const hit = await historian(LATER);
    expect(hit.llm.calls).toEqual([]);
    expect(hit.out.sourceErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "secondhandsongs", code: "unavailable" }),
      ]),
    );
    expect(JSON.stringify(cache.getResearch(key()))).toBe(before);
  });

  it("keeps the cached records of a source the re-read does not ask again, and says so", async () => {
    net = stubFetch(undated);
    const first = await onFakeTimers(() => historian(AT));
    const shsIds = ids(first.out.evidence).filter((id) => id.startsWith("secondhandsongs:"));
    expect(shsIds.length).toBeGreaterThan(0);

    await holdSecondHandSongs();
    const hit = await historian(LATER);
    expect(ids(hit.out.evidence)).toEqual(expect.arrayContaining(shsIds));
    expect(hit.out.primaryNotAsked ?? []).toEqual([]);
    expect(statusOf(hit.events)).toContain(
      `📇 SecondHandSongs not asked again: its ${shsIds.length} records come from the research cache (read 2026-10-20)`,
    );
    const row = cache.getResearch(key());
    expect(row?.evidence?.items.map((e) => e.id)).toEqual(expect.arrayContaining(shsIds));
    expect(row?.evidence?.incomplete).toEqual([]);
  });

  it("says what it misses to a run that could not read the track's details", async () => {
    await historian();
    const row = cache.getResearch(key()) as CachedResearch;
    const evidence = row.evidence as CachedEvidence;
    cache.putResearch(key(), {
      ...row,
      evidence: {
        ...evidence,
        items: evidence.items.filter((e) => e.source !== "secondhandsongs"),
        incomplete: [
          { source: "musicbrainz", part: "dates" },
          { source: "secondhandsongs", part: "not_asked" },
        ],
      },
    });
    const degraded = {
      spotifyData: { ...spotifyData, isrc: null, durationMs: 0, duration: "" },
      isrc: null,
      sourceErrors: [{ source: "spotify", code: "unavailable", message: "spotify: HTTP 503" }],
    } as unknown as SonicAgentStateType;
    const events: Array<{ type: string; message?: string }> = [];
    const before = net.calls.length;
    const out = await historianNode(
      degraded,
      { writer: (event: never) => events.push(event) } as never,
      testRuntime(stubLlm(planner), LATER),
    );
    expect(net.calls.length).toBe(before);
    expect(out.primaryNotAsked).toEqual(["secondhandsongs"]);
    expect(statusOf(events)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^📇 MusicBrainz: dates incomplete/),
        "📇 SecondHandSongs not asked: the research cached on 2026-10-20 did not ask it; a later run asks it",
      ]),
    );
  });

  it("judges web pages against the title the researcher searched, without the featured artist", async () => {
    const featured = {
      ...spotifyData,
      id: "4uLU6hMCjMI75M1A2tKUQC",
      title: "404 (feat. Quinn)",
      artist: "The Testers",
      isrc: null,
    } as unknown as SpotifyData;
    const page = "https://example.test/404-review";
    net = stubFetch((call) =>
      call.url === "https://api.tavily.com/search"
        ? json({
            results: [
              { title: "404 | Pitchfork", url: page, content: "A careful review of the single." },
            ],
          })
        : route(call),
    );
    const run = (at: string) => {
      const llm = stubLlm(planner);
      return historianNode(
        { spotifyData: featured, isrc: null } as SonicAgentStateType,
        { writer: () => {} } as never,
        testRuntime(llm, at),
      ).then((out) => ({ out, llm }));
    };
    const fresh = await run(AT);
    expect(ids(fresh.out.evidence)).toContain(`tavily:${page}`);
    const hit = await run(LATER);
    expect(hit.llm.calls).toEqual([]);
    expect(ids(hit.out.evidence)).toContain(`tavily:${page}`);
  });
});

describe("a source our pacing did not ask", () => {
  afterEach(() => setUnpacedForTests(true));

  it("is reported as not asked by a fresh run, and the research is cached incomplete", async () => {
    await holdSecondHandSongs();
    const { out, events } = await historian();
    expect(out.primaryNotAsked).toEqual(["secondhandsongs"]);
    expect(out.sourceErrors?.some((e) => e.source === "secondhandsongs")).toBe(false);
    expect(statusOf(events)).toContain(
      "📇 SecondHandSongs not asked: our own pacing of its requests left no time in this run; a later run asks it",
    );
    expect(cache.getResearch(key())?.evidence?.incomplete).toEqual([
      { source: "secondhandsongs", part: "not_asked" },
    ]);
  });

  it("is reported as not asked by a refresh hit that cannot ask it either", async () => {
    await holdSecondHandSongs();
    await historian();
    // Still held: the refresh hit does not ask it, and holds no records of it to keep.
    const hit = await historian(LATER);
    expect(hit.llm.calls).toEqual([]);
    expect(hit.out.primaryNotAsked).toEqual(["secondhandsongs"]);
  });
});

describe("pacing in concurrent runs", () => {
  let restoreMb: () => void;
  beforeEach(() => {
    setUnpacedForTests(false);
    // MusicBrainz at its production spacing, as the shared queue runs it.
    restoreMb = MusicBrainzRateLimiter.getInstance().setIntervalForTests(1100);
  });
  afterEach(() => {
    restoreMb();
    setUnpacedForTests(true);
  });

  /** `n` historian runs at once on the timers the test drives; what each one read. */
  async function concurrent(n: number) {
    vi.useFakeTimers({ toFake: [...FAKE] });
    try {
      const runs = Promise.all(Array.from({ length: n }, () => historian()));
      await vi.advanceTimersByTimeAsync(60_000);
      return await runs;
    } finally {
      vi.useRealTimers();
    }
  }

  for (const n of [4, 6]) {
    it(`loses no record of ${n} concurrent runs to our own pacing`, async () => {
      const [alone] = await concurrent(1);
      db.prepare("DELETE FROM research_cache").run();
      const runs = await concurrent(n);
      const own = (alone.out.evidence ?? []).filter((e) => e.source === "secondhandsongs");
      expect(own.length).toBeGreaterThan(0);
      let notAsked = 0;
      for (const { out } of runs) {
        // Our own pacing kept no request from being sent, and no source was "timed out" by it.
        expect((out.statusMessages ?? []).filter((m) => m.includes("our own pacing"))).toEqual([]);
        expect(out.sourceErrors?.some((e) => e.source === "secondhandsongs")).toBe(false);
        if (out.primaryNotAsked?.includes("secondhandsongs")) {
          // Only the run's own deadline, after the shared MusicBrainz queue, may leave it unasked.
          notAsked++;
          continue;
        }
        const shs = (out.evidence ?? []).filter((e) => e.source === "secondhandsongs");
        expect(shs.map((e) => e.id)).toEqual(own.map((e) => e.id));
      }
      expect(net.calls.filter((c) => c.url === SHS_WORK)).toHaveLength(1 + n - notAsked);
    }, 30_000);
  }
});

describe("the historian, researcher and research cache log through the API's logger", () => {
  it("as JSON lines of their component; the planner's reasoning only at debug level", async () => {
    const logs = captureLogsForTests();
    try {
      await historian();
      // A research row of a shape the reader does not know is a miss, and says so.
      db.prepare("UPDATE research_cache SET full_data = '{\"samples\": 3}'").run();
      await historian(LATER);
    } finally {
      logs.restore();
    }
    const entries = logs.entries();
    const of = (component: string) => entries.filter((e) => e.component === component);
    // The track's title is written at debug level only.
    expect(of("Historian")).toContainEqual(
      expect.objectContaining({
        level: "debug",
        msg: "Deep dive research for: Ice Ice Baby by Vanilla Ice",
      }),
    );
    const above = [...of("Historian"), ...of("Researcher"), ...of("Cache")].filter(
      (e) => e.level !== "debug",
    );
    expect(above.length).toBeGreaterThan(0);
    for (const entry of above) expect(JSON.stringify(entry)).not.toContain("Ice Ice Baby");
    expect(of("Researcher").map((e) => e.msg)).toContain("Plan: done");
    expect(of("Cache")).toContainEqual(
      expect.objectContaining({
        level: "warn",
        msg: `Ignoring research row for ${key()}: unexpected shape`,
      }),
    );
    // Model text (the planner's reasoning) is written at debug level only.
    const reasoning = entries.filter((e) => JSON.stringify(e).includes("enough for this track"));
    expect(reasoning.length).toBeGreaterThan(0);
    for (const entry of reasoning) expect(entry.level).toBe("debug");
  });

  it("none of them writes to the console", () => {
    for (const file of [
      "../nodes/historianNode.ts",
      "../researcherSubgraph.ts",
      "../../store/cache.ts",
    ]) {
      const text = readFileSync(new URL(file, import.meta.url), "utf8");
      expect(text, file).not.toMatch(/\bconsole\./);
    }
  });
});
