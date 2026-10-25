/**
 * What the audio cache accepts as a measurement, and the keys it files one under. Shared by the
 * cache's reads and writes and by the engineer, so all of them agree.
 *
 * A row holds the audio service's AudioFeatures v2 block as measured and how its clip was matched
 * to the track. It is filed under (track key, analyzer version):
 * - the track key is the measuring track's own `spotify:<Spotify id>`, always; and also
 *   `isrc:<ISRC>:<Deezer id>` when the clip was a Deezer entry taken by the track's ISRC: the
 *   entry the ISRC lookup gave, its readable alternative (read by id, no score), or a search hit
 *   that carries the ISRC (deezer.ts marks all three `isrc`). The Deezer id is part of the key, so
 *   two entries that carry one ISRC never share or overwrite a row;
 * - the analyzer version is the block's `analyzerVersion` (semver of the analysis plus the
 *   estimator and the model set). A row measured by another version is a miss when the service
 *   names its version, and the track is measured again.
 * An `isrc:` row is not every track's with that ISRC: ISRCs are reused (a karaoke or an edit can
 * carry the original's), and Deezer's entries are judged against each requesting track (its
 * artist, title, version and duration). A track is looked up under the `isrc:` key of the entry
 * its own preview resolution took this run, and nothing else (`audioLookupKeys`; `isrcRowServes`
 * checks the row's entry again). Its own `spotify:` row is served whatever this run's resolution,
 * so a track keeps its measurement while Deezer cannot be read.
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
 * for a day. Loading the models changes the analyzer version, so a complete measurement is filed
 * under a key of its own and the partial row is simply no longer read.
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

/**
 * The Deezer entry's id when the clip was an entry taken by the track's ISRC (the contract's
 * PreviewMatch `isrc`), else null.
 */
export function isrcEntryId(match: PreviewSourceMatch | null | undefined): number | null {
  if (match?.provider !== "deezer" || typeof match.deezerId !== "number") return null;
  // A Deezer entry read by id that carries the requested ISRC has no score (deezer.ts).
  const byIsrc = match.method === "isrc" || (match.method === "id" && match.score === null);
  return byIsrc ? match.deezerId : null;
}

/** The `isrc:` key of the Deezer entry `match` took by ISRC, or null. */
function isrcKey(match: PreviewSourceMatch | null | undefined, isrc: string | null | undefined) {
  const canonical = canonicalIsrc(isrc);
  const entry = isrcEntryId(match);
  return canonical && entry !== null ? `isrc:${canonical}:${entry}` : null;
}

/** The track keys a measurement is filed under (see the top of this file): ISRC's first. */
export function audioTrackKeys(
  match: PreviewSourceMatch,
  spotifyId: string,
  isrc: string | null | undefined,
): string[] {
  const shared = isrcKey(match, isrc);
  return shared ? [shared, `spotify:${spotifyId}`] : [`spotify:${spotifyId}`];
}

/**
 * Whether a row found under `trackKey` may be served to the track whose preview resolution this
 * run gave `freshMatch`: a track's own (`spotify:`) row always; an `isrc:` row only when the
 * track's own resolution took, by ISRC, the same Deezer entry the row was measured on. With no
 * resolution (none found, Deezer not read) an `isrc:` row is not served.
 */
export function isrcRowServes(
  trackKey: string,
  row: CachedAudio,
  freshMatch: PreviewSourceMatch | null | undefined,
): boolean {
  if (!trackKey.startsWith("isrc:")) return true;
  const fresh = isrcEntryId(freshMatch);
  return fresh !== null && fresh === isrcEntryId(row.previewMatch);
}

/**
 * The track keys to look a track up under: the `isrc:` key of the entry this run's own preview
 * resolution took by ISRC, when it took one, then the track's own.
 */
export function audioLookupKeys(
  spotifyId: string,
  isrc: string | null | undefined,
  freshMatch: PreviewSourceMatch | null | undefined,
): string[] {
  const shared = isrcKey(freshMatch, isrc);
  return shared ? [shared, `spotify:${spotifyId}`] : [`spotify:${spotifyId}`];
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
