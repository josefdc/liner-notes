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
import { Command, InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { analysisIssues, claimIsRejected, runIssues, TrackAnalysis } from "@liner-notes/contract";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { captureLogsForTests } from "../logger.js";

const tools = vi.hoisted(() => {
  const tool = (answer: () => string) => ({
    invoke: vi.fn(async (..._args: unknown[]) => answer()),
  });
  const track = {
    id: "3Fcfwhm8oRrBvBZ8KGhtea",
    title: "Ice Ice Baby",
    artist: "Vanilla Ice",
    artistIds: ["7GaxyUddsPok8BuhxN6OUW"],
    album: "To the Extreme",
    releaseDate: "1990-09-10",
    coverUrl: "https://i.scdn.co/image/x",
    duration: "4:31",
    durationMs: 271_000,
    explicit: false,
    spotifyUrl: "https://open.spotify.com/track/3Fcfwhm8oRrBvBZ8KGhtea",
    previewUrl: null,
  };
  const none = () => JSON.stringify({ found: false });
  // A web search with one result.
  const web = (content: string) =>
    JSON.stringify({
      found: true,
      results: [{ title: "Page", url: "https://example.test/", content }],
    });
  return {
    spotifySearch: tool(() => JSON.stringify([track])),
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
    searchSamples: tool(() =>
      web("The bass line comes from Under Pressure by Queen and David Bowie."),
    ),
    searchProductionHistory: tool(() => web("Recorded in Miami.")),
    searchMusicInfo: tool(() => web("More history.")),
    getMusicBrainzRelations: tool(none),
    getMusicBrainzArtist: tool(none),
    getListenBrainzSimilarArtists: tool(none),
  };
});
// The scout's search: the stub answers as the tool would, and the client gives its tracks.
vi.mock("../sources/spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/spotify.js")>()),
  searchTracks: async (query: string, limit: number, signal?: AbortSignal) =>
    JSON.parse(await tools.spotifySearch.invoke({ query, limit }, { signal })),
}));
vi.mock("../sources/audio.js", async (importOriginal) => {
  const audio = await importOriginal<typeof import("../sources/audio.js")>();
  hooks.audio = audio;
  return {
    ...audio,
    // The engineer's own preview lookup and health probe (the analysis itself is stubbed).
    resolvePreview: async (...args: Parameters<typeof audio.resolvePreview>) => {
      hooks.onPreview?.();
      if (hooks.realPreview) return audio.resolvePreview(...args);
      return { previewUrl: null, match: null, detail: "No preview in this test" };
    },
    audioServiceHealth: async () => null,
    analyzeAudioPreview: tools.analyzeAudioPreview,
  };
});
vi.mock("../sources/lastfm.js", () => ({
  lastfmConfigured: () => true,
  getLastfmTrackTags: tools.getLastfmTrackTags,
  getLastfmArtistTags: tools.getLastfmArtistTags,
  getLastfmSimilarTracks: tools.getLastfmSimilarTracks,
  getLastfmSimilarArtists: tools.getLastfmSimilarArtists,
  getLastfmArtistInfo: tools.getLastfmArtistInfo,
}));
vi.mock("../sources/search.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/search.js")>()),
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
const hooks = vi.hoisted(() => ({
  /** Replaces the artwork enricher when set. */
  enrich: null as
    | null
    | ((answer: { nodes: Array<{ id: string }>; complete: boolean }) => Promise<{
        nodes: Array<{ id: string }>;
        complete: boolean;
      }>),
  putAudio: vi.fn(),
  putResearch: vi.fn(),
  /** Called when the engineer looks up the track's preview. */
  onPreview: null as null | (() => void),
  /** When set, the engineer's preview lookup is the real one (Deezer through its pacer). */
  realPreview: false,
  /** The real audio module, for the tests that run its lookup and analysis tool. */
  audio: null as null | typeof import("../sources/audio.js"),
}));
vi.mock("../store/cache.js", () => ({
  getCache: () => ({
    getAudio: () => null,
    getNewestAudio: () => null,
    putAudio: hooks.putAudio,
    getResearch: () => null,
    putResearch: hooks.putResearch,
  }),
}));
vi.mock(
  "./enricher.js",
  () =>
    ({
      enrichGenealogyWithArtwork: async (genealogy) => {
        const answer = {
          nodes: (genealogy?.nodes ?? []).map(({ id }) => ({ id })),
          complete: true,
        };
        return hooks.enrich ? hooks.enrich(answer) : answer;
      },
    }) satisfies Partial<typeof import("./enricher.js")>,
);

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
import { TRACKS_NAMESPACE } from "./cacheKeys.js";
import { buildSonicAgentGraph } from "./graph.js";
import { engineerNode } from "./nodes/engineerNode.js";
import type { SonicAgentStateType } from "./state.js";
import type { TrackData } from "./schema.js";
import { TransientError } from "./errors.js";
import { DEEZER_MAX_PER_WINDOW, deezerPreviewByIsrc } from "../sources/deezer.js";
import { SourceError } from "../sources/http.js";
import { setUnpacedForTests } from "../sources/pacing.js";
import { failureWith, toolFailure } from "../sources/toolResult.js";
import { ANALYZER_VERSION, audioV2, keyWithheldV2 } from "./testing/measuredAudio.js";
import { type StubCall, stubLlm, testRuntime } from "./testing/stubLlm.js";
import { statementsIn } from "./verifier/testing.js";

// The web's query names the artist: a title alone always asks which recording is meant.
const QUERY = "Ice Ice Baby Vanilla Ice";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-graph-"));
  writeFileSync(join(dir, "spend.jsonl"), "");
  for (const tool of Object.values(tools)) tool.invoke.mockClear();
  hooks.enrich = null;
  hooks.onPreview = null;
  hooks.realPreview = false;
  hooks.putAudio.mockClear();
  hooks.putResearch.mockClear();
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
            scope: "recording",
          },
        ],
        factoids: [
          {
            title: "Borrowed bass",
            text: "The bass line comes from Under Pressure.",
            type: "sample",
            entities: [{ text: "Queen", type: "artist" }],
            evidenceIds: [],
            scope: "recording",
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
        genealogyLinks: [
          { source: "up", target: "current", type: "sample", evidenceIds: [], scope: "recording" },
        ],
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
      const nodes = update as {
        composer?: { trackData?: TrackData };
        verifier?: { trackData?: TrackData };
      };
      if (nodes.composer) {
        result.composerRuns++;
        // The composer hands the verifier a draft; it never sends the result itself.
        expect(nodes.composer.trackData).toBeUndefined();
      }
      if (nodes.verifier) result.trackData = nodes.verifier.trackData ?? null;
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
      {
        fetch: provider.fetch,
        now: () => new Date("2026-03-01T10:00:00.000Z"),
        commit: () => "abc123def456",
      },
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
    // Only the model's answers are replayed: the sources were read again, so each run's
    // evidence says it was retrieved at that run's time.
    const retrieved = (data: typeof recordedData) => data.evidence?.map((e) => e.retrievedAt);
    expect(recordedData.evidence?.length).toBeGreaterThan(0);
    expect(new Set(retrieved(recordedData))).toEqual(new Set(["2026-03-01T10:00:00.000Z"]));
    expect(new Set(retrieved(replayedData))).toEqual(new Set(["2026-09-09T22:22:22.000Z"]));
    const undated = (data: typeof recordedData) => ({
      ...data,
      evidence: data.evidence?.map(({ retrievedAt: _at, ...item }) => item),
    });
    expect(undated(replayedData)).toEqual(undated(recordedData));
    // Answers from cassettes make a replayed run; the recording run called the provider.
    expect(replayedRun).toMatchObject({ id: "thread-b", fallback: false, mode: "replay" });
    expect(recordedRun).toMatchObject({ id: "thread-a", fallback: false, mode: "live" });
    // The replay says when and from which commit its answers were recorded, and that only the
    // model's answers were replayed: it passes the contract's run rules, as the live run does.
    expect(replayedRun).toMatchObject({
      replayed: "model_answers",
      recordedAt: "2026-03-01T10:00:00.000Z",
      commit: "abc123def456",
    });
    expect(runIssues(replayedRun!, undefined)).toEqual([]);
    expect(recordedRun).toMatchObject({ recordedAt: null, commit: null });
    expect(recordedRun).not.toHaveProperty("replayed");
    expect(runIssues(recordedRun!, undefined)).toEqual([]);
    expect(TrackAnalysis.safeParse(replayed.trackData).success).toBe(true);

    // Cassettes written before they kept when and where: the run cannot say either, and says
    // nothing in their place.
    for (const file of readdirSync(join(dir, "cassettes"))) {
      const path = join(dir, "cassettes", file);
      const { recordedAt: _at, commit: _commit, ...older } = JSON.parse(readFileSync(path, "utf8"));
      writeFileSync(path, JSON.stringify(older));
    }
    const logs = captureLogsForTests();
    onTestFinished(() => logs.restore());
    const unknown = await run(replayer, { threadId: "thread-c", at: "2026-09-09T22:22:22.000Z" });
    expect(unknown.trackData?.run).toMatchObject({
      mode: "replay",
      replayed: "model_answers",
      recordedAt: null,
      commit: null,
    });
    expect(logs.messages("warn").join("\n")).toMatch(
      /run information breaks the contract's run rules/,
    );
    expect(replayedData.factoids[0]).toMatchObject({ title: "Borrowed bass" });
    // The research the planner chose ran: Last.fm tags reached the composer.
    expect(tools.getLastfmTrackTags.invoke).toHaveBeenCalled();
  });

  it("replays the verifier's judge from its cassette: the same verdicts, with the network denied", async () => {
    const SUPPORTED = "The bass line comes from Under Pressure by Queen and David Bowie.";
    const CONTRADICTED = "Ice Ice Baby was first released in 1975.";
    // The composer cites the first item of the evidence pack it is shown; the judge supports
    // the sample and contradicts the date.
    const judged: ProviderRoute = (call, index) => {
      if (schemaOf(call) === "JudgeOutput") {
        const verdicts = statementsIn(call.body.input).map(({ claimId, text }) => ({
          claimId,
          verdict: text === CONTRADICTED ? "contradicted" : "supported",
          reason:
            text === CONTRADICTED ? "The page dates it 1990." : "The page names the bass line.",
        }));
        return Response.json(responseBody({ verdicts }, { input: 600, output: 80 }));
      }
      if (schemaOf(call) !== "ComposerOutput") return answering(call, index);
      const pack = JSON.stringify(call.body.input)
        .split("<<<SOURCE evidence pack>>>")[1]
        ?.split("<<<END SOURCE>>>")[0];
      const [cited] = [...(pack ?? "").matchAll(/\\"id\\":\\"([^\\]+)\\"/g)].map((m) => m[1]);
      if (!cited) throw new Error("the composer was shown no evidence");
      const claim = (text: string, about: string) => ({
        text,
        about,
        evidenceIds: [cited],
        field: null,
        scope: "recording",
      });
      return Response.json(
        responseBody(
          {
            claims: [claim(SUPPORTED, "sample"), claim(CONTRADICTED, "history")],
            factoids: [],
            genealogyNodes: [],
            genealogyLinks: [],
          },
          { input: 900, output: 300 },
        ),
      );
    };
    const provider = providerFetch(judged);
    const recorder = llmWith(
      { LLM_CASSETTE: "record", LLM_CASSETTE_DIR: join(dir, "cassettes") },
      { fetch: provider.fetch, commit: () => "abc123def456" },
    );
    const recorded = await run(recorder, { threadId: "judge-a", at: "2026-03-01T10:00:00.000Z" });

    expect(recorded.threw).toBeNull();
    expect(provider.calls.map(schemaOf)).toEqual([
      "ResearchPlanOutput",
      "ResearchPlanOutput",
      "ComposerOutput",
      "JudgeOutput",
    ]);
    const cassettes = readdirSync(join(dir, "cassettes"));
    expect(cassettes.filter((file) => file.startsWith("JudgeOutput.judge."))).toHaveLength(1);
    expect(cassettes).toHaveLength(4);

    const denied = vi.fn(async () => {
      throw new Error("network denied");
    });
    const replayer = llmWith(
      { LLM_CASSETTE: "replay", LLM_CASSETTE_DIR: join(dir, "cassettes") },
      { fetch: denied as unknown as typeof fetch },
    );
    const replayed = await run(replayer, { threadId: "judge-b", at: "2026-09-09T22:22:22.000Z" });

    expect(replayed.threw).toBeNull();
    expect(denied).not.toHaveBeenCalled();
    expect(replayed.trackData?.run).toMatchObject({ mode: "replay", replayed: "model_answers" });
    const verdicts = (data: TrackData | null) =>
      (data?.claims ?? [])
        .filter((claim) => claim.origin === "model")
        .map(({ text, verdict, verdictReason, kind }) => ({ text, verdict, verdictReason, kind }));
    // The recording judged both claims; the replay gives the same verdicts and reasons.
    expect(verdicts(recorded.trackData)).toEqual([
      {
        text: SUPPORTED,
        verdict: "supported",
        verdictReason: "The page names the bass line.",
        kind: "sourced",
      },
      {
        text: CONTRADICTED,
        verdict: "contradicted",
        verdictReason: "The page dates it 1990.",
        kind: "inferred",
      },
    ]);
    expect(verdicts(replayed.trackData)).toEqual(verdicts(recorded.trackData));
    // The replayed contradiction is a rejected claim, as the live one was; the supported is not.
    const replayedClaim = (text: string) =>
      replayed.trackData?.claims?.find((claim) => claim.text === text);
    expect(claimIsRejected(replayedClaim(CONTRADICTED)!)).toBe(true);
    expect(claimIsRejected(replayedClaim(SUPPORTED)!)).toBe(false);
    expect(replayed.trackData?.run?.verifier).toEqual({ judged: 2, unjudged: 0 });
    expect(replayed.trackData?.run?.verifier).toEqual(recorded.trackData?.run?.verifier);
    // The judge's answer came from the cassette, recorded at the recording's commit: no spend.
    expect(replayed.trackData?.run).toMatchObject({
      commit: "abc123def456",
      usage: { llmCalls: 4, usd: 0 },
    });
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
    // Built from primary records only: the web hit about the bass line is not shown.
    expect(result.trackData?.factoids.map((f) => [f.title, f.content])).toEqual([
      ["Release Info", 'Released in 1990 on "To the Extreme".'],
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

  it("gives no node a retry policy: retries happen once, inside the nodes", () => {
    const graph = buildSonicAgentGraph({ runtime: testRuntime(llmWith({})) });
    for (const name of ["scout", "clarification", "engineer", "historian", "composer"] as const) {
      expect(graph.nodes[name].retryPolicy, name).toBeUndefined();
    }
  });

  it("joins the two branches with one list-form edge", () => {
    const graph = buildSonicAgentGraph({ runtime: testRuntime(llmWith({})) });
    const joins = Object.keys(graph.channels).filter((name) => name.startsWith("join:"));
    expect(joins).toEqual(["join:engineer+historian:composer"]);
  });
});

// =============================================================================
// Failures, cancellation and run identity (on a stub model layer)
// =============================================================================

const COMPOSITION = {
  claims: [],
  factoids: [
    {
      title: "Borrowed bass",
      text: "From a record.",
      type: "sample",
      entities: [],
      evidenceIds: [],
      scope: "recording",
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

/** A model layer that composes COMPOSITION and plans `steps`, then "done". */
function stubModel(steps: string[], planner?: (call: StubCall) => unknown) {
  return stubLlm((call) => {
    if (call.callSite === "composer") return COMPOSITION;
    if (planner) return planner(call);
    const step = Number(JSON.stringify(call.input).match(/Planning step (\d+)/)?.[1] ?? 1);
    const next = steps[step - 1] ?? "done";
    return { nextAction: next, query: null, reasoning: `planned ${next}` };
  });
}

interface Driven {
  threw: unknown;
  events: Array<Record<string, unknown>>;
  state: Record<string, unknown> & { trackData?: TrackData | null };
}

/** Runs the graph with `streamMode` updates and custom events; never throws. */
async function drive(
  llm: ReturnType<typeof stubLlm>,
  options: {
    threadId?: string;
    signal?: AbortSignal;
    store?: InMemoryStore;
    at?: string;
    query?: string;
    /** Run on this checkpointer; with `resume`, resume its paused thread with that track id. */
    checkpointer?: MemorySaver;
    resume?: string;
  } = {},
): Promise<Driven> {
  const checkpointer = options.checkpointer ?? (options.threadId ? new MemorySaver() : undefined);
  const graph = buildSonicAgentGraph({
    runtime: testRuntime(llm, options.at),
    ...(checkpointer ? { checkpointer } : {}),
    store: options.store ?? new InMemoryStore(),
  });
  const events: Array<Record<string, unknown>> = [];
  let threw: unknown = null;
  let state: Driven["state"] = {};
  try {
    const stream = await graph.stream(
      options.resume
        ? new Command({ resume: options.resume })
        : { songQuery: options.query ?? QUERY },
      {
        ...(options.threadId ? { configurable: { thread_id: options.threadId } } : {}),
        streamMode: ["values", "custom"],
        signal: options.signal,
      },
    );
    for await (const [mode, data] of stream as AsyncIterable<[string, Record<string, unknown>]>) {
      if (mode === "custom") events.push(data);
      else state = data;
    }
  } catch (error) {
    threw = error;
  }
  return { threw, events, state };
}

describe("the analysis graph under failure", () => {
  it("caches research when a source is only not configured, and stores that with it", async () => {
    const missing = async () =>
      JSON.stringify(failureWith("not_configured", "Last.fm is not configured"));
    for (const tool of [
      tools.getLastfmTrackTags,
      tools.getLastfmArtistTags,
      tools.getLastfmSimilarTracks,
    ]) {
      tool.invoke.mockImplementationOnce(missing);
    }

    const { threw, state } = await drive(stubModel(["done"]), { threadId: "t-no-key" });

    expect(threw).toBeNull();
    expect(state.trackData?.run?.sourceErrors).toEqual([
      expect.objectContaining({ source: "lastfm", code: "not_configured" }),
    ]);
    expect(hooks.putResearch).toHaveBeenCalledTimes(1);
    const [key, research] = hooks.putResearch.mock.calls[0] as [string, Record<string, unknown>];
    expect(key).toMatch(/^v4:3Fcfwhm8oRrBvBZ8KGhtea:lastfm=1:tavily=[01]:discogs=0:genius=0$/);
    expect(research.notConfigured).toEqual([
      expect.objectContaining({ source: "lastfm", code: "not_configured" }),
    ]);
  });

  it("does not cache research when a source failed for a passing reason", async () => {
    tools.getMusicBrainzRelations.invoke.mockImplementationOnce(async () =>
      JSON.stringify(toolFailure(new SourceError("musicbrainz", "timeout", "no answer"))),
    );

    const { threw, state } = await drive(stubModel(["search_musicbrainz", "done"]), {
      threadId: "t-timeout",
    });

    expect(threw).toBeNull();
    expect(state.trackData?.run?.sourceErrors).toEqual([
      expect.objectContaining({ source: "musicbrainz", code: "timeout" }),
    ]);
    expect(hooks.putResearch).not.toHaveBeenCalled();
  });

  it("keeps the planner's calls and reports the source when a search keeps failing", async () => {
    tools.searchProductionHistory.invoke.mockImplementation(async () => {
      throw new TransientError("search 503", 503);
    });
    const llm = stubModel(["search_production", "done"]);

    const { threw, state } = await drive(llm, { threadId: "t-search" });

    expect(threw).toBeNull();
    const run = state.trackData?.run;
    expect((state.usage as Array<{ callSite: string }>).map((u) => u.callSite)).toEqual([
      "research_planner",
      "research_planner",
      "composer",
    ]);
    expect(run?.usage).toMatchObject({ llmCalls: 3, inputTokens: 300 });
    expect(run?.sourceErrors).toEqual([expect.objectContaining({ source: "tavily" })]);
    // One retry of the failing search, and nothing searched twice.
    expect(tools.searchProductionHistory.invoke).toHaveBeenCalledTimes(2);
    expect(tools.searchSamples.invoke).toHaveBeenCalledTimes(1);
    expect(tools.getMusicBrainzRelations.invoke).not.toHaveBeenCalled();
    tools.searchProductionHistory.invoke.mockReset();
    tools.searchProductionHistory.invoke.mockImplementation(async () =>
      JSON.stringify({
        found: true,
        results: [{ title: "Page", url: "https://example.test/", content: "Recorded in Miami." }],
      }),
    );
  });

  it("fails the run on a planner bug instead of hiding it", async () => {
    const llm = stubModel([], () => {
      throw new TypeError("cannot read properties of undefined (planner bug)");
    });

    const { threw, state } = await drive(llm, { threadId: "t-bug" });

    expect(threw).toBeInstanceOf(TypeError);
    expect(state.trackData ?? null).toBeNull();
    expect(llm.calls.map((call) => call.callSite)).toEqual(["research_planner"]);
  });

  it("stores and reports nothing when the run is cancelled during artwork enrichment", async () => {
    const controller = new AbortController();
    let release: () => void = () => {};
    hooks.enrich = (genealogy) =>
      new Promise((resolve) => {
        release = () => resolve(genealogy);
        controller.abort();
      });
    const store = new InMemoryStore();

    const { threw, events } = await drive(stubModel(["done"]), {
      threadId: "t-enrich",
      signal: controller.signal,
      store,
    });
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(threw).not.toBeNull();
    expect(await store.search(["tracks"])).toEqual([]);
    expect(events.filter((event) => event.type === "complete")).toEqual([]);
  });

  it("passes the run's signal to the scout and the audio analysis, and caches no audio after a cancel", async () => {
    const controller = new AbortController();
    let audioSignal: AbortSignal | undefined;
    tools.analyzeAudioPreview.invoke.mockImplementationOnce(async (...args: unknown[]) => {
      audioSignal = (args[1] as { signal?: AbortSignal } | undefined)?.signal;
      controller.abort();
      return JSON.stringify({ source: "analyzed", audio: audioV2() });
    });

    const { threw } = await drive(stubModel(["done"]), {
      threadId: "t-audio",
      signal: controller.signal,
    });

    expect(threw).not.toBeNull();
    expect(audioSignal?.aborted).toBe(true);
    expect(hooks.putAudio).not.toHaveBeenCalled();
    expect(hooks.putResearch).not.toHaveBeenCalled();
    const scoutOptions = tools.spotifySearch.invoke.mock.calls[0] as unknown[];
    expect((scoutOptions[1] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it("starts no audio analysis once the run is cancelled", async () => {
    const controller = new AbortController();
    // The client leaves while the engineer looks up the preview.
    hooks.onPreview = () => controller.abort();
    const runtime = testRuntime(stubModel(["done"]));
    const state = {
      spotifyData: { id: "x", title: "T", artist: "A", previewUrl: null },
    } as unknown as SonicAgentStateType;

    await expect(
      engineerNode(state, { writer: () => {}, signal: controller.signal } as never, runtime),
    ).rejects.toThrow();
    expect(tools.analyzeAudioPreview.invoke).not.toHaveBeenCalled();
  });

  it("stamps every status event with the runtime's clock", async () => {
    const { events } = await drive(stubModel(["search_lastfm_tags"]), {
      threadId: "t-clock",
      at: "2020-02-02T02:02:02.000Z",
    });

    const stamped = events.filter((event) => event.timestamp !== undefined);
    expect(new Set(stamped.map((event) => event.node))).toEqual(
      new Set([
        "scout",
        "engineer",
        "historian",
        "research_manager",
        "research_tool",
        "composer",
        "verifier",
      ]),
    );
    for (const event of stamped) expect(event.timestamp).toBe("2020-02-02T02:02:02.000Z");
  });

  it("counts every model call of a run under one run id, even without a thread", async () => {
    const llm = stubModel(["search_lastfm_tags", "done"]);

    const { state } = await drive(llm);

    const runIds = new Set(llm.calls.map((call) => call.options.runId));
    expect(llm.calls).toHaveLength(3);
    expect(runIds.size).toBe(1);
    expect(state.trackData?.run).toMatchObject({ id: [...runIds][0], usage: { llmCalls: 3 } });
  });

  it("sends the engineer's clip of the chosen recording to the player with how it was matched", async () => {
    const clip = "https://cdnt-preview.dzcdn.net/api/1/1/a/b/0/c.mp3?hdnea=exp=1~hmac=x";
    tools.analyzeAudioPreview.invoke.mockImplementationOnce(async () =>
      JSON.stringify({
        source: "analyzed",
        audio: audioV2(),
        previewUrl: clip,
        previewMatch: { provider: "deezer", method: "isrc", deezerId: 3366332, score: null },
      }),
    );

    const { events } = await drive(stubModel(["done"]), { threadId: "t-preview" });

    const request = tools.analyzeAudioPreview.invoke.mock.calls[0] as unknown[];
    expect(request[0]).toMatchObject({ title: "Ice Ice Baby", durationMs: 271_000 });
    const complete = events.find((event) => event.type === "complete") as
      | { data: { previewUrl?: string; preview?: unknown } }
      | undefined;
    expect(complete?.data.previewUrl).toBe(clip);
    expect(complete?.data.preview).toEqual({ provider: "deezer", method: "isrc", score: null });
    // The measurement reaches the result through the graph, finalised by code.
    const result = TrackAnalysis.parse(complete?.data);
    expect(result.audio).toEqual(audioV2());
    expect(result).toMatchObject({ bpm: 116, key: "D Minor", audioSource: "analyzed" });
    expect(result.run?.analyzerVersion).toBe(ANALYZER_VERSION);
    expect(analysisIssues(result)).toEqual([]);
  });
});

describe("the analysis graph's stored results", () => {
  const TRACK_ID = "3Fcfwhm8oRrBvBZ8KGhtea";
  const complete = (events: Driven["events"]) =>
    events.find((event) => event.type === "complete") as { data: TrackData } | undefined;

  it("serves the result stored for a track to a run whose text finds that track", async () => {
    const store = new InMemoryStore();
    const first = await drive(stubModel(["done"]), { store });
    expect(complete(first.events)?.data.id).toBe(TRACK_ID);
    expect(tools.analyzeAudioPreview.invoke).toHaveBeenCalledTimes(1);

    // Other words for the same song: the search finds the same track.
    const llm = stubModel(["done"]);
    const second = await drive(llm, { store, query: "vanilla ice - ice ice baby" });

    expect(second.threw).toBeNull();
    expect(llm.calls).toEqual([]);
    expect(tools.analyzeAudioPreview.invoke).toHaveBeenCalledTimes(1);
    expect(tools.spotifySearch.invoke).toHaveBeenCalledTimes(2);
    const served = complete(second.events)?.data;
    expect(served).toMatchObject({ id: TRACK_ID, queryMatch: "exact" });
    expect(served).not.toHaveProperty("run");
  });

  it("serves the result stored for the track the user picks, and analyses nothing", async () => {
    const store = new InMemoryStore();
    await drive(stubModel(["done"]), { store });
    tools.analyzeAudioPreview.invoke.mockClear();

    // A title alone: the user is asked which recording is meant, and picks the stored one.
    const checkpointer = new MemorySaver();
    const threadId = "t-pick";
    const asked = await drive(stubModel(["done"]), {
      store,
      checkpointer,
      threadId,
      query: "Ice Ice Baby",
    });
    expect(asked.events.some((event) => event.type === "candidates")).toBe(true);
    expect(complete(asked.events)).toBeUndefined();

    const llm = stubModel(["done"]);
    const picked = await drive(llm, { store, checkpointer, threadId, resume: TRACK_ID });

    expect(picked.threw).toBeNull();
    expect(complete(picked.events)?.data).toMatchObject({ id: TRACK_ID, queryMatch: "exact" });
    expect(tools.analyzeAudioPreview.invoke).not.toHaveBeenCalled();
    expect(llm.calls).toEqual([]);
  });

  it("does not store a picked track's result built without its details, and composes it again later", async () => {
    const store = new InMemoryStore();
    const checkpointer = new MemorySaver();
    const threadId = "t-degraded";
    await drive(stubModel(["done"]), { store, checkpointer, threadId, query: "Ice Ice Baby" });

    // The details lookup fails (the network is denied): the run goes on with the candidate.
    const picked = await drive(stubModel(["done"]), {
      store,
      checkpointer,
      threadId,
      resume: TRACK_ID,
    });

    const result = complete(picked.events)?.data;
    expect(result).toMatchObject({ id: TRACK_ID });
    expect(result?.run?.sourceErrors).toEqual(
      expect.arrayContaining([expect.objectContaining({ source: "spotify" })]),
    );
    expect(await store.search(TRACKS_NAMESPACE)).toEqual([]);

    // A later run that finds the track with its full details composes it, and stores that.
    const llm = stubModel(["done"]);
    const later = await drive(llm, { store });
    expect(llm.calls.map((call) => call.callSite)).toContain("composer");
    expect(complete(later.events)?.data.run?.sourceErrors ?? []).toEqual([]);
    expect(await store.search(TRACKS_NAMESPACE)).toHaveLength(1);
  });

  it("does not store a result whose preview lookup could not be finished, so the next run analyses again", async () => {
    const store = new InMemoryStore();
    // The real lookup and analysis tool: Deezer's pace refuses the search (the track has no ISRC).
    hooks.realPreview = true;
    const audio = hooks.audio;
    if (!audio) throw new Error("the audio module was not loaded");
    // Undone when the test finishes, whatever its outcome: no queued answer outlives it.
    onTestFinished(() => {
      tools.analyzeAudioPreview.invoke.mockReset();
    });
    tools.analyzeAudioPreview.invoke.mockImplementationOnce(async (...args: unknown[]) =>
      String(
        await audio.analyzeAudioPreview.invoke(
          ...(args as Parameters<typeof audio.analyzeAudioPreview.invoke>),
        ),
      ),
    );
    setUnpacedForTests(false);
    const others = new AbortController();
    const paced = new AbortController();
    const ahead: Array<Promise<unknown>> = [];
    onTestFinished(async () => {
      // Stopped, never let go: the real network is back by now (afterEach runs first), and
      // undoing the pace lets every waiting request go, the run's own among them.
      paced.abort();
      others.abort();
      setUnpacedForTests(true);
      await Promise.all(ahead);
    });
    // A full window of other Deezer requests, and as many again waiting for the next one.
    const other = { title: "Song 99", artist: "Queen", isrc: "GBXXX9900099" };
    for (let i = 0; i < 2 * DEEZER_MAX_PER_WINDOW; i++) {
      ahead.push(deezerPreviewByIsrc(other, others.signal).catch(() => null));
    }
    const first = await drive(stubModel(["done"]), { store, signal: paced.signal });

    // Not a finished analysis: nothing is stored for the track.
    expect(await store.search(TRACKS_NAMESPACE)).toEqual([]);
    const result = complete(first.events)?.data;
    expect(result).toMatchObject({
      id: TRACK_ID,
      audioUnavailableReason: "preview_lookup_incomplete",
    });
    expect(result?.run?.sourceErrors ?? []).toEqual([]);

    // The next run that finds the track analyses it again instead of serving "no clip".
    hooks.realPreview = false;
    const llm = stubModel(["done"]);
    const second = await drive(llm, { store, query: "vanilla ice - ice ice baby" });
    expect(second.threw).toBeNull();
    expect(llm.calls.map((call) => call.callSite)).toContain("composer");
    expect(tools.analyzeAudioPreview.invoke).toHaveBeenCalledTimes(2);
    expect(complete(second.events)?.data).not.toMatchObject({
      audioUnavailableReason: "preview_lookup_incomplete",
    });
  });

  it("does not serve a result stored for another track", async () => {
    const store = new InMemoryStore();
    await drive(stubModel(["done"]), { store });
    // The same text now finds another track: its result is composed, not the stored one.
    const answer = tools.spotifySearch.invoke.getMockImplementation();
    const [track] = JSON.parse(String(await answer?.()));
    tools.spotifySearch.invoke.mockImplementationOnce(async () =>
      JSON.stringify([{ ...track, id: "4Fcfwhm8oRrBvBZ8KGhteb" }]),
    );

    const llm = stubModel(["done"]);
    const again = await drive(llm, { store });

    expect(complete(again.events)?.data.id).toBe("4Fcfwhm8oRrBvBZ8KGhteb");
    expect(llm.calls.map((call) => call.callSite)).toContain("composer");
  });
});

// The honesty guard's own patterns (scripts/guard-honest.mjs): the prototype's phrases and the
// emoji it counts in progress messages.
const guard: {
  PROTOTYPE_COPY: RegExp[];
  rules: Array<{ id: string; pattern: RegExp | RegExp[] }>;
} = await import(new URL("../../../../scripts/guard-honest.mjs", import.meta.url).href);
const EMOJI = [guard.rules.find((rule) => rule.id === "emoji-in-progress")!.pattern].flat();

/** What a message holds that the guard counts: emoji and the prototype's phrases. */
const flagged = (message: string) =>
  [...EMOJI, ...guard.PROTOTYPE_COPY].flatMap((pattern) => message.match(pattern) ?? []);

/**
 * Every message a run writes for the user: its status and candidate messages, error texts, the
 * interrupt's message, and the status lines it keeps in its state.
 */
async function messagesOf(
  llm: ReturnType<typeof stubLlm> | ReturnType<typeof createLlm>,
  options: {
    store?: InMemoryStore;
    checkpointer?: MemorySaver;
    threadId?: string;
    query?: string;
    resume?: string;
  } = {},
): Promise<string[]> {
  const graph = buildSonicAgentGraph({
    runtime: testRuntime(llm),
    checkpointer: options.checkpointer ?? new MemorySaver(),
    store: options.store ?? new InMemoryStore(),
  });
  const messages: string[] = [];
  const stream = await graph.stream(
    options.resume
      ? new Command({ resume: options.resume })
      : { songQuery: options.query ?? QUERY },
    {
      configurable: { thread_id: options.threadId ?? "t-messages" },
      streamMode: ["updates", "custom"],
    },
  );
  for await (const [mode, data] of stream as AsyncIterable<[string, Record<string, unknown>]>) {
    if (mode === "custom") {
      for (const text of [data.message, data.error]) {
        if (typeof text === "string") messages.push(text);
      }
      continue;
    }
    for (const [node, update] of Object.entries(data)) {
      if (node === "__interrupt__") {
        for (const { value } of update as Array<{ value?: { message?: string } }>) {
          if (value?.message) messages.push(value.message);
        }
      } else {
        messages.push(...((update as { statusMessages?: string[] } | null)?.statusMessages ?? []));
      }
    }
  }
  return messages;
}

describe("the analysis graph's progress messages", () => {
  it("say what happened, with no emoji and none of the prototype's phrases", async () => {
    // A measured tempo whose key the service withheld, then the result served from the store.
    tools.analyzeAudioPreview.invoke.mockImplementationOnce(async () =>
      JSON.stringify({
        source: "analyzed",
        audio: keyWithheldV2(),
        previewUrl: null,
        previewMatch: { provider: "deezer", method: "search", deezerId: 1, score: 1 },
      }),
    );
    const store = new InMemoryStore();
    const measured = await messagesOf(stubModel(["search_lastfm_tags"]), { store });
    const served = await messagesOf(stubModel(["done"]), { store, threadId: "t-served" });

    // A source that cannot be read, and a model that keeps answering 429: the fallback.
    tools.searchSamples.invoke.mockImplementationOnce(async () =>
      JSON.stringify(failureWith("unavailable", "Tavily is down")),
    );
    const provider = providerFetch(() => errorResponse(429));
    const fallback = await messagesOf(llmWith({ LLM_CASSETTE: "off" }, { fetch: provider.fetch }), {
      threadId: "t-fallback",
    });

    // A title alone: the user is asked which recording is meant, and picks one.
    const checkpointer = new MemorySaver();
    const asked = await messagesOf(stubModel(["done"]), {
      checkpointer,
      threadId: "t-ask",
      query: "Ice Ice Baby",
    });
    const picked = await messagesOf(stubModel(["done"]), {
      checkpointer,
      threadId: "t-ask",
      resume: "3Fcfwhm8oRrBvBZ8KGhtea",
    });

    // Each path wrote its own lines (so the check below reads them all).
    expect(measured).toEqual(
      expect.arrayContaining([
        "Searching Spotify",
        "Found the track on Spotify: Ice Ice Baby by Vanilla Ice",
        "Measured 116 BPM; key not given: one pitched source, not a key",
        // Only the sources it will ask: no ISRC, so no primary source, and no web search key.
        "Starting the research: Last.fm",
        "Primary sources not asked: the track has no ISRC",
        "Choosing follow-up step 1 of at most 2",
        // A finish with no count: each step said what it did.
        "Research finished",
        "Writing the liner notes",
        "Looking up cover art on Spotify for the genealogy",
        "Analysis complete",
      ]),
    );
    expect(served).toContain("Serving the analysis stored for this track");
    expect(fallback).toEqual(
      expect.arrayContaining([
        "Web search (Tavily) could not be read: it gave no usable answer",
        "The model is unavailable: it is limiting requests; showing source data only, with a template song structure and no written notes",
        // The planner's 429 ended the research early: said, and never followed by a normal finish.
        "Research ended early: the model is unavailable: it is limiting requests",
        "Research stopped early; showing what was found",
      ]),
    );
    expect(fallback).not.toContain("Research finished");
    // The streamed fallback line and the state's are the same line.
    expect(
      fallback.filter(
        (line) =>
          line ===
          "The model is unavailable: it is limiting requests; showing source data only, with a template song structure and no written notes",
      ),
    ).toHaveLength(2);
    // One candidate: the choice line says one, in the candidates event, the state and the
    // interrupt alike.
    const one = "One possible track from Spotify; confirm it or search again";
    expect(asked.filter((message) => message === one)).toHaveLength(3);
    expect(asked.join("\n")).not.toMatch(/Multiple|songs found|matching songs/);
    expect(picked).toContain("Selected: Ice Ice Baby (its Spotify details could not be read)");
    // Its ISRC is unknown, not absent: the details could not be read.
    expect(picked).toContain(
      "Primary sources not asked: the track's ISRC could not be read from Spotify",
    );
    expect(picked).not.toContain("Primary sources not asked: the track has no ISRC");

    const all = [...measured, ...served, ...fallback, ...asked, ...picked];
    expect(all.filter((message) => flagged(message).length > 0)).toEqual([]);
    expect(all.filter((message) => message.endsWith("..."))).toEqual([]);
    expect(all.filter((message) => /steps? run/.test(message))).toEqual([]);
    // No web search key in these runs: no line says the web is being searched.
    expect(all.filter((message) => message.startsWith("Searching: sample history"))).toEqual([]);
    // The planner's reasoning ("planned …", model text) is never a status line.
    expect(all.filter((message) => message.startsWith("planned "))).toEqual([]);
  });

  it("flag a message the guard counts (the check above can fail)", () => {
    expect(flagged("🔍 Target acquired: deep-web research protocols")).toEqual([
      "🔍",
      "Target acquired",
      "deep-web research protocols",
    ]);
    expect(flagged("Found the track on Spotify: One More Time by Daft Punk")).toEqual([]);
  });
});
