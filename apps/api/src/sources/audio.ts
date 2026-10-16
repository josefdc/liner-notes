/**
 * Audio Analysis Tool for LangGraph Agent
 *
 * Analyzes audio preview URLs to extract:
 * - Real BPM (tempo)
 * - Musical key (C, D#, etc.)
 * - Mode (Major/Minor)
 * - Energy level
 *
 * Preview source priority: Deezer (primary) → Spotify (fallback) → estimation.
 * Calls a Python FastAPI microservice (librosa) for actual analysis.
 * Falls back to estimation heuristics if service is unavailable.
 *
 * @requires Audio analysis service running on AUDIO_ANALYSIS_URL
 */

import { tool } from "@langchain/core/tools";
import { z } from "zod";
import dotenv from "dotenv";

import { searchDeezerPreview, type DeezerSearchResult } from "./deezer.js";

dotenv.config();

// =============================================================================
// TypeScript Interfaces
// =============================================================================

export interface KeyMoment {
  time: number; // Time in seconds
  type: "energy_peak" | "energy_drop" | "onset" | "harmonic_change" | "silence";
  intensity: number; // 0-1 scale
  description: string;
}

export interface AudioAnalysisResult {
  bpm: number;
  key: string;
  mode: string;
  energy: number;
  duration?: number;
  source: "analyzed" | "estimated";
  keyMoments?: KeyMoment[];
  error?: string;
  // Perceptual features from Essentia (present when models are available)
  valence?: number;
  danceability?: number;
  acousticness?: number;
  instrumentalness?: number;
}

interface AudioServiceResponse {
  bpm: number;
  key: string;
  mode: string;
  energy: number;
  duration: number;
  source: string;
  keyMoments?: KeyMoment[];
  // Perceptual features from Essentia (present when models are available)
  valence?: number;
  danceability?: number;
  acousticness?: number;
  instrumentalness?: number;
}

// =============================================================================
// Configuration
// =============================================================================

const AUDIO_SERVICE_URL = process.env.AUDIO_ANALYSIS_URL || "http://localhost:3002";
const SERVICE_TIMEOUT = 30000; // 30 seconds for audio processing

// =============================================================================
// Estimation Fallbacks (used when service unavailable or no preview)
// =============================================================================

/**
 * Estimate BPM based on title/artist heuristics
 * Used as fallback when audio analysis unavailable
 */
function estimateBPM(title: string, artist: string): number {
  const combined = `${title} ${artist}`.toLowerCase();

  // Genre-based heuristics
  if (combined.includes("ballad") || combined.includes("slow") || combined.includes("acoustic")) {
    return 65 + Math.floor(Math.random() * 20); // 65-85
  }
  if (combined.includes("dance") || combined.includes("club") || combined.includes("house")) {
    return 120 + Math.floor(Math.random() * 15); // 120-135
  }
  if (
    combined.includes("drum and bass") ||
    combined.includes("dnb") ||
    combined.includes("jungle")
  ) {
    return 170 + Math.floor(Math.random() * 10); // 170-180
  }
  if (combined.includes("rock") || combined.includes("punk") || combined.includes("metal")) {
    return 130 + Math.floor(Math.random() * 30); // 130-160
  }
  if (combined.includes("hip hop") || combined.includes("rap") || combined.includes("trap")) {
    return 80 + Math.floor(Math.random() * 20); // 80-100
  }
  if (combined.includes("jazz") || combined.includes("blues")) {
    return 90 + Math.floor(Math.random() * 40); // 90-130
  }
  if (combined.includes("techno") || combined.includes("trance")) {
    return 135 + Math.floor(Math.random() * 15); // 135-150
  }

  // Default range for pop/rock
  return 100 + Math.floor(Math.random() * 30); // 100-130
}

/**
 * Estimate key randomly (no reliable heuristic without audio)
 */
function estimateKey(): { key: string; mode: string } {
  const keys = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const modes = ["Major", "Minor"];
  return {
    key: keys[Math.floor(Math.random() * keys.length)],
    mode: modes[Math.floor(Math.random() * modes.length)],
  };
}

/**
 * Estimate energy based on genre heuristics
 */
function estimateEnergy(title: string, artist: string): number {
  const combined = `${title} ${artist}`.toLowerCase();

  if (
    combined.includes("ballad") ||
    combined.includes("acoustic") ||
    combined.includes("ambient")
  ) {
    return 0.2 + Math.random() * 0.2; // 0.2-0.4
  }
  if (combined.includes("dance") || combined.includes("rock") || combined.includes("metal")) {
    return 0.7 + Math.random() * 0.25; // 0.7-0.95
  }

  return 0.5 + Math.random() * 0.3; // 0.5-0.8 default
}

/**
 * Generate full estimated audio features
 */
function generateEstimatedFeatures(title: string, artist: string): AudioAnalysisResult {
  const { key, mode } = estimateKey();
  return {
    bpm: estimateBPM(title, artist),
    key,
    mode,
    energy: Math.round(estimateEnergy(title, artist) * 1000) / 1000,
    source: "estimated",
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`${AUDIO_SERVICE_URL}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Call the audio analysis service
 */
async function analyzeWithService(previewUrl: string): Promise<AudioServiceResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SERVICE_TIMEOUT);

  try {
    const response = await fetch(`${AUDIO_SERVICE_URL}/analyze`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ preview_url: previewUrl }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const error = (await response.json().catch(() => ({ detail: "Unknown error" }))) as {
        detail?: string;
      };
      throw new Error(error.detail || `HTTP ${response.status}`);
    }

    return (await response.json()) as AudioServiceResponse;
  } finally {
    clearTimeout(timeout);
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
      // No preview from either source
      console.log("⚠️ [Audio] No preview from Deezer or Spotify, using estimation");
      const estimated = generateEstimatedFeatures(title || "", artist || "");
      return JSON.stringify({
        ...estimated,
        message: "No preview available (Deezer/Spotify) - using genre-based estimation",
      });
    }

    // Try the audio analysis service with the resolved preview URL
    try {
      const serviceAvailable = await isServiceAvailable();

      if (!serviceAvailable) {
        console.log("⚠️ [Audio] Analysis service unavailable, using estimation");
        const estimated = generateEstimatedFeatures(title || "", artist || "");
        return JSON.stringify({
          ...estimated,
          message: "Audio service offline - using genre-based estimation",
        });
      }

      console.log("🎧 [Audio] Calling analysis service...");
      const result = await analyzeWithService(effectivePreviewUrl);

      console.log(
        `✅ [Audio] Analysis complete: ${result.bpm} BPM, ${result.key} ${result.mode}, ${result.keyMoments?.length || 0} key moments`,
      );

      return JSON.stringify({
        bpm: result.bpm,
        key: result.key,
        mode: result.mode,
        energy: result.energy,
        duration: result.duration,
        source: "analyzed" as const,
        keyMoments: result.keyMoments || [],
        // Pass through perceptual features from Essentia (undefined if unavailable)
        valence: result.valence,
        danceability: result.danceability,
        acousticness: result.acousticness,
        instrumentalness: result.instrumentalness,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("❌ [Audio] Analysis failed:", message);

      // Fallback to estimation
      const estimated = generateEstimatedFeatures(title || "", artist || "");
      return JSON.stringify({
        ...estimated,
        error: message,
        message: "Analysis failed - using genre-based estimation",
      });
    }
  },
  {
    name: "analyze_audio_preview",
    description:
      "Analyze an audio preview URL to extract real BPM and musical key. " +
      "Tries Deezer first (more reliable previews), then Spotify as fallback. " +
      "Falls back to genre-based estimation if all sources fail.",
    schema: z.object({
      previewUrl: z
        .string()
        .nullable()
        .optional()
        .describe(
          "The Spotify preview URL (30-second MP3). Can be null to trigger Deezer fallback.",
        ),
      title: z
        .string()
        .optional()
        .describe("Song title (required for Deezer fallback and estimation)"),
      artist: z
        .string()
        .optional()
        .describe("Artist name (required for Deezer fallback and estimation)"),
    }),
  },
);

/**
 * Check audio service health
 */
export const checkAudioServiceHealth = tool(
  async (): Promise<string> => {
    try {
      const response = await fetch(`${AUDIO_SERVICE_URL}/health`);

      if (!response.ok) {
        return JSON.stringify({
          available: false,
          url: AUDIO_SERVICE_URL,
          error: `HTTP ${response.status}`,
        });
      }

      const data = (await response.json()) as { version?: string };
      return JSON.stringify({
        available: true,
        url: AUDIO_SERVICE_URL,
        version: data.version,
      });
    } catch (error) {
      return JSON.stringify({
        available: false,
        url: AUDIO_SERVICE_URL,
        error: error instanceof Error ? error.message : "Connection failed",
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
export { generateEstimatedFeatures, estimateBPM, estimateKey };
