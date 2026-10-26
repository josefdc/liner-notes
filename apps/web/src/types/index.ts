export enum AppPhase {
  ONBOARDING = 'ONBOARDING',
  DASHBOARD = 'DASHBOARD',
  PLAYER = 'PLAYER',
}

export interface SongSegment {
  label: string;
  start: number; // percentage 0-100
  end: number; // percentage 0-100
  color: string;
}

// Log codes for System Console
export type LogCode =
  | 'NET-100'
  | 'NET-200'
  | 'NET-400'
  | 'NET-500'
  | 'AUDIO-INIT'
  | 'AUDIO-PARSING'
  | 'AUDIO-COMPLETE'
  | 'AUDIO-ERROR'
  | 'GEMINI-CONNECT'
  | 'GEMINI-THOUGHT'
  | 'GEMINI-RESPONSE'
  | 'GEMINI-ERROR'
  // The model codes the API sends since the provider layer; the GEMINI-* ones above are kept for
  // logs and runs recorded before it.
  | 'LLM-CONNECT'
  | 'LLM-RESPONSE'
  | 'LLM-ERROR'
  | 'SPOTIFY-SEARCH'
  | 'SPOTIFY-FOUND'
  | 'SPOTIFY-NONE'
  | 'RESEARCH-START'
  | 'RESEARCH-FOUND'
  | 'RESEARCH-DEEP'
  | 'GRAPH-BUILD'
  | 'GRAPH-ENRICH'
  | 'GRAPH-COMPLETE'
  | 'SYS-INIT'
  | 'SYS-READY'
  | 'SYS-WARN'
  | 'SYS-ERROR';

// Entity for Interactive Intel Cards
export interface FactoidEntity {
  id: string;
  text: string;
  type: 'synth' | 'producer' | 'sample' | 'technique' | 'artist' | 'album' | 'year';
  searchQuery?: string;
}

export interface Factoid {
  id: string;
  title: string;
  content: string;
  type: 'production' | 'trivia' | 'credits' | 'sample' | 'curiosity' | 'connection';
  entities?: FactoidEntity[];
  /** The claim this card shows (results with claims); read with resultClaims (provenance/). */
  claimId?: string;
}

export interface GenealogyNode {
  id: string;
  group: number;
  label: string;
  img?: string;
  size: number;
  // Audio preview for hover-to-play
  previewUrl?: string;
  spotifyId?: string;
  // Parsed metadata for click-to-analyze navigation
  trackTitle?: string;
  trackArtist?: string;
}

/**
 * A relation between two genealogy nodes (the contract's GenealogyLink). Shown through
 * `shownLinks` (components/genealogy/links.ts), which reads it with the contract's schema:
 * sourced only when it says so and cites evidence that is all in the result's pack.
 */
export interface GenealogyLink {
  source: string;
  target: string;
  value: number;
  type?: 'sample' | 'interpolation' | 'cover' | 'remix' | 'producer' | 'influence';
  kind?: 'sourced' | 'inferred';
  origin?: 'code' | 'model';
  claimId?: string;
  evidenceIds?: string[];
}

// Key moment detected in audio (drops, peaks, transitions)
export interface KeyMoment {
  time: number; // Time in seconds
  type: 'energy_peak' | 'energy_drop' | 'onset' | 'harmonic_change' | 'silence';
  intensity: number; // 0-1 scale
  description: string;
}

// Production credits (producers, writers, engineers)
export interface ProductionCredits {
  producers: string[];
  writers: string[];
  engineers?: string[];
  label?: string;
}

// Genre profile for Sonic Fingerprint radar chart
export interface GenreProfileItem {
  genre: string;
  value: number; // 0-100
}

/**
 * Why measured audio values are missing (sent with audioSource "unavailable"). "low_confidence":
 * measured, but below the confidence needed to show a value. "preview_not_asked": the preview
 * was not looked up in time, so whether there is one is not known.
 */
export type AudioUnavailableReason =
  | 'service_unavailable'
  | 'no_preview'
  | 'preview_rejected'
  | 'analysis_failed'
  | 'not_detected'
  | 'not_run'
  | 'low_confidence'
  | 'preview_not_asked';

/** Why the model was unavailable (a category: the API never sends the provider's text). */
/**
 * Why the "more facts" stream could not write a fact, when the user should know: the model's
 * rate limit, live model calls paused by the budget, live calls switched off on this server
 * (it replays recorded runs only), or, for a replayed result, a recording no longer served.
 */
export type FactoidUnavailableCode =
  | 'rate_limited'
  | 'budget_exhausted'
  | 'live_disabled'
  | 'not_found';

/**
 * The run that produced a result, as the API sends it with the result. A replay ("replay")
 * is a recorded run served again: it says when it was recorded and from which commit.
 * Results from older servers have no run.
 */
export interface ResultRun {
  id?: string;
  mode?: string;
  recordedAt?: string | null;
  commit?: string | null;
  /**
   * What a replay replayed: "run", the whole recorded run, or "model_answers", only the model's
   * answers (stored answers, in development and evaluation; the rest ran live). Older results
   * do not say.
   */
  replayed?: string;
  /** The audio analyzer of the run's measurement; null when nothing was measured. */
  analyzerVersion?: string | null;
}

export type ModelUnavailableReason =
  | 'no_output'
  | 'rate_limited'
  | 'timeout'
  | 'auth'
  | 'error'
  | 'budget_exhausted';

/**
 * How the search text matched the analysed track by title and artist: anything but "exact"
 * means the track may not be the song searched for.
 */
export type QueryMatch = 'exact' | 'partial' | 'artist' | 'none';

export interface TrackData {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  // Enhanced metadata
  spotifyUrl?: string;
  previewUrl?: string;
  releaseYear?: string;
  explicit?: boolean;
  // Measured from the audio preview; null when not measured (never filled in).
  bpm: number | null;
  key?: string | null;
  energy?: number | null;
  // Scores (0-1) from audio models run over the preview: estimates, not probabilities.
  // null when not measured.
  valence?: number | null;
  danceability?: number | null;
  acousticness?: number | null;
  durationSeconds?: number; // Duration in seconds for timeline display
  segments: SongSegment[];
  /** 'template': a generic default structure; 'inferred': written by the model. Never measured. */
  segmentsSource?: 'template' | 'inferred';
  samples: { time: number; description: string; claimId?: string }[];
  keyMoments?: KeyMoment[]; // Detected in the audio preview
  // May be fewer than three, or empty, when there was nothing to say
  factoids: Factoid[];
  // Production credits
  credits?: ProductionCredits;
  genealogy: {
    nodes: GenealogyNode[];
    links: GenealogyLink[];
  };
  // Genre profile for the Sonic Fingerprint radar chart (written by the model)
  genreProfile?: GenreProfileItem[];
  /**
   * The audio measurement itself (the contract's AudioFeatures v2): each value with its method,
   * confidence and basis, the preview window and the gate. The stream reader hands on the
   * contract's reading of it: null when nothing was measured or when the contract cannot read
   * the block (then `audioUnreadable` is true). Read it with `measuredAudioOf` (constants.ts).
   * Absent from results of APIs that do not send it.
   */
  audio?: unknown;
  /** True when the result sent an `audio` block the contract cannot read. */
  audioUnreadable?: boolean;
  // Audio provenance: 'analyzed' when tempo and key were measured, 'unavailable' otherwise.
  // 'estimated' is sent by the API before audio values were measured only, and by results it
  // cached: those values were estimated from the genre or at random and are never shown.
  // With an `audio` block, the block decides what was measured, not this field.
  audioSource?: 'analyzed' | 'unavailable' | 'estimated';
  audioConfidence?: 'high' | 'low';
  audioUnavailableReason?: AudioUnavailableReason;
  // Model provenance: true when the result was built from source data without the model
  modelUnavailable?: boolean;
  modelUnavailableReason?: ModelUnavailableReason;
  // How the result was produced: live, or a recorded run replayed
  run?: ResultRun;
  // How this run's search text matched the track; absent in older results
  queryMatch?: QueryMatch | null;
  /**
   * The evidence pack and the claims (the contract's Evidence and Claim lists), as the API sent
   * them. Read them with `resultClaims` (components/provenance/claims.ts), which keeps what the
   * contract can read. Absent from results of APIs that do not send them.
   */
  evidence?: unknown;
  claims?: unknown;
}

export interface AgentLog {
  id: string;
  message: string;
  timestamp: string;
  code?: LogCode;
  node?: string;
}
