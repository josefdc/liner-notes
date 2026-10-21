/**
 * Keys of what the agent caches, with the version of what is stored under them. A change in
 * what a cached value means bumps its version, so values cached by older code are not served
 * (they expire on their own).
 *
 * v2: results and research of the provider layer — claims, a genealogy of inferred influences,
 * template segments, and research cached only when it is complete.
 * v3: research read by type — similar artists and tracks by rank with their raw score (no
 * percentages), ListenBrainz about the track's own artist only, empty and skipped steps
 * recorded, the sources that are not configured stored with the research. Both the research key
 * and the result key name which optional sources (Last.fm, Tavily) had a key, so adding a key
 * later runs the research and the composer again. A rejected key is not "not configured": it
 * blocks both caches until it is fixed, as any other source failure does.
 */

import { lastfmConfigured } from "../sources/lastfm.js";
import { tavilyConfigured } from "../sources/search.js";

/** Long-term store namespace of composed results, keyed by `resultCacheKey`. */
export const TRACKS_NAMESPACE: string[] = ["tracks", "v3"];

/** The optional research sources that are configured (have a key). */
export interface ConfiguredSources {
  lastfm: boolean;
  tavily: boolean;
}

/** The optional research sources configured now. */
export function configuredSources(): ConfiguredSources {
  return { lastfm: lastfmConfigured(), tavily: tavilyConfigured() };
}

const flags = (configured: ConfiguredSources) =>
  `lastfm=${configured.lastfm ? 1 : 0}:tavily=${configured.tavily ? 1 : 0}`;

/** Research cache key of a track, for the sources configured now. */
export const researchCacheKey = (spotifyId: string, configured: ConfiguredSources) =>
  `v3:${spotifyId}:${flags(configured)}`;

/** Result cache key of a query (normalised), for the sources configured now. */
export const resultCacheKey = (normalizedQuery: string, configured: ConfiguredSources) =>
  `${normalizedQuery}|${flags(configured)}`;
