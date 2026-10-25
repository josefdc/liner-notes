/**
 * Engineer Node — Audio Analysis
 * Runs in parallel with Historian
 *
 * It leaves the audio service's measurement for the composer: the AudioFeatures v2 block as the
 * service sent it, or why there is none (`unavailableReason`). It derives no value itself: the
 * result's copies come from the block in finalize.ts. Nothing is cached without a measurement.
 *
 * The run probes the service's /health once and resolves the chosen track's preview once, and
 * passes both to the analysis. The audio cache is then read by the track's keys and the analyzer
 * version /health names (store/measuredAudio.ts): a measurement by another version is a miss and
 * the track is measured again. When the service does not answer or names no version, the newest
 * cached measurement is served, saying which analyzer made it and when. An `isrc:` row is served
 * only when this run's own preview resolution accepted the same Deezer entry by ISRC. A
 * measurement with a tempo and a key is cached under `isrc:<ISRC>` when its clip was the Deezer
 * entry found by the ISRC, and under `spotify:<id>` otherwise.
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
  type AudioRunContext,
  type AudioServiceHealth,
  audioServiceHealth,
  isAllowedPreviewUrl,
  type PreviewLookupError,
  type PreviewResolution,
  type PreviewSourceMatch,
  resolvePreview,
  type TrackPreviewRequest,
} from "../../sources/audio.js";
import { type CachedAudio, getCache, type SonicCache } from "../../store/cache.js";
import {
  audioConfidence,
  audioLookupKeys,
  audioTrackKey,
  isrcRowServes,
} from "../../store/measuredAudio.js";
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

/** A cached measurement the run serves. */
interface CacheHit {
  measurement: CachedAudio;
  /**
   * Set when the service did not say its analyzer version: the newest row was served, and the
   * run says so, with the analyzer that made it and when.
   */
  unversioned?: { reason: string; measuredAt: Date };
}

/**
 * The cached measurement this run serves, or null to measure:
 * - the service names its analyzer version: the rows of that version under the track's keys;
 * - it does not answer, or names no version: the newest row under each key, of any version (its
 *   block and the result's run.analyzerVersion name the analyzer that made it; no version is
 *   made up);
 * an `isrc:` row only when this run's own preview resolution accepted the same Deezer entry by
 * ISRC (measuredAudio.ts isrcRowServes). Of the rows left, a complete one is preferred, then the
 * ISRC's: a partial `isrc:` row never hides a complete row of the track's own.
 */
function cachedMeasurement(
  cache: SonicCache,
  spotifyId: string,
  isrc: string | null | undefined,
  health: AudioServiceHealth | null,
  fresh: PreviewResolution,
): CacheHit | null {
  const version = health?.analyzerVersion ?? null;
  const reason = health
    ? "The audio service did not name its analyzer version."
    : "The audio service is unavailable.";
  const hits = audioLookupKeys(spotifyId, isrc).flatMap((key): CacheHit[] => {
    let hit: CacheHit | null = null;
    if (version) {
      const measurement = cache.getAudio(key, version);
      hit = measurement ? { measurement } : null;
    } else {
      const newest = cache.getNewestAudio(key);
      hit = newest
        ? {
            measurement: newest.measurement,
            unversioned: { reason, measuredAt: newest.measuredAt },
          }
        : null;
    }
    return hit && isrcRowServes(key, hit.measurement, fresh.match) ? [hit] : [];
  });
  return hits.find((hit) => audioConfidence(hit.measurement) === "high") ?? hits[0] ?? null;
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

  // What the run asks once: the service's health (its analyzer version) and the chosen track's
  // preview. Both are passed on to the analysis, so neither is asked twice.
  const health = await audioServiceHealth(config.signal);
  const fresh = await resolvePreview(request, config.signal);

  let cache: SonicCache | null = null;
  try {
    cache = getCache();
  } catch {
    // Cache not available — proceed with fresh analysis
  }
  const hit = cache ? cachedMeasurement(cache, track.id, request.isrc, health, fresh) : null;
  if (hit) {
    const summary = measuredSummary(hit.measurement).text;
    // When the service cannot say its version, the newest measurement is served, and the run
    // says which analyzer made it and when.
    const old = hit.unversioned;
    const served = old
      ? `${old.reason} Showing the measurement by analyzer ${hit.measurement.audio.analyzerVersion} from ${old.measuredAt.toISOString().slice(0, 10)}: ${summary}`
      : `Audio cache hit: ${summary}`;
    log.info(`Cache hit for: ${track.title}${old ? " (service version unknown)" : ""}`);
    writer?.({
      type: "status",
      code: "AUDIO-COMPLETE",
      message: served,
      node: "engineer",
      timestamp: timestampOf(runtime),
    });
    // The cache keeps no clip URL (they expire): the player gets this run's clip or none.
    return {
      audioFeatures: hit.measurement,
      preview: previewProvenance(hit.measurement.previewMatch),
      previewUrl:
        fresh.previewUrl && isAllowedPreviewUrl(fresh.previewUrl) ? fresh.previewUrl : null,
      ...lookupErrors(fresh.sourceError),
      statusMessages: [
        old
          ? `⚠️ ${served.replace(" // ", ", ")}`
          : `🎵 Audio (cached): ${summary.replace(" // ", ", ")}`,
      ],
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
    const audioRun: AudioRunContext = { preview: fresh, serviceAvailable: health !== null };
    const analysisResult = await analyzeAudioPreview.invoke(
      { ...trackRequest, previewUrl: spotifyPreviewUrl },
      { signal: config.signal, configurable: { audioRun } },
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
