import type { TrackData, AgentLog, Factoid } from '../../types';

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
  /** Answers the open track picker; later calls for the same picker are ignored. */
  selectCandidate: (candidateId: string) => Promise<void>;
  /** Runs the last analysis again from the start (after an error). */
  retry: () => void;
  /**
   * Stream factoids one-by-one for faster perceived speed. The stream is closed, and the
   * promise rejects with an AbortError, when `signal` aborts or a new analysis starts.
   */
  decryptMoreFactoidsStream: (
    trackTitle: string,
    trackArtist: string,
    existingIds: string[],
    onFactoid: (factoid: Factoid) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Rejects when the request fails. */
  searchSuggest: (query: string, limit?: number) => Promise<SearchCandidate[]>;
  reset: () => void;
}

/** An event of the analysis streams (`data:` lines, delivered through `onmessage`). */
export interface AgentStreamEvent {
  type: string;
  message?: string;
  code?: AgentLog['code'];
  node?: string;
  threadId?: string;
  candidates?: SearchCandidate[];
  data?: TrackData;
  error?: string;
}

// Use same hostname as the frontend, but port 3001 for the API
// This allows network access from mobile devices
export const API_BASE_URL =
  typeof window !== 'undefined'
    ? `http://${window.location.hostname}:3001`
    : 'http://localhost:3001';

// Re-export types needed by consumers of the hook
export type { Factoid };
