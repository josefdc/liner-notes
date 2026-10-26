/**
 * The last step of every result the API composes (the composer's and the fallback's): the
 * audio measurement goes into the result by code, in one pure step.
 *
 * The measurement is the audio service's AudioFeatures v2 block (the contract's `audio`), as the
 * engineer received it. `finalizeResult` writes that block into the result, sets
 * `run.analyzerVersion` to the block's `analyzerVersion`, and derives the flat copies the web
 * app has always read (bpm, key, energy, valence, danceability, acousticness, keyMoments,
 * audioSource, audioConfidence, audioUnavailableReason) from the block alone. Whatever a draft
 * carries in those fields (a model answer cast to hold `bpm`, a value from older code) is
 * replaced: no model output reaches them, and the model's schema has no field for them.
 *
 * A result without a measurement carries no block, `run.analyzerVersion` is null and every copy
 * is null. A block is never built here: a measurement that is not a v2 block the contract reads
 * (a v1 payload, a state written by older code) counts as no measurement.
 *
 * Energy. The service measures loudness: the mean RMS of the preview (`audio.loudness.rmsMean`,
 * shown as dBFS RMS). The `energy` copy keeps the 0..1 scale of the service's first version,
 * (rmsMean - 0.02) / 0.25, only where that scale says something: at or above about -11.4 dBFS
 * RMS (rmsMean 0.27, ordinary for modern masters) it reads 1 for every track, and at or below
 * -34 dBFS it reads 0, the same as silence. There the copy is null rather than a saturated
 * number; the loudness stays in the block as measured. No other energy scale is made up.
 *
 * Why a value is missing. The block says why each value it leaves null was withheld
 * (`audio.withheld`, from analyzer 2.3.0; the service's reasons, plus `out_of_range` for a mood
 * head the API drops because it lies outside its own range, see readServiceMeasurement). It
 * stays in the block: no flat field repeats it. A null `energy` beside a measured loudness
 * means the copy's scale saturates (ENERGY_RMS_OFFSET and ENERGY_RMS_SPAN below); that copy is
 * not part of the block, so readers say so themselves.
 */

import {
  type AudioFeatures,
  AudioFeatures as AudioFeaturesSchema,
  audioFeaturesIssues,
  measuredAudio,
  measuredKeyLabel,
  type ModelScore,
} from "@liner-notes/contract";
import type { TrackData } from "./schema.js";
import type { AudioMeasurement } from "./state.js";

/** The first service version's energy scale: (rmsMean - offset) / span, clipped to 0..1. */
export const ENERGY_RMS_OFFSET = 0.02;
export const ENERGY_RMS_SPAN = 0.25;

const round3 = (value: number) => Math.round(value * 1000) / 1000;

/**
 * The `energy` copy of a measured mean RMS: the first service version's 0..1 scale, rounded to
 * three places, or null where that scale saturates (it would read 0 or 1 whatever the track).
 */
export function energyFromLoudness(rmsMean: number): number | null {
  if (!Number.isFinite(rmsMean)) return null;
  const scaled = round3((rmsMean - ENERGY_RMS_OFFSET) / ENERGY_RMS_SPAN);
  return scaled > 0 && scaled < 1 ? scaled : null;
}

/** A mean RMS (linear, full scale 1) in dBFS, or null for silence. */
export function loudnessDbfs(rmsMean: number): number | null {
  return Number.isFinite(rmsMean) && rmsMean > 0 ? 20 * Math.log10(rmsMean) : null;
}

/**
 * A mood head's output on 0..1, mapped linearly from the head's own range (DEAM valence's 1..9
 * becomes (value - 1) / 8, as the service's first version did), rounded to three places; null
 * without the head or when its output lies outside its range.
 */
export function moodScore(score: ModelScore | null | undefined): number | null {
  if (!score) return null;
  const [low, high] = score.range;
  if (!Number.isFinite(score.value) || !Number.isFinite(low) || !Number.isFinite(high)) {
    return null;
  }
  if (!(high > low) || score.value < low || score.value > high) return null;
  return round3((score.value - low) / (high - low));
}

/**
 * The measurement's v2 block as the result may carry it: one that fits the contract and breaks
 * none of its rules (`audioFeaturesIssues`), else null.
 */
export function emittableAudio(
  measurement: AudioMeasurement | null | undefined,
): AudioFeatures | null {
  const block = (measurement as { audio?: unknown } | null | undefined)?.audio;
  if (block == null) return null;
  const parsed = AudioFeaturesSchema.safeParse(block);
  if (!parsed.success) return null;
  return audioFeaturesIssues(parsed.data).length === 0 ? parsed.data : null;
}

/** The result's audio fields: the block and the copies derived from it. */
export type MeasuredAudioFields = Pick<
  TrackData,
  | "bpm"
  | "key"
  | "energy"
  | "valence"
  | "danceability"
  | "acousticness"
  | "keyMoments"
  | "audioSource"
  | "audioConfidence"
  | "audioUnavailableReason"
> & { audio?: AudioFeatures };

/**
 * The result's audio fields from the measurement, by code only:
 * - no block (nothing measured, or not a block the contract reads): no `audio`, every copy null,
 *   no key moments, and the reason the engineer gave (`not_run` when it gave none, e.g. older
 *   state; `analysis_failed` for a block that cannot be read);
 * - a block: `audio` is the block, and each copy is set only when what it is taken from was
 *   measured (a passed gate and that block): `bpm` is the tempo rounded to a whole BPM, `key`
 *   the measured key ("A# Minor"), `energy` from the loudness where its scale says something
 *   (energyFromLoudness), the mood copies from the mood heads (moodScore), the key moments as
 *   measured. audioSource is "analyzed" with a tempo and a key; audioConfidence is "high" when
 *   the loudness and the valence, danceability, acoustic and instrumental heads were measured
 *   too. Without a tempo or a key, or when the gate did not pass, the reason is `not_detected`.
 */
export function measuredAudioFields(
  measurement: AudioMeasurement | null | undefined,
): MeasuredAudioFields {
  const audio = emittableAudio(measurement);
  if (!audio) {
    const unreadable = (measurement as { audio?: unknown } | null | undefined)?.audio != null;
    return {
      bpm: null,
      key: null,
      energy: null,
      valence: null,
      danceability: null,
      acousticness: null,
      keyMoments: [],
      audioSource: "unavailable",
      audioConfidence: "low",
      audioUnavailableReason: unreadable
        ? "analysis_failed"
        : (measurement?.unavailableReason ?? "not_run"),
    };
  }

  const passed = measuredAudio(audio);
  const tempo = passed ? audio.tempo : null;
  const key = passed ? audio.key : null;
  const loudness = passed ? audio.loudness : null;
  const moods = passed ? (audio.fingerprint?.moods ?? null) : null;
  const analyzed = tempo !== null && key !== null;
  const complete =
    analyzed &&
    loudness !== null &&
    [moods?.valence, moods?.danceability, moods?.acoustic, moods?.instrumental].every(
      (head) => moodScore(head) !== null,
    );
  return {
    audio,
    bpm: tempo ? Math.round(tempo.bpm) : null,
    key: key ? measuredKeyLabel(key) : null,
    energy: loudness ? energyFromLoudness(loudness.rmsMean) : null,
    valence: moodScore(moods?.valence),
    danceability: moodScore(moods?.danceability),
    acousticness: moodScore(moods?.acoustic),
    keyMoments: passed ? audio.keyMoments : [],
    audioSource: analyzed ? "analyzed" : "unavailable",
    audioConfidence: complete ? "high" : "low",
    ...(analyzed ? {} : { audioUnavailableReason: "not_detected" as const }),
  };
}

/** The fields finalizeResult writes; whatever a draft holds in them is dropped first. */
const AUDIO_FIELDS = [
  "audio",
  "bpm",
  "key",
  "energy",
  "valence",
  "danceability",
  "acousticness",
  "keyMoments",
  "audioSource",
  "audioConfidence",
  "audioUnavailableReason",
] as const;

/** A result before finalizeResult: whatever it holds in the audio fields is replaced. */
export type ResultDraft = Omit<TrackData, "bpm"> & Partial<Pick<TrackData, "bpm">>;

/**
 * The result with its audio fields from the measurement (measuredAudioFields) and, when it has
 * run information, `run.analyzerVersion` from the block (null without one). Pure: the draft is
 * not changed.
 */
export function finalizeResult(
  draft: ResultDraft,
  measurement: AudioMeasurement | null | undefined,
): TrackData {
  const kept: Record<string, unknown> = { ...draft };
  for (const field of AUDIO_FIELDS) delete kept[field];
  const fields = measuredAudioFields(measurement);
  const result = { ...kept, ...fields } as TrackData;
  if (draft.run) {
    result.run = { ...draft.run, analyzerVersion: fields.audio?.analyzerVersion ?? null };
  }
  return result;
}
