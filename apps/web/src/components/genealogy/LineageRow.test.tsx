import { cleanup, render, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { LineageRow } from './LineageRow';
import { nodeName, nodesById, readGenealogy } from './links';
import { contextOf, link, node } from './testing';

afterEach(cleanup);

/** The row for these links, and the list (by its name) each track's card is in. */
function placesOf(
  nodes: ReturnType<typeof node>[],
  links: ReturnType<typeof link>[],
): Record<string, string> {
  const shown = readGenealogy({ nodes, links }, contextOf()).links;
  const named = nodesById(nodes);
  const currentId = nodes.find((n) => n.group === 1)?.id ?? null;
  const view = render(
    <LineageRow
      nodes={nodes}
      links={shown}
      currentId={currentId}
      yearOf={() => null}
      isOrigin={() => false}
      describe={(n) => n.label}
      nameOf={(id) => nodeName(named.get(id), id)}
      onAnalyse={() => {}}
    />,
  );
  const places: Record<string, string> = {};
  for (const card of view.container.querySelectorAll('[data-lineage-card]')) {
    const list = card.closest('ul');
    places[card.getAttribute('data-lineage-card') ?? ''] = list?.getAttribute('aria-label') ?? '';
  }
  return places;
}

const sourced = { kind: 'sourced' as const, origin: 'code' as const, evidenceIds: ['ev-mb-1'] };

describe('the compact row', () => {
  it('orders only links whose direction is known; the rest are related tracks, in no order', () => {
    const places = placesOf(
      [
        node('current', 1, 'Bright Lines - Test Artist (2011)'),
        node('older', 2, 'Older - Someone (1984)'),
        // Its years contradict its direction: "related (direction unknown)".
        node('backwards', 2, 'Backwards - Someone (2020)'),
      ],
      [
        link('older', 'current', { type: 'sample', ...sourced }),
        link('backwards', 'current', { type: 'sample', kind: 'inferred', evidenceIds: [] }),
      ],
    );
    expect(places).toEqual({
      older: 'Tracks this one uses',
      current: '',
      backwards: 'Related tracks',
    });
  });

  it('puts a shared producer with the related tracks, never before or after this one', () => {
    const places = placesOf(
      [node('current', 1, 'Song (2011)'), node('peer', 4, 'Peer - Someone (2001)')],
      [link('peer', 'current', { type: 'producer', ...sourced })],
    );
    expect(places.peer).toBe('Related tracks');
  });

  it('shows a second hop by its own link to another track', () => {
    const view = placesOf(
      [
        node('current', 1, 'Song (2011)'),
        node('source', 2, 'Source - Someone (1984)'),
        node('sibling', 4, 'Sibling - Other (1990)'),
      ],
      [
        link('source', 'current', { type: 'sample', ...sourced }),
        link('source', 'sibling', { type: 'sample', ...sourced }),
      ],
    );
    expect(view.sibling).toBe('Related tracks');
    expect(document.body.textContent).toContain(
      'Sibling - Other (1990) samples Source - Someone (1984)',
    );
  });

  it('draws each link once, from its source to its target, with no analysed track', () => {
    placesOf(
      [node('a', 2, 'A - X (1984)'), node('b', 3, 'B - Y (1990)')],
      [link('a', 'b', { type: 'sample', ...sourced })],
    );
    const list = document.querySelector('ul[aria-label="Links"]') as HTMLElement;
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(1);
    expect(
      [...items[0].querySelectorAll('[data-lineage-card]')].map((card) =>
        card.getAttribute('data-lineage-card'),
      ),
    ).toEqual(['a', 'b']);
  });
});
