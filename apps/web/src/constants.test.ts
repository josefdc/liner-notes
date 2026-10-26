import { describe, expect, it } from 'vitest';
import { audioBlock, measuredTrack } from './components/measured/testing';
import {
  AUDIO_UNAVAILABLE_SHORT,
  AUDIO_WITHHELD_TEXT,
  audioNoticeOf,
  audioReadings,
  audioValues,
  displayableFactoids,
  fingerprintSubtitle,
  hasEstimatedAudio,
  hasMeasuredAudioSource,
  MODELS_NOT_LOADED_TEXT,
  measuredKeyMoments,
  modelUnavailableText,
  noKeyMomentsReason,
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
      // On the estimator's own scale, said to be uncalibrated: never a bare probability.
      confidence: 'estimator confidence 3.30 of 5.32, not calibrated',
      basis: 'signal, 29.8 s preview',
      detail:
        'essentia.RhythmExtractor2013 · analyzer 2.1.0+essentia.models-5c5c0c7f · the confidence does not flag half or double tempo',
    });
    expect(values.key).toMatchObject({
      value: 'F# Minor',
      confidence: 'key strength 0.71 of 1, not a probability',
      detail: 'essentia.KeyExtractor, edma profile · analyzer 2.1.0+essentia.models-5c5c0c7f',
    });
    // Loudness replaces the older energy score.
    expect(values.loudness).toMatchObject({ value: '-13.6 dBFS RMS', kind: 'measured' });
    expect(values.energy).toBeUndefined();
    // Model scores are estimates, named by their model.
    expect(model.every((r) => r.state === 'shown' && r.kind === 'estimate')).toBe(true);
    expect(byField(model).danceability).toMatchObject({
      value: '0.81',
      basis: 'model discogs-effnet-bs64-1, 29.8 s preview',
    });
    expect(audioNoticeOf(measuredTrack())).toBeNull();
  });

  it('gives a normalised tempo confidence its scale when the raw one is not sent', () => {
    const tempo = { ...audioBlock().tempo, rawConfidence: undefined };
    const values = byField(audioReadings(measuredTrack(audioBlock({ tempo }))).signal);
    expect(values.bpm).toMatchObject({
      confidence: 'estimator confidence 0.62 of 1, not calibrated',
    });
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

  it('says which check withheld the key, in plain words, and nothing for what was measured', () => {
    const block = audioBlock({
      key: null,
      withheld: {
        key: {
          code: 'one_pitched_source',
          reason: 'one pitched source (its partials hold still and rise and fall together)',
        },
      },
    });
    const track = measuredTrack(block, { key: null, audioUnavailableReason: 'not_detected' });
    const values = byField(audioReadings(track).signal);
    expect(values.key).toEqual({
      field: 'key',
      label: 'Key',
      state: 'missing',
      status: 'not measured',
      reason: 'one pitched source (a cowbell or similar), so no key',
    });
    expect(values.bpm).toMatchObject({ state: 'shown', value: '123.1' });
    expect(audioNoticeOf(track)).toEqual({
      title: 'Audio partly measured',
      lines: ['Not measured: key (one pitched source (a cowbell or similar), so no key).'],
    });
  });

  it('gives a tempo its own reason and the key its own', () => {
    const block = audioBlock({
      tempo: null,
      key: null,
      withheld: {
        tempo: { code: 'unsteady_tempo', reason: 'the tempo does not hold over the window' },
        key: { code: 'low_key_strength', reason: 'the key strength (0.31 of 1) is under 0.40' },
      },
    });
    const values = byField(audioReadings(measuredTrack(block)).signal);
    expect(values.bpm).toMatchObject({ reason: 'the tempo changes within the preview' });
    expect(values.key).toMatchObject({ reason: 'the key estimate was too weak' });
  });

  it('drops a reason whose code this page cannot read, and says only what the result says', () => {
    const block = audioBlock({ key: null });
    const track = measuredTrack(block);
    // A reader given the block directly (not through the contract) with a code it cannot read
    // drops that reason: the result-level reason is shown instead, when it is about detection.
    const odd = measuredTrack(
      audioBlock({ key: null, withheld: { key: { code: 'newer_rule', reason: 'a newer rule' } } }),
      { audioUnavailableReason: 'not_detected' },
    );
    expect(byField(audioReadings(track).signal).key).toMatchObject({ reason: null });
    expect(byField(audioReadings(odd).signal).key).toMatchObject({
      reason: AUDIO_UNAVAILABLE_SHORT.not_detected,
    });
  });

  it('gives each missing mood head, style or tag list the reason the service gave', () => {
    const fingerprint = {
      ...audioBlock().fingerprint,
      tags: null,
      moods: { ...audioBlock().fingerprint.moods, valence: null, arousal: null },
    };
    const notMusic = { code: 'non_music_style', reason: 'the strongest style is Spoken Word' };
    const block = audioBlock({
      fingerprint,
      withheld: {
        tags: { code: 'model_failed', reason: 'the tag model failed or gave unusable output' },
        moods: { valence: notMusic, arousal: notMusic },
      },
    });
    const readings = audioReadings(measuredTrack(block));
    expect(byField(readings.model).valence).toMatchObject({
      state: 'missing',
      reason: AUDIO_WITHHELD_TEXT.non_music_style,
    });
    expect(byField(readings.model).danceability).toMatchObject({ state: 'shown' });
    expect(readings.fingerprint?.tags).toEqual({
      label: 'Tags',
      state: 'missing',
      reason: 'the audio model gave no usable output',
    });
  });

  it('says why there is no fingerprint when the service says, else that no models are loaded', () => {
    const notMusic = audioBlock({
      fingerprint: null,
      withheld: { fingerprint: { code: 'not_music', reason: 'not music: one harmonic series' } },
    });
    const readings = audioReadings(measuredTrack(notMusic));
    expect(byField(readings.model).valence).toMatchObject({
      reason: 'not music (one tone or a voice, no beat)',
    });
    expect(readings.fingerprint?.styles).toMatchObject({
      reason: 'not music (one tone or a voice, no beat)',
    });
  });

  it('has words for every code the service sends', () => {
    for (const text of Object.values(AUDIO_WITHHELD_TEXT)) {
      expect(text.length).toBeGreaterThan(0);
      expect(text.length).toBeLessThanOrEqual(60);
      // No measured-looking number: a reason never shows the value it withheld.
      expect(text).not.toMatch(/\d+\.\d+/);
    }
  });

  it('shows a saturated energy (1.0) as missing, with why, not as a measurement', () => {
    const values = byField(audioReadings(copiesOnly({ energy: 1 })).signal);
    expect(values.energy).toMatchObject({
      state: 'missing',
      status: 'not shown',
      reason: SATURATED_ENERGY_TEXT,
    });
    // Listed as not shown, with why, never as "not measured"; the title says what it counts.
    expect(
      audioNoticeOf(copiesOnly({ energy: 1, valence: 0.4, danceability: 0.5, acousticness: 0.1 })),
    ).toEqual({
      title: 'Some audio values not shown',
      lines: ['Not shown: energy (energy saturates on loud masters).'],
    });
    // An energy below saturation is shown on its own 0-1 scale, never as a measurement.
    expect(byField(audioReadings(copiesOnly({})).signal).energy).toMatchObject({
      state: 'shown',
      kind: 'score',
      value: '0.67',
      confidence: null,
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

const moments = [{ time: 12, type: 'energy_peak', intensity: 0.9, description: 'Peak' }] as const;

describe('key moments', () => {
  it('are shown only when the audio was measured', () => {
    // An "unavailable" result whose analysis did not run measured no key moments either.
    const notRun = copiesOnly({
      audioSource: 'unavailable',
      audioUnavailableReason: 'no_preview',
      keyMoments: [...moments],
    });
    expect(measuredKeyMoments(notRun)).toEqual([]);
    expect(noKeyMomentsReason(notRun)).toBe('no audio preview');

    const estimated = copiesOnly({ audioSource: 'estimated', keyMoments: [...moments] });
    expect(measuredKeyMoments(estimated)).toEqual([]);
    expect(noKeyMomentsReason(estimated)).toBe('the audio was not measured');

    const ran = copiesOnly({ keyMoments: [...moments] });
    expect(measuredKeyMoments(ran)).toEqual(moments);
    expect(noKeyMomentsReason(ran)).toBeNull();
  });

  it('come from the measurement, and a gate that did not pass gives its reason', () => {
    expect(measuredKeyMoments(measuredTrack())).toHaveLength(2);
    expect(noKeyMomentsReason(measuredTrack())).toBeNull();
    const gated = measuredTrack(audioBlock({ gate: { passed: false, reason: 'silence' } }));
    expect(measuredKeyMoments(gated)).toEqual([]);
    expect(noKeyMomentsReason(gated)).toBe('the preview is silent');
  });
});

describe('a result whose audio block is null or cannot be read', () => {
  const blocks = [
    ['null', { audio: null }],
    ['unreadable', { audio: audioBlock({ version: 3 }) }],
    ['read as null by the stream reader', { audio: null, audioUnreadable: true }],
  ] as const;
  const withBlock = (block: object, change: Partial<TrackData>) =>
    measuredTrack(audioBlock(), { valence: 0.4, ...block, ...change } as Partial<TrackData>);

  it.each(blocks)('shows the copies of an analysis that ran as not confirmed (%s)', (_c, block) => {
    for (const change of [
      { audioSource: 'analyzed' },
      { audioSource: 'unavailable', audioUnavailableReason: 'not_detected' },
      { audioSource: 'unavailable', audioUnavailableReason: 'low_confidence' },
    ] as Partial<TrackData>[]) {
      const track = withBlock(block, change);
      expect(hasMeasuredAudioSource(track)).toBe(false);
      expect(audioValues(track).bpm).toBeNull();
      expect(measuredKeyMoments(track)).toEqual([]);
      const { signal, model } = audioReadings(track);
      const values = byField(signal);
      expect(values.bpm).toMatchObject({ state: 'shown', kind: 'unverified', basis: null });
      // Loudness, as in a measured result; a copy cannot stand in for it.
      expect(values.loudness).toMatchObject({ state: 'missing' });
      expect(values.energy).toBeUndefined();
      // Model scores stay estimates.
      expect(byField(model).valence).toMatchObject({ state: 'shown', kind: 'estimate' });
      expect(signal.some((r) => r.state === 'shown' && r.kind === 'measured')).toBe(false);
      expect(audioNoticeOf(track)?.title).toBe('Audio values not confirmed');
    }
  });

  it.each(blocks)('keeps estimated values estimated, as without a block (%s)', (_c, block) => {
    for (const source of ['estimated', undefined]) {
      const track = withBlock(block, { audioSource: source } as Partial<TrackData>);
      expect(hasEstimatedAudio(track)).toBe(true);
      const values = byField(audioReadings(track).signal);
      expect(values.bpm).toMatchObject({ state: 'missing', reason: 'estimated, not measured' });
      expect(audioReadings(track).model.every((r) => r.state === 'missing')).toBe(true);
      expect(audioNoticeOf(track)).toMatchObject({
        title: 'Audio values not measured',
        lines: expect.arrayContaining(['Estimated, not measured — not shown.']),
      });
    }
  });

  it.each(blocks)(
    'shows the values of an analysis that did not run as missing, with why (%s)',
    (_c, block) => {
      const track = withBlock(block, {
        audioSource: 'unavailable',
        audioUnavailableReason: 'no_preview',
      });
      const values = byField(audioReadings(track).signal);
      expect(values.bpm).toMatchObject({ state: 'missing', reason: 'no audio preview' });
      expect(audioReadings(track).signal.some((r) => r.state === 'shown')).toBe(false);
      expect(audioNoticeOf(track)).toMatchObject({
        title: 'Audio not measured',
        lines: expect.arrayContaining(['No audio preview is available for this track.']),
      });
    },
  );

  it("gives the timeline the result's reason for a null block, and says an unreadable one could not be read", () => {
    const notRun = { audioSource: 'unavailable', audioUnavailableReason: 'no_preview' } as const;
    expect(noKeyMomentsReason(withBlock({ audio: null }, notRun))).toBe('no audio preview');
    expect(noKeyMomentsReason(withBlock({ audio: audioBlock({ version: 3 }) }, notRun))).toBe(
      'the measurement could not be read',
    );
    expect(
      audioNoticeOf(
        withBlock({ audio: audioBlock({ version: 3 }) }, { ...notRun, bpm: null, key: null }),
      ),
    ).toMatchObject({ title: 'Audio not measured' });
  });
});

describe('model scores', () => {
  it('of results without an audio block are estimates, never measured', () => {
    const { model } = audioReadings(copiesOnly({ valence: 0.4, danceability: 0.7 }));
    const shown = model.filter((r) => r.state === 'shown');
    expect(shown).toHaveLength(2);
    expect(shown.every((r) => r.kind === 'estimate')).toBe(true);
  });

  it('are not shown when outside the range their model produces', () => {
    const block = audioBlock();
    const moods = {
      ...block.fingerprint.moods,
      danceability: { ...block.fingerprint.moods.danceability, value: 1.4 },
    };
    const track = measuredTrack(audioBlock({ fingerprint: { ...block.fingerprint, moods } }));
    expect(byField(audioReadings(track).model).danceability).toMatchObject({
      state: 'missing',
      status: 'not shown',
    });
    expect(audioValues(track).danceability).toBeNull();
  });

  it('missing are "not available", not "not measured"', () => {
    const { model, fingerprint } = audioReadings(measuredTrack(audioBlock({ fingerprint: null })));
    expect(model.every((r) => r.state === 'missing' && r.status === 'not available')).toBe(true);
    expect(fingerprint?.styles).toMatchObject({ state: 'missing' });
  });
});

describe('a zero loudness on a preview the gate passed', () => {
  it('is not said to be silence', () => {
    const track = measuredTrack(
      audioBlock({ loudness: { rmsMean: 0, method: 'm', basis: 'signal' } }),
    );
    const loudness = byField(audioReadings(track).signal).loudness;
    expect(loudness).toMatchObject({ state: 'missing', status: 'not shown' });
    expect(JSON.stringify(loudness)).not.toContain('silent');
  });
});

describe('audioNoticeOf', () => {
  it('names only what is missing: a measured tempo is never said to be undetected', () => {
    const partly = measuredTrack(audioBlock({ key: null }), {
      key: null,
      audioSource: 'unavailable',
      audioUnavailableReason: 'not_detected',
    });
    expect(audioNoticeOf(partly)).toEqual({
      title: 'Audio partly measured',
      lines: ['The analysis ran but did not detect the key.', 'Not measured: key.'],
    });
    // The same with the copies only (the shape of the recorded "One More Time" result).
    const replayShape = copiesOnly({
      key: null,
      audioSource: 'unavailable',
      audioUnavailableReason: 'not_detected',
    });
    expect(audioNoticeOf(replayShape)?.lines[0]).toBe(
      'The analysis ran but did not detect the key.',
    );
  });

  it('says both when tempo and key are missing', () => {
    const track = copiesOnly({
      bpm: null,
      key: null,
      audioSource: 'unavailable',
      audioUnavailableReason: 'not_detected',
    });
    expect(audioNoticeOf(track)?.lines[0]).toBe(
      'The analysis ran but could not detect the tempo or key.',
    );
  });

  it('does not call a result with every signal value measured "partly measured"', () => {
    const track = measuredTrack(audioBlock({ fingerprint: null }));
    expect(audioNoticeOf(track)).toEqual({
      title: 'Audio-model estimates not available',
      lines: [
        `Audio-model estimates not available: mood, arousal, danceability, acousticness, instrumental, style scores, tag scores (${MODELS_NOT_LOADED_TEXT}).`,
      ],
    });
    expect(audioNoticeOf(measuredTrack())).toBeNull();
  });

  it('gives a gate that did not pass a title and body that agree', () => {
    const track = measuredTrack(audioBlock({ gate: { passed: false, reason: 'noise' } }));
    expect(audioNoticeOf(track)).toEqual({
      title: 'Audio not measured',
      lines: ['Nothing was measured on the preview: the preview is noise, not music.'],
    });
  });

  it('does not call "unavailable" values without a reason estimated', () => {
    const track = copiesOnly({ audioSource: 'unavailable' });
    const signal = byField(audioReadings(track).signal);
    expect(signal.bpm).toMatchObject({ state: 'missing', reason: null });
    expect(audioNoticeOf(track)).toEqual({
      title: 'Audio not analysed',
      lines: [
        'The analysis did not report why.',
        'Not measured: BPM, key, energy.',
        'Audio-model estimates not available: mood, danceability, acousticness.',
      ],
    });
  });
});

describe('fingerprintSubtitle', () => {
  it('says what the panel shows', () => {
    expect(fingerprintSubtitle(measuredTrack(), false)).toBe(
      'Style and tag scores from audio models run on the preview',
    );
    expect(fingerprintSubtitle(measuredTrack(audioBlock({ fingerprint: null })), false)).toBe(
      `Style and tag scores not available: ${MODELS_NOT_LOADED_TEXT}`,
    );
    expect(
      fingerprintSubtitle(
        measuredTrack(audioBlock({ gate: { passed: false, reason: 'silence' } })),
        false,
      ),
    ).toBe('Style and tag scores not available: the preview is silent');
    expect(fingerprintSubtitle(measuredTrack(), true)).toBe(
      'Style and tag scores from audio models run on the preview; genre affinity written by the model',
    );
    expect(fingerprintSubtitle(copiesOnly({}), true)).toBe('Genre affinity written by the model');
    expect(fingerprintSubtitle(copiesOnly({}), false)).toBe('Genre affinity');
  });
});

describe('notice titles and reasons', () => {
  it('lists a zero loudness as not shown, and the title says only that', () => {
    const track = measuredTrack(
      audioBlock({ loudness: { rmsMean: 0, method: 'essentia.RMS', basis: 'signal' } }),
    );
    expect(audioNoticeOf(track)).toEqual({
      title: 'Some audio values not shown',
      lines: ['Not shown: loudness (a level of zero has no dBFS value).'],
    });
  });

  it('calls a result partly measured while measured key moments are shown', () => {
    const noSignal = audioBlock({ tempo: null, key: null, loudness: null });
    expect(audioNoticeOf(measuredTrack(noSignal, { bpm: null, key: null }))?.title).toBe(
      'Audio partly measured',
    );
    const nothing = audioBlock({ tempo: null, key: null, loudness: null, keyMoments: [] });
    expect(
      audioNoticeOf(measuredTrack(nothing, { bpm: null, key: null, keyMoments: [] }))?.title,
    ).toBe('Audio not measured');
  });

  it('never gives a result-level reason as the notice text next to measured values', () => {
    const track = measuredTrack(audioBlock({ key: null }), {
      key: null,
      audioSource: 'unavailable',
      audioUnavailableReason: 'no_preview',
    });
    const notice = audioNoticeOf(track);
    expect(notice?.title).toBe('Audio partly measured');
    expect(notice?.lines.join(' ')).not.toContain('No audio preview');
    expect(notice?.lines[0]).toBe('The analysis did not report why.');
  });
});

describe('model scores shown in part', () => {
  const { fingerprint } = audioBlock();
  it('names in the subtitle only the scores that are shown', () => {
    const tagsOnly = measuredTrack(audioBlock({ fingerprint: { ...fingerprint, styles: null } }));
    expect(fingerprintSubtitle(tagsOnly, false)).toBe(
      'Tag scores from audio models run on the preview',
    );
    const stylesOnly = measuredTrack(audioBlock({ fingerprint: { ...fingerprint, tags: null } }));
    expect(fingerprintSubtitle(stylesOnly, false)).toBe(
      'Style scores from audio models run on the preview',
    );
  });
});
