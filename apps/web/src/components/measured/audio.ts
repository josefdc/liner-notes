import type { AudioFeatures, KeyMoment, ModelScore } from '@liner-notes/contract';

// Reading the `audio` block of a result: the measurement itself (AudioFeatures v2), with each
// value's method, confidence and basis. The result reaches the page as the server wrote it, so
// the block is checked here, field by field, without loading the contract's schemas (and zod)
// with the page. A block this page cannot read counts as no measurement; a block inside it that
// cannot be read counts as not measured. Nothing is filled in.

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

/** The parts of a result's `audio` block the result screens show, as read from the payload. */
export interface MeasuredAudio {
  analyzerVersion: string;
  /** Length of the decoded preview window, in seconds. */
  windowSeconds: number;
  gate: { passed: boolean; reason: string | null };
  // Every block is null when the gate did not pass, and null when it was not measured or
  // cannot be read.
  tempo: Tempo | null;
  key: MusicalKey | null;
  loudness: Loudness | null;
  /** null when the audio models were not loaded (or the block cannot be read). */
  fingerprint: { styles: Styles | null; tags: Tags | null; moods: Moods | null } | null;
  /** Times are seconds from the start of the preview window (moments past it are kept). */
  keyMoments: KeyMoment[];
}

type Obj = Record<string, unknown>;

const isObject = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);
const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isUnit = (value: unknown): value is number => isNumber(value) && value >= 0 && value <= 1;
const isRange = (value: unknown): value is [number, number] =>
  Array.isArray(value) && value.length === 2 && isNumber(value[0]) && isNumber(value[1]);
const isModel = (value: unknown): value is Obj & { id: string } =>
  isObject(value) && isText(value.id);

const PITCH_CLASSES = new Set(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);
const MOMENT_TYPES = new Set(['energy_peak', 'energy_drop', 'onset', 'harmonic_change', 'silence']);

function readTempo(value: unknown): Tempo | null {
  if (!isObject(value) || value.basis !== 'signal') return null;
  const { bpm, confidence, rawConfidence, method } = value;
  if (!isNumber(bpm) || bpm <= 0 || !isText(method)) return null;
  if (confidence !== null && !isUnit(confidence)) return null;
  const raw =
    isObject(rawConfidence) && isNumber(rawConfidence.value) && isRange(rawConfidence.range)
      ? { value: rawConfidence.value, range: rawConfidence.range }
      : null;
  return { bpm, confidence, rawConfidence: raw, method, basis: 'signal' };
}

function readKey(value: unknown): MusicalKey | null {
  if (!isObject(value) || value.basis !== 'signal') return null;
  const { tonic, mode, strength, profile, method } = value;
  if (typeof tonic !== 'string' || !PITCH_CLASSES.has(tonic)) return null;
  if (mode !== 'major' && mode !== 'minor') return null;
  if (strength !== null && !isUnit(strength)) return null;
  if (!isText(profile) || !isText(method)) return null;
  return { tonic: tonic as MusicalKey['tonic'], mode, strength, profile, method, basis: 'signal' };
}

function readLoudness(value: unknown): Loudness | null {
  if (!isObject(value) || value.basis !== 'signal') return null;
  const { rmsMean, method } = value;
  if (!isNumber(rmsMean) || rmsMean < 0 || !isText(method)) return null;
  return { rmsMean, method, basis: 'signal' };
}

function readLabelScores(value: unknown) {
  if (!Array.isArray(value)) return null;
  const scores = value.filter(
    (item): item is { label: string; score: number } =>
      isObject(item) && isText(item.label) && isNumber(item.score),
  );
  // Highest first, whatever order they were sent in.
  return scores.map(({ label, score }) => ({ label, score })).sort((a, b) => b.score - a.score);
}

function readStyles(value: unknown): Styles | null {
  if (!isObject(value) || value.basis !== 'model' || !isModel(value.model)) return null;
  const top = readLabelScores(value.top);
  return top ? { model: readModel(value.model), top, basis: 'model' } : null;
}

function readTags(value: unknown): Tags | null {
  if (!isObject(value) || value.basis !== 'model' || !isModel(value.model)) return null;
  const scores = readLabelScores(value.scores);
  return scores ? { model: readModel(value.model), scores, basis: 'model' } : null;
}

function readModel(model: Obj & { id: string }) {
  return { id: model.id, licence: typeof model.licence === 'string' ? model.licence : '' };
}

function readModelScore(value: unknown): ModelScore | null {
  if (!isObject(value) || value.basis !== 'model' || !isModel(value.model)) return null;
  if (!isNumber(value.value) || !isRange(value.range)) return null;
  return { value: value.value, range: value.range, model: readModel(value.model), basis: 'model' };
}

function readMoods(value: unknown): Moods | null {
  if (!isObject(value)) return null;
  const moods = {} as Moods;
  for (const head of MOOD_HEADS) moods[head] = readModelScore(value[head]);
  return moods;
}

function readFingerprint(value: unknown): MeasuredAudio['fingerprint'] {
  if (!isObject(value)) return null;
  return {
    styles: readStyles(value.styles),
    tags: readTags(value.tags),
    moods: readMoods(value.moods),
  };
}

function readKeyMoments(value: unknown): KeyMoment[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is KeyMoment =>
      isObject(item) &&
      isNumber(item.time) &&
      item.time >= 0 &&
      typeof item.type === 'string' &&
      MOMENT_TYPES.has(item.type) &&
      isUnit(item.intensity) &&
      typeof item.description === 'string',
  );
}

/**
 * The result's measurement, or null when it has none this page can read (no `audio` block, a
 * null one, another version, or no window or gate). A gate that did not pass leaves every
 * block null and no key moments, whatever the payload carries.
 */
export function readAudio(value: unknown): MeasuredAudio | null {
  if (!isObject(value) || value.version !== 2 || !isText(value.analyzerVersion)) return null;
  const { window, gate } = value;
  if (!isObject(window) || window.kind !== 'preview-30s' || !isNumber(window.durationSeconds)) {
    return null;
  }
  if (window.durationSeconds < 0 || !isObject(gate) || typeof gate.passed !== 'boolean') {
    return null;
  }
  const windowSeconds = window.durationSeconds;
  const read = {
    analyzerVersion: value.analyzerVersion,
    windowSeconds,
    gate: { passed: gate.passed, reason: typeof gate.reason === 'string' ? gate.reason : null },
  };
  if (!gate.passed) {
    return { ...read, tempo: null, key: null, loudness: null, fingerprint: null, keyMoments: [] };
  }
  return {
    ...read,
    tempo: readTempo(value.tempo),
    key: readKey(value.key),
    loudness: readLoudness(value.loudness),
    fingerprint: readFingerprint(value.fingerprint),
    keyMoments: readKeyMoments(value.keyMoments),
  };
}

/** The key as the result's `key` copy writes it, e.g. "A# Minor". */
export function keyLabel(key: MusicalKey): string {
  return `${key.tonic} ${key.mode === 'major' ? 'Major' : 'Minor'}`;
}

/** Mean RMS as dBFS (full scale = 0 dB), or null for silence (no finite level). */
export function rmsToDbfs(rmsMean: number): number | null {
  return rmsMean > 0 ? 20 * Math.log10(rmsMean) : null;
}
