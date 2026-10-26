/**
 * The evidence pack of a run, end to end with every source stubbed and the model faked: the
 * historian reads the primary sources from the track's ISRC and the web search, sends each item
 * as an `evidence` event and writes the pack to the state; the composer is given it; the stored
 * run keeps it in `runs.evidence`, where a query lists the sources, none of them a model.
 *
 * Set EVIDENCE_RUN_DB to a file path to keep the stored run's database for a manual query.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { type Evidence, SourceId, TrackAnalysis } from "@liner-notes/contract";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tools = vi.hoisted(() => {
  const tool = (answer: () => string) => ({
    invoke: vi.fn(async (..._args: unknown[]) => answer()),
  });
  const none = () => JSON.stringify({ found: false });
  const track = {
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
  };
  return {
    track,
    spotifySearch: tool(() => JSON.stringify([track])),
    analyzeAudioPreview: tool(() =>
      JSON.stringify({ source: "unavailable", reason: "no_preview" }),
    ),
    lastfm: tool(none),
    searchSamples: tool(() =>
      JSON.stringify({
        found: true,
        results: [
          {
            title: "Ice Ice Baby samples",
            url: "https://example.test/ice-ice-baby",
            content: "The bass line comes from Under Pressure by Queen and David Bowie.",
          },
        ],
      }),
    ),
    other: tool(none),
  };
});
vi.mock("../../sources/spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sources/spotify.js")>()),
  searchTracks: async (query: string, limit: number, signal?: AbortSignal) =>
    JSON.parse(await tools.spotifySearch.invoke({ query, limit }, { signal })),
}));
vi.mock("../../sources/audio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sources/audio.js")>()),
  // The engineer's own preview lookup and health probe (the analysis itself is stubbed).
  resolvePreview: async () => ({
    previewUrl: null,
    match: null,
    detail: "No preview in this test",
  }),
  audioServiceHealth: async () => null,
  analyzeAudioPreview: tools.analyzeAudioPreview,
}));
vi.mock("../../sources/lastfm.js", () => ({
  lastfmConfigured: () => true,
  getLastfmTrackTags: tools.lastfm,
  getLastfmArtistTags: tools.lastfm,
  getLastfmSimilarTracks: tools.lastfm,
  getLastfmSimilarArtists: tools.lastfm,
  getLastfmArtistInfo: tools.lastfm,
}));
vi.mock("../../sources/search.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sources/search.js")>()),
  tavilyConfigured: () => true,
  searchSamples: tools.searchSamples,
  searchProductionHistory: tools.other,
  searchMusicInfo: tools.other,
}));
const cache = vi.hoisted(() => ({
  getResearch: vi.fn((_key: string): unknown => null),
  putResearch: vi.fn(),
}));
vi.mock("../../store/cache.js", () => ({
  getCache: () => ({
    getAudio: () => null,
    getNewestAudio: () => null,
    putAudio: () => {},
    getResearch: cache.getResearch,
    putResearch: cache.putResearch,
  }),
}));
vi.mock(
  "../enricher.js",
  () =>
    ({
      enrichGenealogyWithArtwork: async (genealogy) => ({
        nodes: (genealogy?.nodes ?? []).map(({ id }) => ({ id })),
      }),
    }) satisfies Partial<typeof import("../enricher.js")>,
);

import { MusicBrainzRateLimiter } from "../../sources/musicbrainz.js";
import { evidenceScope } from "../../sources/records.js";
import { json, stubFetch } from "../../sources/testing/fetchStub.js";
import shsWork from "../../sources/fixtures/shs-work-ice-ice-baby.json" with { type: "json" };
import { setUnpacedForTests } from "../../sources/pacing.js";
import { shsRelationships } from "../../sources/shs.js";
import { ICE_TRACK, runRoute } from "../../sources/testing/iceIceBaby.js";
import { TRACKS_NAMESPACE } from "../cacheKeys.js";
import { runMigrations } from "../../store/migrations.js";
import { startRun, storeRunResult } from "../../store/runs.js";
import { buildSonicAgentGraph } from "../graph.js";
import { historianNode } from "../nodes/historianNode.js";
import type { TrackData } from "../schema.js";
import type { SonicAgentStateType, SpotifyData } from "../state.js";
import { messagesOf, type StubCall, stubLlm, testRuntime } from "../testing/stubLlm.js";

const AT = "2026-10-20T12:00:00.000Z";
const SHS_WORK = "https://secondhandsongs.com/work/4196";
const WEB_ID = "tavily:https://example.test/ice-ice-baby";
/** The MusicBrainz item for the recording itself. */
const RECORDING_ID = "musicbrainz:track/recording/875c24bc-fe9e-4ac6-80d3-beaacb70ee43";

/** The A2 query: the sources of the latest stored run's evidence pack. */
const A2_QUERY =
  "select group_concat(json_extract(e.value,'$.source')) s from (select evidence from runs " +
  "where evidence is not null order by rowid desc limit 1) r, json_each(r.evidence) e";

let restoreInterval: () => void;
beforeAll(() => {
  restoreInterval = MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
});
afterAll(() => restoreInterval());

let net: ReturnType<typeof stubFetch>;
beforeEach(() => {
  for (const name of ["DISCOGS_TOKEN", "GENIUS_ACCESS_TOKEN", "SHS_API_KEY", "SOURCE_CASSETTE"]) {
    delete process.env[name];
  }
  // Only the run's requests about the track are answered; any other request fails the source.
  net = stubFetch(runRoute);
  cache.getResearch.mockReset().mockReturnValue(null);
  cache.putResearch.mockClear();
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The fake model: the planner stops; the composer cites the recording and the web page. */
const answer = (call: StubCall) => {
  if (call.callSite === "research_planner") {
    return { nextAction: "done", query: null, reasoning: "enough for this track" };
  }
  return {
    claims: [
      {
        text: "MusicBrainz lists the recording with ISRC USCA29001716.",
        about: "track",
        evidenceIds: [RECORDING_ID],
        field: null,
      },
    ],
    factoids: [
      {
        title: "Borrowed bass",
        text: "The bass line comes from Under Pressure.",
        type: "sample",
        entities: [{ text: "Queen", type: "artist" }],
        evidenceIds: [WEB_ID],
      },
    ],
    genealogyNodes: [
      {
        id: "current",
        role: "current",
        label: "Ice Ice Baby",
        trackTitle: null,
        trackArtist: null,
        year: null,
      },
    ],
    genealogyLinks: [],
  };
};

const spotifyData = tools.track as unknown as SpotifyData;

/**
 * The research row a complete run caches, its research replaced by "cached", and marked as
 * having left `incomplete` for a later run (a hit then reads the primary sources again).
 */
async function storedRow(
  incomplete: unknown[] = [{ source: "secondhandsongs", part: "not_asked" }],
): Promise<Record<string, unknown>> {
  cache.getResearch.mockReturnValue(null);
  await historianNode(
    { spotifyData, isrc: "USCA29001716" } as SonicAgentStateType,
    { writer: () => {} } as never,
    testRuntime(stubLlm(answer), AT),
  );
  const row = JSON.parse(JSON.stringify(cache.putResearch.mock.calls.at(-1)?.[1]));
  cache.putResearch.mockClear();
  return { ...row, samples: ["cached"], evidence: { ...row.evidence, incomplete } };
}

describe("the historian's evidence pack", () => {
  it("holds the primary sources' records and the web search's results, each sent as an event", async () => {
    const llm = stubLlm(answer);
    const events: Array<{ type: string; evidence?: Evidence; message?: string }> = [];
    const out = await historianNode(
      { spotifyData, isrc: "USCA29001716" } as SonicAgentStateType,
      { writer: (event: never) => events.push(event) } as never,
      testRuntime(llm, AT),
    );

    const evidence = out.evidence ?? [];
    expect(new Set(evidence.map((e) => e.source))).toEqual(
      new Set(["musicbrainz", "secondhandsongs", "tavily"]),
    );
    expect(evidence[0].id).toBe(RECORDING_ID);
    // Best tier first: the web page comes last, after the song's (work) records.
    expect(evidence.at(-1)?.id).toBe(WEB_ID);
    expect(evidence.at(-1)?.sourceTier).toBe("web");
    const ranks = evidence.map((e) =>
      e.sourceTier === "web" ? 3 : { track: 0, release: 1, work: 2 }[evidenceScope(e) ?? "work"],
    );
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    for (const item of evidence) expect(item.retrievedAt).toBe(AT);
    expect(events.filter((e) => e.type === "evidence").map((e) => e.evidence)).toEqual(evidence);
    // Discogs and Genius have no credential: their errors are the run's, and say so.
    expect(out.sourceErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "discogs", code: "not_configured" }),
        expect.objectContaining({ source: "genius", code: "not_configured" }),
      ]),
    );
    expect(out.statusMessages).toContain(
      `📇 Primary sources: ${evidence.length - 1} records (MusicBrainz ${
        evidence.filter((e) => e.source === "musicbrainz").length
      }, SecondHandSongs ${evidence.filter((e) => e.source === "secondhandsongs").length})`,
    );
    // The research is cached with the pack and the primary sources' errors that do not block it.
    expect(cache.putResearch).toHaveBeenCalledTimes(1);
    const cached = cache.putResearch.mock.calls[0][1] as {
      evidence?: { items: Evidence[]; errors: unknown[] };
    };
    expect(cached.evidence?.items.map((e) => e.id)).toEqual(evidence.map((e) => e.id));
    expect(cached.evidence?.errors).toEqual(
      out.sourceErrors?.filter((e) => e.source === "discogs" || e.source === "genius"),
    );
    expect(net.calls.some((c) => c.url === "https://secondhandsongs.com/work/4196")).toBe(true);
  });

  it("reads the primary sources again for a cached research that left a part, and says so first", async () => {
    cache.getResearch.mockReturnValue(await storedRow());
    const events: Array<{ type: string; message?: string }> = [];
    const out = await historianNode(
      { spotifyData, isrc: "USCA29001716" } as SonicAgentStateType,
      { writer: (event: never) => events.push(event) } as never,
      testRuntime(stubLlm(answer), AT),
    );
    // The cached research, with this run's MusicBrainz sample relations.
    expect(out.researchData?.samples).toEqual([
      "cached",
      expect.stringMatching(/^\[MusicBrainz Samples\] .*"Under Pressure"/),
    ]);
    // This run's primary records and the cached run's web page.
    expect(new Set(out.evidence?.map((e) => e.source))).toEqual(
      new Set(["musicbrainz", "secondhandsongs", "tavily"]),
    );
    // SecondHandSongs answered this time: the row is written again, complete.
    expect(cache.putResearch).toHaveBeenCalledTimes(1);
    expect(
      (cache.putResearch.mock.calls[0][1] as { evidence: { incomplete: unknown[] } }).evidence
        .incomplete,
    ).toEqual([]);
    // While the sources are read, the stream says what the run is waiting for.
    // Only the sources that will be asked: Discogs and Genius have no credential here.
    const reading = events.findIndex(
      (e) => e.message === "📇 Reading primary sources (MusicBrainz, SecondHandSongs)...",
    );
    expect(reading).toBeGreaterThan(-1);
    expect(reading).toBeLessThan(events.findIndex((e) => e.type === "evidence"));
  });

  it("asks no primary source without an ISRC, and says so", async () => {
    const out = await historianNode(
      { spotifyData: { ...spotifyData, isrc: null }, isrc: null } as SonicAgentStateType,
      { writer: () => {} } as never,
      testRuntime(stubLlm(answer), AT),
    );
    expect(net.calls).toEqual([]);
    expect(out.evidence?.map((e) => e.id)).toEqual([WEB_ID]);
    expect(out.statusMessages).toContain("📇 Primary sources not asked: the track has no ISRC");
  });
});

/** One run of the whole graph for the track; the stored results and research it left. */
async function runGraph(threadId = "run-a2", store = new InMemoryStore()) {
  const llm = stubLlm(answer);
  const graph = buildSonicAgentGraph({
    runtime: testRuntime(llm, AT),
    checkpointer: new MemorySaver(),
    store,
  });
  let trackData: TrackData | null = null;
  const events: Array<{ type: string; message?: string }> = [];
  // Every node's source errors, as the run's state collects them.
  const sourceErrors: Array<{ source: string; code: string; message?: string }> = [];
  const stream = await graph.stream(
    { songQuery: "Ice Ice Baby Vanilla Ice" },
    { configurable: { thread_id: threadId }, streamMode: ["updates", "custom"] },
  );
  for await (const [mode, chunk] of stream as AsyncIterable<[string, unknown]>) {
    if (mode === "custom") {
      events.push(chunk as { type: string });
      continue;
    }
    for (const update of Object.values(chunk as Record<string, unknown>)) {
      const node = (update ?? {}) as { trackData?: TrackData; sourceErrors?: typeof sourceErrors };
      if (node.trackData) trackData = node.trackData;
      sourceErrors.push(...(node.sourceErrors ?? []));
    }
  }
  const stored = (await store.search(TRACKS_NAMESPACE)).length;
  return { llm, trackData: trackData as TrackData | null, events, stored, sourceErrors };
}

const statusLines = (events: ReadonlyArray<{ type: string; message?: string }>) =>
  events.filter((e) => e.type === "status").map((e) => e.message ?? "");

describe("a run whose primary sources fail", () => {
  const html = (body: string) =>
    new Response(body, { status: 200, headers: { "content-type": "text/html" } });

  it("does not take an HTML page for the work for an answer: lost, nothing kept", async () => {
    net = stubFetch((call) =>
      call.url.startsWith(WORK) ? html("<html>challenge</html>") : runRoute(call),
    );
    const { trackData, stored } = await runGraph();

    expect(TrackAnalysis.parse(trackData).run?.sourceErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "musicbrainz", code: "unavailable" }),
      ]),
    );
    expect(stored).toBe(0);
    expect(cache.putResearch).not.toHaveBeenCalled();
  });

  it("does not keep the result when SecondHandSongs answers JSON that does not parse", async () => {
    // A cut or garbled body: passing, not an answer of a shape the reader does not know.
    net = stubFetch((call) =>
      call.url === SHS_WORK
        ? new Response('{"title": "Ice Ice Baby", "versions": [', {
            headers: { "content-type": "application/json" },
          })
        : runRoute(call),
    );
    const { trackData, stored } = await runGraph();

    expect(TrackAnalysis.parse(trackData).run?.sourceErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "secondhandsongs" })]),
    );
    expect(stored).toBe(0);
  });

  it("keeps the result on a research-cache hit past a lasting primary-source error", async () => {
    cache.getResearch.mockReturnValue(await storedRow());
    net = stubFetch((call) =>
      call.url === SHS_WORK ? json({ unexpected: true }) : runRoute(call),
    );
    const { stored } = await runGraph();
    expect(stored).toBe(1);
  });

  it("does not keep the result when SecondHandSongs answers with an HTML page", async () => {
    net = stubFetch((call) =>
      call.url === SHS_WORK ? html("<html>are you a robot?</html>") : runRoute(call),
    );
    const { trackData, stored } = await runGraph();

    expect(TrackAnalysis.parse(trackData).run?.sourceErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "secondhandsongs", code: "unavailable" }),
      ]),
    );
    expect(stored).toBe(0);
  });

  it("says no primary record could be read when MusicBrainz is down", async () => {
    net = stubFetch((call) =>
      call.url.startsWith("https://musicbrainz.org/")
        ? new Response("bad gateway", { status: 502 })
        : runRoute(call),
    );
    const { events } = await runGraph();

    const lines = statusLines(events);
    expect(lines).toContain(
      "📇 Primary sources: none could be read (MusicBrainz could not be read)",
    );
    expect(lines).not.toContain("📇 Primary sources: no record matched the track");
  });

  it("does not keep the result on a research-cache hit when a primary source fails", async () => {
    cache.getResearch.mockReturnValue(await storedRow());
    net = stubFetch((call) =>
      call.url === SHS_WORK ? new Response("busy", { status: 503 }) : runRoute(call),
    );
    const { trackData, stored } = await runGraph();

    expect(TrackAnalysis.parse(trackData).run?.sourceErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "secondhandsongs", code: "unavailable" }),
      ]),
    );
    expect(stored).toBe(0);
  });

  it("serves a result stored past a lasting error with that error reported again", async () => {
    const store = new InMemoryStore();
    net = stubFetch((call) =>
      call.url === SHS_WORK ? json({ unexpected: true }) : runRoute(call),
    );
    const first = await runGraph("run-first", store);
    expect(first.stored).toBe(1);

    // SecondHandSongs answers now, but the stored result is served: it says what it misses.
    net = stubFetch(runRoute);
    const served = await runGraph("run-served", store);

    expect(served.llm.calls).toEqual([]);
    expect(served.trackData?.evidence?.some((e) => e.source === "secondhandsongs")).toBe(false);
    expect(served.sourceErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "secondhandsongs", code: "invalid_response" }),
      ]),
    );
    expect(statusLines(served.events)).toContain(
      "⚠️ Stored result: SecondHandSongs could not be read when it was composed (invalid_response)",
    );
  });

  const WORK = "https://musicbrainz.org/ws/2/work/e0ebb61d-7f69-3667-a2b1-dcd447d80f3d?";

  it("reports the work's covers as missing and keeps neither the result nor the research", async () => {
    net = stubFetch((call) =>
      call.url.startsWith(WORK) ? new Response("busy", { status: 503 }) : runRoute(call),
    );
    const { trackData, events, stored } = await runGraph();

    const result = TrackAnalysis.parse(trackData);
    const lost = result.run?.sourceErrors?.find((e) => e.source === "musicbrainz");
    // MusicBrainz answers 503 when it is over its rate: a passing reason, kept as it was.
    expect(lost).toMatchObject({ source: "musicbrainz", code: "rate_limited" });
    expect(statusLines(events).some((m) => /MusicBrainz records are incomplete/.test(m))).toBe(
      true,
    );
    // MusicBrainz lists no cover of the work, and the run does not pass that off as complete.
    const covers = (e: { source: string; recordRef: string | null }) =>
      e.source === "musicbrainz" && /covered-by/.test(e.recordRef ?? "");
    expect(result.evidence?.some(covers)).toBe(false);
    expect(stored).toBe(0);
    expect(cache.putResearch).not.toHaveBeenCalled();
  });

  it("keeps the result when a primary source answers in a shape its reader does not know", async () => {
    net = stubFetch((call) =>
      call.url === SHS_WORK ? json({ unexpected: true }) : runRoute(call),
    );
    const { trackData, stored } = await runGraph();

    expect(TrackAnalysis.parse(trackData).run?.sourceErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "secondhandsongs", code: "invalid_response" }),
      ]),
    );
    expect(stored).toBe(1);
    expect(cache.putResearch).toHaveBeenCalledTimes(1);
  });

  it("reports a bug in a primary source's reader as an internal error, and keeps nothing", async () => {
    // A performer whose name is not text: the reader fails on it with a TypeError.
    const broken = structuredClone(shsWork) as { versions: Array<{ performer?: unknown }> };
    broken.versions[0].performer = { name: { first: "Vanilla" } };
    net = stubFetch((call) => (call.url === SHS_WORK ? json(broken) : runRoute(call)));
    const { trackData, stored, events } = await runGraph();

    const error = TrackAnalysis.parse(trackData).run?.sourceErrors?.find(
      (e) => e.source === "secondhandsongs",
    );
    expect(error).toMatchObject({ code: "unavailable" });
    expect(error?.message).toMatch(/^internal error: /);
    // The status blames our reader, not the source.
    expect(statusLines(events)).toContain(
      "⚠️ SecondHandSongs: our reader failed on its answer (internal error)",
    );
    expect(stored).toBe(0);
  });

  it("keeps neither the result nor the research when a primary source could not be read", async () => {
    net = stubFetch((call) =>
      call.url === SHS_WORK ? new Response("busy", { status: 503 }) : runRoute(call),
    );
    const { trackData, stored } = await runGraph();

    expect(TrackAnalysis.parse(trackData).run?.sourceErrors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "secondhandsongs", code: "unavailable" }),
      ]),
    );
    expect(stored).toBe(0);
    // The research is cached with its evidence: a source that could not be read blocks it.
    expect(cache.putResearch).not.toHaveBeenCalled();
  });
});

describe("a run whose primary source our own pacing did not ask", () => {
  /** SecondHandSongs held for 120 s by one 429: the pacer refuses its next request. */
  async function holdSecondHandSongs() {
    setUnpacedForTests(false);
    stubFetch((call) =>
      call.url === SHS_WORK
        ? new Response("slow down", { status: 429, headers: { "retry-after": "120" } })
        : undefined,
    );
    await shsRelationships(ICE_TRACK, [{ kind: "work", id: 4196, from: "work" }]);
    net = stubFetch(runRoute);
  }
  afterEach(() => setUnpacedForTests(true));

  it("stores no result from a fresh run, and says the source was not asked", async () => {
    await holdSecondHandSongs();
    const { stored, events, sourceErrors } = await runGraph("run-paced");
    expect(stored).toBe(0);
    expect(sourceErrors.some((e) => e.source === "secondhandsongs")).toBe(false);
    expect(statusLines(events)).toContain(
      "📇 SecondHandSongs not asked: our own pacing of its requests left no time in this run; a later run asks it",
    );
  });

  it("stores no result from a refresh hit that cannot ask it either", async () => {
    const row = await storedRow([{ source: "secondhandsongs", part: "not_asked" }]);
    const evidence = row.evidence as { items: Array<{ source: string }> };
    cache.getResearch.mockReturnValue({
      ...row,
      evidence: {
        ...evidence,
        items: evidence.items.filter((e) => e.source !== "secondhandsongs"),
      },
    });
    await holdSecondHandSongs();
    const { stored, llm } = await runGraph("run-paced-hit");
    expect(llm.calls.filter((c) => c.callSite === "research_planner")).toEqual([]);
    expect(stored).toBe(0);
  });
});

describe("a stubbed run", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "evidence-run-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("gives the composer the pack and stores it with the run; none of its sources is a model", async () => {
    const { llm, trackData, events, stored } = await runGraph();
    // Discogs and Genius are only not configured: the result is kept.
    expect(stored).toBe(1);

    const result = TrackAnalysis.parse(trackData);
    const evidence = result.evidence ?? [];
    expect(evidence.length).toBeGreaterThan(2);
    // The work's covers are there when MusicBrainz answers (see the failing case above).
    expect(
      evidence.some((e) => e.source === "musicbrainz" && /covered-by/.test(e.recordRef ?? "")),
    ).toBe(true);
    expect(events.filter((e) => e.type === "evidence")).toHaveLength(evidence.length);
    // The composer was given the pack, and the song's records are marked as such.
    const composer = llm.calls.find((c) => c.callSite === "composer");
    const { user } = messagesOf(composer as StubCall);
    for (const item of evidence) expect(user).toContain(JSON.stringify(item.id));
    expect(user).toContain('"about":"the song, not this recording"');
    // Its citations of the pack are kept.
    expect(result.claims?.flatMap((c) => c.evidenceIds)).toEqual(
      expect.arrayContaining([RECORDING_ID, WEB_ID]),
    );

    const path = process.env.EVIDENCE_RUN_DB || join(dir, "runs.db");
    const db = new Database(path);
    runMigrations(db);
    startRun(db, { runId: "run-a2", threadId: "run-a2", query: "Ice Ice Baby Vanilla Ice" });
    expect(storeRunResult(db, "run-a2", trackData)).toBe("stored");
    db.close();

    const readonly = new Database(path, { readonly: true });
    const row = readonly.prepare(A2_QUERY).get() as { s: string };
    readonly.close();
    const sources = row.s.split(",");
    expect(new Set(sources)).toEqual(new Set(["musicbrainz", "secondhandsongs", "tavily"]));
    expect(sources).toHaveLength(evidence.length);
    // Every value is one of the contract's sources, none of which is a model.
    for (const source of sources) expect(SourceId.options).toContain(source);
  });
});

describe("concurrent runs on the shared MusicBrainz queue", () => {
  it("keeps the same records when the deadline cuts only the dating of the work's recordings", async () => {
    const baseline = await runGraph("run-alone");
    // The release is read last, on the dating signal: a run whose dating was cut may not name
    // it (a note, not a lost record).
    const isRelease = (id: string) => id.startsWith("musicbrainz:release/");
    const ids = (data: TrackData | null) =>
      (data?.evidence ?? [])
        .map((e) => e.id)
        .filter((id) => !isRelease(id))
        .sort();
    expect((baseline.trackData?.evidence ?? []).filter((e) => isRelease(e.id))).toHaveLength(1);
    cache.putResearch.mockClear();

    // The real spacing between MusicBrainz requests: four runs fill the queue, and the 20 s
    // deadline cuts the dating requests, which come last in each chain.
    const restore = MusicBrainzRateLimiter.getInstance().setIntervalForTests(1100);
    let runs: Awaited<ReturnType<typeof runGraph>>[];
    try {
      runs = await Promise.all(["run-1", "run-2", "run-3", "run-4"].map((id) => runGraph(id)));
    } finally {
      restore();
    }

    const dating = net.calls.filter((c) => c.url.includes("/ws/2/recording?work="));
    const works = net.calls.filter((c) => c.url.includes("/ws/2/work/"));
    expect(works.length).toBeGreaterThanOrEqual(5); // the baseline's and each run's
    expect(dating.length).toBeLessThan(2 * 5); // some dating requests were cut
    for (const run of runs) {
      expect(ids(run.trackData)).toEqual(ids(baseline.trackData));
      expect(run.sourceErrors.some((e) => e.source === "musicbrainz")).toBe(false);
      expect(run.stored).toBe(1);
    }
    expect(cache.putResearch).toHaveBeenCalledTimes(4);
  }, 90_000);
});
