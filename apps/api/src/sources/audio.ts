/**
 * Audio Analysis Tool for LangGraph Agent
 *
 * Measures from a 30-second preview clip:
 * - BPM (tempo)
 * - Musical key and mode
 * - Energy level
 * - Perceptual features (valence, danceability, ...) when the Essentia models are installed
 *
 * The clip is a preview of the chosen recording only (see resolvePreview): the Deezer entry for
 * its ISRC, Spotify's own clip of the chosen track, or a Deezer search result that strictly
 * matches it. Never another recording's clip: with no such preview nothing is measured.
 * Calls the Python audio analysis service for the measurement. When there is no preview or
 * the service cannot measure it, the result has source "unavailable", null values and a
 * reason; nothing is estimated.
 *
 * Preview URLs are signed and expire within minutes: they are returned for the run's player,
 * never logged.
 *
 * @requires Audio analysis service running on AUDIO_ANALYSIS_URL
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";

import {
  type DeezerMatch,
  type DeezerPreviewResult,
  deezerFailure,
  deezerPreviewByIsrc,
  deezerPreviewBySearch,
  type PreviewRequest,
} from "./deezer.js";
import { describeError, fetchJson, isSourceError } from "./http.js";
import type { AudioUnavailableReason } from "../agent/state.js";

// =============================================================================
// TypeScript Interfaces
// =============================================================================

export interface KeyMoment {
  time: number; // Time in seconds
  type: "energy_peak" | "energy_drop" | "onset" | "harmonic_change" | "silence";
  intensity: number; // 0-1 scale
  description: string;
}

/**
 * How the run's preview clip was matched to the chosen track: a Deezer match (see DeezerMatch),
 * or Spotify's own clip of the chosen track (`id`: no matching needed).
 */
export type PreviewSourceMatch = DeezerMatch | { provider: "spotify"; method: "id"; score: null };

/** The chosen track's preview clip, or why there is none. */
export type PreviewResolution =
  | { previewUrl: string; match: PreviewSourceMatch }
  | { previewUrl: null; match: null; detail: string; error?: string };

/** Result of analyze_audio_preview. Every value is measured or null. */
export interface AudioAnalysisResult {
  source: "analyzed" | "unavailable";
  bpm: number | null;
  key: string | null;
  mode: string | null;
  energy: number | null;
  duration?: number | null;
  keyMoments?: KeyMoment[];
  // Perceptual features from Essentia (null when the models are unavailable)
  valence?: number | null;
  danceability?: number | null;
  acousticness?: number | null;
  instrumentalness?: number | null;
  /** Fields the service returned outside their valid range (reported as null) */
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
}

// What the service may return. It sends null bpm when no tempo is found and null key/mode
// for unpitched audio; any field may also be missing in older service versions.
interface AudioServiceResponse {
  bpm?: number | null;
  key?: string | null;
  mode?: string | null;
  energy?: number | null;
  duration?: number | null;
  source?: string;
  keyMoments?: KeyMoment[];
  // Perceptual features from Essentia (present when models are available)
  valence?: number | null;
  danceability?: number | null;
  acousticness?: number | null;
  instrumentalness?: number | null;
}

// =============================================================================
// Configuration
// =============================================================================

// Read when called, so the URL set by the environment loader (or a test) is used.
const audioServiceUrl = () => process.env.AUDIO_ANALYSIS_URL || "http://localhost:3002";
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

/** A measured tempo: a finite number above zero, else null. */
function measuredBpm(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/** A finite number, else null. */
function measuredNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A non-empty string, else null. */
function measuredText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/** "Major" or "Minor" (any case), else null. */
function measuredMode(value: unknown): "Major" | "Minor" | null {
  const text = measuredText(value)?.toLowerCase();
  return text === "major" ? "Major" : text === "minor" ? "Minor" : null;
}

function unavailable(reason: AudioUnavailableReason, error?: string): AudioAnalysisResult {
  return {
    source: "unavailable",
    bpm: null,
    key: null,
    mode: null,
    energy: null,
    keyMoments: [],
    valence: null,
    danceability: null,
    acousticness: null,
    instrumentalness: null,
    reason,
    error,
  };
}

// =============================================================================
// The preview clip
// =============================================================================

/** What resolvePreview needs: the chosen track and Spotify's own clip of it, if any. */
export interface TrackPreviewRequest extends PreviewRequest {
  spotifyPreviewUrl?: string | null;
}

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
 * error (its quota, the network) is reported, never read as "not found".
 */
export async function resolvePreview(
  request: TrackPreviewRequest,
  signal: AbortSignal | undefined,
): Promise<PreviewResolution> {
  if (!request.title && !request.artist && !request.isrc) {
    return { previewUrl: null, match: null, detail: "No track to find a preview for" };
  }
  signal?.throwIfAborted();

  const lookup = async (find: typeof deezerPreviewByIsrc) => {
    try {
      return await find(request, signal);
    } catch (error) {
      return deezerFailure(error, signal);
    }
  };

  const byIsrc = await lookup(deezerPreviewByIsrc);
  if (byIsrc.found) return { previewUrl: byIsrc.previewUrl, match: byIsrc.match };

  if (request.spotifyPreviewUrl) {
    console.log("🎵 [Audio] Using Spotify's own preview of the chosen track");
    return {
      previewUrl: request.spotifyPreviewUrl,
      match: { provider: "spotify", method: "id", score: null },
    };
  }

  // After a Deezer error a search would fail the same way.
  const bySearch = byIsrc.error ? byIsrc : await lookup(deezerPreviewBySearch);
  if (bySearch.found) return { previewUrl: bySearch.previewUrl, match: bySearch.match };

  const error = bySearch.error ?? byIsrc.error;
  const detail = error
    ? "Deezer could not be read and Spotify has no preview of this track"
    : `No preview of this recording on Deezer or Spotify${rejectionSummary([byIsrc, bySearch])}`;
  console.log(`⚠️ [Audio] ${detail}`);
  return { previewUrl: null, match: null, detail, ...(error ? { error } : {}) };
}

// =============================================================================
// Audio Analysis Service Client
// =============================================================================

/**
 * Check if the audio analysis service is available
 */
async function isServiceAvailable(signal: AbortSignal | undefined): Promise<boolean> {
  try {
    await fetchJson({
      source: "audio",
      url: `${audioServiceUrl()}/health`,
      timeoutMs: 5000,
      cassette: false,
      signal,
    });
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    return false;
  }
}

/**
 * Call the audio analysis service
 */
async function analyzeWithService(
  previewUrl: string,
  signal: AbortSignal | undefined,
): Promise<AudioServiceResponse> {
  try {
    return await fetchJson<AudioServiceResponse>({
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
    if (typeof detail === "string" && detail) throw new Error(detail);
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
    console.log(`🎧 [Audio] Analyzing: "${title}" by ${artist}`);

    const preview = await resolvePreview(
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
    );
    if (preview.previewUrl === null) {
      console.log("⚠️ [Audio] No preview of the chosen recording; audio not measured");
      const detail = preview.error ? `${preview.detail}: ${preview.error}` : preview.detail;
      return JSON.stringify({
        ...unavailable("no_preview", detail),
        previewUrl: null,
        previewMatch: null,
      });
    }
    const effectivePreviewUrl = preview.previewUrl;
    // Every result below carries the clip and how it was matched, for the run's player.
    const withPreview = (result: AudioAnalysisResult): string =>
      JSON.stringify({ ...result, previewUrl: effectivePreviewUrl, previewMatch: preview.match });

    if (!isAllowedPreviewUrl(effectivePreviewUrl)) {
      console.log("⚠️ [Audio] Preview URL host not allowed; audio not measured");
      // Neither analysed nor given to the player.
      return JSON.stringify({
        ...unavailable("preview_rejected", "Preview URL is not on an allowed audio CDN host"),
        previewUrl: null,
        previewMatch: null,
      });
    }

    // Try the audio analysis service with the resolved preview URL
    try {
      const serviceAvailable = await isServiceAvailable(signal);

      if (!serviceAvailable) {
        console.log("⚠️ [Audio] Analysis service unavailable; audio not measured");
        return withPreview(
          unavailable("service_unavailable", "Audio analysis service did not respond"),
        );
      }

      console.log("🎧 [Audio] Calling analysis service...");
      signal?.throwIfAborted();
      const result = await analyzeWithService(effectivePreviewUrl, signal);

      console.log(
        `✅ [Audio] Analysis complete: ${result.bpm} BPM, ${result.key} ${result.mode}, ${result.keyMoments?.length || 0} key moments`,
      );

      // Only a reply that says it analysed the clip is a measurement.
      if (result.source !== "analyzed") {
        return withPreview(
          unavailable(
            "analysis_failed",
            `Service reply source is ${JSON.stringify(result.source)}`,
          ),
        );
      }

      // Missing values stay null, never 0 or a default. A key needs both a pitch class and a
      // mode: when either is missing (e.g. unpitched audio) both are null. 0..1 scores outside
      // that range are dropped and listed in outOfRange.
      const outOfRange: string[] = [];
      const unit = (name: string, value: unknown): number | null => {
        const n = measuredNumber(value);
        if (n === null) return null;
        if (n < 0 || n > 1) {
          outOfRange.push(name);
          return null;
        }
        return n;
      };
      const keyName = measuredText(result.key);
      const mode = measuredMode(result.mode);
      const pitched = keyName !== null && mode !== null;
      const measured: AudioAnalysisResult = {
        source: "analyzed",
        bpm: measuredBpm(result.bpm),
        key: pitched ? keyName : null,
        mode: pitched ? mode : null,
        energy: unit("energy", result.energy),
        duration: measuredNumber(result.duration),
        keyMoments: Array.isArray(result.keyMoments) ? result.keyMoments : [],
        // Scores from the Essentia models (null when the models are unavailable)
        valence: unit("valence", result.valence),
        danceability: unit("danceability", result.danceability),
        acousticness: unit("acousticness", result.acousticness),
        instrumentalness: unit("instrumentalness", result.instrumentalness),
      };
      if (outOfRange.length > 0) measured.outOfRange = outOfRange;
      return withPreview(measured);
    } catch (error) {
      // A cancelled run rejects: no "analysis failed" is reported for it.
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      console.error("❌ [Audio] Analysis failed:", message);
      return withPreview(unavailable("analysis_failed", message));
    }
  },
  {
    name: "analyze_audio_preview",
    description:
      "Measure BPM, key and energy from a preview clip of the chosen recording: the Deezer " +
      "entry for its ISRC, Spotify's own clip, or a Deezer search result that is strictly the " +
      "same recording. Returns null values and a reason when no measurement is possible.",
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
