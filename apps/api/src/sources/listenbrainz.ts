/**
 * ListenBrainz Tools for LangGraph Agent
 *
 * Provides open-source artist similarity data:
 * - Similar artists based on listening patterns (no API key required)
 *
 * Uses ListenBrainz Labs API. Requires MusicBrainz artist MBID.
 * Can resolve artist name → MBID via MusicBrainz search.
 *
 * @see https://listenbrainz.readthedocs.io/en/latest/users/api/
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import dotenv from "dotenv";

dotenv.config();

// =============================================================================
// Configuration
// =============================================================================

const LISTENBRAINZ_API = "https://api.listenbrainz.org";
const MB_API_BASE = "https://musicbrainz.org/ws/2";
const REQUEST_TIMEOUT = 10000; // 10 seconds
const USER_AGENT = process.env.MUSICBRAINZ_USER_AGENT || "SonicAgent/1.0 (contact@example.com)";

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Resolve artist name to MusicBrainz MBID via MusicBrainz search API
 */
async function resolveArtistMbid(artistName: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  try {
    const query = encodeURIComponent(`artist:"${artistName}"`);
    const url = `${MB_API_BASE}/artist?query=${query}&limit=1&fmt=json`;

    const response = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/json",
      },
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as {
      artists?: Array<{ id: string; name: string }>;
    };

    return data.artists?.[0]?.id || null;
  } catch {
    clearTimeout(timeout);
    return null;
  }
}

// =============================================================================
// LangGraph Tools
// =============================================================================

/**
 * Get similar artists from ListenBrainz based on listening patterns
 */
export const getListenBrainzSimilarArtists = tool(
  async ({ artistMbid, artistName }): Promise<string> => {
    try {
      // Resolve MBID from name if not directly provided
      let mbid = artistMbid;
      if (!mbid && artistName) {
        console.log(`🔍 [ListenBrainz] Resolving MBID for "${artistName}"...`);
        mbid = (await resolveArtistMbid(artistName)) ?? undefined;
        if (!mbid) {
          return JSON.stringify({
            found: false,
            error: `Could not resolve MusicBrainz MBID for "${artistName}"`,
          });
        }
        console.log(`✅ [ListenBrainz] Resolved MBID: ${mbid}`);
      }

      if (!mbid) {
        return JSON.stringify({
          found: false,
          error: "Either artistMbid or artistName is required",
        });
      }

      console.log(`🔗 [ListenBrainz] Getting similar artists for MBID: ${mbid}`);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

      try {
        const url = `${LISTENBRAINZ_API}/1/explore/similar-artists/${mbid}`;

        const response = await fetch(url, {
          headers: {
            "User-Agent": USER_AGENT,
            Accept: "application/json",
          },
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (!response.ok) {
          // Try the labs endpoint as fallback
          const labsController = new AbortController();
          const labsTimeout = setTimeout(() => labsController.abort(), REQUEST_TIMEOUT);

          try {
            const labsUrl = "https://labs.api.listenbrainz.org/similar-artists/json";
            const labsResponse = await fetch(labsUrl, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
              },
              body: JSON.stringify([{ artist_mbid: mbid }]),
              signal: labsController.signal,
            });

            clearTimeout(labsTimeout);

            if (!labsResponse.ok) {
              throw new Error(`ListenBrainz API error: HTTP ${labsResponse.status}`);
            }

            const labsData = (await labsResponse.json()) as Array<{
              artist_mbid: string;
              similar_artists?: Array<{
                artist_mbid: string;
                name?: string;
                score: number;
              }>;
            }>;

            const similar = labsData?.[0]?.similar_artists || [];
            const artists = similar.slice(0, 5).map((a) => ({
              name: a.name || a.artist_mbid,
              mbid: a.artist_mbid,
              similarity: a.score,
            }));

            console.log(`✅ [ListenBrainz] Found ${artists.length} similar artists (labs API)`);
            return JSON.stringify({ found: artists.length > 0, artists });
          } finally {
            clearTimeout(labsTimeout);
          }
        }

        const data = (await response.json()) as {
          payload?: Array<{
            artist_mbid: string;
            name?: string;
            score?: number;
            reference_mbid?: string;
          }>;
        };

        const similar = data.payload || [];
        const artists = similar.slice(0, 5).map((a) => ({
          name: a.name || a.artist_mbid,
          mbid: a.artist_mbid,
          similarity: a.score ?? 0,
        }));

        console.log(`✅ [ListenBrainz] Found ${artists.length} similar artists`);
        return JSON.stringify({ found: artists.length > 0, artists });
      } finally {
        clearTimeout(timeout);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [ListenBrainz] Similar artists error:", message);
      return JSON.stringify({ found: false, error: message });
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
    }),
  },
);

// =============================================================================
// Exports
// =============================================================================

export const listenbrainzTools = [getListenBrainzSimilarArtists];
