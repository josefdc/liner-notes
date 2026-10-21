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
 * the source as unavailable (`unavailable: true`), never as "0 results", and the missing key is
 * logged once.
 *
 * @see https://www.last.fm/api
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import { credential, describeError, fetchJson, isSourceError, type Shape } from "./http.js";

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
const RESPONSE_SHAPE: Shape = {
  error: true,
  message: true,
  toptags: TAGS_SHAPE,
  similartracks: { track: [{ name: true, match: true, artist: { name: true, mbid: true } }] },
  similarartists: { artist: [{ name: true, match: true, mbid: true }] },
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
    console.warn(`⚠️ [Last.fm] ${NOT_CONFIGURED}; Last.fm tags and similar items are unavailable.`);
  }
  return false;
}

/** Last.fm's error answer: a numeric code and a message (also sent with HTTP 4xx). */
interface LastfmError {
  error?: number;
  message?: string;
}

type LastfmResult<T> = { ok: true; data: T } | { ok: false; error: string; unavailable?: true };

/**
 * Calls a Last.fm method. Resolves with the data, or with the reason it is missing: not
 * configured (no request made), Last.fm's own error message, or the request's typed error.
 * Methods that take names get `autocorrect=1`, so a misspelt name resolves to the canonical one.
 */
async function callLastfm<T extends object>(
  params: Record<string, string>,
  signal?: AbortSignal,
): Promise<LastfmResult<T>> {
  if (!lastfmConfigured()) return { ok: false, error: NOT_CONFIGURED, unavailable: true };

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
    // Last.fm answers errors with HTTP 4xx and a JSON body; keep its message.
    const body = isSourceError(error) ? (error.body as LastfmError | undefined) : undefined;
    if (body && typeof body.message === "string" && body.message) {
      return { ok: false, error: `Last.fm error ${body.error ?? "?"}: ${body.message}` };
    }
    return { ok: false, error: describeError(error) };
  }
  if (data.error) {
    return { ok: false, error: `Last.fm error ${data.error}: ${data.message ?? "no message"}` };
  }
  return { ok: true, data };
}

/** The tool result for a call that returned no data. */
function failure(result: { error: string; unavailable?: true }): string {
  return JSON.stringify(
    result.unavailable
      ? { found: false, unavailable: true, error: result.error }
      : { found: false, error: result.error },
  );
}

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
    console.log(`🏷️ [Last.fm] Getting track tags: "${title}" by ${artist}`);
    const result = await callLastfm<{ toptags?: { tag?: LastfmTag | LastfmTag[] } }>(
      {
        method: "track.getTopTags",
        track: title,
        artist: artist,
      },
      config?.signal,
    );
    if (!result.ok) {
      console.error("❌ [Last.fm] Track tags error:", result.error);
      return failure(result);
    }

    const tags = cleanTags(result.data.toptags?.tag);
    console.log(`✅ [Last.fm] Found ${tags.length} track tags`);
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
  async ({ artist }, config): Promise<string> => {
    console.log(`🏷️ [Last.fm] Getting artist tags: "${artist}"`);
    const result = await callLastfm<{ toptags?: { tag?: LastfmTag | LastfmTag[] } }>(
      {
        method: "artist.getTopTags",
        artist: artist,
      },
      config?.signal,
    );
    if (!result.ok) {
      console.error("❌ [Last.fm] Artist tags error:", result.error);
      return failure(result);
    }

    const tags = cleanTags(result.data.toptags?.tag);
    console.log(`✅ [Last.fm] Found ${tags.length} artist tags`);
    return JSON.stringify({ found: tags.length > 0, tags });
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
  async ({ title, artist }, config): Promise<string> => {
    console.log(`🔗 [Last.fm] Getting similar tracks: "${title}" by ${artist}`);
    const result = await callLastfm<{
      similartracks?: { track?: LastfmSimilarTrack | LastfmSimilarTrack[] };
    }>(
      {
        method: "track.getSimilar",
        track: title,
        artist: artist,
        limit: "5",
      },
      config?.signal,
    );
    if (!result.ok) {
      console.error("❌ [Last.fm] Similar tracks error:", result.error);
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

    console.log(`✅ [Last.fm] Found ${tracks.length} similar tracks`);
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
  async ({ artist }, config): Promise<string> => {
    console.log(`🔗 [Last.fm] Getting similar artists: "${artist}"`);
    const result = await callLastfm<{
      similarartists?: { artist?: LastfmSimilarArtist | LastfmSimilarArtist[] };
    }>(
      {
        method: "artist.getSimilar",
        artist: artist,
        limit: "5",
      },
      config?.signal,
    );
    if (!result.ok) {
      console.error("❌ [Last.fm] Similar artists error:", result.error);
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

    console.log(`✅ [Last.fm] Found ${artists.length} similar artists`);
    return JSON.stringify({ found: artists.length > 0, artists });
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
  async ({ artist }, config): Promise<string> => {
    console.log(`📋 [Last.fm] Getting artist info: "${artist}"`);
    const result = await callLastfm<{ artist?: LastfmArtistInfo }>(
      {
        method: "artist.getInfo",
        artist: artist,
      },
      config?.signal,
    );
    if (!result.ok) {
      console.error("❌ [Last.fm] Artist info error:", result.error);
      return failure(result);
    }

    const info = result.data.artist;
    if (!info || typeof info.name !== "string") {
      return JSON.stringify({ found: false, error: "Artist not found" });
    }

    const tags = cleanTags(info.tags?.tag);
    const similarArtists = asList(info.similar?.artist)
      .filter((a) => typeof a?.name === "string")
      .slice(0, 5)
      .map((a) => ({
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
