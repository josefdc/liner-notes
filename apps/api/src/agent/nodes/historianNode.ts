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
import {
  getCachedResearcherSubgraph,
  mergeTags,
  type NoneLabel,
  type ResearcherStateType,
  similarTrackLines,
  StepReader,
  uniqueErrors,
  unreadableStatus,
} from "../researcherSubgraph.js";
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
  // This ensures genre tags are always available regardless of which actions the LLM picks.
  // Each result is read by its type: data, "nothing found" (recorded, never a fact) or the
  // source's error (a source error, and the prompts say Last.fm was unavailable).
  const prefetchData: Partial<ResearchData> = {};
  const prefetch = new StepReader();
  console.log("🏷️ [Historian] Pre-fetching Last.fm data in parallel...");
  config.signal?.throwIfAborted();
  const [trackTagsResult, artistTagsResult, similarTracksResult] = await Promise.allSettled([
    getLastfmTrackTags.invoke({ title, artist }, options),
    getLastfmArtistTags.invoke({ artist }, options),
    getLastfmSimilarTracks.invoke({ title, artist }, options),
  ]);
  config.signal?.throwIfAborted();
  const settled = (result: PromiseSettledResult<string>, label: NoneLabel) => {
    if (result.status === "fulfilled") return prefetch.read("lastfm", result.value, label);
    if (isAbortError(result.reason)) throw result.reason;
    prefetch.errors.push(errorRecord("lastfm", result.reason));
    return null;
  };
  const trackTags = settled(trackTagsResult, "trackTags");
  const artistTags = settled(artistTagsResult, "artistTags");
  const similarTracks = settled(similarTracksResult, "similarTracks");
  prefetchData.lastfmTags = mergeTags(mergeTags([], trackTags?.tags), artistTags?.tags);
  prefetchData.lastfmSimilarTracks = similarTrackLines(similarTracks?.tracks);
  console.log(
    `✅ [Historian] Pre-fetched ${prefetchData.lastfmTags.length} tags, ` +
      `${prefetchData.lastfmSimilarTracks.length} similar tracks from Last.fm ` +
      `(${prefetch.errors.length} source errors)`,
  );
  const prefetchErrors = uniqueErrors(prefetch.errors);
  const prefetchStatus = unreadableStatus(prefetchErrors);
  for (const message of prefetchStatus) {
    writer?.({
      type: "status",
      code: "SYS-WARN",
      message,
      node: "historian",
      timestamp: timestampOf(runtime),
    });
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
        // The planner reads which sources could not be read, and what found nothing.
        sourceErrors: prefetchErrors,
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
    noneFound: [...prefetch.none, ...(research.noneFound || [])],
  };
  // The subgraph's state starts with the pre-fetch errors; each source and code counts once.
  const sourceErrors = uniqueErrors([
    ...prefetchErrors,
    ...(finalState.sourceErrors ?? []),
    ...(isSourceError(failure) ? [errorRecord(sourceIdOf(failure.source), failure)] : []),
  ]);

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
    statusMessages: [
      ...prefetchStatus,
      ...(finalState.statusMessages ?? []),
      ...(failure ? [summary] : []),
    ],
  };
}

const EMPTY_RESEARCH: ResearchData = { samples: [], productionTrivia: [], relatedArtists: [] };

/** The contract's id for a source; the audio service is not a research source. */
function sourceIdOf(source: SourceName): SourceId {
  return source === "audio" ? "deezer" : source;
}
