/**
 * ListenBrainz Tools for LangGraph Agent
 *
 * Similar artists from listening sessions, via the ListenBrainz Labs `similar-artists` dataset
 * (no API key). Takes the artist's own MusicBrainz MBID, or a name that is resolved through the
 * MusicBrainz client (and so its rate-limited queue) to the artist with exactly that name. The
 * result is the typed JSON of `toolResult.ts`, with the artist asked for and each similar
 * artist's raw score.
 *
 * @see https://labs.api.listenbrainz.org/similar-artists
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import dotenv from "dotenv";
import { describeError, fetchJson, type Shape, SourceError } from "./http.js";
import { ARTIST_REASON, findArtist, isMbid } from "./musicbrainz.js";
import { toolFailure } from "./toolResult.js";

dotenv.config();

// =============================================================================
// Configuration
// =============================================================================

const LABS_SIMILAR_ARTISTS = "https://labs.api.listenbrainz.org/similar-artists/json";
// The dataset ListenBrainz itself uses for artist similarity on its site.
const ALGORITHM =
  "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30";
const MAX_ARTISTS = 5;

// The answer is a list ordered by score; the pipeline reads the first few.
const SIMILAR_SHAPE: Shape = [{ artist_mbid: true, name: true, score: true }];

// =============================================================================
// Typed client
// =============================================================================

/**
 * An artist similar to the one asked for. Only the dataset's raw score is given: a score
 * relative to the top artist would make that artist "100 %" whatever the data says.
 */
export interface SimilarArtist {
  name: string;
  mbid: string;
  /**
   * The raw co-listening score of ListenBrainz's similar-artists dataset: higher is more
   * similar; it has no fixed maximum and is not 0-1.
   */
  score: number;
}

interface LabsSimilarArtist {
  artist_mbid?: unknown;
  name?: unknown;
  score?: unknown;
}

/**
 * Artists similar to `mbid`, most similar first; [] when the dataset has none. An answer that
 * is not a JSON list (e.g. an HTML page) rejects with a SourceError.
 */
export async function fetchSimilarArtists(mbid: string, limit = MAX_ARTISTS, signal?: AbortSignal) {
  if (!isMbid(mbid)) throw new SourceError("listenbrainz", "invalid_input", "not an MBID");
  const url = new URL(LABS_SIMILAR_ARTISTS);
  url.searchParams.set("artist_mbids", mbid);
  url.searchParams.set("algorithm", ALGORITHM);

  const data = await fetchJson<unknown>({
    source: "listenbrainz",
    url,
    headers: { Accept: "application/json" },
    scrub: SIMILAR_SHAPE,
    signal,
  });
  if (!Array.isArray(data)) {
    throw new SourceError("listenbrainz", "parse", "similar-artists answer is not a list");
  }

  const rows = (data as LabsSimilarArtist[])
    .filter(
      (a): a is { artist_mbid: string; name: string; score: number } =>
        isMbid(a?.artist_mbid) &&
        typeof a.name === "string" &&
        typeof a.score === "number" &&
        Number.isFinite(a.score) &&
        a.score > 0,
    )
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  return rows.map((a): SimilarArtist => ({ name: a.name, mbid: a.artist_mbid, score: a.score }));
}

// =============================================================================
// LangGraph Tools
// =============================================================================

/**
 * Get similar artists from ListenBrainz based on listening patterns
 */
export const getListenBrainzSimilarArtists = tool(
  async ({ artistMbid, artistName, artistNames, spotifyArtistId }, config): Promise<string> => {
    const signal = config?.signal;
    try {
      // The artist's own MBID: given, or resolved from its exact name on MusicBrainz.
      let artist = isMbid(artistMbid) ? { mbid: artistMbid, name: artistName ?? null } : null;
      if (!artist) {
        console.log(`🔍 [ListenBrainz] Resolving MBID for "${artistName ?? ""}"...`);
        const match = await findArtist(artistName ?? "", { artistNames, spotifyArtistId, signal });
        if (!match.artist) {
          // Nothing is asked of ListenBrainz for an artist MusicBrainz cannot identify, nor for a
          // request without a name (our input, not the source, is missing).
          return JSON.stringify({
            found: false,
            reason: ARTIST_REASON[match.reason],
            message: match.detail,
          });
        }
        artist = { mbid: match.artist.id, name: match.artist.name };
        console.log(`✅ [ListenBrainz] Resolved MBID: ${match.artist.id}`);
      }

      console.log(`🔗 [ListenBrainz] Getting similar artists for MBID: ${artist.mbid}`);
      const artists = await fetchSimilarArtists(artist.mbid, MAX_ARTISTS, signal);
      console.log(`✅ [ListenBrainz] Found ${artists.length} similar artists`);
      return JSON.stringify(
        artists.length > 0
          ? { found: true, artist, artists }
          : { found: false, reason: "no_similar_artists", artist },
      );
    } catch (error) {
      // A cancelled run rejects: nothing is reported for it.
      if (signal?.aborted) throw error;
      console.error("❌ [ListenBrainz] Similar artists error:", describeError(error));
      // A failure while resolving the name on MusicBrainz names MusicBrainz as the source.
      return JSON.stringify(toolFailure(error));
    }
  },
  {
    name: "listenbrainz_similar_artists",
    description:
      "Get similar artists from ListenBrainz (open-source, based on listening patterns). " +
      "Accepts artist MBID directly or artist name (auto-resolves via MusicBrainz). " +
      "No API key required. Use for genealogy and relatedArtists supplementation.",
    schema: z.object({
      artistMbid: z
        .string()
        .optional()
        .describe("MusicBrainz artist MBID (preferred, skips name resolution)"),
      artistName: z
        .string()
        .optional()
        .describe("Artist name (will be resolved to MBID via MusicBrainz search)"),
      artistNames: z
        .array(z.string())
        .optional()
        .describe("When artistName joins several artists: the artists one by one"),
      spotifyArtistId: z
        .string()
        .optional()
        .describe("The artist's Spotify id, to tell artists with the same name apart"),
    }),
  },
);

// =============================================================================
// Exports
// =============================================================================

export const listenbrainzTools = [getListenBrainzSimilarArtists];
