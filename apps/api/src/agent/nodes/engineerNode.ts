/**
 * Engineer Node — Audio Analysis
 * Runs in parallel with Historian
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { analyzeAudioPreview, type AudioAnalysisResult } from "../../sources/audio.js";
import { withRetry } from "../errors.js";
import { getCache } from "../../store/cache.js";
import type { SonicAgentStateType, AudioFeatures } from "../state.js";

export async function engineerNode(
  state: SonicAgentStateType,
  config: LangGraphRunnableConfig
): Promise<Partial<SonicAgentStateType>> {
  if (!state.spotifyData) {
    return { statusMessages: ["⚠️ Skipping audio analysis - no track data"] };
  }

  const writer = config.writer;

  // Check persistent audio cache first
  try {
    const cache = getCache();
    const cachedAudio = cache.getAudio(state.spotifyData.id);
    if (cachedAudio) {
      console.log("🎧 [Engineer] Cache hit for:", state.spotifyData.title);
      writer?.({ type: "status", code: "AUDIO-COMPLETE", message: `Audio cache hit: ${cachedAudio.bpm} BPM // ${cachedAudio.key}`, node: "engineer", timestamp: new Date().toISOString() });
      return {
        audioFeatures: cachedAudio,
        statusMessages: [`🎵 Audio (cached): ${cachedAudio.bpm} BPM, ${cachedAudio.key}`],
      };
    }
  } catch {
    // Cache not available — proceed with fresh analysis
  }

  writer?.({ type: "status", code: "AUDIO-INIT", message: "Initializing audio waveform parser...", node: "engineer", timestamp: new Date().toISOString() });

  console.log("🎧 [Engineer] Analyzing:", state.spotifyData.title);

  try {
    // Use real audio analysis via Python microservice (librosa), with retry on transient failures
    const analysisResult = await withRetry(() =>
      analyzeAudioPreview.invoke({
        previewUrl: state.spotifyData!.previewUrl,
        title: state.spotifyData!.title,
        artist: state.spotifyData!.artist,
      })
    );

    const analysis = JSON.parse(analysisResult) as AudioAnalysisResult;

    // Construct full key string (e.g., "C Major")
    const fullKey = analysis.mode ? `${analysis.key} ${analysis.mode}` : analysis.key;

    // Real perceptual features from Essentia (null/undefined when models unavailable)
    const hasEssentiaFeatures = analysis.valence != null && analysis.danceability != null
      && analysis.acousticness != null && analysis.instrumentalness != null;

    // Confidence is "high" only when both librosa and Essentia provide real data
    const confidence = (analysis.source === "analyzed" && hasEssentiaFeatures) ? "high" : "low";

    const audioFeatures: AudioFeatures = {
      bpm: analysis.bpm,
      key: fullKey,
      energy: analysis.energy,
      // Use real Essentia values when available; fall back to energy-based estimation
      valence: analysis.valence ?? (0.5 + Math.random() * 0.3),
      danceability: analysis.danceability ?? (analysis.energy > 0.6 ? 0.6 + Math.random() * 0.3 : 0.4 + Math.random() * 0.2),
      acousticness: analysis.acousticness ?? (analysis.energy < 0.4 ? 0.5 + Math.random() * 0.3 : Math.random() * 0.3),
      instrumentalness: analysis.instrumentalness ?? (Math.random() * 0.2),
      confidence,
      keyMoments: analysis.keyMoments || [],
    };

    // Persist to cache
    try {
      getCache().putAudio(state.spotifyData!.id, audioFeatures);
    } catch {
      // Non-critical — log and continue
    }

    const sourceLabel = analysis.source === "analyzed" ? "verified" : "estimated";
    writer?.({ type: "status", code: "AUDIO-COMPLETE", message: `Frequency analysis (${sourceLabel}): ${audioFeatures.bpm} BPM // ${audioFeatures.key}`, node: "engineer", timestamp: new Date().toISOString() });
    console.log(`✅ [Engineer] Analysis complete (${analysis.source}):`, audioFeatures.bpm, "BPM,", audioFeatures.key);

    return {
      audioFeatures,
      statusMessages: [`🎵 Audio (${analysis.source}): ${audioFeatures.bpm} BPM, ${audioFeatures.key}`],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ [Engineer] Error:", message);
    return {
      audioFeatures: {
        bpm: 120,
        key: "C Major",
        energy: 0.7,
        valence: 0.6,
        danceability: 0.7,
        acousticness: 0.2,
        instrumentalness: 0.1,
        confidence: "low" as const, // Fallback = low confidence
        keyMoments: [], // No key moments for fallback
      },
      statusMessages: ["⚠️ Using fallback audio features"],
    };
  }
}
