/**
 * Engineer Node — Audio Analysis
 * Runs in parallel with Historian
 *
 * Every value it returns is measured by the audio analysis service or null. When no
 * measurement is possible the features carry `unavailableReason`, and nothing is cached.
 * Cached rows are only reused when they carry the `measured` marker; rows written before
 * estimates were removed have none and are measured again.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { analyzeAudioPreview, type AudioAnalysisResult } from "../../sources/audio.js";
import { getCache } from "../../store/cache.js";
import type { SonicAgentStateType, AudioFeatures, AudioUnavailableReason } from "../state.js";

function unavailableFeatures(reason: AudioUnavailableReason, detail?: string): AudioFeatures {
  return {
    bpm: null,
    key: null,
    energy: null,
    valence: null,
    danceability: null,
    acousticness: null,
    instrumentalness: null,
    confidence: "low",
    keyMoments: [],
    unavailableReason: reason,
    unavailableDetail: detail,
  };
}

/** Builds AudioFeatures from an analysis result, keeping only measured values. */
export function toAudioFeatures(analysis: AudioAnalysisResult): AudioFeatures {
  if (analysis.source !== "analyzed") {
    return unavailableFeatures(analysis.reason ?? "analysis_failed", analysis.error);
  }

  const key = analysis.key
    ? analysis.mode
      ? `${analysis.key} ${analysis.mode}`
      : analysis.key
    : null;
  const features: AudioFeatures = {
    bpm: analysis.bpm ?? null,
    key,
    energy: analysis.energy ?? null,
    valence: analysis.valence ?? null,
    danceability: analysis.danceability ?? null,
    acousticness: analysis.acousticness ?? null,
    instrumentalness: analysis.instrumentalness ?? null,
    confidence: "low",
    keyMoments: analysis.keyMoments || [],
  };

  if (features.bpm == null || features.key == null) {
    const missing = [features.bpm == null && "tempo", features.key == null && "key"]
      .filter(Boolean)
      .join(" and ");
    return {
      ...features,
      unavailableReason: "not_detected",
      unavailableDetail: `The analysis found no ${missing}`,
    };
  }

  const complete =
    features.energy != null &&
    features.valence != null &&
    features.danceability != null &&
    features.acousticness != null &&
    features.instrumentalness != null;
  return {
    ...features,
    confidence: complete ? "high" : "low",
    measured: true,
    analyzer: "audio-service",
  };
}

/** True for a cached row this code wrote from a measurement. */
function isTrustedCacheRow(row: AudioFeatures | null | undefined): row is AudioFeatures {
  return (
    row?.measured === true &&
    row.analyzer === "audio-service" &&
    typeof row.bpm === "number" &&
    row.bpm > 0 &&
    typeof row.key === "string" &&
    row.key !== ""
  );
}

export async function engineerNode(
  state: SonicAgentStateType,
  config: LangGraphRunnableConfig,
): Promise<Partial<SonicAgentStateType>> {
  if (!state.spotifyData) {
    return { statusMessages: ["⚠️ Skipping audio analysis - no track data"] };
  }

  const writer = config.writer;

  // Check persistent audio cache first. Rows without the measured marker are ignored.
  try {
    const cache = getCache();
    const cachedAudio = cache.getAudio(state.spotifyData.id);
    if (cachedAudio && !isTrustedCacheRow(cachedAudio)) {
      console.log("🎧 [Engineer] Ignoring unmarked cached audio for:", state.spotifyData.title);
    }
    if (isTrustedCacheRow(cachedAudio)) {
      console.log("🎧 [Engineer] Cache hit for:", state.spotifyData.title);
      writer?.({
        type: "status",
        code: "AUDIO-COMPLETE",
        message: `Audio cache hit: ${cachedAudio.bpm} BPM // ${cachedAudio.key}`,
        node: "engineer",
        timestamp: new Date().toISOString(),
      });
      return {
        audioFeatures: cachedAudio,
        statusMessages: [`🎵 Audio (cached): ${cachedAudio.bpm} BPM, ${cachedAudio.key}`],
      };
    }
  } catch {
    // Cache not available — proceed with fresh analysis
  }

  writer?.({
    type: "status",
    code: "AUDIO-INIT",
    message: "Initializing audio waveform parser...",
    node: "engineer",
    timestamp: new Date().toISOString(),
  });

  console.log("🎧 [Engineer] Analyzing:", state.spotifyData.title);

  let audioFeatures: AudioFeatures;
  try {
    // analyzeAudioPreview reports failures in its result (source "unavailable") instead of throwing.
    const analysisResult = await analyzeAudioPreview.invoke({
      previewUrl: state.spotifyData.previewUrl,
      title: state.spotifyData.title,
      artist: state.spotifyData.artist,
    });
    audioFeatures = toAudioFeatures(JSON.parse(analysisResult) as AudioAnalysisResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("❌ [Engineer] Error:", message);
    audioFeatures = unavailableFeatures("analysis_failed", message);
  }

  if (audioFeatures.unavailableReason) {
    const reason = audioFeatures.unavailableReason;
    writer?.({
      type: "status",
      code: "AUDIO-ERROR",
      message: `Audio not measured (${reason}): BPM and key unavailable`,
      node: "engineer",
      timestamp: new Date().toISOString(),
    });
    console.log(`⚠️ [Engineer] Audio not measured: ${reason}`);
    return {
      audioFeatures,
      statusMessages: [`⚠️ Audio not measured (${reason})`],
    };
  }

  // Only measurements are cached. A failed write (e.g. a column that does not accept null
  // energy yet) is logged and the run continues; nothing reports the result as cached.
  try {
    getCache().putAudio(state.spotifyData.id, audioFeatures);
  } catch (error) {
    console.warn("⚠️ [Engineer] Could not cache audio:", error);
  }

  const partial =
    audioFeatures.confidence === "high" ? "" : " (some perceptual features not measured)";
  writer?.({
    type: "status",
    code: "AUDIO-COMPLETE",
    message: `Frequency analysis: ${audioFeatures.bpm} BPM // ${audioFeatures.key}${partial}`,
    node: "engineer",
    timestamp: new Date().toISOString(),
  });
  console.log("✅ [Engineer] Analysis complete:", audioFeatures.bpm, "BPM,", audioFeatures.key);

  return {
    audioFeatures,
    statusMessages: [`🎵 Audio (measured): ${audioFeatures.bpm} BPM, ${audioFeatures.key}`],
  };
}
