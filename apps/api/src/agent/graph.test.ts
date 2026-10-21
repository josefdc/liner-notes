/**
 * The whole graph (scout → engineer ∥ historian → composer) on the real provider layer, with
 * every source stubbed and the provider answered by a fake Responses API (no network):
 *
 * - a run recorded to cassettes replays exactly from them, with the network denied and another
 *   clock and run id (the prompts hold no time and no generated id);
 * - when every model call fails with 429, the run makes at most MAX_LLM_CALLS_PER_RUN calls,
 *   returns the honest fallback and does not throw (it used to make 12 calls and then fail);
 * - a cancelled run stops the model call in flight;
 * - the composer runs once, after both branches (one list-form fan-in).
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tools = vi.hoisted(() => {
  const tool = (answer: () => string) => ({ invoke: vi.fn(async () => answer()) });
  const track = {
    id: "3Fcfwhm8oRrBvBZ8KGhtea",
    title: "Ice Ice Baby",
    artist: "Vanilla Ice",
    artistIds: ["7GaxyUddsPok8BuhxN6OUW"],
    album: "To the Extreme",
    releaseDate: "1990-09-10",
    coverUrl: "https://i.scdn.co/image/x",
    popularity: 90,
    duration: "4:31",
    durationMs: 271_000,
    explicit: false,
    spotifyUrl: "https://open.spotify.com/track/3Fcfwhm8oRrBvBZ8KGhtea",
    previewUrl: null,
  };
  const none = () => JSON.stringify({ found: false });
  return {
    searchMultipleTracks: tool(() => JSON.stringify([track])),
    analyzeAudioPreview: tool(() =>
      JSON.stringify({ source: "unavailable", reason: "no_preview" }),
    ),
    getLastfmTrackTags: tool(() =>
      JSON.stringify({ found: true, tags: [{ name: "hip hop", count: 100 }] }),
    ),
    getLastfmArtistTags: tool(none),
    getLastfmSimilarTracks: tool(none),
    getLastfmSimilarArtists: tool(none),
    getLastfmArtistInfo: tool(none),
    searchSamples: tool(() => "The bass line comes from Under Pressure by Queen and David Bowie."),
    searchProductionHistory: tool(() => "Recorded in Miami."),
    searchMusicInfo: tool(() => "More history."),
    getMusicBrainzRelations: tool(none),
    getMusicBrainzArtist: tool(none),
    getListenBrainzSimilarArtists: tool(none),
  };
});
vi.mock("../sources/spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/spotify.js")>()),
  searchMultipleTracks: tools.searchMultipleTracks,
}));
vi.mock("../sources/audio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/audio.js")>()),
  analyzeAudioPreview: tools.analyzeAudioPreview,
}));
vi.mock("../sources/lastfm.js", () => ({
  getLastfmTrackTags: tools.getLastfmTrackTags,
  getLastfmArtistTags: tools.getLastfmArtistTags,
  getLastfmSimilarTracks: tools.getLastfmSimilarTracks,
  getLastfmSimilarArtists: tools.getLastfmSimilarArtists,
  getLastfmArtistInfo: tools.getLastfmArtistInfo,
}));
vi.mock("../sources/search.js", () => ({
  searchSamples: tools.searchSamples,
  searchProductionHistory: tools.searchProductionHistory,
  searchMusicInfo: tools.searchMusicInfo,
}));
vi.mock("../sources/musicbrainz.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/musicbrainz.js")>()),
  getMusicBrainzRelations: tools.getMusicBrainzRelations,
  getMusicBrainzArtist: tools.getMusicBrainzArtist,
  lookupIsrc: vi.fn(async () => {
    throw new Error("MusicBrainz must not be called without an ISRC");
  }),
}));
vi.mock("../sources/listenbrainz.js", () => ({
  getListenBrainzSimilarArtists: tools.getListenBrainzSimilarArtists,
}));
vi.mock("../store/cache.js", () => ({
  getCache: () => ({
    getAudio: () => null,
    putAudio: () => {},
    getResearch: () => null,
    putResearch: () => {},
  }),
}));
vi.mock("./enricher.js", () => ({
  enrichGenealogyWithArtwork: async (genealogy: unknown) => genealogy,
}));

import { createLlm, type LlmDependencies } from "../llm/invoke.js";
import {
  errorResponse,
  hang,
  type ProviderCall,
  type ProviderRoute,
  providerFetch,
  responseBody,
  testSettings,
} from "../llm/testing/providerStub.js";
import { buildSonicAgentGraph } from "./graph.js";
import type { TrackData } from "./schema.js";
import { testRuntime } from "./testing/stubLlm.js";

const QUERY = "ice ice baby";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-graph-"));
  writeFileSync(join(dir, "spend.jsonl"), "");
  for (const tool of Object.values(tools)) tool.invoke.mockClear();
  // Every source is stubbed: any other request is a mistake, and fails.
  vi.stubGlobal("fetch", () => {
    throw new Error("network denied");
  });
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The schema a provider request asks for. */
const schemaOf = (call: ProviderCall) =>
  (call.body.text as { format: { name: string } }).format.name;

/** The fake model: plans one Last.fm step, then stops; writes a short composition. */
const answering: ProviderRoute = (call) => {
  if (schemaOf(call) === "ResearchPlanOutput") {
    const user = JSON.stringify(call.body.input);
    const next = user.includes("Planning step 1") ? "search_lastfm_tags" : "done";
    return Response.json(
      responseBody({ nextAction: next, query: null, reasoning: `planned ${next}` }, null),
    );
  }
  return Response.json(
    responseBody(
      {
        claims: [
          {
            text: "The bass line comes from Under Pressure.",
            about: "sample",
            evidenceIds: [],
            field: null,
          },
        ],
        factoids: [
          {
            title: "Borrowed bass",
            text: "The bass line comes from Under Pressure.",
            type: "sample",
            entities: [{ text: "Queen", type: "artist" }],
            evidenceIds: [],
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
          {
            id: "up",
            role: "source",
            label: "Under Pressure - Queen",
            trackTitle: "Under Pressure",
            trackArtist: "Queen",
            year: null,
          },
        ],
        genealogyLinks: [{ source: "up", target: "current", type: "sample", evidenceIds: [] }],
      },
      { input: 900, output: 300, reasoning: 100 },
    ),
  );
};

function llmWith(env: Record<string, string>, deps: Partial<LlmDependencies> = {}) {
  return createLlm({
    settings: testSettings({ LLM_SPEND_LOG: join(dir, "spend.jsonl"), ...env }),
    recordUsage: () => {},
    sleep: async () => {},
    ...deps,
  });
}

interface RunResult {
  trackData: TrackData | null;
  composerRuns: number;
  threw: unknown;
}

/** Runs the graph for QUERY on a fresh checkpointer and store; never throws. */
async function run(
  llm: ReturnType<typeof createLlm>,
  options: { threadId: string; at?: string; signal?: AbortSignal },
): Promise<RunResult> {
  const graph = buildSonicAgentGraph({
    runtime: testRuntime(llm, options.at),
    checkpointer: new MemorySaver(),
    store: new InMemoryStore(),
  });
  const result: RunResult = { trackData: null, composerRuns: 0, threw: null };
  try {
    const stream = await graph.stream(
      { songQuery: QUERY },
      {
        configurable: { thread_id: options.threadId },
        streamMode: "updates",
        signal: options.signal,
      },
    );
    for await (const update of stream) {
      const composer = (update as { composer?: { trackData?: TrackData } }).composer;
      if (composer) {
        result.composerRuns++;
        result.trackData = composer.trackData ?? null;
      }
    }
  } catch (error) {
    result.threw = error;
  }
  return result;
}

describe("the analysis graph", () => {
  it("replays a recorded run from cassettes, with the network denied", async () => {
    const provider = providerFetch(answering);
    const recorder = llmWith(
      { LLM_CASSETTE: "record", LLM_CASSETTE_DIR: join(dir, "cassettes") },
      { fetch: provider.fetch },
    );
    const recorded = await run(recorder, { threadId: "thread-a", at: "2026-03-01T10:00:00.000Z" });

    expect(recorded.threw).toBeNull();
    expect(provider.calls.map(schemaOf)).toEqual([
      "ResearchPlanOutput",
      "ResearchPlanOutput",
      "ComposerOutput",
    ]);
    expect(provider.calls.map((call) => call.body.model)).toEqual([
      "gpt-6-luna",
      "gpt-6-luna",
      "gpt-6-luna",
    ]);
    const cassettes = readdirSync(join(dir, "cassettes"));
    expect(cassettes).toHaveLength(3);
    for (const file of cassettes) {
      expect(readFileSync(join(dir, "cassettes", file), "utf8")).not.toContain(
        "test-fake-azure-key",
      );
    }

    const denied = vi.fn(async () => {
      throw new Error("network denied");
    });
    const replayer = llmWith(
      { LLM_CASSETTE: "replay", LLM_CASSETTE_DIR: join(dir, "cassettes") },
      { fetch: denied as unknown as typeof fetch },
    );
    const replayed = await run(replayer, { threadId: "thread-b", at: "2026-09-09T22:22:22.000Z" });

    expect(replayed.threw).toBeNull();
    expect(denied).not.toHaveBeenCalled();
    expect(replayed.composerRuns).toBe(1);
    const { run: recordedRun, ...recordedData } = recorded.trackData!;
    const { run: replayedRun, ...replayedData } = replayed.trackData!;
    expect(replayedData).toEqual(recordedData);
    expect(replayedRun).toMatchObject({ id: "thread-b", fallback: false });
    expect(recordedRun).toMatchObject({ id: "thread-a", fallback: false });
    expect(replayedData.factoids[0]).toMatchObject({ title: "Borrowed bass" });
    // The research the planner chose ran: Last.fm tags reached the composer.
    expect(tools.getLastfmTrackTags.invoke).toHaveBeenCalled();
  });

  it("makes at most MAX_LLM_CALLS_PER_RUN calls when every call fails with 429, and falls back", async () => {
    const provider = providerFetch(() => errorResponse(429));
    const llm = llmWith({ LLM_CASSETTE: "off" }, { fetch: provider.fetch });

    const result = await run(llm, { threadId: "thread-429" });

    expect(result.threw).toBeNull();
    // The planner's call (its failure ends the research) and the composer's, each tried twice:
    // 4, within the default cap of 12.
    expect(provider.calls.length).toBeLessThanOrEqual(testSettings().maxCallsPerRun);
    expect(provider.calls.map(schemaOf)).toEqual([
      "ResearchPlanOutput",
      "ResearchPlanOutput",
      "ComposerOutput",
      "ComposerOutput",
    ]);
    expect(result.composerRuns).toBe(1);
    expect(result.trackData).toMatchObject({
      modelUnavailable: true,
      modelUnavailableReason: "rate_limited",
      claims: [],
      run: { fallback: true, usage: { llmCalls: 4 } },
    });
    // Built from the sources only: the web research and the Spotify metadata.
    expect(result.trackData?.factoids.map((f) => [f.title, f.content])).toEqual([
      ["Sample Detective", "The bass line comes from Under Pressure by Queen and David Bowie."],
      ["Release Info", 'Released in 1990 on "To the Extreme". Spotify popularity score: 90/100.'],
    ]);
  });

  it("stops at the per-run cap: the composer is refused and falls back", async () => {
    const provider = providerFetch(() => errorResponse(429));
    const llm = llmWith(
      { LLM_CASSETTE: "off", MAX_LLM_CALLS_PER_RUN: "2" },
      { fetch: provider.fetch },
    );

    const result = await run(llm, { threadId: "thread-cap" });

    expect(result.threw).toBeNull();
    expect(provider.calls).toHaveLength(2);
    expect(result.trackData).toMatchObject({
      modelUnavailable: true,
      modelUnavailableReason: "budget_exhausted",
      run: { fallback: true },
    });
  });

  it("stops the model call in flight when the run is cancelled", async () => {
    const controller = new AbortController();
    const provider = providerFetch((call, index) => {
      if (schemaOf(call) !== "ComposerOutput") return answering(call, index);
      setTimeout(() => controller.abort(), 0);
      return hang(call);
    });
    const llm = llmWith({ LLM_CASSETTE: "off" }, { fetch: provider.fetch });

    const result = await run(llm, { threadId: "thread-abort", signal: controller.signal });

    const composerCall = provider.calls.find((call) => schemaOf(call) === "ComposerOutput");
    expect(composerCall?.signal?.aborted).toBe(true);
    expect(result.threw).not.toBeNull();
    expect(result.trackData).toBeNull();
    expect(provider.calls.filter((call) => schemaOf(call) === "ComposerOutput")).toHaveLength(1);
  });

  it("stops a research planner call in flight when the run is cancelled", async () => {
    const controller = new AbortController();
    const provider = providerFetch((call) => {
      setTimeout(() => controller.abort(), 0);
      return hang(call);
    });
    const llm = llmWith({ LLM_CASSETTE: "off" }, { fetch: provider.fetch });

    const result = await run(llm, { threadId: "thread-abort-plan", signal: controller.signal });

    expect(provider.calls.map(schemaOf)).toEqual(["ResearchPlanOutput"]);
    expect(provider.calls[0].signal?.aborted).toBe(true);
    expect(result.trackData).toBeNull();
    // The historian stops too: no fallback searches after the run was cancelled.
    expect(tools.searchSamples.invoke).toHaveBeenCalledTimes(1);
    expect(tools.getMusicBrainzRelations.invoke).not.toHaveBeenCalled();
  });

  it("joins the two branches with one list-form edge", () => {
    const graph = buildSonicAgentGraph({ runtime: testRuntime(llmWith({})) });
    const joins = Object.keys(graph.channels).filter((name) => name.startsWith("join:"));
    expect(joins).toEqual(["join:engineer+historian:composer"]);
  });
});
