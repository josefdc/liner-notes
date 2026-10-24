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
vi.mock("../sources/spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/spotify.js")>()),
  searchMultipleTracks: tools.searchMultipleTracks,
}));
vi.mock("../sources/audio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/audio.js")>()),
  analyzeAudioPreview: tools.analyzeAudioPreview,
}));
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
  enrich: null as null | ((genealogy: unknown) => Promise<unknown>),
  putAudio: vi.fn(),
  putResearch: vi.fn(),
}));
vi.mock("../store/cache.js", () => ({
  getCache: () => ({
    getAudio: () => null,
    putAudio: hooks.putAudio,
    getResearch: () => null,
    putResearch: hooks.putResearch,
  }),
}));
vi.mock("./enricher.js", () => ({
  enrichGenealogyWithArtwork: async (genealogy: unknown) =>
    hooks.enrich ? hooks.enrich(genealogy) : genealogy,
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
import { engineerNode } from "./nodes/engineerNode.js";
import type { SonicAgentStateType } from "./state.js";
import type { TrackData } from "./schema.js";
import { TransientError } from "./errors.js";
import { SourceError } from "../sources/http.js";
import { failureWith, toolFailure } from "../sources/toolResult.js";
import { type StubCall, stubLlm, testRuntime } from "./testing/stubLlm.js";

// The web's query names the artist: a title alone always asks which recording is meant.
const QUERY = "Ice Ice Baby Vanilla Ice";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-graph-"));
  writeFileSync(join(dir, "spend.jsonl"), "");
  for (const tool of Object.values(tools)) tool.invoke.mockClear();
  hooks.enrich = null;
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
    // Answers from cassettes make a replayed run; the recording run called the provider.
    expect(replayedRun).toMatchObject({ id: "thread-b", fallback: false, mode: "replay" });
    expect(recordedRun).toMatchObject({ id: "thread-a", fallback: false, mode: "live" });
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
  options: { threadId?: string; signal?: AbortSignal; store?: InMemoryStore; at?: string } = {},
): Promise<Driven> {
  const graph = buildSonicAgentGraph({
    runtime: testRuntime(llm, options.at),
    ...(options.threadId ? { checkpointer: new MemorySaver() } : {}),
    store: options.store ?? new InMemoryStore(),
  });
  const events: Array<Record<string, unknown>> = [];
  let threw: unknown = null;
  let state: Driven["state"] = {};
  try {
    const stream = await graph.stream(
      { songQuery: QUERY },
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
    expect(key).toMatch(/^v3:3Fcfwhm8oRrBvBZ8KGhtea:lastfm=1:tavily=[01]$/);
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
    expect(await store.get(["tracks"], QUERY)).toBeNull();
    expect(events.filter((event) => event.type === "complete")).toEqual([]);
  });

  it("passes the run's signal to the scout and the audio analysis, and caches no audio after a cancel", async () => {
    const controller = new AbortController();
    let audioSignal: AbortSignal | undefined;
    tools.analyzeAudioPreview.invoke.mockImplementationOnce(async (...args: unknown[]) => {
      audioSignal = (args[1] as { signal?: AbortSignal } | undefined)?.signal;
      controller.abort();
      return JSON.stringify({ source: "analyzed", bpm: 116, key: "D", mode: "minor" });
    });

    const { threw } = await drive(stubModel(["done"]), {
      threadId: "t-audio",
      signal: controller.signal,
    });

    expect(threw).not.toBeNull();
    expect(audioSignal?.aborted).toBe(true);
    expect(hooks.putAudio).not.toHaveBeenCalled();
    expect(hooks.putResearch).not.toHaveBeenCalled();
    const scoutOptions = tools.searchMultipleTracks.invoke.mock.calls[0] as unknown[];
    expect((scoutOptions[1] as { signal?: AbortSignal }).signal).toBeInstanceOf(AbortSignal);
  });

  it("starts no audio analysis once the run is cancelled", async () => {
    const controller = new AbortController();
    // The clock is read for the engineer's first status event: the client leaves then.
    const runtime = {
      ...testRuntime(stubModel(["done"])),
      now: () => {
        controller.abort();
        return new Date("2026-01-01T00:00:00.000Z");
      },
    };
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
      new Set(["scout", "engineer", "historian", "research_manager", "research_tool", "composer"]),
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
        bpm: 116,
        key: "D",
        mode: "Minor",
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
  });
});
