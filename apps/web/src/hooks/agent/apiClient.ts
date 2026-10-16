/**
 * Pure async functions wrapping fetch() for the Sonic Agent API.
 * No React, no state — independently testable.
 */

import { API_BASE_URL } from './types';
import type { Factoid } from './types';
import type { SearchCandidate } from './types';

/**
 * Analyze a song synchronously (non-streaming fallback)
 */
export async function analyzeSync(
  query: string,
  signal?: AbortSignal,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const response = await fetch(`${API_BASE_URL}/api/analyze`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal,
  });
  return response.json();
}

/**
 * Resume analysis after HITL disambiguation (non-streaming fallback)
 */
export async function resumeSync(
  threadId: string,
  selectedTrackId: string,
): Promise<{ success: boolean; data?: unknown; error?: string }> {
  const response = await fetch(`${API_BASE_URL}/api/analyze/resume`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threadId, selectedTrackId }),
  });
  return response.json();
}

/**
 * Fetch additional factoids for a track (batch)
 */
export async function fetchFactoids(
  trackId: string,
  trackTitle: string,
  trackArtist: string,
  existingIds: string[],
): Promise<Factoid[]> {
  const response = await fetch(`${API_BASE_URL}/api/factoids/decrypt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      trackId,
      trackTitle,
      trackArtist,
      existingFactoidIds: existingIds,
    }),
  });

  const result = await response.json();

  if (result.success && result.factoids) {
    return result.factoids as Factoid[];
  }

  throw new Error(result.error || 'Failed to decrypt factoids');
}

/**
 * Fetch autocomplete search suggestions
 */
export async function fetchSuggestions(
  query: string,
  limit: number = 5,
): Promise<SearchCandidate[]> {
  const response = await fetch(
    `${API_BASE_URL}/api/search/suggest?query=${encodeURIComponent(query)}&limit=${limit}`,
  );

  const result = await response.json();

  if (result.success && result.suggestions) {
    return result.suggestions as SearchCandidate[];
  }

  return [];
}
