import type { TrackData, AgentLog, Factoid, FactoidUnavailableCode } from '../../types';

export interface SearchCandidate {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  releaseYear?: string;
  /** Optional in the contract: the API may stop sending it. */
  popularity?: number;
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
  /**
   * The run is a recorded run played again, not a live analysis: the API said so (its replay
   * notice, or a result whose run.mode is "replay"). The progress screens say so too.
   */
  isReplay: boolean;
}

/** How a result was produced: computed live, or a recorded run replayed. */
export type ResultMode = 'live' | 'replay';

/**
 * How a row of the track picker was chosen: a click (or Enter) on it, or the picker's
 * countdown. A deliberate click is not warned about a loose search match.
 */
export type PickedBy = 'click' | 'countdown';

/** How an analysis is asked for, besides its text. */
export interface AnalyzeOptions {
  /** The Spotify track the user chose (a suggestion, a node): that very track is analysed. */
  trackId?: string;
  /** With `trackId`, for a picker row asked for by id: how the row was picked. */
  pickedBy?: PickedBy;
}

export interface UseAgentReturn extends AgentState {
  analyze: (query: string, options?: AnalyzeOptions) => Promise<void>;
  /** Answers the open track picker; later calls for the same picker are ignored. */
  selectCandidate: (candidateId: string, pickedBy?: PickedBy) => Promise<void>;
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
    onUnavailable?: (code: FactoidUnavailableCode) => void,
    /** How the result was produced (its run.mode): more facts stay on that side. */
    resultMode?: ResultMode,
  ) => Promise<void>;
  /** Rejects when the request fails. */
  searchSuggest: (query: string, limit?: number) => Promise<SearchCandidate[]>;
  reset: () => void;
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
