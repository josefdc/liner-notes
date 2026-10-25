// Results for the tests of the measured values: an `audio` block (AudioFeatures v2) as the API
// sends it with a measured result, and a result that carries it. Used by tests only.

import type { TrackData } from '../../types';

const effnet = { id: 'discogs-effnet-bs64-1', licence: 'CC BY-NC-SA 4.0' };
const musicnn = { id: 'msd-musicnn-1', licence: 'CC BY-NC-SA 4.0' };

/** A measurement whose gate passed, with every block measured. */
export const audioBlock = (overrides: Record<string, unknown> = {}) => ({
  version: 2,
  analyzerVersion: '2.1.0+essentia.models-5c5c0c7f',
  window: { kind: 'preview-30s', durationSeconds: 29.75 },
  gate: { passed: true, reason: null },
  tempo: {
    bpm: 123.05,
    confidence: 0.62,
    rawConfidence: { value: 3.3, range: [0, 5.32] },
    method: 'essentia.RhythmExtractor2013',
    basis: 'signal',
  },
  key: {
    tonic: 'F#',
    mode: 'minor',
    strength: 0.71,
    profile: 'edma',
    method: 'essentia.KeyExtractor',
    basis: 'signal',
  },
  loudness: { rmsMean: 0.21, method: 'essentia.RMS', basis: 'signal' },
  beats: null,
  energyContour: null,
  sections: null,
  keyMoments: [
    { time: 4.2, type: 'onset', intensity: 0.8, description: 'Beat transition' },
    { time: 27.9, type: 'energy_peak', intensity: 1, description: 'Energy peak' },
  ],
  fingerprint: {
    styles: {
      model: effnet,
      top: [
        { label: 'Electronic---House', score: 0.41 },
        { label: 'Electronic---Disco', score: 0.22 },
      ],
      basis: 'model',
    },
    tags: {
      model: musicnn,
      scores: [
        { label: 'electronic', score: 0.63 },
        { label: 'dance', score: 0.48 },
      ],
      basis: 'model',
    },
    moods: {
      danceability: { value: 0.81, range: [0, 1], model: effnet, basis: 'model' },
      acoustic: { value: 0.04, range: [0, 1], model: effnet, basis: 'model' },
      instrumental: { value: 0.37, range: [0, 1], model: effnet, basis: 'model' },
      valence: { value: 5.6, range: [1, 9], model: musicnn, basis: 'model' },
      arousal: { value: 6.1, range: [1, 9], model: musicnn, basis: 'model' },
    },
  },
  ...overrides,
});

/** A result as the API sends it with the measurement: copies made from `audio` by code. */
export const measuredTrack = (
  audio: Record<string, unknown> = audioBlock(),
  overrides: Partial<TrackData> = {},
): TrackData =>
  ({
    id: 't-measured',
    title: 'Measured Song',
    artist: 'Artist',
    album: 'Album',
    coverUrl: '',
    bpm: 123.05,
    key: 'F# Minor',
    energy: null,
    valence: null,
    danceability: 0.81,
    acousticness: 0.04,
    segments: [],
    samples: [],
    factoids: [],
    genealogy: { nodes: [], links: [] },
    audioSource: 'analyzed',
    audioConfidence: 'high',
    audio,
    ...overrides,
  }) as TrackData;
