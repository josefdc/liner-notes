/**
 * What the audio cache accepts as a measurement. Shared by the cache's reads and writes and by
 * the migration that cleans rows written before measured-only writes, so all three agree.
 */

import { z } from "zod";
import type { AudioFeatures } from "../agent/state.js";

/**
 * A partial measurement (low confidence, e.g. the perceptual models were unavailable) is cached
 * for a day, so a complete measurement replaces it soon after the models are back.
 */
export const LOW_CONFIDENCE_AUDIO_TTL_MS = 24 * 60 * 60 * 1000;

const unitScore = z.number().min(0).max(1).nullable();

/** Audio features as the engineer caches them: measured, from the audio service. */
export const MeasuredAudioSchema = z
  .object({
    bpm: z.number().positive(),
    key: z.string().min(1),
    energy: unitScore,
    valence: unitScore,
    danceability: unitScore,
    acousticness: unitScore,
    instrumentalness: unitScore,
    confidence: z.enum(["low", "high"]),
    keyMoments: z.array(z.unknown()).optional(),
    unavailableReason: z.undefined(),
    measured: z.literal(true),
    analyzer: z.literal("audio-service"),
  })
  .passthrough();

/** True when `features` is a measurement the audio cache may store and serve. */
export function isMeasuredAudio(features: unknown): features is AudioFeatures {
  return MeasuredAudioSchema.safeParse(features).success;
}

/** Parses stored `full_data` and returns it when it is a valid measurement, else null. */
export function parseMeasuredAudio(fullData: string): AudioFeatures | null {
  let value: unknown;
  try {
    value = JSON.parse(fullData);
  } catch {
    return null;
  }
  const parsed = MeasuredAudioSchema.safeParse(value);
  return parsed.success ? (parsed.data as AudioFeatures) : null;
}
