/**
 * Agent State Definition
 *
 * Defines the state that flows through the LangGraph workflow.
 * Maps to the frontend TrackData interface.
 */

import { randomUUID } from "node:crypto";
import { Annotation } from "@langchain/langgraph";
import type {
  AudioFeatures,
  Claim,
  Evidence,
  PreviewMatch,
  ResearchPlanOutput,
  SourceError,
} from "@liner-notes/contract";
import type { z } from "zod";
import type { LlmTier } from "../config/settings.js";
import type { LlmErrorKind } from "../llm/errors.js";
import type { PreviewSourceMatch } from "../sources/audio.js";
import type { IdentifiedRecording } from "../sources/identity.js";
import { isPlaceholder, lastfmBio } from "./research/plan.js";
import type { PrimaryRelation } from "./research/relations.js";
import type { SearchCandidate, TrackData } from "./schema.js";
import type { QueryMatch } from "./trackMatch.js";

// =============================================================================
// TypeScript Interfaces (matching frontend types)
// =============================================================================

/** A section of the song structure, in percent of the track. The web picks its colours. */
export interface SongSegment {
  label: string;
  start: number; // percentage 0-100
  end: number; // percentage 0-100
}

export interface FactoidEntity {
  id: string;
  text: string;
  type: "synth" | "producer" | "sample" | "technique" | "artist" | "album" | "year";
  searchQuery?: string;
}

export interface Factoid {
  id: string;
  title: string;
  content: string;
  type: "production" | "trivia" | "credits" | "sample" | "curiosity" | "connection";
  /** Clickable entities mentioned in the factoid (artists, songs, albums) */
  entities?: FactoidEntity[];
}

export interface Sample {
  time: number;
  description: string;
}

export interface ProductionCredits {
  producers: string[];
  writers: string[];
  engineers?: string[];
  label?: string;
}

export interface GenealogyNode {
  id: string;
  group: number;
  label: string;
  img: string;
  size: number;
  // Audio preview for hover-to-play
  previewUrl?: string;
  spotifyId?: string;
  // Parsed metadata for navigation
  trackTitle?: string;
  trackArtist?: string;
}

export interface GenealogyLink {
  source: string;
  target: string;
  value: number;
  // Semantic relationship type
  type?: "sample" | "cover" | "remix" | "producer" | "influence";
}

// =============================================================================
// Intermediate Data Types (collected during workflow)
// =============================================================================

export interface SpotifyData {
  id: string;
  title: string;
  artist: string;
  /**
   * The credited artists one by one (`artist` joins them with ", ", which cannot be told apart
   * from a comma in one name). Missing on data read before it was recorded.
   */
  artistNames?: string[];
  artistIds: string[];
  album: string;
  releaseDate: string;
  coverUrl: string;
  /**
   * Spotify's popularity score (0-100). Spotify no longer gives it to this app, so it is
   * missing on new data; never filled with a default.
   */
  popularity?: number;
  /** The recording's ISRC from Spotify; null or missing when Spotify gave none. */
  isrc?: string | null;
  duration: string;
  /** 0 when Spotify did not give a duration. */
  durationMs: number;
  /** null when unknown (e.g. a track picked from candidates whose details could not be read). */
  explicit: boolean | null;
  spotifyUrl: string;
  previewUrl: string | null;
}

export interface KeyMoment {
  time: number; // Time in seconds
  type: "energy_peak" | "energy_drop" | "onset" | "harmonic_change" | "silence";
  intensity: number; // 0-1 scale
  description: string;
}

/**
 * Why measured audio values are missing:
 * - no_preview: no preview clip of the chosen recording was found (by its ISRC on Deezer, as
 *   Spotify's own clip, or as a Deezer search result that is strictly the same recording)
 * - preview_rejected: the preview URL is not on an allowed audio CDN host
 * - service_unavailable: the audio analysis service did not answer its health check
 * - analysis_failed: the service was reached but the analysis failed, or its answer carried no
 *   v2 block the contract reads (an older service that sends only the v1 fields)
 * - not_detected: the analysis ran but found no tempo or no key (e.g. unpitched audio), or its
 *   gate measured nothing (silence, noise, too short: the block says which)
 * - not_run: audio analysis did not run for this track
 * - preview_lookup_incomplete: Spotify has no clip of the track and the lookup on Deezer could
 *   not be finished: a request was not sent (its pace had no slot in time, sources/pacing.ts) or
 *   Deezer could not be read. Whether a clip exists is unknown, so this is never "no_preview"
 *   (every request answered, no clip), and the result is not stored
 */
export type AudioUnavailableReason =
  | "no_preview"
  | "preview_rejected"
  | "service_unavailable"
  | "analysis_failed"
  | "not_detected"
  | "not_run"
  | "preview_lookup_incomplete";

/**
 * What the engineer leaves for the composer: the audio service's measurement of the preview
 * clip, as the service sent it (the contract's AudioFeatures v2 block), or why there is none.
 *
 * The block is the only source of measured values: the result's copies (bpm, key, energy, the
 * mood scores, the key moments) and `run.analyzerVersion` are derived from it by code in one
 * step (finalize.ts). Tempo, key, loudness, beats, energy contour and sections are signal
 * measurements; the fingerprint's styles, tags and mood heads are scores of audio models, not
 * probabilities. Nothing here is filled in by this code or by a language model.
 */
export interface AudioMeasurement {
  /**
   * The v2 block as measured, null when nothing was measured. A block whose gate did not pass
   * (silence, noise, too short) is a measurement of nothing: every value in it is null.
   */
  audio: AudioFeatures | null;
  /**
   * How the measured clip was matched to the chosen track (never its URL); set with `audio`.
   * The audio cache keys a measurement by ISRC only when its clip was matched by ISRC.
   */
  previewMatch?: PreviewSourceMatch;
  /** Why there is no block (`audio` is null). */
  unavailableReason?: AudioUnavailableReason;
  /** Detail for unavailableReason (e.g. the service's error message). */
  unavailableDetail?: string;
  /**
   * Mood heads the service returned outside their range; they are null in `audio`, with that
   * reason in `audio.withheld`.
   */
  outOfRange?: string[];
  /**
   * Set on a cached measurement served while the service could not say its analyzer version
   * (down, or naming none): a newer analyzer may measure it differently, so a result built on it
   * is not stored.
   */
  servedUnversioned?: true;
}

export interface ResearchData {
  samples: string[];
  productionTrivia: string[];
  /** Artist collaborators from MusicBrainz (only for an artist linked to the track's Spotify artist) */
  collaborators?: string[];
  /** Genre/style tags of the track from Last.fm */
  lastfmTags?: string[];
  /** Genre/style tags of the track's artist from Last.fm (dropped when the artist is uncertain) */
  lastfmArtistTags?: string[];
  /** Similar tracks from Last.fm */
  lastfmSimilarTracks?: string[];
  /** Similar artists from Last.fm (dropped when the artist is uncertain) */
  lastfmSimilarArtists?: string[];
  /** Artist biography snippet from Last.fm (dropped when the artist is uncertain) */
  lastfmArtistBio?: string;
  /** Similar artists from ListenBrainz (open-source listening data) */
  listenbrainzSimilarArtists?: string[];
  /**
   * Research steps whose source answered with nothing for this track (labels written by code,
   * e.g. "Last.fm similar tracks"). A source that could not be read is a source error instead.
   */
  noneFound?: string[];
  /**
   * Research steps not asked, or whose source could not identify the track or artist (labels
   * written by code, e.g. "ListenBrainz similar artists (not asked: …)"): no answer either way.
   */
  notAsked?: string[];
  /** The artist `collaborators` belong to, as MusicBrainz names it (one artist of the track). */
  collaboratorsOf?: string;
  /**
   * Only in the research cache: the sources that were not configured when this research was
   * made, restored as the run's source errors on a cache hit.
   */
  notConfigured?: SourceError[];
}

/** Research with nothing in it. */
export function emptyResearch(): ResearchData {
  return {
    samples: [],
    productionTrivia: [],
    collaborators: [],
    lastfmTags: [],
    lastfmArtistTags: [],
    lastfmSimilarTracks: [],
    lastfmSimilarArtists: [],
    lastfmArtistBio: undefined,
    listenbrainzSimilarArtists: [],
    noneFound: [],
    notAsked: [],
  };
}

/** How two entries of a list are the same: by their text, or by the name they rank. */
type Key = (entry: string) => string;
const byText: Key = (entry) => entry.replace(/\s+/g, " ").trim();
/** "funk (12)" → "funk": a tag once, whatever its count. */
const byTag: Key = (entry) =>
  byText(entry)
    .replace(/\s*\(\d+\)$/, "")
    .toLowerCase();
const MBID_IN_LINE =
  /\bMusicBrainz ([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i;
/**
 * A similar track or artist by its MusicBrainz id when the line names one (two artists of one
 * name stay apart), else by its name: "2. Under Pressure by Queen (Last.fm match 0.91, …)" →
 * "under pressure by queen".
 */
const byName: Key = (entry) => {
  const mbid = byText(entry).match(MBID_IN_LINE)?.[1];
  if (mbid) return `mbid:${mbid.toLowerCase()}`;
  return byText(entry)
    .replace(/^\d+\.\s+/, "")
    .replace(/\s*\([^()]*\)$/, "")
    .toLowerCase();
};

/**
 * `b` appended to `a`: each entry once (`key`), and never a placeholder (a step's "no result",
 * an empty text: research/plan.ts).
 */
function appended(a: string[] | undefined, b: string[] | undefined, key: Key = byText): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of [...(a ?? []), ...(b ?? [])]) {
    if (isPlaceholder(entry)) continue;
    const k = key(entry);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(entry);
  }
  return out;
}

/** Labels written by code (`noneFound`, `notAsked`): each once. */
function labels(a: string[] | undefined, b: string[] | undefined): string[] {
  return [...new Set([...(a ?? []), ...(b ?? [])])];
}

/**
 * `next` appended to `prev`, list by list (the reducer of research in the graph and the
 * subgraph). An entry already held is not added again (a tag or a similar track or artist by its
 * name, anything else by its text), so merging the same research twice changes nothing.
 */
export function mergeResearch(prev: ResearchData, next: Partial<ResearchData>): ResearchData {
  return {
    samples: appended(prev.samples, next.samples),
    productionTrivia: appended(prev.productionTrivia, next.productionTrivia),
    collaborators: appended(prev.collaborators, next.collaborators),
    lastfmTags: appended(prev.lastfmTags, next.lastfmTags, byTag),
    lastfmArtistTags: appended(prev.lastfmArtistTags, next.lastfmArtistTags, byTag),
    lastfmSimilarTracks: appended(prev.lastfmSimilarTracks, next.lastfmSimilarTracks, byName),
    lastfmSimilarArtists: appended(prev.lastfmSimilarArtists, next.lastfmSimilarArtists, byName),
    lastfmArtistBio:
      lastfmBio(next.lastfmArtistBio) ?? lastfmBio(prev.lastfmArtistBio) ?? undefined,
    listenbrainzSimilarArtists: appended(
      prev.listenbrainzSimilarArtists,
      next.listenbrainzSimilarArtists,
      byName,
    ),
    noneFound: labels(prev.noneFound, next.noneFound),
    notAsked: labels(prev.notAsked, next.notAsked),
    collaboratorsOf: next.collaboratorsOf || prev.collaboratorsOf,
  };
}

// =============================================================================
// HITL Configuration Types
// =============================================================================

/**
 * Why the scout ended a run without a track, as a type the analyze route reads (never text):
 * - `no_match`: Spotify found nothing for the query, or no track with the requested id;
 * - `rate_limited`: Spotify kept refusing for its rate limit; `retryAfterMs` is how long it
 *   asked to wait, when it said;
 * - `upstream_unavailable`: Spotify could not answer (an outage, a timeout, no credentials).
 */
export type ScoutFailure =
  | { kind: "no_match" }
  | { kind: "rate_limited"; retryAfterMs: number | null }
  | { kind: "upstream_unavailable" };

/**
 * How the user chose a track themselves: a click (or Enter) on a row of the track picker or on
 * a search suggestion, or the picker's countdown, which takes the highlighted row when the user
 * did not choose.
 */
export type PickedBy = "click" | "countdown";

/**
 * Configuration for Human-in-the-Loop disambiguation behavior. When a choice is needed is
 * decided by how the results match the query (trackMatch.ts), not by a threshold.
 */
export interface HITLConfig {
  /** Maximum candidates to show user (default: 5) */
  maxCandidates: number;
}

/**
 * Default HITL configuration values
 */
export const DEFAULT_HITL_CONFIG: HITLConfig = {
  maxCandidates: 5,
};

// =============================================================================
// Research Subgraph Types
// =============================================================================

/** The research planner's next step (the first step is fixed; later ones come from the model). */
export type ResearchPlan = ResearchPlanOutput;

// =============================================================================
// Model calls of a run
// =============================================================================

/**
 * One model call of a run, as the node that made it saw it: the tokens and cost when it
 * answered, or the error kind when it failed (`status`). The provider layer keeps its own
 * per-attempt records (`llm_usage`); this is what the run's result reports.
 */
export interface LlmCallRecord {
  callSite: string;
  tier: LlmTier;
  /** "unexpected": the call threw something other than a provider-layer error (a bug). */
  status: "ok" | LlmErrorKind | "unexpected";
  /** The deployment that answered; null when the call failed. */
  deployment: string | null;
  /** Attempts the call took; null when it failed. */
  attempts: number | null;
  /** live or record: the provider answered; replay: a cassette did. null when it failed. */
  mode: "live" | "record" | "replay" | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  /**
   * The estimated cost; for a failed call, only when the provider reported its tokens
   * (otherwise 0: what it may have cost is settled in the spend log).
   */
  usdEst: number;
  /**
   * For an answer replayed from a cassette: when and from which commit it was recorded (null
   * where the cassette does not say). Absent for other calls.
   */
  recording?: { recordedAt: string | null; commit: string | null };
}

type PreviewMatchValue = z.infer<typeof PreviewMatch>;

/**
 * The result the composer hands the verifier: what the model wrote, as claims, factoid cards and
 * a genealogy (nodes without artwork, links still inferred), or the fallback built from source
 * data when the model gave nothing usable (`modelUnavailableReason`); either way with the claims
 * and links code built from the primary records (codeClaims.ts), sourced by construction.
 * Everything the verifier does not change (metadata, the measurement, the evidence) it takes from
 * the state.
 */
export interface ComposedDraft {
  /** null for a composed result; for the fallback, why the model gave nothing usable. */
  modelUnavailableReason: NonNullable<TrackData["modelUnavailableReason"]> | null;
  factoids: TrackData["factoids"];
  claims: Claim[];
  genealogy: TrackData["genealogy"];
  /** The year the model gave for a node, by node id: for the artwork's release check only. */
  nodeYears: Record<string, string>;
  /** Nodes made from records whose cover art is not looked up (codeClaims.ts); none when absent. */
  noArtwork?: string[];
  segments: TrackData["segments"];
  segmentsSource: "template";
  samples: TrackData["samples"];
}

/**
 * A research lead discovered during analysis
 */
export interface ResearchLead {
  /** Unique identifier */
  id: string;
  /** Type of lead */
  type: "sample" | "influence" | "producer" | "collaborator" | "event";
  /** Search query to explore this lead */
  query: string;
  /** Priority level */
  priority: "high" | "medium" | "low";
  /** Why this lead is interesting */
  reason: string;
  /** Whether this lead has been explored */
  explored: boolean;
}

// =============================================================================
// Sonic Agent State (the real state used by the graph)
// =============================================================================

/**
 * The main state that flows through the LangGraph workflow.
 *
 * Workflow: scout → [clarification?] → parallel(engineer, historian) → composer → verifier → END
 */
export const SonicAgentState = Annotation.Root({
  // Input
  songQuery: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),

  // The Spotify track the request asked for by id (a suggestion or a node), or null for a search
  // by text. With an id the scout reads that track instead of searching.
  requestedTrackId: Annotation<string | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Search candidates (for human disambiguation)
  candidates: Annotation<SearchCandidate[] | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Selected track ID (after disambiguation or auto-select)
  selectedTrackId: Annotation<string | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Who chose the track: "match" when the scout selected it as the query's clear match, "user"
  // when it came from the track picker (a click or the picker's countdown). Either way the
  // result is stored under the track, never under the search text.
  selectedBy: Annotation<"match" | "user" | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // For a track the user chose ("user" above): a click, or the picker's countdown; null when
  // the scout selected it, or when the client did not say. A deliberate click is the user's own
  // choice, so the result does not warn that the search text matched it loosely.
  pickedBy: Annotation<PickedBy | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Why the scout found no track (typed); null otherwise.
  scoutFailure: Annotation<ScoutFailure | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Spotify metadata
  spotifyData: Annotation<SpotifyData | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // The audio measurement (from the engineer); null until it runs
  audioFeatures: Annotation<AudioMeasurement | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Research data (from the historian: its Last.fm pre-fetch and the researcher subgraph's
  // steps, or the research cache). Lists accumulate ([...prev.X, ...next.X]); a node that
  // returns research adds to what the state already holds.
  researchData: Annotation<ResearchData>({
    reducer: mergeResearch,
    default: emptyResearch,
  }),

  // Final output
  trackData: Annotation<TrackData | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Error tracking
  error: Annotation<string | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Status messages for streaming
  statusMessages: Annotation<string[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  // The run this invocation belongs to: the thread id, or an id minted once when there is no
  // thread. Every model call of the run counts against one cap under this id. Set once.
  runId: Annotation<string | null>({
    reducer: (prev, next) => prev ?? next,
    default: () => null,
  }),

  // The track's ISRC, when the scout found one; null when unknown.
  isrc: Annotation<string | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // The MusicBrainz recording the ISRC identified, from the historian's identity chain (the
  // run's one ISRC lookup), for the composer; null without an ISRC or a match.
  isrcRecording: Annotation<IdentifiedRecording | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // How the query matched the chosen track by title and artist (trackMatch.ts); while the user
  // is choosing, how it matched the best result. "none" is a low match: nothing Spotify
  // returned carries the query's title or artist. null before the scout has searched. The
  // result carries it (TrackAnalysis.queryMatch), so the web can say when it is not exact.
  queryMatch: Annotation<QueryMatch | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Where the clip the audio values were measured on came from and how it was matched to the
  // track; null when nothing was measured. On an audio-cache hit it describes the cached
  // measurement's clip, which may be another entry of the recording than the player's clip.
  preview: Annotation<PreviewMatchValue | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // The run's preview clip of the chosen recording, for the player; null when there is none.
  // Spotify's own clip is used here only when the engineer chose it.
  // The URL is signed and expires within minutes: the checkpointer never saves it
  // (store/checkpointer.ts) and stored results drop it.
  previewUrl: Annotation<string | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // The evidence pack: records from source payloads, never model text. The historian writes it
  // (research/evidencePack.ts); an id already in the pack is kept once (the first item wins).
  evidence: Annotation<Evidence[]>({
    reducer: (prev, next) => {
      const ids = new Set(prev.map((item) => item.id));
      return [...prev, ...next.filter((item) => !ids.has(item.id) && ids.add(item.id))];
    },
    default: () => [],
  }),

  // The relations the primary records state (research/relations.ts), each stated by an item of
  // `evidence`: the historian writes them with the pack, and the composer builds the result's
  // code-built claims and links from them (codeClaims.ts). The model is never shown them.
  relations: Annotation<PrimaryRelation[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  // What the composer wrote (or its fallback), before the verifier checks it; null until the
  // composer runs. It holds no preview URL: artwork and previews are looked up by the verifier,
  // after its checks (and the checkpointer scrubs this channel all the same).
  draft: Annotation<ComposedDraft | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // The claims of the result, as the verifier left them. Only the verifier writes them; a new
  // set replaces the old one.
  claims: Annotation<Claim[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),

  // Every model call of the run (research planner, composer), in order.
  usage: Annotation<LlmCallRecord[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  // Sources that could not be read during the run, shown as "source unavailable".
  sourceErrors: Annotation<SourceError[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  // Those of sourceErrors that are lasting: a primary-record answer of a shape its reader does
  // not know (marked by the reader, never by source name). They do not keep the composer from
  // storing the result; it is stored with them and reports them again when served.
  lastingSourceErrors: Annotation<SourceError[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  // The primary-record sources the run did not ask, their request not sent (our own pacing left
  // no slot in time, or the run's time for them ran out first): no source error. The research
  // may be cached; the composer stores no result without them, so a stored result never lacks
  // their records without saying so.
  primaryNotAsked: Annotation<SourceError["source"][]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),

  // HITL configuration (how many candidates the track picker offers)
  hitlConfig: Annotation<HITLConfig>({
    reducer: (_, next) => next,
    default: () => DEFAULT_HITL_CONFIG,
  }),
});

export type SonicAgentStateType = typeof SonicAgentState.State;

/**
 * The state with the evidence-model channels present: a state written before they existed (or
 * a node called outside the graph) reads them as empty.
 */
export function withChannelDefaults(state: SonicAgentStateType): SonicAgentStateType {
  return {
    ...state,
    evidence: state.evidence ?? [],
    relations: state.relations ?? [],
    claims: state.claims ?? [],
    draft: state.draft ?? null,
    usage: state.usage ?? [],
    sourceErrors: state.sourceErrors ?? [],
    lastingSourceErrors: state.lastingSourceErrors ?? [],
    primaryNotAsked: state.primaryNotAsked ?? [],
    isrc: state.isrc ?? null,
    isrcRecording: state.isrcRecording ?? null,
    preview: state.preview ?? null,
    previewUrl: state.previewUrl ?? null,
    queryMatch: state.queryMatch ?? null,
  };
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Generate a unique ID
 */
export function generateId(): string {
  return randomUUID();
}

/**
 * A generic song structure used when nothing better is known. It is a template, not an
 * analysis of the track: TrackData built with it sets `segmentsSource: "template"`.
 */
export function createDefaultSegments(_durationMs: number): SongSegment[] {
  return [
    { label: "Intro", start: 0, end: 8 },
    { label: "Verse 1", start: 8, end: 25 },
    { label: "Chorus", start: 25, end: 42 },
    { label: "Verse 2", start: 42, end: 58 },
    { label: "Bridge", start: 58, end: 75 },
    { label: "Chorus", start: 75, end: 92 },
    { label: "Outro", start: 92, end: 100 },
  ];
}
