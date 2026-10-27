/**
 * Pure async functions wrapping the fetch API for the Liner Notes API.
 * No React, no state — independently testable.
 *
 * The analysis itself runs over event streams (see useAgent); there is deliberately no
 * request-based fallback that would start a second run of it.
 */

import { API_BASE_URL } from './types';
import type { SearchCandidate } from './types';

/**
 * Fetch autocomplete search suggestions. Rejects when `signal` aborts the request.
 */
export async function fetchSuggestions(
  query: string,
  limit: number = 5,
  signal?: AbortSignal,
): Promise<SearchCandidate[]> {
  const response = await fetch(
    `${API_BASE_URL}/search/suggest?query=${encodeURIComponent(query)}&limit=${limit}`,
    { signal },
  );
  if (!response.ok) {
    throw new Error(`Search suggestions failed (HTTP ${response.status})`);
  }

  const result = await response.json();

  if (result.success && result.suggestions) {
    return result.suggestions as SearchCandidate[];
  }

  return [];
}

/** A recorded run the API can replay (GET /api/replays): a showcase track. */
export interface ReplayTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  /** When the run was recorded (ISO time). */
  recordedAt: string;
}

const isReplayTrack = (value: unknown): value is ReplayTrack => {
  if (typeof value !== 'object' || value === null) return false;
  const { id, title, artist, album, recordedAt } = value as Record<string, unknown>;
  return (
    typeof id === 'string' &&
    id !== '' &&
    typeof title === 'string' &&
    typeof artist === 'string' &&
    typeof album === 'string' &&
    typeof recordedAt === 'string'
  );
};

/**
 * The recorded runs the API can replay. Entries this page cannot read are left out; a failed
 * request rejects, so the caller can say the list is unavailable.
 */
export async function fetchReplays(): Promise<ReplayTrack[]> {
  const response = await fetch(`${API_BASE_URL}/replays`);
  if (!response.ok) {
    throw new Error(`Recorded tracks unavailable (HTTP ${response.status})`);
  }
  const result = await response.json();
  return Array.isArray(result?.replays) ? result.replays.filter(isReplayTrack) : [];
}

/** A run token (POST /api/runs) and when it expires, in milliseconds since the epoch. */
export interface RunToken {
  runToken: string;
  expiresAt: number;
}

/**
 * A request the API refused: its code and message (a JSON error), or the app's own code when
 * the API could not be reached or gave no answer this page can read. `retryAfterMs`: how long
 * the API said to wait before asking again (its Retry-After header), when it said.
 */
export class RunTokenError extends Error {
  constructor(
    message: string,
    readonly code: string | null,
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = 'RunTokenError';
  }
}

/**
 * The longest wait this page keeps from a refusal: a longer one (a proxy's or a misconfigured
 * server's Retry-After, or one too large to read) is taken as this, so the page never locks
 * itself until a reload. The API's own limits reset within minutes.
 */
export const MAX_RETRY_WAIT_MS = 60 * 60_000;

/** `ms` as a wait this page keeps: at most MAX_RETRY_WAIT_MS, which a non-finite value is too. */
export function boundedWait(ms: number): number {
  return Number.isFinite(ms) ? Math.min(Math.max(0, ms), MAX_RETRY_WAIT_MS) : MAX_RETRY_WAIT_MS;
}

/**
 * A Retry-After header's wait in milliseconds: a number of seconds, or an HTTP date (the time
 * left until then), at most MAX_RETRY_WAIT_MS. Null without a header or for one this page
 * cannot read.
 */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
  const value = header?.trim() ?? '';
  if (/^\d+$/.test(value)) return boundedWait(Number(value) * 1000);
  // An HTTP date names its day and month ("Tue, 27 Oct 2026 12:00:00 GMT"); Date.parse would
  // also read "-5" or "1.5" as dates.
  const at = /[a-z]/i.test(value) ? Date.parse(value) : Number.NaN;
  return Number.isNaN(at) ? null : boundedWait(at - now);
}

/**
 * Asks the API for a run token, with the token of a passed Turnstile check (or the development
 * bypass's). Rejects with a RunTokenError carrying the API's code and message when it refuses
 * (and its Retry-After, as `retryAfterMs`), and as fetch does when `signal` aborts the request.
 */
export async function requestRunToken(
  turnstileToken: string,
  signal?: AbortSignal,
): Promise<RunToken> {
  const response = await fetch(`${API_BASE_URL}/runs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ turnstileToken }),
    signal,
  });
  const body: unknown = await response.json().catch(() => null);
  const fields = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  if (!response.ok) {
    throw new RunTokenError(
      typeof fields.error === 'string'
        ? fields.error
        : `Run token refused (HTTP ${response.status})`,
      typeof fields.code === 'string' ? fields.code : null,
      retryAfterMs(response.headers.get('Retry-After')),
    );
  }
  const expiresAt = typeof fields.expiresAt === 'string' ? Date.parse(fields.expiresAt) : NaN;
  if (typeof fields.runToken !== 'string' || fields.runToken === '' || Number.isNaN(expiresAt)) {
    throw new RunTokenError('The run token answer could not be read', null);
  }
  return { runToken: fields.runToken, expiresAt };
}
