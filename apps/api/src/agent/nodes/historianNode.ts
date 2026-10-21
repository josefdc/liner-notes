/**
 * Historian Node — Deep Dive Research
 * Runs in parallel with Engineer
 * Uses the ResearcherSubgraph for iterative research. It has no graph retry policy: a retry
 * would repeat the planner's model calls. When the research stops early on a provider or
 * source failure, what it found, its model calls and its source errors are kept and the status
 * says so; a bug fails the run.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { SourceId } from "@liner-notes/contract";
import { isLlmError } from "../../llm/errors.js";
import { isSourceError, type SourceName } from "../../sources/http.js";
import { errorRecord } from "../../sources/records.js";
import {
  getLastfmTrackTags,
  getLastfmArtistTags,
  getLastfmSimilarTracks,
} from "../../sources/lastfm.js";
import { getCachedResearcherSubgraph, type ResearcherStateType } from "../researcherSubgraph.js";
import { researchCacheKey } from "../cacheKeys.js";
import { isAbortError, isTransient } from "../errors.js";
import { type AgentRuntime, defaultAgentRuntime, runIdFor, timestampOf } from "../runtime.js";
import { getCache } from "../../store/cache.js";
import type { SonicAgentStateType, ResearchData } from "../state.js";

/**
 * Research cached before song-meaning research was removed may hold page text from that
 * search (which can quote the song) or from an earlier song-text source; it is dropped.
 */
export function withoutSongMeaning(research: ResearchData): ResearchData {
  const { songMeaning: _dropped, ...rest } = research;
  return rest;
}

export async function historianNode(
  state: SonicAgentStateType,
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime = defaultAgentRuntime,
): Promise<Partial<SonicAgentStateType>> {
  if (!state.spotifyData) {
    return { statusMessages: ["⚠️ Skipping research - no track data"] };
  }

  const writer = config.writer;

  // Check persistent research cache first
  try {
    const cache = getCache();
    const cached = cache.getResearch(researchCacheKey(state.spotifyData.id));
    if (cached) {
      const cachedResearch = withoutSongMeaning(cached);
      console.log("📚 [Historian] Cache hit for:", state.spotifyData.title);
      writer?.({
        type: "status",
        code: "RESEARCH-FOUND",
        message: "Research cache hit — intelligence already extracted",
        node: "historian",
        timestamp: timestampOf(runtime),
      });
      return {
        researchData: cachedResearch,
        statusMessages: ["📚 Research (cached): loaded from persistent cache"],
      };
    }
  } catch {
    // Cache not available — proceed with fresh research
  }

  writer?.({
    type: "status",
    code: "RESEARCH-START",
    message: "Activating deep-web research protocols...",
    node: "historian",
    timestamp: timestampOf(runtime),
  });

  const { title, artist } = state.spotifyData;
  // Every search stops when the run is cancelled.
  const options = { signal: config.signal };
  console.log("📚 [Historian] Deep dive research for:", title, "by", artist);

  // Pre-fetch Last.fm tags and similar tracks in parallel (outside the researcher loop)
  // This ensures genre tags are always available regardless of which actions the LLM picks
  const prefetchData: Partial<ResearchData> = {};
  try {
    console.log("🏷️ [Historian] Pre-fetching Last.fm data in parallel...");
    config.signal?.throwIfAborted();
    const [trackTagsResult, artistTagsResult, similarTracksResult] = await Promise.allSettled([
      getLastfmTrackTags.invoke({ title, artist }, options),
      getLastfmArtistTags.invoke({ artist }, options),
      getLastfmSimilarTracks.invoke({ title, artist }, options),
    ]);

    // Process track tags
    if (trackTagsResult.status === "fulfilled") {
      try {
        const data = JSON.parse(trackTagsResult.value);
        if (data.found && data.tags?.length > 0) {
          prefetchData.lastfmTags = data.tags.map(
            (t: { name: string; count: number }) => `${t.name} (${t.count})`,
          );
        }
      } catch {
        /* ignore parse errors */
      }
    }

    // Process artist tags (merge with track tags, deduplicate)
    if (artistTagsResult.status === "fulfilled") {
      try {
        const data = JSON.parse(artistTagsResult.value);
        if (data.found && data.tags?.length > 0) {
          const existingNames = new Set(
            (prefetchData.lastfmTags || []).map((t: string) =>
              t.replace(/\s*\(\d+\)$/, "").toLowerCase(),
            ),
          );
          const newTags = data.tags
            .filter((t: { name: string }) => !existingNames.has(t.name.toLowerCase()))
            .map((t: { name: string; count: number }) => `${t.name} (${t.count})`);
          prefetchData.lastfmTags = [...(prefetchData.lastfmTags || []), ...newTags];
        }
      } catch {
        /* ignore parse errors */
      }
    }

    // Process similar tracks
    if (similarTracksResult.status === "fulfilled") {
      try {
        const data = JSON.parse(similarTracksResult.value);
        if (data.found && data.tracks?.length > 0) {
          prefetchData.lastfmSimilarTracks = data.tracks.map(
            (t: { name: string; artist: string; match: number }) =>
              `${t.name} by ${t.artist} (match: ${(t.match * 100).toFixed(0)}%)`,
          );
        }
      } catch {
        /* ignore parse errors */
      }
    }

    const tagCount = prefetchData.lastfmTags?.length || 0;
    const trackCount = prefetchData.lastfmSimilarTracks?.length || 0;
    console.log(
      `✅ [Historian] Pre-fetched ${tagCount} tags, ${trackCount} similar tracks from Last.fm`,
    );
  } catch (error) {
    if (config.signal?.aborted || isAbortError(error)) throw error;
    console.warn("⚠️ [Historian] Last.fm pre-fetch failed (non-critical):", error);
  }

  // The research subgraph: its last state is kept whatever happens, so the planner's calls,
  // the source errors and the steps that finished reach the run even when it stops early.
  let finalState: Partial<ResearcherStateType> = {};
  let failure: unknown = null;
  try {
    const researcherGraph = getCachedResearcherSubgraph(runtime);

    // The run's abort signal stops the planner's model calls and the searches.
    const stream = await researcherGraph.stream(
      {
        spotifyData: state.spotifyData,
        ...(state.researchData ? { researchData: state.researchData } : {}),
        runId: runIdFor(state, config, runtime),
      },
      {
        streamMode: ["values", "custom"],
        signal: config.signal,
      },
    );

    for await (const event of stream) {
      const [mode, chunk] = event as unknown as [string, unknown];
      if (mode === "custom") {
        // Forward subgraph progress events to parent SSE stream
        writer?.(chunk);
      } else if (mode === "values") {
        // Last values chunk = the accumulated state so far
        finalState = chunk as Partial<ResearcherStateType>;
      }
    }
  } catch (error) {
    // A cancelled run stops here. A provider or source failure ends the research early with
    // what it found; anything else is a bug and fails the run.
    if (config.signal?.aborted || isAbortError(error)) throw error;
    if (!isLlmError(error) && !isSourceError(error) && !isTransient(error)) throw error;
    failure = error;
    console.error("❌ [Historian] Research stopped early:", (error as Error).message);
  }

  // Merge pre-fetched Last.fm data with the research results
  const research = finalState.researchData ?? state.researchData ?? EMPTY_RESEARCH;
  const mergedResearch: ResearchData = {
    ...research,
    lastfmTags: [...(prefetchData.lastfmTags || []), ...(research.lastfmTags || [])],
    lastfmSimilarTracks: [
      ...(prefetchData.lastfmSimilarTracks || []),
      ...(research.lastfmSimilarTracks || []),
    ],
  };
  const sourceErrors = [
    ...(finalState.sourceErrors ?? []),
    ...(isSourceError(failure) ? [errorRecord(sourceIdOf(failure.source), failure)] : []),
  ];

  // Nothing is written for a cancelled run. Research is cached only when it is complete: not
  // when it stopped early, a source could not be read, or a planner call failed (the next run
  // may find more, as with audio that failed transiently).
  config.signal?.throwIfAborted();
  const complete =
    !failure &&
    sourceErrors.length === 0 &&
    (finalState.usage ?? []).every((call) => call.status === "ok");
  if (complete) {
    try {
      getCache().putResearch(researchCacheKey(state.spotifyData.id), mergedResearch);
    } catch {
      // Non-critical
    }
  }

  const summary = failure
    ? "⚠️ Research stopped early; showing what was found"
    : `Intelligence extraction complete: ${finalState.researchIteration || 0} layers processed`;
  writer?.({
    type: "status",
    code: failure ? "SYS-WARN" : "RESEARCH-FOUND",
    message: summary,
    node: "historian",
    timestamp: timestampOf(runtime),
  });

  return {
    researchData: mergedResearch,
    usage: finalState.usage ?? [],
    sourceErrors,
    statusMessages: [...(finalState.statusMessages ?? []), ...(failure ? [summary] : [])],
  };
}

const EMPTY_RESEARCH: ResearchData = { samples: [], productionTrivia: [], relatedArtists: [] };

/** The contract's id for a source; the audio service is not a research source. */
function sourceIdOf(source: SourceName): SourceId {
  return source === "audio" ? "deezer" : source;
}
