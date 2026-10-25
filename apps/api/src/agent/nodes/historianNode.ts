/**
 * Historian Node — Deep Dive Research
 * Runs in parallel with Engineer
 * Runs the run's research plan (research/plan.ts): the primary sources from the track's ISRC,
 * each Last.fm method once, then the ResearcherSubgraph: its fixed steps together (the
 * sample-history search, and with an identified recording the production-history search and the
 * credited artist's ListenBrainz similar artists and MusicBrainz collaborators, by MBID), then at
 * most two follow-ups chosen by the planner. The MusicBrainz recording the ISRC identifies is read once:
 * its credited artist is the researcher's artist (by MBID) and the recording goes to the
 * composer (`isrcRecording`). It has no graph retry policy: a retry would repeat the planner's
 * model calls. When the research stops early on a provider or source failure, what it found, its
 * model calls and its source errors are kept and the status says so; a bug fails the run.
 *
 * It writes the run's evidence pack (research/runEvidence.ts): the primary sources' records,
 * read from the track's ISRC (MusicBrainz, Discogs, SecondHandSongs, Genius), and the web
 * search's results. Each item is sent as an `evidence` event. The primary sources are read on
 * every run with an ISRC, also when the research comes from the cache, and their errors are the
 * run's source errors; they are not part of the cached research, and do not block caching it
 * unless a source lost records to a failed request.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { SourceId } from "@liner-notes/contract";
import { isLlmError } from "../../llm/errors.js";
import { isSourceError, type SourceName } from "../../sources/http.js";
import { discogsConfigured } from "../../sources/discogs.js";
import { geniusConfigured } from "../../sources/genius.js";
import { errorRecord } from "../../sources/records.js";
import {
  getLastfmTrackTags,
  getLastfmArtistTags,
  getLastfmSimilarTracks,
} from "../../sources/lastfm.js";
import {
  type ArtistRef,
  artistFromCredit,
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
import { configuredSources, researchCacheKey } from "../cacheKeys.js";
import { isAbortError, isTransient } from "../errors.js";
import { type AgentRuntime, defaultAgentRuntime, runIdFor, timestampOf } from "../runtime.js";
import { getCache } from "../../store/cache.js";
import { fixedSteps, researcherSteps } from "../research/plan.js";
import {
  lastingAmong,
  runEvidence,
  sendStatus,
  startPrimarySources,
} from "../research/runEvidence.js";
import type { IdentifiedRecording } from "../../sources/identity.js";
import {
  emptyResearch,
  mergeResearch,
  type ResearchData,
  type SonicAgentStateType,
} from "../state.js";

/**
 * The status line of a research-cache hit while the primary sources are read: the ones that
 * will be asked (a source without its credential is reported as not configured instead).
 */
function readingPrimary(): string {
  const asked = [
    "MusicBrainz",
    ...(discogsConfigured() ? ["Discogs"] : []),
    "SecondHandSongs",
    ...(geniusConfigured() ? ["Genius"] : []),
  ];
  return `📇 Reading primary sources (${asked.join(", ")})...`;
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
  // The primary sources are read from the track's ISRC while the research runs.
  const isrc = state.isrc ?? null;
  const primary = startPrimarySources(state.spotifyData, isrc, config.signal, runtime);
  // Research depends on which optional sources have a key: adding one later runs it again.
  const cacheKey = researchCacheKey(state.spotifyData.id, configuredSources());

  // Check persistent research cache first
  let cached: ReturnType<ReturnType<typeof getCache>["getResearch"]> = null;
  try {
    cached = getCache().getResearch(cacheKey);
  } catch {
    // Cache not available — proceed with fresh research
  }
  if (cached) {
    // The sources that were not configured when it was made are reported again: a cached
    // answer without them would read as "read, nothing there".
    const { notConfigured = [], ...cachedResearch } = cached;
    console.log("📚 [Historian] Cache hit for:", state.spotifyData.title);
    writer?.({
      type: "status",
      code: "RESEARCH-FOUND",
      message: "Research cache hit — intelligence already extracted",
      node: "historian",
      timestamp: timestampOf(runtime),
    });
    // The cached research holds no evidence: the primary sources are read for this run.
    const reading = isrc ? readingPrimary() : null;
    if (reading) sendStatus(config, runtime, "RESEARCH-FOUND", reading);
    const pack = await runEvidence(primary.run, [], config, runtime);
    const sourceErrors = uniqueErrors([...notConfigured, ...pack.errors]);
    const lasting = lastingAmong(pack.lasting, notConfigured);
    return {
      // The recording's MusicBrainz sample relations of this run join the cached research (for
      // the result built without the model); the cache holds no primary record.
      researchData: {
        ...cachedResearch,
        samples: [...(cachedResearch.samples ?? []), ...pack.samples],
      },
      evidence: pack.evidence,
      isrcRecording: await primary.recording,
      ...(sourceErrors.length > 0 ? { sourceErrors } : {}),
      ...(lasting.length > 0 ? { lastingSourceErrors: lasting } : {}),
      statusMessages: [
        "📚 Research (cached): loaded from persistent cache",
        ...unreadableStatus(notConfigured),
        ...(reading ? [reading] : []),
        ...pack.status,
      ],
    };
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

  // The plan's Last.fm step, each method at most once per run (outside the researcher subgraph,
  // which does not ask them again): the track's tags and similar tracks while the ISRC identifies
  // the recording, and the artist's tags, by the credited artist's MusicBrainz id once it is
  // known (a request Last.fm cannot answer by that id may be made once more by name, kept only
  // when the name is that artist's alone). Each result is read by its type: data, "nothing
  // found" (recorded, never a fact) or the source's error (a source error, and the prompts say
  // Last.fm was unavailable).
  const prefetch = new StepReader();
  console.log("🏷️ [Historian] Pre-fetching Last.fm data in parallel...");
  config.signal?.throwIfAborted();
  const identified = primary.recording.then((found) => ({
    recording: found,
    artist: found ? artistOf(found, query.primary) : null,
  }));
  const [[trackTagsResult, artistTagsResult, similarTracksResult], { recording, artist: own }] =
    await Promise.all([
      Promise.allSettled([
        getLastfmTrackTags.invoke({ title: query.title, artist: query.primary }, options),
        identified.then(({ artist: credited }) =>
          getLastfmArtistTags.invoke(
            { artist: query.primary, ...(credited ? { mbid: credited.mbid } : {}) },
            options,
          ),
        ),
        getLastfmSimilarTracks.invoke({ title: query.title, artist: query.primary }, options),
      ]),
      identified,
    ]);
  config.signal?.throwIfAborted();
  /** The requests whose source could not be read: their step says so, and is not asked again. */
  const unread = new Set<NoneLabel>();
  const settled = (result: PromiseSettledResult<string>, label: NoneLabel) => {
    const before = prefetch.errors.length;
    let data: Record<string, unknown> | null = null;
    if (result.status === "fulfilled") data = prefetch.read("lastfm", result.value, label);
    else if (isAbortError(result.reason)) throw result.reason;
    else prefetch.errors.push(errorRecord("lastfm", result.reason));
    if (prefetch.errors.length > before) unread.add(label);
    return data;
  };
  const trackTags = settled(trackTagsResult, "trackTags");
  const artistTags = settled(artistTagsResult, "artistTags");
  const similarTracks = settled(similarTracksResult, "similarTracks");
  const trackTagLines = mergeTags([], trackTags?.tags);
  const prefetchData = {
    lastfmTags: trackTagLines,
    // The artist's tags apart from the track's: they are dropped if the artist is uncertain.
    lastfmArtistTags: mergeTags(trackTagLines, artistTags?.tags).slice(trackTagLines.length),
    lastfmSimilarTracks: similarTrackLines(similarTracks?.tracks),
  };
  console.log(
    `✅ [Historian] Pre-fetched ${prefetchData.lastfmTags.length} tags, ` +
      `${prefetchData.lastfmSimilarTracks.length} similar tracks from Last.fm ` +
      `(${prefetch.errors.length} source errors)`,
  );
  const prefetchErrors = uniqueErrors(prefetch.errors);
  const prefetchStatus = [
    ...unreadableStatus(prefetchErrors, prefetch.rejected),
    // The artist's tags were not asked by name: Last.fm does not know the artist's MBID and the
    // name may be another artist's.
    ...prefetch.notAsked
      .filter(() => prefetch.reasons.includes("lastfm_unknown_mbid"))
      .filter((line) => line.startsWith("Last.fm artist tags"))
      .map((line) => `⚠️ ${line}`),
  ];
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
  const seeded = mergeResearch(
    mergeResearch(emptyResearch(), {
      ...prefetchData,
      noneFound: prefetch.none,
      notAsked: prefetch.notAsked,
    }),
    state.researchData ?? {},
  );

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
        // The steps already read are not offered again; the artist the identified recording
        // credits is the artist of every artist-level step.
        ranSteps: fixedSteps({
          recordingIdentified: recording !== null,
          lastfmUnread: {
            tags: unread.has("trackTags") || unread.has("artistTags"),
            similarTracks: unread.has("similarTracks"),
          },
        }),
        plannedSteps: researcherSteps({ recordingIdentified: own !== null }),
        ...(own ? { artistResolution: { status: "identified", verified: true, ...own } } : {}),
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

  // The subgraph's research starts with the pre-fetched data. Last.fm's artist-level data is
  // dropped when it cannot be this artist's (several artists share the name, or Last.fm keeps
  // one page for them), whichever step found that out.
  const mergedResearch = withoutUncertainArtistData(
    finalState.researchData ?? seeded,
    finalState.lastfmArtistUncertain ?? null,
  );
  // The subgraph's state starts with the pre-fetch errors; each source and code counts once.
  const sourceErrors = uniqueErrors([
    ...prefetchErrors,
    ...(finalState.sourceErrors ?? []),
    ...(isSourceError(failure) ? [errorRecord(sourceIdOf(failure.source), failure)] : []),
  ]);

  // The run's evidence: the primary sources' records, then the web search's results.
  const pack = await runEvidence(primary.run, finalState.webFindings ?? [], config, runtime);

  // Nothing is written for a cancelled run. Research is cached only when it is complete: not
  // when it stopped early, a source could not be read for a passing reason (an outage, a
  // timeout, a rate limit, a bad answer), or a planner call failed (the next run may find more,
  // as with audio that failed transiently). A source that is not configured is a lasting state:
  // it does not block the cache, its errors are stored with the research and reported on a hit,
  // and the cache key names the configured sources, so adding a key runs the research again.
  // The primary sources are not part of the cached research and their errors do not block it,
  // except a source that lost records to a failed request: the run is incomplete.
  config.signal?.throwIfAborted();
  const notConfigured = sourceErrors.filter((e) => e.code === "not_configured");
  const complete =
    !failure &&
    pack.lost.length === 0 &&
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
    : `Intelligence extraction complete: ${finalState.stepsRun ?? 0} layers processed`;
  writer?.({
    type: "status",
    code: failure ? "SYS-WARN" : "RESEARCH-FOUND",
    message: summary,
    node: "historian",
    timestamp: timestampOf(runtime),
  });

  return {
    // With this run's MusicBrainz sample relations (for the result built without the model);
    // they are not part of the cached research, which holds no primary record.
    researchData: mergeResearch(mergedResearch, { samples: pack.samples }),
    evidence: pack.evidence,
    isrcRecording: recording,
    usage: finalState.usage ?? [],
    // The primary sources' errors are the run's too; they do not block the research cache,
    // which does not hold their records.
    sourceErrors: uniqueErrors([...sourceErrors, ...pack.errors]),
    lastingSourceErrors: lastingAmong(pack.lasting, sourceErrors),
    statusMessages: [
      ...prefetchStatus,
      ...(finalState.statusMessages ?? []),
      ...pack.status,
      ...(failure ? [summary] : []),
    ],
  };
}

/**
 * The researcher's artist from the recording the ISRC identified: its credited artist (the
 * track's first artist among the credits, else the first credit), verified by the identification.
 */
function artistOf(recording: IdentifiedRecording, primary: string): ArtistRef | null {
  return artistFromCredit(recording.artists, primary);
}

/** Research without Last.fm's artist-level data, when `uncertain` says it is not this artist's. */
function withoutUncertainArtistData(
  research: ResearchData,
  uncertain: string | null,
): ResearchData {
  if (!uncertain) return research;
  const held =
    (research.lastfmArtistTags?.length ?? 0) > 0 ||
    (research.lastfmSimilarArtists?.length ?? 0) > 0 ||
    Boolean(research.lastfmArtistBio);
  return {
    ...research,
    lastfmArtistTags: [],
    lastfmSimilarArtists: [],
    lastfmArtistBio: undefined,
    notAsked: [
      ...(research.notAsked ?? []),
      ...(held ? [`Last.fm artist tags, similar artists and bio (dropped: ${uncertain})`] : []),
    ],
  };
}

/** The contract's id for a source; the audio service is not a research source. */
function sourceIdOf(source: SourceName): SourceId {
  return source === "audio" ? "deezer" : source;
}
