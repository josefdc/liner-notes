/**
 * Deezer Preview Tool for LangGraph Agent
 *
 * Provides fallback audio preview URLs when Spotify previews are unavailable.
 * Uses the public Deezer API (no authentication required).
 *
 * API Docs: https://developers.deezer.com/api/search/track
 *
 * @see https://api.deezer.com/search/track?q=...
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";

// =============================================================================
// TypeScript Interfaces
// =============================================================================

interface DeezerArtist {
  id: number;
  name: string;
}

interface DeezerAlbum {
  id: number;
  title: string;
  cover_medium: string;
}

interface DeezerTrack {
  id: number;
  title: string;
  preview: string; // 30-second MP3 URL (dzcdn.net)
  artist: DeezerArtist;
  album: DeezerAlbum;
  duration: number;
}

interface DeezerSearchResponse {
  data: DeezerTrack[];
  total: number;
  error?: {
    type: string;
    message: string;
    code: number;
  };
}

export interface DeezerSearchResult {
  found: boolean;
  previewUrl: string | null;
  title?: string;
  artist?: string;
  album?: string;
  coverUrl?: string;
  duration?: number;
  deezerId?: number;
  message?: string;
  error?: string;
}

// =============================================================================
// Configuration
// =============================================================================

const DEEZER_API_BASE = "https://api.deezer.com";
const REQUEST_TIMEOUT = 10000; // 10 seconds

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Normalize a string for fuzzy matching
 */
function normalize(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^\w\s]/g, "") // Remove punctuation
    .replace(/\s+/g, " ") // Normalize whitespace
    .trim();
}

/**
 * Check if two strings are a fuzzy match
 */
function fuzzyMatch(a: string, b: string): boolean {
  const normA = normalize(a);
  const normB = normalize(b);
  return normA.includes(normB) || normB.includes(normA);
}

/**
 * Search Deezer for a track by title and artist
 * Returns the best matching track with preview URL
 */
async function searchDeezerTrack(title: string, artist: string): Promise<DeezerTrack | null> {
  // Build search query: "artist track" format works best for Deezer
  const query = encodeURIComponent(`${artist} ${title}`);
  const url = `${DEEZER_API_BASE}/search/track?q=${query}&limit=5`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    console.log(`🔍 [Deezer] Searching: ${url}`);

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        Accept: "application/json",
      },
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Deezer API error: HTTP ${response.status}`);
    }

    const data = (await response.json()) as DeezerSearchResponse;

    // Check for API error response
    if (data.error) {
      throw new Error(`Deezer API: ${data.error.message}`);
    }

    if (!data.data || data.data.length === 0) {
      console.log("⚠️ [Deezer] No results found");
      return null;
    }

    console.log(`📋 [Deezer] Found ${data.data.length} results`);

    // Find best match: prioritize tracks with previews and matching artist/title
    const normalizedArtist = artist.split(",")[0].trim(); // Take first artist if multiple
    const normalizedTitle = title;

    // First pass: exact-ish match with preview
    const exactMatch = data.data.find((track) => {
      const hasPreview = track.preview && track.preview.length > 0;
      const artistMatch = fuzzyMatch(track.artist.name, normalizedArtist);
      const titleMatch = fuzzyMatch(track.title, normalizedTitle);
      return hasPreview && artistMatch && titleMatch;
    });

    if (exactMatch) {
      console.log(`✅ [Deezer] Exact match: "${exactMatch.title}" by ${exactMatch.artist.name}`);
      return exactMatch;
    }

    // Second pass: any track with matching artist and preview
    const artistMatch = data.data.find((track) => {
      const hasPreview = track.preview && track.preview.length > 0;
      const artistMatch = fuzzyMatch(track.artist.name, normalizedArtist);
      return hasPreview && artistMatch;
    });

    if (artistMatch) {
      console.log(`✅ [Deezer] Artist match: "${artistMatch.title}" by ${artistMatch.artist.name}`);
      return artistMatch;
    }

    // Fallback: any track with a preview
    const withPreview = data.data.find((track) => track.preview && track.preview.length > 0);

    if (withPreview) {
      console.log(
        `⚠️ [Deezer] Fallback match: "${withPreview.title}" by ${withPreview.artist.name}`,
      );
      return withPreview;
    }

    console.log("⚠️ [Deezer] No tracks with previews found");
    return null;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error("Deezer API request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// =============================================================================
// LangGraph Tools
// =============================================================================

/**
 * Search Deezer for a track preview URL
 */
export const searchDeezerPreview = tool(
  async ({ title, artist }): Promise<string> => {
    console.log(`🎵 [Deezer] Searching for: "${title}" by ${artist}`);

    try {
      const track = await searchDeezerTrack(title, artist);

      if (!track) {
        console.log("❌ [Deezer] No track found");
        return JSON.stringify({
          found: false,
          previewUrl: null,
          message: `No Deezer track found for "${title}" by ${artist}`,
        } satisfies DeezerSearchResult);
      }

      if (!track.preview || track.preview.length === 0) {
        console.log("⚠️ [Deezer] Track found but no preview available");
        return JSON.stringify({
          found: true,
          previewUrl: null,
          title: track.title,
          artist: track.artist.name,
          message: "Track found but preview not available",
        } satisfies DeezerSearchResult);
      }

      console.log(`✅ [Deezer] Found preview: ${track.title} by ${track.artist.name}`);

      return JSON.stringify({
        found: true,
        previewUrl: track.preview,
        title: track.title,
        artist: track.artist.name,
        album: track.album.title,
        coverUrl: track.album.cover_medium,
        duration: track.duration,
        deezerId: track.id,
      } satisfies DeezerSearchResult);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Deezer] Error:", message);
      return JSON.stringify({
        found: false,
        previewUrl: null,
        error: message,
      } satisfies DeezerSearchResult);
    }
  },
  {
    name: "deezer_search_preview",
    description:
      "Search Deezer for a track's 30-second preview URL. " +
      "Use this as a fallback when Spotify preview is unavailable. " +
      "No authentication required. Returns preview URL from dzcdn.net.",
    schema: z.object({
      title: z.string().describe("The song title"),
      artist: z.string().describe("The artist name"),
    }),
  },
);

// =============================================================================
// Exports
// =============================================================================

export const deezerTools = [searchDeezerPreview];
