/**
 * Spotify Tools for LangGraph Agent
 *
 * These tools provide the "Ears" for The Sonic Agent:
 * - searchTrack: Find songs by name/artist and get Spotify ID
 * - getAudioFeatures: Extract BPM, Key, Energy, and other audio characteristics
 *
 * Best Practices Implemented:
 * - Token caching with Singleton pattern (avoids rate limits)
 * - Strict TypeScript interfaces for API responses
 * - Comprehensive error handling
 * - Rich descriptions for LLM tool calling
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import dotenv from "dotenv";

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
  images: SpotifyImage[];
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

// =============================================================================
// Spotify Authentication Manager (Singleton Pattern)
// =============================================================================

/**
 * Singleton class to manage Spotify OAuth tokens.
 *
 * Why Singleton?
 * - Prevents requesting new tokens for every API call
 * - Caches token until 60 seconds before expiration
 * - Avoids Spotify rate limits (429 errors)
 */
class SpotifyAuthManager {
  private static instance: SpotifyAuthManager;
  private token: string | null = null;
  private tokenExpiresAt: number = 0;

  private constructor() {}

  static getInstance(): SpotifyAuthManager {
    if (!SpotifyAuthManager.instance) {
      SpotifyAuthManager.instance = new SpotifyAuthManager();
    }
    return SpotifyAuthManager.instance;
  }

  /**
   * Get a valid access token, refreshing if necessary.
   * Uses Client Credentials Flow (server-to-server, no user auth needed).
   */
  async getToken(): Promise<string> {
    const now = Date.now();

    // Return cached token if still valid (with 60s safety margin)
    if (this.token && now < this.tokenExpiresAt - 60000) {
      return this.token;
    }

    // Validate environment variables
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      throw new Error(
        "Missing Spotify credentials. Set SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in apps/api/.env",
      );
    }

    console.log("🔄 [Spotify] Refreshing access token...");

    const params = new URLSearchParams();
    params.append("grant_type", "client_credentials");

    const response = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      },
      body: params,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Spotify auth failed: ${response.status} - ${errorText}`);
    }

    const data = (await response.json()) as SpotifyToken;
    this.token = data.access_token;
    this.tokenExpiresAt = now + data.expires_in * 1000;

    console.log("✅ [Spotify] Token refreshed, expires in", data.expires_in, "seconds");

    return this.token;
  }

  /**
   * Clear cached token (useful for testing or forced refresh)
   */
  clearToken(): void {
    this.token = null;
    this.tokenExpiresAt = 0;
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
      const auth = SpotifyAuthManager.getInstance();
      const token = await auth.getToken();

      const searchUrl = new URL("https://api.spotify.com/v1/search");
      searchUrl.searchParams.set("q", query);
      searchUrl.searchParams.set("type", "track");
      searchUrl.searchParams.set("limit", "1");

      const response = await fetch(searchUrl.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        if (response.status === 429) {
          return "Rate limited by Spotify. Please wait a moment and try again.";
        }
        throw new Error(`Spotify API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as SpotifySearchResponse;
      const track = data.tracks.items[0];

      if (!track) {
        return `No track found for "${query}". Try a different spelling or include the artist name.`;
      }

      // Return rich metadata for the LLM
      return JSON.stringify({
        id: track.id,
        title: track.name,
        artist: track.artists.map((a) => a.name).join(", "),
        album: track.album.name,
        releaseDate: track.album.release_date,
        coverUrl: track.album.images[0]?.url || "",
        popularity: track.popularity, // 0-100 score
        duration: formatDuration(track.duration_ms),
        explicit: track.explicit,
        spotifyUrl: track.external_urls.spotify,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Spotify] Search error:", message);
      return `Error searching for track: ${message}`;
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
 * For BPM/Key analysis, consider integrating Essentia.js or similar in the future.
 */
export const getTrackDetails = tool(
  async ({ trackId }): Promise<string> => {
    try {
      const auth = SpotifyAuthManager.getInstance();
      const token = await auth.getToken();

      const response = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        if (response.status === 404) {
          return `Track not found for ID "${trackId}".`;
        }
        if (response.status === 429) {
          return "Rate limited by Spotify. Please wait a moment and try again.";
        }
        throw new Error(`Spotify API error: ${response.status} ${response.statusText}`);
      }

      const track = (await response.json()) as SpotifyTrack & { preview_url?: string };

      if (!track || !track.id) {
        return `No track data available for ID "${trackId}".`;
      }

      // Return extended track information
      return JSON.stringify({
        id: track.id,
        title: track.name,
        artist: track.artists.map((a) => a.name).join(", "),
        artistIds: track.artists.map((a) => a.id),
        album: track.album.name,
        releaseDate: track.album.release_date,
        coverUrl: track.album.images[0]?.url || "",
        popularity: track.popularity,
        duration: formatDuration(track.duration_ms),
        durationMs: track.duration_ms,
        explicit: track.explicit,
        spotifyUrl: track.external_urls.spotify,
        previewUrl: track.preview_url || null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Spotify] Track details error:", message);
      return `Error getting track details: ${message}`;
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
 * Useful for finding related songs by the same artist.
 */
export const getArtistTopTracks = tool(
  async ({ artistId, market = "US" }): Promise<string> => {
    try {
      const auth = SpotifyAuthManager.getInstance();
      const token = await auth.getToken();

      const response = await fetch(
        `https://api.spotify.com/v1/artists/${artistId}/top-tracks?market=${market}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!response.ok) {
        if (response.status === 404) {
          return `Artist not found for ID "${artistId}".`;
        }
        throw new Error(`Spotify API error: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as { tracks: SpotifyTrack[] };
      const tracks = data.tracks;

      if (!tracks || tracks.length === 0) {
        return `No top tracks found for artist ID "${artistId}".`;
      }

      // Return top 5 tracks
      const topTracks = tracks.slice(0, 5).map((t) => ({
        id: t.id,
        title: t.name,
        album: t.album.name,
        popularity: t.popularity,
      }));

      return JSON.stringify({ artistId, topTracks });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Spotify] Artist top tracks error:", message);
      return `Error getting artist top tracks: ${message}`;
    }
  },
  {
    name: "get_artist_top_tracks",
    description:
      "Get the top tracks for a Spotify artist. " +
      "Useful for discovering more songs by the same artist. " +
      "Requires an Artist ID (available from spotify_search or get_track_details).",
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
 * Returns up to 5 candidates for Human-in-the-loop selection.
 */
export const searchMultipleTracks = tool(
  async ({ query, limit = 5 }): Promise<string> => {
    try {
      const auth = SpotifyAuthManager.getInstance();
      const token = await auth.getToken();

      const searchUrl = new URL("https://api.spotify.com/v1/search");
      searchUrl.searchParams.set("q", query);
      searchUrl.searchParams.set("type", "track");
      searchUrl.searchParams.set("limit", Math.min(limit, 10).toString());

      const response = await fetch(searchUrl.toString(), {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (!response.ok) {
        if (response.status === 429) {
          return "Error: Rate limited by Spotify.";
        }
        throw new Error(`Spotify API error: ${response.status}`);
      }

      const data = (await response.json()) as SpotifySearchResponse;
      const tracks = data.tracks.items;

      if (!tracks || tracks.length === 0) {
        return `No tracks found for "${query}".`;
      }

      // Return array of candidates
      const candidates = tracks.map((track) => ({
        id: track.id,
        title: track.name,
        artist: track.artists.map((a) => a.name).join(", "),
        artistIds: track.artists.map((a) => a.id),
        album: track.album.name,
        releaseDate: track.album.release_date,
        coverUrl: track.album.images[0]?.url || "",
        popularity: track.popularity,
        duration: formatDuration(track.duration_ms),
        durationMs: track.duration_ms,
        explicit: track.explicit,
        spotifyUrl: track.external_urls.spotify,
        previewUrl: null,
      }));

      return JSON.stringify(candidates);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Spotify] Multi-search error:", message);
      return `Error searching for tracks: ${message}`;
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
