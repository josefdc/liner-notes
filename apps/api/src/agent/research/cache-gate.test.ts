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
import { runRoute } from "../../sources/testing/iceIceBaby.js";
import { type CachedResearch, initCache, type SonicCache } from "../../store/cache.js";
import { runMigrations } from "../../store/migrations.js";
import { configuredSources, researchCacheKey } from "../cacheKeys.js";
import { historianNode } from "../nodes/historianNode.js";
import type { SonicAgentStateType, SpotifyData } from "../state.js";
import { type StubCall, stubLlm, testRuntime } from "../testing/stubLlm.js";

const AT = "2026-10-20T12:00:00.000Z";
const LATER = "2026-10-21T08:00:00.000Z";
const MB = "https://musicbrainz.org/ws/2";
const SHS_WORK = "https://secondhandsongs.com/work/4196";
const WORK = `${MB}/work/e0ebb61d-7f69-3667-a2b1-dcd447d80f3d?`;
const WEB_ID = "tavily:https://example.test/ice-ice-baby";

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

  it("reads the primary sources for cached evidence of another ISRC, and keeps its web items", async () => {
    await historian();
    const stored = cache.getResearch(key()) as CachedResearch;
    const evidence = stored.evidence;
    if (!evidence) throw new Error("no cached evidence");
    cache.putResearch(key(), { ...stored, evidence: { ...evidence, isrc: "USXX00000001" } });

    const hit = await historian(LATER);
    expect(hit.llm.calls).toEqual([]);
    expect(primaryRequests(hit.requests).length).toBeGreaterThan(0);
    expect(ids(hit.out.evidence)).toContain(WEB_ID);
    expect(statusOf(hit.events)).toContain(
      "📇 Reading primary sources (MusicBrainz, SecondHandSongs)...",
    );
  });
});

describe("pacing in a run", () => {
  beforeEach(() => setUnpacedForTests(false));
  afterEach(() => setUnpacedForTests(true));

  it("reports a SecondHandSongs request it cannot pace in time as rate limited", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      // Three runs at once: the anonymous pace (one request every 6 s) puts the third run's
      // request 12 s away, within the 15 s a request may wait; a fourth would wait 18 s.
      const runs = Promise.all([historian(), historian(), historian(), historian()]);
      await vi.advanceTimersByTimeAsync(30_000);
      const done = await runs;
      const limited = done.filter(({ out }) =>
        out.sourceErrors?.some((e) => e.source === "secondhandsongs" && e.code === "rate_limited"),
      );
      expect(limited).toHaveLength(1);
      expect(net.calls.filter((c) => c.url === SHS_WORK)).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
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
    expect(of("Historian").map((e) => e.msg)).toContain(
      "Deep dive research for: Ice Ice Baby by Vanilla Ice",
    );
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
