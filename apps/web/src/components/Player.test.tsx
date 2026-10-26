import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Factoid, TrackData } from '../types';
import { audioBlock } from './measured/testing';
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

describe('the Player album cover', () => {
  const MBID = 'ae103b0a-b932-4009-acb6-388db1cf890b';
  const ARCHIVE = `https://coverartarchive.org/release/${MBID}/front-500`;
  const credit = () => screen.queryByRole('link', { name: /^Cover: / });
  const evidence = [
    {
      id: `musicbrainz:release/${MBID}`,
      source: 'musicbrainz',
      title: 'To the Extreme — MusicBrainz release',
    },
  ];

  it('shows a Cover Art Archive cover with its credit, and says when it fails to load', () => {
    const { container } = render(
      <Player trackData={{ ...missingTrack, coverUrl: ARCHIVE }} onBack={() => {}} />,
    );
    const cover = screen.getByRole('img', { name: 'Cover from the Cover Art Archive' });
    expect(container.querySelectorAll(`img[src="${ARCHIVE}"]`)).toHaveLength(2);
    expect(credit()?.getAttribute('href')).toBe(`https://coverartarchive.org/release/${MBID}`);
    fireEvent.error(cover);
    expect(screen.getByText('Cover not available')).toBeTruthy();
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(credit()).toBeNull();
  });

  it("names the album, or the cover's release when it is another", () => {
    render(
      <Player trackData={{ ...missingTrack, coverUrl: ARCHIVE, evidence }} onBack={() => {}} />,
    );
    expect(screen.getByRole('img', { name: 'Cover of To the Extreme' })).toBeTruthy();
    expect(credit()?.textContent).toBe(
      'Cover: To the Extreme · Cover Art Archive (opens in a new tab)',
    );
  });

  it('credits no archive for a cover from elsewhere', () => {
    render(
      <Player
        trackData={{ ...missingTrack, coverUrl: 'https://i.scdn.co/image/ab67616d0000b273' }}
        onBack={() => {}}
      />,
    );
    expect(screen.getByRole('img', { name: 'Cover of Test Album' })).toBeTruthy();
    expect(credit()).toBeNull();
  });

  it('says the cover is not available when the result has none', () => {
    const { container } = render(<Player trackData={missingTrack} onBack={() => {}} />);
    expect(screen.getByText('Cover not available')).toBeTruthy();
    expect(container.querySelectorAll('img')).toHaveLength(0);
  });
});

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

  it.each([
    [
      'no audio preview',
      { audioUnavailableReason: 'no_preview' },
      'No key moments — no audio preview',
    ],
    ['an estimate', { audioSource: 'estimated' }, 'No key moments — the audio was not measured'],
    [
      'a gate that did not pass',
      {
        audio: audioBlock({ gate: { passed: false, reason: 'silence' } }),
        audioSource: 'unavailable',
      },
      'No key moments — the preview is silent',
    ],
  ])('draws no key moments for %s, and says why', (_case, change, note) => {
    const moments = [{ time: 12, type: 'energy_peak', intensity: 0.9, description: 'Peak' }];
    render(
      <Player
        trackData={{ ...missingTrack, keyMoments: moments, ...change } as TrackData}
        onBack={() => {}}
      />,
    );
    const timeline = screen.getByRole('group', { name: 'Song structure' });
    expect(timeline.textContent).toContain(note);
    expect(timeline.textContent).not.toContain('key moments measured');
    expect(screen.queryAllByRole('img', { name: /Peak/ })).toHaveLength(0);
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
    // No model wrote them: a neutral chip with a page icon, not the model's violet sparkles.
    const chip = screen.getByText('From source data').closest('[data-provenance]') as HTMLElement;
    expect(chip.dataset.provenance).toBe('record');
    expect(chip.className).not.toContain('prov-inferred');
    expect(chip.querySelector('svg.lucide-sparkles')).toBeNull();
    expect(chip.querySelector('svg.lucide-file-text')).not.toBeNull();
  });

  it('says no key moments were detected when the tempo or key was not detected', () => {
    const { container } = render(<Player trackData={missingTrack} onBack={() => {}} />);
    expect(container.textContent).toContain('No key moments detected');
    expect(container.textContent).not.toContain('the audio was not analysed');
  });

  it('labels decrypted factoids as model inference and counts only the ones shown', async () => {
    const track = {
      ...missingTrack,
      modelUnavailable: true,
      factoids: [{ id: 's1', title: 'Release Info', content: 'Released in 2001.', type: 'trivia' }],
    } as unknown as TrackData;
    const decrypt = async (
      _title: string,
      _artist: string,
      _ids: string[],
      onFactoid: (f: Factoid) => void,
    ) => {
      onFactoid({
        id: 'm1',
        title: 'Hidden Sample',
        content: 'Interpolates a 1972 record.',
        type: 'sample',
      });
      onFactoid({
        id: 'm2',
        title: 'Lyric Meaning',
        content: 'About the words.',
        type: 'lyrics',
      } as unknown as Factoid);
    };
    render(<Player trackData={track} onBack={() => {}} onDecryptMoreStream={decrypt} />);
    fireEvent.click(screen.getByRole('button', { name: /DECRYPT MORE/ }));

    const decrypted = await screen.findByRole('region', { name: 'Decrypted insights' });
    expect(decrypted.textContent).toContain('Hidden Sample');
    expect(decrypted.textContent).toContain('Model inference');
    expect(decrypted.textContent).not.toContain('From source data');
    expect(screen.getAllByText('From source data')).toHaveLength(1);
    expect(screen.queryByText('Lyric Meaning')).toBeNull();
    expect(await screen.findByText('1 NEW INTEL DECODED')).toBeTruthy();
  });

  it.each([
    ['rate_limited', 'quota or rate limit reached'],
    ['budget_exhausted', 'live model calls are paused, budget reached'],
  ] as const)('says why DECRYPT MORE added nothing: %s', async (code, text) => {
    const decrypt = async (
      _title: string,
      _artist: string,
      _ids: string[],
      _onFactoid: (f: Factoid) => void,
      _signal?: AbortSignal,
      onUnavailable?: (code: 'rate_limited' | 'budget_exhausted') => void,
    ) => {
      onUnavailable?.(code);
    };
    const track = {
      ...missingTrack,
      factoids: [{ id: 's1', title: 'Release Info', content: 'Released in 2001.', type: 'trivia' }],
    } as unknown as TrackData;
    render(<Player trackData={track} onBack={() => {}} onDecryptMoreStream={decrypt} />);
    fireEvent.click(screen.getByRole('button', { name: /DECRYPT MORE/ }));

    const notice = await screen.findByText(`More facts unavailable: ${text}`);
    expect(notice.getAttribute('role')).toBe('status');
  });
});
