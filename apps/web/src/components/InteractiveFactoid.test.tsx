import type { Claim, Evidence } from '@liner-notes/contract';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { Factoid } from '../types';
import InteractiveFactoid from './InteractiveFactoid';
import type { ShownClaim } from './provenance/claims';
import { claim as aClaim, evidence as anItem } from './provenance/testing';

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

  it('draws entity links in neutral greys, each with its type as an icon and a word', () => {
    const types = ['synth', 'producer', 'sample', 'technique', 'artist', 'album', 'year'] as const;
    const factoid = {
      id: 'f',
      title: 'Title',
      content: types.map((type) => `${type}-name`).join(', '),
      type: 'sample',
      claimId: 'c1',
      entities: types.map((type, i) => ({ id: `e${i}`, text: `${type}-name`, type })),
    } as Factoid;
    const { container } = render(<InteractiveFactoid factoid={factoid} claim={sourced()} />);
    const links = [...container.querySelectorAll<HTMLElement>('a[data-entity-type]')];
    expect(links).toHaveLength(types.length);
    for (const [i, type] of types.entries()) {
      const link = links[i];
      expect(link.className, type).not.toMatch(PROVENANCE_HUES);
      expect(link.className, type).not.toMatch(/pink/);
      expect(link.getAttribute('aria-label'), type).toBe(
        `${type}-name (${type}), opens the cited source in a new tab`,
      );
      expect(link.querySelectorAll('svg').length, type).toBe(2);
    }
    // The count of links under the card is neutral too.
    const count = container.querySelector('[data-entity-count]') as HTMLElement;
    expect(count.outerHTML).not.toMatch(PROVENANCE_HUES);
  });
});

const SOURCE_URL = 'https://www.whosampled.com/sample/1/';
const cited = (overrides: Partial<Evidence> = {}) =>
  anItem({ id: 'ev1', source: 'tavily', sourceTier: 'web', url: SOURCE_URL, ...overrides });

/** A claim as the Player shows it (`kind` its display kind, `cited` the items it cites). */
const shown = (claim: Claim, kind: ShownClaim['kind'], items: Evidence[] = []): ShownClaim => ({
  claim,
  key: `0:${claim.id}`,
  kind,
  cited: items,
  missingCitations: 0,
  rejected: false,
});

/** A model claim about a sample, judged supported by the item it cites: shown as sourced. */
const sourced = (items: Evidence[] = [cited()]) =>
  shown(
    aClaim({
      about: 'sample',
      kind: 'sourced',
      evidenceIds: items.map((item) => item.id),
      verdict: 'supported',
    }),
    'sourced',
    items,
  );

/** A model's guess about a sample, citing an item the judge did not support it with. */
const guessed = () =>
  shown(aClaim({ about: 'sample', evidenceIds: ['ev1'] }), 'inferred', [cited()]);

/** A card that names one entity, the record it says is sampled. */
const sampleCard = (type: Factoid['type'] = 'sample'): Factoid => ({
  id: 'fc-aaaaaaaaaaaa',
  title: 'Hidden Sample',
  content: 'It samples Old Record by an older band.',
  type,
  claimId: 'c1',
  entities: [{ id: 'e1', text: 'Old Record', type: 'sample', searchQuery: 'Old Record' }],
});

const typeBadge = (container: HTMLElement) =>
  (container.querySelector('[data-factoid-type]') as HTMLElement).textContent;

describe('InteractiveFactoid with its claim', () => {
  it('shows a sourced claim with its chip and links its entity to the cited source', () => {
    const { container } = render(<InteractiveFactoid factoid={sampleCard()} claim={sourced()} />);
    expect(container.querySelector('[data-claim-kind]')?.getAttribute('data-claim-kind')).toBe(
      'sourced',
    );
    expect(container.querySelector('[data-provenance="sourced"]')?.textContent).toBe('Sourced');
    const link = screen.getByRole('link', {
      name: 'Old Record (sample), opens the cited source in a new tab',
    });
    expect(link.getAttribute('href')).toBe(SOURCE_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(typeBadge(container)).toBe('SAMPLE');
    // No web search anywhere on the card.
    expect(container.innerHTML).not.toContain('google.com');
  });

  it('links the first cited source that can be opened', () => {
    const items = [cited({ id: 'ev0', url: 'javascript:alert(1)' }), cited()];
    render(<InteractiveFactoid factoid={sampleCard()} claim={sourced(items)} />);
    expect(screen.getByRole('link', { name: /^Old Record/ }).getAttribute('href')).toBe(SOURCE_URL);
  });

  it('shows an inferred claim with no link, and its sample as a possible sample', () => {
    const { container } = render(<InteractiveFactoid factoid={sampleCard()} claim={guessed()} />);
    expect(container.querySelector('[data-provenance="inferred"]')?.textContent).toBe(
      'Model inference',
    );
    expect(container.querySelector('a[data-entity-type]')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
    expect(container.textContent).toContain('Old Record');
    expect(typeBadge(container)).toBe('POSSIBLE SAMPLE');
    // A card no entity of which can be opened counts none as clickable.
    expect(container.querySelector('[data-entity-count]')).toBeNull();
  });

  it('gives a sourced claim with no source that can be opened no link', () => {
    const items = [cited({ url: null })];
    const { container } = render(
      <InteractiveFactoid factoid={sampleCard()} claim={sourced(items)} />,
    );
    expect(container.querySelector('a[data-entity-type]')).toBeNull();
    expect(typeBadge(container)).toBe('SAMPLE');
  });

  it('takes the type from the claim, not from the card', () => {
    // The card calls itself trivia; its claim, sourced, is about a sample.
    const { container: asSample } = render(
      <InteractiveFactoid factoid={sampleCard('trivia')} claim={sourced()} />,
    );
    expect(typeBadge(asSample)).toBe('SAMPLE');
    cleanup();
    // The card calls itself a sample; its claim is about a credit.
    const credit = shown(aClaim({ about: 'credit' }), 'inferred');
    const { container: asCredit } = render(
      <InteractiveFactoid factoid={sampleCard('sample')} claim={credit} />,
    );
    expect(typeBadge(asCredit)).toBe('CREDITS');
  });

  it.each([
    ['sample', 'POSSIBLE SAMPLE'],
    ['cover', 'POSSIBLE COVER'],
  ] as const)(
    'reads a partly supported %s as possible, keeping its chip and link',
    (about, badge) => {
      // A relation is stated whole: a source that supports only part of it does not confirm it.
      const partial = shown(
        aClaim({ about, kind: 'sourced', evidenceIds: ['ev1'], verdict: 'partial' }),
        'sourced',
        [cited()],
      );
      const { container } = render(<InteractiveFactoid factoid={sampleCard()} claim={partial} />);
      expect(typeBadge(container)).toBe(badge);
      expect(container.textContent).toContain('Partly supported');
      expect(container.querySelector('[data-provenance="sourced"]')).not.toBeNull();
      expect(container.querySelector('a[data-entity-type]')?.getAttribute('href')).toBe(SOURCE_URL);
    },
  );

  it('counts only the entities drawn as links', () => {
    const card = {
      ...sampleCard(),
      entities: [
        { id: 'e1', text: 'Old Record', type: 'sample' },
        // Not in the fact's text as written: neither is drawn.
        { id: 'e2', text: 'old record', type: 'sample' },
        { id: 'e3', text: 'Nowhere', type: 'album' },
      ],
    } as Factoid;
    const { container } = render(<InteractiveFactoid factoid={card} claim={sourced()} />);
    expect(container.querySelectorAll('a[data-entity-type]')).toHaveLength(1);
    expect(container.querySelector('[data-entity-count]')?.textContent).toBe('1 CLICKABLE ENTITY');
  });

  it('reads a cover the model guessed as a possible cover', () => {
    const cover = shown(aClaim({ about: 'cover' }), 'inferred');
    const { container } = render(<InteractiveFactoid factoid={sampleCard()} claim={cover} />);
    expect(typeBadge(container)).toBe('POSSIBLE COVER');
  });

  it('says a claim the verifier gave no verdict was not checked', () => {
    const unchecked = shown(
      aClaim({ about: 'sample', kind: 'sourced', evidenceIds: ['ev1'], verdict: null }),
      'inferred',
      [cited()],
    );
    const { container } = render(<InteractiveFactoid factoid={sampleCard()} claim={unchecked} />);
    expect(container.textContent).toContain('not checked by the verifier');
    expect(container.querySelector('a[data-entity-type]')).toBeNull();
    expect(typeBadge(container)).toBe('POSSIBLE SAMPLE');
  });

  it("reads a model card's sample without a claim as possible, and one from source data as a sample", () => {
    const card = { ...sampleCard(), claimId: undefined };
    const { container: model } = render(<InteractiveFactoid factoid={card} origin="inferred" />);
    expect(typeBadge(model)).toBe('POSSIBLE SAMPLE');
    expect(model.querySelector('a, button')).toBeNull();
    cleanup();
    const { container: record } = render(
      <InteractiveFactoid factoid={card} origin="record" fromSourceData />,
    );
    expect(typeBadge(record)).toBe('SAMPLE');
  });
});
