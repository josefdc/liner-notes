/**
 * Genius Lyrics Tool for LangGraph Agent
 *
 * Provides raw lyrics for LLM analysis:
 * - Quote specific lines in factoids
 * - Analyze lyrical themes and references
 * - Connect lyrics to song meaning
 *
 * Uses genius-lyrics-api library (handles Genius scraping)
 *
 * @requires GENIUS_ACCESS_TOKEN in environment
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

// =============================================================================
// TypeScript Interfaces
// =============================================================================

interface GeniusSearchResult {
  id: number;
  url: string;
  title: string;
  artist: string;
  albumArt?: string;
}

interface GeniusSongResponse {
  meta: { status: number };
  response: {
    hits: Array<{
      result: {
        id: number;
        url: string;
        title: string;
        primary_artist: { name: string };
        song_art_image_url?: string;
        release_date_for_display?: string;
      };
    }>;
  };
}

// =============================================================================
// Configuration
// =============================================================================

const GENIUS_API_BASE = "https://api.genius.com";
const MAX_LYRICS_LENGTH = 3000; // Truncate to save tokens

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Search for a song on Genius
 */
async function searchGeniusSong(
  title: string,
  artist: string,
  accessToken: string
): Promise<GeniusSearchResult | null> {
  const query = `${title} ${artist}`;
  const url = new URL(`${GENIUS_API_BASE}/search`);
  url.searchParams.set("q", query);

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Genius search failed: ${response.status}`);
  }

  const data = (await response.json()) as GeniusSongResponse;
  const hits = data.response?.hits || [];

  if (hits.length === 0) return null;

  // Find best match (prioritize exact title matches)
  const normalizedTitle = title.toLowerCase().trim();
  const normalizedArtist = artist.toLowerCase().trim();

  const bestMatch = hits.find((hit) => {
    const resultTitle = hit.result.title.toLowerCase();
    const resultArtist = hit.result.primary_artist.name.toLowerCase();
    return (
      resultTitle.includes(normalizedTitle) ||
      normalizedTitle.includes(resultTitle)
    ) && resultArtist.includes(normalizedArtist.split(",")[0]);
  }) || hits[0];

  return {
    id: bestMatch.result.id,
    url: bestMatch.result.url,
    title: bestMatch.result.title,
    artist: bestMatch.result.primary_artist.name,
    albumArt: bestMatch.result.song_art_image_url,
  };
}

/**
 * Scrape lyrics from Genius URL
 * Uses a simple HTML scraping approach since Genius doesn't provide lyrics via API
 */
async function scrapeLyrics(geniusUrl: string): Promise<string | null> {
  try {
    const response = await fetch(geniusUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; SonicAgent/1.0)",
        "Accept": "text/html",
      },
    });

    if (!response.ok) return null;

    const html = await response.text();

    // Genius stores lyrics in containers with data-lyrics-container attribute
    // We'll extract text between common markers
    const lyricsContainerRegex = /<div[^>]*data-lyrics-container="true"[^>]*>([\s\S]*?)<\/div>/gi;
    const matches = html.matchAll(lyricsContainerRegex);

    let lyrics = "";
    for (const match of matches) {
      // Clean HTML tags while preserving line breaks
      let chunk = match[1]
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<[^>]+>/g, "")
        .replace(/&#x27;/g, "'")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/\n{3,}/g, "\n\n")
        .trim();

      if (chunk) {
        lyrics += chunk + "\n\n";
      }
    }

    // Fallback: Try alternative selector patterns
    if (!lyrics) {
      const altRegex = /class="Lyrics__Container[^"]*"[^>]*>([\s\S]*?)<\/div>/gi;
      const altMatches = html.matchAll(altRegex);
      for (const match of altMatches) {
        let chunk = match[1]
          .replace(/<br\s*\/?>/gi, "\n")
          .replace(/<[^>]+>/g, "")
          .trim();
        if (chunk) lyrics += chunk + "\n\n";
      }
    }

    return lyrics.trim() || null;
  } catch (error) {
    console.error("❌ [Genius] Scraping error:", error);
    return null;
  }
}

// =============================================================================
// LangGraph Tools
// =============================================================================

/**
 * Fetch raw lyrics for a song
 */
export const fetchLyrics = tool(
  async ({ title, artist }): Promise<string> => {
    const accessToken = process.env.GENIUS_ACCESS_TOKEN;

    if (!accessToken) {
      return JSON.stringify({
        error: "GENIUS_ACCESS_TOKEN not set",
        lyrics: null,
      });
    }

    try {
      console.log(`🎤 [Genius] Searching for: "${title}" by ${artist}`);

      // Step 1: Search for song
      const song = await searchGeniusSong(title, artist, accessToken);

      if (!song) {
        return JSON.stringify({
          error: `No lyrics found for "${title}" by ${artist}`,
          lyrics: null,
        });
      }

      console.log(`🎤 [Genius] Found: ${song.title} - ${song.artist}`);

      // Step 2: Scrape lyrics from Genius URL
      const lyrics = await scrapeLyrics(song.url);

      if (!lyrics) {
        return JSON.stringify({
          error: "Could not extract lyrics from Genius page",
          song: song.title,
          artist: song.artist,
          geniusUrl: song.url,
          lyrics: null,
        });
      }

      // Truncate if too long
      const truncated = lyrics.length > MAX_LYRICS_LENGTH;
      const finalLyrics = truncated
        ? lyrics.substring(0, MAX_LYRICS_LENGTH) + "\n\n[... lyrics truncated ...]"
        : lyrics;

      console.log(
        `✅ [Genius] Retrieved ${finalLyrics.length} chars of lyrics${truncated ? " (truncated)" : ""}`
      );

      return JSON.stringify({
        title: song.title,
        artist: song.artist,
        geniusUrl: song.url,
        lyrics: finalLyrics,
        truncated,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Genius] Error:", message);
      return JSON.stringify({
        error: `Failed to fetch lyrics: ${message}`,
        lyrics: null,
      });
    }
  },
  {
    name: "fetch_lyrics",
    description:
      "Fetch raw lyrics from Genius. Returns: full lyrics text (max 3000 chars). " +
      "Use for quoting specific lines in factoids. HIGH PRIORITY for lyrics-type content.",
    schema: z.object({
      title: z.string().describe("The exact song title"),
      artist: z.string().describe("The artist name"),
    }),
  }
);

/**
 * Get song annotations and meaning from Genius
 */
export const getGeniusAnnotations = tool(
  async ({ title, artist }): Promise<string> => {
    const accessToken = process.env.GENIUS_ACCESS_TOKEN;

    if (!accessToken) {
      return JSON.stringify({ error: "GENIUS_ACCESS_TOKEN not set" });
    }

    try {
      console.log(`📝 [Genius] Getting annotations for: "${title}" by ${artist}`);

      // Search for song
      const song = await searchGeniusSong(title, artist, accessToken);

      if (!song) {
        return JSON.stringify({
          error: `Song not found: "${title}" by ${artist}`,
        });
      }

      // Get referents (annotations) for this song
      const url = new URL(`${GENIUS_API_BASE}/referents`);
      url.searchParams.set("song_id", song.id.toString());
      url.searchParams.set("per_page", "10");
      url.searchParams.set("text_format", "plain");

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Genius API error: ${response.status}`);
      }

      const data = await response.json() as {
        response?: { referents?: Array<{ fragment: string; annotations?: Array<{ body?: { plain?: string } }> }> }
      };
      const referents = data.response?.referents || [];

      // Extract annotation summaries
      const annotations = referents.slice(0, 5).map((ref: any) => ({
        fragment: ref.fragment,
        annotation:
          ref.annotations?.[0]?.body?.plain?.substring(0, 500) || "No annotation text",
      }));

      console.log(`✅ [Genius] Found ${annotations.length} annotations`);

      return JSON.stringify({
        title: song.title,
        artist: song.artist,
        geniusUrl: song.url,
        annotationCount: referents.length,
        topAnnotations: annotations,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Genius] Annotations error:", message);
      return JSON.stringify({ error: message });
    }
  },
  {
    name: "get_genius_annotations",
    description:
      "Get Genius crowd-sourced annotations. Returns: lyric fragments with explanations. " +
      "Use for song meaning context and cultural references.",
    schema: z.object({
      title: z.string().describe("The exact song title"),
      artist: z.string().describe("The artist name"),
    }),
  }
);

// =============================================================================
// Exports
// =============================================================================

export const geniusTools = [fetchLyrics, getGeniusAnnotations];
