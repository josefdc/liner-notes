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
 * its ISRC, or a Deezer search result that strictly matches it. Never another recording's clip:
 * with no such preview nothing is measured. Spotify's own clip is never measured: Spotify's terms
 * restrict using its content for machine learning, so Spotify is a search and metadata source.
 * Calls the Python audio analysis service for the measurement. When there is no preview or
 * the service cannot measure it, the result has source "unavailable", no block and a reason;
 * nothing is estimated. A preview the service refuses for what the file is (a format it does not
 * decode, an MP3 that does not decode in full) has its own reason when the service sends its
 * code; an older service's failed-read sentence alone stays `analysis_failed`.
 *
 * Preview URLs are signed and expire within minutes: they are returned for the run's player,
 * never logged.
 *
 * Under SOURCE_CASSETTE (sources/http.ts) the audio step is recorded and replayed by what it is
 * about, never by the clip. /health is one entry (its analyzer version only, recorded only from
 * an answer that names one: one per cassette directory, so re-record the whole set after an
 * analyzer change; the recording warns when it changes). Each track's outcome is one
 * entry, keyed by the track (its ISRC, else its Spotify id), the analyzer version /health named
 * (`none` when it named none or did not answer) and the window (audioCassetteKey): the block the
 * API read, or the reason nothing was measured (no clip, an unfinished lookup, a rejected host,
 * the service unavailable, a refusal with its code, a failure), with how the clip was matched,
 * the preview lookup's error and whether the clip was sent. Nothing of the clip's URL is kept,
 * and recorded text loses anything that looks like a link. A replay asks neither Deezer nor the
 * service and serves the recorded outcome, with no clip for the player. A measurement is served
 * only from an entry of the recorded /health's version whose block names that version and the
 * window: anything else is a miss, never a stale measurement, and fails the analysis
 * (`analysis_failed`) as any cassette miss does.
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
import {
  cassetteMode,
  describeError,
  fetchJson,
  isSourceError,
  plainReason,
  recordedEntry,
  recordJson,
  SourceError,
} from "./http.js";
import type { SourceErrorCode } from "./toolResult.js";
import type { AudioUnavailableReason } from "../agent/state.js";
import { logger } from "../logger.js";

const log = logger("Audio");

// =============================================================================
// TypeScript Interfaces
// =============================================================================

/**
 * How the run's preview clip was matched to the chosen track: a Deezer match (see DeezerMatch).
 * The contract's PreviewMatch still names `spotify`, so results stored when Spotify's own clip
 * was measured stay readable; no clip of Spotify's is measured now.
 */
export type PreviewSourceMatch = DeezerMatch;

/** Deezer could not be read while the clip was looked up (its quota, the network). */
export interface PreviewLookupError {
  source: "deezer";
  code: SourceErrorCode;
  message: string;
}

/**
 * The chosen track's preview clip, or why there is none. `sourceError` is set whenever Deezer
 * could not be read. `incomplete` is set when there
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
  /**
   * Under SOURCE_CASSETTE=replay only: the recorded run sent the clip to the service (and said it
   * was measuring).
   */
  sentToService?: boolean;
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

// Preview clips the player may load come from the Deezer or Spotify CDNs (isAllowedPreviewUrl).
// Only Deezer's are sent for analysis (isAnalysablePreviewUrl), with the same rules as the audio
// service (services/audio/preview.py), so a URL the service would refuse is reported here as
// preview_rejected instead of failing inside the analysis. Spotify's (p.scdn.co) are played,
// never analysed: Spotify's terms restrict using its content for machine learning.
const SPOTIFY_PREVIEW_HOST = "p.scdn.co";
const PREVIEW_HOST_SUFFIX = ".dzcdn.net";
const MAX_PREVIEW_URL_LENGTH = 2048;
const URL_CHARS = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const DNS_LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME = new RegExp(`^${DNS_LABEL}(?:\\.${DNS_LABEL})+$`);
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** The host of a well-formed preview URL on an https default port, or null. */
function previewHostOf(previewUrl: string): string | null {
  if (!previewUrl || previewUrl.length > MAX_PREVIEW_URL_LENGTH) return null;
  if (!URL_CHARS.test(previewUrl) || !previewUrl.startsWith("https://")) return null;

  // Authority as written (before any normalisation by the URL parser)
  const authority = previewUrl.slice("https://".length).split(/[/?#]/, 1)[0];
  if (authority.includes("@")) return null;
  const [host, port, ...rest] = authority.split(":");
  if (rest.length > 0 || (port !== undefined && port !== "443")) return null;
  if (!HOSTNAME.test(host) || IPV4.test(host)) return null;
  if (host.split(".").some((label) => label.startsWith("xn--"))) return null;
  return host;
}

/** A preview clip the player may load: on Deezer's or Spotify's preview CDN. */
export function isAllowedPreviewUrl(previewUrl: string): boolean {
  const host = previewHostOf(previewUrl);
  return host !== null && (host === SPOTIFY_PREVIEW_HOST || host.endsWith(PREVIEW_HOST_SUFFIX));
}

/** A preview clip the audio service measures: on Deezer's preview CDN only. */
export function isAnalysablePreviewUrl(previewUrl: string): boolean {
  return previewHostOf(previewUrl)?.endsWith(PREVIEW_HOST_SUFFIX) ?? false;
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

/** What resolvePreview needs: the chosen track. */
export type TrackPreviewRequest = PreviewRequest;

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
 * readable alternative), then a Deezer search result that is strictly the same recording. Nothing
 * else, and never Spotify's own clip: with neither there is no preview. A Deezer
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

  // After a Deezer error a search would fail the same way, and one the pace had no slot for
  // would wait as long.
  const bySearch =
    byIsrc.error || byIsrc.notAsked ? byIsrc : await lookup(deezerPreviewBySearch, byIsrc.rejected);
  if (bySearch.found) return { previewUrl: bySearch.previewUrl, match: bySearch.match };

  const failed = failure(bySearch);
  const answered = rejectionSummary(bySearch === byIsrc ? [byIsrc] : [byIsrc, bySearch]);
  const incomplete = failed.sourceError !== undefined || bySearch.notAsked === true;
  const detail = failed.sourceError
    ? `The preview lookup on Deezer could not be finished, as Deezer could not be read (${failed.sourceError.message})${answered}`
    : bySearch.notAsked
      ? `The preview lookup on Deezer could not be finished, as a request had no slot of Deezer's pace in time and was not sent${answered}`
      : `No preview of this recording on Deezer${answered}`;
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

/** The audio cassette's entry for /health: one, the analyzer of the latest recording. */
export const HEALTH_CASSETTE_KEY = "GET /health";

/** The `analyzer_version` a /health answer names, or null. */
const versionOf = (health: unknown): unknown =>
  health !== null && typeof health === "object"
    ? (health as { analyzer_version?: unknown }).analyzer_version
    : null;

/**
 * /health, as the service answers it; null when it did not answer. Replayed from
 * HEALTH_CASSETTE_KEY; under SOURCE_CASSETTE=record an answer is recorded there only when it
 * names an analyzer version (recordHealth), so an error never replaces a good entry.
 */
async function readHealth(signal: AbortSignal | undefined): Promise<unknown> {
  const replaying = cassetteMode() === "replay";
  let health: unknown;
  try {
    health = await fetchJson<unknown>({
      source: "audio",
      url: `${audioServiceUrl()}/health`,
      timeoutMs: 5000,
      ...(replaying ? { cassetteKey: HEALTH_CASSETTE_KEY } : { cassette: false }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return null;
  }
  await recordHealth(health);
  return health;
}

/** The request /health is recorded and read with (its analyzer version only). */
const healthRequest = () => ({
  source: "audio" as const,
  url: `${audioServiceUrl()}/health`,
  cassetteKey: HEALTH_CASSETTE_KEY,
  scrub: { analyzer_version: true } as const,
});

/**
 * Under SOURCE_CASSETTE=record, records a 2xx /health answer (its analyzer version only) when
 * it names a version; with none it is not recorded, and a run keeps the entry it found. The
 * directory's entry is the analyzer of its latest recording: a version other than the one
 * recorded is written with a warning, since the steps recorded under the earlier one then miss
 * on replay.
 */
async function recordHealth(health: unknown): Promise<void> {
  if (cassetteMode() !== "record") return;
  const named = versionOf(health);
  const version = keyVersion(typeof named === "string" ? named : null);
  if (version === null) {
    log.warn("/health not recorded: the audio service named no analyzer version");
    return;
  }
  const before = recordedAnalyzer();
  if (before.version === version) return;
  if (before.version !== null) {
    log.warn(
      `The recorded /health changes from analyzer ${before.version} to ${version}: the steps ` +
        `recorded under ${before.version} miss on replay. Re-record the whole set into a fresh ` +
        "SOURCE_CASSETTE_DIR.",
    );
  }
  await recordJson(healthRequest(), { analyzer_version: version });
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
  /** The analyzer version the service's /health named (null: none); keys the audio cassette. */
  analyzerVersion?: string | null;
  /** The chosen track's Spotify id: the cassette's key for a track with no ISRC. */
  trackId?: string | null;
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

/** The service refused the preview for what the file is (refusalReason), with its code. */
class PreviewRefusedError extends Error {
  constructor(
    readonly reason: AudioUnavailableReason,
    message: string,
    readonly code: string | null,
  ) {
    super(message);
  }
}

/**
 * Call the audio analysis service. Never recorded or replayed itself: the audio cassette keeps
 * the outcome of the whole step (recordAudioStep), never the clip it was sent.
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
    const body = isSourceError(error, "http")
      ? (error.body as { detail?: unknown; code?: unknown } | undefined)
      : undefined;
    const reason = plainReason(body?.detail);
    const refused = refusalReason(error);
    if (refused) {
      const code = typeof body?.code === "string" ? body.code : null;
      throw new PreviewRefusedError(refused, reason ?? describeError(error), code);
    }
    if (reason) throw new Error(reason);
    throw error;
  }
}

// =============================================================================
// The audio cassette
// =============================================================================

/** The window the service measures, as its block names it: part of the cassette key. */
export const AUDIO_WINDOW: AudioFeatures["window"]["kind"] = "preview-30s";

/** The version part of a key when the service named no analyzer version, or did not answer. */
const NO_VERSION = "none";

/**
 * The track an audio cassette entry is about: `isrc:<ISRC>` (upper case), else
 * `spotify:<id>`; null with neither (nothing is recorded, and a replay misses).
 */
export function audioTrackIdentity(
  isrc: string | null | undefined,
  trackId: string | null | undefined,
): string | null {
  const code = isrc?.trim().toUpperCase() ?? "";
  if (/^[A-Z0-9]{12}$/.test(code)) return `isrc:${code}`;
  const id = trackId?.trim() ?? "";
  return /^[A-Za-z0-9]{1,64}$/.test(id) ? `spotify:${id}` : null;
}

/** An analyzer version to key by: a short printable name, else null. */
const keyVersion = (version: string | null | undefined): string | null =>
  typeof version === "string" && /^[!-~]{1,128}$/.test(version) && version !== NO_VERSION
    ? version
    : null;

/**
 * The cassette entry of a track's audio step: the track (audioTrackIdentity), the analyzer
 * version /health named (`none` when it named none or did not answer) and the window.
 */
export function audioCassetteKey(track: string, analyzerVersion: string | null): string {
  return `audio ${track} analyzer:${keyVersion(analyzerVersion) ?? NO_VERSION} window:${AUDIO_WINDOW}`;
}

/**
 * Text that holds a link or a piece of a signed one: a scheme (`://`), a link without one
 * (`host.tld/path`), percent-encoded slashes or colons, or a signing parameter (`hdnea=`,
 * `exp=`, `hmac=`, `acl=`, `token=`, `sig=`, `signature=`).
 */
const URL_LIKE =
  /:\/\/|%(?:2f|3a)|(?:^|[^a-z0-9])(?:hdnea|exp|hmac|acl|token|sig|signature)=|(?:^|[^a-z0-9.-])(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?\//i;

/** `text` with each run of characters that looks like a link (URL_LIKE) shown as "[url]". */
export function withoutUrlLike(text: string): string {
  return text.replace(/[^\s"'<>()[\]{}]+/g, (word) => (URL_LIKE.test(word) ? "[url]" : word));
}

/** True when a key or a string anywhere in `value` looks like a link (URL_LIKE). */
function holdsUrlLike(value: unknown): boolean {
  if (typeof value === "string") return URL_LIKE.test(value);
  if (Array.isArray(value)) return value.some(holdsUrlLike);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, inner]) => URL_LIKE.test(key) || holdsUrlLike(inner));
}

/**
 * A track's audio step as the cassette keeps it: what the live run's analysis gave, never the
 * clip. Exactly one of `audio` (the block the API read from the service, ranges checked, with
 * the mood heads it dropped in `outOfRange`) and `unavailable` (the reason nothing was measured,
 * its `detail`, and for a refusal the service's `code`). `sent`: the clip was sent to the service
 * (the run said it was measuring). `match` and `sourceError` are the preview lookup's.
 */
interface RecordedAudioStep {
  audio?: AudioFeatures;
  outOfRange?: string[];
  unavailable?: AudioUnavailableReason;
  detail?: string;
  code?: string;
  sent: boolean;
  match: PreviewSourceMatch | null;
  sourceError?: PreviewLookupError;
}

/** The fields of a recorded step, for the cassette's scrub (sources/http.ts `pick`). */
const RECORDED_STEP = {
  audio: true,
  outOfRange: true,
  unavailable: true,
  detail: true,
  code: true,
  sent: true,
  match: true,
  sourceError: { source: true, code: true, message: true },
} as const;

/** A request for the step's cassette entry (the URL is the service's; nothing is sent). */
const stepRequest = (key: string) => ({
  source: "audio" as const,
  url: `${audioServiceUrl()}/analyze`,
  cassetteKey: key,
  scrub: RECORDED_STEP,
});

/**
 * Under SOURCE_CASSETTE=record, writes the outcome of a track's audio step under its key
 * (audioCassetteKey), through the cassette's scrub. Text is kept without anything that looks
 * like a link (withoutUrlLike). Not recorded, with a warning: a step with no track identity; a
 * measurement whose analyzer version is unknown; a block that holds anything like a link, which
 * the scrub would change.
 */
async function recordAudioStep(
  track: string | null,
  version: string | null,
  result: AudioAnalysisResult,
  step: { sent: boolean; code?: string | null },
): Promise<void> {
  if (cassetteMode() !== "record") return;
  const measured = result.source === "analyzed" && result.audio !== null;
  const notRecorded = (why: string) => log.warn(`Audio step not recorded: ${why}`);
  if (track === null) return notRecorded("the track has no ISRC or id to file it under");
  if (measured && keyVersion(version) === null) {
    return notRecorded("the audio service named no analyzer version for the measurement");
  }
  if (measured && holdsUrlLike(result.audio)) {
    return notRecorded("the measurement holds text that looks like a link");
  }
  const entry: RecordedAudioStep = {
    ...(measured
      ? {
          audio: result.audio as AudioFeatures,
          ...(result.outOfRange ? { outOfRange: result.outOfRange } : {}),
        }
      : {
          unavailable: result.reason ?? "analysis_failed",
          ...(result.error ? { detail: withoutUrlLike(result.error) } : {}),
          ...(step.code ? { code: withoutUrlLike(step.code) } : {}),
        }),
    sent: step.sent,
    match: result.previewMatch ?? null,
    ...(result.previewSourceError
      ? {
          sourceError: {
            ...result.previewSourceError,
            message: withoutUrlLike(result.previewSourceError.message),
          },
        }
      : {}),
  };
  await recordJson(stepRequest(audioCassetteKey(track, version)), entry);
}

/** What the live run could have given as the reason nothing was measured. */
const STEP_REASONS: ReadonlySet<string> = new Set<AudioUnavailableReason>([
  "no_preview",
  "preview_lookup_incomplete",
  "preview_rejected",
  "service_unavailable",
  "analysis_failed",
  "unsupported_format",
  "decode_incomplete",
]);

/**
 * How the clip of a replayed step was matched, as it was recorded; null when the entry holds
 * none, or not one of the shapes resolvePreview gives.
 */
function recordedMatch(match: unknown): PreviewSourceMatch | null {
  if (match === null || typeof match !== "object") return null;
  // A recorded match of Spotify's own clip (made before its clips were no longer measured) is
  // none of these shapes: it is read as no match.
  const { provider, method, deezerId, score } = match as Record<string, unknown>;
  const isScore = score === null || (typeof score === "number" && Number.isFinite(score));
  if (
    provider === "deezer" &&
    (method === "isrc" || method === "id" || method === "search") &&
    typeof deezerId === "number" &&
    Number.isSafeInteger(deezerId) &&
    isScore
  ) {
    return { provider, method, deezerId, score: score as number | null };
  }
  return null;
}

/** The preview lookup's error of a replayed step, as it was recorded; undefined when none. */
function recordedSourceError(error: unknown): PreviewLookupError | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const { source, code, message } = error as Record<string, unknown>;
  return source === "deezer" && typeof code === "string" && typeof message === "string"
    ? { source, code: code as SourceErrorCode, message }
    : undefined;
}

const miss = (message: string) => new SourceError("audio", "cassette_miss", message);

/**
 * The analyzer version of the recorded /health, or why there is none: nothing recorded, an
 * error recorded (by an older recording), an entry that names no version, or a cassette that
 * cannot be read.
 */
function recordedAnalyzer(): { version: string } | { version: null; why: string } {
  let entry: ReturnType<typeof recordedEntry>;
  try {
    entry = recordedEntry("audio", HEALTH_CASSETTE_KEY);
  } catch (error) {
    return { version: null, why: `the audio cassette cannot be read (${describeError(error)})` };
  }
  if (entry === undefined) {
    return { version: null, why: "no /health with an analyzer version was recorded" };
  }
  if (entry.status < 200 || entry.status > 299) {
    return { version: null, why: `the recorded /health is an error (HTTP ${entry.status})` };
  }
  const named = versionOf(entry.json);
  const version = keyVersion(typeof named === "string" ? named : null);
  return version
    ? { version }
    : { version: null, why: "the recorded /health names no analyzer version" };
}

/** The result of a replayed step, and whether its run sent the clip to the service. */
type ReplayedStep = AudioAnalysisResult & { sentToService: boolean };

/**
 * The recorded audio step of `track` (SOURCE_CASSETTE=replay): the result the live run gave,
 * with no clip. Nothing is sent. Looked up by the analyzer version of the recorded /health, then
 * under `none` (a step that measured nothing while the service named no version or did not
 * answer). A measurement is served only from an entry of that version whose block names it and
 * the window; anything else is a miss, which fails the analysis (`analysis_failed`) as any
 * cassette miss does: no other measurement is served in its place.
 */
async function replayedAudioStep(
  track: string | null,
  signal: AbortSignal | undefined,
): Promise<ReplayedStep> {
  try {
    if (track === null) throw miss("no recorded analysis: the track has no ISRC or id");
    const analyzer = recordedAnalyzer();
    const { version } = analyzer;
    const keys = [
      ...(version ? [audioCassetteKey(track, version)] : []),
      audioCassetteKey(track, null),
    ];
    let found: { key: string; entry: unknown } | null = null;
    for (const key of keys) {
      try {
        found = { key, entry: await fetchJson<unknown>(stepRequest(key)) };
        break;
      } catch (error) {
        if (!isSourceError(error, "cassette_miss")) throw error;
      }
    }
    if (found === null) {
      throw miss(
        "why" in analyzer
          ? `no recorded analysis for ${track}: ${analyzer.why}`
          : `no cassette entry for ${keys[0]}`,
      );
    }
    const { key, entry } = found;
    const step = (entry ?? {}) as Partial<Record<keyof RecordedAudioStep, unknown>>;
    const replayed = {
      sentToService: step.sent === true,
      previewMatch: recordedMatch(step.match),
      ...(recordedSourceError(step.sourceError)
        ? { previewSourceError: recordedSourceError(step.sourceError) }
        : {}),
    };
    if (step.audio !== undefined) {
      const measured = readServiceMeasurement({ v2: step.audio });
      if (measured.audio === null) throw miss(`the entry ${key} holds no readable block`);
      if (!version || key !== audioCassetteKey(track, version)) {
        throw miss(`the entry ${key} holds a measurement of no named analyzer`);
      }
      if (measured.audio.analyzerVersion !== version) {
        throw miss(`the entry ${key} holds a block of analyzer ${measured.audio.analyzerVersion}`);
      }
      if (measured.audio.window.kind !== AUDIO_WINDOW) {
        throw miss(`the entry ${key} holds a block of window ${measured.audio.window.kind}`);
      }
      const outOfRange = Array.isArray(step.outOfRange)
        ? step.outOfRange.filter((head): head is string => typeof head === "string")
        : [];
      return { ...analysisOf({ audio: measured.audio, outOfRange }), ...replayed };
    }
    if (typeof step.unavailable === "string" && STEP_REASONS.has(step.unavailable)) {
      const detail = typeof step.detail === "string" ? step.detail : undefined;
      log.info(`Replayed audio step: ${step.unavailable}`);
      return { ...unavailable(step.unavailable as AudioUnavailableReason, detail), ...replayed };
    }
    throw miss(`the entry ${key} holds no recorded outcome`);
  } catch (error) {
    return { ...failedAnalysis(error, signal), sentToService: false, previewMatch: null };
  }
}

// =============================================================================
// LangGraph Tools
// =============================================================================

/** The result for an /analyze answer, live or replayed: its v2 block, or why there is none. */
function analysisOf(measured: ServiceMeasurement): AudioAnalysisResult {
  // Only the v2 block is a measurement; missing values in it stay null, never a default.
  if (measured.audio === null) {
    log.warn(`No measurement in the service's answer: ${measured.error}`);
    return unavailable("analysis_failed", measured.error);
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
  return { source: "analyzed", audio, ...(outOfRange.length > 0 ? { outOfRange } : {}) };
}

/** The result for an analysis that failed, live or replayed. A cancelled run rethrows. */
function failedAnalysis(error: unknown, signal: AbortSignal | undefined): AudioAnalysisResult {
  // A cancelled run rejects: no "analysis failed" is reported for it.
  if (signal?.aborted) throw error;
  const message = error instanceof Error ? error.message : String(error);
  // A preview refused for what the file is has its own reason: the analysis did not fail.
  if (error instanceof PreviewRefusedError) {
    log.warn(`Preview not measured: ${message}`);
    return unavailable(error.reason, message);
  }
  log.error(`Analysis failed: ${message}`);
  return unavailable("analysis_failed", message);
}

/**
 * Measures the chosen track from its preview clip (see resolvePreview), never Spotify's own clip.
 * The result carries the
 * clip and how it was matched, for the run's player; without a clip of the chosen recording
 * nothing is measured. Under SOURCE_CASSETTE=record each outcome is recorded (recordAudioStep);
 * under replay the recorded outcome for the track is served instead, with no clip, and neither
 * Deezer nor the service is asked (replayedAudioStep).
 */
export const analyzeAudioPreview = tool(
  async ({ title, artist, artistNames, album, isrc, durationMs }, config) => {
    // The run's signal stops every request below (Deezer, the service's health and analysis).
    const signal = config?.signal;
    const known = audioRunContext(config);
    log.info(`Analyzing: "${title}" by ${artist}`);
    const track = audioTrackIdentity(isrc, known.trackId);

    if (cassetteMode() === "replay") {
      // No clip is given to the player: a recorded clip URL would have expired.
      return JSON.stringify({ ...(await replayedAudioStep(track, signal)), previewUrl: null });
    }

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
        },
        signal,
      ));
    const lookupError = preview.sourceError ? { previewSourceError: preview.sourceError } : {};
    let { serviceAvailable, analyzerVersion = null } = known;
    /** The result as the tool returns it, recorded first (SOURCE_CASSETTE=record). */
    const finish = async (
      result: AudioAnalysisResult,
      step: { sent: boolean; code?: string | null },
    ): Promise<string> => {
      await recordAudioStep(track, analyzerVersion, result, step);
      return JSON.stringify(result);
    };

    if (preview.previewUrl === null) {
      log.info("No preview of the chosen recording; audio not measured");
      // A lookup that could not be finished is no missing clip: whether there is one is unknown.
      return finish(
        {
          ...unavailable(
            preview.incomplete ? "preview_lookup_incomplete" : "no_preview",
            preview.detail,
          ),
          previewUrl: null,
          previewMatch: null,
          ...lookupError,
        },
        { sent: false },
      );
    }
    const effectivePreviewUrl = preview.previewUrl;
    // Every result below carries the clip and how it was matched, for the run's player.
    const withPreview = (result: AudioAnalysisResult): AudioAnalysisResult => ({
      ...result,
      previewUrl: effectivePreviewUrl,
      previewMatch: preview.match,
      ...lookupError,
    });

    if (!isAnalysablePreviewUrl(effectivePreviewUrl)) {
      log.info("Preview URL host not allowed; audio not measured");
      // Neither analysed nor given to the player.
      return finish(
        {
          ...unavailable("preview_rejected", "Preview URL is not on an allowed audio CDN host"),
          previewUrl: null,
          previewMatch: null,
          ...lookupError,
        },
        { sent: false },
      );
    }

    // Try the audio analysis service with the resolved preview URL
    let sent = false;
    try {
      // The run's health answer when it has one; else one probe.
      if (serviceAvailable === undefined) {
        const health = await audioServiceHealth(signal);
        serviceAvailable = health !== null;
        analyzerVersion = health?.analyzerVersion ?? null;
      }

      if (!serviceAvailable) {
        log.warn("Analysis service unavailable; audio not measured");
        return finish(
          withPreview(unavailable("service_unavailable", "Audio analysis service did not respond")),
          { sent: false },
        );
      }

      log.info("Calling analysis service...");
      signal?.throwIfAborted();
      sent = true;
      const answer = await analyzeWithService(effectivePreviewUrl, signal);
      return finish(withPreview(analysisOf(readServiceMeasurement(answer))), { sent });
    } catch (error) {
      const code = error instanceof PreviewRefusedError ? error.code : null;
      return finish(withPreview(failedAnalysis(error, signal)), { sent, code });
    }
  },
  {
    name: "analyze_audio_preview",
    description:
      "Measure tempo, key and loudness from a preview clip of the chosen recording: the Deezer " +
      "entry for its ISRC, or a Deezer search result that is strictly the same recording. " +
      "Returns no measurement and a reason when none is possible.",
    schema: z.object({
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
