/**
 * Pure async functions wrapping the fetch API for the Sonic Agent API.
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
