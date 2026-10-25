/**
 * Engineer Node — Audio Analysis
 * Runs in parallel with Historian
 *
 * It leaves the audio service's measurement for the composer: the AudioFeatures v2 block as the
 * service sent it, or why there is none (`unavailableReason`). It derives no value itself: the
 * result's copies come from the block in finalize.ts. Nothing is cached without a measurement.
 *
 * The audio cache is read first, by the track's keys and the analyzer version the service reports
 * on /health (store/measuredAudio.ts): a measurement by another analyzer version is a miss, and
 * when the service does not say its version the cache is not read and the track is measured. A
 * measurement with a tempo and a key is cached under `isrc:<ISRC>` when its clip was found by the
 * ISRC, and under `spotify:<id>` otherwise.
 *
 * The clip is a preview of the chosen recording only (sources/audio.ts resolvePreview). The node
 * writes it for the player (`previewUrl`, for this run only: it is signed and expires), and how
 * the measured clip was matched (`preview`, only when something was measured). On a cache hit a
 * fresh clip is looked up for the player, and `preview` still describes the clip the cached
 * values were measured on: both are clips of the chosen recording, not always the same entry.
 * Without a clip the player has none, never another recording's clip. When Deezer could not be
 * read, that is recorded as a source error, apart from "no clip".
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  analyzeAudioPreview,
  type AudioAnalysisResult,
  audioServiceVersion,
  isAllowedPreviewUrl,
  type PreviewLookupError,
  type PreviewSourceMatch,
  resolvePreview,
  type TrackPreviewRequest,
} from "../../sources/audio.js";
import { type CachedAudio, getCache, type SonicCache } from "../../store/cache.js";
import { audioLookupKeys, audioTrackKey } from "../../store/measuredAudio.js";
import type { AudioMeasurement, AudioUnavailableReason, SonicAgentStateType } from "../state.js";
import { isAbortError } from "../errors.js";
import { measuredAudioFields } from "../finalize.js";
import { type AgentRuntime, defaultAgentRuntime, timestampOf } from "../runtime.js";
import { logger } from "../../logger.js";

const log = logger("Engineer");

function unavailableMeasurement(reason: AudioUnavailableReason, detail?: string): AudioMeasurement {
  return {
    audio: null,
    unavailableReason: reason,
    ...(detail ? { unavailableDetail: detail } : {}),
  };
}

/**
 * The measurement in an analysis result: the service's v2 block with how its clip was matched,
 * or the reason there is none. Nothing else of the result is read.
 */
export function toAudioMeasurement(analysis: AudioAnalysisResult): AudioMeasurement {
  if (analysis.source !== "analyzed" || !analysis.audio) {
    return unavailableMeasurement(
      analysis.reason ?? "analysis_failed",
      analysis.error ?? (analysis.source === "analyzed" ? "The analysis carried no v2 block" : ""),
    );
  }
  return {
    audio: analysis.audio,
    ...(analysis.previewMatch ? { previewMatch: analysis.previewMatch } : {}),
    ...(analysis.outOfRange?.length ? { outOfRange: analysis.outOfRange } : {}),
  };
}

/** What a measurement says, for status lines: "116 BPM // D Minor" or what is missing. */
function measuredSummary(measurement: AudioMeasurement): {
  measured: boolean;
  text: string;
  complete: boolean;
} {
  const fields = measuredAudioFields(measurement);
  if (fields.audioSource === "analyzed") {
    return {
      measured: true,
      text: `${fields.bpm} BPM // ${fields.key}`,
      complete: fields.audioConfidence === "high",
    };
  }
  const reason = fields.audioUnavailableReason ?? "not_run";
  const audio = fields.audio;
  if (audio && !audio.gate.passed) {
    return {
      measured: false,
      text: `The analysis measured nothing on the preview (${audio.gate.reason ?? "gate"}) (${reason})`,
      complete: false,
    };
  }
  if (audio) {
    const missing = [!audio.tempo && "tempo", !audio.key && "key"].filter(Boolean).join(" and ");
    return {
      measured: false,
      text: `The analysis found no ${missing} (${reason})`,
      complete: false,
    };
  }
  return {
    measured: false,
    text: `Audio not measured (${reason}): BPM and key unavailable`,
    complete: false,
  };
}

/**
 * How a clip was matched, in the result's terms (the contract's PreviewMatch):
 * - the Deezer entry for the ISRC, or an entry read by id that carries the requested ISRC and
 *   passed the same checks: `isrc`;
 * - a Deezer entry read by id that does not carry it and matched strictly: `id`, with its score;
 * - a strict search match: `search`, with its score;
 * - Spotify's own clip of the chosen track: `{spotify, id}`, no score.
 */
export function previewProvenance(
  match: PreviewSourceMatch | null | undefined,
): SonicAgentStateType["preview"] {
  if (!match) return null;
  if (match.provider === "spotify") return { provider: "spotify", method: "id", score: null };
  if (match.method === "isrc" || (match.method === "id" && match.score === null)) {
    return { provider: "deezer", method: "isrc", score: null };
  }
  return { provider: "deezer", method: match.method, score: match.score };
}

/** Deezer's failure while the clip was looked up, as the run's source error. */
function lookupErrors(error: PreviewLookupError | undefined): Partial<SonicAgentStateType> {
  return error
    ? { sourceErrors: [{ source: error.source, code: error.code, message: error.message }] }
    : {};
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

export async function engineerNode(
  state: SonicAgentStateType,
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime = defaultAgentRuntime,
): Promise<Partial<SonicAgentStateType>> {
  if (!state.spotifyData) {
    return { statusMessages: ["⚠️ Skipping audio analysis - no track data"] };
  }

  const writer = config.writer;
  const track = state.spotifyData;
  const request = previewRequest(state);

  // The audio cache first, by the track's keys and the analyzer version the service reports.
  // Without that version (the service does not answer) the cache is not read: a measurement of
  // another version must not be served.
  let cache: SonicCache | null = null;
  try {
    cache = getCache();
  } catch {
    // Cache not available — proceed with fresh analysis
  }
  let cached: CachedAudio | null = null;
  if (cache) {
    const version = await audioServiceVersion(config.signal);
    if (version) cached = cache.getAudio(audioLookupKeys(track.id, request.isrc), version);
    else log.info("The audio service did not say its analyzer version; the cache is not read");
  }
  if (cached) {
    const summary = measuredSummary(cached).text;
    log.info(`Cache hit for: ${track.title}`);
    writer?.({
      type: "status",
      code: "AUDIO-COMPLETE",
      message: `Audio cache hit: ${summary}`,
      node: "engineer",
      timestamp: timestampOf(runtime),
    });
    // The cache keeps no clip URL (they expire): the player gets a fresh clip or none.
    let previewUrl: string | null = null;
    let lookupError: PreviewLookupError | undefined;
    try {
      const fresh = await resolvePreview(request, config.signal);
      previewUrl =
        fresh.previewUrl && isAllowedPreviewUrl(fresh.previewUrl) ? fresh.previewUrl : null;
      lookupError = fresh.sourceError;
    } catch (error) {
      if (config.signal?.aborted || isAbortError(error)) throw error;
      log.warn("Could not look up a preview", { err: error });
    }
    return {
      audioFeatures: cached,
      preview: previewProvenance(cached.previewMatch),
      previewUrl,
      ...lookupErrors(lookupError),
      statusMessages: [`🎵 Audio (cached): ${summary.replace(" // ", ", ")}`],
    };
  }

  writer?.({
    type: "status",
    code: "AUDIO-INIT",
    message: "Initializing audio waveform parser...",
    node: "engineer",
    timestamp: timestampOf(runtime),
  });

  log.info(`Analyzing: ${track.title}`);

  let measurement: AudioMeasurement;
  let analysis: AudioAnalysisResult | null = null;
  try {
    // analyzeAudioPreview reports failures in its result (source "unavailable") instead of throwing.
    // The run's abort signal stops the analysis when the client leaves.
    config.signal?.throwIfAborted();
    const { spotifyPreviewUrl, ...trackRequest } = request;
    const analysisResult = await analyzeAudioPreview.invoke(
      { ...trackRequest, previewUrl: spotifyPreviewUrl },
      { signal: config.signal },
    );
    analysis = JSON.parse(analysisResult) as AudioAnalysisResult;
    measurement = toAudioMeasurement(analysis);
  } catch (error) {
    if (config.signal?.aborted || isAbortError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    log.error(`Error: ${message}`);
    measurement = unavailableMeasurement("analysis_failed", message);
  }
  // The clip for the player, and how it was matched when the service measured it.
  const previewOut = {
    preview: measurement.audio ? previewProvenance(measurement.previewMatch) : null,
    previewUrl: analysis?.previewUrl ?? null,
    ...lookupErrors(analysis?.previewSourceError),
  };

  const summary = measuredSummary(measurement);
  if (!summary.measured) {
    writer?.({
      type: "status",
      code: "AUDIO-ERROR",
      message: summary.text,
      node: "engineer",
      timestamp: timestampOf(runtime),
    });
    log.info(summary.text);
    return {
      audioFeatures: measurement,
      ...previewOut,
      statusMessages: [`⚠️ ${summary.text}`],
    };
  }

  // Only measurements with a tempo and a key are cached, under the key their clip's match
  // allows. A failed write is logged and the run continues; nothing reports the result as
  // cached. Nothing is cached for a cancelled run.
  config.signal?.throwIfAborted();
  if (cache && measurement.previewMatch) {
    try {
      cache.putAudio(
        audioTrackKey(measurement.previewMatch, track.id, request.isrc),
        track.id,
        measurement,
      );
    } catch (error) {
      log.warn("Could not cache audio", { err: error });
    }
  }

  const partial = summary.complete ? "" : " (some perceptual features not measured)";
  writer?.({
    type: "status",
    code: "AUDIO-COMPLETE",
    message: `Frequency analysis: ${summary.text}${partial}`,
    node: "engineer",
    timestamp: timestampOf(runtime),
  });
  log.info(`Analysis complete: ${summary.text}`);

  return {
    audioFeatures: measurement,
    ...previewOut,
    statusMessages: [`🎵 Audio (measured): ${summary.text.replace(" // ", ", ")}`],
  };
}
