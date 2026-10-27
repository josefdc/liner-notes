import type { TrackData } from '../../types';
import type { RelationLinkNote } from './notes';

// Where the timeline draws each of a result's sample times, by the rule SmartTimeline draws its
// markers by (`placeable`): a time that is a number from 0 to the song's duration, when that
// duration is a positive number. Every other sample is not drawn: its time falls outside the
// song, the song's duration is unknown, or it has no time at all.

type Sample = TrackData['samples'][number];

export type NotPlaced = 'outside' | 'no-duration' | 'no-time';

/** The samples the timeline draws, and those it does not, each with why. */
export function placeSamples(
  samples: readonly Sample[],
  durationSeconds: unknown,
): { drawn: Sample[]; notPlaced: Array<{ sample: Sample; why: NotPlaced }> } {
  const duration =
    typeof durationSeconds === 'number' && Number.isFinite(durationSeconds) && durationSeconds > 0
      ? durationSeconds
      : null;
  const drawn: Sample[] = [];
  const notPlaced: Array<{ sample: Sample; why: NotPlaced }> = [];
  for (const sample of samples) {
    const time = (sample as { time?: unknown }).time;
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
      notPlaced.push({ sample, why: 'no-time' });
    } else if (duration === null) notPlaced.push({ sample, why: 'no-duration' });
    else if (time > duration) notPlaced.push({ sample, why: 'outside' });
    else drawn.push(sample);
  }
  return { drawn, notPlaced };
}

/** A time in the song as m:ss. */
const clock = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

/** A sample the timeline does not draw, listed with the notes: its description, and why. */
export function notPlacedNote(
  { sample, why }: { sample: Sample; why: NotPlaced },
  index: number,
): RelationLinkNote {
  const time = (sample as { time?: unknown }).time as number;
  const detail =
    why === 'no-time'
      ? 'Not placed: the result gives it no time'
      : why === 'no-duration'
        ? `Time inferred by the model: ${clock(time)} · not placed, the song's duration is unknown`
        : `Time inferred by the model: ${clock(time)} · outside the song, not drawn`;
  const description = typeof sample.description === 'string' ? sample.description.trim() : '';
  return {
    key: `sample-${index}`,
    label: 'Possible sample',
    text: description ? `${description}.` : 'A sample the result does not describe.',
    detail,
    kind: 'inferred',
  };
}
