import type { ModelScore } from '@liner-notes/contract';
import {
  keyLabel,
  MOOD_HEADS,
  type MeasuredAudio,
  type MoodHead,
  readAudio,
  rmsToDbfs,
} from './components/measured/audio';
import { isWholeRecording } from './utils/recording';
import type {
  AudioUnavailableReason,
  Factoid,
  FactoidUnavailableCode,
  ModelUnavailableReason,
  QueryMatch,
  TrackData,
} from './types';

// How the result screens describe values that are missing. Nothing here stands in for a
// value: when a value is not known, the screens say so with this text.

/** Why the audio values are missing, in words, for each reason the API sends. */
export const AUDIO_UNAVAILABLE_TEXT: Record<AudioUnavailableReason, string> = {
  service_unavailable: 'The audio analysis service did not respond.',
  no_preview: 'No audio preview is available for this track.',
  preview_rejected: 'The audio preview is not from an allowed source, so it was not analysed.',
  analysis_failed: 'The audio analysis failed.',
  not_detected: 'The analysis ran but could not detect the tempo or key.',
  not_run: 'The audio analysis did not run.',
  low_confidence:
    'The analysis ran, but its tempo or key was below the confidence needed to show it.',
};

export function audioUnavailableText(reason: string | undefined): string {
  if (reason && Object.hasOwn(AUDIO_UNAVAILABLE_TEXT, reason)) {
    return AUDIO_UNAVAILABLE_TEXT[reason as AudioUnavailableReason];
  }
  return reason ? `The audio was not analysed (${reason}).` : 'The analysis did not report why.';
}

/**
 * Shown instead of audio values that were estimated (from the genre, or at random) rather
 * than measured. Sent as audioSource "estimated" by the API before audio values were measured
 * only, and still found in results it cached.
 */
export const ESTIMATED_AUDIO_TEXT = 'Estimated, not measured — not shown.';

/** Why the model was unavailable, in words, for each category the API sends. */
export const MODEL_UNAVAILABLE_TEXT: Record<ModelUnavailableReason, string> = {
  no_output: 'the model returned no output',
  rate_limited: 'quota or rate limit reached',
  timeout: 'the model timed out',
  auth: 'authentication or configuration problem',
  error: 'the model returned an error',
  budget_exhausted: 'live model calls are paused, budget reached',
};

/**
 * A short, fixed description of why the model was unavailable. Anything other than a known
 * category (older results carried the provider's error text) is never rendered.
 */
export function modelUnavailableText(reason: string | undefined): string {
  return reason && Object.hasOwn(MODEL_UNAVAILABLE_TEXT, reason)
    ? MODEL_UNAVAILABLE_TEXT[reason as ModelUnavailableReason]
    : 'the model did not respond';
}

/** Why "more facts" added nothing, in words, for each code the API sends. */
export const FACTOID_UNAVAILABLE_TEXT: Record<FactoidUnavailableCode, string> = {
  rate_limited: MODEL_UNAVAILABLE_TEXT.rate_limited,
  budget_exhausted: MODEL_UNAVAILABLE_TEXT.budget_exhausted,
  live_disabled: 'live model calls are off on this server, it replays recorded runs only',
  not_found: 'the recording this result came from is no longer served here',
};

/** How a replayed result was recorded. */
export interface Recording {
  /** When the run was recorded (ISO time), or null when the result does not say. */
  recordedAt: string | null;
  commit: string | null;
}

/**
 * The recording a result was replayed from, or null when the result is not a replay. A replay
 * is never shown as a live analysis: the result screens label it with this.
 */
export function recordingOf(track: TrackData): Recording | null {
  const run = typeof track.run === 'object' && track.run !== null ? track.run : null;
  if (run?.mode !== 'replay') return null;
  const recordedAt = measuredText(run.recordedAt);
  return {
    recordedAt: recordedAt && !Number.isNaN(Date.parse(recordedAt)) ? recordedAt : null,
    commit: measuredText(run.commit),
  };
}

/** Title of the note shown when the search text did not match the analysed track exactly. */
export const QUERY_MATCH_TITLE = 'This may not be the song you searched for';

/** How the search text matched the track, in words, for each match that is not exact. */
export const QUERY_MATCH_TEXT: Record<Exclude<QueryMatch, 'exact'>, string> = {
  partial: 'Its title matches your search only in part.',
  artist: 'Only the artist matches your search, not the title.',
  none: 'Neither its title nor its artist matches your search.',
};

/**
 * Why the analysed track may not be the song searched for, or null: the match was exact, is
 * unknown (older results do not say), or is a value this page does not know.
 */
export function queryMatchText(match: string | null | undefined): string | null {
  if (!match || match === 'exact' || !Object.hasOwn(QUERY_MATCH_TEXT, match)) return null;
  return QUERY_MATCH_TEXT[match as Exclude<QueryMatch, 'exact'>];
}

/** The value when it was measured (a finite number), otherwise null. */
export function measuredNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

// Strings some serialisers write for a missing value; they are not values.
const MISSING_TEXT = new Set(['', 'null', 'undefined', 'nan']);

/** The value when it is a real string ("null", "undefined" and blanks are missing), else null. */
export function measuredText(value: string | null | undefined): string | null {
  return typeof value === 'string' && !MISSING_TEXT.has(value.trim().toLowerCase()) ? value : null;
}

/** The result's audio measurement (its `audio` block), or null when it has none to read. */
export function measuredAudioOf(track: TrackData): MeasuredAudio | null {
  return readAudio(track.audio);
}

/**
 * True when a result without an `audio` block (from an API that did not send it) carries values
 * its analysis measured: audioSource "analyzed", or "unavailable" because the analysis ran but did
 * not detect the tempo or the key ("not_detected"; the values it did measure are kept). Any other
 * "unavailable" result measured nothing, whatever values it carries.
 */
function legacyMeasured(track: TrackData): boolean {
  return (
    track.audioSource === 'analyzed' ||
    (track.audioSource === 'unavailable' && track.audioUnavailableReason === 'not_detected')
  );
}

/**
 * True when the audio values of this result can be shown as measurements. With an `audio`
 * block, that block decides (its gate passed; each value is then shown only when it was
 * measured). Without one, only the values of an analysis that ran count (see legacyMeasured):
 * "estimated", a missing source, an "unavailable" analysis that did not run and any other value
 * are not measurements.
 */
export function hasMeasuredAudioSource(track: TrackData): boolean {
  const audio = measuredAudioOf(track);
  return audio ? audio.gate.passed : legacyMeasured(track);
}

export interface AudioValues {
  bpm: number | null;
  key: string | null;
  energy: number | null;
  valence: number | null;
  danceability: number | null;
  acousticness: number | null;
}

function rawAudioValues(track: TrackData): AudioValues {
  return {
    bpm: measuredNumber(track.bpm),
    key: measuredText(track.key),
    energy: measuredNumber(track.energy),
    valence: measuredNumber(track.valence),
    danceability: measuredNumber(track.danceability),
    acousticness: measuredNumber(track.acousticness),
  };
}

const NO_AUDIO_VALUES: AudioValues = {
  bpm: null,
  key: null,
  energy: null,
  valence: null,
  danceability: null,
  acousticness: null,
};

/** A mood head's value when it is a 0-1 score, else null. */
function unitScore(score: ModelScore | null | undefined): number | null {
  return score && score.range[0] === 0 && score.range[1] === 1 ? score.value : null;
}

/**
 * The audio values that may be shown as measured; everything else is null. With an `audio`
 * block they are read from it (energy is then null: loudness replaces it); without one, from
 * the result's copies when its analysis ran.
 */
export function audioValues(track: TrackData): AudioValues {
  const audio = measuredAudioOf(track);
  if (audio) {
    const moods = audio.fingerprint?.moods;
    return {
      bpm: audio.tempo?.bpm ?? null,
      key: audio.key ? keyLabel(audio.key) : null,
      energy: null,
      valence: unitScore(moods?.valence),
      danceability: unitScore(moods?.danceability),
      acousticness: unitScore(moods?.acoustic),
    };
  }
  return legacyMeasured(track) ? rawAudioValues(track) : NO_AUDIO_VALUES;
}

/**
 * True when the result carries audio values that were estimated rather than measured: values
 * with no `audio` block under audioSource "estimated", a missing source or one this page does
 * not know. Values under "unavailable" were not estimated: the analysis did not run.
 */
export function hasEstimatedAudio(track: TrackData): boolean {
  return (
    measuredAudioOf(track) === null &&
    !legacyMeasured(track) &&
    track.audioSource !== 'unavailable' &&
    Object.values(rawAudioValues(track)).some((value) => value !== null)
  );
}

/** A 0-1 audio-model score as shown to users: two decimals, never a percentage. */
export function formatScore(score: number): string {
  return score.toFixed(2);
}

/** Mood word for a measured valence score (0 = melancholic, 1 = euphoric). */
export function moodLabel(valence: number): string {
  if (valence > 0.7) return 'Euphoric';
  if (valence > 0.5) return 'Upbeat';
  if (valence > 0.3) return 'Mellow';
  return 'Melancholic';
}

// ─── Each audio value with its provenance, or why it is missing ──────────────────────────────

/**
 * Why one value is missing, in a few words, for each reason the API sends with
 * audioUnavailableReason.
 */
export const AUDIO_UNAVAILABLE_SHORT: Record<AudioUnavailableReason, string> = {
  service_unavailable: 'the audio service did not respond',
  no_preview: 'no audio preview',
  preview_rejected: 'the preview is not from an allowed source',
  analysis_failed: 'the analysis failed',
  not_detected: 'not detected in the preview',
  not_run: 'the analysis did not run',
  low_confidence: 'below the confidence needed to show it',
};

/** Why the audio service measured nothing on a preview (its gate), in a few words. */
export const AUDIO_GATE_TEXT: Record<string, string> = {
  silence: 'the preview is silent',
  noise: 'the preview is noise, not music',
  too_short: 'the preview is too short to measure',
};

/** The v1 energy (0-1) reads 1.0 for any master louder than about -11 dBFS RMS. */
export const SATURATED_ENERGY_TEXT = 'energy saturates on loud masters';

/** Why the audio-model values are missing when the result has a measurement without them. */
export const MODELS_NOT_LOADED_TEXT = 'the audio models are not loaded';

export type AudioField =
  | 'bpm'
  | 'key'
  | 'loudness'
  | 'energy'
  | 'valence'
  | 'arousal'
  | 'danceability'
  | 'acousticness'
  | 'instrumental';

/** A value shown: measured from the signal, or an audio model's score (an estimate). */
export interface ShownReading {
  field: AudioField;
  label: string;
  state: 'shown';
  kind: 'measured' | 'estimate';
  value: string;
  /** The estimator's confidence in words; null when the result does not say. */
  confidence: string | null;
  /** What the value rests on (signal or model, and the preview window); null when unknown. */
  basis: string | null;
  /** The full provenance (method, model, analyzer), for the tooltip. */
  title: string;
}

/** A value that is not shown, with why when the result says. */
export interface MissingReading {
  field: AudioField;
  label: string;
  state: 'missing';
  /** "not measured", or "not shown" for a value that was measured but says nothing. */
  status: string;
  reason: string | null;
}

export type Reading = ShownReading | MissingReading;

/** A ranked list of audio-model scores (Discogs styles, MusiCNN tags), or why it is missing. */
export type ScoreListReading =
  | {
      label: string;
      state: 'shown';
      items: { label: string; score: number }[];
      model: string;
      basis: string;
      title: string;
    }
  | { label: string; state: 'missing'; reason: string | null };

export interface AudioReadings {
  /** Signal measurements: tempo, key, and loudness (or the older energy). */
  signal: Reading[];
  /** Audio-model scores (moods and classification heads). */
  model: Reading[];
  /** False for a result without an `audio` block: its missing model scores are not shown. */
  showMissingModel: boolean;
  /**
   * The style and tag scores (the audio fingerprint); null for a result without an `audio`
   * block, which never carries them.
   */
  fingerprint: { styles: ScoreListReading; tags: ScoreListReading } | null;
}

const MEASURED_TITLE = 'Measured from the audio preview';
const RECORDED_TITLE = 'Measured from the audio preview when this run was recorded';
const ESTIMATED_TEXT = 'estimated, not measured';
const SCORE_TEXT = 'score, not a probability';

/** Seconds as shown for a preview window: one decimal, without a trailing ".0". */
export function formatSeconds(seconds: number): string {
  return String(Math.round(seconds * 10) / 10);
}

/** A tempo as shown: one decimal, without a trailing ".0". */
export function formatBpm(bpm: number): string {
  return String(Math.round(bpm * 10) / 10);
}

function formatModelScore(score: ModelScore): string {
  const [low, high] = score.range;
  return low === 0 && high === 1
    ? formatScore(score.value)
    : `${score.value.toFixed(2)} on ${low}–${high}`;
}

function missing(field: AudioField, label: string, reason: string | null, status = 'not measured') {
  return { field, label, state: 'missing', status, reason } satisfies MissingReading;
}

const MOOD_LABELS: Record<MoodHead, [AudioField, string]> = {
  valence: ['valence', 'Mood'],
  arousal: ['arousal', 'Arousal'],
  danceability: ['danceability', 'Dance'],
  acoustic: ['acousticness', 'Acoustic'],
  instrumental: ['instrumental', 'Instrumental'],
};

/** Readings from the result's `audio` block. */
function measuredReadings(track: TrackData, audio: MeasuredAudio, recorded: boolean) {
  const window = `${formatSeconds(audio.windowSeconds)} s preview`;
  const basis = `signal, ${window}`;
  const measuredTitle = (method: string, extra = '') =>
    `${recorded ? RECORDED_TITLE : MEASURED_TITLE} (${window}) · ${method}${extra} · analyzer ${audio.analyzerVersion}`;
  const gateReason = audio.gate.passed
    ? null
    : (AUDIO_GATE_TEXT[audio.gate.reason ?? ''] ?? 'the preview did not pass the analysis gate');
  // The result-level reason applies to a withheld tempo or key only when it is about detection.
  const resultReason =
    track.audioUnavailableReason === 'not_detected' ||
    track.audioUnavailableReason === 'low_confidence'
      ? AUDIO_UNAVAILABLE_SHORT[track.audioUnavailableReason]
      : null;
  const signalReason = gateReason ?? resultReason;

  const { tempo, key, loudness, fingerprint } = audio;
  const level = loudness ? rmsToDbfs(loudness.rmsMean) : null;
  const signal: Reading[] = [
    tempo
      ? {
          field: 'bpm',
          label: 'BPM',
          state: 'shown',
          kind: 'measured',
          value: formatBpm(tempo.bpm),
          confidence:
            tempo.confidence === null
              ? 'no confidence given'
              : `confidence ${tempo.confidence.toFixed(2)}`,
          basis,
          title: measuredTitle(
            tempo.method,
            tempo.rawConfidence
              ? ` · confidence ${tempo.rawConfidence.value.toFixed(2)} on the estimator's ${tempo.rawConfidence.range[0]}–${tempo.rawConfidence.range[1]} scale`
              : '',
          ),
        }
      : missing('bpm', 'BPM', signalReason),
    key
      ? {
          field: 'key',
          label: 'Key',
          state: 'shown',
          kind: 'measured',
          value: keyLabel(key),
          confidence:
            key.strength === null ? 'no strength given' : `strength ${key.strength.toFixed(2)}`,
          basis,
          title: measuredTitle(key.method, ` · ${key.profile} profile`),
        }
      : missing('key', 'Key', signalReason),
    loudness && level !== null
      ? {
          field: 'loudness',
          label: 'Loudness',
          state: 'shown',
          kind: 'measured',
          value: `${level.toFixed(1)} dBFS RMS`,
          confidence: 'direct measure',
          basis,
          title: measuredTitle(loudness.method, ` · mean RMS ${loudness.rmsMean.toFixed(3)}`),
        }
      : missing('loudness', 'Loudness', loudness ? AUDIO_GATE_TEXT.silence : gateReason),
  ];

  const modelReason = gateReason ?? (fingerprint ? null : MODELS_NOT_LOADED_TEXT);
  const model: Reading[] = MOOD_HEADS.map((head) => {
    const [field, label] = MOOD_LABELS[head];
    const score = fingerprint?.moods?.[head] ?? null;
    if (!score) return missing(field, label, modelReason);
    const value = formatModelScore(score);
    const unit = unitScore(score);
    return {
      field,
      label,
      state: 'shown',
      kind: 'estimate',
      value: head === 'valence' && unit !== null ? `${moodLabel(unit)} ${value}` : value,
      confidence: SCORE_TEXT,
      basis: `model ${score.model.id}, ${window}`,
      title: `Score from the audio model ${score.model.id} on the ${window}: an estimate, not a measurement and not a probability`,
    } satisfies ShownReading;
  });

  const scoreList = (
    label: string,
    list: { model: { id: string }; items: { label: string; score: number }[] } | null,
  ): ScoreListReading =>
    list && list.items.length > 0
      ? {
          label,
          state: 'shown',
          items: list.items,
          model: list.model.id,
          basis: `model ${list.model.id}, ${window}`,
          title: `Activations of the audio model ${list.model.id} on the ${window}: scores, not probabilities`,
        }
      : { label, state: 'missing', reason: modelReason };
  const styles = fingerprint?.styles;
  const tags = fingerprint?.tags;
  return {
    signal,
    model,
    showMissingModel: true,
    fingerprint: {
      styles: scoreList('Styles', styles ? { model: styles.model, items: styles.top } : null),
      tags: scoreList('Tags', tags ? { model: tags.model, items: tags.scores } : null),
    },
  } satisfies AudioReadings;
}

/** Readings from a result without an `audio` block: its copies, whose basis it does not say. */
function legacyReadings(track: TrackData, recorded: boolean): AudioReadings {
  const raw = rawAudioValues(track);
  const title = recorded ? RECORDED_TITLE : MEASURED_TITLE;
  const ran = legacyMeasured(track);
  const reason = (value: unknown) => {
    if (track.audioSource === 'unavailable' && track.audioUnavailableReason) {
      return Object.hasOwn(AUDIO_UNAVAILABLE_SHORT, track.audioUnavailableReason)
        ? AUDIO_UNAVAILABLE_SHORT[track.audioUnavailableReason]
        : null;
    }
    return !ran && value !== null ? ESTIMATED_TEXT : null;
  };
  const measured = (field: AudioField, label: string, value: string): ShownReading => ({
    field,
    label,
    state: 'shown',
    kind: 'measured',
    value,
    confidence: null,
    basis: null,
    title,
  });
  const estimate = (field: AudioField, label: string, value: string): ShownReading => ({
    field,
    label,
    state: 'shown',
    kind: 'estimate',
    value,
    confidence: SCORE_TEXT,
    basis: null,
    title: `${label} score from an audio model (0–1): an estimate, not a probability`,
  });

  const signal: Reading[] = [
    ran && raw.bpm !== null
      ? measured('bpm', 'BPM', formatBpm(raw.bpm))
      : missing('bpm', 'BPM', reason(raw.bpm)),
    ran && raw.key !== null
      ? measured('key', 'Key', raw.key)
      : missing('key', 'Key', reason(raw.key)),
    !ran || raw.energy === null
      ? missing('energy', 'Energy', reason(raw.energy))
      : raw.energy >= 1
        ? missing('energy', 'Energy', SATURATED_ENERGY_TEXT, 'not shown')
        : measured('energy', 'Energy', `${Math.round(raw.energy * 100)}%`),
  ];
  const model: Reading[] = [
    ran && raw.valence !== null
      ? estimate('valence', 'Mood', `${moodLabel(raw.valence)} ${formatScore(raw.valence)}`)
      : missing('valence', 'Mood', reason(raw.valence)),
    ran && raw.danceability !== null
      ? estimate('danceability', 'Dance', formatScore(raw.danceability))
      : missing('danceability', 'Dance', reason(raw.danceability)),
    ran && raw.acousticness !== null
      ? estimate('acousticness', 'Acoustic', formatScore(raw.acousticness))
      : missing('acousticness', 'Acoustic', reason(raw.acousticness)),
  ];
  return { signal, model, showMissingModel: false, fingerprint: null };
}

/**
 * Every audio value of a result, each shown with its provenance (measured or model estimate,
 * confidence, basis) or marked missing with why. A result's `audio` block decides; a result
 * without one is read from its copies, whose confidence and basis are unknown.
 */
export function audioReadings(track: TrackData): AudioReadings {
  const recorded = isWholeRecording(track.run);
  const audio = measuredAudioOf(track);
  return audio ? measuredReadings(track, audio, recorded) : legacyReadings(track, recorded);
}

// How the notices name each value.
const NOTICE_LABELS: Record<AudioField, string> = {
  bpm: 'BPM',
  key: 'key',
  loudness: 'loudness',
  energy: 'energy',
  valence: 'mood',
  arousal: 'arousal',
  danceability: 'danceability',
  acousticness: 'acousticness',
  instrumental: 'instrumental',
};

/** Names of the audio values that are missing, signal measurements first. */
export function missingAudioValues(track: TrackData): string[] {
  const { signal, model, fingerprint } = audioReadings(track);
  const names = [...signal, ...model]
    .filter((reading) => reading.state === 'missing')
    .map((reading) => NOTICE_LABELS[reading.field]);
  if (fingerprint?.styles.state === 'missing') names.push('style scores');
  if (fingerprint?.tags.state === 'missing') names.push('tag scores');
  return names;
}

/** How many audio values a result can have: the notice says "not analysed" when all are missing. */
export function audioValueCount(track: TrackData): number {
  const { signal, model, fingerprint } = audioReadings(track);
  return signal.length + model.length + (fingerprint ? 2 : 0);
}

/** Parts of a result the model writes that this result does not have. */
export function missingModelOutput(track: TrackData): string[] {
  const missing: string[] = [];
  if (!track.genreProfile?.length) missing.push('genre profile');
  if (track.segmentsSource === 'template') {
    missing.push('song structure (a generic template is shown)');
  }
  if (!track.factoids?.length) missing.push('insights');
  if (!track.genealogy?.nodes?.some((node) => node.group !== 1)) missing.push('connected tracks');
  return missing;
}

// Titles of the factoids the estimating fallback writes from its estimated audio values.
const ESTIMATE_FACTOID_TITLES = new Set(['sonic profile', 'track signature']);

/**
 * True when a factoid repeats audio values that were not measured: one of the estimating
 * fallback's audio templates, or text stating the estimated BPM, key, energy or danceability.
 * A result whose values were measured (see hasMeasuredAudioSource) is never matched.
 */
function repeatsEstimatedAudio(factoid: Factoid, track: TrackData): boolean {
  if (hasMeasuredAudioSource(track)) return false;
  if (ESTIMATE_FACTOID_TITLES.has(factoid.title.trim().toLowerCase())) return true;
  const raw = rawAudioValues(track);
  const content = typeof factoid.content === 'string' ? factoid.content.toLowerCase() : '';
  const stated = [
    raw.bpm !== null ? `${raw.bpm} bpm` : null,
    raw.key?.toLowerCase() ?? null,
    raw.energy !== null ? `${Math.round(raw.energy * 100)}%` : null,
    raw.danceability !== null ? `${Math.round(raw.danceability * 100)}%` : null,
  ];
  return stated.some((text) => text !== null && content.includes(text));
}

function list<T>(value: T[] | null | undefined): T[] {
  return Array.isArray(value) ? value : [];
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** Factoids that can be shown: lyric factoids (no longer produced) are dropped. */
export function displayableFactoids(factoids: unknown): Factoid[] {
  if (!Array.isArray(factoids)) return [];
  return factoids.filter(
    (f): f is Factoid =>
      isObject(f) && typeof f.id === 'string' && typeof f.title === 'string' && f.type !== 'lyrics',
  );
}

/**
 * A result with every list and object the views read present, so a payload with missing
 * fields renders (showing them as missing) instead of throwing. Values are not filled in:
 * lists default to empty and text that is not a real value becomes missing.
 */
export function normalizeTrack(track: TrackData): TrackData {
  const genealogy: Partial<TrackData['genealogy']> = isObject(track.genealogy)
    ? track.genealogy
    : {};
  return {
    ...track,
    album: measuredText(track.album) ?? '',
    releaseYear: measuredText(track.releaseYear) ?? undefined,
    key: measuredText(track.key),
    segments: list(track.segments),
    samples: list(track.samples),
    keyMoments: list(track.keyMoments),
    factoids: displayableFactoids(track.factoids).filter((f) => !repeatsEstimatedAudio(f, track)),
    genealogy: { nodes: list(genealogy.nodes), links: list(genealogy.links) },
    genreProfile: Array.isArray(track.genreProfile) ? track.genreProfile : undefined,
    credits: isObject(track.credits) ? track.credits : undefined,
  };
}
