/**
 * Web search (Tavily) for music research: sample history, production history and general
 * background.
 *
 * `webSearch` resolves with normalised results (title, URL, text) or rejects with a
 * SourceError. The tools return the typed JSON of `toolResult.ts`:
 *   - results: `{ found: true, results: [{ title, url, content }] }`;
 *   - nothing found: `{ found: false, reason: "no_results" }`;
 *   - search unavailable (no key, timeout, API error): `{ found: false, code, error }`; a key
 *     Tavily refuses (HTTP 401, 403) also carries `keyRejected: true`.
 * Lyric sites are excluded from every search, so no lyric text reaches research. So are social
 * platforms, whose pages are mostly comments and the handles of the people who wrote them (a
 * video page on YouTube carries a title, channel and description, and is kept), and any result
 * whose text is profile or handle boilerplate or a comment thread. Every @handle left in a
 * result's title and text is masked ("@…").
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import {
  credential,
  describeError,
  fetchJson,
  isSourceError,
  type Shape,
  SourceError,
} from "./http.js";
import { keyRejected, notAnswered, toolFailure } from "./toolResult.js";
import { logger } from "../logger.js";

const log = logger("Search");

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

/**
 * Social platforms and their short-link hosts, and forum comment pages (Hacker News): their pages
 * are page chrome, comments and the names or handles of private people, and weak evidence of a
 * song's history. Filtered from the answer by exact host or subdomain (m.facebook.com,
 * old.reddit.com) and through a translate proxy, and excluded in the request except for
 * SHORT_SITES. YouTube is not one of them: a video page carries a title, a channel (its
 * publisher) and a description.
 */
export const SOCIAL_SITES = [
  "instagram.com",
  "instagr.am",
  "tiktok.com",
  "vm.tiktok.com",
  "facebook.com",
  "fb.com",
  "fb.watch",
  "x.com",
  "twitter.com",
  "t.co",
  "threads.net",
  "threads.com",
  "bsky.app",
  "reddit.com",
  "redd.it",
  "pinterest.com",
  "tumblr.com",
  "news.ycombinator.com",
] as const;

/**
 * Social sites never sent in the request's `exclude_domains`: names so short that a match by
 * suffix would also exclude other sites (x.com would take complex.com and vox.com with it). The
 * request's list and the answer's filter differ for that reason only: the answer's filter
 * matches exact hosts and subdomains, so these are left out there.
 */
const SHORT_SITES: ReadonlySet<string> = new Set(["x.com", "t.co", "fb.com"]);

/** A host as Google's translate proxy writes it: "genius.com" → "genius-com.translate.goog". */
function translateProxyHost(host: string): string {
  return `${host.replace(/-/g, "--").replace(/\./g, "-")}.translate.goog`;
}

/** The host a translate.goog proxy host stands for: "genius-com.translate.goog" → "genius.com". */
function unproxyHost(host: string): string {
  const label = host.slice(0, -".translate.goog".length);
  return label.replace(/--/g, "\0").replace(/-/g, ".").replace(/\0/g, "-");
}

const EXCLUDED_SITES = [...LYRIC_SITES, ...SOCIAL_SITES.filter((site) => !SHORT_SITES.has(site))];

/**
 * Domains sent as `exclude_domains`: the lyric sites, social platforms and forum comment pages
 * (but SHORT_SITES), and their translate-proxy hosts.
 */
export const EXCLUDED_DOMAINS = [...EXCLUDED_SITES, ...EXCLUDED_SITES.map(translateProxyHost)];

function isLyricHost(host: string): boolean {
  if (LYRIC_SITES.some((site) => host === site || host.endsWith(`.${site}`))) return true;
  return /lyric|songtext|paroles|tekstowo/.test(host) || host.startsWith("letras.");
}

// Path words that mark a lyrics page. "lyric" alone is not one: "lyric-video" pages are news.
const LYRIC_PATH = /(?:^|[/_.,-])(?:lyrics|songtexte?|paroles|letras?|teksty?)(?=[/_.,?#-]|$)/i;

/** A URL written with or without a scheme, parsed; null when it does not parse. */
function looseUrl(url: string): URL | null {
  const text = url.trim();
  try {
    const withScheme = text.startsWith("//")
      ? `https:${text}`
      : /^[a-z][a-z0-9+.-]*:\/\//i.test(text)
        ? text
        : `https://${text}`;
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/** The page a Google translate link (translate.google.*?u=…) stands for, if it is one. */
function translatedPage(parsed: URL, host: string): string | null {
  if (!/^translate\.google\./.test(host)) return null;
  return parsed.searchParams.get("u") ?? parsed.searchParams.get("url");
}

const hostOf = (parsed: URL) => parsed.hostname.toLowerCase().replace(/\.$/, "");

/**
 * True for a URL on a lyric site (also through a translate proxy, and with or without a
 * scheme), or a page whose path says it is lyrics.
 */
export function isLyricPage(url: string): boolean {
  const parsed = looseUrl(url);
  if (!parsed) return false;
  const host = hostOf(parsed);
  if (isLyricHost(host)) return true;
  if (host.endsWith(".translate.goog") && isLyricHost(unproxyHost(host))) return true;
  const inner = translatedPage(parsed, host);
  if (inner && isLyricPage(inner)) return true;
  return LYRIC_PATH.test(parsed.pathname);
}

const onSite = (host: string, site: string) => host === site || host.endsWith(`.${site}`);

/**
 * True for a page on a social platform or a forum's comment pages (SOCIAL_SITES; also through a
 * translate proxy, and with or without a scheme).
 */
export function isSocialPage(url: string): boolean {
  const parsed = looseUrl(url);
  if (!parsed) return false;
  const host = hostOf(parsed);
  const named = host.endsWith(".translate.goog") ? unproxyHost(host) : host;
  if (SOCIAL_SITES.some((site) => onSite(named, site))) return true;
  const inner = translatedPage(parsed, host);
  return inner !== null && isSocialPage(inner);
}

/**
 * An @handle in text: an @ not after an ASCII letter, digit or e-mail character (an e-mail
 * address is not one; a handle right after another script or after "RT" is), then letters,
 * digits, "_", "." or "-", not ending with "." or "-". A masked handle ("@…") is not one.
 */
const HANDLE_IN_TEXT =
  /(?:(?<![A-Za-z0-9._%+\-@])|(?<=\bRT))@[\p{L}\p{N}_](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}_])?/gu;
const MASKED = "@…";

/** `text` with every @handle masked as "@…": a private person's handle is never stored. */
export function maskHandles(text: string): string {
  return text.replace(HANDLE_IN_TEXT, MASKED);
}

/** The longest web page title kept, cut before it is checked or stored. */
export const MAX_WEB_TITLE = 300;

/** A web page's title as it is checked and stored: cut, and its handles masked. */
export function webTitle(title: string): string {
  return maskHandles(title.trim().slice(0, MAX_WEB_TITLE).trimEnd());
}

/**
 * A user name as a comment thread shows it: a lower-case token with a digit or "_" after its
 * first letter ("jane_doe", "mark99", "some.one2"), or a masked handle. Never a tracklist
 * position ("a1", "cd2"), a band name ("R.E.M.", "U2") or a word.
 */
const USER_NAME = /^(?:@…|[a-z][a-z0-9_.]*[_\d][a-z0-9_.]*)$/;
const TRACK_POSITION = /^[a-z]{1,2}\d{1,2}$/;
const isUserName = (token: string) =>
  USER_NAME.test(token) && !TRACK_POSITION.test(token) && !token.endsWith(".");

/** "jane_doe's profile picture": the alt text a social page writes beside each commenter. */
const PROFILE_PICTURE = /(?:^|[\s(])(\S+?)['’]s profile (?:picture|photo)/gu;
/** A word that is a handle, masked or not, with the punctuation around it. */
const HANDLE_WORD = /^\(?(?:RT)?@(?:…|[\p{L}\p{N}_.-]+)[),:;.!?·]*$/u;
/** The buttons of a comment thread. */
const THREAD_LABELS: ReadonlySet<string> = new Set([
  "Reply",
  "Replies",
  "Like",
  "Likes",
  "Follow",
  "Following",
]);
/** A comment's age as a thread shows it, glued: "3w", "2d", "5h", "10m" (never "'90s" or "5 min"). */
const AGE = /^\d{1,3}[wdhm]$/;
/** How far a thread's button stands from its comment's age, in words. */
const LABEL_REACH = 3;
/** "name: comment", where the name is a token of its own. */
const NAME_LINE = /(?:^|[\s.!?])([^\s:]+):(?=\s)/gu;
/**
 * A forum comment's byline, as Hacker News writes it: a user name, the comment's date ("on Feb
 * 22, 2021") or age ("3 hours ago"), then the thread's links ("| parent", "| prev", "| next",
 * "| root"). A byline without the thread's links ("by Jane Smith on Feb 22, 2021") is not one.
 */
const FORUM_BYLINE =
  /(?:^|\s)[^\s|]+\s+(?:on\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}|\d{1,4}\s+(?:minute|hour|day|month|year)s?\s+ago)\s+\|\s+(?:parent|prev|next|root)\b/u;

/** A token without the punctuation around it. */
const bare = (token: string) => token.replace(/^[^\p{L}\p{N}@…]+|[^\p{L}\p{N}…]+$/gu, "");

/** How many comments' ages stand within LABEL_REACH words of their own thread button. */
function labelledAges(words: readonly string[]): number {
  const tokens = words.map(bare);
  const used = new Set<number>();
  let pairs = 0;
  tokens.forEach((token, i) => {
    if (!AGE.test(token)) return;
    for (let d = 1; d <= LABEL_REACH; d++) {
      for (const j of [i + d, i - d]) {
        if (j >= 0 && j < tokens.length && !used.has(j) && THREAD_LABELS.has(tokens[j])) {
          used.add(j);
          pairs++;
          return;
        }
      }
    }
  });
  return pairs;
}

/**
 * Why a web page's text (as it is stored: an excerpt or a title) is not kept, or null:
 * - "a private @handle": a handle that was not masked (maskHandles);
 * - "profile or handle boilerplate": "'s profile picture" right after a user name, or three or
 *   more handles in a row or that make up a fifth of the words;
 * - "a comment thread": two comments' ages ("3w") each next to a thread button ("Reply",
 *   "Like", "Follow"), three "name: comment" lines whose names are user names, or a forum
 *   comment's byline ("some_user on Feb 22, 2021 | parent", "some_user 3 hours ago | next").
 * One handle in a sentence ("Thomas Bangalter (@…)"), "Following the success of …", "the '90s",
 * a tracklist ("A1: …"), "R.E.M.: …", a "|"-separated title and a byline without a thread's
 * links are kept. The web tier runs this on the text it stores,
 * and every reader of stored evidence runs it again on the same text.
 */
export function webTextIssue(text: string): string | null {
  if ((text.match(HANDLE_IN_TEXT)?.length ?? 0) > 0) return "a private @handle";
  for (const [, name] of text.matchAll(PROFILE_PICTURE)) {
    if (isUserName(name)) return "profile or handle boilerplate";
  }
  const words = text.split(/\s+/).filter(Boolean);
  let handles = 0;
  let run = 0;
  for (const word of words) {
    if (HANDLE_WORD.test(word)) {
      handles++;
      run++;
      if (run >= 3) return "profile or handle boilerplate";
    } else {
      run = 0;
    }
  }
  if (handles >= 3 && handles / words.length >= 0.2) return "profile or handle boilerplate";
  if (labelledAges(words) >= 2) return "a comment thread";
  let names = 0;
  for (const [, name] of text.matchAll(NAME_LINE)) if (isUserName(name)) names++;
  if (names >= 3) return "a comment thread";
  if (FORUM_BYLINE.test(text)) return "a comment thread";
  return null;
}

/**
 * Why the web tier leaves a page out, from what is stored of it (its URL, title and text), or
 * null: a social platform page, or a title or text with an issue (webTextIssue).
 */
export function webPageIssue(page: {
  url?: string | null;
  title?: string | null;
  text: string;
}): string | null {
  if (page.url && isSocialPage(page.url)) return "a social platform page";
  return webTextIssue(page.text) ?? (page.title ? webTextIssue(page.title) : null);
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

/** True when web search can be asked (TAVILY_API_KEY is set, or a replay cassette answers). */
export function tavilyConfigured(): boolean {
  return Boolean(credential("TAVILY_API_KEY"));
}

/**
 * Searches the web. Rejects with SourceError "unavailable" when TAVILY_API_KEY is not set (no
 * request is made), and with the request's typed error when Tavily cannot answer.
 */
export async function webSearch(query: string, signal?: AbortSignal): Promise<WebResult[]> {
  const apiKey = credential("TAVILY_API_KEY");
  if (!apiKey) {
    if (!warnedNoKey) {
      warnedNoKey = true;
      log.warn("TAVILY_API_KEY is not set; web search is unavailable.");
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
    // A cassette may be committed: it never keeps a social page or a handle.
    recordAs: keptAnswer,
    signal,
  });

  if (!data || !Array.isArray(data.results)) {
    throw new SourceError("tavily", "parse", "search response has no results list");
  }

  return data.results.flatMap((r) => {
    const result = keptResult(r);
    return result ? [result] : [];
  });
}

/**
 * A result as the search keeps it, or null: no lyric or social platform page, handles masked in
 * its title and text, the title cut to MAX_WEB_TITLE and the text to MAX_RESULT_TEXT (without a
 * space left at the cut), and nothing whose text or title is boilerplate or a comment thread.
 * Run on a result it made, it gives the same result, so a cassette can hold the kept results
 * only. A cassette therefore keeps the decisions of the rules it was recorded with: a result a
 * later rule would keep is not in it.
 */
function keptResult(r: { title?: unknown; url?: unknown; content?: unknown }): WebResult | null {
  if (typeof r?.url !== "string" || typeof r.content !== "string") return null;
  if (isLyricPage(r.url) || isSocialPage(r.url)) return null;
  const content = maskHandles(r.content.replace(/\s+/g, " ").trim())
    .slice(0, MAX_RESULT_TEXT)
    .trimEnd();
  if (!content) return null;
  const title = webTitle(typeof r.title === "string" && r.title.trim() ? r.title : r.url);
  if (webPageIssue({ url: r.url, title, text: content })) return null;
  return { title, url: r.url, content };
}

/** What a cassette keeps of an answer: only the results the search keeps, as it keeps them. */
function keptAnswer(data: unknown): unknown {
  const results = (data as TavilyResponse | null)?.results;
  if (!Array.isArray(results)) return data;
  return { ...(data as object), results: results.flatMap((r) => keptResult(r) ?? []) };
}

/** Results as one string: a "title / URL / text" block per result. */
export function formatResults(results: WebResult[]): string {
  return results.map((r) => `${r.title}\n${r.url}\n${r.content}`).join("\n\n");
}

/**
 * Runs a search for a tool: its results, "nothing found", or the failure with its code. A
 * cancelled run (its `signal` aborted) rejects instead: nothing is reported.
 */
async function searchText(
  label: string,
  query: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  signal?.throwIfAborted();
  log.info(label);
  log.debug(label, { query });
  try {
    const results = await webSearch(query, signal);
    return JSON.stringify(
      results.length > 0 ? { found: true, results } : notAnswered("no_results"),
    );
  } catch (error) {
    if (signal?.aborted) throw error;
    log.error(`${label} unavailable: ${describeError(error)}`);
    // 401 and 403 mean Tavily refused the key: an operator error, reported as such.
    if (isSourceError(error, "http") && (error.status === 401 || error.status === 403)) {
      return JSON.stringify({
        ...keyRejected(`Tavily rejected the API key (${describeError(error)})`),
        source: "tavily",
      });
    }
    return JSON.stringify(toolFailure(error));
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
    searchText("General music search", query, config?.signal),
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
