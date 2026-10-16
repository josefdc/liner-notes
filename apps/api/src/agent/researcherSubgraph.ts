/**
 * Deep Dive Researcher Subgraph
 *
 * Implements a ReAct (Reasoning + Acting) pattern for iterative music research.
 * Instead of running 3 parallel searches once, this subgraph:
 * 1. Analyzes current research findings
 * 2. Decides what to search next (or if done)
 * 3. Executes the search
 * 4. Loops back (max 3 iterations)
 *
 * This allows the agent to "follow leads" - if it discovers a sample,
 * it can research that sampled song to build a richer genealogy.
 */

import { StateGraph, END, START, Annotation } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import dotenv from "dotenv";

import { generateStructuredOutput, GEMINI_MODEL_PRO } from "./geminiClient.js";
import { ResearchPlanSchema } from "./schema.js";
import { formatResearchManagerPrompt } from "./prompts.js";
import {
  searchSamples,
  searchProductionHistory,
  searchSongMeaning,
  searchMusicInfo,
} from "../sources/search.js";
import { fetchLyrics, getGeniusAnnotations } from "../sources/genius.js";
import { getMusicBrainzRelations, getMusicBrainzArtist } from "../sources/musicbrainz.js";
import { getArtistTopTracks } from "../sources/spotify.js";
import {
  getLastfmTrackTags,
  getLastfmArtistTags,
  getLastfmSimilarTracks,
  getLastfmSimilarArtists,
  getLastfmArtistInfo,
} from "../sources/lastfm.js";
import { getListenBrainzSimilarArtists } from "../sources/listenbrainz.js";
import type { SpotifyData, ResearchData, ResearchPlan } from "./state.js";

dotenv.config();

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
      songMeaning: [...prev.songMeaning, ...(next.songMeaning || [])],
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
      songMeaning: [],
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
});

export type ResearcherStateType = typeof ResearcherState.State;

// =============================================================================
// Node: Research Manager (LLM-based decision maker)
// Uses unified geminiClient for Gemini 3 structured output
// =============================================================================

async function researchManagerNode(
  state: ResearcherStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<ResearcherStateType>> {
  const writer = config.writer;
  const iteration = state.researchIteration;

  console.log(`🧠 [Research Manager] Iteration ${iteration + 1}/3`);

  // First iteration: start with samples search
  if (iteration === 0) {
    writer?.({
      type: "status",
      message: "🔬 Starting deep dive research...",
      node: "research_manager",
      timestamp: new Date().toISOString(),
    });

    return {
      researchPlan: {
        nextAction: "search_samples",
        query: `${state.spotifyData?.title} ${state.spotifyData?.artist}`,
        reasoning: "Starting research with sample history to discover musical DNA",
      },
      researchIteration: 1,
      statusMessages: ["🔬 Starting deep dive research..."],
    };
  }

  // Use LLM to analyze current findings and decide next steps
  if (!state.spotifyData) {
    console.log("⚠️ [Research Manager] No track data, completing research");
    return {
      researchComplete: true,
      statusMessages: ["Research complete (no track data)"],
    };
  }

  const { title, artist } = state.spotifyData;

  writer?.({
    type: "status",
    message: `🧠 Analyzing findings with ${GEMINI_MODEL_PRO} (iteration ${iteration}/3)...`,
    node: "research_manager",
    timestamp: new Date().toISOString(),
  });

  const prompt = formatResearchManagerPrompt(title, artist, state.researchData, iteration);

  // Use unified Gemini client for structured output (Pro tier for reasoning)
  const result = await generateStructuredOutput({
    prompt,
    schema: ResearchPlanSchema,
    useFallbackOnQuota: true,
    tier: "pro",
  });

  if (!result.data) {
    console.error("❌ [Research Manager] LLM failed:", result.error);
    return {
      researchComplete: true,
      statusMessages: ["Research complete (LLM error)"],
    };
  }

  const plan = result.data as ResearchPlan;
  console.log(`📋 [Research Manager] Plan: ${plan.nextAction} - ${plan.reasoning}`);

  // Check if research is complete
  if (plan.nextAction === "done" || iteration >= 3) {
    writer?.({
      type: "status",
      message: "✅ Deep dive complete",
      node: "research_manager",
      timestamp: new Date().toISOString(),
    });

    return {
      researchComplete: true,
      statusMessages: [`✅ ${plan.reasoning}`],
    };
  }

  // Continue with next search
  writer?.({
    type: "status",
    message: `🔍 ${plan.reasoning}`,
    node: "research_manager",
    timestamp: new Date().toISOString(),
  });

  return {
    researchPlan: plan,
    researchIteration: iteration + 1,
    statusMessages: [`🔍 ${plan.reasoning}`],
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

async function researchToolNode(
  state: ResearcherStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<ResearcherStateType>> {
  const writer = config.writer;
  const plan = state.researchPlan;

  if (!plan || !state.spotifyData) {
    return { researchComplete: true };
  }

  const { title, artist } = state.spotifyData;
  const actionLabel = plan.nextAction.replace("search_", "").replace("_", " ");

  console.log(`🔧 [Research Tool] Executing: ${plan.nextAction}`);

  writer?.({
    type: "status",
    message: `🔎 Searching ${actionLabel}...`,
    node: "research_tool",
    timestamp: new Date().toISOString(),
  });

  // Prepare new research data (will be merged via appending reducer)
  const newData: ResearchData = {
    samples: [],
    productionTrivia: [],
    songMeaning: [],
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
        result = await searchSamples.invoke({
          songTitle: title,
          artistName: artist,
        });
        if (!result.startsWith("Error") && !result.startsWith("No sample")) {
          newData.samples.push(result);
        }
        break;

      case "search_production":
        result = await searchProductionHistory.invoke({
          songTitle: title,
          artistName: artist,
        });
        if (!result.startsWith("Error") && !result.startsWith("No production")) {
          newData.productionTrivia.push(result);
        }
        break;

      case "search_meaning":
        result = await searchSongMeaning.invoke({
          songTitle: title,
          artistName: artist,
        });
        if (!result.startsWith("Error") && !result.startsWith("No song meaning")) {
          newData.songMeaning.push(result);
        }
        break;

      case "search_general": {
        // Use the custom query from the plan (for following leads)
        const query = plan.query || `${title} ${artist} music history`;
        result = await searchMusicInfo.invoke({ query });
        if (!result.startsWith("Error") && !result.startsWith("No results")) {
          // Classify general results as production trivia
          newData.productionTrivia.push(result);
        }
        break;
      }

      case "search_lyrics":
        // Use Genius to fetch raw lyrics
        result = await fetchLyrics.invoke({ title, artist });
        try {
          const lyricsData = JSON.parse(result);
          if (lyricsData.lyrics) {
            newData.songMeaning.push(`[Genius Lyrics]\n${lyricsData.lyrics}`);
          }
        } catch {
          // If parse fails, add raw result
          if (!result.includes("error")) {
            newData.songMeaning.push(result);
          }
        }
        break;

      case "search_annotations":
        // Use Genius annotations for deeper meaning
        result = await getGeniusAnnotations.invoke({ title, artist });
        try {
          const annotData = JSON.parse(result);
          if (annotData.topAnnotations?.length > 0) {
            newData.songMeaning.push(
              `[Genius Annotations] ${JSON.stringify(annotData.topAnnotations)}`,
            );
          }
        } catch {
          if (!result.includes("error")) {
            newData.songMeaning.push(result);
          }
        }
        break;

      case "search_musicbrainz":
        // Use MusicBrainz for structured genealogy data
        result = await getMusicBrainzRelations.invoke({ title, artist });
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
        result = await getMusicBrainzArtist.invoke({ artistName: artist });
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

      case "search_artist_top_tracks": {
        // Use Spotify to get artist's top tracks for "More from this artist"
        const artistId = state.spotifyData.artistIds?.[0];
        if (artistId) {
          result = await getArtistTopTracks.invoke({ artistId });
          try {
            const topTracksData = JSON.parse(result);
            if (topTracksData.topTracks?.length > 0) {
              newData.artistTopTracks = topTracksData.topTracks;
              newData.relatedArtists.push(
                `[Spotify Top Tracks] ${JSON.stringify(topTracksData.topTracks)}`,
              );
            }
          } catch {
            if (!result.includes("error")) {
              newData.relatedArtists.push(result);
            }
          }
        } else {
          console.log("⚠️ [Research Tool] No artist ID available for top tracks");
        }
        break;
      }

      case "search_lastfm_tags":
        // Fetch both track and artist tags in parallel
        {
          const [trackTagsResult, artistTagsResult] = await Promise.allSettled([
            getLastfmTrackTags.invoke({ title, artist }),
            getLastfmArtistTags.invoke({ artist }),
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
        result = await getLastfmSimilarTracks.invoke({ title, artist });
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
        result = await getLastfmSimilarArtists.invoke({ artist });
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
        result = await getLastfmArtistInfo.invoke({ artist });
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
          result = await getListenBrainzSimilarArtists.invoke({
            artistMbid: mbid || undefined,
            artistName: mbid ? undefined : artist,
          });
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

      default:
        console.warn(`⚠️ [Research Tool] Unknown action: ${plan.nextAction}`);
        return { researchComplete: true };
    }

    console.log(`✅ [Research Tool] Found data for ${plan.nextAction}`);

    return {
      researchData: newData,
      statusMessages: [`Found ${actionLabel} information`],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error(`❌ [Research Tool] Error in ${plan.nextAction}:`, message);

    return {
      statusMessages: [`Search failed: ${actionLabel}`],
    };
  }
}

// =============================================================================
// Conditional Edge: Should continue research loop?
// =============================================================================

function shouldContinueResearch(state: ResearcherStateType): string {
  // Exit conditions
  if (state.researchComplete) {
    console.log("🏁 [Router] Research marked complete");
    return END;
  }

  if (state.researchIteration >= 3) {
    console.log("🏁 [Router] Max iterations reached");
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

  if (state.researchIteration >= 3) {
    console.log("🏁 [Router] Max iterations after tool");
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
 * - researchComplete is true
 * - researchIteration reaches 3
 * - researchPlan.nextAction is "done"
 */
export function createResearcherSubgraph() {
  const workflow = new StateGraph(ResearcherState)
    .addNode("research_manager", researchManagerNode, {
      retryPolicy: { maxAttempts: 2 },
    })
    .addNode("research_tool", researchToolNode, {
      retryPolicy: { maxAttempts: 3 },
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

// Cached singleton — the compiled subgraph has no mutable state
let cachedSubgraph: ReturnType<typeof createResearcherSubgraph> | null = null;

export function getCachedResearcherSubgraph() {
  if (!cachedSubgraph) {
    cachedSubgraph = createResearcherSubgraph();
  }
  return cachedSubgraph;
}

// Type export for parent graph
export type ResearcherSubgraph = ReturnType<typeof createResearcherSubgraph>;
