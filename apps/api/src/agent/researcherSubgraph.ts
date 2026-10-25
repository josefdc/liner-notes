/**
 * Deep Dive Researcher Subgraph
 *
 * The researcher's part of the run's research plan (research/plan.ts): its fixed steps
 * (`plannedSteps`: the sample history, and with an identified recording the production history,
 * ListenBrainz and the artist's collaborators), run together without a model, then up to
 * MAX_PLANNED_STEPS follow-ups chosen by the research planner, a model call on the `fast` tier
 * through the provider layer (schema `ResearchPlanOutput`). Each step runs one search; the
 * planner sees what was found. Every step runs at most once per run:
 * the steps the historian already read (`ranSteps`: Last.fm, the recording's MusicBrainz
 * relationships when the ISRC identified it) and the ones that ran here are not offered again,
 * and one the planner picks anyway is not run. The artist the identified recording credits
 * (`artistResolution`, set by the historian) is the artist of every artist-level step, by its
 * MusicBrainz id: no name search.
 *
 * A failed planner call ends the research (the run continues with what was found) and is
 * recorded in `usage` with its error kind. A cancelled run stops the research: the run's abort
 * signal goes to every planner call and every search.
 *
 * Tool results are read by their type (`readToolResult`), never by their text: found data is
 * research; "nothing found" is recorded in `noneFound`; a source that could not be read is a
 * `sourceErrors` entry, its status line says so and the planner prompt shows it as unavailable.
 * Similar artists and tracks are kept by rank with their raw score and its scale. ListenBrainz
 * is asked about the track's own artist only (its MusicBrainz MBID, or its exact name). The web
 * search's results are also kept as they were read (`webFindings`), for the run's web-tier
 * evidence.
 */

import { StateGraph, END, START, Annotation } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { ResearchPlanOutput } from "@liner-notes/contract";

import { answeredCall, failedCall } from "./callRecords.js";
import type { WebFinding } from "./research/evidencePack.js";
import {
  FIRST_STEP,
  FOLLOW_UP_TIER,
  isErrorPage,
  isPlaceholder,
  lastfmBio,
  MAX_FOLLOW_UPS,
  RAN_IN_RESEARCH,
  type RanStep,
  UNREAD_IN_RESEARCH,
  uniqueSteps,
} from "./research/plan.js";
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
  withoutFeatured,
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
import {
  INTERNAL_ERROR_PREFIX,
  type NotAskedReason,
  readToolResult,
} from "../sources/toolResult.js";
import type { SourceError, SourceId } from "@liner-notes/contract";
import {
  emptyResearch,
  type LlmCallRecord,
  mergeResearch,
  type ResearchData,
  type ResearchPlan,
  type SpotifyData,
} from "./state.js";

export const PLANNER_CALL_SITE = "research_planner";
/** Output budget of a planner call, reasoning included (fast tier: low effort). */
export const PLANNER_MAX_OUTPUT_TOKENS = 1500;
/** Research steps chosen by the planner, after the fixed steps (`plannedSteps`). */
export const MAX_PLANNED_STEPS = MAX_FOLLOW_UPS;
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
    reducer: mergeResearch,
    default: emptyResearch,
  }),

  // The track's own artist, resolved at most once per run: identified (by MusicBrainz's link to
  // the Spotify artist, the recording's credit, or a single exact-name match, which is
  // unverified), or not identified and why. Every artist-level step reads it.
  artistResolution: Annotation<ArtistResolution | null>({
    reducer: (prev, next) => next ?? prev,
    default: () => null,
  }),

  // Set when Last.fm's artist-level data cannot be this artist's (several artists share the
  // name, or Last.fm keeps one page for them): the reason, as a label.
  lastfmArtistUncertain: Annotation<string | null>({
    reducer: (prev, next) => next ?? prev,
    default: () => null,
  }),

  // The steps that already ran this run, each with why: the historian's (Last.fm, the
  // recording's MusicBrainz relationships when the ISRC identified it) and this research's. A
  // step runs at most once per run.
  ranSteps: Annotation<RanStep[]>({
    reducer: (prev, next) => uniqueSteps([...prev, ...next]),
    default: () => [],
  }),

  // The research's fixed steps, run together before any follow-up, without a model call (the
  // historian sets them from the run's plan; alone, the sample history).
  plannedSteps: Annotation<Array<RanStep["action"]>>({
    reducer: (_, next) => next,
    default: () => [FIRST_STEP],
  }),

  // The fixed steps the tool node runs next, together; empty once they ran.
  pendingPlans: Annotation<ResearchPlan[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  // How many steps were asked of a source (a step not asked again is not counted).
  stepsRun: Annotation<number>({
    reducer: (prev, next) => prev + next,
    default: () => 0,
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

  // The web search's results as it read them, and when: the historian builds the run's
  // web-tier evidence from them (research/evidencePack.ts).
  webFindings: Annotation<WebFinding[]>({
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

    // The fixed steps, together, without a model call
    if (iteration === 0) {
      status("🔬 Starting deep dive research...");
      const taken = new Set(state.ranSteps.map((step) => step.action));
      const plans: ResearchPlan[] = state.plannedSteps
        .filter((action) => !taken.has(action))
        .map((action) => ({
          nextAction: action,
          query: null,
          reasoning:
            action === FIRST_STEP
              ? "Starting research with sample history to discover musical DNA"
              : "Part of the research plan for this track",
        }));
      return {
        ...(plans.length > 0 ? { researchPlan: plans[0], pendingPlans: plans } : {}),
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
      ran: state.ranSteps,
    });
    let plan: ResearchPlan;
    let call: LlmCallRecord;
    try {
      const result = await runtime.llm.invoke(
        PLANNER_CALL_SITE,
        FOLLOW_UP_TIER,
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
      const failed = failedCall(PLANNER_CALL_SITE, FOLLOW_UP_TIER, error);
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

/** The track's artists and title as research asks for them. */
export interface TrackQuery {
  /** The first credited artist: artist-level questions are about this artist. */
  primary: string;
  /** The credited artists one by one, when known; else the one name Spotify gave. */
  names: string[];
  /** The primary artist's Spotify id, when known (tells artists of the same name apart). */
  spotifyArtistId: string | undefined;
  /** The title without a featured-artist note ("Song (feat. X)" → "Song"). */
  title: string;
}

/**
 * The track as research asks for it. Without the separate artist names (e.g. a track picked from
 * candidates whose details could not be read), Spotify's string is searched as one name: it
 * cannot be split, since a comma also occurs inside names ("Earth, Wind & Fire").
 */
export function trackQuery(spotify: SpotifyData): TrackQuery {
  const names = (spotify.artistNames ?? []).filter((n) => n.trim() !== "");
  const known = names.length > 0 ? names : [spotify.artist];
  const id = spotify.artistIds?.[0];
  return {
    primary: known[0],
    names: known,
    spotifyArtistId: id && id.trim() !== "" ? id : undefined,
    title: withoutFeatured(spotify.title, known) || spotify.title,
  };
}

/** The artist's own MusicBrainz identity, as research found it. */
export interface ArtistRef {
  mbid: string;
  name: string;
}

/**
 * The track's artist as this run resolved it, at most once: identified (`verified` when
 * MusicBrainz links it to the track's Spotify artist, or it is the identified recording's
 * credit; else a single exact-name match), or not identified and why.
 */
export type ArtistResolution =
  | ({ status: "identified"; verified: boolean } & ArtistRef)
  | { status: "not_identified"; reason: NotAskedReason };

/** How a research line says its artist was matched by name only. */
const UNVERIFIED = "artist matched by name only, not linked to the Spotify artist";

/** Why Last.fm's artist-level data may not be this artist's. */
const UNCERTAIN = {
  ambiguous: "several MusicBrainz artists have this name and none is linked to the Spotify artist",
  shared: "Last.fm keeps one page for several artists of this name",
} as const;

/** The artist reasons that end the resolution for the run. */
const UNRESOLVED: ReadonlySet<NotAskedReason> = new Set([
  "ambiguous_artist",
  "artist_not_identified",
  "other_spotify_artist",
  "no_input",
]);

/**
 * The track's own artist among a recording's credited artists: the credit whose name (as
 * credited, or the artist's MusicBrainz name) is the track's first artist, else the first credit
 * (the recording search only matches recordings credited to exactly the track's artists). Never
 * a related or similar artist, never the recording's id.
 */
export function artistFromCredit(credits: unknown, primary: string): ArtistRef | null {
  const list = (Array.isArray(credits) ? credits : []).filter(
    (c): c is ArtistRef & { credited?: unknown } => isMbid(c?.mbid) && typeof c?.name === "string",
  );
  const wanted = normalizeName(primary);
  const named = (c: ArtistRef & { credited?: unknown }) =>
    normalizeName(c.name) === wanted ||
    (typeof c.credited === "string" && normalizeName(c.credited) === wanted);
  const own = list.find(named) ?? list[0];
  return own ? { mbid: own.mbid, name: own.name } : null;
}

/** Tag lines ("name (count)"), each tag once (case-insensitive), `existing` first. */
export function mergeTags(existing: string[], tags: unknown): string[] {
  const seen = new Set(existing.map((t) => t.replace(/\s*\(\d+\)$/, "").toLowerCase()));
  const merged = [...existing];
  for (const tag of Array.isArray(tags) ? tags : []) {
    if (typeof tag?.name !== "string" || !tag.name.trim() || seen.has(tag.name.toLowerCase())) {
      continue;
    }
    seen.add(tag.name.toLowerCase());
    merged.push(`${tag.name} (${Number(tag.count) || 0})`);
  }
  return merged;
}

const score = (value: unknown) => (Number(value) || 0).toFixed(2);

/**
 * Last.fm similar tracks by rank, with Last.fm's match value, which is relative to its closest
 * match (that one is 1). Never a percentage, and never read as an absolute similarity.
 */
export function similarTrackLines(tracks: unknown): string[] {
  return (Array.isArray(tracks) ? tracks : [])
    .filter((t) => typeof t?.name === "string" && typeof t?.artist === "string")
    .map(
      (t, i) =>
        `${i + 1}. ${t.name} by ${t.artist} (Last.fm match ${score(t.match)}, ` +
        "relative to its closest match = 1)",
    );
}

/** ", MusicBrainz <id>" when the source gave the artist's MBID (artists of one name stay apart). */
const mbidNote = (mbid: unknown) => (isMbid(mbid) ? `, MusicBrainz ${mbid}` : "");

/** Last.fm similar artists by rank, with Last.fm's match value relative to its closest match. */
export function similarArtistLines(artists: unknown): string[] {
  return (Array.isArray(artists) ? artists : [])
    .filter((a) => typeof a?.name === "string")
    .map(
      (a, i) =>
        `${i + 1}. ${a.name} (Last.fm match ${score(a.match)}, relative to its closest match = 1${mbidNote(a.mbid)})`,
    );
}

/**
 * ListenBrainz similar artists by rank, with the raw co-listening score of its similar-artists
 * dataset (higher is more similar; no fixed maximum, so not a percentage).
 */
export function listenBrainzLines(artists: unknown, of: string): string[] {
  return (Array.isArray(artists) ? artists : [])
    .filter((a) => typeof a?.name === "string")
    .map(
      (a, i) =>
        `${i + 1}. ${a.name} (similar to ${of}; ListenBrainz co-listening score ` +
        `${Number(a.score) || 0}, higher is more similar, no fixed maximum${mbidNote(a.mbid)})`,
    );
}

/** The label of a step for `noneFound` and `notAsked`. Written by code: never source text. */
const STEP_LABEL = {
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
export type NoneLabel = keyof typeof STEP_LABEL;

/**
 * Tool reasons that mean the source was not asked, or could not identify the track or artist:
 * no answer either way, so never "nothing found". Any other reason is the source's empty answer.
 */
const NOT_ASKED: Record<NotAskedReason, string> = {
  no_input: "not asked: no name to ask for",
  ambiguous: "not identified: several matching recordings, none picked",
  ambiguous_artist:
    "not asked: several MusicBrainz artists have this name and none is linked to the Spotify artist",
  artist_not_identified: "not asked: no MusicBrainz artist with exactly this name",
  other_spotify_artist:
    "not asked: the MusicBrainz artist of this name links to another Spotify artist",
  invalid_request: "not answered: Last.fm refused the request",
  other_artist: "dropped: Last.fm answered for another artist",
  shared_page: "dropped: Last.fm keeps one page for several artists of this name",
  lastfm_unknown_mbid:
    "not asked: Last.fm does not know this artist's MusicBrainz id, and the name alone may be another artist's",
};

const isNotAsked = (reason: string | null): reason is NotAskedReason =>
  reason !== null && Object.hasOwn(NOT_ASKED, reason);

/** What a research step read: its data, the sources it could not read, the empty answers. */
export class StepReader {
  readonly errors: SourceError[] = [];
  readonly none: string[] = [];
  readonly notAsked: string[] = [];
  /** The sources that refused their key. */
  readonly rejected = new Set<SourceId>();
  /** The not-asked reasons of this step's results. */
  readonly reasons: NotAskedReason[] = [];

  /** The data of a found result; null (recorded as an error, empty or not asked) otherwise. */
  read<T extends object = Record<string, unknown>>(
    source: SourceId,
    raw: unknown,
    label: NoneLabel,
  ): T | null {
    const outcome = readToolResult<T>(source, raw);
    if (outcome.kind === "found") return outcome.data;
    if (outcome.kind === "failed") {
      this.errors.push(outcome.error);
      if (outcome.keyRejected) this.rejected.add(outcome.error.source);
      // Another source failing (MusicBrainz, while ListenBrainz resolves a name) means this
      // step's own source was never asked.
      if (outcome.error.source !== source) {
        this.notAsked.push(
          `${STEP_LABEL[label]} (not asked: ${SOURCE_NAMES[outcome.error.source]} could not be read)`,
        );
      }
    } else if (isNotAsked(outcome.reason)) this.skip(label, outcome.reason);
    else this.nothing(label);
    return null;
  }

  /** Records a step that was not asked, or whose source could not identify the track. */
  skip(label: NoneLabel, reason: NotAskedReason) {
    this.reasons.push(reason);
    this.notAsked.push(`${STEP_LABEL[label]} (${NOT_ASKED[reason]})`);
  }

  /** Records a step whose source answered with nothing for the track. */
  nothing(label: NoneLabel, note?: string) {
    this.none.push(note ? `${STEP_LABEL[label]} (${note})` : STEP_LABEL[label]);
  }
}

/**
 * One status line per source that could not be read: "⚠️ Last.fm could not be read (…)",
 * "⚠️ Last.fm key rejected (…)" for a key the source refused, or, for a bug in our own reader
 * (an internal error), that the reader failed: the source is not to blame.
 */
export function unreadableStatus(
  errors: readonly SourceError[],
  rejected: ReadonlySet<SourceId> = new Set(),
): string[] {
  return uniqueErrors(errors).map((e) =>
    rejected.has(e.source)
      ? `⚠️ ${SOURCE_NAMES[e.source]} key rejected: fix the key (${e.code})`
      : e.message?.startsWith(INTERNAL_ERROR_PREFIX)
        ? `⚠️ ${SOURCE_NAMES[e.source]}: our reader failed on its answer (internal error)`
        : `⚠️ ${SOURCE_NAMES[e.source]} could not be read (${e.code})`,
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

/**
 * Runs the pending fixed steps together, or the planner's step; their updates as one. A step's
 * own failure is its source error, so one step never takes the others down.
 */
async function researchToolNode(
  state: ResearcherStateType,
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime,
): Promise<Partial<ResearcherStateType>> {
  const plans = state.pendingPlans.length > 0 ? state.pendingPlans : [state.researchPlan];
  // The warnings already sent by a step of this batch ("Web search could not be read").
  const warned = new Set<string>();
  const updates = await Promise.all(
    plans.map((plan) => researchStep(state, plan, config, runtime, warned)),
  );
  return { ...combineSteps(updates), pendingPlans: [] };
}

/** The updates of steps run together, as one update (the channels' own merge rules). */
export function combineSteps(
  updates: Array<Partial<ResearcherStateType>>,
): Partial<ResearcherStateType> {
  if (updates.length === 1) return updates[0];
  const out: Partial<ResearcherStateType> & {
    researchData: ResearchData;
    ranSteps: RanStep[];
    sourceErrors: SourceError[];
    webFindings: WebFinding[];
    statusMessages: string[];
    stepsRun: number;
  } = {
    researchData: emptyResearch(),
    ranSteps: [],
    sourceErrors: [],
    webFindings: [],
    statusMessages: [],
    stepsRun: 0,
  };
  for (const update of updates) {
    if (update.researchData)
      out.researchData = mergeResearch(out.researchData, update.researchData);
    out.ranSteps.push(...(update.ranSteps ?? []));
    out.sourceErrors.push(...(update.sourceErrors ?? []));
    out.webFindings.push(...(update.webFindings ?? []));
    out.statusMessages.push(...(update.statusMessages ?? []));
    out.stepsRun += update.stepsRun ?? 0;
    if (update.artistResolution) out.artistResolution = update.artistResolution;
    if (update.lastfmArtistUncertain) out.lastfmArtistUncertain = update.lastfmArtistUncertain;
    if (update.researchComplete) out.researchComplete = true;
  }
  return out;
}

/** True when a step added anything to the research. */
function holdsData(data: ResearchData): boolean {
  return (
    Boolean(data.lastfmArtistBio) ||
    [
      data.samples,
      data.productionTrivia,
      data.collaborators,
      data.lastfmTags,
      data.lastfmArtistTags,
      data.lastfmSimilarTracks,
      data.lastfmSimilarArtists,
      data.listenbrainzSimilarArtists,
    ].some((list) => (list?.length ?? 0) > 0)
  );
}

interface WebResults {
  results?: WebResult[];
}

async function researchStep(
  state: ResearcherStateType,
  plan: ResearchPlan | null,
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime,
  warned: Set<string> = new Set(),
): Promise<Partial<ResearcherStateType>> {
  const writer = config.writer;

  if (!plan || plan.nextAction === "done" || !state.spotifyData) {
    return { researchComplete: true };
  }

  // The recording search strips a featured-artist note itself, against the credited artists.
  const { album, title: fullTitle } = state.spotifyData;
  // Every question is about the first credited artist and the title without a featured-artist
  // note: the joined Spotify string is no artist, and a quoted search for it finds nothing.
  const query = trackQuery(state.spotifyData);
  const { primary, names: artistNames, spotifyArtistId, title } = query;
  // A web result naming the track or its artist is about it, whatever its title looks like.
  const searched = { title, artist: primary };
  const resolution = state.artistResolution;
  const known = resolution?.status === "identified" ? resolution : null;
  const uncertain = state.lastfmArtistUncertain;
  const research = state.researchData;
  const label = actionLabel(plan.nextAction);

  // A step runs at most once per run: one that already ran (here or in the historian) is not
  // asked again, and costs the planner its step.
  const ran = state.ranSteps.find((step) => step.action === plan.nextAction);
  if (ran) {
    const message = `⏭️ Not asked again: ${label} (${ran.why})`;
    writer?.({ type: "status", message, node: "research_tool", timestamp: timestampOf(runtime) });
    return { statusMessages: [message] };
  }
  const action = plan.nextAction;
  /** This step, as it ran: it is not offered again, and its reason says how it went. */
  const ranAs = (unread: boolean): RanStep[] => [
    { action, why: unread ? UNREAD_IN_RESEARCH : RAN_IN_RESEARCH },
  ];
  // Last.fm's artist-level data is asked by the artist's MusicBrainz id when the run verified it.
  const artistMbid = known?.verified ? { mbid: known.mbid } : {};
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
    /** The web search's results, for the run's web-tier evidence. */
    web: WebFinding[];
    /** How many web results were kept, and left out (an error page, no text). */
    webKept: number;
    webLeftOut: number;
    resolution?: ArtistResolution;
    lastfmUncertain?: string;
  }

  // One search attempt; its result is merged into the research by the appending reducer.
  const search = async (): Promise<Step> => {
    const newData = emptyResearch();
    const reader = new StepReader();
    const step: Step = { data: newData, reader, web: [], webKept: 0, webLeftOut: 0 };
    const webText = (raw: unknown, none: NoneLabel): string | null => {
      const found = reader.read<WebResults>("tavily", raw, none);
      // Each result is judged on its own: one without text or that is an error page ("404 Not
      // Found") is no answer, and the others are kept.
      const all = Array.isArray(found?.results) ? found.results : [];
      const results = all.filter((r) => !isPlaceholder(r?.content) && !isErrorPage(r, searched));
      step.webKept += results.length;
      step.webLeftOut += all.length - results.length;
      if (found && results.length === 0) {
        reader.nothing(
          none,
          all.length > 0 ? "every result was an error page or had no text" : undefined,
        );
      }
      const retrievedAt = timestampOf(runtime);
      for (const result of results) step.web.push({ result, retrievedAt, track: searched });
      return results.length > 0 ? formatResults(results) : null;
    };
    /** The artist did not resolve: the run asks no artist-level question about it again. */
    const unresolved = (label: NoneLabel): boolean => {
      if (resolution?.status !== "not_identified") return false;
      reader.skip(label, resolution.reason);
      return true;
    };
    /** Records how the artist resolved, from a tool's not-asked reasons. */
    const resolvedFrom = () => {
      const reason = reader.reasons.find((r) => UNRESOLVED.has(r));
      if (reason) step.resolution = { status: "not_identified", reason };
      if (reason === "ambiguous_artist") step.lastfmUncertain = UNCERTAIN.ambiguous;
    };
    /** Last.fm's artist-level data cannot be this artist's: not asked. */
    const lastfmUnsure = (label: NoneLabel): boolean => {
      if (!uncertain) return false;
      reader.notAsked.push(`${STEP_LABEL[label]} (not asked: ${uncertain})`);
      return true;
    };

    switch (plan.nextAction) {
      case "search_samples": {
        config.signal?.throwIfAborted();
        const text = webText(
          await searchSamples.invoke({ songTitle: title, artistName: primary }, options),
          "samples",
        );
        if (text) newData.samples.push(text);
        break;
      }

      case "search_production": {
        config.signal?.throwIfAborted();
        const text = webText(
          await searchProductionHistory.invoke({ songTitle: title, artistName: primary }, options),
          "production",
        );
        if (text) newData.productionTrivia.push(text);
        break;
      }

      case "search_general": {
        // Use the custom query from the plan (for following leads)
        const lead = plan.query || `${title} ${primary} music history`;
        config.signal?.throwIfAborted();
        // Classify general results as production trivia
        const text = webText(await searchMusicInfo.invoke({ query: lead }, options), "general");
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
            {
              title: fullTitle,
              artist: primary,
              artistNames,
              ...(album ? { album } : {}),
            },
            options,
          ),
          "relations",
        );
        if (!mbData) break;
        // The identified recording's credit names the artist: verified, and it settles an
        // earlier name-only match.
        const own = artistFromCredit(mbData.artistCredit, primary);
        if (own && !known?.verified)
          step.resolution = { status: "identified", verified: true, ...own };
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
        if (unresolved("collaborators")) break;
        config.signal?.throwIfAborted();
        const artistData = reader.read<{
          mbid?: unknown;
          name?: unknown;
          verified?: unknown;
          collaborators?: Array<{ name?: unknown; relationship?: unknown }>;
        }>(
          "musicbrainz",
          await getMusicBrainzArtist.invoke(
            {
              artistName: primary,
              artistNames,
              ...(known ? { artistMbid: known.mbid } : {}),
              ...(spotifyArtistId ? { spotifyArtistId } : {}),
            },
            options,
          ),
          "collaborators",
        );
        resolvedFrom();
        if (!artistData) break;
        const of = typeof artistData.name === "string" ? artistData.name : primary;
        const verified = artistData.verified === true || known?.verified === true;
        if (isMbid(artistData.mbid)) {
          step.resolution = { status: "identified", mbid: artistData.mbid, name: of, verified };
        }
        const collaborators = (artistData.collaborators ?? []).filter(
          (c): c is { name: string; relationship: string } =>
            typeof c?.name === "string" && typeof c.relationship === "string",
        );
        if (collaborators.length === 0) {
          reader.nothing("collaborators");
          break;
        }
        const list = JSON.stringify(collaborators);
        if (!verified) {
          // A single exact-name match: kept as source material that says so, never as the
          // artist's collaborators (no card is built from it).
          newData.productionTrivia.push(
            `[MusicBrainz Artist] ${of} (${UNVERIFIED}) collaborators: ${list}`,
          );
          break;
        }
        newData.collaborators = collaborators.map((c) => `${c.name} (${c.relationship})`);
        newData.collaboratorsOf = of;
        newData.productionTrivia.push(`[MusicBrainz Artist] ${of} collaborators: ${list}`);
        break;
      }

      case "search_lastfm_tags": {
        // Track tags, and the artist's unless Last.fm's artist page cannot be this artist's.
        config.signal?.throwIfAborted();
        const [trackTags, artistTags] = await Promise.all([
          getLastfmTrackTags.invoke({ title, artist: primary }, options),
          uncertain
            ? null
            : getLastfmArtistTags.invoke({ artist: primary, ...artistMbid }, options),
        ]);
        const track = reader.read<{ tags?: unknown }>("lastfm", trackTags, "trackTags");
        newData.lastfmTags = mergeTags([], track?.tags);
        if (lastfmUnsure("artistTags")) break;
        const byArtist = reader.read<{ tags?: unknown }>("lastfm", artistTags, "artistTags");
        newData.lastfmArtistTags = mergeTags([], byArtist?.tags);
        break;
      }

      case "search_lastfm_similar_tracks": {
        config.signal?.throwIfAborted();
        const data = reader.read<{ tracks?: unknown }>(
          "lastfm",
          await getLastfmSimilarTracks.invoke({ title, artist: primary }, options),
          "similarTracks",
        );
        newData.lastfmSimilarTracks = similarTrackLines(data?.tracks);
        break;
      }

      case "search_lastfm_similar_artists": {
        if (lastfmUnsure("similarArtists")) break;
        config.signal?.throwIfAborted();
        const data = reader.read<{ artists?: unknown }>(
          "lastfm",
          await getLastfmSimilarArtists.invoke({ artist: primary, ...artistMbid }, options),
          "similarArtists",
        );
        newData.lastfmSimilarArtists = similarArtistLines(data?.artists);
        break;
      }

      case "search_lastfm_artist_info": {
        if (lastfmUnsure("artistInfo")) break;
        config.signal?.throwIfAborted();
        const data = reader.read<{ bio?: unknown; tags?: unknown; similarArtists?: unknown }>(
          "lastfm",
          await getLastfmArtistInfo.invoke({ artist: primary, ...artistMbid }, options),
          "artistInfo",
        );
        if (reader.reasons.includes("shared_page")) step.lastfmUncertain = UNCERTAIN.shared;
        if (!data) break;
        // A bio that is only Last.fm's "Read more" link is no bio.
        const bio = lastfmBio(data.bio);
        if (bio) newData.lastfmArtistBio = bio;
        // Tags already read for the track or the artist are not added again.
        const held = [...(research.lastfmTags ?? []), ...(research.lastfmArtistTags ?? [])];
        newData.lastfmArtistTags = mergeTags(held, data.tags).slice(held.length);
        // Artist info lists similar artists without a match value: names in Last.fm's order,
        // only when the ranked list with match values was not read.
        if ((research.lastfmSimilarArtists?.length ?? 0) === 0) {
          newData.lastfmSimilarArtists = (
            Array.isArray(data.similarArtists) ? data.similarArtists : []
          )
            .filter((a) => typeof a?.name === "string")
            .map(
              (a, i) =>
                `${i + 1}. ${a.name} (Last.fm artist info; no match value${mbidNote(a.mbid)})`,
            );
        }
        const similar = newData.lastfmSimilarArtists?.length ?? 0;
        if (!bio && newData.lastfmArtistTags.length + similar === 0) {
          reader.nothing("artistInfo", "nothing that was not already read");
        }
        break;
      }

      case "search_listenbrainz_similar": {
        // Only the track's own artist, resolved once per run: its MBID when known, else its
        // name, which the tool resolves on MusicBrainz (through the Spotify link first).
        if (unresolved("listenbrainz")) break;
        config.signal?.throwIfAborted();
        const data = reader.read<{
          artist?: { mbid?: unknown; name?: unknown; verified?: unknown };
          artists?: unknown;
        }>(
          "listenbrainz",
          await getListenBrainzSimilarArtists.invoke(
            known
              ? { artistMbid: known.mbid, artistName: known.name }
              : {
                  artistName: primary,
                  artistNames,
                  ...(spotifyArtistId ? { spotifyArtistId } : {}),
                },
            options,
          ),
          "listenbrainz",
        );
        resolvedFrom();
        const of =
          typeof data?.artist?.name === "string" ? data.artist.name : (known?.name ?? primary);
        const verified = known ? known.verified : data?.artist?.verified === true;
        if (!known && isMbid(data?.artist?.mbid)) {
          step.resolution = { status: "identified", mbid: data.artist.mbid, name: of, verified };
        }
        newData.listenbrainzSimilarArtists = listenBrainzLines(
          data?.artists,
          verified ? of : `${of} (${UNVERIFIED})`,
        );
        break;
      }
    }
    newData.noneFound = reader.none;
    newData.notAsked = reader.notAsked;
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
    // The status says what happened: a source that could not be read is never "found". Steps
    // run together say a source's warning once.
    const warnings = unreadableStatus(errors, step.reader.rejected).filter(
      (message) => !warned.has(message) && Boolean(warned.add(message)),
    );
    for (const message of warnings) {
      writer?.({ type: "status", message, node: "research_tool", timestamp: timestampOf(runtime) });
    }
    // A step whose source was not asked, or could not identify the track, did not find
    // "nothing": it has its own status, which says why when Last.fm was not asked by name.
    const unknownMbid = step.reader.reasons.includes("lastfm_unknown_mbid");
    const empty = unknownMbid
      ? `Not asked: ${label} (${NOT_ASKED.lastfm_unknown_mbid.replace(/^not asked: /, "")})`
      : step.reader.none.length === 0 && step.reader.notAsked.length > 0
        ? `Not asked or not identified: ${label}`
        : `Nothing found: ${label}`;
    // A web step says how many results it kept when it left some out.
    const kept =
      step.webLeftOut > 0
        ? ` (${step.webKept} web results kept, ${step.webLeftOut} left out: error pages or no text)`
        : "";
    const status = [
      ...warnings,
      ...(holdsData(step.data)
        ? [`Found ${label} information${kept}`]
        : errors.length === 0
          ? [empty]
          : []),
    ];
    return {
      researchData: step.data,
      ranSteps: ranAs(errors.length > 0 && !holdsData(step.data)),
      stepsRun: 1,
      sourceErrors: errors,
      ...(step.web.length > 0 ? { webFindings: step.web } : {}),
      ...(step.resolution ? { artistResolution: step.resolution } : {}),
      ...(step.lastfmUncertain ? { lastfmArtistUncertain: step.lastfmUncertain } : {}),
      statusMessages: status,
    };
  } catch (error) {
    // A cancelled run stops here; any other failure is recorded as the source's error and the
    // research goes on.
    if (config.signal?.aborted || isAbortError(error)) throw error;
    const record = errorRecord(ACTION_SOURCE[plan.nextAction], error);
    console.error(`❌ [Research Tool] Error in ${plan.nextAction}:`, record.message);
    return {
      ranSteps: ranAs(true),
      stepsRun: 1,
      sourceErrors: [record],
      // A bug in our own reader says so: the source is not to blame.
      statusMessages: [
        record.message?.startsWith(INTERNAL_ERROR_PREFIX)
          ? `⚠️ Search failed: ${label} (internal error in our reader)`
          : `⚠️ Search failed: ${label} (${record.code})`,
      ],
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
