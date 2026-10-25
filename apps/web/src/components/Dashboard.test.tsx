import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TrackData } from '../types';
import Dashboard from './Dashboard';
import { claim, link, node, PACK } from './genealogy/testing';
import { setReaderImport } from './genealogy/useLinkReader';

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
  const connected = (
    links: TrackData['genealogy']['links'],
    { withPack = true, claims = [] as unknown[] } = {},
  ) =>
    ({
      ...missingTrack,
      modelUnavailable: false,
      ...(withPack ? { evidence: PACK } : {}),
      claims,
      genealogy: {
        nodes: [
          {
            ...node('current', 1, 'Quiet Signal - Test Artist (2011)'),
            trackTitle: 'Quiet Signal',
          },
          node('guess', 2, 'Guessed Sample - Someone (1990)'),
          node('older', 2, 'Older Record - Someone (1984)'),
          node('later', 3, 'Later Track - Someone (2015)'),
          node('lonely', 2, 'Lonely Node - Someone (1970)'),
        ],
        links,
      },
    }) as unknown as TrackData;

  /** The cards, once the link reader has loaded. */
  const cards = async () => {
    await screen.findAllByText(/LOGIC:/);
    return screen.getAllByRole('button').filter((button) => button.textContent?.includes('LOGIC:'));
  };
  const badges = async () =>
    (await cards()).map((card) => card.querySelector('[data-link-kind]')?.textContent);
  const sourcedSample = (source: string, target: string, ev = 'ev-mb-1') =>
    link(source, target, { type: 'sample', kind: 'sourced', origin: 'code', evidenceIds: [ev] });

  it('names a documented relation only for a sourced link, as a sentence with both tracks', async () => {
    renderDashboard(
      connected([
        link('guess', 'current', { type: 'sample', kind: 'inferred', value: 3 }),
        sourcedSample('older', 'current'),
        sourcedSample('current', 'later', 'ev-shs-1'),
      ]),
    );
    // Sourced relations first; a track with no link to this one says so.
    expect(await badges()).toEqual([
      'LOGIC: Sample',
      'LOGIC: Sample',
      'LOGIC: Possible influence',
      'LOGIC: No direct link to this track',
    ]);
    const [older, later, guess, lonely] = await cards();
    expect(older.querySelector('[data-link-relation]')?.textContent).toBe(
      'Quiet Signal (2011) samples Older Record - Someone (1984)',
    );
    expect(later.querySelector('[data-link-relation]')?.textContent).toBe(
      'Later Track - Someone (2015) samples Quiet Signal (2011)',
    );
    expect(older.textContent).toContain('Sourced · cites ev-mb-1 (MusicBrainz · primary record)');
    expect(guess.querySelector('[data-link-relation]')?.textContent).toBe(
      'Possible influence between Guessed Sample - Someone (1990) and Quiet Signal (2011)',
    );
    expect(guess.textContent).toContain(
      'Model inference · stated as a sample, shown as an influence; no evidence cited',
    );
    expect(lonely.textContent).not.toMatch(/Sourced|Model inference/);
    // Kind in words and in the badge's colour: amber for sourced, neutral otherwise.
    expect(older.querySelector('[data-link-kind]')?.className).toContain('text-analog');
    expect(guess.querySelector('[data-link-kind]')?.className).toContain('border-white/15');
    expect(guess.querySelector('[data-link-kind] > span')?.className).toBe('text-text-secondary');
  });

  it('labels every relation as inferred when the result has no evidence pack', async () => {
    renderDashboard(connected([sourcedSample('older', 'current')], { withPack: false }));
    expect((await badges())[0]).toBe('LOGIC: Possible influence');
    expect((await cards())[0].textContent).toContain(
      'cites ev-mb-1; this result has no evidence pack',
    );
  });

  it('never takes a relation from a model link without a verdict, nor from a rejected one', async () => {
    renderDashboard(
      connected(
        [
          link('older', 'current', {
            type: 'sample',
            kind: 'sourced',
            origin: 'model',
            evidenceIds: ['ev-mb-1'],
          }),
          { ...sourcedSample('guess', 'current'), claimId: 'cl-bad' },
        ],
        { claims: [claim('cl-bad', { verdict: 'contradicted' })] },
      ),
    );
    const shown = await cards();
    const byTitle = (title: string) => shown.find((card) => card.textContent?.includes(title));
    expect(byTitle('Older Record')?.querySelector('[data-link-kind]')?.textContent).toBe(
      'LOGIC: Possible influence',
    );
    expect(byTitle('Older Record')?.textContent).toContain('no verifier verdict supports it');
    // The rejected link is not used at all, and the track only it related is left out.
    expect(byTitle('Guessed Sample')).toBeUndefined();
  });

  it('gives no direction to a relation the release years contradict', async () => {
    // "Later Track" (2015) as the record this 2011 track samples: the years say otherwise.
    renderDashboard(connected([sourcedSample('later', 'current')]));
    const later = (await cards()).find((card) => card.textContent?.includes('Later Track'));
    expect(later?.querySelector('[data-link-kind]')?.textContent).toBe(
      'LOGIC: Related, direction unknown',
    );
    expect(later?.querySelector('[data-link-relation]')?.textContent).toBe(
      'Later Track - Someone (2015) and Quiet Signal (2011) are related (direction unknown)',
    );
  });

  it('relates tracks to each other when the analysed track is not in the graph', async () => {
    const track = connected([sourcedSample('older', 'later')]);
    track.genealogy.nodes = track.genealogy.nodes.filter((n) => n.group !== 1);
    renderDashboard(track);
    const shown = await cards();
    const later = shown.find((card) => card.textContent?.includes('Later Track'));
    expect(later?.querySelector('[data-link-kind]')?.textContent).toBe('LOGIC: Sample');
    expect(later?.querySelector('[data-link-relation]')?.textContent).toBe(
      'Later Track - Someone (2015) samples Older Record - Someone (1984)',
    );
    const lonely = shown.find((card) => card.textContent?.includes('Lonely Node'));
    expect(lonely?.querySelector('[data-link-kind]')?.textContent).toBe(
      'LOGIC: No link to another track',
    );
  });

  it('counts the related tracks it shows, in the singular for one', async () => {
    const one = connected([sourcedSample('older', 'current')]);
    one.genealogy.nodes = one.genealogy.nodes.filter((n) => ['current', 'older'].includes(n.id));
    const { unmount } = renderDashboard(one);
    await cards();
    expect(screen.getByText('1 RELATED TRACK')).toBeTruthy();
    unmount();

    // Four related tracks, all shown.
    const four = renderDashboard(connected([]));
    await cards();
    expect(screen.getByText('4 RELATED TRACKS')).toBeTruthy();
    four.unmount();

    // Five related, four cards: the count says so.
    const five = connected([]);
    five.genealogy.nodes = [...five.genealogy.nodes, node('fifth', 4, 'Fifth - Someone (2000)')];
    renderDashboard(five);
    expect(await cards()).toHaveLength(4);
    expect(screen.getByText('4 OF 5 RELATED TRACKS')).toBeTruthy();
  });

  it('says when the link reader cannot be loaded, and tries again when asked', async () => {
    const real = () => import('./genealogy/links');
    let fail = true;
    setReaderImport(() => (fail ? Promise.reject(new Error('chunk failed')) : real()));
    try {
      renderDashboard(connected([sourcedSample('older', 'current')]));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe('Connected tracks could not be loaded.TRY AGAIN');
      expect(screen.queryByText(/LOGIC:/)).toBeNull();
      // Not busy for ever: the row says it is done (with nothing).
      expect(document.querySelector('[aria-busy="true"]')).toBeNull();
      fail = false;
      await act(async () => {
        fireEvent.click(within(alert).getByRole('button', { name: 'TRY AGAIN' }));
      });
      expect(await badges()).toContain('LOGIC: Sample');
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      setReaderImport(real);
    }
  });

  it('never takes a relation from the node group', async () => {
    renderDashboard(connected([]));
    expect(await badges()).toEqual(Array(4).fill('LOGIC: No direct link to this track'));
    expect(screen.queryByText(/samples/)).toBeNull();
  });
});
