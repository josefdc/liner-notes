/**
 * The latest stored result of a track (GET /api/runs/by-track/:spotifyId): what a link to
 * `/t/<spotifyId>` shows. Reading it starts no analysis and costs nothing.
 */

import type { TrackData } from '../../types';
import { loadEventSchemas, readContractAudio, withContractAudio } from './events';
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

/** How long the API is waited for before the stored result counts as not loaded. */
export const STORED_RUN_TIMEOUT_MS = 15_000;

/**
 * Loads the latest stored result of a track. Rejects only with an AbortError, when `signal`
 * aborts; every other failure is a `failed` result, an answer that takes longer than
 * `timeoutMs` included.
 */
export async function fetchStoredRun(
  trackId: string,
  signal?: AbortSignal,
  timeoutMs = STORED_RUN_TIMEOUT_MS,
): Promise<StoredRunResult> {
  // One signal for the request and the reading of its body: the caller's, or the deadline's.
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const deadline = setTimeout(() => {
    timedOut = true;
    abort();
  }, timeoutMs);
  try {
    const response = await fetch(`${API_BASE_URL}/runs/by-track/${encodeURIComponent(trackId)}`, {
      signal: controller.signal,
    });
    const body = await bodyOf(response);
    if (signal?.aborted) throw abortError();
    if (timedOut) return failed();
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
    return { kind: 'found', track: withContractAudio(analysis, readContractAudio) };
  } catch (error) {
    if (signal?.aborted) throw abortError();
    console.warn(
      '[storedRun] The stored result could not be loaded:',
      timedOut ? `no answer within ${timeoutMs} ms` : error,
    );
    return failed();
  } finally {
    clearTimeout(deadline);
    signal?.removeEventListener('abort', abort);
  }
}

function abortError(): DOMException {
  return new DOMException('The request was aborted.', 'AbortError');
}

function failed(): StoredRunResult {
  return { kind: 'failed' };
}
