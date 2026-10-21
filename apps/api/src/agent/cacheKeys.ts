/**
 * Keys of what the agent caches, with the version of what is stored under them. A change in
 * what a cached value means bumps its version, so values cached by older code are not served
 * (they expire on their own).
 *
 * v2: results and research of the provider layer — claims, a genealogy of inferred influences,
 * template segments, and research cached only when it is complete.
 * v3: research read by type — similar artists and tracks by rank with their raw score (no
 * percentages), ListenBrainz about the track's own artist only, empty and skipped steps
 * recorded, the sources that are not configured stored with the research; the research key
 * names which optional sources were configured, so adding a key later runs the research again.
 */

/** Long-term store namespace of composed results, keyed by the normalised query. */
export const TRACKS_NAMESPACE: string[] = ["tracks", "v3"];

/** The optional research sources that were configured (had a key) when research was made. */
export interface ConfiguredSources {
  lastfm: boolean;
  tavily: boolean;
}

/** Research cache key of a track, for the sources configured now. */
export const researchCacheKey = (spotifyId: string, configured: ConfiguredSources) =>
  `v3:${spotifyId}:lastfm=${configured.lastfm ? 1 : 0}:tavily=${configured.tavily ? 1 : 0}`;
