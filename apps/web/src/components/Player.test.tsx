import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Claim } from '@liner-notes/contract';
import { factoidRoundsLeft } from '@liner-notes/contract/factoids';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moreFactsOf } from '../hooks/agent/moreFacts';
import type { FailedFact, MoreFacts, MoreFactsOptions } from '../hooks/agent/types';
import type { Factoid, TrackData } from '../types';
import { audioBlock, measuredTrack } from './measured/testing';
import Player from './Player';
import { claim as aClaim, evidence as anItem } from './provenance/testing';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

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

describe("the Player's preview lane", () => {
  const layers = {
    beats: { times: [0.5, 1, 1.5], method: 'essentia.RhythmExtractor2013', basis: 'signal' },
    energyContour: { hopSeconds: 0.5, values: [0.1, 0.2, 0.3], method: 'RMS', basis: 'signal' },
    sections: {
      segments: [
        { label: 'A', start: 0, end: 12 },
        { label: 'B', start: 12, end: 29.75 },
      ],
      method: 'novelty-on-beat-chroma',
      basis: 'signal',
    },
  };
  const drawn = () =>
    [
      ...screen
        .getByRole('group', { name: 'Song structure' })
        .querySelectorAll('[data-measured-layer]'),
    ].map((layer) => layer.getAttribute('data-measured-layer'));

  it('draws the beats, energy and sections the result measured, on the measured window', () => {
    render(<Player trackData={measuredTrack(audioBlock(layers))} onBack={() => {}} />);
    const lane = screen.getByRole('group', { name: 'Preview window (29.8 s, measured)' });
    expect(drawn()).toEqual(['sections', 'energy', 'beats', 'legend']);
    expect(within(lane).getByRole('img', { name: /^Beat grid: 3 beats/ })).toBeTruthy();
    expect(
      within(lane)
        .getAllByRole('listitem')
        .map((item) => item.style.width),
    ).toEqual([
      `${Math.round((12 / 29.75) * 100 * 10_000) / 10_000}%`,
      `${Math.round((17.75 / 29.75) * 100 * 10_000) / 10_000}%`,
    ]);
  });

  it('draws none of them when the gate stopped the measurement, or a layer is null', () => {
    render(
      <Player
        trackData={measuredTrack(
          audioBlock({ ...layers, gate: { passed: false, reason: 'silence' } }),
          { audioSource: 'unavailable' },
        )}
        onBack={() => {}}
      />,
    );
    expect(drawn()).toEqual([]);
    cleanup();
    render(
      <Player
        trackData={measuredTrack(audioBlock({ ...layers, beats: null }))}
        onBack={() => {}}
      />,
    );
    expect(drawn()).toEqual(['sections', 'energy', 'legend']);
  });

  it('says why the service withheld a layer, and not when the gate stopped everything', () => {
    const unsteady = { code: 'unsteady_tempo', reason: 'the tempo does not hold over the window' };
    render(
      <Player
        trackData={measuredTrack(
          audioBlock({ ...layers, beats: null, withheld: { beats: unsteady } }),
        )}
        onBack={() => {}}
      />,
    );
    const timeline = () => screen.getByRole('group', { name: 'Song structure' }).textContent;
    expect(timeline()).toContain('Beat grid withheld — the tempo did not hold across the preview');
    cleanup();
    const silent = { code: 'gate_silence', reason: 'the preview is silent' };
    render(
      <Player
        trackData={measuredTrack(
          audioBlock({
            ...layers,
            gate: { passed: false, reason: 'silence' },
            withheld: { beats: silent, energyContour: silent, sections: silent },
          }),
          { audioSource: 'unavailable' },
        )}
        onBack={() => {}}
      />,
    );
    expect(timeline()).toContain('No key moments — the preview is silent');
    expect(timeline()).not.toContain('withheld');
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
    expect(container.textContent).not.toContain('the audio was not analyzed');
  });

  /**
   * The Player with "more facts" kept as useAgent keeps them: `answer` gives each click's facts,
   * its failures and the round named next, or reports the API unavailable.
   */
  function MoreFactsPlayer({
    track,
    answers,
  }: {
    track: TrackData;
    answers: Array<{
      factoids?: Factoid[];
      /** The facts' claims, kept by id as useAgent keeps them. */
      claims?: Claim[];
      failed?: FailedFact[];
      nextRound?: number;
      unavailable?: 'rate_limited' | 'budget_exhausted';
      /** The answer failed as a whole; `broke`: its stream broke, so the request rejects. */
      answerFailed?: 'error' | 'broke';
    }>;
  }) {
    const [moreFacts, setMoreFacts] = useState<MoreFacts | null>(null);
    const clicks = useRef(0);
    const ask = async (result: TrackData, options?: MoreFactsOptions) => {
      const reply = answers[clicks.current++] ?? {};
      if (reply.unavailable) options?.onUnavailable?.(reply.unavailable);
      const before = moreFactsOf(result, moreFacts);
      const factoids = reply.factoids ?? [];
      setMoreFacts({
        ...before,
        factoids: [...before.factoids, ...factoids],
        claims: {
          ...before.claims,
          ...Object.fromEntries((reply.claims ?? []).map((claim) => [claim.id, claim])),
        },
        failed: reply.failed ?? [],
        answerFailed: reply.answerFailed !== undefined,
        ...(reply.nextRound !== undefined
          ? { nextRound: reply.nextRound, finished: !factoidRoundsLeft(reply.nextRound) }
          : {}),
      });
      if (reply.answerFailed === 'broke') throw new Error('Factoid stream connection failed');
      return factoids;
    };
    return (
      <Player
        trackData={track}
        onBack={() => {}}
        moreFacts={moreFacts}
        onMoreFactoidsStream={ask}
      />
    );
  }
  const releaseInfo = {
    ...missingTrack,
    factoids: [{ id: 's1', title: 'Release Info', content: 'Released in 2001.', type: 'trivia' }],
  } as unknown as TrackData;
  const moreButton = () => screen.getByRole('button', { name: /DECRYPT MORE/ });

  it('labels decrypted factoids as model inference and counts only the ones shown', async () => {
    const track = { ...releaseInfo, modelUnavailable: true } as TrackData;
    const facts = [
      { id: 'm1', title: 'Hidden Sample', content: 'Interpolates a 1972 record.', type: 'sample' },
      { id: 'm2', title: 'Lyric Meaning', content: 'About the words.', type: 'lyrics' },
    ] as unknown as Factoid[];
    render(<MoreFactsPlayer track={track} answers={[{ factoids: facts, nextRound: 1 }]} />);
    fireEvent.click(moreButton());

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
    // Every fact failed for that reason: the reason is said once, not as facts not written.
    const failed = [0, 1, 2].map((index) => ({ index, code }));
    render(<MoreFactsPlayer track={releaseInfo} answers={[{ unavailable: code, failed }]} />);
    fireEvent.click(moreButton());

    const notice = await screen.findByText(`More facts unavailable: ${text}`);
    expect(notice.getAttribute('role')).toBe('status');
    expect(screen.queryByText(/could not be written/)).toBeNull();
  });

  it.each([
    ['an error for the whole answer', 'error'],
    ['a stream that broke', 'broke'],
  ] as const)('says so when more facts failed as a whole: %s', async (_label, how) => {
    if (how === 'broke') vi.spyOn(console, 'error').mockImplementation(() => {});
    render(<MoreFactsPlayer track={releaseInfo} answers={[{ answerFailed: how }, {}]} />);
    fireEvent.click(moreButton());

    const notice = await screen.findByText('More facts could not be written. Try again.');
    expect(notice.getAttribute('role')).toBe('status');
    await waitFor(() => expect(moreButton().hasAttribute('disabled')).toBe(false));
    fireEvent.click(moreButton());
    await waitFor(() =>
      expect(screen.queryByText('More facts could not be written. Try again.')).toBeNull(),
    );
  });

  it("shows nothing of another result's more facts", () => {
    const shown = { ...releaseInfo, run: { id: 'run-a', mode: 'live' } } as TrackData;
    const foreign = (other: TrackData): MoreFacts => ({
      ...moreFactsOf(other, null),
      factoids: [
        { id: 'fc-x', title: 'Foreign Fact', content: 'Of another result.', type: 'trivia' },
      ],
      failed: [{ index: 1, code: 'failed' }],
      nextRound: 2,
      finished: true,
      answerFailed: true,
    });
    for (const other of [
      { ...shown, id: 'another-track' },
      { ...shown, run: { id: 'run-b', mode: 'live' } },
    ] as TrackData[]) {
      render(
        <Player
          trackData={shown}
          onBack={() => {}}
          moreFacts={foreign(other)}
          onMoreFactoidsStream={async () => []}
        />,
      );
      expect(screen.queryByText('Foreign Fact')).toBeNull();
      expect(screen.queryByText(/could not be written/)).toBeNull();
      expect(screen.queryByText(/No more facts/)).toBeNull();
      expect(moreButton().hasAttribute('disabled')).toBe(false);
      cleanup();
    }
  });

  it('says how many facts of a click could not be written, and shows the others', async () => {
    const fact = { id: 'fc-a', title: 'Hidden Sample', content: 'A 1972 record.', type: 'sample' };
    render(
      <MoreFactsPlayer
        track={releaseInfo}
        answers={[{ factoids: [fact] as Factoid[], failed: [{ index: 1, code: 'failed' }] }]}
      />,
    );
    fireEvent.click(moreButton());

    const notice = await screen.findByText('1 fact could not be written.');
    expect(notice.getAttribute('role')).toBe('status');
    expect(screen.getByRole('region', { name: 'Decrypted insights' }).textContent).toContain(
      'Hidden Sample',
    );
  });

  it('disables the control once every round has been asked, and says why', async () => {
    render(<MoreFactsPlayer track={releaseInfo} answers={[{ nextRound: 1 }, { nextRound: 2 }]} />);
    fireEvent.click(moreButton());
    await waitFor(() => expect(moreButton().hasAttribute('disabled')).toBe(false));
    expect(screen.queryByText(/every angle on this track has been asked/)).toBeNull();

    fireEvent.click(moreButton());
    const reason = await screen.findByText(
      'No more facts: every angle on this track has been asked.',
    );
    expect(reason.getAttribute('role')).toBe('status');
    await waitFor(() => expect(moreButton().hasAttribute('disabled')).toBe(true));
    expect(moreButton().getAttribute('aria-describedby')).toBe(reason.id);
  });

  describe('the Player with the claims of its facts', () => {
    const SOURCE_URL = 'https://www.whosampled.com/sample/1/';
    const evidence = [anItem({ id: 'ev1', source: 'tavily', sourceTier: 'web', url: SOURCE_URL })];
    /** A model claim about a sample, judged supported by the item it cites: shown as sourced. */
    const sourcedSample = (id: string) =>
      aClaim({
        id,
        about: 'sample',
        kind: 'sourced',
        evidenceIds: ['ev1'],
        verdict: 'supported',
        text: 'It samples Old Record.',
      });
    const card = (id: string, title: string, claimId?: string): Factoid => ({
      id,
      title,
      content: `${title}: it samples Old Record.`,
      type: 'sample',
      ...(claimId ? { claimId } : {}),
      entities: [{ id: `${id}-e1`, text: 'Old Record', type: 'sample', searchQuery: 'Old Record' }],
    });
    const withFacts = (factoids: Factoid[], claims: Claim[]) =>
      ({ ...missingTrack, evidence, claims, factoids }) as unknown as TrackData;
    const cardOf = (title: string) =>
      screen.getAllByText(title)[0].closest('[data-factoid-category]') as HTMLElement;
    const badgeOf = (title: string) =>
      cardOf(title).querySelector('[data-factoid-type]')?.textContent;

    it("shows each fact's claim: a sourced sample links its source, a guessed one is possible", () => {
      const track = withFacts(
        [card('f1', 'Known Sample', 'c-known'), card('f2', 'Guessed Sample', 'c-guess')],
        [sourcedSample('c-known'), aClaim({ id: 'c-guess', about: 'sample' })],
      );
      render(<Player trackData={track} onBack={() => {}} />);

      const known = cardOf('Known Sample');
      expect(known.querySelector('[data-claim-kind]')?.getAttribute('data-claim-kind')).toBe(
        'sourced',
      );
      expect(badgeOf('Known Sample')).toBe('SAMPLE');
      const link = within(known).getByRole('link', {
        name: 'Old Record (sample), opens the cited source in a new tab',
      });
      expect(link.getAttribute('href')).toBe(SOURCE_URL);
      expect(link.getAttribute('rel')).toBe('noopener noreferrer');
      expect(link.getAttribute('target')).toBe('_blank');

      const guessed = cardOf('Guessed Sample');
      expect(guessed.querySelector('[data-claim-kind]')?.getAttribute('data-claim-kind')).toBe(
        'inferred',
      );
      expect(badgeOf('Guessed Sample')).toBe('POSSIBLE SAMPLE');
      expect(within(guessed).queryByRole('link', { name: /Old Record/ })).toBeNull();
      expect(within(guessed).queryByRole('button', { name: /Old Record/ })).toBeNull();
    });

    it('opens no web search for an entity', () => {
      const open = vi.spyOn(window, 'open').mockImplementation(() => null);
      const track = withFacts(
        [card('f2', 'Guessed Sample', 'c-guess')],
        [aClaim({ id: 'c-guess', about: 'sample' })],
      );
      render(<Player trackData={track} onBack={() => {}} />);
      fireEvent.click(within(cardOf('Guessed Sample')).getByText('Old Record'));
      expect(open).not.toHaveBeenCalled();
    });

    it("uses the claims of the second round's facts, and says a fact with no verdict was not checked", async () => {
      // The control shows under the result's own facts.
      const track = withFacts(releaseInfo.factoids, []);
      render(
        <MoreFactsPlayer
          track={track}
          answers={[
            {
              factoids: [card('fc-aaaaaaaaaaaa', 'First Round', 'fc-aaaaaaaaaaaa')],
              claims: [
                aClaim({
                  id: 'fc-aaaaaaaaaaaa',
                  about: 'sample',
                  evidenceIds: ['ev1'],
                  verdict: null,
                }),
              ],
              nextRound: 1,
            },
            {
              factoids: [card('fc-bbbbbbbbbbbb', 'Second Round', 'fc-bbbbbbbbbbbb')],
              claims: [sourcedSample('fc-bbbbbbbbbbbb')],
              nextRound: 2,
            },
          ]}
        />,
      );
      fireEvent.click(moreButton());
      await screen.findByText('First Round');
      await waitFor(() => expect(moreButton().hasAttribute('disabled')).toBe(false));
      fireEvent.click(moreButton());
      await screen.findByText('Second Round');

      const second = cardOf('Second Round');
      expect(second.querySelector('[data-claim-kind]')?.getAttribute('data-claim-kind')).toBe(
        'sourced',
      );
      expect(badgeOf('Second Round')).toBe('SAMPLE');
      expect(
        within(second)
          .getByRole('link', { name: /^Old Record .*opens the cited source/ })
          .getAttribute('href'),
      ).toBe(SOURCE_URL);

      const first = cardOf('First Round');
      expect(first.textContent).toContain('not checked by the verifier');
      expect(badgeOf('First Round')).toBe('POSSIBLE SAMPLE');
      expect(within(first).queryByRole('link', { name: /Old Record/ })).toBeNull();
      // Each card shows its own claim: the section is not labelled model inference as a whole.
      const decrypted = screen.getByRole('region', { name: 'Decrypted insights' });
      expect(decrypted.querySelectorAll('[data-claim-kind]')).toHaveLength(2);
      // A claim a card shows is not listed again.
      expect(
        screen.queryByRole('region', { name: 'More claims' })?.textContent ?? '',
      ).not.toContain('It samples Old Record.');
    });

    /** A model claim about a sample that its cited source only partly supports. */
    const partialSample = (id: string) =>
      aClaim({ id, about: 'sample', kind: 'sourced', evidenceIds: ['ev1'], verdict: 'partial' });

    it('reads a partly supported sample as possible, from the result and from more facts', async () => {
      const track = withFacts(
        [card('f1', 'Partial Sample', 'c-partial')],
        [partialSample('c-partial')],
      );
      render(
        <MoreFactsPlayer
          track={track}
          answers={[
            {
              factoids: [card('fc-aaaaaaaaaaaa', 'Added Partial', 'fc-aaaaaaaaaaaa')],
              claims: [partialSample('fc-aaaaaaaaaaaa')],
              nextRound: 1,
            },
          ]}
        />,
      );
      expect(badgeOf('Partial Sample')).toBe('POSSIBLE SAMPLE');
      expect(cardOf('Partial Sample').textContent).toContain('Partly supported');
      fireEvent.click(moreButton());
      await screen.findByText('Added Partial');
      expect(badgeOf('Added Partial')).toBe('POSSIBLE SAMPLE');
      expect(cardOf('Added Partial').textContent).toContain('Partly supported');
    });

    it('never reads a sample more facts added as source data, even when the model was unavailable', async () => {
      // A result built without the model: its own cards come from source data, but a card
      // "more facts" added is the model's, with or without a claim.
      const track = {
        ...withFacts([card('f1', 'Record Sample')], []),
        modelUnavailable: true,
      } as TrackData;
      render(
        <MoreFactsPlayer
          track={track}
          answers={[{ factoids: [card('fc-aaaaaaaaaaaa', 'Added Sample')], nextRound: 1 }]}
        />,
      );
      expect(badgeOf('Record Sample')).toBe('SAMPLE');
      fireEvent.click(moreButton());
      await screen.findByText('Added Sample');
      expect(badgeOf('Added Sample')).toBe('POSSIBLE SAMPLE');
    });

    it('counts a card left out for an unreadable claim once when its id repeats', async () => {
      const unreadable = { ...aClaim({ id: 'c-lyric' }), about: 'lyrics' } as unknown as Claim;
      const track = withFacts(
        [card('s1', 'Release Info'), card('f9', 'A Lyric', 'c-lyric')],
        [unreadable],
      );
      render(
        <MoreFactsPlayer
          track={track}
          answers={[{ factoids: [card('f9', 'A Lyric', 'c-lyric')], nextRound: 1 }]}
        />,
      );
      fireEvent.click(moreButton());
      await waitFor(() => expect(moreButton().hasAttribute('disabled')).toBe(false));
      expect(
        screen.getByText('1 fact is not shown: this page cannot read the claim it states.'),
      ).toBeTruthy();
      expect(screen.queryByText('A Lyric')).toBeNull();
    });

    it('shows a fact once when its id repeats, with no duplicate keys', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const track = withFacts(
        [card('f1', 'Known Sample', 'c-known'), card('f1', 'Known Sample', 'c-known')],
        [sourcedSample('c-known')],
      );
      render(
        <MoreFactsPlayer
          track={track}
          answers={[{ factoids: [card('f1', 'Known Sample', 'c-known')], nextRound: 1 }]}
        />,
      );
      fireEvent.click(moreButton());
      await waitFor(() => expect(moreButton().hasAttribute('disabled')).toBe(false));
      expect(screen.getAllByText('Known Sample')).toHaveLength(1);
      expect(screen.getByText('1 insights decoded')).toBeTruthy();
      const keyWarnings = error.mock.calls.filter((call) => /same key/.test(String(call[0])));
      expect(keyWarnings).toEqual([]);
    });
  });
});
