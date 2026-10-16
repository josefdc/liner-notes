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
  mode?: string | null;
  energy?: number | null;
  // Scores (0-1) from audio models run over the preview: estimates, not probabilities.
  // null when not measured.
  valence?: number | null;
  danceability?: number | null;
  acousticness?: number | null;
  instrumentalness?: number | null;
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
  // Audio provenance: 'analyzed' when tempo and key were measured, 'unavailable' otherwise
  audioSource?: 'analyzed' | 'unavailable';
  audioConfidence?: 'high' | 'low';
  audioUnavailableReason?: AudioUnavailableReason;
  audioUnavailableDetail?: string;
  // Model provenance: true when the result was built from source data without the model
  modelUnavailable?: boolean;
  modelUnavailableReason?: string;
}

export interface AgentLog {
  id: string;
  message: string;
  timestamp: string;
  code?: LogCode;
  node?: string;
}
