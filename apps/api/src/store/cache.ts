/**
 * SonicCache — typed cache tables for expensive lookups
 *
 * Separate tables for each data type (audio, research, artwork), each with a TTL. Stored JSON
 * is validated when read; a row that does not match is treated as a miss.
 *
 * The audio cache holds measurements only. A row is served only when its stored data carries
 * the `measured` marker the engineer sets on audio service measurements; a measured row with
 * low confidence is served too, with its confidence. Writes of unmarked features are refused.
 *
 * Reads return null on a database error (the caller then does the work again). Writes throw,
 * after logging, so the caller decides whether a failed write matters.
 */

import type Database from "better-sqlite3";
import { SourceError } from "@liner-notes/contract";
import { z } from "zod";
import type { AudioFeatures, ResearchData } from "../agent/state.js";
import {
  isMatchedMeasurement,
  isMeasuredAudio,
  LOW_CONFIDENCE_AUDIO_TTL_MS,
  parseMeasuredAudio,
} from "./measuredAudio.js";

export { isMatchedMeasurement, isMeasuredAudio } from "./measuredAudio.js";

// =============================================================================
// Types
// =============================================================================

/**
 * What the artwork cache keeps of a Spotify search: the cover and the track it belongs to. No
 * preview URL: previews are looked up afresh for each run and never stored (the table's
 * `preview_url` column is left null; migration 6 cleared the values older code wrote).
 */
export interface SpotifySearchResult {
  coverUrl: string | null;
  spotifyUrl: string | null;
  spotifyId: string | null;
  trackTitle: string | null;
  trackArtist: string | null;
}

// =============================================================================
// TTL Defaults (ms)
// =============================================================================

/** A complete measurement (tempo, key and every perceptual feature) is kept for 30 days. */
const TTL_AUDIO_HIGH = 30 * 24 * 60 * 60 * 1000;
/** A partial (low-confidence) measurement is kept for a day; see measuredAudio.ts. */
const TTL_AUDIO_LOW = LOW_CONFIDENCE_AUDIO_TTL_MS;
const TTL_RESEARCH = 48 * 60 * 60 * 1000; // 48 hours
const TTL_ARTWORK = 7 * 24 * 60 * 60 * 1000; // 7 days

// =============================================================================
// Stored data schemas
// =============================================================================

const stringList = z.array(z.string());

const ResearchSchema = z
  .object({
    samples: stringList,
    productionTrivia: stringList,
    collaborators: stringList.optional(),
    lastfmTags: stringList.optional(),
    lastfmArtistTags: stringList.optional(),
    lastfmSimilarTracks: stringList.optional(),
    lastfmSimilarArtists: stringList.optional(),
    lastfmArtistBio: z.string().optional(),
    listenbrainzSimilarArtists: stringList.optional(),
    noneFound: stringList.optional(),
    notAsked: stringList.optional(),
    collaboratorsOf: z.string().optional(),
    notConfigured: z.array(SourceError).optional(),
  })
  // Fields the reader does not know (from older code) are dropped, never passed on.
  .strip();

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const nowSec = () => Math.floor(Date.now() / 1000);

// =============================================================================
// SonicCache
// =============================================================================

function prepareStatements(db: Database.Database) {
  return {
    getAudio: db.prepare<[string], { full_data: string; expires_at: number }>(
      "SELECT full_data, expires_at FROM audio_cache WHERE spotify_id = ?",
    ),
    putAudio: db.prepare(
      `INSERT INTO audio_cache (spotify_id, bpm, key_signature, energy, confidence, full_data, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(spotify_id) DO UPDATE SET
         bpm = excluded.bpm,
         key_signature = excluded.key_signature,
         energy = excluded.energy,
         confidence = excluded.confidence,
         full_data = excluded.full_data,
         created_at = unixepoch(),
         expires_at = excluded.expires_at`,
    ),
    getResearch: db.prepare<[string], { full_data: string; expires_at: number }>(
      "SELECT full_data, expires_at FROM research_cache WHERE spotify_id = ?",
    ),
    putResearch: db.prepare(
      `INSERT INTO research_cache (spotify_id, samples_count, trivia_count, full_data, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(spotify_id) DO UPDATE SET
         samples_count = excluded.samples_count,
         trivia_count = excluded.trivia_count,
         full_data = excluded.full_data,
         expires_at = excluded.expires_at`,
    ),
    getArtwork: db.prepare<
      [string],
      {
        cover_url: string | null;
        spotify_url: string | null;
        spotify_id: string | null;
        track_title: string | null;
        track_artist: string | null;
        expires_at: number;
      }
    >(
      "SELECT cover_url, spotify_url, spotify_id, track_title, track_artist, expires_at FROM artwork_cache WHERE search_key = ?",
    ),
    putArtwork: db.prepare(
      `INSERT INTO artwork_cache (search_key, cover_url, spotify_url, spotify_id, track_title, track_artist, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(search_key) DO UPDATE SET
         cover_url = excluded.cover_url,
         spotify_url = excluded.spotify_url,
         preview_url = NULL,
         spotify_id = excluded.spotify_id,
         track_title = excluded.track_title,
         track_artist = excluded.track_artist,
         expires_at = excluded.expires_at`,
    ),
    purgeAudio: db.prepare("DELETE FROM audio_cache WHERE expires_at <= ?"),
    purgeResearch: db.prepare("DELETE FROM research_cache WHERE expires_at <= ?"),
    purgeArtwork: db.prepare("DELETE FROM artwork_cache WHERE expires_at <= ?"),
  };
}

export class SonicCache {
  private readonly stmt: ReturnType<typeof prepareStatements>;

  constructor(db: Database.Database) {
    this.stmt = prepareStatements(db);
  }

  // ---------------------------------------------------------------------------
  // Audio Cache
  // ---------------------------------------------------------------------------

  /** A cached measurement, or null (missing, expired, unmarked or not a valid measurement). */
  getAudio(spotifyId: string): AudioFeatures | null {
    try {
      const row = this.stmt.getAudio.get(spotifyId);
      if (!row || nowSec() >= row.expires_at) return null;

      const features = parseMeasuredAudio(row.full_data);
      if (!features) {
        console.warn(`[SonicCache] Ignoring audio row for ${spotifyId}: not a marked measurement`);
      }
      return features;
    } catch (err) {
      console.error("[SonicCache] getAudio error:", err);
      return null;
    }
  }

  /**
   * Caches a measurement. Throws on unmarked features and on database errors. A complete
   * (high-confidence) measurement that has not expired is not replaced by a partial one; a
   * stored row that is not a valid measurement, or does not say how its clip was matched (see
   * isMatchedMeasurement), counts as absent and is overwritten.
   */
  putAudio(spotifyId: string, features: AudioFeatures, ttlMs?: number): void {
    if (!isMeasuredAudio(features)) {
      throw new TypeError(
        "Only measured audio features (measured: true, from the audio service) can be cached",
      );
    }
    try {
      const now = nowSec();
      const row = this.stmt.getAudio.get(spotifyId);
      const stored = row && now < row.expires_at ? parseMeasuredAudio(row.full_data) : null;
      const existing = isMatchedMeasurement(stored) ? stored : null;
      if (existing?.confidence === "high" && features.confidence === "low") {
        console.log(`[SonicCache] Keeping the complete audio row for ${spotifyId}`);
        return;
      }

      const ttl = ttlMs ?? (features.confidence === "high" ? TTL_AUDIO_HIGH : TTL_AUDIO_LOW);
      this.stmt.putAudio.run(
        spotifyId,
        features.bpm,
        features.key,
        features.energy,
        features.confidence,
        JSON.stringify(features),
        now + Math.floor(ttl / 1000),
      );
    } catch (err) {
      console.error("[SonicCache] putAudio error:", err);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Research Cache
  // ---------------------------------------------------------------------------

  getResearch(spotifyId: string): ResearchData | null {
    try {
      const row = this.stmt.getResearch.get(spotifyId);
      if (!row || nowSec() >= row.expires_at) return null;

      const parsed = ResearchSchema.safeParse(parseJson(row.full_data));
      if (!parsed.success) {
        console.warn(`[SonicCache] Ignoring research row for ${spotifyId}: unexpected shape`);
        return null;
      }
      return parsed.data as ResearchData;
    } catch (err) {
      console.error("[SonicCache] getResearch error:", err);
      return null;
    }
  }

  putResearch(spotifyId: string, data: ResearchData, ttlMs: number = TTL_RESEARCH): void {
    try {
      this.stmt.putResearch.run(
        spotifyId,
        data.samples?.length ?? 0,
        data.productionTrivia?.length ?? 0,
        JSON.stringify(data),
        nowSec() + Math.floor(ttlMs / 1000),
      );
    } catch (err) {
      console.error("[SonicCache] putResearch error:", err);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Artwork Cache
  // ---------------------------------------------------------------------------

  getArtwork(searchKey: string): SpotifySearchResult | null {
    try {
      const row = this.stmt.getArtwork.get(searchKey);
      if (!row || nowSec() >= row.expires_at) return null;

      return {
        coverUrl: row.cover_url,
        spotifyUrl: row.spotify_url,
        spotifyId: row.spotify_id,
        trackTitle: row.track_title,
        trackArtist: row.track_artist,
      };
    } catch (err) {
      console.error("[SonicCache] getArtwork error:", err);
      return null;
    }
  }

  putArtwork(searchKey: string, result: SpotifySearchResult, ttlMs: number = TTL_ARTWORK): void {
    try {
      this.stmt.putArtwork.run(
        searchKey,
        result.coverUrl,
        result.spotifyUrl,
        result.spotifyId,
        result.trackTitle,
        result.trackArtist,
        nowSec() + Math.floor(ttlMs / 1000),
      );
    } catch (err) {
      console.error("[SonicCache] putArtwork error:", err);
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Purge Expired Entries
  // ---------------------------------------------------------------------------

  purgeExpired(): { audio: number; research: number; artwork: number } {
    const now = nowSec();

    try {
      const audio = this.stmt.purgeAudio.run(now).changes;
      const research = this.stmt.purgeResearch.run(now).changes;
      const artwork = this.stmt.purgeArtwork.run(now).changes;

      if (audio + research + artwork > 0) {
        console.log(
          `[SonicCache] Purged expired: ${audio} audio, ${research} research, ${artwork} artwork`,
        );
      }

      return { audio, research, artwork };
    } catch (err) {
      console.error("[SonicCache] purgeExpired error:", err);
      return { audio: 0, research: 0, artwork: 0 };
    }
  }
}

// =============================================================================
// Singleton
// =============================================================================

let cacheInstance: SonicCache | null = null;

export function initCache(db: Database.Database): SonicCache {
  cacheInstance = new SonicCache(db);
  return cacheInstance;
}

export function getCache(): SonicCache {
  if (!cacheInstance) {
    throw new Error("[SonicCache] Not initialized. Call initCache(db) first.");
  }
  return cacheInstance;
}
