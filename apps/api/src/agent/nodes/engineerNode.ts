/**
 * Engineer Node — Audio Analysis
 * Runs in parallel with Historian
 *
 * Every value it returns is measured by the audio analysis service or null. When no
 * measurement is possible the features carry `unavailableReason`, and nothing is cached.
 * Cached rows are only reused when they carry the `measured` marker and say how the measured
 * clip was matched to the track; older rows are measured again.
 *
 * The clip is a preview of the chosen recording only (sources/audio.ts resolvePreview). The node
 * writes it for the player (`previewUrl`, for this run only: it is signed and expires) and how
 * it was matched (`preview`). On a cache hit a fresh clip is looked up for the player; without
 * one the player has none, never another recording's clip.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  analyzeAudioPreview,
  type AudioAnalysisResult,
  isAllowedPreviewUrl,
  type PreviewSourceMatch,
  resolvePreview,
  type TrackPreviewRequest,
} from "../../sources/audio.js";
import { getCache } from "../../store/cache.js";
import type { SonicAgentStateType, AudioFeatures, AudioUnavailableReason } from "../state.js";
import { isAbortError } from "../errors.js";
import { type AgentRuntime, defaultAgentRuntime, timestampOf } from "../runtime.js";

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

  // A key is a pitch class plus a mode; with either missing there is no key.
  const key = analysis.key && analysis.mode ? `${analysis.key} ${analysis.mode}` : null;
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
    ...(analysis.outOfRange?.length ? { outOfRange: analysis.outOfRange } : {}),
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
    ...(analysis.previewMatch ? { previewMatch: analysis.previewMatch } : {}),
  };
}

/**
 * How a clip was matched, in the result's terms (the contract's PreviewMatch). A Deezer entry
 * read by id is reported as an ISRC match when it carries the requested ISRC, else as a search
 * match with its score. Spotify's own clip of the chosen track needed no matching; the contract
 * has no method for it, so it is reported as null (unknown), never as an ISRC or search match.
 */
export function previewProvenance(
  match: PreviewSourceMatch | null | undefined,
): SonicAgentStateType["preview"] {
  if (match?.provider !== "deezer") return null;
  if (match.method === "search" || (match.method === "id" && match.score !== null)) {
    return { provider: "deezer", method: "search", score: match.score };
  }
  return { provider: "deezer", method: "isrc", score: null };
}

/** The chosen track, as resolvePreview needs it. */
function previewRequest(state: SonicAgentStateType): TrackPreviewRequest {
  const track = state.spotifyData;
  return {
    title: track?.title ?? "",
    artist: track?.artist ?? "",
    ...(track?.artistNames?.length ? { artistNames: track.artistNames } : {}),
    ...(track?.album ? { album: track.album } : {}),
    isrc: state.isrc ?? track?.isrc ?? null,
    durationMs: track?.durationMs ?? null,
    spotifyPreviewUrl: track?.previewUrl ?? null,
  };
}

/** True for a cached row this code wrote from a measurement of a matched clip. */
function isTrustedCacheRow(row: AudioFeatures | null | undefined): row is AudioFeatures {
  return (
    row?.measured === true &&
    typeof row.previewMatch?.provider === "string" &&
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
  runtime: AgentRuntime = defaultAgentRuntime,
): Promise<Partial<SonicAgentStateType>> {
  if (!state.spotifyData) {
    return { statusMessages: ["⚠️ Skipping audio analysis - no track data"] };
  }

  const writer = config.writer;

  // Check persistent audio cache first. Rows without the measured marker are ignored.
  let cachedAudio: AudioFeatures | null = null;
  try {
    cachedAudio = getCache().getAudio(state.spotifyData.id);
  } catch {
    // Cache not available — proceed with fresh analysis
  }
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
      timestamp: timestampOf(runtime),
    });
    // The cache keeps no clip URL (they expire): the player gets a fresh clip or none.
    let previewUrl: string | null = null;
    try {
      const fresh = (await resolvePreview(previewRequest(state), config.signal)).previewUrl;
      previewUrl = fresh && isAllowedPreviewUrl(fresh) ? fresh : null;
    } catch (error) {
      if (config.signal?.aborted || isAbortError(error)) throw error;
      console.warn("⚠️ [Engineer] Could not look up a preview:", error);
    }
    return {
      audioFeatures: cachedAudio,
      preview: previewProvenance(cachedAudio.previewMatch),
      previewUrl,
      statusMessages: [`🎵 Audio (cached): ${cachedAudio.bpm} BPM, ${cachedAudio.key}`],
    };
  }

  writer?.({
    type: "status",
    code: "AUDIO-INIT",
    message: "Initializing audio waveform parser...",
    node: "engineer",
    timestamp: timestampOf(runtime),
  });

  console.log("🎧 [Engineer] Analyzing:", state.spotifyData.title);

  let audioFeatures: AudioFeatures;
  let analysis: AudioAnalysisResult | null = null;
  try {
    // analyzeAudioPreview reports failures in its result (source "unavailable") instead of throwing.
    // The run's abort signal stops the analysis when the client leaves.
    config.signal?.throwIfAborted();
    const { spotifyPreviewUrl, ...track } = previewRequest(state);
    const analysisResult = await analyzeAudioPreview.invoke(
      { ...track, previewUrl: spotifyPreviewUrl },
      { signal: config.signal },
    );
    analysis = JSON.parse(analysisResult) as AudioAnalysisResult;
    audioFeatures = toAudioFeatures(analysis);
  } catch (error) {
    if (config.signal?.aborted || isAbortError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    console.error("❌ [Engineer] Error:", message);
    audioFeatures = unavailableFeatures("analysis_failed", message);
  }
  // The clip measured (or tried), for the player, and how it was matched.
  const previewOut = {
    preview: previewProvenance(analysis?.previewMatch),
    previewUrl: analysis?.previewUrl ?? null,
  };

  if (audioFeatures.unavailableReason) {
    const reason = audioFeatures.unavailableReason;
    // Say what is missing: "not_detected" can leave a measured tempo without a key, or the
    // reverse; the other reasons mean nothing was measured.
    const summary =
      reason === "not_detected"
        ? `${audioFeatures.unavailableDetail ?? "The analysis found no tempo or key"} (${reason})`
        : `Audio not measured (${reason}): BPM and key unavailable`;
    writer?.({
      type: "status",
      code: "AUDIO-ERROR",
      message: summary,
      node: "engineer",
      timestamp: timestampOf(runtime),
    });
    console.log(`⚠️ [Engineer] ${summary}`);
    return {
      audioFeatures,
      ...previewOut,
      statusMessages: [`⚠️ ${summary}`],
    };
  }

  // Only measurements are cached. A failed write (e.g. a column that does not accept null
  // energy yet) is logged and the run continues; nothing reports the result as cached.
  // Nothing is cached for a cancelled run.
  config.signal?.throwIfAborted();
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
    timestamp: timestampOf(runtime),
  });
  console.log("✅ [Engineer] Analysis complete:", audioFeatures.bpm, "BPM,", audioFeatures.key);

  return {
    audioFeatures,
    ...previewOut,
    statusMessages: [`🎵 Audio (measured): ${audioFeatures.bpm} BPM, ${audioFeatures.key}`],
  };
}
