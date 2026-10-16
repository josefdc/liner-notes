/**
 * SonicCache — Typed cache tables for expensive API responses
 *
 * Separate tables for each data type (audio, research, artwork) with TTL.
 * Called directly from nodes; no stringly-typed keys.
 */

import type Database from "better-sqlite3";
import type { AudioFeatures } from "../agent/state.js";
import type { ResearchData } from "../agent/state.js";

// =============================================================================
// Types
// =============================================================================

export interface SpotifySearchResult {
  coverUrl: string | null;
  spotifyUrl: string | null;
  previewUrl: string | null;
  spotifyId: string | null;
  trackTitle: string | null;
  trackArtist: string | null;
}

// =============================================================================
// TTL Defaults (ms)
// =============================================================================

const TTL_AUDIO = 30 * 24 * 60 * 60 * 1000;     // 30 days
const TTL_RESEARCH = 48 * 60 * 60 * 1000;         // 48 hours
const TTL_ARTWORK = 7 * 24 * 60 * 60 * 1000;      // 7 days

// =============================================================================
// SonicCache
// =============================================================================

export class SonicCache {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ---------------------------------------------------------------------------
  // Audio Cache
  // ---------------------------------------------------------------------------

  getAudio(spotifyId: string): AudioFeatures | null {
    try {
      const row = this.db
        .prepare("SELECT full_data, confidence, expires_at FROM audio_cache WHERE spotify_id = ?")
        .get(spotifyId) as { full_data: string; confidence: string; expires_at: number } | undefined;

      if (!row) return null;

      // Check TTL
      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec >= row.expires_at) return null;

      return JSON.parse(row.full_data) as AudioFeatures;
    } catch (err) {
      console.error("[SonicCache] getAudio error:", err);
      return null;
    }
  }

  putAudio(spotifyId: string, features: AudioFeatures, ttlMs: number = TTL_AUDIO): void {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const expiresAt = nowSec + Math.floor(ttlMs / 1000);

      // Overwrite protection: don't replace "high" confidence with "low"
      const existing = this.db
        .prepare("SELECT confidence FROM audio_cache WHERE spotify_id = ?")
        .get(spotifyId) as { confidence: string } | undefined;

      if (existing && existing.confidence === "high" && features.confidence === "low") {
        return; // Don't downgrade
      }

      this.db
        .prepare(
          `INSERT INTO audio_cache (spotify_id, bpm, key_signature, energy, confidence, full_data, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(spotify_id) DO UPDATE SET
             bpm = excluded.bpm,
             key_signature = excluded.key_signature,
             energy = excluded.energy,
             confidence = excluded.confidence,
             full_data = excluded.full_data,
             expires_at = excluded.expires_at`
        )
        .run(
          spotifyId,
          features.bpm,
          features.key,
          features.energy,
          features.confidence,
          JSON.stringify(features),
          expiresAt
        );
    } catch (err) {
      console.error("[SonicCache] putAudio error:", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Research Cache
  // ---------------------------------------------------------------------------

  getResearch(spotifyId: string): ResearchData | null {
    try {
      const row = this.db
        .prepare("SELECT full_data, expires_at FROM research_cache WHERE spotify_id = ?")
        .get(spotifyId) as { full_data: string; expires_at: number } | undefined;

      if (!row) return null;

      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec >= row.expires_at) return null;

      return JSON.parse(row.full_data) as ResearchData;
    } catch (err) {
      console.error("[SonicCache] getResearch error:", err);
      return null;
    }
  }

  putResearch(spotifyId: string, data: ResearchData, ttlMs: number = TTL_RESEARCH): void {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const expiresAt = nowSec + Math.floor(ttlMs / 1000);

      this.db
        .prepare(
          `INSERT INTO research_cache (spotify_id, samples_count, trivia_count, full_data, expires_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(spotify_id) DO UPDATE SET
             samples_count = excluded.samples_count,
             trivia_count = excluded.trivia_count,
             full_data = excluded.full_data,
             expires_at = excluded.expires_at`
        )
        .run(
          spotifyId,
          data.samples?.length ?? 0,
          data.productionTrivia?.length ?? 0,
          JSON.stringify(data),
          expiresAt
        );
    } catch (err) {
      console.error("[SonicCache] putResearch error:", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Artwork Cache
  // ---------------------------------------------------------------------------

  getArtwork(searchKey: string): SpotifySearchResult | null {
    try {
      const row = this.db
        .prepare(
          "SELECT cover_url, spotify_url, preview_url, spotify_id, track_title, track_artist, expires_at FROM artwork_cache WHERE search_key = ?"
        )
        .get(searchKey) as {
        cover_url: string | null;
        spotify_url: string | null;
        preview_url: string | null;
        spotify_id: string | null;
        track_title: string | null;
        track_artist: string | null;
        expires_at: number;
      } | undefined;

      if (!row) return null;

      const nowSec = Math.floor(Date.now() / 1000);
      if (nowSec >= row.expires_at) return null;

      return {
        coverUrl: row.cover_url,
        spotifyUrl: row.spotify_url,
        previewUrl: row.preview_url,
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
      const nowSec = Math.floor(Date.now() / 1000);
      const expiresAt = nowSec + Math.floor(ttlMs / 1000);

      this.db
        .prepare(
          `INSERT INTO artwork_cache (search_key, cover_url, spotify_url, preview_url, spotify_id, track_title, track_artist, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(search_key) DO UPDATE SET
             cover_url = excluded.cover_url,
             spotify_url = excluded.spotify_url,
             preview_url = excluded.preview_url,
             spotify_id = excluded.spotify_id,
             track_title = excluded.track_title,
             track_artist = excluded.track_artist,
             expires_at = excluded.expires_at`
        )
        .run(
          searchKey,
          result.coverUrl,
          result.spotifyUrl,
          result.previewUrl,
          result.spotifyId,
          result.trackTitle,
          result.trackArtist,
          expiresAt
        );
    } catch (err) {
      console.error("[SonicCache] putArtwork error:", err);
    }
  }

  // ---------------------------------------------------------------------------
  // Purge Expired Entries
  // ---------------------------------------------------------------------------

  purgeExpired(): { audio: number; research: number; artwork: number } {
    const nowSec = Math.floor(Date.now() / 1000);

    try {
      const audio = this.db
        .prepare("DELETE FROM audio_cache WHERE expires_at <= ?")
        .run(nowSec).changes;
      const research = this.db
        .prepare("DELETE FROM research_cache WHERE expires_at <= ?")
        .run(nowSec).changes;
      const artwork = this.db
        .prepare("DELETE FROM artwork_cache WHERE expires_at <= ?")
        .run(nowSec).changes;

      if (audio + research + artwork > 0) {
        console.log(
          `[SonicCache] Purged expired: ${audio} audio, ${research} research, ${artwork} artwork`
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
