import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// d3-timer asks for animation frames through the requestAnimationFrame it finds when it loads:
// they are counted, so a test can tell whether anything (a layout, a transition) still runs.
const frames = vi.hoisted(() => {
  const counted = { asked: 0 };
  const ask = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback: FrameRequestCallback) => {
    counted.asked += 1;
    return ask(callback);
  };
  return counted;
});

import GenealogyGraph from './GenealogyGraph';
import { link, node, PACK } from './genealogy/testing';

const CLIP = 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/0/n.mp3?hdnea=exp=1~hmac=y';
const RELATED = 'musicbrainz:recording/x y';

/** An audio element that records the clips asked to play. */
let played: string[] = [];
class FakeAudio {
  src = '';
  volume = 1;
  paused = true;
  currentTime = 0;
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  play() {
    played.push(this.src);
    this.paused = false;
    this.onplay?.();
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.onpause?.();
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  load() {}
}

/** Reports the wrapper's size, as the browser does when the panel is laid out or resized. */
let report: ((width: number, height: number) => void) | null = null;
class SizedObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}
  observe(target: Element) {
    report = (width, height) =>
      this.callback(
        [{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver,
      );
    report(800, 600);
  }
  unobserve() {}
  disconnect() {
    report = null;
  }
}

/** Whether the reader asked for reduced motion. */
function reduceMotion(reduce: boolean) {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: reduce && query.includes('reduce'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
}

// Three relations, so the map is drawn (with two or fewer it is a compact row).
const data = {
  nodes: [
    // Each dated by a record, as MusicBrainz dates a recording.
    { id: 'musicbrainz:recording/current', group: 1, label: 'Song (2011)', size: 40, year: 2011 },
    {
      id: RELATED,
      group: 4,
      label: 'Under Pressure - Queen (1981)',
      size: 22,
      previewUrl: CLIP,
      year: 1981,
    },
    { ...node('peer', 4, 'Peer - Someone (1990)'), year: 1990 },
    { ...node('later', 3, 'Later - Someone (2015)'), year: 2015 },
  ],
  links: [
    {
      source: RELATED,
      target: 'musicbrainz:recording/current',
      value: 1,
      type: 'influence' as const,
    },
    link('peer', 'musicbrainz:recording/current', { type: 'influence' }),
    link('musicbrainz:recording/current', 'later', { type: 'remix' }),
  ],
};

/**
 * The graph with an origin too: a track a sourced sample says this one uses (its hover hint
 * fades in), with no clip of its own.
 */
const withOrigin = {
  nodes: [...data.nodes, { ...node('older', 2, 'Older Record - Someone (1984)'), year: 1984 }],
  links: [
    ...data.links,
    link('older', 'musicbrainz:recording/current', {
      type: 'sample',
      kind: 'sourced',
      origin: 'code',
      evidenceIds: ['ev-mb-1'],
    }),
  ],
};

const drawnTracks = (container: HTMLElement) => [...container.querySelectorAll('g.nodes > g')];
const relatedTrack = (container: HTMLElement) => {
  const track = drawnTracks(container).find((g) => g.getAttribute('data-node-id') === RELATED);
  if (!track) throw new Error('the related track is not drawn');
  return track;
};
/** The zoom, from the drawing's `translate(x,y) scale(k)`. */
function zoomOf(svg: SVGSVGElement) {
  const [x, y, k] = (
    /translate\(([-\d.e]+),([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(
      svg.querySelector(':scope > g')?.getAttribute('transform') ?? '',
    ) ?? []
  )
    .slice(1)
    .map(Number);
  return { x, y, k };
}
const waitFor = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  played = [];
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('ResizeObserver', SizedObserver);
  reduceMotion(false);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GenealogyGraph on a resize', () => {
  it('at rest, shows the first view for the new room: from the earliest year, no card cut', async () => {
    const { container } = render(<GenealogyGraph data={data} />);
    const svg = container.querySelector('svg');
    if (!svg) throw new Error('no svg');
    /** Each card's left and right on screen, at the zoom drawn now. */
    const across = () => {
      const { x, k } = zoomOf(svg);
      return drawnTracks(container).map((track) => {
        const left = Number(
          /translate\(([-\d.e]+),/.exec(track.getAttribute('transform') ?? '')?.[1],
        );
        const width = Number(track.querySelector('rect.card')?.getAttribute('width'));
        return [x + left * k, x + (left + width) * k] as const;
      });
    };
    // Wider than the panel: the first view starts at the earliest year, and no card straddles
    // the panel's right edge, at 800 px and after a resize to 700 px.
    expect(zoomOf(svg)).toMatchObject({ x: 0, k: 1 });
    for (const [left, right] of across()) expect(left >= 800 || right <= 800).toBe(true);
    await act(async () => report?.(700, 500));
    expect(svg.getAttribute('width')).toBe('700');
    expect(zoomOf(svg)).toMatchObject({ x: 0, k: 1 });
    const now = across();
    for (const [left, right] of now) expect(left >= 700 || right <= 700).toBe(true);
    expect(now.filter(([, right]) => right <= 700).length).toBeGreaterThan(1);
  });

  it('once the reader has moved the view, keeps the drawing, its cards and its zoom on a resize, and shifts the view by half the change', async () => {
    const { container } = render(<GenealogyGraph data={data} />);
    const svg = container.querySelector('svg');
    if (!svg) throw new Error('no svg');
    const zoomed = svg.querySelector(':scope > g');
    const tracks = drawnTracks(container);
    expect(tracks).toHaveLength(4);
    // Drawn at its size: the text at 12 px on screen, never zoomed out.
    expect(zoomOf(svg).k).toBe(1);
    const card = relatedTrack(container).querySelector('rect.card')?.getAttribute('width');
    // The keyboard brings the last card, past the first view, into view: the reader's view.
    const later = tracks.find((track) => track.getAttribute('data-node-id') === 'later');
    await act(async () => (later as SVGGElement | undefined)?.focus());
    const before = zoomOf(svg);
    expect(before.x).toBeLessThan(0);

    await act(async () => report?.(700, 500));

    expect(svg.querySelector(':scope > g')).toBe(zoomed);
    const after = drawnTracks(container);
    after.forEach((track, i) => {
      expect(track).toBe(tracks[i]);
    });
    expect(relatedTrack(container).querySelector('rect.card')?.getAttribute('width')).toBe(card);
    expect(svg.getAttribute('width')).toBe('700');
    expect(svg.getAttribute('height')).toBe('500');
    const now = zoomOf(svg);
    expect(now.k).toBe(1);
    expect(now.x).toBeCloseTo(before.x - 50, 0);
  });

  it('ends the first view at a selection, a focus or a hover: a resize then keeps the drawing', async () => {
    for (const act_ of ['select', 'focus', 'hover'] as const) {
      const { container, unmount } = render(<GenealogyGraph data={data} />);
      const svg = container.querySelector('svg');
      if (!svg) throw new Error('no svg');
      const zoomed = svg.querySelector(':scope > g');
      expect(svg.getAttribute('data-view')).toBe('first');
      // The related track's card is in the first view: none of these moves the view.
      const before = zoomOf(svg);
      const track = relatedTrack(container) as SVGGElement;
      if (act_ === 'select') await act(async () => fireEvent.click(track));
      if (act_ === 'focus') await act(async () => track.focus());
      if (act_ === 'hover') await act(async () => fireEvent.mouseEnter(track));
      expect(zoomOf(svg), act_).toEqual(before);
      expect(svg.getAttribute('data-view'), act_).toBe('reader');

      await act(async () => report?.(700, 500));

      expect(svg.querySelector(':scope > g'), act_).toBe(zoomed);
      if (act_ === 'focus') expect(document.activeElement).toBe(track);
      unmount();
    }
  });

  it('lays the map out again when the panel turns too narrow for years side by side', async () => {
    const { container } = render(<GenealogyGraph data={data} />);
    const svg = container.querySelector('svg');
    if (!svg) throw new Error('no svg');
    const zoomed = svg.querySelector(':scope > g');
    const x = (id: string) =>
      Number(
        /translate\(([-\d.e]+),/.exec(
          container.querySelector(`g.nodes > g[data-node-id="${id}"]`)?.getAttribute('transform') ??
            '',
        )?.[1],
      );
    // Side by side by year at 800 px: 1981, 1990, then this track (2011) and its remix (2015).
    expect(x(RELATED)).toBeLessThan(x('peer'));
    expect(x('peer')).toBeLessThan(x('musicbrainz:recording/current'));

    await act(async () => report?.(360, 600));

    // A new drawing, the years from top to bottom: one column of cards.
    expect(svg.querySelector(':scope > g')).not.toBe(zoomed);
    expect(x(RELATED)).toBe(x('peer'));
    expect(x('peer')).toBe(x('later'));
  });
});

describe("GenealogyGraph's pictures", () => {
  it('clips each picture by a valid id of its own, which its url(#…) names', () => {
    const { container } = render(<GenealogyGraph data={data} />);
    const images = [...container.querySelectorAll('g.nodes image')];
    expect(images).toHaveLength(4);
    const ids = images.map((image) => {
      const id = /^url\(#(.+)\)$/.exec(image.getAttribute('clip-path') ?? '')?.[1] ?? '';
      expect(id).toMatch(/^[A-Za-z][\w-]*$/);
      expect(container.querySelector(`clipPath#${id}`)).not.toBeNull();
      return id;
    });
    expect(new Set(ids).size).toBe(4);
  });

  it('links each picture with href, not xlink:href', () => {
    const { container } = render(<GenealogyGraph data={data} />);
    for (const image of container.querySelectorAll('g.nodes image')) {
      expect(image.getAttribute('href')).toMatch(/^data:image\/svg\+xml|^https:/);
      expect(image.getAttributeNS('http://www.w3.org/1999/xlink', 'href')).toBeNull();
      expect(image.hasAttribute('xlink:href')).toBe(false);
    }
  });
});

describe('GenealogyGraph previews', () => {
  it('neither plays nor offers a preview when the pointer enters a track', async () => {
    const { container } = render(<GenealogyGraph data={data} />);
    await act(async () => {
      relatedTrack(container).dispatchEvent(new MouseEvent('mouseenter'));
    });
    expect(played).toEqual([]);
    // No hint names a preview there.
    expect(container.querySelector('.preview-indicator')).toBeNull();
    expect(container.textContent).not.toMatch(/PREVIEW/);
  });

  it('plays a preview from its button in the list of previews, which says when it is playing', async () => {
    render(<GenealogyGraph data={data} />);
    const previews = screen.getByRole('list', { name: 'Track previews', hidden: true });
    const button = within(previews).getByRole('button', {
      name: 'Play preview of Under Pressure - Queen (1981)',
      hidden: true,
    });
    expect(button.getAttribute('aria-pressed')).toBe('false');

    await act(async () => fireEvent.click(button));
    expect(played).toEqual([CLIP]);
    expect(button.getAttribute('aria-pressed')).toBe('true');

    await act(async () => fireEvent.click(button));
    expect(played).toEqual([CLIP]);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });
  it('shows no hint on an origin that has a clip, and plays nothing on hover', async () => {
    const withClip = {
      ...withOrigin,
      nodes: withOrigin.nodes.map((n) =>
        n.id === 'older' ? { ...n, previewUrl: `${CLIP}&older` } : n,
      ),
    };
    const { container } = render(<GenealogyGraph data={withClip} evidence={PACK} />);
    await act(async () => {
      container
        .querySelector('g.nodes > g[data-node-id="older"]')
        ?.dispatchEvent(new MouseEvent('mouseenter'));
    });
    // A click selects the track (the panel says what it offers): the pointer shows no hint.
    expect(container.querySelector('.preview-indicator')).toBeNull();
    expect(container.querySelector('g.link-chips')?.textContent).not.toMatch(/Analyze/);
    expect(played).toEqual([]);
  });

  it('has a preview button for a track with a clip whose link is not shown', () => {
    render(<GenealogyGraph data={{ nodes: data.nodes, links: [] }} />);
    expect(
      screen.getByRole('button', {
        name: 'Play preview of Under Pressure - Queen (1981)',
        hidden: true,
      }),
    ).toBeTruthy();
  });
});

describe("GenealogyGraph's lists", () => {
  // Both lists lie over the graph: one is open at a time. A browser without exclusive
  // <details name> (as here) gets it from the lists' toggle handler.
  it('closes the list of links when the previews open, and the other way round', async () => {
    const { container } = render(<GenealogyGraph data={data} />);
    const [links, previews] = [...container.querySelectorAll('details')];
    expect(links.textContent).toMatch(/^Links as a list/);
    expect(previews.textContent).toMatch(/^Previews/);
    const open = (details: HTMLDetailsElement) =>
      act(async () => {
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
      });

    await open(links);
    expect(links.open).toBe(true);
    await open(previews);
    expect(previews.open).toBe(true);
    expect(links.open).toBe(false);
    await open(links);
    expect(links.open).toBe(true);
    expect(previews.open).toBe(false);
  });
});

describe('GenealogyGraph when it goes', () => {
  it('removes every listener it added to the graph and stops its timers', async () => {
    // The prototype elements take addEventListener from (the DOM's EventTarget, not Node's).
    let target = Object.getPrototypeOf(document.createElement('div'));
    while (target && !Object.hasOwn(target, 'addEventListener')) {
      target = Object.getPrototypeOf(target);
    }
    const add = vi.spyOn(target as EventTarget, 'addEventListener');
    const remove = vi.spyOn(target as EventTarget, 'removeEventListener');
    const view = render(<GenealogyGraph data={withOrigin} evidence={PACK} />);
    const svg = view.container.querySelector('svg');
    if (!svg) throw new Error('no svg');
    // The pointer on the origin, then a click: it is selected (its ring, its panel).
    const origin = view.container.querySelector('g.nodes > g[data-node-id="older"]');
    await act(async () => {
      origin?.dispatchEvent(new MouseEvent('mouseenter'));
      origin?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(origin?.getAttribute('aria-pressed')).toBe('true');

    view.unmount();

    const inGraph = (target: unknown) =>
      target instanceof Node && (target === svg || svg.contains(target));
    const calls = (spy: typeof add) =>
      spy.mock.calls
        .map(([type, listener], i) => ({ target: spy.mock.contexts[i], type, listener }))
        .filter(({ target }) => inGraph(target));
    const added = calls(add);
    expect(added.length).toBeGreaterThan(0);
    const removed = calls(remove);
    const left = added.filter(
      (call) =>
        !removed.some(
          (gone) =>
            gone.target === call.target &&
            gone.type === call.type &&
            gone.listener === call.listener,
        ),
    );
    expect(left.map(({ type }) => type)).toEqual([]);

    // A frame asked for before the graph went may still come; then none is asked for.
    await waitFor(50);
    const asked = frames.asked;
    await waitFor(150);
    expect(frames.asked).toBe(asked);
  });
});
