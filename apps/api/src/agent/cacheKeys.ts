/**
 * Keys of what the agent caches, with the version of what is stored under them. A change in
 * what a cached value means bumps its version, so values cached by older code are not served
 * (they expire on their own).
 *
 * v2: results and research of the provider layer — claims, a genealogy of inferred influences,
 * template segments, and research cached only when it is complete.
 */

/** Long-term store namespace of composed results, keyed by the normalised query. */
export const TRACKS_NAMESPACE: string[] = ["tracks", "v2"];

/** Research cache key of a track. */
export const researchCacheKey = (spotifyId: string) => `v2:${spotifyId}`;
