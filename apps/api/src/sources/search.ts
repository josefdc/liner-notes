/**
 * Web Search Tool for LangGraph Agent
 *
 * The "Archivist" - provides external knowledge:
 * - Sample history ("Who sampled this song?")
 * - Production trivia
 * - Artist background
 * - Music theory context
 *
 * Uses Tavily Search API (optimized for AI agents)
 */

import { TavilySearch } from "@langchain/tavily";
import { tool } from "@langchain/core/tools";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

// =============================================================================
// Tavily Search Tool (Pre-built from LangChain)
// =============================================================================

/**
 * Create Tavily search instance
 * Requires TAVILY_API_KEY in environment
 */
function createTavilySearch() {
  const apiKey = process.env.TAVILY_API_KEY;

  if (!apiKey) {
    console.warn("⚠️ [Search] TAVILY_API_KEY not set. Web search will be disabled.");
    return null;
  }

  return new TavilySearch({
    maxResults: 5,
  });
}

export const tavilySearch = createTavilySearch();

// =============================================================================
// Custom Search Tools for Music Research
// =============================================================================

/**
 * Search for sample history and interpolations
 */
export const searchSamples = tool(
  async ({ songTitle, artistName }): Promise<string> => {
    if (!tavilySearch) {
      return "Web search is not available. Please set TAVILY_API_KEY.";
    }

    try {
      const query = `"${songTitle}" "${artistName}" sampled by OR samples from whosampled`;
      console.log(`🔍 [Search] Searching samples: ${query}`);

      const results = await tavilySearch.invoke({ query });

      if (!results || results === "[]") {
        return `No sample information found for "${songTitle}" by ${artistName}.`;
      }

      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Search] Sample search error:", message);
      return `Error searching for samples: ${message}`;
    }
  },
  {
    name: "search_samples",
    description:
      "Search for sample history. Returns: songs this track samples, songs that sampled it. " +
      "Sources: WhoSampled, sample databases. Use for genealogy graph data.",
    schema: z.object({
      songTitle: z.string().describe("The title of the song"),
      artistName: z.string().describe("The artist/band name"),
    }),
  }
);

/**
 * Search for production history and trivia
 */
export const searchProductionHistory = tool(
  async ({ songTitle, artistName }): Promise<string> => {
    if (!tavilySearch) {
      return "Web search is not available. Please set TAVILY_API_KEY.";
    }

    try {
      const query = `"${songTitle}" "${artistName}" production history recording studio trivia making of`;
      console.log(`🔍 [Search] Searching production history: ${query}`);

      const results = await tavilySearch.invoke({ query });

      if (!results || results === "[]") {
        return `No production history found for "${songTitle}" by ${artistName}.`;
      }

      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Search] Production history error:", message);
      return `Error searching for production history: ${message}`;
    }
  },
  {
    name: "search_production_history",
    description:
      "Search for studio/recording history. Returns: producer, instruments, recording location, techniques. " +
      "Use for production-type factoids.",
    schema: z.object({
      songTitle: z.string().describe("The title of the song"),
      artistName: z.string().describe("The artist/band name"),
    }),
  }
);

/**
 * Search for song meaning and lyrics analysis
 */
export const searchSongMeaning = tool(
  async ({ songTitle, artistName }): Promise<string> => {
    if (!tavilySearch) {
      return "Web search is not available. Please set TAVILY_API_KEY.";
    }

    try {
      const query = `"${songTitle}" "${artistName}" song meaning lyrics analysis genius songmeanings`;
      console.log(`🔍 [Search] Searching song meaning: ${query}`);

      const results = await tavilySearch.invoke({ query });

      if (!results || results === "[]") {
        return `No song meaning analysis found for "${songTitle}" by ${artistName}.`;
      }

      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Search] Song meaning error:", message);
      return `Error searching for song meaning: ${message}`;
    }
  },
  {
    name: "search_song_meaning",
    description:
      "Search for lyric interpretations. Returns: thematic analysis, artist quotes. " +
      "Use for lyrics-type factoids. Prefer fetch_lyrics for raw lyrics.",
    schema: z.object({
      songTitle: z.string().describe("The title of the song"),
      artistName: z.string().describe("The artist/band name"),
    }),
  }
);

/**
 * General music research search
 */
export const searchMusicInfo = tool(
  async ({ query }): Promise<string> => {
    if (!tavilySearch) {
      return "Web search is not available. Please set TAVILY_API_KEY.";
    }

    try {
      console.log(`🔍 [Search] General music search: ${query}`);

      const results = await tavilySearch.invoke({ query });

      if (!results || results === "[]") {
        return `No results found for "${query}".`;
      }

      return results;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Search] General search error:", message);
      return `Error searching: ${message}`;
    }
  },
  {
    name: "search_music_info",
    description:
      "General music web search. Returns: artist info, genre context, cultural impact. " +
      "Fallback when specialized tools (samples, production, lyrics) don't apply.",
    schema: z.object({
      query: z.string().describe("The search query"),
    }),
  }
);

// =============================================================================
// Exports
// =============================================================================

export const searchTools = [
  searchSamples,
  searchProductionHistory,
  searchSongMeaning,
  searchMusicInfo,
];
