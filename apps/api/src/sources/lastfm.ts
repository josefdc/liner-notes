/**
 * Last.fm Tools for LangGraph Agent
 *
 * Provides genre tags, similar tracks/artists, and artist info:
 * - Track and artist genre tags (for radar chart / genre profile)
 * - Similar tracks (for Discovered Gems / genealogy)
 * - Similar artists (for genealogy edges)
 * - Artist bio and metadata (for factoids)
 *
 * Uses Last.fm API v2. Requires LASTFM_API_KEY in environment. Without it every tool reports
 * the source as unavailable (`unavailable: true`, code "not_configured"), never as "0 results",
 * and the missing key is logged once; a key Last.fm rejects (errors 4, 10, 26) is "key
 * rejected" (code "unavailable": an operator error, not a lasting configuration). Results are the typed JSON of `toolResult.ts`: a track or artist Last.fm does not
 * know is "nothing found"; an empty name is not sent; an answer Last.fm's autocorrection gave
 * for another artist is dropped; any other error is a failure with its code.
 *
 * @see https://www.last.fm/api
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { credential, fetchJson, isSourceError, type Shape } from "./http.js";
import { isMbid, normalizeName, onlyArtistNamed } from "./musicbrainz.js";
import {
  failureWith,
  keyRejected,
  type NotAnswered,
  notAnswered,
  type ToolFailure,
  toolFailure,
} from "./toolResult.js";
import { currentRunId, logger } from "../logger.js";

const log = logger("Last.fm");

// =============================================================================
// Configuration
// =============================================================================

const LASTFM_API_BASE = "https://ws.audioscrobbler.com/2.0/";

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
  tags?: { tag?: LastfmTag | LastfmTag[] };
  similar?: { artist?: LastfmSimilarArtist | LastfmSimilarArtist[] };
}

// =============================================================================
// Shared Helper
// =============================================================================

// Fields the pipeline reads, kept when a response is recorded to a cassette.
const TAGS_SHAPE: Shape = { tag: [{ name: true, count: true }] };
// "@attr" names the artist (and track) Last.fm answered for, after its autocorrection.
const ATTR_SHAPE: Shape = { artist: true, track: true };
const RESPONSE_SHAPE: Shape = {
  error: true,
  message: true,
  toptags: { tag: [{ name: true, count: true }], "@attr": ATTR_SHAPE },
  similartracks: {
    track: [{ name: true, match: true, artist: { name: true, mbid: true } }],
    "@attr": ATTR_SHAPE,
  },
  similarartists: { artist: [{ name: true, match: true, mbid: true }], "@attr": ATTR_SHAPE },
  artist: {
    name: true,
    mbid: true,
    stats: { listeners: true, playcount: true },
    bio: { summary: true },
    tags: TAGS_SHAPE,
    similar: { artist: [{ name: true, mbid: true }] },
  },
};

const NOT_CONFIGURED = "Last.fm is not configured (LASTFM_API_KEY is not set)";
let reportedMissingKey = false;

/** True when LASTFM_API_KEY is set. Without it the source is unavailable; reported once. */
export function lastfmConfigured(): boolean {
  if (credential("LASTFM_API_KEY")) return true;
  if (!reportedMissingKey) {
    reportedMissingKey = true;
    log.warn(`${NOT_CONFIGURED}; Last.fm tags and similar items are unavailable.`);
  }
  return false;
}

/** Last.fm's error answer: a numeric code and a message (also sent with HTTP 4xx). */
interface LastfmError {
  error?: number;
  message?: string;
}

/**
 * Last.fm's error 6, "Invalid parameters", is also its answer for a track or artist it does not
 * know ("Track not found", "The artist you supplied could not be found"). It is read as nothing
 * found when its message says "not found" or when there is no message (Last.fm sends one in
 * practice), and as a request Last.fm refused otherwise. Requests with an empty name are never
 * sent, so a refused request is not our missing input.
 */
const INVALID_PARAMETERS = 6;
/** Last.fm's error 29: rate limit exceeded. */
const RATE_LIMITED = 29;
/** Authentication failed, invalid API key, suspended API key: an operator error to fix. */
const KEY_REJECTED: ReadonlySet<number> = new Set([4, 10, 26]);

/**
 * The tool result for a call that brought nothing for the track: Last.fm does not know it
 * (`not_found`), or the request was not made or not answered for this artist (`no_input`: an
 * empty name; `invalid_request`: Last.fm refused the parameters; `other_artist`: Last.fm's
 * autocorrection answered for another artist).
 */
type NothingFound = NotAnswered;

type LastfmResult<T> =
  | {
      ok: true;
      data: T /** How Last.fm was asked: by the artist's MBID, or by its name. */;
      by?: "mbid" | "name";
    }
  | { ok: false; answer: ToolFailure | NothingFound };

/**
 * Whether the name stands for the identified artist alone, per run and name (each run asks
 * MusicBrainz once for its three artist methods): a few hundred answers are kept, the oldest
 * dropped first.
 */
const nameChecks = new Map<string, Promise<boolean>>();
const NAME_CHECKS_MAX = 500;

function nameIsOnly(name: string, mbid: string, signal?: AbortSignal): Promise<boolean> {
  const runId = currentRunId();
  // Outside a run nothing is kept: the answer may change between calls.
  if (!runId) return onlyArtistNamed(name, mbid, signal).catch(() => false);
  const key = `${runId}|${mbid}|${normalizeName(name)}`;
  let check = nameChecks.get(key);
  if (!check) {
    // A MusicBrainz that cannot be read leaves the name unchecked: not kept.
    check = onlyArtistNamed(name, mbid, signal).catch(() => false);
    nameChecks.set(key, check);
    if (nameChecks.size > NAME_CHECKS_MAX) {
      const oldest = nameChecks.keys().next().value;
      if (oldest !== undefined) nameChecks.delete(oldest);
    }
  }
  return check;
}

/**
 * Last.fm's own error answer as a tool result: "not found" is nothing found, not a failure; a
 * rejected key is "key rejected" (it blocks the research cache until it is fixed); a rate limit
 * is a rate limit.
 */
function lastfmError(body: LastfmError): ToolFailure | NothingFound {
  const message = `Last.fm error ${body.error ?? "?"}: ${body.message ?? "no message"}`;
  if (body.error === INVALID_PARAMETERS) {
    const notFound = !body.message || /\bnot (?:be )?found\b/i.test(body.message);
    return notAnswered(notFound ? "not_found" : "invalid_request", message);
  }
  if (body.error !== undefined && KEY_REJECTED.has(body.error)) {
    return keyRejected(`Last.fm rejected the API key (${message})`);
  }
  return failureWith(body.error === RATE_LIMITED ? "rate_limited" : "unavailable", message);
}

/** What a call asks for, to check before sending it and to check the answer against. */
interface LastfmRequest<T> {
  params: Record<string, string>;
  /** The artist asked for. */
  artist: string;
  /**
   * The artist's MusicBrainz id, when the run identified it: Last.fm is asked for that artist,
   * not for a name several artists may share. When Last.fm knows no artist with that id, the
   * request is made once more by name, and its answer kept only when MusicBrainz has exactly
   * one artist of that name, this one (`lastfm_unknown_mbid` otherwise).
   */
  mbid?: string;
  /** The artist Last.fm answered for (its "@attr" or the artist object's name). */
  answeredFor?: (data: T) => unknown;
}

/**
 * Calls a Last.fm method after checking the request: an empty name is not sent (`no_input`), and
 * an answer Last.fm's autocorrection gave for another artist is dropped (`other_artist`).
 */
async function askLastfm<T extends object>(
  request: LastfmRequest<T>,
  signal?: AbortSignal,
): Promise<LastfmResult<T>> {
  const empty = Object.entries(request.params).find(
    ([key, value]) => (key === "artist" || key === "track") && !value.trim(),
  );
  if (empty) {
    return { ok: false, answer: notAnswered("no_input", `no ${empty[0]} name to ask for`) };
  }
  let byName = false;
  if (request.mbid && isMbid(request.mbid)) {
    // By id: the answer is that artist's, whatever name Last.fm gives it.
    const { artist: _name, ...rest } = request.params;
    const byId = await callLastfm<T>({ ...rest, mbid: request.mbid }, signal);
    if (byId.ok) return { ...byId, by: "mbid" };
    if (!("reason" in byId.answer) || byId.answer.reason !== "not_found") return byId;
    // Last.fm knows no artist with this id. Its page for the name is this artist's only when
    // MusicBrainz has no other artist of that name.
    if (!(await nameIsOnly(request.artist, request.mbid, signal))) {
      return {
        ok: false,
        answer: notAnswered(
          "lastfm_unknown_mbid",
          `Last.fm knows no artist with MusicBrainz id ${request.mbid}, and MusicBrainz does not have exactly one artist named "${request.artist}"`,
        ),
      };
    }
    byName = true;
  }
  const result = await callLastfm<T>(request.params, signal);
  if (!result.ok) return result;
  const answered = request.answeredFor?.(result.data);
  if (typeof answered === "string" && normalizeName(answered) !== normalizeName(request.artist)) {
    return {
      ok: false,
      answer: notAnswered(
        "other_artist",
        `Last.fm answered for "${answered}", not "${request.artist}"`,
      ),
    };
  }
  return byName ? { ...result, by: "name" } : result;
}

/**
 * Calls a Last.fm method. Resolves with the data, or with the tool result that says why there
 * is none: not configured (no request made), nothing found, Last.fm's own error, or the
 * request's typed error. Methods that take names get `autocorrect=1`, so a misspelt name
 * resolves to the canonical one.
 */
async function callLastfm<T extends object>(
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<LastfmResult<T>> {
  if (!lastfmConfigured()) {
    return { ok: false, answer: failureWith("not_configured", NOT_CONFIGURED) };
  }

  const url = new URL(LASTFM_API_BASE);
  url.searchParams.set("api_key", credential("LASTFM_API_KEY") as string);
  url.searchParams.set("format", "json");
  url.searchParams.set("autocorrect", "1");
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  let data: T & LastfmError;
  try {
    data = await fetchJson<T & LastfmError>({
      source: "lastfm",
      url,
      scrub: RESPONSE_SHAPE,
      signal,
    });
  } catch (error) {
    // A cancelled run rejects: nothing is reported for it.
    if (signal?.aborted) throw error;
    // Last.fm answers errors with HTTP 4xx and a JSON body; keep its message and code.
    const body = isSourceError(error) ? (error.body as LastfmError | undefined) : undefined;
    if (body && typeof body.message === "string" && body.message) {
      return { ok: false, answer: lastfmError(body) };
    }
    return { ok: false, answer: toolFailure(error) };
  }
  if (data.error) return { ok: false, answer: lastfmError(data) };
  return { ok: true, data };
}

/** The tool result for a call that returned no data. */
function failure(result: { answer: ToolFailure | NothingFound }): string {
  return JSON.stringify(result.answer);
}

/** A log line for a call that returned no data. */
function why(result: { answer: ToolFailure | NothingFound }): string {
  return "error" in result.answer
    ? result.answer.error
    : (result.answer.message ?? result.answer.reason);
}

/** The artist (and track) Last.fm answered for. */
interface AnsweredFor {
  "@attr"?: { artist?: unknown; track?: unknown };
}
type TagsAnswer = { tag?: LastfmTag | LastfmTag[] } & AnsweredFor;

/** The start of a bio on a page Last.fm shares between artists of the same name. */
const SHARED_PAGE =
  /^there (?:are|is) (?:at least )?(?:multiple|several|many|more than one|two|three|four|five|six|\d+)\b[^.]{0,40}\bartists?\b/i;

/** Last.fm sends a single item as an object instead of a one-item list. */
function asList<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Filter noise tags using the blocklist
 */
function cleanTags(
  tags: LastfmTag | LastfmTag[] | undefined,
): Array<{ name: string; count: number }> {
  return asList(tags)
    .filter((t) => typeof t?.name === "string" && !TAG_BLOCKLIST.has(t.name.toLowerCase()))
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
  return `${cleaned.substring(0, maxLength).replace(/\s+\S*$/, "")}...`;
}

// =============================================================================
// LangGraph Tools
// =============================================================================

/**
 * Get top tags for a track from Last.fm
 */
export const getLastfmTrackTags = tool(
  async ({ title, artist }, config): Promise<string> => {
    log.info(`Getting track tags: "${title}" by ${artist}`);
    const result = await askLastfm<{ toptags?: TagsAnswer }>(
      {
        params: { method: "track.getTopTags", track: title, artist },
        artist,
        answeredFor: (data) => data.toptags?.["@attr"]?.artist,
      },
      config?.signal,
    );
    if (!result.ok) {
      log.error(`Track tags error: ${why(result)}`);
      return failure(result);
    }

    const tags = cleanTags(result.data.toptags?.tag);
    log.info(`Found ${tags.length} track tags`);
    return JSON.stringify({ found: tags.length > 0, tags });
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
  async ({ artist, mbid }, config): Promise<string> => {
    log.info(`Getting artist tags: "${artist}"`);
    const result = await askLastfm<{ toptags?: TagsAnswer }>(
      {
        params: { method: "artist.getTopTags", artist },
        artist,
        mbid,
        answeredFor: (data) => data.toptags?.["@attr"]?.artist,
      },
      config?.signal,
    );
    if (!result.ok) {
      log.error(`Artist tags error: ${why(result)}`);
      return failure(result);
    }

    const tags = cleanTags(result.data.toptags?.tag);
    log.info(`Found ${tags.length} artist tags`);
    return JSON.stringify({ found: tags.length > 0, tags });
  },
  {
    name: "lastfm_artist_tags",
    description:
      "Get genre/style tags for an artist from Last.fm community. " +
      "Supplementary genre data when track tags are sparse.",
    schema: z.object({
      artist: z.string().describe("The artist name"),
      mbid: z
        .string()
        .optional()
        .describe("The artist's MusicBrainz id, when known: Last.fm is asked for that artist"),
    }),
  },
);

/**
 * Get similar tracks from Last.fm
 */
export const getLastfmSimilarTracks = tool(
  async ({ title, artist }, config): Promise<string> => {
    log.info(`Getting similar tracks: "${title}" by ${artist}`);
    const result = await askLastfm<{
      similartracks?: { track?: LastfmSimilarTrack | LastfmSimilarTrack[] } & AnsweredFor;
    }>(
      {
        params: { method: "track.getSimilar", track: title, artist, limit: "5" },
        artist,
        answeredFor: (data) => data.similartracks?.["@attr"]?.artist,
      },
      config?.signal,
    );
    if (!result.ok) {
      log.error(`Similar tracks error: ${why(result)}`);
      return failure(result);
    }

    const tracks = asList(result.data.similartracks?.track)
      .filter((t) => typeof t?.name === "string" && typeof t.artist?.name === "string")
      .slice(0, 5)
      .map((t) => ({
        name: t.name,
        artist: t.artist.name,
        match: Number(t.match) || 0,
      }));

    log.info(`Found ${tracks.length} similar tracks`);
    return JSON.stringify({ found: tracks.length > 0, tracks });
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
  async ({ artist, mbid }, config): Promise<string> => {
    log.info(`Getting similar artists: "${artist}"`);
    const result = await askLastfm<{
      similarartists?: { artist?: LastfmSimilarArtist | LastfmSimilarArtist[] } & AnsweredFor;
    }>(
      {
        params: { method: "artist.getSimilar", artist, limit: "5" },
        artist,
        mbid,
        answeredFor: (data) => data.similarartists?.["@attr"]?.artist,
      },
      config?.signal,
    );
    if (!result.ok) {
      log.error(`Similar artists error: ${why(result)}`);
      return failure(result);
    }

    const artists = asList(result.data.similarartists?.artist)
      .filter((a) => typeof a?.name === "string")
      .slice(0, 5)
      .map((a) => ({
        name: a.name,
        match: Number(a.match) || 0,
        mbid: a.mbid || undefined,
      }));

    log.info(`Found ${artists.length} similar artists`);
    return JSON.stringify({ found: artists.length > 0, artists });
  },
  {
    name: "lastfm_similar_artists",
    description:
      "Get similar artists from Last.fm. Returns up to 5 artists with match scores and MBIDs. " +
      "Use for genealogy edges.",
    schema: z.object({
      artist: z.string().describe("The artist name"),
      mbid: z
        .string()
        .optional()
        .describe("The artist's MusicBrainz id, when known: Last.fm is asked for that artist"),
    }),
  },
);

/**
 * Get artist info from Last.fm (bio, stats, tags, similar)
 */
export const getLastfmArtistInfo = tool(
  async ({ artist, mbid }, config): Promise<string> => {
    log.info(`Getting artist info: "${artist}"`);
    const result = await askLastfm<{ artist?: LastfmArtistInfo }>(
      {
        params: { method: "artist.getInfo", artist },
        artist,
        mbid,
        answeredFor: (data) => data.artist?.name,
      },
      config?.signal,
    );
    if (!result.ok) {
      log.error(`Artist info error: ${why(result)}`);
      return failure(result);
    }

    const info = result.data.artist;
    if (!info || typeof info.name !== "string") {
      return JSON.stringify(notAnswered("not_found", "Artist not found"));
    }
    // Asked by name for an identified artist: a page Last.fm files under another MusicBrainz id
    // is another artist's.
    if (result.by === "name" && mbid && isMbid(info.mbid) && info.mbid !== mbid) {
      return JSON.stringify(
        notAnswered(
          "other_artist",
          `Last.fm's page for "${info.name}" is filed under another MusicBrainz artist`,
        ),
      );
    }

    const tags = cleanTags(info.tags?.tag);
    const similarArtists = asList(info.similar?.artist)
      .filter((a) => typeof a?.name === "string")
      .slice(0, 5)
      .map((a) => ({
        name: a.name,
        mbid: a.mbid || undefined,
      }));
    // Last.fm keeps one page for artists of the same name: its bio then describes several of
    // them, and its tags and similar artists mix them. None of it is this artist's.
    const bio = info.bio?.summary ? cleanBio(info.bio.summary) : undefined;
    if (bio && SHARED_PAGE.test(bio)) {
      return JSON.stringify(
        notAnswered("shared_page", `Last.fm's page for "${info.name}" covers several artists`),
      );
    }

    if (!bio && tags.length === 0 && similarArtists.length === 0) {
      return JSON.stringify(
        notAnswered("not_found", `Last.fm has no bio, tags or similar artists for "${info.name}"`),
      );
    }

    log.info(`Got artist info: ${info.name}`);
    return JSON.stringify({
      found: true,
      name: info.name,
      bio,
      listeners: info.stats?.listeners ? parseInt(info.stats.listeners, 10) : undefined,
      playcount: info.stats?.playcount ? parseInt(info.stats.playcount, 10) : undefined,
      tags,
      similarArtists,
    });
  },
  {
    name: "lastfm_artist_info",
    description:
      "Get artist biography, listener stats, tags, and similar artists from Last.fm. " +
      "Use for factoid content and supplementary data.",
    schema: z.object({
      artist: z.string().describe("The artist name"),
      mbid: z
        .string()
        .optional()
        .describe("The artist's MusicBrainz id, when known: Last.fm is asked for that artist"),
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
