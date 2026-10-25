import { describe, expect, it } from 'vitest';
import { keyLabel, readAudio, rmsToDbfs } from './audio';
import { audioBlock } from './testing';

describe('readAudio', () => {
  it('reads each measured value with its method, confidence and basis', () => {
    const audio = readAudio(audioBlock());
    expect(audio?.analyzerVersion).toBe('2.1.0+essentia.models-5c5c0c7f');
    expect(audio?.windowSeconds).toBe(29.75);
    expect(audio?.tempo).toMatchObject({
      bpm: 123.05,
      confidence: 0.62,
      method: 'essentia.RhythmExtractor2013',
      basis: 'signal',
    });
    expect(audio?.key && keyLabel(audio.key)).toBe('F# Minor');
    expect(audio?.loudness?.rmsMean).toBe(0.21);
    expect(audio?.fingerprint?.styles?.top.map((s) => s.label)).toEqual([
      'Electronic---House',
      'Electronic---Disco',
    ]);
    expect(audio?.fingerprint?.moods?.valence).toMatchObject({ value: 5.6, range: [1, 9] });
    expect(audio?.keyMoments).toHaveLength(2);
  });

  it.each([
    ['no block', undefined],
    ['a null block', null],
    ['another version', audioBlock({ version: 3 })],
    ['no window', audioBlock({ window: undefined })],
    ['no gate', audioBlock({ gate: undefined })],
    ['a block that is not an object', 'measured'],
  ])('reads %s as no measurement', (_case, value) => {
    expect(readAudio(value)).toBeNull();
  });

  it('reads nothing as measured behind a gate that did not pass, whatever the payload carries', () => {
    const audio = readAudio(audioBlock({ gate: { passed: false, reason: 'silence' } }));
    expect(audio?.gate).toEqual({ passed: false, reason: 'silence' });
    expect(audio?.tempo).toBeNull();
    expect(audio?.key).toBeNull();
    expect(audio?.loudness).toBeNull();
    expect(audio?.fingerprint).toBeNull();
    expect(audio?.keyMoments).toEqual([]);
  });

  it('reads a block it cannot read as not measured and keeps the others', () => {
    const audio = readAudio(
      audioBlock({
        tempo: { bpm: 120, confidence: 3.3, method: 'x', basis: 'signal' },
        key: {
          tonic: 'Bb',
          mode: 'minor',
          strength: 0.5,
          profile: 'edma',
          method: 'x',
          basis: 'signal',
        },
        loudness: { rmsMean: 0.2, method: 'x', basis: 'model' },
      }),
    );
    expect(audio?.tempo).toBeNull();
    expect(audio?.key).toBeNull();
    expect(audio?.loudness).toBeNull();
    expect(audio?.fingerprint?.tags?.scores).toHaveLength(2);
  });

  it('reads missing audio models as no fingerprint', () => {
    expect(readAudio(audioBlock({ fingerprint: null }))?.fingerprint).toBeNull();
  });
});

describe('rmsToDbfs', () => {
  it('gives the level in dB below full scale, and nothing for silence', () => {
    expect(rmsToDbfs(1)).toBe(0);
    expect(rmsToDbfs(0.21)).toBeCloseTo(-13.56, 2);
    expect(rmsToDbfs(0)).toBeNull();
  });
});
