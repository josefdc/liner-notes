import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TrackData } from '../../types';
import Player from '../Player';
import { provenanceTrack } from './testing';

afterEach(cleanup);

// The Player on the provenance fixture: a claim in each state. Contradicted claims, and the
// cards that state them, leave the main view for the rejected claims.

const analysis = () => document.getElementById('panel-context') as HTMLElement;

/** The main view of the analysis panel: everything but the rejected claims. */
function mainView() {
  const panel = analysis().cloneNode(true) as HTMLElement;
  panel.querySelector('section[aria-label="Rejected claims"]')?.remove();
  return panel;
}

describe('the Player with claims', () => {
  it('shows a chip on a card that states a claim, and labels the cards without one', () => {
    render(<Player trackData={provenanceTrack()} onBack={() => {}} />);
    const card = screen.getByText('Two days').closest('.group') as HTMLElement;
    expect(card.querySelector('[data-claim-kind]')?.getAttribute('data-claim-kind')).toBe(
      'sourced',
    );
    expect(card.textContent).toContain('Web search · editorial');
    expect(card.textContent).toContain('supported by its sources');
    // "Studio Intel" has no claim: it is labelled model inference, and the section is not.
    const other = screen.getByText('Studio Intel').closest('.group') as HTMLElement;
    expect(other.textContent).toContain('Model inference');
    const header = analysis().querySelector('h2')?.parentElement as HTMLElement;
    expect(header.textContent).toBe('Facts');
  });

  it('keeps contradicted claims, and their cards, out of the main view', () => {
    render(<Player trackData={provenanceTrack()} onBack={() => {}} />);
    const main = mainView();
    for (const text of [
      'A 1998 release',
      'first released in 1998',
      'Mixed by Eve Example',
      '90 BPM',
      'horn stab',
      'toured Japan',
      // Cards whose claim this page cannot read, rejected or not.
      'A lighthouse',
      'Leaving home',
    ]) {
      expect(main.textContent, text).not.toContain(text);
    }
    expect(main.textContent).toContain(
      '1 fact is not shown: this page cannot read the claim it states.',
    );
    const button = screen.getByRole('button', { name: 'Rejected by the verifier (6)' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    const panel = document.getElementById(
      button.getAttribute('aria-controls') ?? '',
    ) as HTMLElement;
    for (const text of [
      'Paper Lanterns was first released in 1998.',
      'Mixed by Eve Example.',
      'The song runs at 90 BPM.',
      'A horn stab from a 1975 record plays at the bridge.',
      'The band toured Japan in 2009.',
      '1 more rejected claim could not be read by this page.',
    ]) {
      expect(panel.textContent, text).toContain(text);
    }
    // The first claim with a rejected id is not listed as rejected, nor shown.
    expect(document.body.textContent).not.toContain('The band toured Japan in 2012.');
  });

  it('keeps samples whose claim was rejected off the timeline', () => {
    render(<Player trackData={provenanceTrack()} onBack={() => {}} />);
    const timeline = screen.getByRole('group', { name: 'Song structure' });
    expect(
      within(timeline).getByRole('img', { name: /^Sample: Vocal chop from an older record/ }),
    ).toBeTruthy();
    expect(within(timeline).queryByRole('img', { name: /Horn stab/ })).toBeNull();
  });

  it('keeps relations whose claim was rejected out of the genealogy, and the tracks only they related', () => {
    render(<Player trackData={provenanceTrack()} onBack={() => {}} />);
    const network = document.getElementById('panel-genealogy') as HTMLElement;
    expect(network.textContent).toContain('Kept Influence - Other (2005)');
    expect(network.textContent).toContain('Unclaimed Influence - Third (1990)');
    expect(network.textContent).not.toContain('Rejected Source');
    // The current track is not counted among the related ones.
    expect(network.textContent).toContain('Connections: 2 related tracks.');
    expect(network.textContent).toContain(
      '1 link not shown: the claim behind it was rejected or cannot be read.',
    );
  });

  it('lists the credits from the credit claims, with their sources and the verifier reasons', () => {
    render(<Player trackData={provenanceTrack()} onBack={() => {}} />);
    const credits = screen.getByRole('region', { name: 'Credits' });
    // A credit claim on a card is not listed again.
    expect(screen.getAllByText('Vocals by Ivy Example.')).toHaveLength(1);
    expect(credits.textContent).toContain('1 credit is shown with the facts above.');
    expect(credits.textContent).not.toContain('Ivy Example');
    const items = within(credits).getAllByRole('listitem');
    expect(items.map((item) => item.querySelector('p')?.textContent)).toEqual([
      'Written by Ada Example and Ben Example.',
      'Produced by Cleo Example and engineered by Dev Example.',
      'Mastered by Gil Example.',
    ]);
    expect(items[0]?.textContent).toContain(
      'MusicBrainz · primary record · about the song, not this recording',
    );
    expect(items[1]?.textContent).toContain(
      'Partly supported: The release credits name the producer; no engineer is listed.',
    );
    expect(items[1]?.textContent).toContain('Discogs · primary record · about a whole release');
    expect(items[2]?.textContent).toContain('Not supported');
    expect(items[2]?.textContent).toContain(
      'Not supported by its sources: The release credits list no mastering engineer.',
    );
  });

  it('shows every other claim, each with its kind', () => {
    render(<Player trackData={provenanceTrack()} onBack={() => {}} />);
    const more = screen.getByRole('region', { name: 'More claims' });
    const kinds = within(more)
      .getAllByRole('listitem')
      .map((item) => [
        item.querySelector('p')?.textContent,
        item.querySelector('[data-claim-kind]')?.getAttribute('data-claim-kind'),
      ]);
    expect(kinds).toEqual([
      ['SoundThe preview was measured at 123 BPM.', 'measured'],
      ["SoundThe preview's key, as measured.", 'inferred'],
      // A genealogy link states it: it is named as its line is, a possible influence.
      ['Possible influenceThe song was a club favourite in 2011.', 'inferred'],
      ['HistoryThe single reached the top 40.', 'inferred'],
      ['ProductionThe song was recorded at Abbey Road.', 'inferred'],
      ['SoundIt runs at roughly 123 BPM.', 'inferred'],
      ['TrackThe sleeve gives the tempo as 246 BPM.', 'sourced'],
      ['SoundIt feels like 61 BPM.', 'inferred'],
      ['ConnectionIt was used in a 2012 short film.', 'sourced'],
      ["HistoryA blog calls it the band's breakthrough.", 'sourced'],
      // A sample the model guessed: hedged, as on the graph and on a fact's card.
      ['Possible sampleA vocal chop from an older record opens the song.', 'inferred'],
      ['SoundThe preview analysis measured the track at 128 BPM.', 'inferred'],
    ]);
    // A model sentence stating a measurement is shown beside the measured value, not compared.
    const wrong = within(more).getAllByRole('listitem')[11];
    expect(wrong?.textContent).toContain(
      'not compared with the measurement · measured 123 BPM (essentia.RhythmExtractor2013, 22.4 s preview)',
    );
    expect(wrong?.textContent).not.toContain('128 BPM (');
    // A number the check found consistent: its text has no verdict, its number agrees.
    const roughly = within(more).getAllByRole('listitem')[5];
    expect(roughly?.textContent).toContain('no verifier verdict on its text');
    expect(roughly?.textContent).not.toContain('not checked');
    expect(roughly?.textContent).toContain('agrees with the measurement · measured 123 BPM');
    const blog = within(more).getAllByRole('listitem')[9];
    expect(blog?.textContent).toContain('Web search · web page');
    expect(blog?.textContent).not.toContain('primary record');
  });

  it('says that the facts of a result built without the model have no citations', () => {
    const track = {
      ...provenanceTrack(),
      modelUnavailable: true,
      claims: undefined,
      evidence: undefined,
      factoids: [
        { id: 's1', title: 'Samples', content: 'This track samples "X" by Y.', type: 'sample' },
        { id: 's2', title: 'Sonic Profile', content: 'Measured at 123 BPM.', type: 'production' },
      ],
    } as TrackData;
    render(<Player trackData={track} onBack={() => {}} />);
    expect(analysis().textContent).toContain('From source data');
    expect(analysis().textContent).toContain(
      'No citations: the facts taken from source records do not link to them. "Sonic Profile" is written from the audio measurement.',
    );
    expect(analysis().textContent).toContain('No credits found in this result.');
    expect(screen.queryByRole('button', { name: /Rejected by the verifier/ })).toBeNull();
  });

  it('says nothing of source records when the only card is written from the measurement', () => {
    const track = {
      ...provenanceTrack(),
      modelUnavailable: true,
      claims: undefined,
      evidence: undefined,
      factoids: [
        { id: 's2', title: 'Sonic Profile', content: 'Measured at 123 BPM.', type: 'production' },
      ],
    } as TrackData;
    render(<Player trackData={track} onBack={() => {}} />);
    expect(analysis().textContent).not.toContain('source records');
    expect(analysis().textContent).toContain(
      '"Sonic Profile" is written from the audio measurement.',
    );
  });

  it.each([
    ['a single-node genealogy', [{ id: 'current', group: 1, label: 'Paper Lanterns', size: 40 }]],
    [
      'a drawn genealogy',
      [
        { id: 'current', group: 1, label: 'Paper Lanterns', size: 40 },
        { id: 'n-free', group: 4, label: 'Unclaimed Influence - Third (1990)', size: 25 },
      ],
    ],
  ])('skips a genealogy link that is null, with %s', (_case, nodes) => {
    const track = {
      ...provenanceTrack(),
      genealogy: { nodes, links: [null, { source: 'n-free', target: 'current', value: 1 }] },
    } as unknown as TrackData;
    render(<Player trackData={track} onBack={() => {}} />);
    expect(screen.getByRole('heading', { name: 'Paper Lanterns' })).toBeTruthy();
    const network = document.getElementById('panel-genealogy')?.textContent ?? '';
    expect(network.includes('Unclaimed Influence')).toBe(nodes.length > 1);
  });
});
