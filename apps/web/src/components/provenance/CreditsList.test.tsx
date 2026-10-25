import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { TrackData } from '../../types';
import { audioBlock, measuredTrack } from '../measured/testing';
import { resultClaims } from './claims';
import { CreditsList } from './CreditsList';
import { claim, evidence } from './testing';

afterEach(cleanup);

const creditsOf = (claims: unknown[]) =>
  resultClaims(
    measuredTrack(audioBlock(), { claims, evidence: [evidence()] } as Partial<TrackData>),
  ).shown.filter((shown) => shown.claim.about === 'credit');

describe('CreditsList', () => {
  it('lists each credit claim with where it comes from and its sources', () => {
    render(
      <CreditsList
        credits={creditsOf([
          claim({
            id: 'w',
            about: 'credit',
            text: 'Written by Ada Example.',
            kind: 'sourced',
            origin: 'code',
            evidenceIds: ['ev1'],
          }),
          claim({ id: 'p', about: 'credit', text: 'Produced by Cleo Example.' }),
        ])}
      />,
    );
    const items = within(screen.getByRole('list', { name: 'Credit claims' })).getAllByRole(
      'listitem',
    );
    expect(items[0]?.textContent).toContain('Written by Ada Example.');
    expect(items[0]?.textContent).toContain('Sourced');
    expect(items[0]?.textContent).toContain('MusicBrainz · primary record');
    expect(items[1]?.textContent).toContain('Produced by Cleo Example.');
    expect(items[1]?.textContent).toContain('Model inference');
    expect(items[1]?.textContent).toContain('not checked');
    expect(screen.queryByText(/No credits found/)).toBeNull();
  });

  it("lists an older result's credits as model inference with no source, never as sourced", () => {
    const { container } = render(
      <CreditsList
        credits={[]}
        uncited={{
          producers: ['Cleo Example'],
          writers: ['Ada Example', 'Ben Example'],
          engineers: [],
        }}
      />,
    );
    const list = container.querySelector('dl[aria-label="Credits without a source"]');
    expect(list?.textContent).toBe('ProducersCleo ExampleWritersAda Example, Ben Example');
    expect(container.textContent).toContain('Model inferenceno source cited');
    expect(container.textContent).not.toContain('Sourced');
    expect(container.querySelector('[data-claim-kind]')?.getAttribute('data-claim-kind')).toBe(
      'inferred',
    );
  });

  it('says that no credits were found, instead of an empty block', () => {
    const { container } = render(<CreditsList credits={[]} uncited={undefined} />);
    expect(screen.getByRole('region', { name: 'Credits' })).toBeTruthy();
    expect(container.textContent).toContain('No credits found in this result.');
  });

  it('ignores names that are not text', () => {
    const { container } = render(
      <CreditsList
        credits={[]}
        uncited={{ producers: [null, ''] as unknown as string[], writers: [] }}
      />,
    );
    expect(container.textContent).toContain('No credits found in this result.');
  });
});
