/**
 * AudioFeatures v2: what the audio service measures on a track's preview.
 *
 * Only the audio service writes these values, and only code copies them into a TrackAnalysis.
 * No schema a language model fills has a field for any of them (see llm.ts).
 *
 * Every block is `null` when it was not measured: the service gates silence, noise and
 * too-short input (`gate`), and the model blocks are `null` when the models are not loaded.
 * A gate that did not pass leaves every measured block null and no key moments. A
 * cross-reference violation or an unknown value never rejects a result: readers accept a
 * payload that breaks this rule and show nothing measured for it; producers check it with
 * `audioFeaturesIssues()`, and the exported JSON Schema (`audioFeaturesJsonSchema()`) states
 * it with `if`/`then`.
 * `withheld` says, per field, which check left a value null (a stable code and the reason in
 * words); a reader that cannot read a reason drops that reason only.
 * Signal values (`basis: "signal"`) come from DSP; model values (`basis: "model"`) are
 * classifier or regression outputs, i.e. scores and not probabilities, and name the model.
 *
 * Times are seconds from the start of the analysed preview window, not of the full track.
 * The JSON Schema built from `AudioFeatures` ships as `dist/audio-features.schema.json` for the
 * service's own tests; the service emits these field names as they are (camelCase).
 */

import { z } from "zod";
import { ModelRef, UnitInterval } from "./common.js";
import { tolerantList } from "./tolerant.js";

/** The `version` field of every AudioFeatures object. */
export const AUDIO_FEATURES_VERSION = 2;

const Seconds = z.number().min(0);

export const SignalBasis = z.literal("signal");
export const ModelBasis = z.literal("model");

/**
 * Pitch classes, always spelled with sharps. Estimators that name flats (Essentia's
 * KeyExtractor answers Bb, Eb, Ab, Db and Gb) are mapped by the audio service to the
 * enharmonic sharp: Db -> C#, Eb -> D#, Gb -> F#, Ab -> G#, Bb -> A#.
 */
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

/** A value on the estimator's own scale, kept next to its normalised form. */
export const RawScore = z.object({
  value: z.number(),
  range: z.tuple([z.number(), z.number()]).describe("The estimator's scale, e.g. [0, 5.32]"),
});

export const Tempo = z.object({
  bpm: z.number().positive(),
  confidence: UnitInterval.nullable().describe(
    "Estimator confidence normalised to 0..1 by the audio service; null when the estimator " +
      "gives none. Essentia's RhythmExtractor2013 reports 0 to 5.32: the service divides by " +
      "5.32 and clips to 0..1, and keeps the reported value in rawConfidence.",
  ),
  rawConfidence: RawScore.nullable()
    .optional()
    .describe("The confidence as the estimator reported it, with its scale"),
  method: z.string().min(1).describe("Estimator, e.g. 'essentia.RhythmExtractor2013'"),
  basis: SignalBasis,
});

export const MusicalKey = z.object({
  tonic: PitchClass.describe("Spelled with sharps; the service maps flat names (Bb -> A#)"),
  mode: KeyMode,
  strength: UnitInterval.nullable().describe("Key strength from the estimator; null when none"),
  profile: z.string().min(1).describe("Key profile used, e.g. 'edma' or 'krumhansl'"),
  method: z.string().min(1).describe("Estimator, e.g. 'essentia.KeyExtractor'"),
  basis: SignalBasis,
});
export type MusicalKey = z.infer<typeof MusicalKey>;

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

/**
 * Why the service withheld a value, as a stable code (readers show their own words for it; the
 * service's `reason` says the same for logs and tools). A code a reader does not know drops that
 * one reason, never the measurement.
 * - the gate (every measured block): `gate_silence`, `gate_noise`, `gate_too_short`;
 * - tempo (and the beat grid, see AudioWithheld.beats): `no_beat` (the onsets do not repeat
 *   enough), `tempo_out_of_range` (the estimate is outside AUDIO_TEMPO_RANGE_BPM, the range the
 *   service accepts), `too_few_beats` (too few beats tracked to fit a tempo, or too few beat
 *   intervals to check that it holds), `low_confidence` (under the estimator's minimum; the
 *   confidence does not rank half- or double-tempo errors, and no check here does),
 *   `unsteady_tempo` (a part of the window disagrees with the tempo), `no_tempo_estimate` (an
 *   estimator that gives no reasons gave no tempo);
 * - key: `no_sustained_pitch` (too little energy in spectral lines), `speech_like` (one pitch
 *   line without stable notes), `one_harmonic_series` (the lines form one harmonic series),
 *   `one_held_pitch`, `no_pitch_track`, `few_pitch_classes`, `one_pitched_source` (the partials
 *   hold still, rise and fall together and spell one note or an open interval),
 *   `low_key_strength`, `no_key_estimate` (the estimator named no key);
 * - the fingerprint and its parts: `models_not_loaded`, `not_music` (no beat, and the key rules
 *   found one harmonic series, one held pitch or one pitch line without stable notes),
 *   `model_failed` (failed, or gave non-finite values or the wrong width), `out_of_range` (a mood
 *   head outside the range its model produces), `non_music_style` (the strongest Discogs style is
 *   a Non-Music one: the mood heads describe music only);
 * - any value: `estimate_failed` (the estimator raised, or gave a non-finite value).
 *
 * The codes name the check that fired, not a cause: the same check fires on different material
 * (spectral lines too weak for a key on drums alone and on a dense electronic mix alike).
 */
export const AudioWithheldCode = z.enum([
  "gate_silence",
  "gate_noise",
  "gate_too_short",
  "no_beat",
  "tempo_out_of_range",
  "too_few_beats",
  "low_confidence",
  "unsteady_tempo",
  "no_tempo_estimate",
  "no_sustained_pitch",
  "speech_like",
  "one_harmonic_series",
  "one_held_pitch",
  "no_pitch_track",
  "few_pitch_classes",
  "one_pitched_source",
  "low_key_strength",
  "no_key_estimate",
  "models_not_loaded",
  "not_music",
  "model_failed",
  "out_of_range",
  "non_music_style",
  "estimate_failed",
]);
export type AudioWithheldCode = z.infer<typeof AudioWithheldCode>;

/** The tempo range, in BPM, the service accepts from either estimator. */
export const AUDIO_TEMPO_RANGE_BPM = [40, 208] as const;

/** One withheld value: the code and the service's reason in words (no withheld value in it). */
export const WithheldReason = z.object({
  code: AudioWithheldCode,
  reason: z.string().min(1).describe("The check that withheld the value, in words"),
});
export type WithheldReason = z.infer<typeof WithheldReason>;

// A reason a reader cannot read (an unknown code, a malformed entry) is absent; the rest of the
// block is kept.
const reasonFor = () => WithheldReason.optional().catch(undefined);

/**
 * Why each null value of the block is null, per field. The service names a reason for every
 * measured block it leaves null; for the parts of a fingerprint it computed (styles, tags, each
 * mood head) when one is null; and none for a value it measured. A null fingerprint's parts have
 * no reasons of their own: `fingerprint` says why. Blocks from analyzers before 2.3.0 have none
 * of the service's reasons; the API still adds `moods.<head>: out_of_range` to such a block when
 * it drops a mood head itself, since that reason is the API's own and true for any analyzer.
 */
export const AudioWithheld = z.object({
  tempo: reasonFor(),
  key: reasonFor(),
  loudness: reasonFor(),
  beats: reasonFor().describe(
    "When no tempo was estimated, the grid is null with the tempo's reason. When a tempo was " +
      "estimated but withheld (unsteady_tempo, or too_few_beats on a short clip), a tracker " +
      "that follows tempo changes (Essentia) keeps its grid, with no reason; a tracker that " +
      "keeps one period (librosa) has a null grid, with the tempo's reason",
  ),
  energyContour: reasonFor(),
  sections: reasonFor(),
  fingerprint: reasonFor(),
  styles: reasonFor(),
  tags: reasonFor(),
  moods: z
    .object({
      danceability: reasonFor(),
      acoustic: reasonFor(),
      instrumental: reasonFor(),
      valence: reasonFor(),
      arousal: reasonFor(),
    })
    .optional()
    .catch(undefined),
});
export type AudioWithheld = z.infer<typeof AudioWithheld>;

/** The blocks a gate that did not pass leaves null. */
export const AUDIO_MEASURED_BLOCKS = [
  "tempo",
  "key",
  "loudness",
  "beats",
  "energyContour",
  "sections",
  "fingerprint",
] as const;

export const AudioFeatures = z.object({
  version: z.literal(AUDIO_FEATURES_VERSION),
  analyzerVersion: z
    .string()
    .min(1)
    .describe("Semver of the feature contract plus model ids; part of the cache key"),
  window: z.object({
    kind: z.literal("preview-30s"),
    durationSeconds: Seconds.describe("Length of the decoded preview"),
  }),
  gate: z.object({
    passed: z.boolean(),
    reason: AudioGateReason.nullable().describe("Set exactly when the gate did not pass"),
  }),
  tempo: Tempo.nullable(),
  key: MusicalKey.nullable(),
  loudness: Loudness.nullable(),
  beats: BeatGrid.nullable(),
  energyContour: EnergyContour.nullable(),
  sections: Sections.nullable(),
  keyMoments: tolerantList(KeyMoment),
  fingerprint: Fingerprint.nullable().describe("null when the models are not loaded"),
  withheld: AudioWithheld.optional()
    .catch(undefined)
    .describe("Why each null value is null (analyzer 2.3.0 and later)"),
});
export type AudioFeatures = z.infer<typeof AudioFeatures>;
