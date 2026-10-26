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

  it('draws entity chips in neutral greys, each with its type as an icon and a word', () => {
    const types = ['synth', 'producer', 'sample', 'technique', 'artist', 'album', 'year'] as const;
    const factoid = {
      id: 'f',
      title: 'Title',
      content: types.map((type) => `${type}-name`).join(', '),
      type: 'sample',
      entities: types.map((type, i) => ({ id: `e${i}`, text: `${type}-name`, type })),
    } as Factoid;
    const { container } = render(<InteractiveFactoid factoid={factoid} origin="inferred" />);
    const chips = [...container.querySelectorAll<HTMLElement>('button[title^="Search: "]')];
    expect(chips).toHaveLength(types.length);
    for (const [i, type] of types.entries()) {
      const chip = chips[i];
      expect(chip.className, type).not.toMatch(PROVENANCE_HUES);
      expect(chip.className, type).not.toMatch(/pink/);
      expect(chip.getAttribute('aria-label'), type).toBe(`${type}-name (${type})`);
      expect(chip.querySelectorAll('svg').length, type).toBe(2);
    }
    // The count of chips under the card is neutral too.
    const count = container.querySelector('[data-entity-count]') as HTMLElement;
    expect(count.outerHTML).not.toMatch(PROVENANCE_HUES);
  });
});
