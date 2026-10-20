/**
 * Audio Analysis Tool for LangGraph Agent
 *
 * Measures from a 30-second preview clip:
 * - BPM (tempo)
 * - Musical key and mode
 * - Energy level
 * - Perceptual features (valence, danceability, ...) when the Essentia models are installed
 *
 * Preview source priority: Deezer (primary) → Spotify (fallback).
 * Calls the Python audio analysis service for the measurement. When there is no preview or
 * the service cannot measure it, the result has source "unavailable", null values and a
 * reason; nothing is estimated.
 *
 * @requires Audio analysis service running on AUDIO_ANALYSIS_URL
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";

import { searchDeezerPreview, type DeezerSearchResult } from "./deezer.js";
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
// Deezer Preview (Primary Source)
// =============================================================================

/**
 * Try to get a preview URL from Deezer (primary audio source).
 * Deezer provides more reliable preview availability than Spotify.
 */
async function tryDeezerFallback(title: string, artist: string): Promise<string | null> {
  if (!title && !artist) {
    return null;
  }

  try {
    console.log("🔄 [Audio] Trying Deezer preview...");

    const result = await searchDeezerPreview.invoke({ title, artist });
    const data = JSON.parse(result) as DeezerSearchResult;

    if (data.found && data.previewUrl) {
      console.log(`✅ [Audio] Deezer preview found: ${data.previewUrl}`);
      return data.previewUrl;
    }

    console.log("⚠️ [Audio] Deezer: no preview found");
    return null;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("❌ [Audio] Deezer preview error:", message);
    return null;
  }
}

// =============================================================================
// Audio Analysis Service Client
// =============================================================================

/**
 * Check if the audio analysis service is available
 */
async function isServiceAvailable(): Promise<boolean> {
  try {
    await fetchJson({
      source: "audio",
      url: `${audioServiceUrl()}/health`,
      timeoutMs: 5000,
      cassette: false,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Call the audio analysis service
 */
async function analyzeWithService(previewUrl: string): Promise<AudioServiceResponse> {
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
 * Analyze audio from Deezer (primary) or Spotify (fallback) preview URL
 */
export const analyzeAudioPreview = tool(
  async ({ previewUrl, title, artist }): Promise<string> => {
    console.log(`🎧 [Audio] Analyzing: "${title}" by ${artist}`);

    // Deezer-first: always try Deezer regardless of Spotify preview availability
    let effectivePreviewUrl = await tryDeezerFallback(title || "", artist || "");

    if (effectivePreviewUrl) {
      console.log("🎵 [Audio] Using Deezer preview (primary source)");
    } else if (previewUrl) {
      // Spotify fallback: use provided preview URL if Deezer had nothing
      effectivePreviewUrl = previewUrl;
      console.log("🎵 [Audio] Deezer unavailable, using Spotify preview (fallback)");
    } else {
      console.log("⚠️ [Audio] No preview from Deezer or Spotify; audio not measured");
      return JSON.stringify(
        unavailable("no_preview", "No preview available from Deezer or Spotify"),
      );
    }

    if (!isAllowedPreviewUrl(effectivePreviewUrl)) {
      console.log("⚠️ [Audio] Preview URL host not allowed; audio not measured");
      return JSON.stringify(
        unavailable("preview_rejected", "Preview URL is not on an allowed audio CDN host"),
      );
    }

    // Try the audio analysis service with the resolved preview URL
    try {
      const serviceAvailable = await isServiceAvailable();

      if (!serviceAvailable) {
        console.log("⚠️ [Audio] Analysis service unavailable; audio not measured");
        return JSON.stringify(
          unavailable("service_unavailable", "Audio analysis service did not respond"),
        );
      }

      console.log("🎧 [Audio] Calling analysis service...");
      const result = await analyzeWithService(effectivePreviewUrl);

      console.log(
        `✅ [Audio] Analysis complete: ${result.bpm} BPM, ${result.key} ${result.mode}, ${result.keyMoments?.length || 0} key moments`,
      );

      // Only a reply that says it analysed the clip is a measurement.
      if (result.source !== "analyzed") {
        return JSON.stringify(
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
      return JSON.stringify(measured);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("❌ [Audio] Analysis failed:", message);
      return JSON.stringify(unavailable("analysis_failed", message));
    }
  },
  {
    name: "analyze_audio_preview",
    description:
      "Analyze an audio preview URL to measure BPM, key and energy. " +
      "Tries Deezer first (more reliable previews), then Spotify as fallback. " +
      "Returns null values and a reason when no measurement is possible.",
    schema: z.object({
      previewUrl: z
        .string()
        .nullable()
        .optional()
        .describe(
          "The Spotify preview URL (30-second MP3). Can be null to trigger Deezer fallback.",
        ),
      title: z.string().optional().describe("Song title (used to find a Deezer preview)"),
      artist: z.string().optional().describe("Artist name (used to find a Deezer preview)"),
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
