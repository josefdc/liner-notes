/**
 * Historian Node — Deep Dive Research
 * Runs in parallel with Engineer
 * Uses the ResearcherSubgraph for iterative ReAct-pattern research
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { searchSamples, searchProductionHistory, searchSongMeaning } from "../../sources/search.js";
import { fetchLyrics } from "../../sources/genius.js";
import { getMusicBrainzRelations } from "../../sources/musicbrainz.js";
import { getLastfmTrackTags, getLastfmArtistTags, getLastfmSimilarTracks } from "../../sources/lastfm.js";
import { getCachedResearcherSubgraph } from "../researcherSubgraph.js";
import { withRetry } from "../errors.js";
import { getCache } from "../../store/cache.js";
import type { SonicAgentStateType, ResearchData } from "../state.js";

export async function historianNode(
  state: SonicAgentStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<SonicAgentStateType>> {
  if (!state.spotifyData) {
    return { statusMessages: ["⚠️ Skipping research - no track data"] };
  }

  const writer = config.writer;

  // Check persistent research cache first
  try {
    const cache = getCache();
    const cachedResearch = cache.getResearch(state.spotifyData.id);
    if (cachedResearch) {
      console.log("📚 [Historian] Cache hit for:", state.spotifyData.title);
      writer?.({
        type: "status",
        code: "RESEARCH-FOUND",
        message: "Research cache hit — intelligence already extracted",
        node: "historian",
        timestamp: new Date().toISOString(),
      });
      return {
        researchData: cachedResearch,
        statusMessages: ["📚 Research (cached): loaded from persistent cache"],
      };
    }
  } catch {
    // Cache not available — proceed with fresh research
  }

  writer?.({
    type: "status",
    code: "RESEARCH-START",
    message: "Activating deep-web research protocols...",
    node: "historian",
    timestamp: new Date().toISOString(),
  });

  const { title, artist } = state.spotifyData;
  console.log("📚 [Historian] Deep dive research for:", title, "by", artist);

  // Pre-fetch Last.fm tags and similar tracks in parallel (outside the researcher loop)
  // This ensures genre tags are always available regardless of which actions the LLM picks
  const prefetchData: Partial<ResearchData> = {};
  try {
    console.log("🏷️ [Historian] Pre-fetching Last.fm data in parallel...");
    const [trackTagsResult, artistTagsResult, similarTracksResult] = await Promise.allSettled([
      getLastfmTrackTags.invoke({ title, artist }),
      getLastfmArtistTags.invoke({ artist }),
      getLastfmSimilarTracks.invoke({ title, artist }),
    ]);

    // Process track tags
    if (trackTagsResult.status === "fulfilled") {
      try {
        const data = JSON.parse(trackTagsResult.value);
        if (data.found && data.tags?.length > 0) {
          prefetchData.lastfmTags = data.tags.map((t: { name: string; count: number }) =>
            `${t.name} (${t.count})`
          );
        }
      } catch { /* ignore parse errors */ }
    }

    // Process artist tags (merge with track tags, deduplicate)
    if (artistTagsResult.status === "fulfilled") {
      try {
        const data = JSON.parse(artistTagsResult.value);
        if (data.found && data.tags?.length > 0) {
          const existingNames = new Set(
            (prefetchData.lastfmTags || []).map((t: string) => t.replace(/\s*\(\d+\)$/, "").toLowerCase())
          );
          const newTags = data.tags
            .filter((t: { name: string }) => !existingNames.has(t.name.toLowerCase()))
            .map((t: { name: string; count: number }) => `${t.name} (${t.count})`);
          prefetchData.lastfmTags = [...(prefetchData.lastfmTags || []), ...newTags];
        }
      } catch { /* ignore parse errors */ }
    }

    // Process similar tracks
    if (similarTracksResult.status === "fulfilled") {
      try {
        const data = JSON.parse(similarTracksResult.value);
        if (data.found && data.tracks?.length > 0) {
          prefetchData.lastfmSimilarTracks = data.tracks.map(
            (t: { name: string; artist: string; match: number }) =>
              `${t.name} by ${t.artist} (match: ${(t.match * 100).toFixed(0)}%)`
          );
        }
      } catch { /* ignore parse errors */ }
    }

    const tagCount = prefetchData.lastfmTags?.length || 0;
    const trackCount = prefetchData.lastfmSimilarTracks?.length || 0;
    console.log(`✅ [Historian] Pre-fetched ${tagCount} tags, ${trackCount} similar tracks from Last.fm`);
  } catch (error) {
    console.warn("⚠️ [Historian] Last.fm pre-fetch failed (non-critical):", error);
  }

  try {
    // Use cached researcher subgraph singleton with streaming
    const researcherGraph = getCachedResearcherSubgraph();

    const stream = await researcherGraph.stream(
      {
        spotifyData: state.spotifyData,
        researchData: state.researchData,
      },
      {
        streamMode: ["values", "custom"],
      }
    );

    let finalState: any = {};
    for await (const event of stream) {
      const [mode, chunk] = event as unknown as [string, unknown];
      if (mode === "custom") {
        // Forward subgraph progress events to parent SSE stream
        writer?.(chunk);
      } else if (mode === "values") {
        // Last values chunk = final accumulated state
        finalState = chunk;
      }
    }

    console.log(
      `✅ [Historian] Deep dive complete - ${finalState.researchIteration || 0} iterations`
    );

    writer?.({
      type: "status",
      code: "RESEARCH-FOUND",
      message: `Intelligence extraction complete: ${finalState.researchIteration || 0} layers processed`,
      node: "historian",
      timestamp: new Date().toISOString(),
    });

    // Merge pre-fetched Last.fm data with subgraph research results
    const mergedResearch: ResearchData = {
      ...finalState.researchData,
      lastfmTags: [
        ...(prefetchData.lastfmTags || []),
        ...(finalState.researchData?.lastfmTags || []),
      ],
      lastfmSimilarTracks: [
        ...(prefetchData.lastfmSimilarTracks || []),
        ...(finalState.researchData?.lastfmSimilarTracks || []),
      ],
    };

    // Persist to cache
    try {
      getCache().putResearch(state.spotifyData!.id, mergedResearch);
    } catch {
      // Non-critical
    }

    return {
      researchData: mergedResearch,
      statusMessages: finalState.statusMessages || [],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ [Historian] Deep dive error:", message);

    // Fallback: run enhanced parallel research with new tools
    console.log("⚠️ [Historian] Falling back to enhanced basic research");

    const researchData: ResearchData = {
      samples: [],
      productionTrivia: [],
      songMeaning: [],
      relatedArtists: [],
      collaborators: [],
      artistTopTracks: [],
      lastfmTags: prefetchData.lastfmTags || [],
      lastfmSimilarTracks: prefetchData.lastfmSimilarTracks || [],
      lastfmSimilarArtists: [],
      lastfmArtistBio: undefined,
      listenbrainzSimilarArtists: [],
    };

    try {
      // Enhanced research: Use MusicBrainz for structured data, Genius for lyrics, plus web search
      const [
        samplesResult,
        triviaResult,
        meaningResult,
        musicBrainzResult,
        lyricsResult,
      ] = await Promise.allSettled([
        withRetry(() => searchSamples.invoke({ songTitle: title, artistName: artist })),
        withRetry(() => searchProductionHistory.invoke({ songTitle: title, artistName: artist })),
        withRetry(() => searchSongMeaning.invoke({ songTitle: title, artistName: artist })),
        withRetry(() => getMusicBrainzRelations.invoke({ title, artist })),
        withRetry(() => fetchLyrics.invoke({ title, artist })),
      ]);

      // Process web search results
      if (samplesResult.status === "fulfilled" && !samplesResult.value.startsWith("Error")) {
        researchData.samples.push(samplesResult.value);
      }
      if (triviaResult.status === "fulfilled" && !triviaResult.value.startsWith("Error")) {
        researchData.productionTrivia.push(triviaResult.value);
      }
      if (meaningResult.status === "fulfilled" && !meaningResult.value.startsWith("Error")) {
        researchData.songMeaning.push(meaningResult.value);
      }

      // Process MusicBrainz structured data
      if (musicBrainzResult.status === "fulfilled") {
        try {
          const mbData = JSON.parse(musicBrainzResult.value);
          if (mbData.found && mbData.genealogy) {
            const { samples, covers, remixes } = mbData.genealogy;
            if (samples?.length > 0) {
              researchData.samples.push(
                `[MusicBrainz] Structured sample data: ${JSON.stringify(samples)}`
              );
            }
            if (covers?.length > 0 || remixes?.length > 0) {
              researchData.productionTrivia.push(
                `[MusicBrainz] Covers: ${JSON.stringify(covers)}, Remixes: ${JSON.stringify(remixes)}`
              );
            }
          }
        } catch (e) {
          console.warn("[Historian] MusicBrainz parse error:", e);
        }
      }

      // Process Genius lyrics
      if (lyricsResult.status === "fulfilled") {
        try {
          const lyricsData = JSON.parse(lyricsResult.value);
          if (lyricsData.lyrics) {
            researchData.songMeaning.push(
              `[Genius Lyrics] Raw lyrics for analysis:\n${lyricsData.lyrics}`
            );
          }
        } catch (e) {
          console.warn("[Historian] Genius lyrics parse error:", e);
        }
      }

      return {
        researchData,
        statusMessages: ["📚 Enhanced research complete (with Genius & MusicBrainz)"],
      };
    } catch {
      return {
        researchData,
        statusMessages: ["⚠️ Research failed"],
      };
    }
  }
}
