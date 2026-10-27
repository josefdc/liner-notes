import type { Claim, ErrorCode } from '@liner-notes/contract';
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
  /** The recording's ISRC; null or absent when Spotify gave none (older servers send none). */
  isrc?: string | null;
  /** Spotify's release date as sent ("0000" when unknown); null or absent when not known. */
  releaseDate?: string | null;
  /** Whether Spotify marks the track explicit; null or absent when not known. */
  explicit?: boolean | null;
  /** The track's length in milliseconds; absent when not known. */
  durationMs?: number;
}

export type AgentStatus =
  | 'idle'
  | 'connecting'
  | 'searching'
  // The engineer's step; `measuring` only while a measurement of the preview runs.
  | 'analyzing'
  | 'measuring'
  | 'researching'
  | 'composing'
  // The verifier checks the composed notes against their sources.
  | 'checking'
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
   * Why the run failed: the code of the server's `error` event (no_match, choice_expired,
   * timeout…), or the app's own code for a failure it raised itself (useAgent's
   * CLIENT_ERROR_CODES and OUTDATED_ERROR). Null only for an error without either.
   */
  errorCode: string | null;
  isLoading: boolean;
  isComplete: boolean;
  /**
   * The run is a recorded run played again, not a live analysis: the API said so (its replay
   * notice, or a result whose run.mode is "replay"). The progress screens say so too.
   */
  isReplay: boolean;
  /**
   * The server's own words for the step under way, when they say more than the status: the
   * picker's question ("One possible track…"), the composer's fallback. Cleared when the run
   * moves to another step.
   */
  statusNote: string | null;
  /** The facts "more facts" added to the result shown last, with their claims; null before. */
  moreFacts: MoreFacts | null;
  /**
   * When the error's refusal said how long to wait (a rate limit's Retry-After): the time, in
   * milliseconds since the epoch, before which a retry would be refused again. The hook sends no
   * request before then. Null for any other error, and while no run has failed.
   */
  retryAt: number | null;
}

/** A fact "more facts" asked for but could not write: its place in the answer, and why. */
export interface FailedFact {
  /** The fact's index in the answer (the stream's `error.index`). */
  index: number;
  /**
   * The stream's error code (`failed`, `rate_limited`, `budget_exhausted`…), or one this page
   * does not know yet: the stream's codes are open (the contract's OpenErrorCode).
   */
  code: ErrorCode | (string & {});
}

/**
 * The facts "more facts" added to one result, their claims and the round to ask for next.
 * The rounds are the contract's (@liner-notes/contract/factoids).
 */
export interface MoreFacts {
  /** The result they add to (moreFactsKey): its run id and track id. */
  result: string;
  /** The facts, in the order they came, each once (by id). */
  factoids: Factoid[];
  /** Their claims as the API sent them, by claim id: each once, whatever answer sent it. */
  claims: Record<string, Claim>;
  /** The round to ask for next: FIRST_FACTOID_ROUND, then each answer's `nextRound`. */
  nextRound: number;
  /** Every round has been asked: asking again would give nothing new, so no request is made. */
  finished: boolean;
  /** The facts of the latest answer that could not be written, by index; the others are kept. */
  failed: FailedFact[];
  /**
   * The latest answer failed as a whole: an error for the whole answer that is not one of the
   * reasons the caller is told (onUnavailable), a stream that broke, or one that stopped
   * responding. Its round is asked again on the next click.
   */
  answerFailed: boolean;
  /**
   * The analysis run whose evidence the latest answer's facts were checked against: the stream's
   * own run id. Null when they were written without one (the result names no run, or the API has
   * no stored result for it), so every one of them reads as inferred.
   */
  runId: string | null;
}

/** How a "more facts" request is made, besides the result it is for. */
export interface MoreFactsOptions {
  /** Aborting it closes the stream; the promise then rejects with an AbortError. */
  signal?: AbortSignal;
  /**
   * Called when the API cannot write facts now: its rate limit, a paused budget, live calls
   * switched off, or a replayed result whose recording is no longer served.
   */
  onUnavailable?: (code: FactoidUnavailableCode) => void;
}

/** How a result was produced: computed live, or a recorded run replayed. */
export type ResultMode = 'live' | 'replay';

/**
 * How a row of the track picker was chosen: a click (or Enter) on it. "countdown" is found only
 * in older recordings, from when the picker chose the highlighted row after a few seconds; the
 * picker now waits for the user. A deliberate click is not warned about a loose search match.
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
   * Asks for the next round of facts about `result` and keeps them, with their claims, in
   * `moreFacts`. Resolves with the facts this answer added; once every round has been asked it
   * resolves with none and makes no request. The stream is closed, and the promise rejects with
   * an AbortError, when `options.signal` aborts or a new analysis starts.
   */
  moreFactoidsStream: (result: TrackData, options?: MoreFactsOptions) => Promise<Factoid[]>;
  /** Rejects when the request fails, or when `signal` aborts it. */
  searchSuggest: (
    query: string,
    limit?: number,
    signal?: AbortSignal,
  ) => Promise<SearchCandidate[]>;
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
