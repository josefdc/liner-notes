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
  /**
   * Why the run failed, when the server said so (`error` events carry a code such as
   * no_match, choice_expired or timeout); null for errors without one.
   */
  errorCode: string | null;
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
  /** A log code on `status` events, a failure code on `error` events. */
  code?: string;
  node?: string;
  threadId?: string;
  candidates?: SearchCandidate[];
  data?: TrackData;
  error?: string;
}

/**
 * The API's root URL, `/api` prefix included, from `VITE_API_URL` at build time: a path on the web
 * app's own origin (`/api`) or an absolute URL (`https://api.example.com/api`). A trailing slash is
 * dropped. Unset or empty, it is `/api` on the web app's origin, which the Vite dev server proxies
 * to the API (vite.config.ts) and the web image's nginx forwards to it.
 */
export function apiBaseUrl(configured: string | undefined): string {
  const base = configured?.trim().replace(/\/+$/, '');
  return base || '/api';
}

export const API_BASE_URL = apiBaseUrl(import.meta.env.VITE_API_URL);

// Re-export types needed by consumers of the hook
export type { Factoid };
