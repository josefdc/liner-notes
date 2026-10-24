/**
 * Scout Node — Searches Spotify, picks the result that matches the query, and returns the
 * candidates instead when the user has to choose (see trackMatch.ts).
 */

import { getStore } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { SearchCandidate as SearchCandidateSchema, TrackAnalysis } from "@liner-notes/contract";
import { searchMultipleTracks } from "../../sources/spotify.js";
import { configuredSources, resultCacheKey, TRACKS_NAMESPACE } from "../cacheKeys.js";
import { isAbortError, withRetry, TransientError } from "../errors.js";
import { type AgentRuntime, defaultAgentRuntime, timestampOf } from "../runtime.js";
import type { SonicAgentStateType, SpotifyData } from "../state.js";
import type { SearchCandidate } from "../schema.js";
import { needsChoice, rankTracks } from "../trackMatch.js";

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
      const fresh =
        cached?.value?.trackData && runtime.now().getTime() - cached.value.timestamp < CACHE_TTL_MS;
      // A stored result the contract no longer accepts would be refused on every search until
      // it expires: it is composed again instead.
      const usable = fresh && TrackAnalysis.safeParse(cached.value.trackData).success;
      if (fresh && !usable) {
        console.warn("⚠️ [Scout] Stored result does not fit the contract; composing again");
      }
      if (usable) {
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
      // Check stored disambiguation preference before interrupting. A query nothing matches
      // always asks: a remembered pick is not a match.
      if (store && queryMatch !== "none") {
        try {
          const pref = await store.get(["disambiguation"], normalizedQuery);
          if (pref?.value?.selectedTrackId) {
            // The same list the clarification node remembers, so a left-out row cannot block a match.
            const currentIds = candidates
              .map((c) => c.id)
              .sort()
              .join(",");
            if (pref.value.candidateIds === currentIds) {
              // Same candidate set — auto-select the remembered preference
              const rememberedRank = ranked.find((r) => r.track.id === pref.value.selectedTrackId);
              const remembered = rememberedRank?.track;
              if (rememberedRank && remembered) {
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
                  isrc: remembered.isrc ?? null,
                  queryMatch: rememberedRank.match,
                  statusMessages: [`✅ Remembered: "${remembered.title}" by ${remembered.artist}`],
                };
              }
            }
          }
        } catch (e) {
          console.warn("⚠️ [Scout] Disambiguation store read error:", e);
        }
      }

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
      isrc: topTrack.isrc ?? null,
      queryMatch,
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
