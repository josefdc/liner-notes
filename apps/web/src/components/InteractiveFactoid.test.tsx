import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Factoid } from '../types';
import InteractiveFactoid from './InteractiveFactoid';

afterEach(cleanup);

const TYPES: Factoid['type'][] = [
  'production',
  'credits',
  'sample',
  'curiosity',
  'connection',
  'trivia',
];
// The provenance colours (measured, sourced, inferred) and the old category hues.
const PROVENANCE_HUES = /cyber|analog|amber|prov-|accent-|purple|green/;

describe('InteractiveFactoid', () => {
  it.each(TYPES)('draws a %s card in neutral greys: only its chip says how it is known', (type) => {
    const { container } = render(
      <InteractiveFactoid
        factoid={{ id: 'f', title: 'Title', content: 'A fact.', type } as Factoid}
        origin="inferred"
      />,
    );
    const card = container.querySelector('[data-factoid-category]') as HTMLElement;
    const header = card.querySelector('[data-factoid-header]') as HTMLElement;
    expect(card.className).not.toMatch(PROVENANCE_HUES);
    expect(header.innerHTML).not.toMatch(PROVENANCE_HUES);
    // The inferred icon belongs to the chip alone.
    expect(header.querySelector('svg.lucide-sparkles')).toBeNull();
    expect(card.querySelectorAll('[data-provenance="inferred"]')).toHaveLength(1);
  });

  it('labels a card taken from source data with the record chip, not the model', () => {
    const { container } = render(
      <InteractiveFactoid
        factoid={{ id: 'f', title: 'Title', content: 'A fact.', type: 'trivia' } as Factoid}
        origin="record"
      />,
    );
    const chip = container.querySelector('[data-provenance]') as HTMLElement;
    expect(chip.dataset.provenance).toBe('record');
    expect(chip.textContent).toBe('From source data');
  });
});
