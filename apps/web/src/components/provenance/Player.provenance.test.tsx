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
    const header = analysis().querySelector('h3')?.parentElement as HTMLElement;
    expect(header.textContent).toBe('Agent Analysis');
  });

  it('keeps contradicted claims, and their cards, out of the main view', () => {
    render(<Player trackData={provenanceTrack()} onBack={() => {}} />);
    const main = mainView();
    for (const text of [
      'A 1998 release',
      'first released in 1998',
      'Mixed by Eve Example',
      '90 BPM',
    ]) {
      expect(main.textContent, text).not.toContain(text);
    }
    const button = screen.getByRole('button', { name: 'Rejected by the verifier (3)' });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    const panel = document.getElementById(
      button.getAttribute('aria-controls') ?? '',
    ) as HTMLElement;
    expect(panel.textContent).toContain('Paper Lanterns was first released in 1998.');
    expect(panel.textContent).toContain('Mixed by Eve Example.');
    expect(panel.textContent).toContain('The song runs at 90 BPM.');
  });

  it('lists the credits from the credit claims, with their sources', () => {
    render(<Player trackData={provenanceTrack()} onBack={() => {}} />);
    const credits = screen.getByRole('region', { name: 'Credits' });
    const items = within(credits).getAllByRole('listitem');
    expect(items.map((item) => item.querySelector('p')?.textContent)).toEqual([
      'Written by Ada Example and Ben Example.',
      'Produced by Cleo Example and engineered by Dev Example.',
    ]);
    expect(items[0]?.textContent).toContain('MusicBrainz · primary record');
    expect(items[1]?.textContent).toContain('Partly supported');
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
      ['TriviaThe song was a club favourite in 2011.', 'inferred'],
      ['HistoryThe single reached the top 40.', 'inferred'],
      ['ProductionThe song was recorded at Abbey Road.', 'inferred'],
      ['SoundIt runs at roughly 123 BPM.', 'inferred'],
      ['TrackThe sleeve gives the tempo as 246 BPM.', 'sourced'],
      ['SoundIt feels like 61 BPM.', 'inferred'],
      ['ConnectionIt was used in a 2012 short film.', 'sourced'],
    ]);
  });

  it('says that a result built without the model has no citations', () => {
    const track = {
      ...provenanceTrack(),
      modelUnavailable: true,
      claims: undefined,
      evidence: undefined,
    } as TrackData;
    render(<Player trackData={track} onBack={() => {}} />);
    expect(analysis().textContent).toContain('From source data');
    expect(analysis().textContent).toContain(
      'No citations: these facts come from source records but do not link to them.',
    );
    expect(analysis().textContent).toContain('No credits found in this result.');
    expect(screen.queryByRole('button', { name: /Rejected by the verifier/ })).toBeNull();
  });
});
