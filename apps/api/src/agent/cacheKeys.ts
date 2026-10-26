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
 * v4: results keyed by the track (its Spotify id) instead of the search text. The search runs
 * first and picks the track; only then is a stored result looked up, so a result is never
 * served for a text that now finds another track, nor for another user's text that happened to
 * lead to a pick. Stored results carry no preview URL and no search match (both belong to one
 * run).
 * v5: results whose genealogy nodes carry a Spotify id only for a strict match of the track the
 * model named. Earlier results may carry the top search hit's id (a cover, another song), and a
 * click on such a node now analyses that id: they are not served.
 * v6: results that carry the audio measurement they were finalised from (the AudioFeatures v2
 * block, `audio`) with copies derived from it, and no 0..1 energy where its scale saturates.
 * Earlier results carry measured copies without the block that says how they were measured,
 * which the contract's producer checks refuse: they are not served, and each track searched
 * again is composed again once (one composer call; the research and the audio are cached
 * apart, though the audio cache was emptied by migration 14 and is measured again for free).
 * v7: results whose genealogy nodes carry a cover only for a strict match of the recording the
 * model named (agent/enricher.ts). Earlier results may show the cover of the top search hit (a
 * cover version, another song, a live album) on a node: they are not served, and each track
 * searched again is composed again once.
 *
 * The result key also names which primary-record sources with a credential (Discogs, Genius)
 * are configured: a result stored while one was not configured says so and holds none of its
 * records, so adding the credential composes the result again.
 *
 * Research key v4: the research is cached with the run's evidence pack (the primary sources'
 * records and the web search's results), so its key names the primary-record sources with a
 * credential too; adding DISCOGS_TOKEN or GENIUS_ACCESS_TOKEN reads the research again. A
 * SecondHandSongs key changes only its rate limit, not what it answers, and is not named. v3
 * entries are never read again (they expire on their own).
 */

import { discogsConfigured } from "../sources/discogs.js";
import { geniusConfigured } from "../sources/genius.js";
import { lastfmConfigured } from "../sources/lastfm.js";
import { tavilyConfigured } from "../sources/search.js";

/** Long-term store namespace of composed results, keyed by `resultCacheKey`. */
export const TRACKS_NAMESPACE: string[] = ["tracks", "v7"];

/** The optional sources that are configured (have a key). */
export interface ConfiguredSources {
  lastfm: boolean;
  tavily: boolean;
  /** Primary-record sources with a credential. */
  discogs: boolean;
  genius: boolean;
}

/** The optional sources configured now. */
export function configuredSources(): ConfiguredSources {
  return {
    lastfm: lastfmConfigured(),
    tavily: tavilyConfigured(),
    discogs: discogsConfigured(),
    genius: geniusConfigured(),
  };
}

const flags = (configured: ConfiguredSources) =>
  `lastfm=${configured.lastfm ? 1 : 0}:tavily=${configured.tavily ? 1 : 0}`;

const primaryFlags = (configured: ConfiguredSources) =>
  `discogs=${configured.discogs ? 1 : 0}:genius=${configured.genius ? 1 : 0}`;

/** Research cache key of a track, for the sources configured now. */
export const researchCacheKey = (spotifyId: string, configured: ConfiguredSources) =>
  `v4:${spotifyId}:${flags(configured)}:${primaryFlags(configured)}`;

/** Result cache key of a track (its Spotify id), for the sources configured now. */
export const resultCacheKey = (spotifyId: string, configured: ConfiguredSources) =>
  `${spotifyId}|${flags(configured)}:${primaryFlags(configured)}`;
