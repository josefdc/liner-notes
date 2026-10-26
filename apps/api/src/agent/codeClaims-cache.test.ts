/**
 * Code-built links on a research-cache hit: two runs of the whole graph on one SQLite research
 * cache, the second served from it, with the primary sources answered from the captured
 * fixtures and the model layer answered by a stub (no network, no spend).
 */

import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import {
  analysisIssues,
  linkDisplayKind,
  resultContext,
  TrackAnalysis,
} from "@liner-notes/contract";
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
    spotifySearch: tool(() => JSON.stringify([track])),
    analyzeAudioPreview: tool(() =>
      JSON.stringify({ source: "unavailable", reason: "no_preview" }),
    ),
    lastfm: tool(none),
    search: tool(none),
  };
});
vi.mock("../sources/spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/spotify.js")>()),
  searchTracks: async (query: string, limit: number, signal?: AbortSignal) =>
    JSON.parse(await tools.spotifySearch.invoke({ query, limit }, { signal })),
}));
vi.mock("../sources/audio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/audio.js")>()),
  resolvePreview: async () => ({
    previewUrl: null,
    match: null,
    detail: "No preview in this test",
  }),
  audioServiceHealth: async () => null,
  analyzeAudioPreview: tools.analyzeAudioPreview,
}));
vi.mock("../sources/lastfm.js", () => ({
  lastfmConfigured: () => true,
  getLastfmTrackTags: tools.lastfm,
  getLastfmArtistTags: tools.lastfm,
  getLastfmSimilarTracks: tools.lastfm,
  getLastfmSimilarArtists: tools.lastfm,
  getLastfmArtistInfo: tools.lastfm,
}));
vi.mock("../sources/search.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/search.js")>()),
  tavilyConfigured: () => true,
  searchSamples: tools.search,
  searchProductionHistory: tools.search,
  searchMusicInfo: tools.search,
}));
vi.mock(
  "./enricher.js",
  () =>
    ({
      enrichGenealogyWithArtwork: async (genealogy) => ({
        nodes: (genealogy?.nodes ?? []).map(({ id }) => ({ id })),
        complete: true,
      }),
    }) satisfies Partial<typeof import("./enricher.js")>,
);

import Database from "better-sqlite3";
import { MusicBrainzRateLimiter } from "../sources/musicbrainz.js";
import { type FetchCall, stubFetch } from "../sources/testing/fetchStub.js";
import { runRoute } from "../sources/testing/iceIceBaby.js";
import { initCache } from "../store/cache.js";
import { runMigrations } from "../store/migrations.js";
import { buildSonicAgentGraph } from "./graph.js";
import type { TrackData } from "./schema.js";
import { stubLlm, testRuntime } from "./testing/stubLlm.js";

const UNDER_PRESSURE = "32c7e292-14f1-4080-bddf-ef852e0a4c59";

/** The model: the planner stops, the composer writes no notes, the judge is not asked. */
const model = () =>
  stubLlm((call) =>
    call.callSite === "research_planner"
      ? { nextAction: "done", query: null, reasoning: "enough for this track" }
      : {
          claims: [],
          factoids: [],
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
        },
  );

let restoreInterval: () => void;
beforeAll(() => {
  restoreInterval = MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
});
afterAll(() => restoreInterval());

let db: Database.Database;
let calls: FetchCall[];
beforeEach(() => {
  for (const name of ["DISCOGS_TOKEN", "GENIUS_ACCESS_TOKEN", "SHS_API_KEY", "SOURCE_CASSETTE"]) {
    delete process.env[name];
  }
  db = new Database(":memory:");
  runMigrations(db);
  initCache(db);
  calls = stubFetch(runRoute).calls;
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** One run of the whole graph with a long-term store of its own: its one result. */
async function analyse(threadId: string): Promise<TrackData> {
  const graph = buildSonicAgentGraph({
    runtime: testRuntime(model(), "2026-10-20T12:00:00.000Z"),
    checkpointer: new MemorySaver(),
    store: new InMemoryStore(),
  });
  const complete: TrackData[] = [];
  const stream = await graph.stream(
    { songQuery: "Ice Ice Baby Vanilla Ice" },
    { configurable: { thread_id: threadId }, streamMode: ["custom"] },
  );
  for await (const [, event] of stream as AsyncIterable<
    [string, { type: string; data?: unknown }]
  >) {
    if (event.type === "complete") complete.push(event.data as TrackData);
  }
  expect(complete).toHaveLength(1);
  return complete[0];
}

const codeSample = (result: TrackData) =>
  result.genealogy.links.find(
    (link) => link.origin === "code" && link.source === `mb-${UNDER_PRESSURE}`,
  );

describe("code-built links from cached research", () => {
  it("are drawn again by a run served from the research cache, which asks no primary source", async () => {
    const first = await analyse("cache-first");
    expect(codeSample(first)).toMatchObject({ type: "sample", kind: "sourced" });

    const before = calls.length;
    const second = await analyse("cache-second");
    const asked = calls
      .slice(before)
      .filter((call) => /^https:\/\/(musicbrainz\.org|secondhandsongs\.com)\//.test(call.url));
    expect(asked).toEqual([]);
    expect(codeSample(second)).toEqual(codeSample(first));
    expect(linkDisplayKind(codeSample(second)!, resultContext(TrackAnalysis.parse(second)))).toBe(
      "sourced",
    );
    expect(analysisIssues(TrackAnalysis.parse(second))).toEqual([]);
  });
});
