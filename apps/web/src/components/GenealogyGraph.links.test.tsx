import { act, cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The audio hook, stubbed with stable callbacks as the real one's are (new ones would redraw
// the graph on every render).
const audio = vi.hoisted(() => ({
  isPlaying: false,
  playingNodeId: null,
  hasPreviewSupport: true,
  unavailableNodeId: null,
  playPreview: () => {},
  stopPreview: () => {},
}));
vi.mock('./genealogy/useAudioPreview', () => ({ useAudioPreview: () => audio }));

import GenealogyGraph from './GenealogyGraph';
import { LINK_COLOR } from './genealogy/linkStyle';
import { link, node, PACK } from './genealogy/testing';

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

// "Older Record" is in group 2 and joined by a sourced sample; "Guess" is also in group 2 but
// joined by a sample the model proposed: its group must not make it an origin.
const data = {
  nodes: [
    node('current', 1, 'Bright Lines'),
    node('older', 2, 'Older Record'),
    node('guess', 2, 'Guess'),
    node('peer', 4, 'Peer'),
  ],
  links: [
    link('older', 'current', {
      type: 'sample',
      kind: 'sourced',
      evidenceIds: ['ev-mb-1'],
      value: 3,
    }),
    link('guess', 'current', { type: 'sample', kind: 'inferred', evidenceIds: [] }),
    link('peer', 'current', { type: 'producer', kind: 'inferred', evidenceIds: ['ev-shs-1'] }),
  ],
};

const lines = (container: HTMLElement) => [...container.querySelectorAll('g.links line')];
const subLabel = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll('g.nodes > g')]
    .find((g) => g.textContent?.startsWith(label))
    ?.querySelectorAll('text')[1]?.textContent;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', SizedObserver);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('GenealogyGraph links', () => {
  it('draws each link by its kind and relation, and names the relation on the line', () => {
    const { container } = render(<GenealogyGraph data={{ ...data, evidence: PACK }} />);
    const drawn = lines(container).map((line) => ({
      kind: line.getAttribute('data-link-kind'),
      type: line.getAttribute('data-link-type'),
      stroke: line.getAttribute('stroke'),
      dash: line.getAttribute('stroke-dasharray'),
    }));
    expect(drawn).toEqual([
      { kind: 'sourced', type: 'sample', stroke: LINK_COLOR.sample, dash: 'none' },
      { kind: 'inferred', type: 'influence', stroke: LINK_COLOR.influence, dash: '6 4' },
      { kind: 'inferred', type: 'producer', stroke: LINK_COLOR.producer, dash: '6 4' },
    ]);
    const names = [...container.querySelectorAll('g.link-labels text')].map((t) => t.textContent);
    expect(names).toEqual(['sample', 'influence', 'shared producer']);
  });

  it('marks as an origin only a track a sourced link says this one samples', () => {
    const { container } = render(<GenealogyGraph data={{ ...data, evidence: PACK }} />);
    expect(subLabel(container, 'Older Record')).toBe('[ORIGIN]');
    expect(subLabel(container, 'Guess')).toBe('[LINK]');
  });

  it('shows every link as inferred without the evidence pack', () => {
    const { container } = render(<GenealogyGraph data={data} />);
    expect(lines(container).map((line) => line.getAttribute('data-link-kind'))).toEqual([
      'inferred',
      'inferred',
      'inferred',
    ]);
    expect(lines(container)[0].getAttribute('data-link-type')).toBe('influence');
    expect(subLabel(container, 'Older Record')).toBe('[LINK]');
  });

  it('shows a link’s relation and provenance while it is pointed at or focused', async () => {
    const { container } = render(<GenealogyGraph data={{ ...data, evidence: PACK }} />);
    const targets = [...container.querySelectorAll<SVGLineElement>('g.link-targets line')];
    expect(targets.map((t) => t.getAttribute('tabindex'))).toEqual(['0', '0', '0']);
    expect(targets[0].getAttribute('aria-label')).toBe(
      'Older Record → Bright Lines: Sample. Sourced · cites ev-mb-1 (musicbrainz).',
    );
    expect(targets[0].querySelector('title')?.textContent).toBe(
      targets[0].getAttribute('aria-label'),
    );

    await act(async () => {
      targets[0].dispatchEvent(new MouseEvent('mouseenter'));
    });
    expect(screen.getByTestId('link-detail').textContent).toBe(
      'Older Record → Bright LinesSample · Sourced · cites ev-mb-1 (musicbrainz)',
    );
    await act(async () => {
      targets[0].dispatchEvent(new MouseEvent('mouseleave'));
    });
    expect(screen.queryByTestId('link-detail')).toBeNull();

    await act(async () => {
      targets[2].dispatchEvent(new FocusEvent('focus'));
    });
    expect(screen.getByTestId('link-detail').textContent).toBe(
      'Peer → Bright LinesShared producer · Model inference · cites ev-shs-1 (secondhandsongs), not checked by a verifier',
    );
    // The focused link stands out; the others fade.
    expect(lines(container).map((line) => line.getAttribute('stroke-opacity'))).toEqual([
      '0.15',
      '0.15',
      '1',
    ]);
    await act(async () => {
      targets[2].dispatchEvent(new FocusEvent('blur'));
    });
    expect(screen.queryByTestId('link-detail')).toBeNull();
  });

  it('lists every link with its relation and provenance, and shows the legend', () => {
    render(<GenealogyGraph data={{ ...data, evidence: PACK }} />);
    const list = screen.getByRole('list', { name: 'Genealogy links' });
    expect(
      within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Older Record → Bright Lines: Sample. Sourced · cites ev-mb-1 (musicbrainz).',
      'Guess → Bright Lines: Influence. Model inference · stated as a sample, shown as an influence; no evidence cited.',
      'Peer → Bright Lines: Shared producer. Model inference · cites ev-shs-1 (secondhandsongs), not checked by a verifier.',
    ]);
    expect(screen.getByText('Links as a list (3)').closest('details')?.open).toBe(false);
    const legend = screen.getByRole('group', { name: 'Link legend' });
    expect(within(legend).getByRole('list', { name: 'Relations' }).textContent).toBe(
      'SampleShared producerInfluence',
    );
  });

  it('gives screen readers each track’s relation from its link, not its group', () => {
    const { container } = render(<GenealogyGraph data={{ ...data, evidence: PACK }} />);
    const summary = container.querySelector('.sr-only')?.textContent;
    expect(summary).toContain('Older Record (Sampled in this track, Sourced).');
    expect(summary).toContain('Guess (Possible influence, Model inference).');
    expect(summary).not.toContain('Guess (Sampled');
  });

  it('has no legend or list without links', () => {
    render(<GenealogyGraph data={{ nodes: [node('current', 1, 'Bright Lines')], links: [] }} />);
    expect(screen.queryByRole('group', { name: 'Link legend' })).toBeNull();
    expect(screen.queryByText(/Links as a list/)).toBeNull();
  });
});
