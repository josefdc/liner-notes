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
 *
 * Tool results are read by their type (`readToolResult`), never by their text: found data is
 * research; "nothing found" is recorded in `noneFound`; a source that could not be read is a
 * `sourceErrors` entry, its status line says so and the planner prompt shows it as unavailable.
 * Similar artists and tracks are kept by rank with their raw score and its scale. ListenBrainz
 * is asked about the track's own artist only (its MusicBrainz MBID, or its exact name).
 */

import { StateGraph, END, START, Annotation } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { ResearchPlanOutput } from "@liner-notes/contract";

import { answeredCall, failedCall } from "./callRecords.js";
import { isAbortError, withRetry } from "./errors.js";
import { plannerMessages, SOURCE_NAMES } from "./prompts.js";
import { type AgentRuntime, defaultAgentRuntime, runIdOf, timestampOf } from "./runtime.js";
import {
  formatResults,
  searchSamples,
  searchProductionHistory,
  searchMusicInfo,
  type WebResult,
} from "../sources/search.js";
import {
  getMusicBrainzRelations,
  getMusicBrainzArtist,
  isMbid,
  normalizeName,
} from "../sources/musicbrainz.js";
import {
  getLastfmTrackTags,
  getLastfmArtistTags,
  getLastfmSimilarTracks,
  getLastfmSimilarArtists,
  getLastfmArtistInfo,
} from "../sources/lastfm.js";
import { getListenBrainzSimilarArtists } from "../sources/listenbrainz.js";
import { errorRecord } from "../sources/records.js";
import { readToolResult } from "../sources/toolResult.js";
import type { SourceError, SourceId } from "@liner-notes/contract";
import type { SpotifyData, ResearchData, ResearchPlan, LlmCallRecord } from "./state.js";

export const PLANNER_CALL_SITE = "research_planner";
/** Output budget of a planner call, reasoning included (fast tier: low effort). */
export const PLANNER_MAX_OUTPUT_TOKENS = 1500;
/** Research steps chosen by the planner, after the fixed first step. */
export const MAX_PLANNED_STEPS = 2;
/** Wait before a search's one retry after a transient failure. */
export const SEARCH_RETRY_MS = 500;

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
      noneFound: [...(prev.noneFound || []), ...(next.noneFound || [])],
    }),
    default: () => emptyResearch(),
  }),

  // The track's own artist on MusicBrainz, once a MusicBrainz step identified it (from the
  // artist search by its exact name, or the recording's artist credit); ListenBrainz asks
  // about this artist only.
  artistMbid: Annotation<ArtistRef | null>({
    reducer: (prev, next) => next ?? prev,
    default: () => null,
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
      sourceErrors: state.sourceErrors,
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
// Reading the tools' results
// =============================================================================

/** The track's artist as research asks for it: the first credited artist, and all of them. */
export function trackArtists(spotify: SpotifyData): { primary: string; names: string[] } {
  const names = (spotify.artistNames ?? []).filter((n) => n.trim() !== "");
  return names.length > 0
    ? { primary: names[0], names }
    : { primary: spotify.artist, names: [spotify.artist] };
}

/** The artist's own MusicBrainz identity, as research found it. */
export interface ArtistRef {
  mbid: string;
  name: string;
}

/**
 * The track's own artist among a recording's credited artists: the credit named like the
 * primary artist, else the first credit (the recording search only matches recordings credited
 * to exactly the track's artists). Never a related or similar artist, never the recording's id.
 */
export function artistFromCredit(credits: unknown, primary: string): ArtistRef | null {
  const list = (Array.isArray(credits) ? credits : []).filter(
    (c): c is ArtistRef => isMbid(c?.mbid) && typeof c?.name === "string",
  );
  const wanted = normalizeName(primary);
  return list.find((c) => normalizeName(c.name) === wanted) ?? list[0] ?? null;
}

/** Tag lines ("name (count)"), each tag once (case-insensitive), `existing` first. */
export function mergeTags(existing: string[], tags: unknown): string[] {
  const seen = new Set(existing.map((t) => t.replace(/\s*\(\d+\)$/, "").toLowerCase()));
  const merged = [...existing];
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (typeof tag?.name !== "string" || seen.has(tag.name.toLowerCase())) continue;
    seen.add(tag.name.toLowerCase());
    merged.push(`${tag.name} (${Number(tag.count) || 0})`);
  }
  return merged;
}

const score = (value: unknown) => (Number(value) || 0).toFixed(2);

/**
 * Last.fm similar tracks by rank, with Last.fm's raw match value and its scale (0 to 1). Never a
 * percentage: the most similar track would always read "100 %".
 */
export function similarTrackLines(tracks: unknown): string[] {
  return (Array.isArray(tracks) ? tracks : [])
    .filter((t) => typeof t?.name === "string" && typeof t?.artist === "string")
    .map(
      (t, i) => `${i + 1}. ${t.name} by ${t.artist} (Last.fm match ${score(t.match)}, scale 0-1)`,
    );
}

/** Last.fm similar artists by rank, with Last.fm's raw match value and its scale (0 to 1). */
export function similarArtistLines(artists: unknown): string[] {
  return (Array.isArray(artists) ? artists : [])
    .filter((a) => typeof a?.name === "string")
    .map((a, i) => `${i + 1}. ${a.name} (Last.fm match ${score(a.match)}, scale 0-1)`);
}

/**
 * ListenBrainz similar artists by rank, with the dataset's raw score (shared listening
 * sessions; higher is more similar; no fixed maximum, so not a percentage).
 */
export function listenBrainzLines(artists: unknown, of: string): string[] {
  return (Array.isArray(artists) ? artists : [])
    .filter((a) => typeof a?.name === "string")
    .map(
      (a, i) =>
        `${i + 1}. ${a.name} (similar to ${of}; ListenBrainz score ${Number(a.score) || 0}, ` +
        "a count of shared listening sessions)",
    );
}

/** The label of an empty step, for `noneFound`. Written by code: never source text. */
const NONE_LABEL = {
  samples: "web search: sample history",
  production: "web search: production history",
  general: "web search: the planner's lead",
  relations: "MusicBrainz relationships of the recording",
  collaborators: "MusicBrainz collaborators of the artist",
  trackTags: "Last.fm track tags",
  artistTags: "Last.fm artist tags",
  similarTracks: "Last.fm similar tracks",
  similarArtists: "Last.fm similar artists",
  artistInfo: "Last.fm artist info",
  listenbrainz: "ListenBrainz similar artists",
} as const;
export type NoneLabel = keyof typeof NONE_LABEL;

/** What a tool's typed `reason` adds to an empty step's label. */
const REASON_NOTE: Record<string, string> = {
  ambiguous: "several matching recordings; none picked",
  artist_not_identified: "skipped: no MusicBrainz artist with exactly this name",
};

/** What a research step read: its data, the sources it could not read, the empty answers. */
export class StepReader {
  readonly errors: SourceError[] = [];
  readonly none: string[] = [];

  /** The data of a found result; null (recorded as an error or "nothing found") otherwise. */
  read<T extends object = Record<string, unknown>>(
    source: SourceId,
    raw: unknown,
    label: NoneLabel,
  ): T | null {
    const outcome = readToolResult<T>(source, raw);
    if (outcome.kind === "found") return outcome.data;
    if (outcome.kind === "failed") this.errors.push(outcome.error);
    else this.nothing(label, outcome.reason ? REASON_NOTE[outcome.reason] : undefined);
    return null;
  }

  /** Records a step whose source answered with nothing for the track. */
  nothing(label: NoneLabel, note?: string) {
    this.none.push(note ? `${NONE_LABEL[label]} (${note})` : NONE_LABEL[label]);
  }
}

/** One status line per source that could not be read: "⚠️ Last.fm could not be read (…)". */
export function unreadableStatus(errors: readonly SourceError[]): string[] {
  return uniqueErrors(errors).map(
    (e) => `⚠️ ${SOURCE_NAMES[e.source]} could not be read (${e.code})`,
  );
}

/** Source errors without repeats: one per source and code, the first message kept. */
export function uniqueErrors(errors: readonly SourceError[]): SourceError[] {
  const seen = new Set<string>();
  return errors.filter((e) => {
    const key = `${e.source}:${e.code}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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

function emptyResearch(): ResearchData {
  return {
    samples: [],
    productionTrivia: [],
    relatedArtists: [],
    collaborators: [],
    lastfmTags: [],
    lastfmSimilarTracks: [],
    lastfmSimilarArtists: [],
    lastfmArtistBio: undefined,
    listenbrainzSimilarArtists: [],
    noneFound: [],
  };
}

/** True when a step added anything to the research. */
function holdsData(data: ResearchData): boolean {
  return (
    Boolean(data.lastfmArtistBio) ||
    [
      data.samples,
      data.productionTrivia,
      data.relatedArtists,
      data.collaborators,
      data.lastfmTags,
      data.lastfmSimilarTracks,
      data.lastfmSimilarArtists,
      data.listenbrainzSimilarArtists,
    ].some((list) => (list?.length ?? 0) > 0)
  );
}

interface WebResults {
  results?: WebResult[];
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

  const { title, artist, album } = state.spotifyData;
  const { primary, names: artistNames } = trackArtists(state.spotifyData);
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

  interface Step {
    data: ResearchData;
    reader: StepReader;
    artist?: ArtistRef;
  }

  // One search attempt; its result is merged into the research by the appending reducer.
  const search = async (): Promise<Step> => {
    const newData = emptyResearch();
    const reader = new StepReader();
    const step: Step = { data: newData, reader };
    const webText = (raw: unknown, none: NoneLabel): string | null => {
      const found = reader.read<WebResults>("tavily", raw, none);
      const results = Array.isArray(found?.results) ? found.results : [];
      if (found && results.length === 0) reader.nothing(none);
      return results.length > 0 ? formatResults(results) : null;
    };

    switch (plan.nextAction) {
      case "search_samples": {
        config.signal?.throwIfAborted();
        const text = webText(
          await searchSamples.invoke({ songTitle: title, artistName: artist }, options),
          "samples",
        );
        if (text) newData.samples.push(text);
        break;
      }

      case "search_production": {
        config.signal?.throwIfAborted();
        const text = webText(
          await searchProductionHistory.invoke({ songTitle: title, artistName: artist }, options),
          "production",
        );
        if (text) newData.productionTrivia.push(text);
        break;
      }

      case "search_general": {
        // Use the custom query from the plan (for following leads)
        const query = plan.query || `${title} ${artist} music history`;
        config.signal?.throwIfAborted();
        // Classify general results as production trivia
        const text = webText(await searchMusicInfo.invoke({ query }, options), "general");
        if (text) newData.productionTrivia.push(text);
        break;
      }

      case "search_musicbrainz": {
        // Use MusicBrainz for structured genealogy data
        config.signal?.throwIfAborted();
        const mbData = reader.read<{
          genealogy?: { samples?: unknown[]; covers?: unknown[]; remixes?: unknown[] };
          artistCredit?: unknown;
        }>(
          "musicbrainz",
          await getMusicBrainzRelations.invoke(
            { title, artist, artistNames, ...(album ? { album } : {}) },
            options,
          ),
          "relations",
        );
        if (!mbData) break;
        const own = artistFromCredit(mbData.artistCredit, primary);
        if (own) step.artist = own;
        const { samples = [], covers = [], remixes = [] } = mbData.genealogy ?? {};
        if (samples.length > 0) {
          newData.samples.push(`[MusicBrainz Samples] ${JSON.stringify(samples)}`);
        }
        if (covers.length > 0) {
          newData.productionTrivia.push(`[MusicBrainz Covers] ${JSON.stringify(covers)}`);
        }
        if (remixes.length > 0) {
          newData.productionTrivia.push(`[MusicBrainz Remixes] ${JSON.stringify(remixes)}`);
        }
        if (samples.length + covers.length + remixes.length === 0) {
          reader.nothing("relations", "recording identified; no samples, covers or remixes");
        }
        break;
      }

      case "search_artist_collaborators": {
        // Use MusicBrainz to get artist collaborators (producers, writers)
        config.signal?.throwIfAborted();
        const artistData = reader.read<{
          mbid?: unknown;
          name?: unknown;
          collaborators?: Array<{ name?: unknown; relationship?: unknown }>;
        }>(
          "musicbrainz",
          await getMusicBrainzArtist.invoke({ artistName: artist, artistNames }, options),
          "collaborators",
        );
        if (!artistData) break;
        // findArtist matched this artist by its exact name: the track's own artist.
        if (isMbid(artistData.mbid) && typeof artistData.name === "string") {
          step.artist = { mbid: artistData.mbid, name: artistData.name };
        }
        const collaborators = (artistData.collaborators ?? []).filter(
          (c): c is { name: string; relationship: string } =>
            typeof c?.name === "string" && typeof c.relationship === "string",
        );
        if (collaborators.length === 0) {
          reader.nothing("collaborators");
          break;
        }
        newData.collaborators = collaborators.map((c) => `${c.name} (${c.relationship})`);
        newData.productionTrivia.push(
          `[MusicBrainz Artist] ${artist} collaborators: ${JSON.stringify(collaborators)}`,
        );
        break;
      }

      case "search_lastfm_tags": {
        // Fetch both track and artist tags in parallel
        config.signal?.throwIfAborted();
        const [trackTags, artistTags] = await Promise.all([
          getLastfmTrackTags.invoke({ title, artist }, options),
          getLastfmArtistTags.invoke({ artist }, options),
        ]);
        const track = reader.read<{ tags?: unknown }>("lastfm", trackTags, "trackTags");
        const byArtist = reader.read<{ tags?: unknown }>("lastfm", artistTags, "artistTags");
        newData.lastfmTags = mergeTags(mergeTags([], track?.tags), byArtist?.tags);
        break;
      }

      case "search_lastfm_similar_tracks": {
        config.signal?.throwIfAborted();
        const data = reader.read<{ tracks?: unknown }>(
          "lastfm",
          await getLastfmSimilarTracks.invoke({ title, artist }, options),
          "similarTracks",
        );
        newData.lastfmSimilarTracks = similarTrackLines(data?.tracks);
        break;
      }

      case "search_lastfm_similar_artists": {
        config.signal?.throwIfAborted();
        const data = reader.read<{ artists?: unknown }>(
          "lastfm",
          await getLastfmSimilarArtists.invoke({ artist }, options),
          "similarArtists",
        );
        newData.lastfmSimilarArtists = similarArtistLines(data?.artists);
        break;
      }

      case "search_lastfm_artist_info": {
        config.signal?.throwIfAborted();
        const data = reader.read<{ bio?: unknown; tags?: unknown; similarArtists?: unknown }>(
          "lastfm",
          await getLastfmArtistInfo.invoke({ artist }, options),
          "artistInfo",
        );
        if (!data) break;
        if (typeof data.bio === "string" && data.bio) {
          newData.lastfmArtistBio = data.bio;
          newData.productionTrivia.push(`[Last.fm Bio] ${data.bio}`);
        }
        const tagNames = (Array.isArray(data.tags) ? data.tags : [])
          .filter((t) => typeof t?.name === "string")
          .map((t) => t.name);
        if (tagNames.length > 0) newData.lastfmTags = [`[Artist Info] ${tagNames.join(", ")}`];
        // Artist info lists similar artists without a match value: names in Last.fm's order.
        newData.lastfmSimilarArtists = (
          Array.isArray(data.similarArtists) ? data.similarArtists : []
        )
          .filter((a) => typeof a?.name === "string")
          .map((a, i) => `${i + 1}. ${a.name} (Last.fm artist info; no match value)`);
        break;
      }

      case "search_listenbrainz_similar": {
        // Only the track's own artist: its MBID from an earlier MusicBrainz step, else its
        // exact name, which the tool resolves on MusicBrainz (and skips when it cannot).
        const own = state.artistMbid;
        config.signal?.throwIfAborted();
        const data = reader.read<{ artist?: { name?: unknown }; artists?: unknown }>(
          "listenbrainz",
          await getListenBrainzSimilarArtists.invoke(
            own
              ? { artistMbid: own.mbid, artistName: own.name }
              : { artistName: artist, artistNames },
            options,
          ),
          "listenbrainz",
        );
        const of =
          typeof data?.artist?.name === "string" ? data.artist.name : (own?.name ?? primary);
        newData.listenbrainzSimilarArtists = listenBrainzLines(data?.artists, of);
        break;
      }
    }
    newData.noneFound = reader.none;
    return step;
  };

  try {
    // At most one more attempt, for a transient failure only; no other retry wraps this one.
    const step = await withRetry(search, {
      maxAttempts: 2,
      initialInterval: SEARCH_RETRY_MS,
      signal: config.signal,
    });
    const errors = uniqueErrors(step.reader.errors);
    console.log(`✅ [Research Tool] Read ${plan.nextAction} (${errors.length} source errors)`);
    // The status says what happened: a source that could not be read is never "found".
    const warnings = unreadableStatus(errors);
    for (const message of warnings) {
      writer?.({ type: "status", message, node: "research_tool", timestamp: timestampOf(runtime) });
    }
    const status = [
      ...warnings,
      ...(holdsData(step.data)
        ? [`Found ${label} information`]
        : errors.length === 0
          ? [`Nothing found: ${label}`]
          : []),
    ];
    return {
      researchData: step.data,
      sourceErrors: errors,
      ...(step.artist ? { artistMbid: step.artist } : {}),
      statusMessages: status,
    };
  } catch (error) {
    // A cancelled run stops here; any other failure is recorded as the source's error and the
    // research goes on.
    if (config.signal?.aborted || isAbortError(error)) throw error;
    const record = errorRecord(ACTION_SOURCE[plan.nextAction], error);
    console.error(`❌ [Research Tool] Error in ${plan.nextAction}:`, record.message);
    return {
      sourceErrors: [record],
      statusMessages: [`⚠️ Search failed: ${label} (${record.code})`],
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
 * No node has a retry policy: the planner's transient failures are retried inside the provider
 * layer (a node retry would be another model call), and a search at most once by its node. A
 * failed search is a source error and the research goes on; only a cancelled run or a bug
 * leaves the subgraph as an error.
 */
export function createResearcherSubgraph(runtime: AgentRuntime = defaultAgentRuntime) {
  const workflow = new StateGraph(ResearcherState)
    .addNode("research_manager", createResearchManagerNode(runtime))
    .addNode("research_tool", createResearchToolNode(runtime))
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
