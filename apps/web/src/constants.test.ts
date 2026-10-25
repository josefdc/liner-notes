import { describe, expect, it } from 'vitest';
import { audioBlock, measuredTrack } from './components/measured/testing';
import {
  AUDIO_UNAVAILABLE_SHORT,
  audioReadings,
  audioValues,
  displayableFactoids,
  hasEstimatedAudio,
  hasMeasuredAudioSource,
  MODELS_NOT_LOADED_TEXT,
  missingAudioValues,
  modelUnavailableText,
  normalizeTrack,
  type Reading,
  SATURATED_ENERGY_TEXT,
} from './constants';
import type { TrackData } from './types';

describe('displayableFactoids', () => {
  it('drops lyric factoids and entries that are not factoids', () => {
    const factoids = [
      { id: 'f1', title: 'Studio', content: 'Text', type: 'production' },
      { id: 'f2', title: 'Lyrical Analysis', content: 'Text', type: 'lyrics' },
      null,
      'text',
    ];
    expect(displayableFactoids(factoids).map((f) => f.id)).toEqual(['f1']);
  });
});

describe('normalizeTrack', () => {
  it('defaults missing lists and treats "null" text as missing without filling values in', () => {
    const track = normalizeTrack({
      id: 't1',
      title: 'Song',
      artist: 'Artist',
      album: 'null',
      coverUrl: '',
      bpm: null,
      key: 'undefined',
      releaseYear: 'null',
    } as unknown as TrackData);
    expect(track.segments).toEqual([]);
    expect(track.samples).toEqual([]);
    expect(track.keyMoments).toEqual([]);
    expect(track.factoids).toEqual([]);
    expect(track.genealogy).toEqual({ nodes: [], links: [] });
    expect(track.genreProfile).toBeUndefined();
    expect(track.album).toBe('');
    expect(track.key).toBeNull();
    expect(track.releaseYear).toBeUndefined();
    expect(track.bpm).toBeNull();
  });
});

describe('factoids that repeat estimated audio values', () => {
  const track = (audioSource: string | undefined) =>
    ({
      id: 't1',
      title: 'Song',
      artist: 'Artist',
      album: 'Album',
      coverUrl: '',
      bpm: 117,
      key: 'A Minor',
      energy: 0.63,
      danceability: 0.54,
      audioSource,
      factoids: [
        {
          id: 'g1',
          title: 'Sonic Profile',
          content: '117 BPM in A Minor. Danceability: 54%.',
          type: 'production',
        },
        {
          id: 'g2',
          title: 'Track Signature',
          content: 'A positive track at 117 BPM in A Minor.',
          type: 'production',
        },
        { id: 'g3', title: 'Groove', content: 'Sits at 117 bpm.', type: 'trivia' },
        { id: 'g4', title: 'Mix', content: 'Energy around 63% of full scale.', type: 'trivia' },
        {
          id: 'g5',
          title: 'Release Info',
          content: 'Released in 1999. Popularity score: 55/100.',
          type: 'trivia',
        },
      ],
    }) as unknown as TrackData;

  it.each(['estimated', undefined])('are dropped when the audio source is %s', (source) => {
    expect(normalizeTrack(track(source)).factoids.map((f) => f.id)).toEqual(['g5']);
  });

  it('are kept when the values were measured', () => {
    expect(normalizeTrack(track('analyzed')).factoids.map((f) => f.id)).toEqual([
      'g1',
      'g2',
      'g3',
      'g4',
      'g5',
    ]);
  });
});

describe('modelUnavailableText', () => {
  it('says live model calls are paused when the budget is exhausted', () => {
    expect(modelUnavailableText('budget_exhausted')).toBe(
      'live model calls are paused, budget reached',
    );
    expect(modelUnavailableText('budget_exhausted')).not.toMatch(/did not respond/);
    // It is shown inside parentheses in the fallback notice: no parentheses of its own.
    expect(modelUnavailableText('budget_exhausted')).not.toMatch(/[()]/);
  });
});

// A result from an API that does not send the `audio` block: only its copies.
const copiesOnly = (overrides: Partial<TrackData>): TrackData =>
  ({
    id: 't1',
    title: 'Song',
    artist: 'Artist',
    album: 'Album',
    coverUrl: '',
    bpm: 123,
    key: 'F# Minor',
    energy: 0.669,
    valence: null,
    danceability: null,
    acousticness: null,
    segments: [],
    samples: [],
    factoids: [],
    genealogy: { nodes: [], links: [] },
    audioSource: 'analyzed',
    ...overrides,
  }) as TrackData;

const byField = (readings: Reading[]) => Object.fromEntries(readings.map((r) => [r.field, r]));

describe('hasMeasuredAudioSource', () => {
  it('does not read audioSource "unavailable" as measured when the analysis did not run', () => {
    const track = copiesOnly({ audioSource: 'unavailable', audioUnavailableReason: 'no_preview' });
    expect(hasMeasuredAudioSource(track)).toBe(false);
    expect(audioValues(track)).toEqual({
      bpm: null,
      key: null,
      energy: null,
      valence: null,
      danceability: null,
      acousticness: null,
    });
    const signal = byField(audioReadings(track).signal);
    expect(signal.bpm).toMatchObject({ state: 'missing', reason: 'no audio preview' });
    // Not presented as an estimate either: the analysis did not run.
    expect(hasEstimatedAudio(track)).toBe(false);
  });

  it.each(['service_unavailable', 'analysis_failed', 'not_run', undefined] as const)(
    'measures nothing for an "unavailable" result without a measurement (%s)',
    (reason) => {
      const track = copiesOnly({ audioSource: 'unavailable', audioUnavailableReason: reason });
      expect(hasMeasuredAudioSource(track)).toBe(false);
      expect(audioReadings(track).signal.every((r) => r.state === 'missing')).toBe(true);
    },
  );

  it('keeps a tempo the analysis did measure when it found no key (no audio block)', () => {
    // As in the recorded "One More Time" result: the tempo was measured, the key was not.
    const track = copiesOnly({
      key: null,
      audioSource: 'unavailable',
      audioUnavailableReason: 'not_detected',
    });
    expect(hasMeasuredAudioSource(track)).toBe(true);
    const signal = byField(audioReadings(track).signal);
    // Shown as measured, with its confidence and basis unknown: never as more than it is.
    expect(signal.bpm).toMatchObject({
      state: 'shown',
      kind: 'measured',
      value: '123',
      confidence: null,
      basis: null,
    });
    expect(signal.key).toMatchObject({ state: 'missing', reason: 'not detected in the preview' });
  });

  it('decides from the audio block, not from audioSource', () => {
    const partly = measuredTrack(audioBlock({ key: null }), {
      key: null,
      audioSource: 'unavailable',
      audioUnavailableReason: 'not_detected',
    });
    expect(hasMeasuredAudioSource(partly)).toBe(true);
    expect(audioValues(partly).bpm).toBe(123.05);

    // A gate that did not pass measured nothing, even with copies and "analyzed".
    const gated = measuredTrack(audioBlock({ gate: { passed: false, reason: 'noise' } }));
    expect(hasMeasuredAudioSource(gated)).toBe(false);
    expect(audioValues(gated).bpm).toBeNull();
    expect(byField(audioReadings(gated).signal).bpm).toMatchObject({
      state: 'missing',
      reason: 'the preview is noise, not music',
    });
  });
});

describe('audioReadings', () => {
  it('gives each measured value its confidence and basis from the audio block', () => {
    const { signal, model } = audioReadings(measuredTrack());
    const values = byField(signal);
    expect(values.bpm).toMatchObject({
      state: 'shown',
      kind: 'measured',
      value: '123.1',
      confidence: 'confidence 0.62',
      basis: 'signal, 29.8 s preview',
    });
    expect((values.bpm as { title: string }).title).toContain('essentia.RhythmExtractor2013');
    expect((values.bpm as { title: string }).title).toContain('3.30 on the estimator');
    expect(values.key).toMatchObject({ value: 'F# Minor', confidence: 'strength 0.71' });
    // Loudness replaces the older energy score.
    expect(values.loudness).toMatchObject({ value: '-13.6 dBFS RMS', kind: 'measured' });
    expect(values.energy).toBeUndefined();
    // Model scores are estimates, named by their model.
    expect(model.every((r) => r.state === 'shown' && r.kind === 'estimate')).toBe(true);
    expect(byField(model).danceability).toMatchObject({
      value: '0.81',
      basis: 'model discogs-effnet-bs64-1, 29.8 s preview',
    });
    expect(missingAudioValues(measuredTrack())).toEqual([]);
  });

  it('says a value the estimator gave no confidence for has none', () => {
    const tempo = { ...audioBlock().tempo, confidence: null, rawConfidence: null };
    const values = byField(audioReadings(measuredTrack(audioBlock({ tempo }))).signal);
    expect(values.bpm).toMatchObject({ state: 'shown', confidence: 'no confidence given' });
  });

  it('says the audio models are not loaded when the measurement has no fingerprint', () => {
    const readings = audioReadings(measuredTrack(audioBlock({ fingerprint: null })));
    expect(readings.model.every((r) => r.state === 'missing')).toBe(true);
    expect(byField(readings.model).valence).toMatchObject({ reason: MODELS_NOT_LOADED_TEXT });
    expect(readings.fingerprint).toEqual({
      styles: { label: 'Styles', state: 'missing', reason: MODELS_NOT_LOADED_TEXT },
      tags: { label: 'Tags', state: 'missing', reason: MODELS_NOT_LOADED_TEXT },
    });
  });

  it('shows a saturated energy (1.0) as missing, with why, not as a measurement', () => {
    const values = byField(audioReadings(copiesOnly({ energy: 1 })).signal);
    expect(values.energy).toMatchObject({
      state: 'missing',
      status: 'not shown',
      reason: SATURATED_ENERGY_TEXT,
    });
    expect(missingAudioValues(copiesOnly({ energy: 1 }))).toEqual([
      'energy',
      'mood',
      'danceability',
      'acousticness',
    ]);
    // An energy below saturation is still shown, its basis unknown.
    expect(byField(audioReadings(copiesOnly({})).signal).energy).toMatchObject({
      state: 'shown',
      value: '67%',
      basis: null,
    });
  });

  it('has a short reason for every reason the API sends', () => {
    expect(Object.keys(AUDIO_UNAVAILABLE_SHORT).sort()).toEqual(
      [
        'analysis_failed',
        'low_confidence',
        'no_preview',
        'not_detected',
        'not_run',
        'preview_rejected',
        'service_unavailable',
      ].sort(),
    );
  });

  it('has no fingerprint for a result without an audio block', () => {
    expect(audioReadings(copiesOnly({})).fingerprint).toBeNull();
  });
});
