import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TrackData } from '../types';
import Player from './Player';

afterEach(cleanup);

const missingTrack = {
  id: 't1',
  title: 'Quiet Signal',
  artist: 'Test Artist',
  album: 'Test Album',
  coverUrl: '',
  bpm: null,
  key: null,
  energy: null,
  valence: null,
  danceability: null,
  acousticness: null,
  segments: [{ label: 'Main', start: 0, end: 100, color: '#1F2937' }],
  segmentsSource: 'template',
  samples: [],
  factoids: [],
  genealogy: { nodes: [{ id: 'current', group: 1, label: 'Quiet Signal', size: 40 }], links: [] },
  audioSource: 'unavailable',
  audioUnavailableReason: 'not_detected',
} as unknown as TrackData;

describe('Player', () => {
  it('shows an empty state, not a demo track, when there is no analysis', () => {
    const { container } = render(<Player trackData={null} onBack={() => {}} />);
    expect(screen.getByText('No analysis loaded')).toBeTruthy();
    expect(container.textContent).not.toContain('Midnight City');
    expect(container.textContent).not.toContain('M83');
  });

  it('marks BPM, key and energy as not measured', () => {
    const { container } = render(<Player trackData={missingTrack} onBack={() => {}} />);
    expect(screen.getByRole('list', { name: 'Audio values' }).textContent).toContain(
      'BPM not measured',
    );
    expect(container.textContent).toContain('DEEP_DIVE_MODE // BPM not measured');
    expect(container.textContent).toContain(
      'The analysis ran but could not detect the tempo or key.',
    );
    expect(container.textContent).not.toMatch(/\b(null|NaN|undefined)\b/);
    expect(container.textContent).not.toMatch(/\d+\s*BPM|\d+%/);
  });

  it('labels the insights and the genealogy as model inference and drops lyric factoids', () => {
    const track = {
      ...missingTrack,
      factoids: [
        { id: 'f1', title: 'Studio Intel', content: 'Recorded in two days.', type: 'production' },
        { id: 'f2', title: 'Lyrical Analysis', content: 'About the words.', type: 'lyrics' },
      ],
      genealogy: {
        nodes: [
          { id: 'current', group: 1, label: 'Quiet Signal', size: 40 },
          { id: 'o1', group: 2, label: 'Older Song', size: 30 },
        ],
        links: [],
      },
    } as unknown as TrackData;
    const { container } = render(<Player trackData={track} onBack={() => {}} />);
    expect(screen.getAllByText('Model inference')).toHaveLength(2);
    expect(container.textContent).toContain('Studio Intel');
    expect(container.textContent).not.toContain('Lyrical Analysis');
  });

  it('labels them as source data when the model was unavailable', () => {
    const track = {
      ...missingTrack,
      modelUnavailable: true,
      factoids: [{ id: 'f1', title: 'Release Info', content: 'Released in 2001.', type: 'trivia' }],
    } as unknown as TrackData;
    render(<Player trackData={track} onBack={() => {}} />);
    expect(screen.getByText('From source data')).toBeTruthy();
    expect(screen.queryByText('Model inference')).toBeNull();
  });
});
