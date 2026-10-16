import type { AudioUnavailableReason, TrackData } from './types';

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
  return reason ? `The audio was not analysed (${reason}).` : 'No reason was given.';
}

/** The value when it was measured (a finite number), otherwise null. */
export function measuredNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The value when it is a non-empty string, otherwise null. */
export function measuredText(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
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

interface AudioField {
  label: string;
  value: (track: TrackData) => number | string | null;
}

/** Values measured from the audio signal. */
export const MEASURED_AUDIO_FIELDS: AudioField[] = [
  { label: 'BPM', value: (t) => measuredNumber(t.bpm) },
  { label: 'key', value: (t) => measuredText(t.key) },
  { label: 'energy', value: (t) => measuredNumber(t.energy) },
];

/** Scores from audio models run over the preview (estimates, not probabilities). */
export const AUDIO_MODEL_FIELDS: AudioField[] = [
  { label: 'mood', value: (t) => measuredNumber(t.valence) },
  { label: 'danceability', value: (t) => measuredNumber(t.danceability) },
  { label: 'acousticness', value: (t) => measuredNumber(t.acousticness) },
];

/** Names of the audio values that were not measured, signal measurements first. */
export function missingAudioValues(track: TrackData): string[] {
  return [...MEASURED_AUDIO_FIELDS, ...AUDIO_MODEL_FIELDS]
    .filter((field) => field.value(track) === null)
    .map((field) => field.label);
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
