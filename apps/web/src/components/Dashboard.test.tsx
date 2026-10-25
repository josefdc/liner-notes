import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TrackData } from '../types';
import Dashboard from './Dashboard';
import { link, node, PACK } from './genealogy/testing';

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
  modelUnavailableReason: 'rate_limited',
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
    expect(notices.textContent).toContain('(quota or rate limit reached)');
    expect(notices.textContent).not.toContain('rate_limited');
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
    expect(screen.getByText(/Audio-model estimates \(scores, not probabilities\)/)).toBeTruthy();
    // The caption labels the list; it is not one of its items.
    expect(scores.textContent).not.toContain('not probabilities');
    expect(scores.textContent).toContain('0.62');
    expect(scores.textContent).toContain('Mellow');
    expect(scores.textContent).not.toContain('62%');
  });
});

describe('Dashboard connected tracks', () => {
  // Group 2 is "it samples" in the node's own terms; only a sourced link may say so.
  const connected = (links: TrackData['genealogy']['links'], withPack = true) =>
    ({
      ...missingTrack,
      modelUnavailable: false,
      ...(withPack ? { evidence: PACK } : {}),
      genealogy: {
        nodes: [
          node('current', 1, 'Quiet Signal'),
          node('guess', 2, 'Guessed Sample'),
          node('older', 2, 'Older Record'),
          node('later', 3, 'Later Track'),
          node('lonely', 2, 'Lonely Node'),
        ],
        links,
      },
    }) as unknown as TrackData;

  const cards = () =>
    screen.getAllByRole('button').filter((button) => button.textContent?.includes('LOGIC:'));
  const reasons = () => cards().map((card) => card.querySelector('[data-link-kind]')?.textContent);

  it('names a documented relation only for a sourced link with evidence in the pack', () => {
    renderDashboard(
      connected([
        link('guess', 'current', { type: 'sample', kind: 'inferred', value: 3 }),
        link('older', 'current', { type: 'sample', kind: 'sourced', evidenceIds: ['ev-mb-1'] }),
        link('current', 'later', { type: 'sample', kind: 'sourced', evidenceIds: ['ev-shs-1'] }),
      ]),
    );
    // Sourced relations first; a track with no link to this one says so.
    expect(reasons()).toEqual([
      'LOGIC: Sampled in this track',
      'LOGIC: Samples this track',
      'LOGIC: Possible influence',
      'LOGIC: No direct link to this track',
    ]);
    const [older, , guess, lonely] = cards();
    expect(older.textContent).toContain('Sourced · cites ev-mb-1 (musicbrainz)');
    expect(guess.textContent).toContain(
      'Model inference · stated as a sample, shown as an influence; no evidence cited',
    );
    expect(lonely.textContent).not.toMatch(/Sourced|Model inference/);
    // Kind in words and in the badge's colour: amber for sourced, neutral otherwise.
    expect(older.querySelector('[data-link-kind]')?.className).toContain('text-analog');
    expect(guess.querySelector('[data-link-kind]')?.className).toContain('border-white/15');
    expect(guess.querySelector('[data-link-kind] > span')?.className).toBe('text-text-secondary');
  });

  it('labels every relation as inferred when the result has no evidence pack', () => {
    renderDashboard(
      connected(
        [link('older', 'current', { type: 'sample', kind: 'sourced', evidenceIds: ['ev-mb-1'] })],
        false,
      ),
    );
    expect(screen.queryByText(/Sampled in this track/)).toBeNull();
    expect(reasons()[0]).toBe('LOGIC: Possible influence');
    expect(cards()[0].textContent).toContain('cites ev-mb-1, not in the evidence pack');
  });

  it('never takes a relation from the node group', () => {
    renderDashboard(connected([]));
    expect(reasons()).toEqual(Array(4).fill('LOGIC: No direct link to this track'));
    expect(screen.queryByText(/Sampled in this track|Samples this track/)).toBeNull();
  });
});
