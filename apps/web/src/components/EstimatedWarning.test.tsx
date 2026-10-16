import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { AUDIO_UNAVAILABLE_TEXT } from '../constants';
import type { AudioUnavailableReason, TrackData } from '../types';
import { AudioStats, ResultNotices } from './EstimatedWarning';

afterEach(cleanup);

const base = {
  id: 't1',
  title: 'Song',
  artist: 'Artist',
  album: 'Album',
  coverUrl: '',
  bpm: 120,
  key: 'C Major',
  energy: 0.5,
  valence: 0.6,
  danceability: 0.7,
  acousticness: 0.1,
  segments: [],
  segmentsSource: 'inferred',
  samples: [],
  factoids: [{ id: 'f1', title: 'Fact', content: 'Text', type: 'trivia' }],
  genreProfile: [{ genre: 'Pop', value: 60 }],
  genealogy: {
    nodes: [
      { id: 'current', group: 1, label: 'Song', size: 40 },
      { id: 'o1', group: 2, label: 'Older', size: 30 },
    ],
    links: [],
  },
  audioSource: 'analyzed',
  audioConfidence: 'high',
} as TrackData;

describe('ResultNotices', () => {
  it('renders nothing for a complete, measured result', () => {
    const { container } = render(<ResultNotices track={base} />);
    expect(container.textContent).toBe('');
  });

  it('names the missing model output and the model error', () => {
    render(
      <ResultNotices
        track={{
          ...base,
          genreProfile: undefined,
          segmentsSource: 'template',
          factoids: [],
          modelUnavailable: true,
          modelUnavailableReason: 'timeout',
        }}
      />,
    );
    const text = screen.getByRole('region', { name: 'Missing data' }).textContent;
    expect(text).toContain('Model unavailable');
    expect(text).toContain('(timeout)');
    expect(text).toContain(
      'Missing: genre profile, song structure (a generic template is shown), insights.',
    );
  });

  it.each(Object.entries(AUDIO_UNAVAILABLE_TEXT) as [AudioUnavailableReason, string][])(
    'explains the audio reason %s in words',
    (reason, text) => {
      render(
        <ResultNotices
          track={{
            ...base,
            bpm: null,
            key: null,
            energy: null,
            valence: null,
            danceability: null,
            acousticness: null,
            audioSource: 'unavailable',
            audioUnavailableReason: reason,
          }}
        />,
      );
      const notice = screen.getByRole('region', { name: 'Missing data' }).textContent;
      expect(notice).toContain('Audio not analysed');
      expect(notice).toContain(text);
      expect(notice).not.toContain(reason);
    },
  );

  it('lists only the values that are missing when the audio was partly measured', () => {
    render(
      <ResultNotices
        track={{
          ...base,
          bpm: null,
          audioSource: 'unavailable',
          audioUnavailableReason: 'not_detected',
          audioUnavailableDetail: 'no stable tempo',
        }}
      />,
    );
    const notice = screen.getByRole('region', { name: 'Missing data' }).textContent;
    expect(notice).toContain('Audio partly measured');
    expect(notice).toContain('no stable tempo');
    expect(notice).toContain('Not measured: BPM.');
  });
});

describe('AudioStats', () => {
  it('shows measured values and model scores', () => {
    render(<AudioStats track={base} />);
    expect(screen.getByRole('list', { name: 'Audio values' }).textContent).toContain('120');
    const scores = screen.getByRole('list', { name: 'Audio-model estimates' }).textContent;
    expect(scores).toContain('Upbeat');
    expect(scores).toContain('0.70');
  });

  it('marks every missing measured value and hides missing model scores', () => {
    render(
      <AudioStats
        track={{
          ...base,
          bpm: null,
          key: '',
          energy: Number.NaN,
          valence: null,
          danceability: null,
          acousticness: null,
        }}
      />,
    );
    const stats = screen.getByRole('list', { name: 'Audio values' }).textContent;
    expect(stats).toContain('BPM not measured');
    expect(stats).toContain('Key not measured');
    expect(stats).toContain('Energy not measured');
    expect(screen.queryByRole('list', { name: 'Audio-model estimates' })).toBeNull();
  });
});
