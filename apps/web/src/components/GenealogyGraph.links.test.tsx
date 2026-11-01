import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The audio hook, stubbed with stable callbacks as the real one's are (new ones would redraw
// the graph on every render).
const audio = vi.hoisted(() => ({
  isPlaying: false,
  playingNodeId: null,
  hasPreviewSupport: true,
  blockedNodeId: null,
  unavailableNodeId: null,
  playPreview: () => {},
  stopPreview: () => {},
}));
vi.mock('./genealogy/useAudioPreview', () => ({ useAudioPreview: () => audio }));

import GenealogyGraph from './GenealogyGraph';
import { LINK_COLOR } from './genealogy/linkStyle';
import { claim, link, node, PACK } from './genealogy/testing';
import { resultClaims } from './provenance/claims';
import type { TrackData } from '../types';

/** A ResizeObserver that reports a size at once, so the graph is drawn. */
class SizedObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    this.callback(
      [{ target, contentRect: { width: 800, height: 600 } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    );
  }
  unobserve() {}
  disconnect() {}
}

// "Older Record" is in group 2 and joined by a code-built sourced sample; "Guess" is also in
// group 2 but joined by a sample the model proposed: its group must not make it an origin.
// "Disputed" is joined by a sample whose claim the verifier contradicted: it is not drawn.
const data = {
  nodes: [
    // The analysed track and the sourced sample carry a record's year (the result's release year,
    // MusicBrainz); the model's tracks carry one in their label only: undated on the map.
    {
      ...node('current', 1, 'Bright Lines - Test Artist (2011)'),
      trackTitle: 'Bright Lines',
      year: 2011,
    },
    { ...node('older', 2, 'Older Record - Someone (1984)'), year: 1984 },
    node('guess', 2, 'Guess - Someone (1990)'),
    node('peer', 4, 'Peer - Someone (2001)'),
    node('disputed', 2, 'Disputed - Someone (1979)'),
  ],
  links: [
    link('older', 'current', {
      type: 'sample',
      kind: 'sourced',
      origin: 'code',
      evidenceIds: ['ev-mb-1'],
      value: 3,
    }),
    link('guess', 'current', { type: 'sample', kind: 'inferred', evidenceIds: [] }),
    link('peer', 'current', { type: 'producer', kind: 'inferred', evidenceIds: ['ev-shs-1'] }),
    link('disputed', 'current', {
      type: 'sample',
      kind: 'sourced',
      origin: 'code',
      evidenceIds: ['ev-mb-1'],
      claimId: 'cl-bad',
    }),
  ],
};
const claims = resultClaims({
  evidence: PACK,
  claims: [claim('cl-bad', { verdict: 'contradicted' })],
} as unknown as TrackData);
/** The graph as the Player draws it: with the result's evidence pack and claims. */
const Graph = (props: Partial<React.ComponentProps<typeof GenealogyGraph>>) => (
  <GenealogyGraph data={data} evidence={PACK} claims={claims} {...props} />
);

// As a claim's chip names the item, with its tier for a sourced link.
const MB_SOURCED = 'ev-mb-1 (MusicBrainz · primary record)';
const lines = (container: HTMLElement) => [...container.querySelectorAll('g.links path')];
/** The relation chips drawn now. */
const chips = (container: HTMLElement) => [...container.querySelectorAll('g.link-chips g.chip')];
const nodeGroup = (container: HTMLElement, id: string) => {
  const group = container.querySelector(`g.nodes > g[data-node-id="${id}"]`);
  if (!group) throw new Error(`no drawn node ${id}`);
  return group as SVGGElement;
};
const subLabel = (container: HTMLElement, id: string) =>
  nodeGroup(container, id).querySelector('.sub-label')?.textContent;
/** Every element in the graph that keyboard focus can reach, in order. */
const focusables = (container: HTMLElement) => [
  ...container.querySelectorAll<SVGElement>('g.nodes > g'),
  ...container.querySelectorAll<SVGElement>('g.link-targets path'),
];

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', SizedObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GenealogyGraph links', () => {
  it('draws each link by its kind and relation, names it in a chip on hover, and leaves out the rejected', async () => {
    const { container } = render(<Graph />);
    const drawn = lines(container).map((line) => ({
      kind: line.getAttribute('data-link-kind'),
      type: line.getAttribute('data-link-type'),
      stroke: line.getAttribute('stroke'),
      dash: line.getAttribute('stroke-dasharray'),
    }));
    expect(drawn).toEqual([
      { kind: 'sourced', type: 'sample', stroke: LINK_COLOR.sample, dash: 'none' },
      // The model's sample, not sourced: drawn grey and dashed as an influence (never in the
      // sample's amber, the sourced colour), and named the possible sample it states.
      { kind: 'inferred', type: 'influence', stroke: LINK_COLOR.influence, dash: '6 4' },
      { kind: 'inferred', type: 'producer', stroke: LINK_COLOR.producer, dash: '6 4' },
    ]);
    // No relation is written on the map at rest: a chip names it while the link is pointed at.
    expect(chips(container)).toEqual([]);
    const targets = [...container.querySelectorAll<SVGPathElement>('g.link-targets path')];
    const names: Array<string | null | undefined> = [];
    for (const target of targets) {
      await act(async () => {
        target.dispatchEvent(new MouseEvent('mouseenter'));
      });
      expect(chips(container)).toHaveLength(1);
      names.push(chips(container)[0].textContent);
      if (names.length === 2) {
        // Edged in the colour the link is drawn in: grey for the sample that is not sourced.
        expect(chips(container)[0].querySelector('rect')?.getAttribute('stroke')).toBe(
          LINK_COLOR.influence,
        );
      }
      await act(async () => {
        target.dispatchEvent(new MouseEvent('mouseleave'));
      });
      expect(chips(container)).toEqual([]);
    }
    expect(names).toEqual(['Sample', 'Possible sample', 'Possible shared producer']);
    // An arrowhead shows the direction of each link but the shared producer's.
    expect(lines(container).map((line) => line.getAttribute('marker-end') !== null)).toEqual([
      true,
      true,
      false,
    ]);
    expect(screen.getByTestId('links-hidden').textContent).toBe(
      '1 link not shown: the claim behind it was rejected or cannot be read.',
    );
  });

  it('marks as an origin only a track a sourced link says this one samples', () => {
    const { container } = render(<Graph />);
    expect(subLabel(container, 'older')).toBe('Origin');
    expect(subLabel(container, 'current')).toBe('This track');
    expect(subLabel(container, 'guess')).toBeUndefined();
    // A track whose only link was rejected is no origin either.
    expect(subLabel(container, 'disputed')).toBeUndefined();
  });

  it('gives its hints in a neutral hue: the measured hue is for measured values', () => {
    render(<Graph />);
    expect(screen.getByText('Click a track for its details').className).not.toMatch(/cyber/);
  });

  it('marks no origin for a track that samples or remixes this one, sourced as it is', () => {
    // Bright Lines (2011) → Later (2015): the later track uses this one, not the other way.
    const derived = {
      nodes: [
        ...data.nodes,
        node('later', 3, 'Later - Someone (2015)'),
        node('remix', 3, 'Remix - Someone (2016)'),
      ],
      links: [
        ...data.links,
        link('current', 'later', {
          type: 'sample',
          kind: 'sourced',
          origin: 'code',
          evidenceIds: ['ev-mb-1'],
        }),
        link('current', 'remix', {
          type: 'remix',
          kind: 'sourced',
          origin: 'code',
          evidenceIds: ['ev-mb-1'],
        }),
      ],
    };
    const { container } = render(<Graph data={derived} />);
    const kinds = lines(container).map((line) => line.getAttribute('data-link-kind'));
    expect(kinds.slice(-2)).toEqual(['sourced', 'sourced']);
    for (const id of ['later', 'remix']) {
      expect(subLabel(container, id)).toBeUndefined();
      expect((nodeGroup(container, id).querySelector('rect') as SVGElement).style.filter).toBe(
        'none',
      );
    }
    expect(subLabel(container, 'older')).toBe('Origin');
  });

  it('shows every link as inferred without the evidence pack', async () => {
    const { container } = render(<Graph evidence={undefined} />);
    expect(lines(container).map((line) => line.getAttribute('data-link-kind'))).toEqual([
      'inferred',
      'inferred',
      'inferred',
    ]);
    expect(lines(container)[0].getAttribute('data-link-type')).toBe('influence');
    expect(lines(container)[0].getAttribute('stroke')).toBe(LINK_COLOR.influence);
    const target = container.querySelector('g.link-targets path') as SVGPathElement;
    await act(async () => {
      target.dispatchEvent(new MouseEvent('mouseenter'));
    });
    expect(chips(container)[0].textContent).toBe('Possible sample');
    expect(subLabel(container, 'older')).toBeUndefined();
  });

  it('shows a link’s relation and provenance while it is pointed at', async () => {
    const { container } = render(<Graph />);
    const targets = [...container.querySelectorAll<SVGPathElement>('g.link-targets path')];
    expect(targets[0].getAttribute('aria-label')).toBe(
      `Bright Lines (2011) samples Older Record - Someone (1984). Sourced · cites ${MB_SOURCED}.`,
    );
    // A role that takes a name: a path has none of its own.
    expect(targets.map((target) => target.getAttribute('role'))).toEqual(targets.map(() => 'img'));
    // No native tooltip repeating the detail.
    expect(targets[0].querySelector('title')).toBeNull();

    await act(async () => {
      targets[0].dispatchEvent(new MouseEvent('mouseenter'));
    });
    expect(screen.getByTestId('link-detail').textContent).toBe(
      `Bright Lines (2011) samples Older Record - Someone (1984)Sourced · cites ${MB_SOURCED}`,
    );
    await act(async () => {
      targets[0].dispatchEvent(new MouseEvent('mouseleave'));
    });
    expect(screen.queryByTestId('link-detail')).toBeNull();
  });

  it('is one tab stop; the arrow keys move between tracks and links, Enter selects a track', async () => {
    const onNodeClick = vi.fn();
    const { container } = render(<Graph onNodeClick={onNodeClick} />);
    const items = focusables(container);
    // Five tracks, then three links; only the first is in the tab order.
    expect(items).toHaveLength(8);
    expect(items.map((item) => item.getAttribute('tabindex'))).toEqual([
      '0',
      '-1',
      '-1',
      '-1',
      '-1',
      '-1',
      '-1',
      '-1',
    ]);
    expect(items[0].getAttribute('aria-label')).toBe('Bright Lines (2011), the analyzed track');
    expect(items[1].getAttribute('role')).toBe('button');

    await act(async () => items[0].focus());
    await act(async () => {
      fireEvent.keyDown(items[0], { key: 'ArrowRight' });
    });
    expect(document.activeElement).toBe(items[1]);
    expect(items[1].getAttribute('tabindex')).toBe('0');
    expect(items[0].getAttribute('tabindex')).toBe('-1');
    // The focused track: its ring shows, and the detail says how it is related.
    expect(items[1].querySelector('.focus-ring')?.getAttribute('opacity')).toBe('1');
    expect(screen.getByTestId('link-detail').textContent).toBe(
      'Older Record - Someone (1984)Bright Lines (2011) samples Older Record - Someone (1984)' +
        `Sourced · cites ${MB_SOURCED}Enter: show its details`,
    );
    // Enter selects the track and opens its details; it analyses nothing.
    await act(async () => {
      fireEvent.keyDown(items[1], { key: 'Enter' });
    });
    expect(items[1].getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('node-detail')).toBeTruthy();
    expect(onNodeClick).not.toHaveBeenCalled();
    // Escape closes them, and the focus is back on the track.
    await act(async () => {
      fireEvent.keyDown(screen.getByTestId('node-detail'), { key: 'Escape' });
    });
    expect(screen.queryByTestId('node-detail')).toBeNull();
    expect(items[1].getAttribute('aria-pressed')).toBe('false');
    expect(document.activeElement).toBe(items[1]);

    // End: the last link. Its band shows as the focus ring.
    await act(async () => {
      fireEvent.keyDown(items[1], { key: 'End' });
    });
    expect(document.activeElement).toBe(items[7]);
    expect(items[7].getAttribute('stroke-opacity')).toBe('0.3');
    expect(lines(container).map((line) => line.getAttribute('stroke-opacity'))).toEqual([
      '0.15',
      '0.15',
      '1',
    ]);
    // Enter on a link selects nothing; Enter on the analyzed track selects nothing either.
    await act(async () => {
      fireEvent.keyDown(items[7], { key: 'Enter' });
    });
    await act(async () => {
      fireEvent.keyDown(items[7], { key: 'Home' });
    });
    expect(document.activeElement).toBe(items[0]);
    await act(async () => {
      fireEvent.keyDown(items[0], { key: 'Enter' });
    });
    expect(screen.queryByTestId('node-detail')).toBeNull();
    expect(items[0].hasAttribute('aria-pressed')).toBe(false);
    expect(onNodeClick).not.toHaveBeenCalled();
  });

  it('keeps the focused link’s detail when the pointer passes over another and leaves', async () => {
    const { container } = render(<Graph />);
    const targets = [...container.querySelectorAll<SVGPathElement>('g.link-targets path')];
    await act(async () => targets[2].focus());
    const focusedText = screen.getByTestId('link-detail').textContent;
    expect(focusedText).toContain('may share a producer');
    await act(async () => {
      targets[0].dispatchEvent(new MouseEvent('mouseenter'));
    });
    expect(screen.getByTestId('link-detail').textContent).toContain('samples');
    await act(async () => {
      targets[0].dispatchEvent(new MouseEvent('mouseleave'));
    });
    expect(screen.getByTestId('link-detail').textContent).toBe(focusedText);
    await act(async () => targets[2].blur());
    expect(screen.queryByTestId('link-detail')).toBeNull();
  });

  it('closes the focused item’s detail with Escape, and leaves the next Escape to the page', async () => {
    const { container } = render(<Graph />);
    const items = focusables(container);
    await act(async () => items[1].focus());
    expect(screen.getByTestId('link-detail')).toBeTruthy();
    // The first Escape is the graph's: the box closes, and the page is told it was handled.
    const first = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => {
      items[1].dispatchEvent(first);
    });
    expect(first.defaultPrevented).toBe(true);
    expect(screen.queryByTestId('link-detail')).toBeNull();
    expect(document.activeElement).toBe(items[1]);
    // Nothing is open now: the next one goes on to the page (the Player goes back).
    const second = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    await act(async () => {
      items[1].dispatchEvent(second);
    });
    expect(second.defaultPrevented).toBe(false);
    // Another item shows its detail again, and so does the first once the focus comes back.
    await act(async () => {
      fireEvent.keyDown(items[1], { key: 'ArrowRight' });
    });
    expect(screen.getByTestId('link-detail').textContent).toContain('Guess');
    await act(async () => {
      fireEvent.keyDown(items[2], { key: 'ArrowLeft' });
    });
    expect(screen.getByTestId('link-detail').textContent).toContain('Older Record');
  });

  it.each([
    ['plain', false, true],
    ['modifier', false, false],
    ['modifier', true, true],
  ] as const)(
    'with the wheel set to %s, a wheel turn (Ctrl held: %s) zooms the graph: %s',
    async (wheelZoom, ctrlKey, zooms) => {
      const { container } = render(<Graph wheelZoom={wheelZoom} />);
      const svg = container.querySelector('svg[aria-label="Connections graph"]') as SVGSVGElement;
      // d3 reads the pointer through SVG geometry this test's DOM lacks: it falls back to the
      // element's box.
      Object.defineProperty(svg, 'createSVGPoint', { value: undefined });
      const drawing = svg.querySelector(':scope > g') as SVGGElement;
      const before = drawing.getAttribute('transform');
      const wheel = new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true });
      // This test DOM's WheelEvent drops the modifier keys it is given.
      Object.defineProperty(wheel, 'ctrlKey', { value: ctrlKey });
      await act(async () => {
        svg.dispatchEvent(wheel);
      });
      // A wheel the graph takes is kept from the page; one it leaves scrolls the page.
      expect(wheel.defaultPrevented).toBe(zooms);
      expect(drawing.getAttribute('transform') !== before).toBe(zooms);
    },
  );

  it('names the zoom gesture as the wheel works', () => {
    render(<Graph wheelZoom="modifier" />);
    expect(screen.getByText('Ctrl or ⌘ + scroll to zoom')).toBeTruthy();
    cleanup();
    render(<Graph />);
    expect(screen.getByText('Scroll to zoom')).toBeTruthy();
  });

  it('hides the drawing’s own words from screen readers', () => {
    const { container } = render(<Graph />);
    expect(container.querySelector('g.link-chips')?.getAttribute('aria-hidden')).toBe('true');
    expect(container.querySelector('g.links')?.getAttribute('aria-hidden')).toBe('true');
    const texts = [...container.querySelectorAll('g.nodes text')];
    expect(texts.length).toBeGreaterThan(0);
    for (const text of texts) expect(text.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('lists every shown link as a sentence with its provenance, and shows the legend', () => {
    render(<Graph />);
    const list = screen.getByRole('list', { name: 'Genealogy links' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      `Bright Lines (2011) samples Older Record - Someone (1984). Sourced · cites ${MB_SOURCED}.`,
      'Possible sample: Bright Lines (2011) may sample Guess - Someone (1990). Model ' +
        'inference · no evidence cited.',
      'Peer - Someone (2001) and Bright Lines (2011) may share a producer. Model inference · ' +
        'cites ev-shs-1 (SecondHandSongs), not checked by a ' +
        'verifier.',
    ]);
    expect(screen.getByText('Links as a list (3)').closest('details')?.open).toBe(false);
    const legend = screen.getByRole('group', { name: 'Link legend' });
    expect(within(legend).getByRole('list', { name: 'Relations' }).textContent).toBe(
      // The grey is drawn for the model's sample, not sourced: no influence is stated.
      'SampleShared producerNot sourced (any relation)',
    );
  });

  it('gives screen readers each track’s relation from its link, not its group', () => {
    const { container } = render(<Graph />);
    const summary = container.querySelector('.sr-only')?.textContent;
    expect(summary).toContain('Connections: 4 related tracks.');
    // Which track uses which, as a sentence naming both.
    expect(summary).toContain(
      'Older Record - Someone (1984): Bright Lines (2011) samples Older Record - Someone (1984) (Sourced).',
    );
    expect(summary).toContain(
      // Its year is the model's (in its label), not a record's: its card is undated.
      'Guess - Someone (1990) (undated): Possible sample: Bright Lines (2011) may sample Guess - Someone (1990) (Model inference).',
    );
    expect(summary).toContain('Disputed - Someone (1979) (undated): no direct link to this track.');
  });

  it('counts the links the caller left out with those it hides itself', () => {
    render(<Graph hiddenLinks={2} />);
    expect(screen.getByTestId('links-hidden').textContent).toBe(
      '3 links not shown: the claims behind them were rejected or cannot be read.',
    );
  });

  it('has no legend or list without links', () => {
    render(<GenealogyGraph data={{ nodes: [node('current', 1, 'Bright Lines')], links: [] }} />);
    expect(screen.queryByRole('group', { name: 'Link legend' })).toBeNull();
    expect(screen.queryByText(/Links as a list/)).toBeNull();
  });
});
