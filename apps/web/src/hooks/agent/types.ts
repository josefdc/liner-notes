import type { TrackData, AgentLog, LogCode, Factoid } from '../../types';

export interface SearchCandidate {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  releaseYear?: string;
  popularity: number;
}

export type AgentStatus =
  | 'idle'
  | 'connecting'
  | 'searching'
  | 'analyzing'
  | 'researching'
  | 'composing'
  | 'disambiguation'
  | 'complete'
  | 'error';

export interface AgentState {
  status: AgentStatus;
  logs: AgentLog[];
  trackData: TrackData | null;
  candidates: SearchCandidate[] | null;
  threadId: string | null;
  error: string | null;
  isLoading: boolean;
  isComplete: boolean;
}

export interface UseAgentReturn extends AgentState {
  analyze: (query: string) => Promise<void>;
  selectCandidate: (candidateId: string) => Promise<void>;
  /** Stream factoids one-by-one for faster perceived speed */
  decryptMoreFactoidsStream: (
    trackTitle: string,
    trackArtist: string,
    existingIds: string[],
    onFactoid: (factoid: Factoid) => void,
  ) => Promise<void>;
  searchSuggest: (query: string, limit?: number) => Promise<SearchCandidate[]>;
  reset: () => void;
}

// Use same hostname as the frontend, but port 3001 for the API
// This allows network access from mobile devices
export const API_BASE_URL =
  typeof window !== 'undefined'
    ? `http://${window.location.hostname}:3001`
    : 'http://localhost:3001';

// Re-export types needed by consumers of the hook
export type { Factoid };
