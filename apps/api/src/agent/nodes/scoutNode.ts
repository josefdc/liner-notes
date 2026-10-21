/**
 * Scout Node — Searches Spotify and returns multiple candidates if ambiguous
 */

import { getStore } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { searchMultipleTracks } from "../../sources/spotify.js";
import { configuredSources, resultCacheKey, TRACKS_NAMESPACE } from "../cacheKeys.js";
import { isAbortError, withRetry, TransientError } from "../errors.js";
import { type AgentRuntime, defaultAgentRuntime, timestampOf } from "../runtime.js";
import type { SonicAgentStateType, SpotifyData } from "../state.js";
import type { SearchCandidate } from "../schema.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export async function scoutNode(
  state: SonicAgentStateType,
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime = defaultAgentRuntime,
): Promise<Partial<SonicAgentStateType>> {
  const writer = config.writer;
  const store = getStore();
  const normalizedQuery = state.songQuery.toLowerCase().trim();

  // Check long-term memory for cached result
  if (store) {
    try {
      // The key names the configured sources: adding a key later composes the result again.
      const cached = await store.get(
        TRACKS_NAMESPACE,
        resultCacheKey(normalizedQuery, configuredSources()),
      );
      if (
        cached?.value?.trackData &&
        runtime.now().getTime() - cached.value.timestamp < CACHE_TTL_MS
      ) {
        console.log("📦 [Scout] Cache hit for:", normalizedQuery);
        writer?.({
          type: "status",
          code: "NET-200",
          message: "Cache hit — returning stored analysis",
          node: "scout",
          timestamp: timestampOf(runtime),
        });
        writer?.({ type: "complete", data: cached.value.trackData });
        return { trackData: cached.value.trackData };
      }
    } catch (e) {
      console.warn("⚠️ [Scout] Store read error:", e);
    }
  }

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
          { query: state.songQuery, limit: 5 },
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

    // Check for ambiguity: multiple results with similar popularity
    // Auto-select ONLY if: top track is VERY popular OR has a HUGE gap over #2
    // Thresholds are now configurable via state.hitlConfig
    const topTrack = tracks[0];
    const secondTrack = tracks[1];
    const { disambiguationThreshold, popularityGap, maxCandidates } = state.hitlConfig;

    const isTopTrackDominant = topTrack.popularity >= disambiguationThreshold;
    const hasSignificantGap =
      !secondTrack || secondTrack.popularity < topTrack.popularity * popularityGap;
    const isAmbiguous = tracks.length > 1 && !isTopTrackDominant && !hasSignificantGap;

    if (isAmbiguous) {
      // Check stored disambiguation preference before interrupting
      if (store) {
        try {
          const pref = await store.get(["disambiguation"], normalizedQuery);
          if (pref?.value?.selectedTrackId) {
            const currentIds = tracks
              .slice(0, maxCandidates)
              .map((t) => t.id)
              .sort()
              .join(",");
            if (pref.value.candidateIds === currentIds) {
              // Same candidate set — auto-select the remembered preference
              const remembered = tracks.find((t) => t.id === pref.value.selectedTrackId);
              if (remembered) {
                console.log(
                  "📦 [Scout] Auto-selecting from disambiguation memory:",
                  remembered.title,
                );
                writer?.({
                  type: "status",
                  code: "SPOTIFY-FOUND",
                  message: `Remembered preference: "${remembered.title}" // ${remembered.artist}`,
                  node: "scout",
                  timestamp: timestampOf(runtime),
                });
                return {
                  spotifyData: remembered,
                  selectedTrackId: remembered.id,
                  statusMessages: [`✅ Remembered: "${remembered.title}" by ${remembered.artist}`],
                };
              }
            }
          }
        } catch (e) {
          console.warn("⚠️ [Scout] Disambiguation store read error:", e);
        }
      }

      // Debug: Log HITL trigger details
      console.log("⚠️ [Scout] HITL triggered:", {
        query: state.songQuery,
        topPopularity: topTrack.popularity,
        secondPopularity: secondTrack?.popularity ?? 0,
        threshold: disambiguationThreshold,
        gapRatio: popularityGap,
        candidateCount: tracks.length,
        reason: `Top: ${topTrack.popularity} < threshold ${disambiguationThreshold} AND no significant gap`,
      });

      // Convert to candidates for human selection (limited by maxCandidates config)
      const candidates: SearchCandidate[] = tracks.slice(0, maxCandidates).map((t) => ({
        id: t.id,
        title: t.title,
        artist: t.artist,
        ...(t.artistNames ? { artistNames: t.artistNames } : {}),
        ...(t.artistIds ? { artistIds: t.artistIds } : {}),
        album: t.album,
        coverUrl: t.coverUrl,
        releaseYear: t.releaseDate?.split("-")[0],
        popularity: t.popularity,
      }));

      writer?.({
        type: "candidates",
        candidates,
        message: `Found ${candidates.length} matching songs. Please select one.`,
      });

      console.log("⏸️ [Scout] Returning candidates for user disambiguation");

      return {
        candidates,
        statusMessages: [`⚠️ Found ${candidates.length} matches - please select`],
      };
    }

    // Unambiguous: auto-select top result
    writer?.({
      type: "status",
      code: "SPOTIFY-FOUND",
      message: `Target acquired: "${topTrack.title}" // ${topTrack.artist}`,
      node: "scout",
      timestamp: timestampOf(runtime),
    });
    console.log("✅ [Scout] Auto-selected:", topTrack.title, "by", topTrack.artist);

    return {
      spotifyData: topTrack,
      selectedTrackId: topTrack.id,
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
