/**
 * Errors and refusals: why a run failed (`error`, `errorCode`), the codes of the failures the
 * hook raises itself, and a refusal's wait (`retryAt`), before which no request is sent.
 * Plain functions, no React.
 */

import { boundedWait, RunTokenError } from './apiClient';
import type { AgentAction } from './state';
import { TURNSTILE_ERROR_CODES } from './turnstile';
import type { AgentState } from './types';

export type FailureState = Pick<AgentState, 'error' | 'errorCode' | 'retryAt'>;

export const INITIAL_FAILURE: FailureState = { error: null, errorCode: null, retryAt: null };

/**
 * The error of a run this page cannot follow: the API sent an outcome it cannot read, or the
 * code that reads the streams could not be loaded (both happen after a newer version was
 * deployed). The code is the app's own, not one the API sends.
 */
export const OUTDATED_ERROR = {
  code: 'outdated_client',
  message:
    'This page is out of date and cannot show the analysis. Reload the page, then search again.',
} as const;

/**
 * Codes for the failures this hook raises itself, so the page can explain each one. They are the
 * app's own, not codes the API sends (`no_match` has the same meaning as the API's).
 */
export const CLIENT_ERROR_CODES = {
  noMatch: 'no_match',
  wrongTrack: 'wrong_track',
  noResult: 'no_result',
  streamStalled: 'stream_stalled',
  connectionLost: 'connection_lost',
  choiceLost: 'choice_lost',
  // The stream could not be opened (the exception's own text is kept in `error`, never shown).
  streamOpenFailed: 'stream_open_failed',
  resumeFailed: 'resume_failed',
  // The server answered the stream's request with an error status (an EventSource cannot read
  // which): a run token it refused, most often. A retry asks for a new one.
  streamRefused: 'stream_refused',
  // The Turnstile check gave no token (agent/turnstile.ts): its script could not be loaded, the
  // widget reported an error, or no answer came in time. A retry runs a new check.
  verificationUnavailable: TURNSTILE_ERROR_CODES.unavailable,
  verificationFailed: TURNSTILE_ERROR_CODES.failed,
  verificationTimeout: TURNSTILE_ERROR_CODES.timeout,
} as const;

/**
 * Why a run token could not be had, as an error the run ends with: the API's refusal (its code,
 * message and Retry-After), a Turnstile check that gave no token, an answer this page cannot read
 * (`unreadableCode`), or no answer at all (the connection failed).
 */
export function tokenFailure(
  error: unknown,
  unreadableCode: string,
): { message: string; code: string; retryAfterMs?: number } {
  if (error instanceof RunTokenError) {
    return {
      message: error.message,
      code: error.code ?? unreadableCode,
      ...(error.retryAfterMs !== null && { retryAfterMs: error.retryAfterMs }),
    };
  }
  return {
    message: error instanceof Error ? error.message : 'Connection failed',
    code: CLIENT_ERROR_CODES.connectionLost,
  };
}

/**
 * A refusal that said how long to wait (a rate limit: the stream's `retryAfterMs`, or the
 * Retry-After of POST /api/runs): until when, and what it said. No analysis or factoid request
 * is sent before then. The analysis and factoid routes count against the same limits; POST
 * /api/runs has a limit of its own, but its wait holds both back too (a factoid request with a
 * token still good might have gone through): one wait, on the safe side.
 */
export interface Wait {
  until: number;
  message: string;
  code: string | null;
}

/** The latest refusal that said how long to wait, kept for one page. */
export function waitKeeper() {
  // Null or past once requests may go.
  let wait: Wait | null = null;
  return {
    /** Keeps a refusal's wait, unless a later one is kept already. Returns until when. */
    holdOff(retryAfterMs: number, message: string, code: string | null): number {
      // At most MAX_RETRY_WAIT_MS, whatever the refusal said.
      const until = Date.now() + boundedWait(retryAfterMs);
      if (!wait || wait.until < until) wait = { until, message, code };
      return wait.until;
    },
    /** The wait still under way, if any. */
    waiting(): Wait | null {
      return wait && wait.until > Date.now() ? wait : null;
    },
  };
}

export type WaitKeeper = ReturnType<typeof waitKeeper>;

/** Why the run failed after `action`; the same object when the action does not change it. */
export function failureReducer(state: FailureState, action: AgentAction): FailureState {
  switch (action.type) {
    case 'reset':
    case 'started':
      return INITIAL_FAILURE;
    case 'failed':
      return { error: action.message, errorCode: action.code, retryAt: action.retryAt };
    default:
      return state;
  }
}
