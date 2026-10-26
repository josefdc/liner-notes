import type {
  AudioFeatures,
  AudioWithheldCode,
  KeyMoment,
  ModelScore,
} from '@liner-notes/contract';

// Reading the `audio` block of a result: the measurement itself (AudioFeatures v2), with each
// value's method, confidence and basis.
//
// The stream reader hands the app the contract's own reading of the block (hooks/agent/events.ts:
// null when the contract cannot read it). This reader decides the same way on its own, so a
// result that did not come through it (a component given a result directly, as in the tests)
// is read as the contract reads it: the whole block or nothing. A block the contract rejects anywhere (a malformed section, a model
// without a licence, an unknown gate reason) is not a measurement, and nothing in it is shown as
// measured. Its key moments are the one tolerant list: entries it cannot read are dropped, as
// the contract does. audio.property.test.ts checks this against the contract's schema.
//
// Why the service withheld a value (`withheld`, analyzer 2.3.0 and later) is read as the contract
// reads it: a reason this page cannot read (an unknown code, a malformed entry) is left out, and
// never rejects the block.

type Tempo = NonNullable<AudioFeatures['tempo']>;
type MusicalKey = NonNullable<AudioFeatures['key']>;
type Loudness = NonNullable<AudioFeatures['loudness']>;
type Fingerprint = NonNullable<AudioFeatures['fingerprint']>;
type Styles = NonNullable<Fingerprint['styles']>;
type Tags = NonNullable<Fingerprint['tags']>;
type Moods = NonNullable<Fingerprint['moods']>;

export type MoodHead = keyof Moods;
export const MOOD_HEADS: readonly MoodHead[] = [
  'valence',
  'arousal',
  'danceability',
  'acoustic',
  'instrumental',
];

/** A withheld value's reason: the service's code and its own words. */
export interface WithheldReason {
  code: AudioWithheldCode;
  reason: string;
}

/** The fields the service gives a reason for (`withheld`); the mood heads have their own. */
export const WITHHELD_FIELDS = [
  'tempo',
  'key',
  'loudness',
  'beats',
  'energyContour',
  'sections',
  'fingerprint',
  'styles',
  'tags',
] as const;
export type WithheldField = (typeof WITHHELD_FIELDS)[number];

/** Why each null value is null, as far as the block says; empty for an older analyzer. */
export interface MeasuredWithheld {
  fields: Partial<Record<WithheldField, WithheldReason>>;
  moods: Partial<Record<MoodHead, WithheldReason>>;
}

/** The parts of a result's `audio` block the result screens show. */
export interface MeasuredAudio {
  analyzerVersion: string;
  /** Length of the decoded preview window, in seconds. */
  windowSeconds: number;
  gate: { passed: boolean; reason: string | null };
  // Every block is null when the gate did not pass, and null when it was not measured.
  tempo: Tempo | null;
  key: MusicalKey | null;
  loudness: Loudness | null;
  /** null when the audio models were not loaded. */
  fingerprint: { styles: Styles | null; tags: Tags | null; moods: Moods | null } | null;
  /** Times are seconds from the start of the preview window (moments past it are kept). */
  keyMoments: KeyMoment[];
  /** Why the service withheld each missing value, where it says. */
  withheld: MeasuredWithheld;
}

type Obj = Record<string, unknown>;
type Check = (value: unknown) => boolean;

const isObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isSeconds = (value: unknown) => isNumber(value) && value >= 0;
const isPositive = (value: unknown) => isNumber(value) && value > 0;
const isText = (value: unknown) => typeof value === 'string' && value.length > 0;
const isUnit = (value: unknown) => isNumber(value) && value >= 0 && value <= 1;
const isRange = (value: unknown) =>
  Array.isArray(value) && value.length === 2 && isNumber(value[0]) && isNumber(value[1]);
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const listOf =
  (check: Check): Check =>
  (value) =>
    Array.isArray(value) && value.every(check);

// The contract's enums, mirrored here so the page loads no schema; audio.property.test.ts checks
// that each equals the contract's own.
export const PITCH_CLASSES: ReadonlySet<string> = new Set([
  'C',
  'C#',
  'D',
  'D#',
  'E',
  'F',
  'F#',
  'G',
  'G#',
  'A',
  'A#',
  'B',
]);
export const KEY_MODES: ReadonlySet<string> = new Set(['major', 'minor']);
export const MOMENT_TYPES: ReadonlySet<string> = new Set([
  'energy_peak',
  'energy_drop',
  'onset',
  'harmonic_change',
  'silence',
]);
export const GATE_REASONS: ReadonlySet<string> = new Set(['silence', 'noise', 'too_short']);
/** The contract's AUDIO_TEMPO_RANGE_BPM: the tempo range the estimators search. */
export const TEMPO_RANGE_BPM = [40, 208] as const;
export const WITHHELD_CODES: ReadonlySet<string> = new Set([
  'gate_silence',
  'gate_noise',
  'gate_too_short',
  'no_beat',
  'tempo_out_of_range',
  'too_few_beats',
  'low_confidence',
  'unsteady_tempo',
  'no_tempo_estimate',
  'no_sustained_pitch',
  'speech_like',
  'one_harmonic_series',
  'one_held_pitch',
  'no_pitch_track',
  'few_pitch_classes',
  'one_pitched_source',
  'low_key_strength',
  'no_key_estimate',
  'models_not_loaded',
  'not_music',
  'model_failed',
  'out_of_range',
  'non_music_style',
  'estimate_failed',
]);
export const WINDOW_KIND = 'preview-30s';
export const SIGNAL_BASIS = 'signal';
export const MODEL_BASIS = 'model';

/** A signal block: its own fields, a method, and basis "signal". */
const signal =
  (fields: (block: Obj) => boolean): Check =>
  (value) =>
    isObject(value) && value.basis === SIGNAL_BASIS && isText(value.method) && fields(value);

const isModelRef: Check = (value) => isObject(value) && isText(value.id) && isText(value.licence);
const isLabelScore: Check = (value) =>
  isObject(value) && isText(value.label) && isNumber(value.score);
const isModelScore: Check = (value) =>
  isObject(value) &&
  value.basis === MODEL_BASIS &&
  isNumber(value.value) &&
  isRange(value.range) &&
  isModelRef(value.model);
const isRawScore: Check = (value) =>
  isObject(value) && isNumber(value.value) && isRange(value.range);

const isTempo = signal(
  (b) =>
    isPositive(b.bpm) &&
    nullable(isUnit)(b.confidence) &&
    (b.rawConfidence === undefined || nullable(isRawScore)(b.rawConfidence)),
);
const isKey = signal(
  (b) =>
    typeof b.tonic === 'string' &&
    PITCH_CLASSES.has(b.tonic) &&
    typeof b.mode === 'string' &&
    KEY_MODES.has(b.mode) &&
    nullable(isUnit)(b.strength) &&
    isText(b.profile),
);
const isLoudness = signal((b) => isSeconds(b.rmsMean));
const isBeats = signal((b) => listOf(isSeconds)(b.times));
const isEnergyContour = signal((b) => isPositive(b.hopSeconds) && listOf(isSeconds)(b.values));
const isSections = signal((b) =>
  listOf(
    (segment) =>
      isObject(segment) &&
      isText(segment.label) &&
      isSeconds(segment.start) &&
      isSeconds(segment.end),
  )(b.segments),
);
const isKeyMoment = (value: unknown): value is KeyMoment =>
  isObject(value) &&
  isSeconds(value.time) &&
  typeof value.type === 'string' &&
  MOMENT_TYPES.has(value.type) &&
  isUnit(value.intensity) &&
  typeof value.description === 'string';
const modelList =
  (field: string): Check =>
  (value) =>
    isObject(value) &&
    value.basis === MODEL_BASIS &&
    isModelRef(value.model) &&
    listOf(isLabelScore)(value[field]);
const isMoods: Check = (value) =>
  isObject(value) && MOOD_HEADS.every((head) => nullable(isModelScore)(value[head]));
const isFingerprint: Check = (value) =>
  isObject(value) &&
  nullable(modelList('top'))(value.styles) &&
  nullable(modelList('scores'))(value.tags) &&
  nullable(isMoods)(value.moods);

/**
 * True when the contract's AudioFeatures schema accepts the block. The key moments are a
 * tolerant list (an array whose unreadable entries are dropped), as in the contract.
 */
export function isAudioFeatures(value: unknown): value is AudioFeatures {
  if (!isObject(value)) return false;
  const { window, gate } = value;
  return (
    value.version === 2 &&
    isText(value.analyzerVersion) &&
    isObject(window) &&
    window.kind === WINDOW_KIND &&
    isSeconds(window.durationSeconds) &&
    isObject(gate) &&
    typeof gate.passed === 'boolean' &&
    (gate.reason === null || (typeof gate.reason === 'string' && GATE_REASONS.has(gate.reason))) &&
    nullable(isTempo)(value.tempo) &&
    nullable(isKey)(value.key) &&
    nullable(isLoudness)(value.loudness) &&
    nullable(isBeats)(value.beats) &&
    nullable(isEnergyContour)(value.energyContour) &&
    nullable(isSections)(value.sections) &&
    Array.isArray(value.keyMoments) &&
    nullable(isFingerprint)(value.fingerprint)
  );
}

const isWithheldReason = (value: unknown): value is WithheldReason =>
  isObject(value) &&
  typeof value.code === 'string' &&
  WITHHELD_CODES.has(value.code) &&
  isText(value.reason);

/** The block's `withheld` reasons this page can read; the others are left out. */
export function readWithheld(value: unknown): MeasuredWithheld {
  const withheld: MeasuredWithheld = { fields: {}, moods: {} };
  if (!isObject(value)) return withheld;
  for (const field of WITHHELD_FIELDS) {
    const reason = value[field];
    if (isWithheldReason(reason))
      withheld.fields[field] = { code: reason.code, reason: reason.reason };
  }
  const moods = value.moods;
  if (isObject(moods)) {
    for (const head of MOOD_HEADS) {
      const reason = moods[head];
      if (isWithheldReason(reason))
        withheld.moods[head] = { code: reason.code, reason: reason.reason };
    }
  }
  return withheld;
}

const byScore = (items: { label: string; score: number }[]) =>
  items.map(({ label, score }) => ({ label, score })).sort((a, b) => b.score - a.score);

/**
 * The result's measurement, or null when it has none this page can read: no `audio` block, a
 * null one, or one the contract rejects. A gate that did not pass leaves every block null and
 * no key moments, whatever the payload carries.
 */
export function readAudio(value: unknown): MeasuredAudio | null {
  if (!isAudioFeatures(value)) return null;
  const read = {
    analyzerVersion: value.analyzerVersion,
    windowSeconds: value.window.durationSeconds,
    gate: { passed: value.gate.passed, reason: value.gate.reason },
    withheld: readWithheld((value as Obj).withheld),
  };
  if (!value.gate.passed) {
    return { ...read, tempo: null, key: null, loudness: null, fingerprint: null, keyMoments: [] };
  }
  const fingerprint = value.fingerprint;
  return {
    ...read,
    tempo: value.tempo,
    key: value.key,
    loudness: value.loudness,
    fingerprint: fingerprint && {
      styles: fingerprint.styles && { ...fingerprint.styles, top: byScore(fingerprint.styles.top) },
      tags: fingerprint.tags && { ...fingerprint.tags, scores: byScore(fingerprint.tags.scores) },
      moods: fingerprint.moods,
    },
    keyMoments: (value.keyMoments as unknown[]).filter(isKeyMoment),
  };
}

/** The key as the result's `key` copy writes it, e.g. "A# Minor". */
export function keyLabel(key: MusicalKey): string {
  return `${key.tonic} ${key.mode === 'major' ? 'Major' : 'Minor'}`;
}

/**
 * True when an analyzer version names the model set it ran with (`2.2.0+essentia.models-…`):
 * the service names one exactly when its audio models were loaded.
 */
export function namesModelSet(analyzerVersion: string): boolean {
  return /[+.]models-/.test(analyzerVersion);
}

/** Mean RMS as dBFS (full scale = 0 dB), or null for a zero level (no finite value). */
export function rmsToDbfs(rmsMean: number): number | null {
  return rmsMean > 0 ? 20 * Math.log10(rmsMean) : null;
}

/** True when a model score lies inside the range its model produces. */
export function inModelRange(score: ModelScore): boolean {
  const [low, high] = score.range;
  return score.value >= Math.min(low, high) && score.value <= Math.max(low, high);
}
