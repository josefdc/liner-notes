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

export interface GenealogyLink {
  source: string;
  target: string;
  value: number;
  // Semantic relationship type for visual styling
  type?: 'sample' | 'cover' | 'remix' | 'producer' | 'influence';
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

/** Why measured audio values are missing (sent with audioSource "unavailable"). */
export type AudioUnavailableReason =
  | 'service_unavailable'
  | 'no_preview'
  | 'preview_rejected'
  | 'analysis_failed'
  | 'not_detected'
  | 'not_run';

/** Why the model was unavailable (a category: the API never sends the provider's text). */
/**
 * Why the "more facts" stream could not write a fact, when the user should know: the model's
 * rate limit, live model calls paused by the budget, or live calls switched off on this server
 * (it replays recorded runs only).
 */
export type FactoidUnavailableCode = 'rate_limited' | 'budget_exhausted' | 'live_disabled';

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
}

export type ModelUnavailableReason =
  | 'no_output'
  | 'rate_limited'
  | 'timeout'
  | 'auth'
  | 'error'
  | 'budget_exhausted';

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
  samples: { time: number; description: string }[];
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
  // Audio provenance: 'analyzed' when tempo and key were measured, 'unavailable' otherwise.
  // 'estimated' is sent by the API before audio values were measured only, and by results it
  // cached: those values were estimated from the genre or at random and are never shown.
  audioSource?: 'analyzed' | 'unavailable' | 'estimated';
  audioConfidence?: 'high' | 'low';
  audioUnavailableReason?: AudioUnavailableReason;
  // Model provenance: true when the result was built from source data without the model
  modelUnavailable?: boolean;
  modelUnavailableReason?: ModelUnavailableReason;
  // How the result was produced: live, or a recorded run replayed
  run?: ResultRun;
}

export interface AgentLog {
  id: string;
  message: string;
  timestamp: string;
  code?: LogCode;
  node?: string;
}
