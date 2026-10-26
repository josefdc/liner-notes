/**
 * The latest stored result of a track (GET /api/runs/by-track/:spotifyId): what a link to
 * `/t/<spotifyId>` shows. Reading it starts no analysis and costs nothing.
 */

import type { TrackData } from '../../types';
import { loadEventSchemas, withContractAudio } from './events';
import { API_BASE_URL } from './types';

export type StoredRunResult =
  /** The track's latest stored result. */
  | { kind: 'found'; track: TrackData }
  /** The API has no stored result for the track (404 `not_found`). */
  | { kind: 'missing' }
  /** The API refused the id (400): it is not a Spotify track id. */
  | { kind: 'invalid' }
  /** Anything else: no answer, another error, or an answer this page cannot use. */
  | { kind: 'failed' };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

async function bodyOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/**
 * Loads the latest stored result of a track. Rejects only with an AbortError, when `signal`
 * aborts; every other failure is a `failed` result.
 */
export async function fetchStoredRun(
  trackId: string,
  signal?: AbortSignal,
): Promise<StoredRunResult> {
  try {
    const response = await fetch(`${API_BASE_URL}/runs/by-track/${encodeURIComponent(trackId)}`, {
      signal,
    });
    const body = await bodyOf(response);
    // Only the API's own answers count: a 404 from anything in between (a proxy without the
    // API behind it) says nothing about the track.
    const code = isObject(body) ? body.code : undefined;
    if (response.status === 404) return code === 'not_found' ? { kind: 'missing' } : failed();
    if (response.status === 400) return code === 'invalid_input' ? { kind: 'invalid' } : failed();
    if (!response.ok || !isObject(body) || body.success !== true) return failed();
    // A run without a result of its own has nothing to show.
    if (body.analysis === null) return { kind: 'missing' };
    const analysis = body.analysis;
    // Another track's result is never shown under this one's address.
    if (!isObject(analysis) || analysis.id !== trackId) return failed();
    // The measurement is read only as the contract reads it, as for a streamed result.
    await loadEventSchemas();
    const { AudioFeatures } = await import('./eventSchemas');
    const track = withContractAudio(analysis, (audio) => {
      const parsed = AudioFeatures.safeParse(audio);
      return parsed.success ? parsed.data : null;
    });
    return { kind: 'found', track };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    console.warn('[storedRun] The stored result could not be loaded:', error);
    return failed();
  }
}

function failed(): StoredRunResult {
  return { kind: 'failed' };
}
