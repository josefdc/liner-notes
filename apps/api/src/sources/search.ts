/**
 * Web search (Tavily) for music research: sample history, production history and general
 * background.
 *
 * `webSearch` resolves with normalised results (title, URL, text) or rejects with a
 * SourceError. The tools return strings, which the researcher and historian filter by prefix:
 *   - results: one block per result, "title / URL / text", separated by blank lines;
 *   - nothing found: a sentence starting "No …";
 *   - search unavailable (no key, timeout, API error): text starting "Error:".
 * Lyric sites are excluded from every search, so no lyric text reaches research.
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import dotenv from "dotenv";
import { credential, describeError, fetchJson, type Shape, SourceError } from "./http.js";

dotenv.config();

// =============================================================================
// Configuration
// =============================================================================

const TAVILY_SEARCH_URL = "https://api.tavily.com/search";
const MAX_RESULTS = 5;
const MAX_RESULT_TEXT = 800;

/** Sites whose pages are song lyrics. Excluded in the request and filtered from the answer. */
export const LYRIC_SITES = [
  "genius.com",
  "azlyrics.com",
  "lyrics.com",
  "songlyrics.com",
  "musixmatch.com",
  "lyricsfreak.com",
  "metrolyrics.com",
  "songmeanings.com",
  "lyricstranslate.com",
  "lyricsmode.com",
  "lyricfind.com",
  "letras.com",
  "letras.mus.br",
  "lyrics.az",
  "elyrics.net",
  "lyrics.fandom.com",
] as const;

/** True for a URL on a lyric site, or a page that is evidently lyrics. */
export function isLyricPage(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  if (LYRIC_SITES.some((site) => host === site || host.endsWith(`.${site}`))) return true;
  if (host.includes("lyric") || host.startsWith("letras.")) return true;
  return /(?:^|[/-])lyrics?(?:[/.-]|$)/i.test(parsed.pathname);
}

const RESPONSE_SHAPE: Shape = { results: [{ title: true, url: true, content: true }] };

// =============================================================================
// Typed client
// =============================================================================

export interface WebResult {
  title: string;
  url: string;
  content: string;
}

interface TavilyResponse {
  results?: Array<{ title?: unknown; url?: unknown; content?: unknown }>;
}

let warnedNoKey = false;

/**
 * Searches the web. Rejects with SourceError "unavailable" when TAVILY_API_KEY is not set (no
 * request is made), and with the request's typed error when Tavily cannot answer.
 */
export async function webSearch(query: string): Promise<WebResult[]> {
  const apiKey = credential("TAVILY_API_KEY");
  if (!apiKey) {
    if (!warnedNoKey) {
      warnedNoKey = true;
      console.warn("⚠️ [Search] TAVILY_API_KEY is not set; web search is unavailable.");
    }
    throw new SourceError("tavily", "unavailable", "TAVILY_API_KEY is not set");
  }

  const data = await fetchJson<TavilyResponse>({
    source: "tavily",
    url: TAVILY_SEARCH_URL,
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      query,
      max_results: MAX_RESULTS,
      search_depth: "basic",
      include_answer: false,
      include_images: false,
      include_raw_content: false,
      exclude_domains: LYRIC_SITES,
    }),
    scrub: RESPONSE_SHAPE,
  });

  if (!data || !Array.isArray(data.results)) {
    throw new SourceError("tavily", "parse", "search response has no results list");
  }

  return data.results.flatMap((r) => {
    if (typeof r?.url !== "string" || typeof r.content !== "string") return [];
    if (isLyricPage(r.url)) return [];
    const content = r.content.replace(/\s+/g, " ").trim().slice(0, MAX_RESULT_TEXT);
    if (!content) return [];
    const title = typeof r.title === "string" && r.title.trim() ? r.title.trim() : r.url;
    return [{ title, url: r.url, content }];
  });
}

/** Results as one string: a "title / URL / text" block per result. */
export function formatResults(results: WebResult[]): string {
  return results.map((r) => `${r.title}\n${r.url}\n${r.content}`).join("\n\n");
}

/** Runs a search for a tool: results text, the `none` sentence, or text starting "Error:". */
async function searchText(label: string, query: string, none: string): Promise<string> {
  console.log(`🔍 [Search] ${label}: ${query}`);
  try {
    const results = await webSearch(query);
    return results.length > 0 ? formatResults(results) : none;
  } catch (error) {
    const message = describeError(error);
    console.error(`❌ [Search] ${label} unavailable:`, message);
    return `Error: web search unavailable: ${message}`;
  }
}

// =============================================================================
// Tools
// =============================================================================

/**
 * Search for sample history and interpolations
 */
export const searchSamples = tool(
  async ({ songTitle, artistName }): Promise<string> =>
    searchText(
      "Samples",
      `"${songTitle}" "${artistName}" sampled by OR samples from whosampled`,
      `No sample information found for "${songTitle}" by ${artistName}.`,
    ),
  {
    name: "search_samples",
    description:
      "Search for sample history. Returns: songs this track samples, songs that sampled it. " +
      "Sources: WhoSampled, sample databases. Use for genealogy graph data.",
    schema: z.object({
      songTitle: z.string().describe("The title of the song"),
      artistName: z.string().describe("The artist/band name"),
    }),
  },
);

/**
 * Search for production history and trivia
 */
export const searchProductionHistory = tool(
  async ({ songTitle, artistName }): Promise<string> =>
    searchText(
      "Production history",
      `"${songTitle}" "${artistName}" production history recording studio trivia making of`,
      `No production history found for "${songTitle}" by ${artistName}.`,
    ),
  {
    name: "search_production_history",
    description:
      "Search for studio/recording history. Returns: producer, instruments, recording location, techniques. " +
      "Use for production-type factoids.",
    schema: z.object({
      songTitle: z.string().describe("The title of the song"),
      artistName: z.string().describe("The artist/band name"),
    }),
  },
);

/**
 * General music research search
 */
export const searchMusicInfo = tool(
  async ({ query }): Promise<string> =>
    searchText("General music search", query, `No results found for "${query}".`),
  {
    name: "search_music_info",
    description:
      "General music web search. Returns: artist info, genre context, cultural impact. " +
      "Fallback when the specialized tools (samples, production) don't apply.",
    schema: z.object({
      query: z.string().describe("The search query"),
    }),
  },
);

// =============================================================================
// Exports
// =============================================================================

export const searchTools = [searchSamples, searchProductionHistory, searchMusicInfo];
