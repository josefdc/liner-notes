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
 * Fetch autocomplete search suggestions
 */
export async function fetchSuggestions(
  query: string,
  limit: number = 5,
): Promise<SearchCandidate[]> {
  const response = await fetch(
    `${API_BASE_URL}/api/search/suggest?query=${encodeURIComponent(query)}&limit=${limit}`,
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
