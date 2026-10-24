/**
 * Composed results kept in the long-term store (TRACKS_NAMESPACE), keyed by the track they are
 * about (see cacheKeys.ts).
 *
 * A result is stored without what belongs to the run that composed it: its run information, its
 * preview URLs (handed out for one run, and they expire) and how that run's search text matched
 * the track. It is served for 24 hours, only for the track it is about and only while the
 * contract accepts it; the run that serves it adds how its own search text matched the track.
 */

import type { BaseStore } from "@langchain/langgraph";
import { type QueryMatch, TrackAnalysis } from "@liner-notes/contract";
import { withoutPreviewUrls } from "../store/runs.js";
import { configuredSources, resultCacheKey, TRACKS_NAMESPACE } from "./cacheKeys.js";
import type { TrackData } from "./schema.js";

/** How long a stored result is served. */
export const STORED_RESULT_TTL_MS = 24 * 60 * 60 * 1000;
/** How far ahead of the clock a stored result's time may be (clocks of other hosts drift). */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

interface StoredValue {
  trackData?: unknown;
  timestamp?: unknown;
}

/**
 * The result stored for a track (by its Spotify id) for the sources configured now, as the
 * contract reads it, or null: none, expired, dated in the future, refused by the contract, about
 * another track, or the store could not be read.
 */
export async function readStoredResult(
  store: BaseStore | undefined,
  trackId: string,
  now: Date,
): Promise<TrackData | null> {
  if (!store) return null;
  try {
    const item = await store.get(TRACKS_NAMESPACE, resultCacheKey(trackId, configuredSources()));
    const value = (item?.value ?? null) as StoredValue | null;
    if (!value?.trackData || typeof value.timestamp !== "number") return null;
    const age = now.getTime() - value.timestamp;
    // A result dated ahead of the clock (a clock set back, a database from another host) would
    // be served past its 24 hours.
    if (age >= STORED_RESULT_TTL_MS || age < -CLOCK_SKEW_MS) return null;
    // A stored result the contract no longer accepts would be refused on every run until it
    // expires: it is composed again instead.
    const checked = TrackAnalysis.safeParse(value.trackData);
    if (!checked.success) {
      console.warn("⚠️ [Store] Stored result does not fit the contract; composing again");
      return null;
    }
    if (checked.data.id !== trackId) {
      console.warn(`⚠️ [Store] Stored result for ${trackId} is about another track; ignored`);
      return null;
    }
    return checked.data as TrackData;
  } catch (error) {
    console.warn("⚠️ [Store] Stored result could not be read:", error);
    return null;
  }
}

/** A stored result as this run serves it: with how this run's search text matched the track. */
export function servedResult(stored: TrackData, queryMatch: QueryMatch | null): TrackData {
  const { queryMatch: _stored, ...result } = stored;
  return queryMatch ? { ...result, queryMatch } : result;
}

/** What is stored of a result: everything but this run's information, preview URLs and match. */
export function storableResult(trackData: TrackData): unknown {
  const { run: _run, queryMatch: _match, ...kept } = trackData;
  return withoutPreviewUrls(kept);
}

/** Stores a result under its track for the sources configured now. Throws on a store error. */
export async function storeResult(
  store: BaseStore,
  trackData: TrackData,
  now: Date,
): Promise<void> {
  await store.put(TRACKS_NAMESPACE, resultCacheKey(trackData.id, configuredSources()), {
    trackData: storableResult(trackData),
    timestamp: now.getTime(),
  });
}
