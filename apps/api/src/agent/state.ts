/**
 * Agent State Definition
 *
 * Defines the state that flows through the LangGraph workflow.
 * Maps to the frontend TrackData interface.
 */

import { randomUUID } from "node:crypto";
import { Annotation } from "@langchain/langgraph";
import type {
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
import type { SearchCandidate, TrackData } from "./schema.js";
import type { QueryMatch } from "./trackMatch.js";

// =============================================================================
// TypeScript Interfaces (matching frontend types)
// =============================================================================

export interface SongSegment {
  label: string;
  start: number; // percentage 0-100
  end: number; // percentage 0-100
  color: string;
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
 * - analysis_failed: the service was reached but the analysis failed
 * - not_detected: the analysis ran but found no tempo or no key (e.g. unpitched audio)
 * - not_run: audio analysis did not run for this track
 */
export type AudioUnavailableReason =
  | "no_preview"
  | "preview_rejected"
  | "service_unavailable"
  | "analysis_failed"
  | "not_detected"
  | "not_run";

/**
 * Audio features from the analysis service, computed on the preview clip, or null.
 * - bpm, key and energy are measured from the signal (tempo tracking, key profiles, RMS).
 * - valence, danceability, acousticness and instrumentalness are scores from audio models
 *   (Essentia) run over the clip: model estimates, not signal measurements.
 * No value is filled in by this code or by a language model; missing values stay null.
 */
export interface AudioFeatures {
  bpm: number | null;
  key: string | null;
  energy: number | null;
  valence: number | null;
  danceability: number | null;
  acousticness: number | null;
  instrumentalness: number | null;
  /**
   * 'high' when tempo, key and all perceptual features were measured;
   * 'low' when some of them are missing (missing values are null, never filled in).
   */
  confidence: "low" | "high";
  /** Key moments detected in the audio (drops, peaks, transitions) */
  keyMoments?: KeyMoment[];
  /** Set when the analysis did not produce a measurement */
  unavailableReason?: AudioUnavailableReason;
  /** Human-readable detail for unavailableReason (e.g. the service error message) */
  unavailableDetail?: string;
  /** Fields the service returned outside their valid range; they are null here */
  outOfRange?: string[];
  /**
   * Set to true only on features built from an audio service measurement. Cached rows without
   * it were written before estimates were removed and are not trusted.
   */
  measured?: true;
  /** What produced the measurement (the audio analysis service) */
  analyzer?: "audio-service";
  /**
   * How the measured clip was matched to the track (never its URL). Cached rows without it were
   * measured before previews were matched strictly and are not trusted.
   */
  previewMatch?: PreviewSourceMatch;
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

const appended = (a: string[] | undefined, b: string[] | undefined) => [...(a ?? []), ...(b ?? [])];

/** `next` appended to `prev`, list by list (the reducer of research in the graph and the subgraph). */
export function mergeResearch(prev: ResearchData, next: Partial<ResearchData>): ResearchData {
  return {
    samples: appended(prev.samples, next.samples),
    productionTrivia: appended(prev.productionTrivia, next.productionTrivia),
    collaborators: appended(prev.collaborators, next.collaborators),
    lastfmTags: appended(prev.lastfmTags, next.lastfmTags),
    lastfmArtistTags: appended(prev.lastfmArtistTags, next.lastfmArtistTags),
    lastfmSimilarTracks: appended(prev.lastfmSimilarTracks, next.lastfmSimilarTracks),
    lastfmSimilarArtists: appended(prev.lastfmSimilarArtists, next.lastfmSimilarArtists),
    lastfmArtistBio: next.lastfmArtistBio || prev.lastfmArtistBio,
    listenbrainzSimilarArtists: appended(
      prev.listenbrainzSimilarArtists,
      next.listenbrainzSimilarArtists,
    ),
    noneFound: appended(prev.noneFound, next.noneFound),
    notAsked: appended(prev.notAsked, next.notAsked),
    collaboratorsOf: next.collaboratorsOf || prev.collaboratorsOf,
  };
}

// =============================================================================
// HITL Configuration Types
// =============================================================================

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
}

type PreviewMatchValue = z.infer<typeof PreviewMatch>;

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
 * Workflow: scout → [clarification?] → parallel(engineer, historian) → composer → END
 */
export const SonicAgentState = Annotation.Root({
  // Input
  songQuery: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
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
  // when it came from the track picker (a click or the picker's countdown). Only a clear match
  // may be served to the next search of the same text.
  selectedBy: Annotation<"match" | "user" | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Spotify metadata
  spotifyData: Annotation<SpotifyData | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Audio features (from engineer)
  audioFeatures: Annotation<AudioFeatures | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),

  // Research data (from historian)
  // Uses accumulation reducer: [...prev.X, ...next.X] (not replace) because
  // engineerNode and historianNode run in parallel and both contribute research data.
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

  // How the query matched the chosen track by title and artist (trackMatch.ts); while the user
  // is choosing, how it matched the best result. "none" is a low match: nothing Spotify
  // returned carries the query's title or artist. null before the scout has searched.
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

  // The evidence pack: records from source payloads, never model text. Branches add items; an
  // id already in the pack is kept once (the first item wins).
  evidence: Annotation<Evidence[]>({
    reducer: (prev, next) => {
      const ids = new Set(prev.map((item) => item.id));
      return [...prev, ...next.filter((item) => !ids.has(item.id) && ids.add(item.id))];
    },
    default: () => [],
  }),

  // The claims of the result. Only the composer writes them; a new set replaces the old one.
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

  // HITL configuration (how many candidates the track picker offers)
  hitlConfig: Annotation<HITLConfig>({
    reducer: (_, next) => next,
    default: () => DEFAULT_HITL_CONFIG,
  }),
});

export type SonicAgentStateType = typeof SonicAgentState.State;

// =============================================================================
// Default Colors for Segments
// =============================================================================

export const SEGMENT_COLORS = {
  intro: "#374151", // gray-700
  verse: "#1F2937", // gray-800
  chorus: "#00F0FF", // cyber
  bridge: "#FFB000", // analog
  outro: "#374151", // gray-700
  instrumental: "#6366F1", // indigo
  breakdown: "#EC4899", // pink
};

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
    { label: "Intro", start: 0, end: 8, color: SEGMENT_COLORS.intro },
    { label: "Verse 1", start: 8, end: 25, color: SEGMENT_COLORS.verse },
    { label: "Chorus", start: 25, end: 42, color: SEGMENT_COLORS.chorus },
    { label: "Verse 2", start: 42, end: 58, color: SEGMENT_COLORS.verse },
    { label: "Bridge", start: 58, end: 75, color: SEGMENT_COLORS.bridge },
    { label: "Chorus", start: 75, end: 92, color: SEGMENT_COLORS.chorus },
    { label: "Outro", start: 92, end: 100, color: SEGMENT_COLORS.outro },
  ];
}
