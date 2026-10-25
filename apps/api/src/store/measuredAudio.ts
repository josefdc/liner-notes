/**
 * What the audio cache accepts as a measurement, and the keys it files one under. Shared by the
 * cache's reads and writes and by the engineer, so all of them agree.
 *
 * A row holds the audio service's AudioFeatures v2 block as measured and how its clip was matched
 * to the track. It is filed under (track key, analyzer version):
 * - the track key is `isrc:<ISRC>` when the measured clip was matched by the track's ISRC, and
 *   `spotify:<Spotify id>` otherwise. ISRCs are reused (a karaoke or an extended entry can carry
 *   the original's), so only a clip found by the ISRC itself is filed under it: every track with
 *   that ISRC would be measured on that same clip. A clip matched by search or Spotify's own clip
 *   is the chosen track's only;
 * - the analyzer version is the block's `analyzerVersion` (semver of the analysis plus the
 *   estimator and the model set). A row measured by any other version is a miss and the track is
 *   measured again.
 * Rows written before migration 14 (flat values without the block) were dropped with their table:
 * a v2 block is never made up from them.
 */

import {
  type AudioFeatures,
  AudioFeatures as AudioFeaturesSchema,
  audioFeaturesIssues,
  measuredAudio,
  PreviewMatch,
} from "@liner-notes/contract";
import { z } from "zod";
import { measuredAudioFields } from "../agent/finalize.js";
import type { AudioMeasurement } from "../agent/state.js";
import type { PreviewSourceMatch } from "../sources/audio.js";

/**
 * A partial measurement (low confidence, e.g. the perceptual models were unavailable) is cached
 * for a day, so a complete measurement replaces it soon after the models are back.
 */
export const LOW_CONFIDENCE_AUDIO_TTL_MS = 24 * 60 * 60 * 1000;

/** A measurement the cache serves: a block, and how its clip was matched. */
export type CachedAudio = AudioMeasurement & {
  audio: AudioFeatures;
  previewMatch: PreviewSourceMatch;
};

/** How the measured clip was matched to the track (sources/audio.ts PreviewSourceMatch). */
const PreviewSourceMatchSchema = PreviewMatch.extend({
  deezerId: z.number().optional(),
});

const ISRC = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/** The ISRC in its canonical form (upper case, no hyphens or spaces), or null when malformed. */
export function canonicalIsrc(isrc: string | null | undefined): string | null {
  const canonical = (isrc ?? "").replace(/[\s-]/g, "").toUpperCase();
  return ISRC.test(canonical) ? canonical : null;
}

/** True when the clip was found by the track's ISRC (the contract's PreviewMatch `isrc`). */
function matchedByIsrc(match: PreviewSourceMatch): boolean {
  if (match.provider !== "deezer") return false;
  // A Deezer entry read by id that carries the requested ISRC has no score (deezer.ts).
  return match.method === "isrc" || (match.method === "id" && match.score === null);
}

/** The track key a measurement is filed under (see the top of this file). */
export function audioTrackKey(
  match: PreviewSourceMatch,
  spotifyId: string,
  isrc: string | null | undefined,
): string {
  const canonical = canonicalIsrc(isrc);
  return canonical && matchedByIsrc(match) ? `isrc:${canonical}` : `spotify:${spotifyId}`;
}

/**
 * The track keys to look a track up under, in order: its ISRC's (a clip found by that ISRC is the
 * clip this track would be measured on first), then its own.
 */
export function audioLookupKeys(spotifyId: string, isrc: string | null | undefined): string[] {
  const canonical = canonicalIsrc(isrc);
  return canonical ? [`isrc:${canonical}`, `spotify:${spotifyId}`] : [`spotify:${spotifyId}`];
}

/**
 * The measurement as the cache may store and serve it, or null: a v2 block that fits the contract
 * and its rules, whose gate passed with a tempo and a key, and that says how its clip was matched.
 */
export function cacheableAudio(measurement: unknown): CachedAudio | null {
  if (measurement === null || typeof measurement !== "object") return null;
  const { audio, previewMatch, outOfRange } = measurement as Record<string, unknown>;
  const block = AudioFeaturesSchema.safeParse(audio);
  const match = PreviewSourceMatchSchema.safeParse(previewMatch);
  if (!block.success || !match.success) return null;
  if (audioFeaturesIssues(block.data).length > 0 || !measuredAudio(block.data)) return null;
  if (!block.data.tempo || !block.data.key) return null;
  const dropped = z.array(z.string()).safeParse(outOfRange);
  return {
    audio: block.data,
    previewMatch: match.data as PreviewSourceMatch,
    ...(dropped.success && dropped.data.length > 0 ? { outOfRange: dropped.data } : {}),
  };
}

/** "high" for a complete measurement (finalize.ts), else "low". */
export function audioConfidence(measurement: CachedAudio): "high" | "low" {
  return measuredAudioFields(measurement).audioConfidence === "high" ? "high" : "low";
}

/** Parses stored `full_data` and returns it when it is a measurement the cache serves. */
export function parseCachedAudio(fullData: string): CachedAudio | null {
  try {
    return cacheableAudio(JSON.parse(fullData));
  } catch {
    return null;
  }
}
