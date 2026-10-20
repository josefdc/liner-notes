/**
 * AudioFeatures v2: what the audio service measures on a track's preview.
 *
 * Only the audio service writes these values, and only code copies them into a TrackAnalysis.
 * No schema a language model fills has a field for any of them (see llm.ts).
 *
 * Every block is `null` when it was not measured: the service gates silence, noise and
 * too-short input (`gate`), and the model blocks are `null` when the models are not loaded.
 * Signal values (`basis: "signal"`) come from DSP; model values (`basis: "model"`) are
 * classifier or regression outputs, i.e. scores and not probabilities, and name the model.
 *
 * Times are seconds from the start of the analysed preview window, not of the full track.
 * The JSON Schema built from `AudioFeatures` ships as `dist/audio-features.schema.json` for the
 * service's own tests; the service emits these field names as they are (camelCase).
 */

import { z } from "zod/v4";
import { ModelRef, UnitInterval } from "./common.js";

/** The `version` field of every AudioFeatures object. */
export const AUDIO_FEATURES_VERSION = 2;

const Seconds = z.number().min(0);

export const SignalBasis = z.literal("signal");
export const ModelBasis = z.literal("model");

/** Pitch classes with sharps, as the audio service names them. */
export const PitchClass = z.enum(["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]);
export type PitchClass = z.infer<typeof PitchClass>;

export const KeyMode = z.enum(["major", "minor"]);
export type KeyMode = z.infer<typeof KeyMode>;

/** Why the service measured nothing on a preview. */
export const AudioGateReason = z.enum(["silence", "noise", "too_short"]);
export type AudioGateReason = z.infer<typeof AudioGateReason>;

/** A notable moment in the preview (peaks, drops, onsets, harmonic changes, silences). */
export const KeyMoment = z.object({
  time: Seconds.describe("Seconds from the start of the preview"),
  type: z.enum(["energy_peak", "energy_drop", "onset", "harmonic_change", "silence"]),
  intensity: UnitInterval,
  description: z.string(),
});
export type KeyMoment = z.infer<typeof KeyMoment>;

export const Tempo = z.object({
  bpm: z.number().positive(),
  confidence: UnitInterval.nullable().describe("Estimator confidence; null when it gives none"),
  method: z.string().min(1).describe("Estimator, e.g. 'essentia.RhythmExtractor2013'"),
  basis: SignalBasis,
});

export const MusicalKey = z.object({
  tonic: PitchClass,
  mode: KeyMode,
  strength: UnitInterval.nullable().describe("Key strength from the estimator; null when none"),
  profile: z.string().min(1).describe("Key profile used, e.g. 'edma' or 'krumhansl'"),
  method: z.string().min(1).describe("Estimator, e.g. 'essentia.KeyExtractor'"),
  basis: SignalBasis,
});

/** Mean RMS of the preview (what the first service version called "energy"). */
export const Loudness = z.object({
  rmsMean: z.number().min(0).describe("Mean RMS amplitude, linear, full scale = 1"),
  method: z.string().min(1),
  basis: SignalBasis,
});

export const BeatGrid = z.object({
  times: z.array(Seconds).describe("Beat positions in seconds, ascending"),
  method: z.string().min(1),
  basis: SignalBasis,
});

export const EnergyContour = z.object({
  hopSeconds: z.number().positive(),
  values: z.array(z.number().min(0)).describe("RMS per hop, from the start of the preview"),
  method: z.string().min(1),
  basis: SignalBasis,
});

/** Neutral sections (A, B, ...) found by novelty on beat-synchronous chroma; not verse/chorus. */
export const Sections = z.object({
  segments: z.array(
    z.object({
      label: z.string().min(1).describe("Neutral label: 'A', 'B', ..."),
      start: Seconds,
      end: Seconds,
    }),
  ),
  method: z.string().min(1),
  basis: SignalBasis,
});

export const LabelScore = z.object({
  label: z.string().min(1),
  score: z.number().describe("Model activation; a score, not a probability"),
});

/** EffNet-Discogs activations over the 400 Discogs styles, highest first (top k). */
export const StyleActivations = z.object({
  model: ModelRef,
  top: z.array(LabelScore),
  basis: ModelBasis,
});

/** MusiCNN activations over its 50 tags, highest first. */
export const TagActivations = z.object({
  model: ModelRef,
  scores: z.array(LabelScore),
  basis: ModelBasis,
});

/** One mood or classification head: its output, the range that output lives in, and its model. */
export const ModelScore = z.object({
  value: z.number(),
  range: z
    .tuple([z.number(), z.number()])
    .describe("Output range of the head, e.g. [0, 1], or [1, 9] for DEAM valence and arousal"),
  model: ModelRef,
  basis: ModelBasis,
});
export type ModelScore = z.infer<typeof ModelScore>;

export const MoodHeads = z.object({
  danceability: ModelScore.nullable(),
  acoustic: ModelScore.nullable(),
  instrumental: ModelScore.nullable().describe("Voice/instrumental head: the instrumental output"),
  valence: ModelScore.nullable(),
  arousal: ModelScore.nullable(),
});

export const Fingerprint = z.object({
  styles: StyleActivations.nullable(),
  tags: TagActivations.nullable(),
  moods: MoodHeads.nullable(),
});

const MEASURED_BLOCKS = [
  "tempo",
  "key",
  "loudness",
  "beats",
  "energyContour",
  "sections",
  "fingerprint",
] as const;

export const AudioFeatures = z
  .object({
    version: z.literal(AUDIO_FEATURES_VERSION),
    analyzerVersion: z
      .string()
      .min(1)
      .describe("Semver of the feature contract plus model ids; part of the cache key"),
    window: z.object({
      kind: z.literal("preview-30s"),
      durationSeconds: Seconds.describe("Length of the decoded preview"),
    }),
    gate: z
      .object({
        passed: z.boolean(),
        reason: AudioGateReason.nullable().describe("Set exactly when the gate did not pass"),
      })
      .refine((gate) => gate.passed === (gate.reason === null), {
        message: "a gate that did not pass needs a reason, and only then",
      }),
    tempo: Tempo.nullable(),
    key: MusicalKey.nullable(),
    loudness: Loudness.nullable(),
    beats: BeatGrid.nullable(),
    energyContour: EnergyContour.nullable(),
    sections: Sections.nullable(),
    keyMoments: z.array(KeyMoment),
    fingerprint: Fingerprint.nullable().describe("null when the models are not loaded"),
  })
  .superRefine((audio, ctx) => {
    // Gated input (silence, noise, too short) measures nothing: no tempo, no "C major".
    if (audio.gate.passed) return;
    for (const block of MEASURED_BLOCKS) {
      if (audio[block] !== null) {
        ctx.addIssue({ code: "custom", path: [block], message: "must be null when gated" });
      }
    }
    if (audio.keyMoments.length > 0) {
      ctx.addIssue({ code: "custom", path: ["keyMoments"], message: "must be empty when gated" });
    }
  });
export type AudioFeatures = z.infer<typeof AudioFeatures>;
