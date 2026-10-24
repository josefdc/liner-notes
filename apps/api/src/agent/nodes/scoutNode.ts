/**
 * Scout Node — Searches Spotify, picks the result that matches the query, and returns the
 * candidates instead when the user has to choose (see trackMatch.ts). A result stored for the
 * picked track is served without composing it again (storedResults.ts): the search always runs
 * first, so what is served is about the track this query finds now.
 */

import { getStore } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { SearchCandidate as SearchCandidateSchema } from "@liner-notes/contract";
import { searchMultipleTracks } from "../../sources/spotify.js";
import { isAbortError, withRetry, TransientError } from "../errors.js";
import { type AgentRuntime, defaultAgentRuntime, timestampOf } from "../runtime.js";
import type { SonicAgentStateType, SpotifyData } from "../state.js";
import type { SearchCandidate } from "../schema.js";
import { readStoredResult, servedResult } from "../storedResults.js";
import { needsChoice, rankTracks } from "../trackMatch.js";

export async function scoutNode(
  state: SonicAgentStateType,
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime = defaultAgentRuntime,
): Promise<Partial<SonicAgentStateType>> {
  const writer = config.writer;

  writer?.({
    type: "status",
    code: "NET-100",
    message: "Establishing connection to Spotify API...",
    node: "scout",
    timestamp: timestampOf(runtime),
  });

  console.log("🔍 [Scout] Searching for:", state.songQuery);

  try {
    // Search for multiple tracks to detect ambiguity (with retry on transient failures)
    const searchResult = await withRetry(
      async () => {
        const result = await searchMultipleTracks.invoke(
          // As many results as Spotify gives (10): a version or a cover ranked high by Spotify
          // must not push the original recording out of the choice.
          { query: state.songQuery, limit: 10 },
          { signal: config.signal },
        );
        // Spotify tools return error strings, not thrown exceptions
        if (
          result.startsWith("Error") &&
          (result.includes("Rate limit") || result.includes("429"))
        ) {
          throw new TransientError(result);
        }
        return result;
      },
      { signal: config.signal },
    );

    if (searchResult.startsWith("Error") || searchResult.startsWith("No track")) {
      return {
        error: searchResult,
        statusMessages: ["❌ Could not find song on Spotify"],
      };
    }

    const tracks = JSON.parse(searchResult) as SpotifyData[];

    if (tracks.length === 0) {
      return {
        error: "No tracks found",
        statusMessages: ["❌ No matching songs found"],
      };
    }

    // Spotify gives this app no popularity, so the results are judged on how their title and
    // artists match the query (trackMatch.ts): the best match first, selected without asking
    // only when it is clearly the song the query names.
    const ranked = rankTracks(state.songQuery, tracks);
    const best = ranked[0];
    const topTrack = best.track;
    const { maxCandidates } = state.hitlConfig;
    const queryMatch = best.match;
    if (queryMatch === "none") {
      console.warn("⚠️ [Scout] No result matches the query by title or artist:", state.songQuery);
    }

    if (needsChoice(ranked)) {
      // Convert to candidates for human selection (limited by maxCandidates config). One the
      // contract does not accept is left out rather than failing the whole choice.
      const candidates: SearchCandidate[] = ranked
        .slice(0, maxCandidates)
        .map(({ track: t }) => ({
          id: t.id,
          title: t.title,
          artist: t.artist,
          ...(t.artistNames ? { artistNames: t.artistNames } : {}),
          ...(t.artistIds ? { artistIds: t.artistIds } : {}),
          album: t.album,
          coverUrl: t.coverUrl,
          releaseYear: t.releaseDate?.split("-")[0],
          // Only a score Spotify gave; none is invented when it is missing.
          ...(typeof t.popularity === "number" ? { popularity: t.popularity } : {}),
        }))
        .filter((candidate) => {
          const checked = SearchCandidateSchema.safeParse(candidate);
          if (!checked.success) {
            console.warn(
              "⚠️ [Scout] Candidate left out, it does not fit the contract:",
              candidate.id,
              checked.error.issues.map((issue) => issue.path.join(".")),
            );
          }
          return checked.success;
        });
      // A pick remembered for the same text is not reused: it was one user's choice (or the
      // picker's countdown), and a title alone must always ask.
      console.log("⚠️ [Scout] Choice needed:", {
        query: state.songQuery,
        queryMatch,
        candidateCount: tracks.length,
      });

      if (candidates.length === 0) {
        return {
          error: "No candidate fits the contract",
          statusMessages: ["❌ No usable matches"],
        };
      }

      writer?.({
        type: "candidates",
        candidates,
        message: `Found ${candidates.length} matching songs. Please select one.`,
      });

      console.log("⏸️ [Scout] Returning candidates for user disambiguation");

      return {
        candidates,
        queryMatch,
        statusMessages: [`⚠️ Found ${candidates.length} matches - please select`],
      };
    }

    // Unambiguous: auto-select top result
    const selected = {
      spotifyData: topTrack,
      selectedTrackId: topTrack.id,
      isrc: topTrack.isrc ?? null,
      queryMatch,
      selectedBy: "match" as const,
    };
    const stored = await readStoredResult(getStore(), topTrack.id, runtime.now());
    config.signal?.throwIfAborted();
    if (stored) {
      console.log("📦 [Scout] Stored result for:", topTrack.id);
      const trackData = servedResult(stored, queryMatch);
      writer?.({
        type: "status",
        code: "NET-200",
        message: "Cache hit — returning stored analysis",
        node: "scout",
        timestamp: timestampOf(runtime),
      });
      writer?.({ type: "complete", data: trackData });
      return { ...selected, trackData };
    }

    writer?.({
      type: "status",
      code: "SPOTIFY-FOUND",
      message: `Target acquired: "${topTrack.title}" // ${topTrack.artist}`,
      node: "scout",
      timestamp: timestampOf(runtime),
    });
    console.log("✅ [Scout] Auto-selected:", topTrack.title, "by", topTrack.artist);

    return {
      ...selected,
      statusMessages: [`✅ Found: "${topTrack.title}" by ${topTrack.artist}`],
    };
  } catch (error) {
    // A cancelled run stops here instead of reporting a search error.
    if (config.signal?.aborted || isAbortError(error)) throw error;
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ [Scout] Error:", message);
    return {
      error: `Scout error: ${message}`,
      statusMessages: ["❌ Error searching Spotify"],
    };
  }
}
