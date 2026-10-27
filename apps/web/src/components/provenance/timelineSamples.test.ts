import { describe, expect, it } from 'vitest';
import { notPlacedNote, placeSamples } from './timelineSamples';

const sample = (time: unknown, description = 'A horn stab') =>
  ({ time, description }) as { time: number; description: string };

describe('placeSamples', () => {
  it('draws a time from 0 to the duration, and says why any other is not drawn', () => {
    const inside = sample(60);
    const end = sample(200);
    const past = sample(260);
    const none = sample(null);
    const negative = sample(-1);
    const { drawn, notPlaced } = placeSamples([inside, end, past, none, negative], 200);
    expect(drawn).toEqual([inside, end]);
    expect(notPlaced).toEqual([
      { sample: past, why: 'outside' },
      { sample: none, why: 'no-time' },
      { sample: negative, why: 'no-time' },
    ]);
  });

  it('draws nothing when the duration is unknown', () => {
    for (const duration of [undefined, 0, -5, Number.NaN, '200']) {
      expect(placeSamples([sample(60)], duration)).toEqual({
        drawn: [],
        notPlaced: [{ sample: sample(60), why: 'no-duration' }],
      });
    }
  });
});

describe('notPlacedNote', () => {
  it('lists the sample with its description, its time as inferred, and why it is not drawn', () => {
    expect(notPlacedNote({ sample: sample(260), why: 'outside' }, 0)).toEqual({
      key: 'sample-0',
      label: 'Possible sample',
      text: 'A horn stab.',
      detail: 'Time inferred by the model: 4:20 · outside the song, not drawn',
      kind: 'inferred',
    });
    expect(notPlacedNote({ sample: sample(65), why: 'no-duration' }, 1).detail).toBe(
      "Time inferred by the model: 1:05 · not placed, the song's duration is unknown",
    );
    expect(notPlacedNote({ sample: sample(null, ' '), why: 'no-time' }, 2)).toMatchObject({
      text: 'A sample the result does not describe.',
      detail: 'Not placed: the result gives it no time',
    });
  });
});
