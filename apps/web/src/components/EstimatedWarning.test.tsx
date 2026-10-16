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
    expect(text).toContain('(the model timed out)');
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
        }}
      />,
    );
    const notice = screen.getByRole('region', { name: 'Missing data' }).textContent;
    expect(notice).toContain('Audio partly measured');
    expect(notice).toContain('The analysis ran but could not detect the tempo or key.');
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

describe('estimated audio values', () => {
  // The shape the API sent before audio values were measured only: genre-based or random
  // estimates under audioSource "estimated" (also served from its result cache).
  const legacy = {
    ...base,
    bpm: 117,
    key: 'A Minor',
    energy: 0.63,
    valence: 0.41,
    danceability: 0.72,
    acousticness: 0.2,
    audioSource: 'estimated',
    audioConfidence: 'low',
  } as TrackData;

  it.each([
    ['audioSource "estimated"', legacy],
    ['no audioSource', { ...legacy, audioSource: undefined }],
    ['an unknown audioSource', { ...legacy, audioSource: 'guessed' } as unknown as TrackData],
  ])('shows nothing as measured for %s', (_case, track) => {
    const { container } = render(
      <>
        <ResultNotices track={track} />
        <AudioStats track={track} />
      </>,
    );
    const stats = screen.getByRole('list', { name: 'Audio values' }).textContent;
    expect(stats).toContain('BPM not measured');
    expect(stats).toContain('Key not measured');
    expect(stats).toContain('Energy not measured');
    expect(screen.queryByRole('list', { name: 'Audio-model estimates' })).toBeNull();
    expect(container.textContent).not.toMatch(/117|A Minor|0\.72|63%/);
    const notice = screen.getByRole('region', { name: 'Missing data' }).textContent;
    expect(notice).toContain('Audio values not measured');
    expect(notice).toContain('Estimated, not measured — not shown.');
  });

  it('still shows values measured when tempo or key was not detected', () => {
    render(
      <AudioStats
        track={{
          ...base,
          bpm: null,
          audioSource: 'unavailable',
          audioUnavailableReason: 'not_detected',
        }}
      />,
    );
    const stats = screen.getByRole('list', { name: 'Audio values' }).textContent;
    expect(stats).toContain('BPM not measured');
    expect(stats).toContain('C Major');
    expect(stats).toContain('50%');
  });
});

describe('partly measured results', () => {
  it('says the analysis did not report why when no reason is given', () => {
    render(
      <ResultNotices
        track={{ ...base, energy: null, valence: null, danceability: null, acousticness: null }}
      />,
    );
    const notice = screen.getByRole('region', { name: 'Missing data' }).textContent;
    expect(notice).toContain('Audio partly measured');
    expect(notice).toContain('The analysis did not report why.');
    expect(notice).toContain('Not measured: energy, mood, danceability, acousticness.');
  });

  it.each(['null', 'undefined', ' NULL '])('treats the key text %j as missing', (key) => {
    const { container } = render(<AudioStats track={{ ...base, key }} />);
    expect(screen.getByRole('list', { name: 'Audio values' }).textContent).toContain(
      'Key not measured',
    );
    expect(container.textContent).not.toMatch(/KEY\s*(null|undefined)/i);
  });
});

describe('model unavailable reason', () => {
  const unavailable = (reason: string | undefined) =>
    ({ ...base, modelUnavailable: true, modelUnavailableReason: reason }) as unknown as TrackData;

  it.each([
    ['no_output', 'the model returned no output'],
    ['rate_limited', 'quota or rate limit reached'],
    ['timeout', 'the model timed out'],
    ['auth', 'authentication or configuration problem'],
    ['error', 'the model returned an error'],
    // Older results carried the provider's text: shown only as the generic description.
    [
      'Resource has been exhausted (e.g. check quota). (RESOURCE_EXHAUSTED)',
      'the model did not respond',
    ],
    ['constructor', 'the model did not respond'],
    [undefined, 'the model did not respond'],
  ])('shows %j as %j', (reason, category) => {
    render(<ResultNotices track={unavailable(reason)} />);
    const text = screen.getByRole('region', { name: 'Missing data' }).textContent;
    expect(text).toContain(`This result was built from source data only (${category}).`);
  });

  it('never shows the provider error text', () => {
    const providerText =
      `${'Upstream provider said: request failed with details '.repeat(5)}x`.slice(0, 300);
    const { container } = render(<ResultNotices track={unavailable(providerText)} />);
    expect(container.textContent).not.toContain('Upstream provider said');
    expect(container.textContent).toContain('(the model did not respond)');
  });
});
