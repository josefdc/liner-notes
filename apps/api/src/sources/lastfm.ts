/**
 * Last.fm Tools for LangGraph Agent
 *
 * Provides genre tags, similar tracks/artists, and artist info:
 * - Track and artist genre tags (for radar chart / genre profile)
 * - Similar tracks (for Discovered Gems / genealogy)
 * - Similar artists (for genealogy edges)
 * - Artist bio and metadata (for factoids)
 *
 * Uses Last.fm API v2. Requires LASTFM_API_KEY in environment.
 * Gracefully degrades if API key is not configured.
 *
 * @see https://www.last.fm/api
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

// =============================================================================
// Configuration
// =============================================================================

const LASTFM_API_BASE = "https://ws.audioscrobbler.com/2.0/";
const REQUEST_TIMEOUT = 10000; // 10 seconds

// Tags that are not useful genre indicators — filter these out
const TAG_BLOCKLIST = new Set([
  "seen live",
  "favorites",
  "favourite",
  "favorite",
  "female vocalists",
  "male vocalists",
  "singer-songwriter",
  "beautiful",
  "awesome",
  "love",
  "loved",
  "sexy",
  "cool",
  "catchy",
  "chill",
  "good",
  "great",
  "best",
  "my favorite",
  "my favourite",
  "all time favorite",
  "all time favourite",
  "makes me happy",
  "guilty pleasure",
  "under 2000 listeners",
  "spotify",
  "check out",
  "to check out",
  "2000s",
  "2010s",
  "2020s",
  "1990s",
  "1980s",
  "1970s",
  "1960s",
  "00s",
  "90s",
  "80s",
  "70s",
  "60s",
]);

// =============================================================================
// TypeScript Interfaces
// =============================================================================

interface LastfmTag {
  name: string;
  count?: number;
  url?: string;
}

interface LastfmSimilarTrack {
  name: string;
  playcount?: number;
  match?: number;
  artist: { name: string; mbid?: string };
}

interface LastfmSimilarArtist {
  name: string;
  match?: string;
  mbid?: string;
}

interface LastfmArtistInfo {
  name: string;
  mbid?: string;
  url?: string;
  stats?: { listeners: string; playcount: string };
  bio?: { summary: string; content: string };
  tags?: { tag: LastfmTag[] };
  similar?: { artist: LastfmSimilarArtist[] };
}

// =============================================================================
// Shared Helper
// =============================================================================

/**
 * Make a request to the Last.fm API with timeout and error handling
 */
async function callLastfm(params: Record<string, string>): Promise<unknown> {
  const apiKey = process.env.LASTFM_API_KEY;
  if (!apiKey) {
    return { error: "LASTFM_API_KEY not configured" };
  }

  const url = new URL(LASTFM_API_BASE);
  url.searchParams.set("api_key", apiKey);
  url.searchParams.set("format", "json");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const response = await fetch(url.toString(), {
      headers: { "User-Agent": "SonicAgent/1.0" },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`Last.fm API error: HTTP ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Filter noise tags using the blocklist
 */
function cleanTags(tags: LastfmTag[]): Array<{ name: string; count: number }> {
  return tags
    .filter((t) => !TAG_BLOCKLIST.has(t.name.toLowerCase()))
    .map((t) => ({ name: t.name, count: Number(t.count) || 0 }))
    .slice(0, 10);
}

/**
 * Strip HTML tags from Last.fm bio text and truncate
 */
function cleanBio(bio: string, maxLength = 300): string {
  const cleaned = bio
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= maxLength) return cleaned;
  return cleaned.substring(0, maxLength).replace(/\s+\S*$/, "") + "...";
}

// =============================================================================
// LangGraph Tools
// =============================================================================

/**
 * Get top tags for a track from Last.fm
 */
export const getLastfmTrackTags = tool(
  async ({ title, artist }): Promise<string> => {
    try {
      console.log(`🏷️ [Last.fm] Getting track tags: "${title}" by ${artist}`);

      const data = (await callLastfm({
        method: "track.getTopTags",
        track: title,
        artist: artist,
      })) as { toptags?: { tag?: LastfmTag[] }; error?: number; message?: string };

      if (data.error) {
        return JSON.stringify({
          found: false,
          error: data.message || `Last.fm error ${data.error}`,
        });
      }

      const rawTags = data.toptags?.tag || [];
      const tags = cleanTags(rawTags);

      console.log(`✅ [Last.fm] Found ${tags.length} track tags`);
      return JSON.stringify({ found: tags.length > 0, tags });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Last.fm] Track tags error:", message);
      return JSON.stringify({ found: false, error: message });
    }
  },
  {
    name: "lastfm_track_tags",
    description:
      "Get genre/style tags for a track from Last.fm community. " +
      "Returns cleaned tags with popularity counts. Use for genre profile radar chart.",
    schema: z.object({
      title: z.string().describe("The exact song title"),
      artist: z.string().describe("The artist name"),
    }),
  },
);

/**
 * Get top tags for an artist from Last.fm
 */
export const getLastfmArtistTags = tool(
  async ({ artist }): Promise<string> => {
    try {
      console.log(`🏷️ [Last.fm] Getting artist tags: "${artist}"`);

      const data = (await callLastfm({
        method: "artist.getTopTags",
        artist: artist,
      })) as { toptags?: { tag?: LastfmTag[] }; error?: number; message?: string };

      if (data.error) {
        return JSON.stringify({
          found: false,
          error: data.message || `Last.fm error ${data.error}`,
        });
      }

      const rawTags = data.toptags?.tag || [];
      const tags = cleanTags(rawTags);

      console.log(`✅ [Last.fm] Found ${tags.length} artist tags`);
      return JSON.stringify({ found: tags.length > 0, tags });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Last.fm] Artist tags error:", message);
      return JSON.stringify({ found: false, error: message });
    }
  },
  {
    name: "lastfm_artist_tags",
    description:
      "Get genre/style tags for an artist from Last.fm community. " +
      "Supplementary genre data when track tags are sparse.",
    schema: z.object({
      artist: z.string().describe("The artist name"),
    }),
  },
);

/**
 * Get similar tracks from Last.fm
 */
export const getLastfmSimilarTracks = tool(
  async ({ title, artist }): Promise<string> => {
    try {
      console.log(`🔗 [Last.fm] Getting similar tracks: "${title}" by ${artist}`);

      const data = (await callLastfm({
        method: "track.getSimilar",
        track: title,
        artist: artist,
        limit: "5",
      })) as { similartracks?: { track?: LastfmSimilarTrack[] }; error?: number; message?: string };

      if (data.error) {
        return JSON.stringify({
          found: false,
          error: data.message || `Last.fm error ${data.error}`,
        });
      }

      const rawTracks = data.similartracks?.track || [];
      const tracks = rawTracks.slice(0, 5).map((t) => ({
        name: t.name,
        artist: t.artist.name,
        match: typeof t.match === "number" ? t.match : Number(t.match) || 0,
      }));

      console.log(`✅ [Last.fm] Found ${tracks.length} similar tracks`);
      return JSON.stringify({ found: tracks.length > 0, tracks });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Last.fm] Similar tracks error:", message);
      return JSON.stringify({ found: false, error: message });
    }
  },
  {
    name: "lastfm_similar_tracks",
    description:
      "Get similar tracks from Last.fm. Returns up to 5 tracks with match scores. " +
      "Use for Discovered Gems and genealogy group 4 (siblings).",
    schema: z.object({
      title: z.string().describe("The exact song title"),
      artist: z.string().describe("The artist name"),
    }),
  },
);

/**
 * Get similar artists from Last.fm
 */
export const getLastfmSimilarArtists = tool(
  async ({ artist }): Promise<string> => {
    try {
      console.log(`🔗 [Last.fm] Getting similar artists: "${artist}"`);

      const data = (await callLastfm({
        method: "artist.getSimilar",
        artist: artist,
        limit: "5",
      })) as {
        similarartists?: { artist?: LastfmSimilarArtist[] };
        error?: number;
        message?: string;
      };

      if (data.error) {
        return JSON.stringify({
          found: false,
          error: data.message || `Last.fm error ${data.error}`,
        });
      }

      const rawArtists = data.similarartists?.artist || [];
      const artists = rawArtists.slice(0, 5).map((a) => ({
        name: a.name,
        match: typeof a.match === "string" ? parseFloat(a.match) : Number(a.match) || 0,
        mbid: a.mbid || undefined,
      }));

      console.log(`✅ [Last.fm] Found ${artists.length} similar artists`);
      return JSON.stringify({ found: artists.length > 0, artists });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Last.fm] Similar artists error:", message);
      return JSON.stringify({ found: false, error: message });
    }
  },
  {
    name: "lastfm_similar_artists",
    description:
      "Get similar artists from Last.fm. Returns up to 5 artists with match scores and MBIDs. " +
      "Use for genealogy edges and relatedArtists.",
    schema: z.object({
      artist: z.string().describe("The artist name"),
    }),
  },
);

/**
 * Get artist info from Last.fm (bio, stats, tags, similar)
 */
export const getLastfmArtistInfo = tool(
  async ({ artist }): Promise<string> => {
    try {
      console.log(`📋 [Last.fm] Getting artist info: "${artist}"`);

      const data = (await callLastfm({
        method: "artist.getInfo",
        artist: artist,
      })) as { artist?: LastfmArtistInfo; error?: number; message?: string };

      if (data.error) {
        return JSON.stringify({
          found: false,
          error: data.message || `Last.fm error ${data.error}`,
        });
      }

      const info = data.artist;
      if (!info) {
        return JSON.stringify({ found: false, error: "Artist not found" });
      }

      const tags = cleanTags(info.tags?.tag || []);
      const similarArtists = (info.similar?.artist || []).slice(0, 5).map((a) => ({
        name: a.name,
        mbid: a.mbid || undefined,
      }));
      const bio = info.bio?.summary ? cleanBio(info.bio.summary) : undefined;

      console.log(`✅ [Last.fm] Got artist info: ${info.name}`);
      return JSON.stringify({
        found: true,
        name: info.name,
        bio,
        listeners: info.stats?.listeners ? parseInt(info.stats.listeners, 10) : undefined,
        playcount: info.stats?.playcount ? parseInt(info.stats.playcount, 10) : undefined,
        tags,
        similarArtists,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Last.fm] Artist info error:", message);
      return JSON.stringify({ found: false, error: message });
    }
  },
  {
    name: "lastfm_artist_info",
    description:
      "Get artist biography, listener stats, tags, and similar artists from Last.fm. " +
      "Use for factoid content and supplementary data.",
    schema: z.object({
      artist: z.string().describe("The artist name"),
    }),
  },
);

// =============================================================================
// Exports
// =============================================================================

export const lastfmTools = [
  getLastfmTrackTags,
  getLastfmArtistTags,
  getLastfmSimilarTracks,
  getLastfmSimilarArtists,
  getLastfmArtistInfo,
];
