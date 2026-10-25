/**
 * SonicCache — typed cache tables for expensive lookups
 *
 * Separate tables for each data type (audio, research, artwork), each with a TTL. Stored JSON
 * is validated when read; a row that does not match is treated as a miss.
 *
 * The research cache holds a run's research with its evidence (`CachedEvidence`, inside the
 * row's JSON): the evidence pack's items, the recording the ISRC identified and the primary
 * sources' errors that did not block caching. Research cached by older code has no evidence;
 * its key version is no longer read (agent/cacheKeys.ts).
 *
 * The audio cache holds measurements only: the audio service's AudioFeatures v2 block with how
 * its clip was matched, filed under (track key, analyzer version) (see measuredAudio.ts). A row
 * is served only for the analyzer version asked for and only when it is still such a
 * measurement; a measurement with low confidence is served too, with its confidence. Writes of
 * anything else are refused.
 *
 * Reads return null on a database error (the caller then does the work again). Writes throw,
 * after logging, so the caller decides whether a failed write matters.
 */

import type Database from "better-sqlite3";
import { Evidence, SourceError, SourceId } from "@liner-notes/contract";
import { z } from "zod";
import type { ResearchData } from "../agent/state.js";
import { logger } from "../logger.js";
import type { IdentifiedRecording } from "../sources/identity.js";
import {
  audioConfidence,
  type CachedAudio,
  cacheableAudio,
  LOW_CONFIDENCE_AUDIO_TTL_MS,
  parseCachedAudio,
} from "./measuredAudio.js";

export type { CachedAudio } from "./measuredAudio.js";

const log = logger("Cache");

// =============================================================================
// Types
// =============================================================================

/**
 * What a node's preview is decided on, of the track a search found (agent/enricher.ts): none of
 * it is a link. Kept as a JSON object in the artwork cache's `track_details` (migration 13).
 */
export interface CachedTrackDetails {
  /** The track's ISRC, canonical; null when Spotify gave none. */
  isrc: string | null;
  /** The track's duration in milliseconds; null when unknown. */
  durationMs: number | null;
  /** The name of the release the track is on; null when unknown. */
  album: string | null;
  /** The release's date as Spotify gives it (YYYY, YYYY-MM or YYYY-MM-DD); null when unknown. */
  releaseDate: string | null;
}

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
  /** The lead artist. */
  trackArtist: string | null;
  /** Every credited artist, lead first; null when unknown (rows written before migration 9). */
  trackArtists?: string[] | null;
  /**
   * The found track's details; absent or null when the row keeps none (rows written before
   * migration 13, or a row kept without the track's identity).
   */
  trackDetails?: CachedTrackDetails | null;
}

/**
 * The evidence of a cached research, as the run that made it collected it: a research-cache hit
 * gives the same evidence as that run without asking the primary sources again. Written and read
 * back by agent/research/runEvidence.ts; its items become evidence again only through
 * `restoredEvidence` (agent/research/evidencePack.ts), which checks each one.
 */
export interface CachedEvidence {
  /** The version of this shape (agent/research/runEvidence.ts); a row of another is a miss. */
  format: number;
  /**
   * When the research was made (ISO 8601): a refresh of the evidence keeps it, and the row
   * expires RESEARCH_TTL_MS (agent/research/runEvidence.ts) after it.
   */
  researchedAt: string;
  /** When the run read the evidence (ISO 8601); a refresh reads it again. */
  readAt: string;
  /** The ISRC the primary sources were read from; null when the track had none (not asked). */
  isrc: string | null;
  /** The evidence pack's items, best tier first. */
  items: Evidence[];
  /** How many items the pack's size cap left out. */
  omitted: number;
  /** The recording's MusicBrainz sample relations, as the research entry the run added. */
  samples: string[];
  /** The recording the ISRC identified, for the composer; null when none was. */
  recording: IdentifiedRecording | null;
  /** Whether the recording is its song's original recording (its covers are then about it). */
  trackIsOriginal: boolean;
  /**
   * The primary sources' errors, none of which blocked caching: a source not configured, or one
   * that answered in a shape its reader does not know (also in `lasting`).
   */
  errors: SourceError[];
  lasting: SourceError[];
  /**
   * What the run left for a later run, none of which blocked caching: a source whose request
   * was not sent ("not_asked": our own pacing left no slot in time, or the run's time for the
   * primary sources ran out first), the MusicBrainz work's recordings not dated ("dates"; its
   * covers are then about the song). A hit reads the primary sources again for such a row.
   */
  incomplete: Array<{ source: SourceId; part: "not_asked" | "dates" }>;
}

/** Research as the research cache holds it. */
export type CachedResearch = ResearchData & { evidence?: CachedEvidence };

// =============================================================================
// TTL Defaults (ms)
// =============================================================================

/** A complete measurement (tempo, key and every perceptual feature) is kept for 30 days. */
const TTL_AUDIO_HIGH = 30 * 24 * 60 * 60 * 1000;
/** A partial (low-confidence) measurement is kept for a day; see measuredAudio.ts. */
const TTL_AUDIO_LOW = LOW_CONFIDENCE_AUDIO_TTL_MS;
/** The default; the historian passes its own (RESEARCH_TTL_MS, agent/research/runEvidence.ts). */
const TTL_RESEARCH = 48 * 60 * 60 * 1000;
const TTL_ARTWORK = 7 * 24 * 60 * 60 * 1000; // 7 days

// =============================================================================
// Stored data schemas
// =============================================================================

const stringList = z.array(z.string());

/** Text that holds a link; a track's details never do. */
const LINK = /https?:\/\//i;
const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;
const RELEASE_DATE = /^\d{4}(?:-\d{2}(?:-\d{2})?)?$/;

/**
 * Track details, field by field: a field that is not valid (an album name that holds a link, a
 * malformed ISRC or date, a duration that is not a positive whole number) is dropped (null) and
 * the others are kept; any other field is left out. Null when `value` is not an object.
 */
function validDetails(value: unknown): CachedTrackDetails | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const fields = value as Record<string, unknown>;
  const text = (field: unknown) => (typeof field === "string" && field ? field : null);
  const isrc = text(fields.isrc);
  const album = text(fields.album);
  const releaseDate = text(fields.releaseDate);
  const durationMs = fields.durationMs;
  return {
    isrc: isrc && ISRC.test(isrc) ? isrc : null,
    durationMs:
      typeof durationMs === "number" && Number.isInteger(durationMs) && durationMs > 0
        ? durationMs
        : null,
    album: album && !LINK.test(album) ? album : null,
    releaseDate: releaseDate && RELEASE_DATE.test(releaseDate) ? releaseDate : null,
  };
}

const RecordingSchema = z.object({
  mbid: z.string(),
  title: z.string(),
  artist: z.string(),
  lengthMs: z.number().nullable(),
  firstReleaseDate: z.string().nullable(),
  artists: z.array(z.object({ mbid: z.string(), name: z.string(), credited: z.string() })),
});

const CachedEvidenceSchema = z.object({
  format: z.number().int(),
  researchedAt: z.string(),
  readAt: z.string(),
  isrc: z.string().nullable(),
  items: z.array(Evidence),
  omitted: z.number().int().nonnegative(),
  samples: stringList,
  recording: RecordingSchema.nullable(),
  trackIsOriginal: z.boolean(),
  errors: z.array(SourceError),
  lasting: z.array(SourceError),
  incomplete: z.array(z.object({ source: SourceId, part: z.enum(["not_asked", "dates"]) })),
});

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
    evidence: CachedEvidenceSchema.optional(),
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

/** Stored track details (validDetails), or null when there are none or they are not an object. */
function trackDetails(text: string | null): CachedTrackDetails | null {
  return text ? validDetails(parseJson(text)) : null;
}

/** A stored JSON list of artist names, or null when there is none or it cannot be read. */
function artistList(text: string | null): string[] | null {
  if (!text) return null;
  const parsed = stringList.safeParse(parseJson(text));
  return parsed.success && parsed.data.length > 0 ? parsed.data : null;
}

// =============================================================================
// SonicCache
// =============================================================================

function prepareStatements(db: Database.Database) {
  return {
    getAudio: db.prepare<[string, string], { full_data: string; expires_at: number }>(
      "SELECT full_data, expires_at FROM audio_cache WHERE track_key = ? AND analyzer_version = ?",
    ),
    newestAudio: db.prepare<
      [string, number],
      { full_data: string; analyzer_version: string; created_at: number | null }
    >(
      `SELECT full_data, analyzer_version, created_at FROM audio_cache
       WHERE track_key = ? AND expires_at > ?
       ORDER BY created_at DESC, rowid DESC`,
    ),
    putAudio: db.prepare(
      `INSERT INTO audio_cache (track_key, analyzer_version, spotify_id, confidence, full_data, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(track_key, analyzer_version) DO UPDATE SET
         spotify_id = excluded.spotify_id,
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
        track_artists: string | null;
        track_details: string | null;
        expires_at: number;
      }
    >(
      "SELECT cover_url, spotify_url, spotify_id, track_title, track_artist, track_artists, track_details, expires_at FROM artwork_cache WHERE search_key = ?",
    ),
    putArtwork: db.prepare(
      `INSERT INTO artwork_cache (search_key, cover_url, spotify_url, spotify_id, track_title, track_artist, track_artists, track_details, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(search_key) DO UPDATE SET
         cover_url = excluded.cover_url,
         spotify_url = excluded.spotify_url,
         preview_url = NULL,
         spotify_id = excluded.spotify_id,
         track_title = excluded.track_title,
         track_artist = excluded.track_artist,
         track_artists = excluded.track_artists,
         track_details = excluded.track_details,
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

  /**
   * The measurement cached under `trackKey` by `analyzerVersion`, or null: none, expired, or no
   * longer a measurement the cache serves (measuredAudio.ts cacheableAudio). The row's own block
   * must name that version too.
   */
  getAudio(trackKey: string, analyzerVersion: string): CachedAudio | null {
    try {
      const row = this.stmt.getAudio.get(trackKey, analyzerVersion);
      if (!row || nowSec() >= row.expires_at) return null;
      const cached = parseCachedAudio(row.full_data);
      if (!cached) {
        log.warn(`Ignoring audio row for ${trackKey}: not a measurement the cache serves`);
        return null;
      }
      if (cached.audio.analyzerVersion !== analyzerVersion) {
        log.warn(`Ignoring audio row for ${trackKey}: filed under another analyzer version`);
        return null;
      }
      return cached;
    } catch (err) {
      log.error("Could not read an audio row", { err });
      return null;
    }
  }

  /**
   * The newest measurement cached under `trackKey` by any analyzer version, with when it was
   * stored, or null. For when the audio service cannot say its version (it is down): the block
   * names the analyzer that measured it.
   */
  getNewestAudio(trackKey: string): { measurement: CachedAudio; measuredAt: Date } | null {
    try {
      for (const row of this.stmt.newestAudio.all(trackKey, nowSec())) {
        const cached = parseCachedAudio(row.full_data);
        if (!cached || cached.audio.analyzerVersion !== row.analyzer_version) continue;
        return { measurement: cached, measuredAt: new Date((row.created_at ?? 0) * 1000) };
      }
      return null;
    } catch (err) {
      log.error("Could not read an audio row", { err });
      return null;
    }
  }

  /**
   * Caches a measurement of track `spotifyId` under `trackKey` and the analyzer version of its
   * block. Throws on anything that is not a measurement the cache serves, and on database errors.
   * A complete (high-confidence) measurement that has not expired is not replaced by a partial
   * one of the same version; a stored row that is no longer a measurement counts as absent and is
   * overwritten.
   */
  putAudio(trackKey: string, spotifyId: string, measurement: unknown, ttlMs?: number): void {
    const cached = cacheableAudio(measurement);
    if (!cached) {
      throw new TypeError(
        "Only measurements (a v2 block with a tempo and a key, and how its clip was matched) can be cached",
      );
    }
    try {
      const now = nowSec();
      const version = cached.audio.analyzerVersion;
      const confidence = audioConfidence(cached);
      const row = this.stmt.getAudio.get(trackKey, version);
      const existing = row && now < row.expires_at ? parseCachedAudio(row.full_data) : null;
      if (existing && audioConfidence(existing) === "high" && confidence === "low") {
        log.info(`Keeping the complete audio row for ${trackKey}`);
        return;
      }

      const ttl = ttlMs ?? (confidence === "high" ? TTL_AUDIO_HIGH : TTL_AUDIO_LOW);
      this.stmt.putAudio.run(
        trackKey,
        version,
        spotifyId,
        confidence,
        JSON.stringify(cached),
        now + Math.floor(ttl / 1000),
      );
    } catch (err) {
      log.error("Could not write an audio row", { err });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Research Cache
  // ---------------------------------------------------------------------------

  getResearch(spotifyId: string): CachedResearch | null {
    try {
      const row = this.stmt.getResearch.get(spotifyId);
      if (!row || nowSec() >= row.expires_at) return null;

      const parsed = ResearchSchema.safeParse(parseJson(row.full_data));
      if (!parsed.success) {
        log.warn(`Ignoring research row for ${spotifyId}: unexpected shape`);
        return null;
      }
      return parsed.data as CachedResearch;
    } catch (err) {
      log.error("Could not read a research row", { err });
      return null;
    }
  }

  putResearch(spotifyId: string, data: CachedResearch, ttlMs: number = TTL_RESEARCH): void {
    try {
      this.stmt.putResearch.run(
        spotifyId,
        data.samples?.length ?? 0,
        data.productionTrivia?.length ?? 0,
        JSON.stringify(data),
        nowSec() + Math.floor(ttlMs / 1000),
      );
    } catch (err) {
      log.error("Could not write a research row", { err });
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Artwork Cache
  // ---------------------------------------------------------------------------

  /**
   * A cached search, or null (missing or expired). Its track details are left out when the row
   * has none or they are not an object (a row of older code); the enricher then searches again
   * for a row that carries a Spotify id (agent/enricher.ts `servable`). A field of the details
   * that is not valid is dropped (validDetails).
   */
  getArtwork(searchKey: string): SpotifySearchResult | null {
    try {
      const row = this.stmt.getArtwork.get(searchKey);
      if (!row || nowSec() >= row.expires_at) return null;

      const details = trackDetails(row.track_details);
      return {
        coverUrl: row.cover_url,
        spotifyUrl: row.spotify_url,
        spotifyId: row.spotify_id,
        trackTitle: row.track_title,
        trackArtist: row.track_artist,
        ...(artistList(row.track_artists) ? { trackArtists: artistList(row.track_artists) } : {}),
        ...(details ? { trackDetails: details } : {}),
      };
    } catch (err) {
      log.error("Could not read an artwork row", { err });
      return null;
    }
  }

  /**
   * Caches a search. Only the fields named here are written (a preview URL never is); a field of
   * the track details that is not valid (an album name that holds a link, a malformed ISRC or
   * date) is written as null, the others as given (validDetails).
   */
  putArtwork(searchKey: string, result: SpotifySearchResult, ttlMs: number = TTL_ARTWORK): void {
    try {
      const details = result.trackDetails ? validDetails(result.trackDetails) : null;
      this.stmt.putArtwork.run(
        searchKey,
        result.coverUrl,
        result.spotifyUrl,
        result.spotifyId,
        result.trackTitle,
        result.trackArtist,
        result.trackArtists?.length ? JSON.stringify(result.trackArtists) : null,
        details ? JSON.stringify(details) : null,
        nowSec() + Math.floor(ttlMs / 1000),
      );
    } catch (err) {
      log.error("Could not write an artwork row", { err });
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
        log.info(`Purged expired: ${audio} audio, ${research} research, ${artwork} artwork`);
      }

      return { audio, research, artwork };
    } catch (err) {
      log.error("Could not purge expired rows", { err });
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
