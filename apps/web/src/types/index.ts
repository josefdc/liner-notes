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
  type: 'production' | 'trivia' | 'lyrics' | 'credits' | 'sample' | 'curiosity' | 'connection';
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
  // Audio features
  bpm: number;
  key?: string;
  energy?: number;
  valence?: number;
  danceability?: number;
  acousticness?: number;
  durationSeconds?: number; // Duration in seconds for timeline display
  segments: SongSegment[];
  samples: { time: number; description: string }[];
  keyMoments?: KeyMoment[]; // Key moments from audio analysis
  factoids: Factoid[];
  // Production credits
  credits?: ProductionCredits;
  genealogy: {
    nodes: GenealogyNode[];
    links: GenealogyLink[];
  };
  // Genre profile for Sonic Fingerprint radar chart
  genreProfile?: GenreProfileItem[];
  // Audio metadata for graceful degradation
  audioSource?: 'analyzed' | 'estimated';
  audioConfidence?: 'high' | 'low';
}

export interface AgentLog {
  id: string;
  message: string;
  timestamp: string;
  code?: LogCode;
  node?: string;
}
