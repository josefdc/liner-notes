import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentLog, TrackData } from '../types';
import Dashboard from './Dashboard';
import TargetScanOverlay from './TargetScanOverlay';
import { claim, link, node, PACK } from './genealogy/testing';
import { setReaderImport } from './genealogy/useLinkReader';
import { PLACEHOLDER_NOTE } from '../styles/placeholder';

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

describe('the Dashboard album cover', () => {
  const MBID = 'ae103b0a-b932-4009-acb6-388db1cf890b';
  const ARCHIVE = `https://coverartarchive.org/release/${MBID}/front-500`;
  /** The MusicBrainz release item the API writes for the cover's release. */
  const releaseItem = (title: string) => ({
    id: `musicbrainz:release/${MBID}`,
    source: 'musicbrainz',
    sourceTier: 'primary-record',
    url: `https://musicbrainz.org/release/${MBID}`,
    title: `${title} — MusicBrainz release`,
    retrievedAt: '2026-10-22T14:02:00.000Z',
    excerpt: `MusicBrainz: "Quiet Signal" by Test Artist appears on the official album "${title}".`,
    recordRef: `release/${MBID}`,
  });
  const withCover = (coverUrl: string, evidence?: unknown[]) =>
    ({ ...missingTrack, coverUrl, ...(evidence && { evidence }) }) as TrackData;
  const credit = () => screen.queryByRole('link', { name: /^Cover: / });

  it('says the cover is not available when the result has none, with no image or background', () => {
    const { container } = renderDashboard(missingTrack);
    expect(screen.getByText('Cover not available')).toBeTruthy();
    expect(container.querySelector('[data-cover="not-available"]')).toBeTruthy();
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(credit()).toBeNull();
  });

  it('shows a Cover Art Archive cover of the shown album, credited with a link to the release', () => {
    const { container } = renderDashboard(withCover(ARCHIVE, [releaseItem('test album!')]));
    const cover = screen.getByRole('img', { name: 'Cover of Test Album' });
    expect(cover.getAttribute('src')).toBe(ARCHIVE);
    // The cover and the blurred background behind the hero.
    expect([...container.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual([
      ARCHIVE,
      ARCHIVE,
    ]);
    expect(credit()?.textContent).toBe('Cover: Cover Art Archive (opens in a new tab)');
    expect(credit()?.getAttribute('href')).toBe(`https://coverartarchive.org/release/${MBID}`);
    expect(credit()?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.queryByText('Cover not available')).toBeNull();
  });

  it("names the cover's release when it is not the album shown", () => {
    renderDashboard(withCover(ARCHIVE, [releaseItem('To the Extreme')]));
    expect(screen.getByRole('img', { name: 'Cover of To the Extreme' })).toBeTruthy();
    expect(credit()?.textContent).toBe(
      'Cover: To the Extreme · Cover Art Archive (opens in a new tab)',
    );
    // Without the release item the cover is not taken for the shown album's either.
    cleanup();
    renderDashboard(withCover(ARCHIVE));
    expect(screen.getByRole('img', { name: 'Cover from the Cover Art Archive' })).toBeTruthy();
    expect(credit()?.textContent).toBe('Cover: Cover Art Archive (opens in a new tab)');
  });

  it('says the cover is not available when it fails to load, and hides the background', () => {
    const { container } = renderDashboard(withCover(ARCHIVE, [releaseItem('Test Album')]));
    act(() => {
      fireEvent.error(screen.getByRole('img', { name: 'Cover of Test Album' }));
    });
    expect(screen.getByText('Cover not available')).toBeTruthy();
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(credit()).toBeNull();
  });

  it('credits no archive for a cover from elsewhere', () => {
    renderDashboard(withCover('https://i.scdn.co/image/ab67616d0000b273'));
    expect(screen.getByRole('img', { name: 'Cover of Test Album' })).toBeTruthy();
    expect(credit()).toBeNull();
    expect(screen.queryByText('Cover not available')).toBeNull();
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
    await screen.findAllByText(/Relation:/);
    return screen
      .getAllByRole('button')
      .filter((button) => button.textContent?.includes('Relation:'));
  };
  const badges = async () =>
    (await cards()).map((card) => card.querySelector('[data-link-kind]')?.textContent);
  const sourcedSample = (source: string, target: string, ev = 'ev-mb-1') =>
    link(source, target, { type: 'sample', kind: 'sourced', origin: 'code', evidenceIds: [ev] });

  it("draws a track without art with the graph's placeholder note, in the same colour", async () => {
    renderDashboard(connected([sourcedSample('older', 'current')]));
    const [older] = await cards();
    const note = older.querySelector('[data-placeholder-note]');
    expect(note?.getAttribute('style')).toContain(`color: ${PLACEHOLDER_NOTE.color}`);
    expect(note?.querySelector('path')?.getAttribute('d')).toBe(PLACEHOLDER_NOTE.path);
    expect(
      [...(note?.querySelectorAll('circle') ?? [])].map((circle) =>
        ['cx', 'cy', 'r'].map((name) => Number(circle.getAttribute(name))),
      ),
    ).toEqual(PLACEHOLDER_NOTE.circles.map(({ cx, cy, r }) => [cx, cy, r]));
  });

  it('names a documented relation as known only for a sourced link, else as a possible one', async () => {
    renderDashboard(
      connected([
        link('guess', 'current', { type: 'sample', kind: 'inferred', value: 3 }),
        sourcedSample('older', 'current'),
        sourcedSample('current', 'later', 'ev-shs-1'),
      ]),
    );
    // Sourced relations first; a track with no link to this one says so.
    expect(await badges()).toEqual([
      'Relation: Sample',
      'Relation: Sample',
      'Relation: Possible sample',
      'Relation: No direct link to this track',
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
      'Possible sample: Quiet Signal (2011) may sample Guessed Sample - Someone (1990)',
    );
    expect(guess.textContent).toContain('Model inference · no evidence cited');
    expect(lonely.textContent).not.toMatch(/Sourced|Model inference/);
    // The heading names every kind a card can show.
    expect(
      screen.getByText(
        'From the genealogy graph — each card says whether its link is sourced, not sourced or a model inference',
      ),
    ).toBeTruthy();
    // Kind in words, and the provenance chip the graph's list uses: amber and a book for
    // sourced, violet and sparkles for a model inference, neutral without a link.
    const badge = (card: Element) =>
      card.querySelector('[data-link-kind] > span.border') as HTMLElement;
    expect(badge(older).dataset.provenance).toBe('sourced');
    expect(badge(older).className).toContain('text-prov-sourced');
    expect(badge(older).querySelector('svg.lucide-book-open')).not.toBeNull();
    expect(badge(guess).dataset.provenance).toBe('inferred');
    expect(badge(guess).className).toContain('text-prov-inferred');
    expect(badge(guess).querySelector('svg.lucide-sparkles')).not.toBeNull();
    expect(badge(lonely).dataset.provenance).toBeUndefined();
    expect(badge(lonely).dataset.variant).toBe('neutral');
  });

  it('labels every relation as inferred when the result has no evidence pack', async () => {
    renderDashboard(connected([sourcedSample('older', 'current')], { withPack: false }));
    expect((await badges())[0]).toBe('Relation: Possible sample');
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
      'Relation: Possible sample',
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
      'Relation: Related, direction unknown',
    );
    expect(later?.querySelector('[data-link-relation]')?.textContent).toBe(
      'Later Track - Someone (2015) and Quiet Signal (2011) are related (direction unknown)',
    );
  });

  it('relates tracks to each other when the analyzed track is not in the graph', async () => {
    const track = connected([sourcedSample('older', 'later')]);
    track.genealogy.nodes = track.genealogy.nodes.filter((n) => n.group !== 1);
    renderDashboard(track);
    const shown = await cards();
    const later = shown.find((card) => card.textContent?.includes('Later Track'));
    expect(later?.querySelector('[data-link-kind]')?.textContent).toBe('Relation: Sample');
    expect(later?.querySelector('[data-link-relation]')?.textContent).toBe(
      'Later Track - Someone (2015) samples Older Record - Someone (1984)',
    );
    const lonely = shown.find((card) => card.textContent?.includes('Lonely Node'));
    expect(lonely?.querySelector('[data-link-kind]')?.textContent).toBe(
      'Relation: No link to another track',
    );
  });

  it('says there are no connections to show, not that none were found, when every relation was rejected', () => {
    renderDashboard({
      ...missingTrack,
      modelUnavailable: false,
      evidence: PACK,
      claims: [claim('cl-bad', { verdict: 'contradicted' })],
      genealogy: {
        nodes: [
          node('current', 1, 'Quiet Signal - Test Artist (2011)'),
          node('older', 2, 'Older Record - Someone (1984)'),
        ],
        links: [{ ...sourcedSample('older', 'current'), claimId: 'cl-bad' }],
      },
    } as unknown as TrackData);
    expect(screen.getByText('No connections to show.')).toBeTruthy();
    expect(screen.queryByText('No connected tracks found for this song.')).toBeNull();
  });

  it('counts the related tracks it shows, in the singular for one', async () => {
    const one = connected([sourcedSample('older', 'current')]);
    one.genealogy.nodes = one.genealogy.nodes.filter((n) => ['current', 'older'].includes(n.id));
    const { unmount } = renderDashboard(one);
    await cards();
    expect(screen.getByText('1 related track')).toBeTruthy();
    unmount();

    // Four related tracks, all shown.
    const four = renderDashboard(connected([]));
    await cards();
    expect(screen.getByText('4 related tracks')).toBeTruthy();
    four.unmount();

    // Five related, four cards: the count says so.
    const five = connected([]);
    five.genealogy.nodes = [...five.genealogy.nodes, node('fifth', 4, 'Fifth - Someone (2000)')];
    renderDashboard(five);
    expect(await cards()).toHaveLength(4);
    expect(screen.getByText('4 of 5 related tracks')).toBeTruthy();
  });

  it('says when the link reader cannot be loaded, and tries again when asked', async () => {
    const real = () => import('./genealogy/links');
    let fail = true;
    setReaderImport(() => (fail ? Promise.reject(new Error('chunk failed')) : real()));
    try {
      renderDashboard(connected([sourcedSample('older', 'current')]));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toBe('Connected tracks could not be loaded.Try again');
      expect(screen.queryByText(/Relation:/)).toBeNull();
      // Not busy for ever: the row says it is done (with nothing).
      expect(document.querySelector('[aria-busy="true"]')).toBeNull();
      fail = false;
      await act(async () => {
        fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
      });
      expect(await badges()).toContain('Relation: Sample');
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      setReaderImport(real);
    }
  });

  it("shows each related track's own title and artist, from its node", async () => {
    const track = connected([sourcedSample('older', 'current')]);
    track.genealogy.nodes = [
      track.genealogy.nodes[0],
      // The node's own fields, over its label.
      {
        ...node('older', 2, 'Older Record - Someone (1984)'),
        trackTitle: 'Older Record (2003 Remaster)',
        trackArtist: 'Someone & The Band',
      },
      // Only a label, written "Title - Artist (Year)": its title is read from it, never its
      // artist ("Song - Live at Wembley (1986)" has the same form).
      node('later', 3, 'Later Track - Someone Else (2015)'),
    ];
    renderDashboard(track);
    const shown = await cards();
    const named = shown.map((card) => ({
      title: card.querySelector('h3')?.textContent,
      artist: card.querySelector('h3 + p')?.textContent ?? null,
    }));
    expect(named).toEqual([
      { title: 'Older Record (2003 Remaster)', artist: 'Someone & The Band' },
      { title: 'Later Track', artist: null },
    ]);
    expect(shown[1].querySelector('img, [data-placeholder-note]')).not.toBeNull();
  });

  it('invents no artist: a label is read as "Title - Artist (Year)" only when it has that form', async () => {
    const track = connected([sourcedSample('older', 'current')]);
    const label = (id: string, text: string, fields = {}) => ({ ...node(id, 4, text), ...fields });
    track.genealogy.nodes = [
      track.genealogy.nodes[0],
      node('older', 2, 'Older Record (1984)'),
      // A title with a " - " in it, and no year: no artist.
      label('live', 'Song - Live at Wembley'),
      // Two " - ": which part is the artist is not known.
      label('remaster', 'Bohemian Rhapsody - 2011 Remaster - Queen (1975)'),
    ];
    renderDashboard(track);
    let shown = await cards();
    const names = () =>
      shown.map((card) => [
        card.querySelector('h3')?.textContent,
        card.querySelector('h3 + p')?.textContent ?? null,
      ]);
    expect(names()).toEqual([
      ['Older Record', null],
      ['Song - Live at Wembley', null],
      ['Bohemian Rhapsody - 2011 Remaster - Queen', null],
    ]);
    cleanup();

    const more = connected([sourcedSample('older', 'current')]);
    more.genealogy.nodes = [
      more.genealogy.nodes[0],
      label('older', 'Intro - Outro'),
      label('bare', 'Bare Title'),
      // Its own title, and a label naming another track: the label's artist is not taken.
      label('other', 'Other Title - Other Artist (1990)', { trackTitle: 'Real Title' }),
      // No label at all (the contract requires one): named by its title, without a crash.
      { id: 'unlabelled', group: 4, size: 22, trackTitle: 'Unlabelled' },
    ] as unknown as TrackData['genealogy']['nodes'];
    renderDashboard(more);
    shown = await cards();
    expect(names()).toEqual([
      ['Intro - Outro', null],
      ['Bare Title', null],
      ['Real Title', null],
      ['Unlabelled', null],
    ]);
    expect(shown.map((card) => card.textContent).join(' ')).not.toMatch(/Unknown|undefined|null/);
  });

  it('analyses a track from its card with no undo toast, and leaves Ctrl+Z to the browser', async () => {
    const analyzed: string[] = [];
    render(
      <Dashboard
        trackData={connected([sourcedSample('older', 'current')])}
        onNavigate={() => {}}
        onAnalyzeTrack={(_id, query) => analyzed.push(query)}
        isRestoredSession
      />,
    );
    const [older] = await cards();
    fireEvent.click(older);
    expect(analyzed).toEqual(['Older Record - Someone (1984)']);
    // Stop on the progress screen, then "Back to the last result", is the way back.
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/Ctrl\+Z|Analyzing Older Record/);
    const undo = new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, cancelable: true });
    window.dispatchEvent(undo);
    expect(undo.defaultPrevented).toBe(false);
  });

  it('never takes a relation from the node group', async () => {
    renderDashboard(connected([]));
    expect(await badges()).toEqual(Array(4).fill('Relation: No direct link to this track'));
    expect(screen.queryByText(/samples/)).toBeNull();
  });

  describe('activity log', () => {
    const logs: AgentLog[] = [
      {
        id: 'l1',
        message: 'Found the track on Spotify',
        timestamp: '2026-01-01T00:00:00.000Z',
        code: 'SPOTIFY-FOUND',
        elapsedMs: 12_400,
      },
      { id: 'l2', message: 'Recorded analysis replayed', timestamp: '2026-01-01T00:00:00.000Z' },
    ];
    const openLog = (trackData: TrackData) => {
      render(<Dashboard trackData={trackData} onNavigate={() => {}} logs={logs} isComplete />);
      fireEvent.click(screen.getByRole('button', { name: /activity log/ }));
      return within(screen.getByRole('region', { name: 'Activity log entries' }));
    };

    it("shows a replayed run's recorded times since the run started, never 'Just now'", () => {
      const replay = {
        ...missingTrack,
        run: {
          id: 'r1',
          mode: 'replay',
          replayed: 'run',
          recordedAt: '2026-10-24T10:00:00.000Z',
          commit: 'abc1234',
        },
      } as unknown as TrackData;
      const entries = openLog(replay);
      expect(entries.getByText('+12.4 s')).toBeTruthy();
      expect(entries.queryByText(/Just now|ago/)).toBeNull();
    });

    it("keeps a live run's relative times", () => {
      const live = { ...missingTrack, run: { id: 'r2', mode: 'live' } } as unknown as TrackData;
      const entries = openLog(live);
      expect(entries.queryByText('+12.4 s')).toBeNull();
      expect(entries.getAllByText(/ago|Just now/).length).toBe(2);
    });
  });
});

describe('the Dashboard headings', () => {
  const logs: AgentLog[] = [
    { id: 'l1', message: 'Found the track on Spotify', timestamp: '2026-01-01T00:00:00.000Z' },
  ];
  const headings = () =>
    [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')].map((heading) => ({
      level: Number(heading.tagName.slice(1)),
      text: heading.textContent?.trim() ?? '',
    }));

  it("has one h1, the analysed track's title, first, and gives it to the focus code", () => {
    const ref = { current: null as HTMLHeadingElement | null };
    render(
      <Dashboard
        trackData={missingTrack}
        onNavigate={() => {}}
        logs={logs}
        isComplete
        headingRef={ref}
      />,
    );
    const all = headings();
    expect(all.filter((heading) => heading.level === 1)).toEqual([
      { level: 1, text: 'Quiet Signal' },
    ]);
    expect(all[0]).toEqual({ level: 1, text: 'Quiet Signal' });
    expect(ref.current?.textContent).toBe('Quiet Signal');
    // No heading skips a level: each sits under the section it belongs to.
    all.slice(1).forEach((heading, index) => {
      expect(heading.level, heading.text).toBeLessThanOrEqual(all[index].level + 1);
    });
  });

  it('names each section with an h2: the fingerprint, the connections and the activity log', () => {
    render(<Dashboard trackData={missingTrack} onNavigate={() => {}} logs={logs} isComplete />);
    const all = headings();
    expect(all.find((heading) => heading.text === 'Sonic Fingerprint')?.level).toBe(2);
    expect(all.find((heading) => heading.text === 'Connections')?.level).toBe(2);
    expect(all.find((heading) => heading.text.startsWith('Activity log'))?.level).toBe(2);
  });

  it("puts the result's notices after its h1, so reading on from the focused title reaches them", () => {
    const replay = {
      ...missingTrack,
      run: {
        id: 'r1',
        mode: 'replay',
        replayed: 'run',
        recordedAt: '2026-10-24T10:00:00.000Z',
        commit: 'abc1234',
      },
    } as unknown as TrackData;
    renderDashboard(replay);
    const title = screen.getByRole('heading', { level: 1 });
    for (const name of ['Recorded run', 'Missing data']) {
      const notice = screen.getByRole('region', { name });
      expect(
        title.compareDocumentPosition(notice) & Node.DOCUMENT_POSITION_FOLLOWING,
        name,
      ).toBeTruthy();
    }
  });

  it('says what it shows in sentence case, and keeps the measured hue off its labels', () => {
    const track = {
      ...missingTrack,
      explicit: true,
      spotifyUrl: 'https://open.spotify.com/track/abc',
    } as unknown as TrackData;
    renderDashboard(track);
    expect(screen.getByRole('link', { name: 'Spotify' }).textContent).toBe('Spotify');
    expect(screen.getByText('Explicit')).toBeTruthy();
    const label = screen.getByText('Analyzed track');
    expect(`${label.className} ${label.nextElementSibling?.className ?? ''}`).not.toMatch(/cyber/);
  });

  it('labels the hover overlay of a connected track in a neutral hue', () => {
    render(<TargetScanOverlay isHovered />);
    expect(screen.getByText('Analyze this track').className).not.toMatch(/cyber/);
  });

  it('says no analysis is loaded, as its h1, when there is no result', () => {
    const ref = { current: null as HTMLHeadingElement | null };
    render(<Dashboard trackData={null} onNavigate={() => {}} isRestoredSession headingRef={ref} />);
    expect(headings().filter((heading) => heading.level === 1)).toEqual([
      { level: 1, text: 'No analysis loaded' },
    ]);
    expect(ref.current?.textContent).toBe('No analysis loaded');
  });
});
