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
 * cached measurement this track may be served is served, saying which analyzer made it and when,
 * and the result is not stored. A measurement with a tempo and a key is cached under the track's
 * own `spotify:<id>`, and also under `isrc:<ISRC>:<Deezer id>` when its clip was a Deezer entry
 * taken by the ISRC; another track is served that row only when its own preview resolution took
 * the same entry by ISRC this run.
 *
 * The clip is a preview of the chosen recording only (sources/audio.ts resolvePreview). The node
 * writes it for the player (`previewUrl`, for this run only: it is signed and expires), and how
 * the measured clip was matched (`preview`, only when something was measured). On a cache hit a
 * fresh clip is looked up for the player, and `preview` still describes the clip the cached
 * values were measured on: both are clips of the chosen recording, not always the same entry.
 * Without a clip the player has none, never another recording's clip. "No clip" (`no_preview`) is
 * said only when Deezer answered every request of the lookup. When there is no clip and the
 * lookup could not be finished (Deezer could not be read, which is also recorded as a source
 * error, or a request had no slot of its pace in time and was not sent), nothing is measured,
 * the reason is `preview_lookup_incomplete`, and the result is not stored (composerNode.ts). A
 * cached measurement, or one of Spotify's own clip, is still served when the lookup is unfinished.
 */

import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  AUDIO_TEMPO_RANGE_BPM,
  type AudioGateReason,
  type AudioUnavailableReason as ResultUnavailableReason,
  type AudioWithheldCode,
} from "@liner-notes/contract";
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
  audioTrackKeys,
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

/** Why audio was not measured at all, in words, by the engineer's reason code. */
const UNMEASURED_TEXT: Record<ResultUnavailableReason, string> = {
  no_preview: "no preview clip of this recording was found",
  preview_rejected: "the preview clip is not on an audio host the analysis accepts",
  service_unavailable: "the audio service is unavailable",
  analysis_failed: "the analysis failed",
  not_detected: "not detected",
  not_run: "the analysis did not run",
  low_confidence: "the estimate was not confident enough",
  preview_lookup_incomplete:
    "the preview lookup on Deezer could not be finished; a later analysis tries again",
};

/** What the service's gate means, for a block that carries no reason of its own. */
const GATE_TEXT: Record<AudioGateReason, string> = {
  silence: "the preview is silent",
  noise: "no beat and no musical pitch in the preview",
  too_short: "the preview is too short to measure",
};

/**
 * Why the service withheld a value, in this app's words for its code (the contract's
 * AudioWithheldCode): the check that fired, never the value. The service's own `reason` text
 * is for logs and tools, and is not shown.
 */
const WITHHELD_TEXT: Record<AudioWithheldCode, string> = {
  gate_silence: GATE_TEXT.silence,
  gate_noise: GATE_TEXT.noise,
  gate_too_short: GATE_TEXT.too_short,
  no_beat: "no repeating beat",
  tempo_out_of_range: `outside the ${AUDIO_TEMPO_RANGE_BPM[0]}–${AUDIO_TEMPO_RANGE_BPM[1]} BPM the analysis accepts`,
  too_few_beats: "too few beats to measure a steady tempo",
  low_confidence: "the estimate was below the confidence needed",
  unsteady_tempo: "the tempo does not hold across the preview",
  no_tempo_estimate: "the tempo estimator gave no tempo",
  no_sustained_pitch: "too little sustained pitch",
  speech_like: "one pitch line without stable notes",
  one_harmonic_series: "one harmonic series dominates",
  one_held_pitch: "one held pitch dominates",
  no_pitch_track: "the pitch could not be tracked",
  few_pitch_classes: "fewer than three pitch classes",
  one_pitched_source: "one pitched source, not a key",
  low_key_strength: "the key estimate was too weak",
  no_key_estimate: "the key estimator named no key",
  models_not_loaded: "the audio models are not loaded",
  not_music: "the preview does not read as music",
  model_failed: "the audio model gave no usable output",
  out_of_range: "outside the range its model produces",
  non_music_style: "the strongest style is a non-music one",
  estimate_failed: "the estimator failed on this preview",
};

/** A withheld reason in words; "not detected" when the block gives none for the field. */
const withheldText = (reason: { code: AudioWithheldCode } | undefined) =>
  reason ? (WITHHELD_TEXT[reason.code] ?? "the analysis withheld it") : "not detected";

/**
 * What a measurement says, for status lines: "116 BPM, D Minor", or what is missing and why.
 * A tempo or key the service withheld is named with the reason for that field
 * (`audio.withheld`), in this app's words; "not detected" only when the block gives no reason.
 */
function measuredSummary(measurement: AudioMeasurement): {
  measured: boolean;
  text: string;
  complete: boolean;
} {
  const fields = measuredAudioFields(measurement);
  if (fields.audioSource === "analyzed") {
    return {
      measured: true,
      text: `${fields.bpm} BPM, ${fields.key}`,
      complete: fields.audioConfidence === "high",
    };
  }
  const audio = fields.audio;
  if (audio && !audio.gate.passed) {
    const why = audio.withheld?.tempo
      ? withheldText(audio.withheld.tempo)
      : audio.gate.reason
        ? GATE_TEXT[audio.gate.reason]
        : "the preview did not pass the checks";
    return { measured: false, text: `Nothing measured on the preview: ${why}`, complete: false };
  }
  if (audio) {
    const why = (field: "tempo" | "key") => withheldText(audio.withheld?.[field]);
    const parts = [
      fields.bpm !== null ? `Measured ${fields.bpm} BPM` : `Tempo not given: ${why("tempo")}`,
      fields.key !== null ? `measured ${fields.key}` : `key not given: ${why("key")}`,
    ];
    return { measured: false, text: parts.join("; "), complete: false };
  }
  const reason = fields.audioUnavailableReason ?? "not_run";
  return {
    measured: false,
    text: `Tempo and key not measured: ${UNMEASURED_TEXT[reason]}`,
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

/**
 * " by analyzer 2.1.0 from 2026-10-20": the analyzer's version without its build and model ids,
 * and the date only when it is known.
 */
function unversionedFrom(analyzerVersion: string, measuredAt: Date): string {
  const version = analyzerVersion.split("+")[0];
  const known = Number.isFinite(measuredAt.getTime()) && measuredAt.getTime() > 0;
  return ` by analyzer ${version}${known ? ` from ${measuredAt.toISOString().slice(0, 10)}` : ""}`;
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
 * The cached measurement this run serves, or null to measure. The track is looked up under its
 * own `spotify:` key and under the `isrc:` key of the Deezer entry this run's own preview
 * resolution took by ISRC, if any (measuredAudio.ts audioLookupKeys; isrcRowServes checks the
 * row's entry again):
 * - the service names its analyzer version: the rows of that version; a complete one is
 *   preferred, then the ISRC's, so a partial `isrc:` row never hides a complete row of the
 *   track's own;
 * - it does not answer, or names no version: the newest of the rows this track may be served,
 *   of any version (its block and the result's run.analyzerVersion name the analyzer that made
 *   it; no version is made up).
 */
function cachedMeasurement(
  cache: SonicCache,
  spotifyId: string,
  isrc: string | null | undefined,
  health: AudioServiceHealth | null,
  fresh: PreviewResolution,
): CacheHit | null {
  const version = health?.analyzerVersion ?? null;
  const keys = audioLookupKeys(spotifyId, isrc, fresh.match);
  if (version) {
    const hits = keys.flatMap((key): CacheHit[] => {
      const measurement = cache.getAudio(key, version);
      return measurement && isrcRowServes(key, measurement, fresh.match) ? [{ measurement }] : [];
    });
    return hits.find((hit) => audioConfidence(hit.measurement) === "high") ?? hits[0] ?? null;
  }
  const reason = health
    ? "The audio service did not name its analyzer version."
    : "The audio service is unavailable.";
  const newest = keys
    .flatMap((key) => {
      const found = cache.getNewestAudio(key);
      return found && isrcRowServes(key, found.measurement, fresh.match) ? [found] : [];
    })
    .sort((a, b) => b.measuredAt.getTime() - a.measuredAt.getTime())[0];
  return newest
    ? { measurement: newest.measurement, unversioned: { reason, measuredAt: newest.measuredAt } }
    : null;
}

export async function engineerNode(
  state: SonicAgentStateType,
  config: LangGraphRunnableConfig,
  runtime: AgentRuntime = defaultAgentRuntime,
): Promise<Partial<SonicAgentStateType>> {
  if (!state.spotifyData) {
    return { statusMessages: ["Audio not measured: no track was chosen"] };
  }

  const writer = config.writer;
  const track = state.spotifyData;
  const request = previewRequest(state);

  // What the run asks once: the service's health (its analyzer version) and the chosen track's
  // preview. Both are passed on to the analysis, so neither is asked twice.
  const [health, fresh] = await Promise.all([
    audioServiceHealth(config.signal),
    resolvePreview(request, config.signal),
  ]);

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
      ? `${old.reason} Showing an earlier measurement${unversionedFrom(hit.measurement.audio.analyzerVersion, old.measuredAt)}: ${summary}`
      : `Measured in an earlier run: ${summary}`;
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
      // A measurement served without the service's version is marked, so the result built on
      // it is not stored (composerNode.ts) and the note above is never lost.
      audioFeatures: old ? { ...hit.measurement, servedUnversioned: true } : hit.measurement,
      preview: previewProvenance(hit.measurement.previewMatch),
      previewUrl:
        fresh.previewUrl && isAllowedPreviewUrl(fresh.previewUrl) ? fresh.previewUrl : null,
      ...lookupErrors(fresh.sourceError),
      statusMessages: [served],
    };
  }

  // Said only when a measurement is attempted: a clip the service accepts, and a service that
  // answered its health probe. Otherwise the next line says why nothing was measured.
  if (health !== null && fresh.previewUrl && isAllowedPreviewUrl(fresh.previewUrl)) {
    writer?.({
      type: "status",
      code: "AUDIO-INIT",
      message: "Measuring tempo and key from the preview clip",
      node: "engineer",
      timestamp: timestampOf(runtime),
    });
  }

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
      statusMessages: [summary.text],
    };
  }

  // Only measurements with a tempo and a key are cached: under the track's own key, and under
  // the key of the Deezer entry when the clip was taken by ISRC. A failed write is logged and the
  // run continues; nothing reports the result as cached. Nothing is cached for a cancelled run.
  config.signal?.throwIfAborted();
  if (cache && measurement.previewMatch) {
    try {
      for (const key of audioTrackKeys(measurement.previewMatch, track.id, request.isrc)) {
        cache.putAudio(key, track.id, measurement);
      }
    } catch (error) {
      log.warn("Could not cache audio", { err: error });
    }
  }

  const partial = summary.complete ? "" : " (some perceptual features not measured)";
  const measured = `Measured from the preview: ${summary.text}${partial}`;
  writer?.({
    type: "status",
    code: "AUDIO-COMPLETE",
    message: measured,
    node: "engineer",
    timestamp: timestampOf(runtime),
  });
  log.info(`Analysis complete: ${summary.text}`);

  return {
    audioFeatures: measurement,
    ...previewOut,
    statusMessages: [measured],
  };
}
