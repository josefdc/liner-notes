import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TrackData } from '../types';
import Dashboard from './Dashboard';

afterEach(cleanup);

// A result built without the model and without audio analysis (the shape the API sends).
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
  audioConfidence: 'low',
  audioUnavailableReason: 'service_unavailable',
  modelUnavailable: true,
  modelUnavailableReason: 'quota exceeded',
} as unknown as TrackData;

const renderDashboard = (trackData: TrackData) =>
  render(<Dashboard trackData={trackData} onNavigate={() => {}} isRestoredSession />);

describe('Dashboard', () => {
  it('marks missing audio values as not measured instead of showing 0', () => {
    const { container } = renderDashboard(missingTrack);
    const stats = screen.getByRole('list', { name: 'Audio values' });
    expect(stats.textContent).toContain('BPM not measured');
    expect(stats.textContent).toContain('Key not measured');
    expect(stats.textContent).toContain('Energy not measured');
    // No mood word or percentage derived from a missing value.
    expect(container.textContent).not.toMatch(/\d+%|Melancholic|Mellow|Upbeat|Euphoric/);
    expect(container.textContent).not.toMatch(/\b(null|NaN|undefined)\b/);
  });

  it('names what is missing when the model and the audio analysis were unavailable', () => {
    renderDashboard(missingTrack);
    const notices = screen.getByRole('region', { name: 'Missing data' });
    expect(notices.textContent).toContain('Model unavailable');
    expect(notices.textContent).toContain('quota exceeded');
    expect(notices.textContent).toContain('genre profile');
    expect(notices.textContent).toContain('The audio analysis service did not respond.');
    expect(notices.textContent).toContain('Not measured: BPM, key, energy');
  });

  it('shows no stand-in tracks or stock images when there are no connections', async () => {
    const { container } = renderDashboard(missingTrack);
    expect(screen.queryByText('Discovered Gems')).toBeNull();
    expect(screen.getByText('No connected tracks found for this song.')).toBeTruthy();
    // No cover and no connections: there is no image to show at all.
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/Plastic Love|Nightcall|Space Song|After Dark/);
    const fingerprint = screen.getByRole('region', { name: 'Sonic Fingerprint' });
    expect(await within(fingerprint).findByText('No genre profile')).toBeTruthy();
  });

  it('shows audio-model scores as labelled scores, not percentages', () => {
    renderDashboard({
      ...missingTrack,
      bpm: 105,
      key: 'A Minor',
      energy: 0.71,
      valence: 0.34,
      danceability: 0.62,
      audioSource: 'analyzed',
      audioUnavailableReason: undefined,
      modelUnavailable: false,
    });
    const stats = screen.getByRole('list', { name: 'Audio values' });
    expect(stats.textContent).toContain('105');
    expect(stats.textContent).toContain('A Minor');
    const scores = screen.getByRole('list', { name: 'Audio-model estimates' });
    expect(scores.textContent).toContain('not probabilities');
    expect(scores.textContent).toContain('0.62');
    expect(scores.textContent).toContain('Mellow');
    expect(scores.textContent).not.toContain('62%');
  });
});
