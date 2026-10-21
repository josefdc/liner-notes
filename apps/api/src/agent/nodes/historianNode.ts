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
  lastfmConfigured,
} from "../../sources/lastfm.js";
import { tavilyConfigured } from "../../sources/search.js";
import {
  getCachedResearcherSubgraph,
  mergeTags,
  type NoneLabel,
  type ResearcherStateType,
  similarTrackLines,
  StepReader,
  trackQuery,
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
  // Research depends on which optional sources have a key: adding one later runs it again.
  const cacheKey = researchCacheKey(state.spotifyData.id, {
    lastfm: lastfmConfigured(),
    tavily: tavilyConfigured(),
  });

  // Check persistent research cache first
  try {
    const cache = getCache();
    const cached = cache.getResearch(cacheKey);
    if (cached) {
      // The sources that were not configured when it was made are reported again: a cached
      // answer without them would read as "read, nothing there".
      const { notConfigured = [], ...cachedResearch } = withoutSongMeaning(cached);
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
        ...(notConfigured.length > 0 ? { sourceErrors: notConfigured } : {}),
        statusMessages: [
          "📚 Research (cached): loaded from persistent cache",
          ...unreadableStatus(notConfigured),
        ],
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
  // Last.fm is asked about the first credited artist and the title without a featured-artist
  // note: the joined Spotify string is no artist, and Last.fm would answer "not found".
  const query = trackQuery(state.spotifyData);
  // Every search stops when the run is cancelled.
  const options = { signal: config.signal };
  console.log("📚 [Historian] Deep dive research for:", title, "by", artist);

  // Pre-fetch Last.fm tags and similar tracks in parallel (outside the researcher loop)
  // This ensures genre tags are always available regardless of which actions the LLM picks.
  // Each result is read by its type: data, "nothing found" (recorded, never a fact) or the
  // source's error (a source error, and the prompts say Last.fm was unavailable).
  const prefetch = new StepReader();
  console.log("🏷️ [Historian] Pre-fetching Last.fm data in parallel...");
  config.signal?.throwIfAborted();
  const [trackTagsResult, artistTagsResult, similarTracksResult] = await Promise.allSettled([
    getLastfmTrackTags.invoke({ title: query.title, artist: query.primary }, options),
    getLastfmArtistTags.invoke({ artist: query.primary }, options),
    getLastfmSimilarTracks.invoke({ title: query.title, artist: query.primary }, options),
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
  const prefetchData = {
    lastfmTags: mergeTags(mergeTags([], trackTags?.tags), artistTags?.tags),
    lastfmSimilarTracks: similarTrackLines(similarTracks?.tracks),
  };
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

  // The research starts from what the pre-fetch read: the planner sees its tags, similar tracks,
  // empty answers and unreadable sources, and does not spend a step asking again.
  const before = state.researchData ?? EMPTY_RESEARCH;
  const seeded: ResearchData = {
    ...before,
    lastfmTags: [...prefetchData.lastfmTags, ...(before.lastfmTags ?? [])],
    lastfmSimilarTracks: [
      ...prefetchData.lastfmSimilarTracks,
      ...(before.lastfmSimilarTracks ?? []),
    ],
    noneFound: [...prefetch.none, ...(before.noneFound ?? [])],
    notAsked: [...prefetch.notAsked, ...(before.notAsked ?? [])],
  };

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
        researchData: seeded,
        runId: runIdFor(state, config, runtime),
        // The planner reads which sources could not be read.
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

  // The subgraph's research starts with the pre-fetched data.
  const mergedResearch: ResearchData = finalState.researchData ?? seeded;
  // The subgraph's state starts with the pre-fetch errors; each source and code counts once.
  const sourceErrors = uniqueErrors([
    ...prefetchErrors,
    ...(finalState.sourceErrors ?? []),
    ...(isSourceError(failure) ? [errorRecord(sourceIdOf(failure.source), failure)] : []),
  ]);

  // Nothing is written for a cancelled run. Research is cached only when it is complete: not
  // when it stopped early, a source could not be read for a passing reason (an outage, a
  // timeout, a rate limit, a bad answer), or a planner call failed (the next run may find more,
  // as with audio that failed transiently). A source that is not configured is a lasting state:
  // it does not block the cache, its errors are stored with the research and reported on a hit,
  // and the cache key names the configured sources, so adding a key runs the research again.
  config.signal?.throwIfAborted();
  const notConfigured = sourceErrors.filter((e) => e.code === "not_configured");
  const complete =
    !failure &&
    sourceErrors.length === notConfigured.length &&
    (finalState.usage ?? []).every((call) => call.status === "ok");
  if (complete) {
    try {
      getCache().putResearch(cacheKey, {
        ...mergedResearch,
        ...(notConfigured.length > 0 ? { notConfigured } : {}),
      });
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
