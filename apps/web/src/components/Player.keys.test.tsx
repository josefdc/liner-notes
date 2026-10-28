import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { GenealogyNode, TrackData } from '../types';
import { provenanceTrack } from './provenance/testing';

// The graph, replaced by a stand-in that hands its node callback to the test: what the Player
// does when a related track is chosen there is tested without drawing it.
const graph = vi.hoisted(() => ({
  onNodeClick: null as null | ((node: GenealogyNode) => void),
  wheelZoom: undefined as string | undefined,
}));
vi.mock('./GenealogyGraph', () => ({
  default: (props: { onNodeClick?: (node: GenealogyNode) => void; wheelZoom?: string }) => {
    graph.onNodeClick = props.onNodeClick ?? null;
    graph.wheelZoom = props.wheelZoom;
    return <div data-testid="graph" />;
  },
}));

/** A window `width` px wide, as the layout's media queries read it (16 px to the rem). */
function windowWidth(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: width >= Number(/min-width:\s*([\d.]+)rem/.exec(query)?.[1] ?? 0) * 16,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

import Player from './Player';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  graph.onNodeClick = null;
  graph.wheelZoom = undefined;
});

/** The provenance result (it has claims the verifier rejected) with a related track. */
const track = (): TrackData =>
  ({
    ...provenanceTrack(),
    genealogy: {
      nodes: [
        { id: 'current', group: 1, label: 'Paper Lanterns - Test Artist (2011)', size: 40 },
        { id: 'peer', group: 4, label: 'Peer - Someone (2001)', size: 22 },
      ],
      links: [{ source: 'peer', target: 'current', value: 1, type: 'influence', kind: 'inferred' }],
    },
  }) as unknown as TrackData;

const press = (target: Element | Document, key = 'Escape') =>
  act(async () => {
    fireEvent.keyDown(target, { key });
  });

const rejectedToggle = () => screen.getByRole('button', { name: /Rejected by the verifier/ });

describe('Escape in the Player', () => {
  it('goes back to the summary when nothing is open', async () => {
    const onBack = vi.fn();
    render(<Player trackData={track()} onBack={onBack} />);
    await press(document.body);
    expect(onBack).toHaveBeenCalledTimes(1);
    await press(screen.getByRole('heading', { level: 1 }));
    expect(onBack).toHaveBeenCalledTimes(2);
  });

  it('closes what is open first, and goes back only once nothing is', async () => {
    const onBack = vi.fn();
    render(<Player trackData={track()} onBack={onBack} />);
    fireEvent.click(rejectedToggle());
    expect(rejectedToggle().getAttribute('aria-expanded')).toBe('true');
    await press(rejectedToggle());
    expect(rejectedToggle().getAttribute('aria-expanded')).toBe('false');
    expect(onBack).not.toHaveBeenCalled();
    await press(rejectedToggle());
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the focus is in a text field', async () => {
    const onBack = vi.fn();
    render(<Player trackData={track()} onBack={onBack} />);
    // A text field inside the Player (a search box, a note): Escape is the field's.
    const field = document.createElement('input');
    field.type = 'search';
    document.getElementById('panel-context')?.append(field);
    field.focus();
    await press(field);
    expect(onBack).not.toHaveBeenCalled();
  });

  it('does nothing when the focus is outside the Player', async () => {
    const onBack = vi.fn();
    render(
      <>
        <Player trackData={track()} onBack={onBack} />
        <footer>
          <a href="https://example.org">Source code</a>
        </footer>
      </>,
    );
    const link = screen.getByRole('link', { name: 'Source code' });
    link.focus();
    await press(link);
    expect(onBack).not.toHaveBeenCalled();
  });

  it('does nothing once something inside has handled it', async () => {
    const onBack = vi.fn();
    render(<Player trackData={track()} onBack={onBack} />);
    const heading = screen.getByRole('heading', { level: 1 });
    heading.addEventListener('keydown', (event) => event.preventDefault());
    await press(heading);
    expect(onBack).not.toHaveBeenCalled();
  });

  it('stops listening once the Player is gone', async () => {
    const onBack = vi.fn();
    const { unmount } = render(<Player trackData={track()} onBack={onBack} />);
    unmount();
    await press(document.body);
    expect(onBack).not.toHaveBeenCalled();
  });
});

describe('the phone tabs', () => {
  const tabs = () => screen.getAllByRole('tab');
  const state = () =>
    tabs().map((tab) => [
      tab.textContent,
      tab.getAttribute('aria-selected'),
      tab.getAttribute('tabindex'),
    ]);

  it('name the panel each controls, and only the open one is in the Tab order', () => {
    windowWidth(390);
    render(<Player trackData={track()} onBack={() => {}} />);
    for (const tab of tabs()) {
      const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
    }
    expect(state()).toEqual([
      ['Analysis', 'false', '-1'],
      ['Player', 'true', '0'],
      ['Connections', 'false', '-1'],
    ]);
  });

  it('move with the arrow keys, wrapping round, and to the ends with Home and End', async () => {
    render(<Player trackData={track()} onBack={() => {}} />);
    const [analysis, player, connections] = tabs();
    player.focus();
    await press(player, 'ArrowRight');
    expect(document.activeElement).toBe(connections);
    expect(state()).toEqual([
      ['Analysis', 'false', '-1'],
      ['Player', 'false', '-1'],
      ['Connections', 'true', '0'],
    ]);
    await press(connections, 'ArrowRight');
    expect(document.activeElement).toBe(analysis);
    expect(analysis.getAttribute('aria-selected')).toBe('true');
    await press(analysis, 'ArrowLeft');
    expect(document.activeElement).toBe(connections);
    await press(connections, 'Home');
    expect(document.activeElement).toBe(analysis);
    expect(analysis.getAttribute('tabindex')).toBe('0');
    await press(analysis, 'End');
    expect(document.activeElement).toBe(connections);
    expect(state()).toEqual([
      ['Analysis', 'false', '-1'],
      ['Player', 'false', '-1'],
      ['Connections', 'true', '0'],
    ]);
    // Any other key leaves the tabs as they are.
    await press(connections, 'ArrowDown');
    expect(document.activeElement).toBe(connections);
    expect(connections.getAttribute('aria-selected')).toBe('true');
  });
});

describe('the panels and the graph by width', () => {
  const panels = () =>
    ['panel-context', 'panel-player', 'panel-genealogy'].map((id) => {
      const panel = document.getElementById(id);
      return [panel?.getAttribute('role') ?? null, panel?.getAttribute('aria-labelledby') ?? null];
    });

  it('on a phone, the panels are tab panels named by their tabs, and the wheel zooms the graph', () => {
    windowWidth(390);
    render(<Player trackData={track()} onBack={() => {}} />);
    expect(panels()).toEqual([
      ['tabpanel', 'tab-context'],
      ['tabpanel', 'tab-player'],
      ['tabpanel', 'tab-genealogy'],
    ]);
    expect(graph.wheelZoom).toBe('plain');
  });

  it.each([
    [820, 'modifier'],
    [1024, 'modifier'],
    // From xl too the connections are a row the page scrolls past.
    [1440, 'modifier'],
  ])(
    'at %i px, with the tabs hidden, no panel claims to be a tab panel; the graph takes the wheel: %s',
    (width, wheelZoom) => {
      windowWidth(width);
      render(<Player trackData={track()} onBack={() => {}} />);
      expect(panels()).toEqual([
        [null, null],
        [null, null],
        [null, null],
      ]);
      // Up to xl the page scrolls past the graph and keeps the wheel; from xl nothing does.
      expect(graph.wheelZoom).toBe(wheelZoom);
    },
  );
});

describe('choosing a related track in the graph', () => {
  const choose = (node: Partial<GenealogyNode>, onAnalyzeTrack = vi.fn()) => {
    render(<Player trackData={track()} onBack={() => {}} onAnalyzeTrack={onAnalyzeTrack} />);
    act(() => graph.onNodeClick?.({ id: 'n', group: 4, size: 22, label: '', ...node }));
    return onAnalyzeTrack;
  };

  it('searches by the node’s own title and artist, by its Spotify id when matched', () => {
    expect(
      choose({
        label: 'Other - Label (1990)',
        trackTitle: 'Real Title',
        trackArtist: 'Real Artist',
        spotifyId: '28cnXtME493VX9NOw9cIUh',
      }),
    ).toHaveBeenCalledWith('28cnXtME493VX9NOw9cIUh', 'Real Title Real Artist', '', 'player');
  });

  it('never splits an artist off the label: a label alone is searched whole', () => {
    // "Live at Wembley" reads like an artist after " - ", and is not one.
    expect(choose({ label: 'Song - Live at Wembley (1986)' })).toHaveBeenCalledWith(
      'search',
      'Song - Live at Wembley (1986)',
      '',
      'player',
    );
    cleanup();
    expect(choose({ label: 'Song - Live at Wembley', trackArtist: 'Queen' })).toHaveBeenCalledWith(
      'search',
      'Song - Live at Wembley Queen',
      '',
      'player',
    );
  });

  it('searches nothing for a node that names nothing', () => {
    expect(choose({ label: '  ' })).not.toHaveBeenCalled();
  });
});
