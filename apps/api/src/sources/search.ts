/**
 * Web search (Tavily) for music research: sample history, production history and general
 * background.
 *
 * `webSearch` resolves with normalised results (title, URL, text) or rejects with a
 * SourceError. The tools return strings:
 *   - results: one block per result, "title / URL / text", separated by blank lines;
 *   - nothing found, or search unavailable (no key, timeout, API error): text starting
 *     "Error:". The historian keeps any search text that does not start with "Error", so
 *     "nothing found" uses that prefix too; neither ever becomes research.
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
  "musica.com",
  "lyrics.az",
  "elyrics.net",
  "lyrics.fandom.com",
  "songtexte.com",
  "songtexte.bz",
  "tekstowo.pl",
  "paroles-musique.com",
  "paroles.net",
] as const;

/** A host as Google's translate proxy writes it: "genius.com" → "genius-com.translate.goog". */
function translateProxyHost(host: string): string {
  return `${host.replace(/-/g, "--").replace(/\./g, "-")}.translate.goog`;
}

/** The host a translate.goog proxy host stands for: "genius-com.translate.goog" → "genius.com". */
function unproxyHost(host: string): string {
  const label = host.slice(0, -".translate.goog".length);
  return label.replace(/--/g, "\0").replace(/-/g, ".").replace(/\0/g, "-");
}

/** Domains sent as `exclude_domains`: the lyric sites and their translate-proxy hosts. */
export const EXCLUDED_DOMAINS = [...LYRIC_SITES, ...LYRIC_SITES.map(translateProxyHost)];

function isLyricHost(host: string): boolean {
  if (LYRIC_SITES.some((site) => host === site || host.endsWith(`.${site}`))) return true;
  return /lyric|songtext|paroles|tekstowo/.test(host) || host.startsWith("letras.");
}

// Path words that mark a lyrics page. "lyric" alone is not one: "lyric-video" pages are news.
const LYRIC_PATH = /(?:^|[/_.,-])(?:lyrics|songtexte?|paroles|letras?|teksty?)(?=[/_.,?#-]|$)/i;

/**
 * True for a URL on a lyric site (also through a translate proxy, and with or without a
 * scheme), or a page whose path says it is lyrics.
 */
export function isLyricPage(url: string): boolean {
  const text = url.trim();
  let parsed: URL;
  try {
    const withScheme = text.startsWith("//")
      ? `https:${text}`
      : /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
        ? text
        : `https://${text}`;
    parsed = new URL(withScheme);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (isLyricHost(host)) return true;
  if (host.endsWith(".translate.goog") && isLyricHost(unproxyHost(host))) return true;
  if (/^translate\.google\./.test(host)) {
    const inner = parsed.searchParams.get("u") ?? parsed.searchParams.get("url");
    if (inner && isLyricPage(inner)) return true;
  }
  return LYRIC_PATH.test(parsed.pathname);
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
export async function webSearch(query: string, signal?: AbortSignal): Promise<WebResult[]> {
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
      exclude_domains: EXCLUDED_DOMAINS,
    }),
    scrub: RESPONSE_SHAPE,
    signal,
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

/**
 * Runs a search for a tool: results text, or text starting "Error:" (nothing found,
 * unavailable). A cancelled run (its `signal` aborted) rejects instead: nothing is reported.
 */
async function searchText(
  label: string,
  query: string,
  none: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  signal?.throwIfAborted();
  console.log(`🔍 [Search] ${label}: ${query}`);
  try {
    const results = await webSearch(query, signal);
    return results.length > 0 ? formatResults(results) : `Error: no web results: ${none}`;
  } catch (error) {
    if (signal?.aborted) throw error;
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
  async ({ songTitle, artistName }, config): Promise<string> =>
    searchText(
      "Samples",
      `"${songTitle}" "${artistName}" sampled by OR samples from whosampled`,
      `no sample information found for "${songTitle}" by ${artistName}`,
      config?.signal,
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
  async ({ songTitle, artistName }, config): Promise<string> =>
    searchText(
      "Production history",
      `"${songTitle}" "${artistName}" production history recording studio trivia making of`,
      `no production history found for "${songTitle}" by ${artistName}`,
      config?.signal,
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
  async ({ query }, config): Promise<string> =>
    searchText("General music search", query, `nothing found for "${query}"`, config?.signal),
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
