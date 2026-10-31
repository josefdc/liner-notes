/**
 * Audio Analysis Tool for LangGraph Agent
 *
 * Measures a 30-second preview clip with the audio service, which answers with the contract's
 * AudioFeatures v2 block (`v2`): tempo, key, loudness, beats, energy contour, sections and key
 * moments from the signal, and model scores (styles, tags, mood heads) when the Essentia models
 * are loaded, and why each value it left null was withheld (`withheld`). Only that block is
 * read: the service sends nothing else since analyzer 2.3.0, an older service's v1 fields (bpm,
 * key, mode, energy, ...) are ignored, and an answer without a readable block is no measurement.
 *
 * The clip is a preview of the chosen recording only (see resolvePreview): the Deezer entry for
 * its ISRC, Spotify's own clip of the chosen track, or a Deezer search result that strictly
 * matches it. Never another recording's clip: with no such preview nothing is measured.
 * Calls the Python audio analysis service for the measurement. When there is no preview or
 * the service cannot measure it, the result has source "unavailable", no block and a reason;
 * nothing is estimated. A preview the service refuses for what the file is (a format it does not
 * decode, an MP3 that does not decode in full) has its own reason, never `analysis_failed`.
 *
 * Preview URLs are signed and expire within minutes: they are returned for the run's player,
 * never logged.
 *
 * @requires Audio analysis service running on AUDIO_ANALYSIS_URL
 */

import { tool } from "@langchain/core/tools";
import {
  type AudioFeatures,
  AudioFeatures as AudioFeaturesSchema,
  audioFeaturesIssues,
  type ModelScore,
} from "@liner-notes/contract";
import { z } from "zod";

import {
  type DeezerMatch,
  type DeezerPreviewResult,
  deezerFailure,
  deezerPreviewByIsrc,
  deezerPreviewBySearch,
  type PreviewRequest,
} from "./deezer.js";
import { describeError, fetchJson, isSourceError, plainReason } from "./http.js";
import type { SourceErrorCode } from "./toolResult.js";
import type { AudioUnavailableReason } from "../agent/state.js";
import { logger } from "../logger.js";

const log = logger("Audio");

// =============================================================================
// TypeScript Interfaces
// =============================================================================

/**
 * How the run's preview clip was matched to the chosen track: a Deezer match (see DeezerMatch),
 * or Spotify's own clip of the chosen track (`id`: no matching needed).
 */
export type PreviewSourceMatch = DeezerMatch | { provider: "spotify"; method: "id"; score: null };

/** Deezer could not be read while the clip was looked up (its quota, the network). */
export interface PreviewLookupError {
  source: "deezer";
  code: SourceErrorCode;
  message: string;
}

/**
 * The chosen track's preview clip, or why there is none. `sourceError` is set whenever Deezer
 * could not be read, also when Spotify's own clip was used instead. `incomplete` is set when there
 * is no clip and the lookup could not be finished: a Deezer request was not sent (its pace had no
 * slot in time, which is no source error) or Deezer could not be read. No clip is known to be
 * missing then.
 */
export type PreviewResolution = (
  | { previewUrl: string; match: PreviewSourceMatch }
  | { previewUrl: null; match: null; detail: string; incomplete?: true }
) & { sourceError?: PreviewLookupError };

/** Result of analyze_audio_preview: the service's v2 block, or why there is none. */
export interface AudioAnalysisResult {
  /** "analyzed" exactly when `audio` holds the service's block. */
  source: "analyzed" | "unavailable";
  /**
   * The AudioFeatures v2 block as the service measured it (its gate may say it measured
   * nothing: silence, noise, too short); null when there is none.
   */
  audio: AudioFeatures | null;
  /** Mood heads the service returned outside their range; they are null in `audio`. */
  outOfRange?: string[];
  /** Set when source is "unavailable" */
  reason?: AudioUnavailableReason;
  /** Error detail for reason */
  error?: string;
  /**
   * The clip used (or tried), for the run's player only: signed, never stored. null when no
   * preview of the chosen recording was found.
   */
  previewUrl?: string | null;
  /** How that clip was matched to the chosen track; null when there is none. */
  previewMatch?: PreviewSourceMatch | null;
  /** Set when Deezer could not be read while the clip was looked up. */
  previewSourceError?: PreviewLookupError;
}

// =============================================================================
// Configuration
// =============================================================================

// Read when called, so the URL set by the environment loader (or a test) is used.
/** Where the audio service listens when AUDIO_ANALYSIS_URL is unset. */
export const DEFAULT_AUDIO_SERVICE_URL = "http://localhost:3002";
const audioServiceUrl = () => process.env.AUDIO_ANALYSIS_URL || DEFAULT_AUDIO_SERVICE_URL;
const SERVICE_TIMEOUT = 30000; // 30 seconds for audio processing

// Optional shared secret the service requires on /analyze when it is configured.
const audioServiceToken = () => process.env.AUDIO_SERVICE_TOKEN || "";

// Preview clips are only sent for analysis when they come from the Spotify or Deezer CDNs.
// Same rules as the audio service (services/audio/preview.py), so a URL the service would
// refuse is reported here as preview_rejected instead of failing inside the analysis.
const PREVIEW_HOSTS = new Set(["p.scdn.co"]);
const PREVIEW_HOST_SUFFIX = ".dzcdn.net";
const MAX_PREVIEW_URL_LENGTH = 2048;
const URL_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})+$`);
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export function isAllowedPreviewUrl(previewUrl: string): boolean {
  if (!previewUrl || previewUrl.length > MAX_PREVIEW_URL_LENGTH) return false;
  if (!URL_CHARS.test(previewUrl) || !previewUrl.startsWith("https://")) return false;

  // Authority as written (before any normalisation by the URL parser)
  const authority = previewUrl.slice("https://".length).split(/[/?#]/, 1)[0];
  if (authority.includes("@")) return false;
  const [host, port, ...rest] = authority.split(":");
  if (rest.length > 0 || (port !== undefined && port !== "443")) return false;
  if (!HOSTNAME.test(host) || IPV4.test(host)) return false;
  if (host.split(".").some((label) => label.startsWith("xn--"))) return false;
  return PREVIEW_HOSTS.has(host) || host.endsWith(PREVIEW_HOST_SUFFIX);
}

function unavailable(reason: AudioUnavailableReason, error?: string): AudioAnalysisResult {
  return { source: "unavailable", audio: null, reason, error };
}

const MOOD_HEADS = ["danceability", "acoustic", "instrumental", "valence", "arousal"] as const;

/** True when a mood head's output is a finite number inside the range it states. */
function withinRange(score: ModelScore): boolean {
  const [low, high] = score.range;
  return (
    [score.value, low, high].every(Number.isFinite) &&
    low <= high &&
    score.value >= low &&
    score.value <= high
  );
}

/**
 * The block without the reasons the contract could not read: the contract reads each as absent
 * (undefined), and the block keeps no key for it.
 */
function withoutUnreadReasons(audio: AudioFeatures): AudioFeatures {
  const { withheld, ...rest } = audio;
  if (!withheld) return rest;
  const defined = <T extends object>(entries: T) =>
    Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined)) as T;
  const { moods, ...fields } = withheld;
  return {
    ...rest,
    withheld: { ...defined(fields), ...(moods ? { moods: defined(moods) } : {}) },
  };
}

/** What the service's answer measured: its v2 block, or why it cannot be used. */
export type ServiceMeasurement =
  | { audio: AudioFeatures; outOfRange: string[] }
  | { audio: null; error: string };

/**
 * The v2 block of an /analyze answer, as the contract reads it. Nothing else of the answer is
 * read: an answer with only the v1 fields (an older service), a block of another version, or
 * one that breaks the contract's rules (a gate that did not pass with values set) is no
 * measurement, with the reason. A mood head outside its own range is dropped (null), named in
 * `outOfRange` and given that reason in the block's `withheld`; the rest of the block is kept.
 */
export function readServiceMeasurement(answer: unknown): ServiceMeasurement {
  const block =
    answer !== null && typeof answer === "object" ? (answer as { v2?: unknown }).v2 : undefined;
  if (block == null) {
    return {
      audio: null,
      error: "The audio service sent no v2 measurement (an older service sends only v1 fields)",
    };
  }
  const parsed = AudioFeaturesSchema.safeParse(block);
  if (!parsed.success) {
    const where = parsed.error.issues
      .slice(0, 3)
      .map((issue) => issue.path.join(".") || "(block)")
      .join(", ");
    return {
      audio: null,
      error: `The audio service's v2 block does not fit the contract (${where})`,
    };
  }
  const audio = withoutUnreadReasons(parsed.data);
  const outOfRange: (typeof MOOD_HEADS)[number][] = [];
  const moods = audio.fingerprint?.moods;
  if (audio.fingerprint && moods) {
    const kept = { ...moods };
    for (const head of MOOD_HEADS) {
      const score = moods[head];
      if (score && !withinRange(score)) {
        kept[head] = null;
        outOfRange.push(head);
      }
    }
    if (outOfRange.length > 0) {
      audio.fingerprint = { ...audio.fingerprint, moods: kept };
      const reasons = { ...audio.withheld?.moods };
      for (const head of outOfRange) {
        reasons[head] = {
          code: "out_of_range",
          reason: `the ${head} head gave a value outside the range its model produces`,
        };
      }
      audio.withheld = { ...audio.withheld, moods: reasons };
    }
  }
  const issues = audioFeaturesIssues(audio);
  if (issues.length > 0) {
    return {
      audio: null,
      error: `The audio service's v2 block breaks the contract's rules (${issues.slice(0, 3).join("; ")})`,
    };
  }
  return { audio, outOfRange };
}

// =============================================================================
// The preview clip
// =============================================================================

/** What resolvePreview needs: the chosen track and Spotify's own clip of it, if any. */
export interface TrackPreviewRequest extends PreviewRequest {
  spotifyPreviewUrl?: string | null;
}

type DeezerRejected = Extract<DeezerPreviewResult, { found: false }>["rejected"];

/** Why each turned-down Deezer entry was not used, for the "no preview" detail. */
function rejectionSummary(results: DeezerPreviewResult[]): string {
  const reasons = results.flatMap((result) => (result.found ? [] : result.rejected));
  if (reasons.length === 0) return "";
  const counts = new Map<string, number>();
  for (const { reason } of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1);
  return ` (entries turned down: ${[...counts].map(([r, n]) => `${n} ${r}`).join(", ")})`;
}

/**
 * The chosen track's preview clip, in this order: the Deezer entry for its ISRC (or that entry's
 * readable alternative), Spotify's own clip of the chosen track, a Deezer search result that is
 * strictly the same recording. Nothing else: with none of them there is no preview. A Deezer
 * error (its quota, the network) is reported, never read as "not found". A request Deezer's pace
 * had no slot for in time was not sent, and is no source error (sources/pacing.ts). After either,
 * with no clip, the lookup could not be finished (`incomplete`): only a lookup Deezer answered at
 * every step can say there is no clip.
 */
export async function resolvePreview(
  request: TrackPreviewRequest,
  signal: AbortSignal | undefined,
): Promise<PreviewResolution> {
  if (!request.title && !request.artist && !request.isrc) {
    return { previewUrl: null, match: null, detail: "No track to find a preview for" };
  }
  signal?.throwIfAborted();

  const lookup = async (find: typeof deezerPreviewBySearch, turnedDown?: DeezerRejected) => {
    try {
      return await find(request, signal, turnedDown);
    } catch (error) {
      return deezerFailure(error, signal);
    }
  };

  const byIsrc = await lookup((request, signal) => deezerPreviewByIsrc(request, signal));
  if (byIsrc.found) return { previewUrl: byIsrc.previewUrl, match: byIsrc.match };
  const failure = (result: DeezerPreviewResult) =>
    !result.found && result.error
      ? {
          sourceError: {
            source: "deezer" as const,
            code: result.errorCode ?? "unavailable",
            message: result.error,
          },
        }
      : {};

  if (request.spotifyPreviewUrl) {
    log.info("Using Spotify's own preview of the chosen track");
    return {
      previewUrl: request.spotifyPreviewUrl,
      match: { provider: "spotify", method: "id", score: null },
      ...failure(byIsrc),
    };
  }

  // After a Deezer error a search would fail the same way, and one the pace had no slot for
  // would wait as long.
  const bySearch =
    byIsrc.error || byIsrc.notAsked ? byIsrc : await lookup(deezerPreviewBySearch, byIsrc.rejected);
  if (bySearch.found) return { previewUrl: bySearch.previewUrl, match: bySearch.match };

  const failed = failure(bySearch);
  const answered = rejectionSummary(bySearch === byIsrc ? [byIsrc] : [byIsrc, bySearch]);
  const incomplete = failed.sourceError !== undefined || bySearch.notAsked === true;
  const detail = failed.sourceError
    ? `The preview lookup on Deezer could not be finished, as Deezer could not be read (${failed.sourceError.message}), and Spotify has no preview of this track${answered}`
    : bySearch.notAsked
      ? `The preview lookup on Deezer could not be finished, as a request had no slot of Deezer's pace in time and was not sent, and Spotify has no preview of this track${answered}`
      : `No preview of this recording on Deezer or Spotify${answered}`;
  if (failed.sourceError) log.warn(detail);
  else log.info(detail);
  return {
    previewUrl: null,
    match: null,
    detail,
    ...failed,
    ...(incomplete ? { incomplete: true as const } : {}),
  };
}

// =============================================================================
// Audio Analysis Service Client
// =============================================================================

/** /health, as the service answers it; null when it did not answer. */
async function readHealth(signal: AbortSignal | undefined): Promise<unknown> {
  try {
    return await fetchJson<unknown>({
      source: "audio",
      url: `${audioServiceUrl()}/health`,
      timeoutMs: 5000,
      cassette: false,
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
}

/** Whether the audio analysis service answers its health check. */
async function isServiceAvailable(signal: AbortSignal | undefined): Promise<boolean> {
  return (await readHealth(signal)) !== null;
}

/** What the audio service said on /health: it answered, and the analyzer version it names. */
export interface AudioServiceHealth {
  /**
   * `analyzer_version`, e.g. "2.1.0+essentia.models-5c5c0c7f"; null when the service names
   * none. The audio cache is keyed by it: a measurement by another version is not served.
   */
  analyzerVersion: string | null;
}

/** The audio service's /health answer, or null when it does not answer. One probe. */
export async function audioServiceHealth(
  signal: AbortSignal | undefined,
): Promise<AudioServiceHealth | null> {
  const health = await readHealth(signal);
  if (health === null) return null;
  const version =
    typeof health === "object" ? (health as { analyzer_version?: unknown }).analyzer_version : null;
  return {
    analyzerVersion: typeof version === "string" && version.trim() !== "" ? version : null,
  };
}

/**
 * What the run already knows when it asks for an analysis, passed in the tool call's config
 * (`configurable.audioRun`) so nothing is asked twice: the preview it resolved for the chosen
 * track, and whether the service answered its health check. What is not given is looked up.
 */
export interface AudioRunContext {
  preview?: PreviewResolution;
  serviceAvailable?: boolean;
}

/** The run context in a tool call's config, when the caller gave one. */
function audioRunContext(config: unknown): AudioRunContext {
  const context = (config as { configurable?: { audioRun?: unknown } } | undefined)?.configurable
    ?.audioRun;
  return context !== null && typeof context === "object" ? (context as AudioRunContext) : {};
}

/**
 * Why the service refused a preview for what the file is (a 422), by the code it sends with
 * the refusal: a format it does not decode, or an MP3 that does not decode to the audio its
 * frames hold (services/audio/main.py). Not a failure of the analysis: the same file is refused
 * again, so the result is stored like any other.
 */
const REFUSAL_CODES: Readonly<Record<string, AudioUnavailableReason>> = {
  unsupported_format: "unsupported_format",
  decode_incomplete: "decode_incomplete",
};

/**
 * The same refusals by their words alone, as a service older than the codes sends them. Not
 * "the MP3 could not be decoded to the end of its MPEG audio frames": an older service also
 * sent it when its own pipe or thread could not be set up (a fault, not the file), so from the
 * words alone it stays analysis_failed, and is not stored.
 */
const REFUSAL_PREFIX = "The preview is not analysable audio: ";
const REFUSAL_DETAILS: Readonly<Record<string, AudioUnavailableReason>> = {
  [`${REFUSAL_PREFIX}it is an MP4 (M4A) or AAC file, a format the service does not decode`]:
    "unsupported_format",
  [`${REFUSAL_PREFIX}the MP3 decodes to less audio than its MPEG audio frames hold`]:
    "decode_incomplete",
};

/**
 * The reason for a refusal of the preview file (REFUSAL_CODES, else REFUSAL_DETAILS), or null:
 * only a 422 is one, and a code or words this client does not know are none.
 */
function refusalReason(error: unknown): AudioUnavailableReason | null {
  if (!isSourceError(error, "http") || error.status !== 422) return null;
  const body = error.body as { detail?: unknown; code?: unknown } | null | undefined;
  const code = typeof body === "object" ? body?.code : undefined;
  if (typeof code === "string" && Object.hasOwn(REFUSAL_CODES, code)) return REFUSAL_CODES[code];
  const detail = typeof body === "object" ? body?.detail : undefined;
  if (typeof detail === "string" && Object.hasOwn(REFUSAL_DETAILS, detail)) {
    return REFUSAL_DETAILS[detail];
  }
  return null;
}

/** The service refused the preview for what the file is (refusalReason). */
class PreviewRefusedError extends Error {
  constructor(
    readonly reason: AudioUnavailableReason,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Call the audio analysis service
 */
async function analyzeWithService(
  previewUrl: string,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  try {
    return await fetchJson<unknown>({
      source: "audio",
      url: `${audioServiceUrl()}/analyze`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(audioServiceToken() ? { "X-Audio-Token": audioServiceToken() } : {}),
      },
      body: JSON.stringify({ preview_url: previewUrl }),
      timeoutMs: SERVICE_TIMEOUT,
      cassette: false,
      signal,
    });
  } catch (error) {
    // The service explains a failed analysis in `detail` (FastAPI).
    const detail = isSourceError(error, "http")
      ? (error.body as { detail?: unknown } | undefined)?.detail
      : undefined;
    const reason = plainReason(detail);
    const refused = refusalReason(error);
    if (refused) throw new PreviewRefusedError(refused, reason ?? describeError(error));
    if (reason) throw new Error(reason);
    throw error;
  }
}

// =============================================================================
// LangGraph Tools
// =============================================================================

/**
 * Measures the chosen track from its preview clip (see resolvePreview). The result carries the
 * clip and how it was matched, for the run's player; without a clip of the chosen recording
 * nothing is measured.
 */
export const analyzeAudioPreview = tool(
  async ({ previewUrl, title, artist, artistNames, album, isrc, durationMs }, config) => {
    // The run's signal stops every request below (Deezer, the service's health and analysis).
    const signal = config?.signal;
    const known = audioRunContext(config);
    log.info(`Analyzing: "${title}" by ${artist}`);

    // The preview the run resolved already, or looked up here.
    const preview =
      known.preview ??
      (await resolvePreview(
        {
          title: title ?? "",
          artist: artist ?? "",
          artistNames,
          album,
          isrc,
          durationMs,
          spotifyPreviewUrl: previewUrl,
        },
        signal,
      ));
    const lookupError = preview.sourceError ? { previewSourceError: preview.sourceError } : {};
    if (preview.previewUrl === null) {
      log.info("No preview of the chosen recording; audio not measured");
      // A lookup that could not be finished is no missing clip: whether there is one is unknown.
      return JSON.stringify({
        ...unavailable(
          preview.incomplete ? "preview_lookup_incomplete" : "no_preview",
          preview.detail,
        ),
        previewUrl: null,
        previewMatch: null,
        ...lookupError,
      });
    }
    const effectivePreviewUrl = preview.previewUrl;
    // Every result below carries the clip and how it was matched, for the run's player.
    const withPreview = (result: AudioAnalysisResult): string =>
      JSON.stringify({
        ...result,
        previewUrl: effectivePreviewUrl,
        previewMatch: preview.match,
        ...lookupError,
      });

    if (!isAllowedPreviewUrl(effectivePreviewUrl)) {
      log.info("Preview URL host not allowed; audio not measured");
      // Neither analysed nor given to the player.
      return JSON.stringify({
        ...unavailable("preview_rejected", "Preview URL is not on an allowed audio CDN host"),
        previewUrl: null,
        previewMatch: null,
        ...lookupError,
      });
    }

    // Try the audio analysis service with the resolved preview URL
    try {
      // The run's health answer when it has one; else one probe.
      const serviceAvailable = known.serviceAvailable ?? (await isServiceAvailable(signal));

      if (!serviceAvailable) {
        log.warn("Analysis service unavailable; audio not measured");
        return withPreview(
          unavailable("service_unavailable", "Audio analysis service did not respond"),
        );
      }

      log.info("Calling analysis service...");
      signal?.throwIfAborted();
      const answer = await analyzeWithService(effectivePreviewUrl, signal);

      // Only the v2 block is a measurement; missing values in it stay null, never a default.
      const measured = readServiceMeasurement(answer);
      if (measured.audio === null) {
        log.warn(`No measurement in the service's answer: ${measured.error}`);
        return withPreview(unavailable("analysis_failed", measured.error));
      }
      const { audio, outOfRange } = measured;
      log.info(
        `Analysis complete (${audio.analyzerVersion}): ` +
          (audio.gate.passed
            ? `${audio.tempo ? `${audio.tempo.bpm} BPM` : "no tempo"}, ` +
              `${audio.key ? `${audio.key.tonic} ${audio.key.mode}` : "no key"}, ` +
              `${audio.keyMoments.length} key moments`
            : `nothing measured (${audio.gate.reason})`),
      );
      return withPreview({
        source: "analyzed",
        audio,
        ...(outOfRange.length > 0 ? { outOfRange } : {}),
      });
    } catch (error) {
      // A cancelled run rejects: no "analysis failed" is reported for it.
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      // A preview refused for what the file is has its own reason: the analysis did not fail.
      if (error instanceof PreviewRefusedError) {
        log.warn(`Preview not measured: ${message}`);
        return withPreview(unavailable(error.reason, message));
      }
      log.error(`Analysis failed: ${message}`);
      return withPreview(unavailable("analysis_failed", message));
    }
  },
  {
    name: "analyze_audio_preview",
    description:
      "Measure tempo, key and loudness from a preview clip of the chosen recording: the Deezer " +
      "entry for its ISRC, Spotify's own clip, or a Deezer search result that is strictly the " +
      "same recording. Returns no measurement and a reason when none is possible.",
    schema: z.object({
      previewUrl: z
        .string()
        .nullable()
        .optional()
        .describe("Spotify's own preview clip of the chosen track, if it has one"),
      title: z.string().optional().describe("Song title"),
      artist: z.string().optional().describe("Artist name (the credited artists joined)"),
      artistNames: z.array(z.string()).optional().describe("The credited artists one by one"),
      album: z.string().optional().describe("The album the track is on"),
      isrc: z.string().nullable().optional().describe("The recording's ISRC"),
      durationMs: z.number().nullable().optional().describe("The track's duration in ms"),
    }),
  },
);

/**
 * Check audio service health
 */
export const checkAudioServiceHealth = tool(
  async (): Promise<string> => {
    try {
      const data = await fetchJson<{ analyzer_version?: string; version?: string }>({
        source: "audio",
        url: `${audioServiceUrl()}/health`,
        timeoutMs: 5000,
        cassette: false,
      });
      return JSON.stringify({
        available: true,
        url: audioServiceUrl(),
        // The service reports `analyzer_version`; older builds sent `version`.
        version: data?.analyzer_version ?? data?.version,
      });
    } catch (error) {
      return JSON.stringify({
        available: false,
        url: audioServiceUrl(),
        error: describeError(error),
      });
    }
  },
  {
    name: "check_audio_service",
    description: "Check if the audio analysis microservice is available.",
    schema: z.object({}),
  },
);

// =============================================================================
// Exports
// =============================================================================

export const audioTools = [analyzeAudioPreview, checkAudioServiceHealth];
