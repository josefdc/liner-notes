/**
 * Deep Dive Researcher Subgraph
 *
 * Iterative research: a fixed first step (sample history), then up to MAX_PLANNED_STEPS steps
 * chosen by the research planner, a model call on the `fast` tier through the provider layer
 * (schema `ResearchPlanOutput`). Each step runs one search; the planner sees what was found.
 *
 * A failed planner call ends the research (the run continues with what was found) and is
 * recorded in `usage` with its error kind. A cancelled run stops the research: the run's abort
 * signal goes to every planner call and every search.
 */

import { StateGraph, END, START, Annotation } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { ResearchPlanOutput } from "@liner-notes/contract";

import { answeredCall, failedCall } from "./callRecords.js";
import { isAbortError, isTransient, TRANSIENT_RETRY } from "./errors.js";
import { plannerMessages } from "./prompts.js";
import { type AgentRuntime, defaultAgentRuntime, runIdOf, timestampOf } from "./runtime.js";
import { searchSamples, searchProductionHistory, searchMusicInfo } from "../sources/search.js";
import { getMusicBrainzRelations, getMusicBrainzArtist } from "../sources/musicbrainz.js";
import {
  getLastfmTrackTags,
  getLastfmArtistTags,
  getLastfmSimilarTracks,
  getLastfmSimilarArtists,
  getLastfmArtistInfo,
} from "../sources/lastfm.js";
import { getListenBrainzSimilarArtists } from "../sources/listenbrainz.js";
import { errorRecord } from "../sources/records.js";
import type { SourceError, SourceId } from "@liner-notes/contract";
import type { SpotifyData, ResearchData, ResearchPlan, LlmCallRecord } from "./state.js";

export const PLANNER_CALL_SITE = "research_planner";
/** Output budget of a planner call, reasoning included (fast tier: low effort). */
export const PLANNER_MAX_OUTPUT_TOKENS = 1500;
/** Research steps chosen by the planner, after the fixed first step. */
export const MAX_PLANNED_STEPS = 2;

// =============================================================================
// Researcher Subgraph State
// =============================================================================

/**
 * State for the researcher subgraph.
 * Shares keys with parent graph: spotifyData, researchData, statusMessages
 */
export const ResearcherState = Annotation.Root({
  // Input from parent (read-only in practice)
  spotifyData: Annotation<SpotifyData | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Research data - uses APPENDING reducer for accumulation across iterations
  researchData: Annotation<ResearchData>({
    reducer: (prev, next) => ({
      samples: [...prev.samples, ...(next.samples || [])],
      productionTrivia: [...prev.productionTrivia, ...(next.productionTrivia || [])],
      relatedArtists: [...prev.relatedArtists, ...(next.relatedArtists || [])],
      collaborators: [...(prev.collaborators || []), ...(next.collaborators || [])],
      artistTopTracks: [...(prev.artistTopTracks || []), ...(next.artistTopTracks || [])],
      lastfmTags: [...(prev.lastfmTags || []), ...(next.lastfmTags || [])],
      lastfmSimilarTracks: [
        ...(prev.lastfmSimilarTracks || []),
        ...(next.lastfmSimilarTracks || []),
      ],
      lastfmSimilarArtists: [
        ...(prev.lastfmSimilarArtists || []),
        ...(next.lastfmSimilarArtists || []),
      ],
      lastfmArtistBio: next.lastfmArtistBio || prev.lastfmArtistBio,
      listenbrainzSimilarArtists: [
        ...(prev.listenbrainzSimilarArtists || []),
        ...(next.listenbrainzSimilarArtists || []),
      ],
    }),
    default: () => ({
      samples: [],
      productionTrivia: [],
      relatedArtists: [],
      collaborators: [],
      artistTopTracks: [],
      lastfmTags: [],
      lastfmSimilarTracks: [],
      lastfmSimilarArtists: [],
      lastfmArtistBio: undefined,
      listenbrainzSimilarArtists: [],
    }),
  }),

  // Subgraph-specific: iteration counter
  researchIteration: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),

  // Subgraph-specific: current research plan from LLM
  researchPlan: Annotation<ResearchPlan | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Subgraph-specific: flag to exit loop
  researchComplete: Annotation<boolean>({
    reducer: (_, next) => next,
    default: () => false,
  }),

  // Status messages for streaming (shared with parent)
  statusMessages: Annotation<string[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  // The run the research belongs to (its model calls count against the run's call cap)
  runId: Annotation<string | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // The planner's model calls (shared with parent)
  usage: Annotation<LlmCallRecord[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  // Sources a step could not read (shared with parent)
  sourceErrors: Annotation<SourceError[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
});

export type ResearcherStateType = typeof ResearcherState.State;

// =============================================================================
// Node: Research Manager (the planner)
// =============================================================================

function createResearchManagerNode(runtime: AgentRuntime) {
  return async function researchManagerNode(
    state: ResearcherStateType,
    config: LangGraphRunnableConfig,
  ): Promise<Partial<ResearcherStateType>> {
    const writer = config.writer;
    const iteration = state.researchIteration;
    const status = (message: string) =>
      writer?.({
        type: "status",
        message,
        node: "research_manager",
        timestamp: timestampOf(runtime),
      });

    // First step: sample history, without a model call
    if (iteration === 0) {
      status("🔬 Starting deep dive research...");
      return {
        researchPlan: {
          nextAction: "search_samples",
          query: null,
          reasoning: "Starting research with sample history to discover musical DNA",
        },
        researchIteration: 1,
        statusMessages: ["🔬 Starting deep dive research..."],
      };
    }

    if (!state.spotifyData || iteration > MAX_PLANNED_STEPS) {
      return { researchComplete: true, statusMessages: ["✅ Deep dive complete"] };
    }

    const { title, artist } = state.spotifyData;
    status(`🧠 Planning the next research step (${iteration}/${MAX_PLANNED_STEPS})...`);

    const messages = plannerMessages({
      track: { title, artist },
      research: state.researchData,
      step: iteration,
      maxSteps: MAX_PLANNED_STEPS,
    });
    let plan: ResearchPlan;
    let call: LlmCallRecord;
    try {
      const result = await runtime.llm.invoke(
        PLANNER_CALL_SITE,
        "fast",
        messages,
        ResearchPlanOutput,
        {
          purpose: runtime.purpose,
          runId: state.runId ?? runIdOf(config, runtime.newId),
          maxOutputTokens: PLANNER_MAX_OUTPUT_TOKENS,
          signal: config.signal,
        },
      );
      plan = result.output;
      call = answeredCall(PLANNER_CALL_SITE, result);
    } catch (error) {
      if (config.signal?.aborted || isAbortError(error)) throw error;
      // Only a provider-layer failure ends the research; anything else is a bug and is thrown.
      const failed = failedCall(PLANNER_CALL_SITE, "fast", error);
      if (failed.status === "unexpected") throw error;
      console.warn(`⚠️ [Research Manager] Planner unavailable (${failed.status})`);
      return {
        researchComplete: true,
        usage: [failed],
        statusMessages: [`Research complete (planner unavailable: ${failed.status})`],
      };
    }

    console.log(`📋 [Research Manager] Plan: ${plan.nextAction} - ${plan.reasoning}`);
    if (plan.nextAction === "done") {
      status("✅ Deep dive complete");
      return { researchComplete: true, usage: [call], statusMessages: [`✅ ${plan.reasoning}`] };
    }

    status(`🔍 ${plan.reasoning}`);
    return {
      researchPlan: plan,
      researchIteration: iteration + 1,
      usage: [call],
      statusMessages: [`🔍 ${plan.reasoning}`],
    };
  };
}

// =============================================================================
// Helper: Extract MBID from existing research data
// =============================================================================

/**
 * Try to extract a MusicBrainz artist MBID from existing research data.
 * Looks for MBID patterns in collaborator and MusicBrainz result strings.
 */
function extractMbidFromResearch(researchData: ResearchData): string | null {
  // Look for MBID in lastfmSimilarArtists (they may have mbid fields)
  for (const entry of researchData.lastfmSimilarArtists || []) {
    const match = entry.match(/mbid:\s*([0-9a-f-]{36})/i);
    if (match) return match[1];
  }

  // Look for MBID in samples data (MusicBrainz results)
  for (const entry of researchData.samples) {
    const match = entry.match(/"mbid"\s*:\s*"([0-9a-f-]{36})"/i);
    if (match) return match[1];
  }

  return null;
}

// =============================================================================
// Node: Research Tool (executes searches)
// =============================================================================

/** The source each research step reads, for its errors. */
const ACTION_SOURCE: Record<Exclude<ResearchPlan["nextAction"], "done">, SourceId> = {
  search_samples: "tavily",
  search_production: "tavily",
  search_general: "tavily",
  search_musicbrainz: "musicbrainz",
  search_artist_collaborators: "musicbrainz",
  search_lastfm_tags: "lastfm",
  search_lastfm_similar_tracks: "lastfm",
  search_lastfm_similar_artists: "lastfm",
  search_lastfm_artist_info: "lastfm",
  search_listenbrainz_similar: "listenbrainz",
};

/** "search_lastfm_similar_tracks" → "lastfm similar tracks". */
export const actionLabel = (action: string) => action.replace(/^search_/, "").replaceAll("_", " ");

function createResearchToolNode(runtime: AgentRuntime) {
  return (state: ResearcherStateType, config: LangGraphRunnableConfig) =>
    researchToolNode(state, config, runtime);
}

async function researchToolNode(
  state: ResearcherStateType,
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime,
): Promise<Partial<ResearcherStateType>> {
  const writer = config.writer;
  const plan = state.researchPlan;

  if (!plan || plan.nextAction === "done" || !state.spotifyData) {
    return { researchComplete: true };
  }

  const { title, artist } = state.spotifyData;
  const label = actionLabel(plan.nextAction);
  // Every search stops when the run is cancelled.
  const options = { signal: config.signal };

  console.log(`🔧 [Research Tool] Executing: ${plan.nextAction}`);

  writer?.({
    type: "status",
    message: `🔎 Searching ${label}...`,
    node: "research_tool",
    timestamp: timestampOf(runtime),
  });

  // Prepare new research data (will be merged via appending reducer)
  const newData: ResearchData = {
    samples: [],
    productionTrivia: [],
    relatedArtists: [],
    collaborators: [],
    artistTopTracks: [],
    lastfmTags: [],
    lastfmSimilarTracks: [],
    lastfmSimilarArtists: [],
    lastfmArtistBio: undefined,
    listenbrainzSimilarArtists: [],
  };

  try {
    let result: string;

    switch (plan.nextAction) {
      case "search_samples":
        result = await searchSamples.invoke({ songTitle: title, artistName: artist }, options);
        if (!result.startsWith("Error") && !result.startsWith("No sample")) {
          newData.samples.push(result);
        }
        break;

      case "search_production":
        result = await searchProductionHistory.invoke(
          { songTitle: title, artistName: artist },
          options,
        );
        if (!result.startsWith("Error") && !result.startsWith("No production")) {
          newData.productionTrivia.push(result);
        }
        break;

      case "search_general": {
        // Use the custom query from the plan (for following leads)
        const query = plan.query || `${title} ${artist} music history`;
        result = await searchMusicInfo.invoke({ query }, options);
        if (!result.startsWith("Error") && !result.startsWith("No results")) {
          // Classify general results as production trivia
          newData.productionTrivia.push(result);
        }
        break;
      }

      case "search_musicbrainz":
        // Use MusicBrainz for structured genealogy data
        result = await getMusicBrainzRelations.invoke({ title, artist }, options);
        try {
          const mbData = JSON.parse(result);
          if (mbData.found && mbData.genealogy) {
            const { samples, covers, remixes } = mbData.genealogy;
            if (samples?.length > 0) {
              newData.samples.push(`[MusicBrainz Samples] ${JSON.stringify(samples)}`);
            }
            if (covers?.length > 0) {
              newData.productionTrivia.push(`[MusicBrainz Covers] ${JSON.stringify(covers)}`);
            }
            if (remixes?.length > 0) {
              newData.productionTrivia.push(`[MusicBrainz Remixes] ${JSON.stringify(remixes)}`);
            }
          }
        } catch {
          if (!result.includes("error")) {
            newData.samples.push(result);
          }
        }
        break;

      case "search_artist_collaborators":
        // Use MusicBrainz to get artist collaborators (producers, writers)
        result = await getMusicBrainzArtist.invoke({ artistName: artist }, options);
        try {
          const artistData = JSON.parse(result);
          if (artistData.found && artistData.collaborators?.length > 0) {
            newData.collaborators = artistData.collaborators.map(
              (c: { name: string; relationship: string }) => `${c.name} (${c.relationship})`,
            );
            newData.productionTrivia.push(
              `[MusicBrainz Artist] ${artist} collaborators: ${JSON.stringify(artistData.collaborators)}`,
            );
          }
        } catch {
          if (!result.includes("error")) {
            newData.productionTrivia.push(result);
          }
        }
        break;

      case "search_lastfm_tags":
        // Fetch both track and artist tags in parallel
        {
          const [trackTagsResult, artistTagsResult] = await Promise.allSettled([
            getLastfmTrackTags.invoke({ title, artist }, options),
            getLastfmArtistTags.invoke({ artist }, options),
          ]);

          if (trackTagsResult.status === "fulfilled") {
            try {
              const data = JSON.parse(trackTagsResult.value);
              if (data.found && data.tags?.length > 0) {
                newData.lastfmTags = data.tags.map(
                  (t: { name: string; count: number }) => `${t.name} (${t.count})`,
                );
              }
            } catch {
              /* ignore */
            }
          }

          if (artistTagsResult.status === "fulfilled") {
            try {
              const data = JSON.parse(artistTagsResult.value);
              if (data.found && data.tags?.length > 0) {
                const existingNames = new Set(
                  (newData.lastfmTags || []).map((t: string) =>
                    t.replace(/\s*\(\d+\)$/, "").toLowerCase(),
                  ),
                );
                const newTags = data.tags
                  .filter((t: { name: string }) => !existingNames.has(t.name.toLowerCase()))
                  .map((t: { name: string; count: number }) => `${t.name} (${t.count})`);
                newData.lastfmTags = [...(newData.lastfmTags || []), ...newTags];
              }
            } catch {
              /* ignore */
            }
          }
        }
        break;

      case "search_lastfm_similar_tracks":
        result = await getLastfmSimilarTracks.invoke({ title, artist }, options);
        try {
          const data = JSON.parse(result);
          if (data.found && data.tracks?.length > 0) {
            newData.lastfmSimilarTracks = data.tracks.map(
              (t: { name: string; artist: string; match: number }) =>
                `${t.name} by ${t.artist} (match: ${(t.match * 100).toFixed(0)}%)`,
            );
          }
        } catch {
          if (!result.includes("error")) {
            newData.relatedArtists.push(result);
          }
        }
        break;

      case "search_lastfm_similar_artists":
        result = await getLastfmSimilarArtists.invoke({ artist }, options);
        try {
          const data = JSON.parse(result);
          if (data.found && data.artists?.length > 0) {
            newData.lastfmSimilarArtists = data.artists.map(
              (a: { name: string; match: number; mbid?: string }) =>
                `${a.name} (match: ${(a.match * 100).toFixed(0)}%${a.mbid ? `, mbid: ${a.mbid}` : ""})`,
            );
            newData.relatedArtists.push(
              `[Last.fm Similar Artists] ${JSON.stringify(data.artists)}`,
            );
          }
        } catch {
          if (!result.includes("error")) {
            newData.relatedArtists.push(result);
          }
        }
        break;

      case "search_lastfm_artist_info":
        result = await getLastfmArtistInfo.invoke({ artist }, options);
        try {
          const data = JSON.parse(result);
          if (data.found) {
            if (data.bio) {
              newData.lastfmArtistBio = data.bio;
              newData.productionTrivia.push(`[Last.fm Bio] ${data.bio}`);
            }
            if (data.tags?.length > 0) {
              const tagStr = data.tags.map((t: { name: string }) => t.name).join(", ");
              newData.lastfmTags = [...(newData.lastfmTags || []), ...[`[Artist Info] ${tagStr}`]];
            }
            if (data.similarArtists?.length > 0) {
              newData.lastfmSimilarArtists = [
                ...(newData.lastfmSimilarArtists || []),
                ...data.similarArtists.map((a: { name: string }) => a.name),
              ];
            }
          }
        } catch {
          if (!result.includes("error")) {
            newData.productionTrivia.push(result);
          }
        }
        break;

      case "search_listenbrainz_similar":
        {
          // Extract MBID from existing research data if available
          const mbid = extractMbidFromResearch(state.researchData);
          result = await getListenBrainzSimilarArtists.invoke(
            { artistMbid: mbid || undefined, artistName: mbid ? undefined : artist },
            options,
          );
          try {
            const data = JSON.parse(result);
            if (data.found && data.artists?.length > 0) {
              newData.listenbrainzSimilarArtists = data.artists.map(
                (a: { name: string; similarity: number }) =>
                  `${a.name} (similarity: ${(a.similarity * 100).toFixed(0)}%)`,
              );
              newData.relatedArtists.push(
                `[ListenBrainz Similar Artists] ${JSON.stringify(data.artists)}`,
              );
            }
          } catch {
            if (!result.includes("error")) {
              newData.relatedArtists.push(result);
            }
          }
        }
        break;
    }

    console.log(`✅ [Research Tool] Found data for ${plan.nextAction}`);

    return {
      researchData: newData,
      statusMessages: [`Found ${label} information`],
    };
  } catch (error) {
    // A cancelled run stops here; a transient failure goes to the node's retry policy; any
    // other failure is recorded as the source's error and the research goes on.
    if (config.signal?.aborted || isAbortError(error) || isTransient(error)) throw error;
    const record = errorRecord(ACTION_SOURCE[plan.nextAction], error);
    console.error(`❌ [Research Tool] Error in ${plan.nextAction}:`, record.message);
    return {
      sourceErrors: [record],
      statusMessages: [`Search failed: ${label}`],
    };
  }
}

// =============================================================================
// Conditional Edge: Should continue research loop?
// =============================================================================

function shouldContinueResearch(state: ResearcherStateType): string {
  // Exit conditions (the manager stops after the fixed step and MAX_PLANNED_STEPS planned ones)
  if (state.researchComplete) {
    console.log("🏁 [Router] Research marked complete");
    return END;
  }

  if (!state.researchPlan || state.researchPlan.nextAction === "done") {
    console.log("🏁 [Router] No plan or done action");
    return END;
  }

  console.log("➡️ [Router] Continuing to research_tool");
  return "research_tool";
}

function afterToolExecution(state: ResearcherStateType): string {
  if (state.researchComplete) {
    console.log("🏁 [Router] Research complete after tool");
    return END;
  }

  console.log("🔄 [Router] Looping back to research_manager");
  return "research_manager";
}

// =============================================================================
// Build and Export Subgraph
// =============================================================================

/**
 * Create the researcher subgraph for deep dive analysis.
 *
 * Flow: research_manager → [research_tool → research_manager]* → END
 *
 * The loop continues until:
 * - researchComplete is true (the planner chose "done", failed, or used its steps)
 * - researchPlan.nextAction is "done"
 *
 * The planner's transient failures are retried inside the provider layer, so its node has no
 * retry policy (a retry would be another model call); a search is retried once on a transient
 * error.
 */
export function createResearcherSubgraph(runtime: AgentRuntime = defaultAgentRuntime) {
  const workflow = new StateGraph(ResearcherState)
    .addNode("research_manager", createResearchManagerNode(runtime))
    .addNode("research_tool", createResearchToolNode(runtime), {
      retryPolicy: TRANSIENT_RETRY,
    })
    .addEdge(START, "research_manager")
    .addConditionalEdges("research_manager", shouldContinueResearch, {
      research_tool: "research_tool",
      [END]: END,
    })
    .addConditionalEdges("research_tool", afterToolExecution, {
      research_manager: "research_manager",
      [END]: END,
    });

  return workflow.compile();
}

// Cached subgraph for the default runtime — the compiled subgraph has no mutable state
let cachedSubgraph: ReturnType<typeof createResearcherSubgraph> | null = null;

/** The subgraph for `runtime`; the one for the default runtime is compiled once. */
export function getCachedResearcherSubgraph(runtime: AgentRuntime = defaultAgentRuntime) {
  if (runtime !== defaultAgentRuntime) return createResearcherSubgraph(runtime);
  if (!cachedSubgraph) {
    cachedSubgraph = createResearcherSubgraph();
  }
  return cachedSubgraph;
}

// Type export for parent graph
export type ResearcherSubgraph = ReturnType<typeof createResearcherSubgraph>;
