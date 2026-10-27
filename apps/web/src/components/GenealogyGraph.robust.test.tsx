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

const data = {
  nodes: [
    { id: 'musicbrainz:recording/current', group: 1, label: 'Song', size: 40 },
    {
      id: RELATED,
      group: 4,
      label: 'Under Pressure - Queen (1981)',
      size: 22,
      previewUrl: CLIP,
    },
  ],
  links: [
    {
      source: RELATED,
      target: 'musicbrainz:recording/current',
      value: 1,
      type: 'influence' as const,
    },
  ],
};

/**
 * The graph with an origin too: a track a sourced sample says this one uses (its hover hint
 * fades in), with no clip of its own.
 */
const withOrigin = {
  nodes: [...data.nodes, node('older', 2, 'Older Record - Someone (1984)')],
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
/** Where a drawn track is, from its `translate(x,y)`. */
const placeOf = (track: Element) =>
  (/translate\(([-\d.e]+),([-\d.e]+)\)/.exec(track.getAttribute('transform') ?? '') ?? [])
    .slice(1)
    .map(Number);
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
/**
 * Where the graph is on screen, in the svg's pixels: the box of the tracks' discs (their outer
 * ring), and the centre of the box the fit centres (each track with 40 px more round its disc).
 */
function onScreen(svg: SVGSVGElement) {
  const { x, y, k } = zoomOf(svg);
  const discs = [...svg.querySelectorAll('g.nodes > g')].map((track) => {
    const [cx, cy] = placeOf(track);
    // The outer ring's radius is the track's size + 4; the fit pads the size by 40.
    const ring = Number(track.querySelector('circle')?.getAttribute('r'));
    return { cx: x + k * cx, cy: y + k * cy, r: k * ring, pad: k * (ring - 4 + 40) };
  });
  const box = (grow: (disc: (typeof discs)[number]) => number) => ({
    left: Math.min(...discs.map((d) => d.cx - grow(d))),
    right: Math.max(...discs.map((d) => d.cx + grow(d))),
    top: Math.min(...discs.map((d) => d.cy - grow(d))),
    bottom: Math.max(...discs.map((d) => d.cy + grow(d))),
  });
  const fitted = box((d) => d.pad);
  return {
    k,
    /** The fitted box's size in graph units: what the fit divides the panel by. */
    graph: [(fitted.right - fitted.left) / k, (fitted.bottom - fitted.top) / k],
    centre: [(fitted.left + fitted.right) / 2, (fitted.top + fitted.bottom) / 2],
    discs: box((d) => d.r),
  };
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
  it('keeps the zoom, the drawn tracks and their scale, and the graph centred on screen', async () => {
    reduceMotion(true);
    const { container } = render(<GenealogyGraph data={data} />);
    const svg = container.querySelector('svg');
    if (!svg) throw new Error('no svg');
    const zoomed = svg.querySelector(':scope > g');
    const tracks = drawnTracks(container);
    expect(tracks).toHaveLength(2);
    const before = onScreen(svg);
    // Fitted to 800 by 600 at its largest zoom.
    expect(before.k).toBe(1.5);
    expect(before.centre[0]).toBeCloseTo(400, 0);
    expect(before.centre[1]).toBeCloseTo(300, 0);
    const ring = relatedTrack(container).querySelector('circle')?.getAttribute('r');

    await act(async () => report?.(400, 300));

    expect(svg.querySelector(':scope > g')).toBe(zoomed);
    const after = drawnTracks(container);
    expect(after).toHaveLength(2);
    after.forEach((track, i) => {
      expect(track).toBe(tracks[i]);
    });
    // The node scale is the first size's: no smaller tracks on the narrower panel.
    expect(relatedTrack(container).querySelector('circle')?.getAttribute('r')).toBe(ring);
    // The svg takes the new size; on screen the graph keeps its zoom and stays centred on the
    // panel, every track inside it.
    expect(svg.getAttribute('width')).toBe('400');
    expect(svg.getAttribute('height')).toBe('300');
    const now = onScreen(svg);
    expect(now.k).toBe(1.5);
    expect(now.centre[0]).toBeCloseTo(200, 0);
    expect(now.centre[1]).toBeCloseTo(150, 0);
    expect(now.discs.left).toBeGreaterThanOrEqual(0);
    expect(now.discs.right).toBeLessThanOrEqual(400);
    expect(now.discs.top).toBeGreaterThanOrEqual(0);
    expect(now.discs.bottom).toBeLessThanOrEqual(300);
  });
});

describe('GenealogyGraph resized while its fit glides in', () => {
  it('fits the graph to the new size, centred, instead of stopping the glide halfway', async () => {
    const { container } = render(<GenealogyGraph data={data} />);
    const svg = container.querySelector('svg');
    if (!svg) throw new Error('no svg');
    // The layout plays out, then the fit glides from the whole view to 1.5: resize halfway.
    await vi.waitFor(
      () => {
        const { k } = zoomOf(svg);
        expect(k).toBeGreaterThan(1.05);
        expect(k).toBeLessThan(1.4);
      },
      { timeout: 10_000, interval: 2 },
    );
    await act(async () => report?.(400, 300));
    await act(() => waitFor(800));

    const now = onScreen(svg);
    // The fit for 400 by 300: 60 px of padding each side, at most 1.5.
    const [width, height] = now.graph;
    const fit = Math.max(Math.min((400 - 120) / width, (300 - 120) / height, 1.5), 0.35);
    expect(now.k).toBeCloseTo(fit, 2);
    expect(now.centre[0]).toBeCloseTo(200, 0);
    expect(now.centre[1]).toBeCloseTo(150, 0);
  });
});

describe('GenealogyGraph resized once its fit is in', () => {
  it('keeps the zoom and shifts the view, as without motion', async () => {
    const { container } = render(<GenealogyGraph data={data} />);
    const svg = container.querySelector('svg');
    if (!svg) throw new Error('no svg');
    // The glide has ended: the fit's 1.5 holds.
    await vi.waitFor(() => expect(zoomOf(svg).k).toBe(1.5), { timeout: 10_000, interval: 5 });
    await act(() => waitFor(100));

    await act(async () => report?.(400, 300));
    await act(() => waitFor(700));

    const now = onScreen(svg);
    expect(now.k).toBe(1.5);
    expect(now.centre[0]).toBeCloseTo(200, 0);
    expect(now.centre[1]).toBeCloseTo(150, 0);
  });
});

describe("GenealogyGraph's pictures", () => {
  it('clips each picture by a valid id of its own, which its url(#…) names', () => {
    const { container } = render(<GenealogyGraph data={data} />);
    const images = [...container.querySelectorAll('g.nodes image')];
    expect(images).toHaveLength(2);
    const ids = images.map((image) => {
      const id = /^url\(#(.+)\)$/.exec(image.getAttribute('clip-path') ?? '')?.[1] ?? '';
      expect(id).toMatch(/^[A-Za-z][\w-]*$/);
      expect(container.querySelector(`clipPath#${id}`)).not.toBeNull();
      return id;
    });
    expect(new Set(ids).size).toBe(2);
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
    // Clicking the track analyses it: no hint names a preview there.
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
  it('shows the click hint on an origin that has a clip too, and plays nothing', async () => {
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
    expect(container.querySelector('.preview-indicator')?.textContent).toMatch(/CLICK TO EXPLORE/);
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
    // The pointer on the origin: its hint fades in (a transition), while the layout plays out.
    const origin = view.container.querySelector('g.nodes > g[data-node-id="older"]');
    await act(async () => {
      origin?.dispatchEvent(new MouseEvent('mouseenter'));
    });
    expect(view.container.querySelector('.preview-indicator')).not.toBeNull();

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
