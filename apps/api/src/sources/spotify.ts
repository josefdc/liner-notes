/**
 * Spotify client. The typed functions (searchTracks, fetchTrack) resolve with data or reject with
 * a SourceError (sources/http.ts). A search with no match is `[]`, not an error. Ids are checked
 * before they reach a URL.
 */

import { credential, fetchJson, isSourceError, type Shape, SourceError } from "./http.js";
import { normalizeIsrc } from "./musicbrainz.js";

// =============================================================================
// TypeScript Interfaces for Spotify API Responses
// =============================================================================

interface SpotifyToken {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface SpotifyArtist {
  name: string;
  id: string;
}

interface SpotifyImage {
  url: string;
  height: number;
  width: number;
}

interface SpotifyAlbum {
  name: string;
  images?: SpotifyImage[];
  release_date: string;
}

interface SpotifyTrack {
  id: string;
  name: string;
  artists: SpotifyArtist[];
  album: SpotifyAlbum;
  duration_ms: number;
  explicit: boolean;
  external_urls: { spotify: string };
  external_ids?: { isrc?: string | null };
  preview_url?: string | null;
}

interface SpotifySearchResponse {
  tracks: {
    items: SpotifyTrack[];
    total: number;
  };
}

interface SpotifyAudioFeatures {
  danceability: number; // 0.0 - 1.0: How suitable for dancing
  energy: number; // 0.0 - 1.0: Perceptual intensity
  key: number; // 0-11: Pitch class (C=0, C#=1, D=2...)
  loudness: number; // -60 to 0 dB: Overall loudness
  mode: number; // 0=Minor, 1=Major
  speechiness: number; // 0.0 - 1.0: Presence of spoken words
  acousticness: number; // 0.0 - 1.0: Confidence track is acoustic
  instrumentalness: number; // 0.0 - 1.0: Predicts no vocals (>0.5)
  liveness: number; // 0.0 - 1.0: Presence of audience
  valence: number; // 0.0 - 1.0: Musical positiveness/happiness
  tempo: number; // BPM
  id: string;
  time_signature: number; // Beats per bar (3-7)
  duration_ms: number;
}

/** A track as the pipeline uses it (SpotifyData in agent/state.ts). */
export interface SpotifyTrackSummary {
  id: string;
  title: string;
  artist: string;
  /** The credited artists one by one (`artist` joins them with ", "). */
  artistNames: string[];
  artistIds: string[];
  album: string;
  releaseDate: string;
  coverUrl: string;
  /** The recording's ISRC, or null when Spotify gave no valid one. */
  isrc: string | null;
  duration: string;
  durationMs: number;
  explicit: boolean;
  spotifyUrl: string;
  previewUrl: string | null;
}

// Fields the pipeline reads, kept when a response is recorded to a cassette.
const TRACK_SHAPE: Shape = {
  id: true,
  name: true,
  artists: [{ id: true, name: true }],
  album: { name: true, release_date: true },
  duration_ms: true,
  explicit: true,
  external_urls: { spotify: true },
  external_ids: { isrc: true },
};
const SEARCH_SHAPE: Shape = { tracks: { items: [TRACK_SHAPE], total: true } };
const TOKEN_SHAPE: Shape = { access_token: true, token_type: true, expires_in: true };

// =============================================================================
// Input checks
// =============================================================================

/** Spotify ids are 22 base-62 characters; anything else never reaches a URL. */
const SPOTIFY_ID = /^[0-9A-Za-z]{22}$/;

export function isSpotifyId(value: unknown): value is string {
  return typeof value === "string" && SPOTIFY_ID.test(value);
}

function requireSpotifyId(value: string, what: string): string {
  if (!isSpotifyId(value)) {
    throw new SourceError("spotify", "invalid_input", `not a Spotify ${what} id`);
  }
  return value;
}

// =============================================================================
// Spotify Authentication Manager (Singleton Pattern)
// =============================================================================

/**
 * Caches the client-credentials token until 60 s before it expires. Concurrent callers share
 * one refresh instead of each requesting a token.
 */
class SpotifyAuthManager {
  private static instance: SpotifyAuthManager;
  private token: string | null = null;
  private tokenExpiresAt: number = 0;
  private pending: Promise<string> | null = null;

  private constructor() {}

  static getInstance(): SpotifyAuthManager {
    if (!SpotifyAuthManager.instance) {
      SpotifyAuthManager.instance = new SpotifyAuthManager();
    }
    return SpotifyAuthManager.instance;
  }

  /** A valid access token, refreshed when needed (Client Credentials Flow). */
  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) {
      return this.token;
    }
    if (!this.pending) {
      this.pending = this.refresh().finally(() => {
        this.pending = null;
      });
    }
    return this.pending;
  }

  private async refresh(): Promise<string> {
    const clientId = credential("SPOTIFY_CLIENT_ID");
    const clientSecret = credential("SPOTIFY_CLIENT_SECRET");

    if (!clientId || !clientSecret) {
      throw new SourceError(
        "spotify",
        "unavailable",
        "missing credentials; set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in apps/api/.env",
      );
    }

    console.log("🔄 [Spotify] Refreshing access token...");
    const startedAt = Date.now();

    const data = await fetchJson<SpotifyToken>({
      source: "spotify",
      url: "https://accounts.spotify.com/api/token",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`,
      },
      body: new URLSearchParams({ grant_type: "client_credentials" }).toString(),
      scrub: TOKEN_SHAPE,
    });

    if (typeof data?.access_token !== "string" || typeof data.expires_in !== "number") {
      throw new SourceError("spotify", "parse", "token response has no access_token");
    }
    this.token = data.access_token;
    this.tokenExpiresAt = startedAt + data.expires_in * 1000;

    console.log("✅ [Spotify] Token refreshed, expires in", data.expires_in, "seconds");
    return this.token;
  }

  /** Clears the cached token (forced refresh, tests). */
  clearToken(): void {
    this.token = null;
    this.tokenExpiresAt = 0;
  }

  /**
   * Drops `rejected` after Spotify refused it. A token refreshed meanwhile (by another request
   * that saw the same 401) is kept.
   */
  invalidate(rejected: string): void {
    if (this.token === rejected) this.clearToken();
  }
}

/**
 * GET from the Web API; a 401 (token revoked or expired early) refreshes the token once.
 * `signal` stops the request (the shared token request is not stopped: other callers wait on it).
 */
async function spotifyGet<T>(url: URL, scrub: Shape, signal?: AbortSignal): Promise<T> {
  const auth = SpotifyAuthManager.getInstance();
  const request = (token: string) => {
    signal?.throwIfAborted();
    return fetchJson<T>({
      source: "spotify",
      url,
      headers: { Authorization: `Bearer ${token}` },
      scrub,
      signal,
    });
  };
  const token = await auth.getToken();
  try {
    return await request(token);
  } catch (error) {
    if (!isSourceError(error, "http") || error.status !== 401) throw error;
    auth.invalidate(token);
    return request(await auth.getToken());
  }
}

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Convert Spotify's numeric key (0-11) to musical notation
 */
const KEY_MAP = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

function keyToNotation(key: number, mode: number): string {
  if (key < 0 || key > 11) return "Unknown";
  const note = KEY_MAP[key];
  const modeName = mode === 1 ? "Major" : "Minor";
  return `${note} ${modeName}`;
}

/**
 * Format milliseconds to mm:ss
 */
function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function summarize(track: SpotifyTrack): SpotifyTrackSummary {
  return {
    id: track.id,
    title: track.name,
    artist: track.artists.map((a) => a.name).join(", "),
    artistNames: track.artists.map((a) => a.name),
    artistIds: track.artists.map((a) => a.id),
    album: track.album.name,
    releaseDate: track.album.release_date,
    coverUrl: track.album.images?.[0]?.url || "",
    isrc: normalizeIsrc(track.external_ids?.isrc),
    duration: formatDuration(track.duration_ms),
    durationMs: track.duration_ms,
    explicit: track.explicit,
    spotifyUrl: track.external_urls.spotify,
    previewUrl: track.preview_url || null,
  };
}

// =============================================================================
// Typed client
// =============================================================================

/** Up to `limit` (1-10) tracks for a query; [] when nothing matches. */
export async function searchTracks(
  query: string,
  limit = 5,
  signal?: AbortSignal,
): Promise<SpotifyTrackSummary[]> {
  if (!query.trim()) throw new SourceError("spotify", "invalid_input", "empty search query");
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", query);
  url.searchParams.set("type", "track");
  url.searchParams.set("limit", String(Math.min(Math.max(Math.trunc(limit) || 1, 1), 10)));

  const data = await spotifyGet<SpotifySearchResponse>(url, SEARCH_SHAPE, signal);
  const items = data?.tracks?.items;
  if (!Array.isArray(items)) {
    throw new SourceError("spotify", "parse", "search response has no tracks.items");
  }
  return items.filter((track) => track?.id).map(summarize);
}

/** One track by id; rejects (invalid_input) before any request when the id is malformed. */
export async function fetchTrack(
  trackId: string,
  signal?: AbortSignal,
): Promise<SpotifyTrackSummary> {
  const id = requireSpotifyId(trackId, "track");
  const track = await spotifyGet<SpotifyTrack>(
    new URL(`https://api.spotify.com/v1/tracks/${id}`),
    TRACK_SHAPE,
    signal,
  );
  if (!track?.id) throw new SourceError("spotify", "parse", "track response has no id");
  return summarize(track);
}

// =============================================================================
// Exports
// =============================================================================

export { SpotifyAuthManager, keyToNotation, formatDuration };
export type { SpotifyTrack, SpotifyAudioFeatures };
