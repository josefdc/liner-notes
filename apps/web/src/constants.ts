import type { AudioUnavailableReason, Factoid, ModelUnavailableReason, TrackData } from './types';

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
  budget_exhausted: 'live model calls are paused (budget reached)',
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

/**
 * True when the audio values of this result can be shown as measurements. Only two sources
 * qualify: "analyzed", and "unavailable" (where any value that is present was still
 * measured). "estimated", a missing source or any other value comes from the estimating
 * analysis (or a result it cached), so those values are treated as not measured.
 */
export function hasMeasuredAudioSource(track: TrackData): boolean {
  return track.audioSource === 'analyzed' || track.audioSource === 'unavailable';
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

/** The audio values that may be shown as measured; everything else is null. */
export function audioValues(track: TrackData): AudioValues {
  return hasMeasuredAudioSource(track) ? rawAudioValues(track) : NO_AUDIO_VALUES;
}

/** True when the result carries audio values that were estimated rather than measured. */
export function hasEstimatedAudio(track: TrackData): boolean {
  return (
    !hasMeasuredAudioSource(track) &&
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

// Signal measurements first, then the scores from audio models run over the preview.
const AUDIO_FIELD_LABELS: [keyof AudioValues, string][] = [
  ['bpm', 'BPM'],
  ['key', 'key'],
  ['energy', 'energy'],
  ['valence', 'mood'],
  ['danceability', 'danceability'],
  ['acousticness', 'acousticness'],
];

export const AUDIO_FIELD_COUNT = AUDIO_FIELD_LABELS.length;

/** Names of the audio values that were not measured, signal measurements first. */
export function missingAudioValues(track: TrackData): string[] {
  const values = audioValues(track);
  return AUDIO_FIELD_LABELS.filter(([field]) => values[field] === null).map(([, label]) => label);
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
 * Measured values (audioSource "analyzed" or "unavailable") are never matched.
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
