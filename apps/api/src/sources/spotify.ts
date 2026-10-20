/**
 * Spotify client and the LangGraph tools built on it.
 *
 * The typed functions (searchTracks, fetchTrack) resolve with data or reject with a
 * SourceError. The tools wrap them and return strings: JSON on success, and text starting
 * "Error:" when Spotify could not answer. A search with no match is `[]`, not an error. Ids are
 * checked before they reach a URL.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import dotenv from "dotenv";
import {
  credential,
  describeError,
  fetchJson,
  isSourceError,
  type Shape,
  SourceError,
} from "./http.js";

// Load environment variables
dotenv.config();

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
  popularity: number;
  duration_ms: number;
  explicit: boolean;
  external_urls: { spotify: string };
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
  artistIds: string[];
  album: string;
  releaseDate: string;
  coverUrl: string;
  popularity: number;
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
  popularity: true,
  duration_ms: true,
  explicit: true,
  external_urls: { spotify: true },
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

/** GET from the Web API; a 401 (token revoked or expired early) refreshes the token once. */
async function spotifyGet<T>(url: URL, scrub: Shape): Promise<T> {
  const auth = SpotifyAuthManager.getInstance();
  const request = (token: string) =>
    fetchJson<T>({ source: "spotify", url, headers: { Authorization: `Bearer ${token}` }, scrub });
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
    artistIds: track.artists.map((a) => a.id),
    album: track.album.name,
    releaseDate: track.album.release_date,
    coverUrl: track.album.images?.[0]?.url || "",
    popularity: track.popularity,
    duration: formatDuration(track.duration_ms),
    durationMs: track.duration_ms,
    explicit: track.explicit,
    spotifyUrl: track.external_urls.spotify,
    previewUrl: track.preview_url || null,
  };
}

/**
 * The text a tool returns when Spotify could not answer; it always starts "Error:". A rate
 * limit names "Rate limit" and 429, which the scout's retry looks for.
 */
function errorText(action: string, error: unknown): string {
  if (isSourceError(error, "rate_limited")) {
    const after = error.retryAfterMs;
    const wait = after === undefined ? "" : `; retry after ${Math.ceil(after / 1000)} s`;
    return `Error: Rate limited by Spotify (429) while ${action}${wait}`;
  }
  return `Error: ${action} failed: ${describeError(error)}`;
}

// =============================================================================
// Typed client
// =============================================================================

/** Up to `limit` (1-10) tracks for a query; [] when nothing matches. */
export async function searchTracks(query: string, limit = 5): Promise<SpotifyTrackSummary[]> {
  if (!query.trim()) throw new SourceError("spotify", "invalid_input", "empty search query");
  const url = new URL("https://api.spotify.com/v1/search");
  url.searchParams.set("q", query);
  url.searchParams.set("type", "track");
  url.searchParams.set("limit", String(Math.min(Math.max(Math.trunc(limit) || 1, 1), 10)));

  const data = await spotifyGet<SpotifySearchResponse>(url, SEARCH_SHAPE);
  const items = data?.tracks?.items;
  if (!Array.isArray(items)) {
    throw new SourceError("spotify", "parse", "search response has no tracks.items");
  }
  return items.filter((track) => track?.id).map(summarize);
}

/** One track by id; rejects (invalid_input) before any request when the id is malformed. */
export async function fetchTrack(trackId: string): Promise<SpotifyTrackSummary> {
  const id = requireSpotifyId(trackId, "track");
  const track = await spotifyGet<SpotifyTrack>(
    new URL(`https://api.spotify.com/v1/tracks/${id}`),
    TRACK_SHAPE,
  );
  if (!track?.id) throw new SourceError("spotify", "parse", "track response has no id");
  return summarize(track);
}

// =============================================================================
// LangGraph Tools
// =============================================================================

/**
 * Tool 1: Search for a track by name/artist
 *
 * Use this tool first to find a song's Spotify ID before getting audio features.
 */
export const searchTrack = tool(
  async ({ query }): Promise<string> => {
    try {
      const [track] = await searchTracks(query, 1);
      if (!track) {
        return `No track found for "${query}". Try a different spelling or include the artist name.`;
      }
      return JSON.stringify({
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album,
        releaseDate: track.releaseDate,
        coverUrl: track.coverUrl,
        popularity: track.popularity,
        duration: track.duration,
        explicit: track.explicit,
        spotifyUrl: track.spotifyUrl,
      });
    } catch (error) {
      console.error("❌ [Spotify] Search error:", describeError(error));
      return errorText("searching for track", error);
    }
  },
  {
    name: "spotify_search",
    description:
      "Search for a song by title and/or artist to get its Spotify ID and metadata. " +
      "Use this tool FIRST before getting audio features. " +
      "Returns: id, title, artist, album, popularity (0-100), duration, and Spotify URL.",
    schema: z.object({
      query: z
        .string()
        .describe(
          'The song title and optionally artist name, e.g. "Midnight City M83" or "Bohemian Rhapsody"',
        ),
    }),
  },
);

/**
 * Tool 2: Get detailed track information
 *
 * Requires a Spotify Track ID (from searchTrack).
 * Returns extended track metadata including artist IDs for further exploration.
 *
 * NOTE: Spotify deprecated audio-features endpoint for new apps (Nov 2024).
 * We use the /tracks endpoint which provides useful metadata.
 */
export const getTrackDetails = tool(
  async ({ trackId }): Promise<string> => {
    try {
      return JSON.stringify(await fetchTrack(trackId));
    } catch (error) {
      console.error("❌ [Spotify] Track details error:", describeError(error));
      return errorText("getting track details", error);
    }
  },
  {
    name: "get_track_details",
    description:
      "Get detailed information about a Spotify track. " +
      "Requires a Spotify Track ID (use spotify_search first). " +
      "Returns: title, artist, artistIds, album, release date, popularity, duration, and preview URL.",
    schema: z.object({
      trackId: z
        .string()
        .describe("The Spotify Track ID (22 character string like '6GyFP1nfCDB8lbD2bG0Hq9')"),
    }),
  },
);

/**
 * Tool 3: Get artist's top tracks
 *
 * Spotify removed `GET /artists/{id}/top-tracks` for development-mode apps (February 2026), so
 * this makes no request and reports the source as unavailable. The answer is JSON with an empty
 * `topTracks`, which the researcher reads as "nothing found".
 */
export const getArtistTopTracks = tool(
  async ({ artistId }): Promise<string> =>
    JSON.stringify({
      artistId,
      topTracks: [],
      found: false,
      unavailable: true,
      reason: "Spotify no longer offers artist top tracks to this app",
    }),
  {
    name: "get_artist_top_tracks",
    description:
      "Unavailable: Spotify no longer offers artist top tracks to this app, so this always " +
      "returns no tracks.",
    schema: z.object({
      artistId: z.string().describe("The Spotify Artist ID (22 character string)"),
      market: z.string().optional().describe("ISO 3166-1 alpha-2 country code (default: US)"),
    }),
  },
);

// Legacy alias for compatibility
export const getAudioFeatures = getTrackDetails;

/**
 * Tool 4: Search for multiple tracks (for disambiguation)
 *
 * Returns a JSON array of up to `limit` candidates; `[]` when nothing matches.
 */
export const searchMultipleTracks = tool(
  async ({ query, limit = 5 }): Promise<string> => {
    try {
      const tracks = await searchTracks(query, limit);
      // Search results carry no preview; the engineer looks one up separately.
      return JSON.stringify(tracks.map((track) => ({ ...track, previewUrl: null })));
    } catch (error) {
      console.error("❌ [Spotify] Multi-search error:", describeError(error));
      return errorText("searching for tracks", error);
    }
  },
  {
    name: "spotify_search_multiple",
    description:
      "Search for multiple tracks by query. " +
      "Returns up to 5 candidates for disambiguation when a search is ambiguous.",
    schema: z.object({
      query: z.string().describe("The song title and/or artist name"),
      limit: z.number().optional().describe("Max results to return (1-10, default 5)"),
    }),
  },
);

// =============================================================================
// Exports
// =============================================================================

export { SpotifyAuthManager, keyToNotation, formatDuration };
export type { SpotifyTrack, SpotifyAudioFeatures };
