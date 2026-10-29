import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import GenealogyGraph from './GenealogyGraph';
import { link, node } from './genealogy/testing';

// The selected track's panel and the detail box over a short map (happy-dom lays nothing out:
// their heights are given here, as the browser would lay them out): the selected card placed
// once beside its panel, never back and forth, and the box and the panel clear of the edge cues.

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

class FakeAudio {
  src = '';
  paused = true;
  play() {
    return Promise.resolve();
  }
  pause() {}
  removeAttribute() {}
  load() {}
}

/** A map of 13 tracks related to this one (1990), dated `years`. */
function mapOf(years: number[]) {
  return {
    nodes: [
      { id: 'musicbrainz:recording/current', group: 1, label: 'Song (1990)', size: 40, year: 1990 },
      ...years.map((year, i) => ({ ...node(`n${i}`, 4, `Track ${i} - Someone (${year})`), year })),
    ],
    links: years.map((_, i) =>
      link(`n${i}`, 'musicbrainz:recording/current', { type: 'influence' }),
    ),
  };
}
/** Its last three tracks share a year. */
const SAME_YEAR_TAIL = mapOf([
  1960, 1964, 1968, 1972, 1976, 1980, 1984, 1995, 2000, 2004, 2016, 2016, 2016,
]);
/** Several pairs of tracks share a year. */
const PAIRS = mapOf([1960, 1964, 1968, 1972, 1976, 1980, 1984, 1995, 1995, 2004, 2004, 2016, 2016]);
/** Many tracks in the years just before this one. */
const FEW_AFTER = mapOf([
  1960, 1964, 1968, 1972, 1976, 1980, 1984, 1985, 1986, 1987, 1995, 2000, 2000,
]);
/** Fourteen tracks over fifty years: across a page, wider than a window. */
const SPREAD = mapOf([
  1960, 1964, 1968, 1972, 1976, 1980, 1984, 1995, 2000, 2004, 2008, 2012, 2016,
]);
/** Three tracks: the whole map fits a desktop's window. */
const SMALL = mapOf([1981, 1995, 2015]);

/**
 * The panel's and the box's heights, as the browser lays them out: the panel as tall as its
 * words (`panelWords`) up to its cap (60% of the map, less what its style takes off), the box
 * `BOX_PX`; the panel as wide as `panelWidth`, at the map's right from md up.
 */
let mapHeight = 600;
let panelWords = 400;
let panelWidth = 400;
const BOX_PX = 44;
function fakeLayout(width: number) {
  const testid = (el: HTMLElement) => el.getAttribute?.('data-testid');
  const capOf = (el: HTMLElement) => {
    const less = /calc\(60% - ([\d.]+)px\)/.exec(el.style.maxHeight)?.[1];
    return Math.floor(0.6 * mapHeight) - (less === undefined ? 0 : Number(less));
  };
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    const id = testid(this);
    return id === 'node-detail'
      ? Math.min(panelWords, capOf(this))
      : id === 'link-detail'
        ? BOX_PX
        : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    const id = testid(this);
    return id === 'node-detail' ? width - 8 - panelWidth : id === 'link-detail' ? 8 : 0;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    const id = testid(this);
    return id === 'node-detail' ? panelWidth : id === 'link-detail' ? width - 16 : 0;
  });
}

const drawnTracks = (container: HTMLElement) => [
  ...container.querySelectorAll<SVGGElement>('g.nodes > g'),
];
const trackOf = (container: HTMLElement, id: string) => {
  const track = drawnTracks(container).find((g) => g.getAttribute('data-node-id') === id);
  if (!track) throw new Error(`${id} is not drawn`);
  return track;
};
/** The drawing's zoom: its translation down and its scale. */
function zoomOf(container: HTMLElement) {
  const svg = container.querySelector('svg') as SVGSVGElement;
  const [, y, k] = (
    /translate\(([-\d.e]+),([-\d.e]+)\) scale\(([-\d.e]+)\)/.exec(
      svg.querySelector(':scope > g')?.getAttribute('transform') ?? '',
    ) ?? []
  )
    .slice(1)
    .map(Number);
  return { y, k };
}
/** A card's top and bottom in the map's box (px), by the drawing's zoom. */
function cardSpan(container: HTMLElement, id: string) {
  const { y, k } = zoomOf(container);
  const track = trackOf(container, id);
  const top = Number(
    /translate\([-\d.e]+,([-\d.e]+)\)/.exec(track.getAttribute('transform') ?? '')?.[1],
  );
  const height = Number(track.querySelector('rect.card')?.getAttribute('height'));
  return [y + top * k, y + (top + height) * k] as const;
}

/** Where the band of the year labels pinned over the map's top ends (px); 0 while not pinned. */
function pinnedBandEnd(container: HTMLElement) {
  const axis = container.querySelector('g.lineage-axis') as SVGGElement;
  const backdrop = axis.querySelector(':scope > rect') as SVGRectElement;
  if (Number(backdrop.getAttribute('fill-opacity')) === 0) return 0;
  const { y, k } = zoomOf(container);
  const below = Number(
    /translate\(0,([-\d.e]+)\)/.exec(axis.getAttribute('transform') ?? '')?.[1] ?? 0,
  );
  return (
    y + (below + Number(backdrop.getAttribute('y')) + Number(backdrop.getAttribute('height'))) * k
  );
}

const FALLBACK = 'The connections graph could not be drawn';
/** The map in its error boundary, as the Player draws it, at `width` x `height`. */
async function drawn(
  data: React.ComponentProps<typeof GenealogyGraph>['data'],
  width: number,
  height: number,
) {
  mapHeight = height;
  fakeLayout(width);
  const view = render(
    <ErrorBoundary message={FALLBACK} action={{ label: 'Try again' }}>
      <GenealogyGraph data={data} />
    </ErrorBoundary>,
  );
  await act(async () => report?.(width, height));
  return view;
}

/** Clicks a track; the times the view moved (the drawing's zoom written) meanwhile. */
async function select(container: HTMLElement, id: string) {
  const g = container.querySelector('svg > g') as SVGGElement;
  let moves = 0;
  const write = g.setAttribute.bind(g);
  g.setAttribute = (name: string, value: string) => {
    if (name === 'transform') moves += 1;
    write(name, value);
  };
  try {
    await act(async () => {
      trackOf(container, id).dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  } finally {
    g.setAttribute = write;
  }
  return moves;
}

/**
 * The media queries by the window's width and the root font size (`rootPx`, the browser's
 * default font size): "(min-width: 48rem)" as the stylesheet reads it; every other query false.
 */
let rootPx = 16;
const mediaListeners = new Set<() => void>();
function matchesNow(query: string) {
  const min = /\(min-width:\s*([\d.]+)(rem|px)\)/.exec(query);
  return min !== null && window.innerWidth >= Number(min[1]) * (min[2] === 'rem' ? rootPx : 1);
}
/** The root font size set to `px`: the queries that change say so, as the browser does. */
async function setRootFont(px: number) {
  rootPx = px;
  await act(async () => {
    for (const listener of [...mediaListeners]) listener();
  });
}

let errors: string[] = [];
beforeEach(() => {
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('ResizeObserver', SizedObserver);
  rootPx = 16;
  mediaListeners.clear();
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        get matches() {
          return matchesNow(query);
        },
        media: query,
        addEventListener: (_: string, listener: () => void) => mediaListeners.add(listener),
        removeEventListener: (_: string, listener: () => void) => mediaListeners.delete(listener),
      }) as unknown as MediaQueryList,
  );
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(String(args[0]).slice(0, 160));
  });
  panelWords = 400;
  panelWidth = 400;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const panelOf = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="node-detail"]');

describe('the selected card beside its panel on a short map', () => {
  it('is placed once: a pan that shows or hides an edge cue does not place it again', async () => {
    // A phone's column 200 px tall, its panel 100 px. The room the panel takes once counted the
    // bottom cues' strip only while a cue showed there: the pan to the first card hid
    // "N more ↓" and changed that room, and the card was placed a second time. With an
    // over-tall card turning between its top and its bottom besides, the pan to n10 went back
    // and forth until the map gave way to its error message.
    panelWords = 100;
    const { container } = await drawn(SAME_YEAR_TAIL, 340, 200);
    expect(await select(container, 'n0')).toBe(1);
    expect(panelOf(container)?.getAttribute('data-at')).toBe('top');
    await select(container, 'n0');
    expect(await select(container, 'n10')).toBe(1);
    expect(panelOf(container)?.getAttribute('data-at')).toBe('overlay');
    expect(container.textContent).not.toContain(FALLBACK);
    expect(errors).toEqual([]);
  });

  it('on phones 340 and 400 px wide, 200 to 300 px tall, each selection moves the view at most twice', async () => {
    const looped: string[] = [];
    for (const [name, data] of Object.entries({ SAME_YEAR_TAIL, PAIRS, FEW_AFTER })) {
      for (const width of [340, 400]) {
        for (let height = 200; height <= 300; height += 4) {
          for (const share of [0.5, 0.6]) {
            vi.restoreAllMocks();
            vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
              errors.push(String(args[0]).slice(0, 160));
            });
            panelWords = Math.floor(height * share);
            const { container, unmount } = await drawn(data, width, height);
            for (const id of drawnTracks(container).map((g) => g.getAttribute('data-node-id'))) {
              if (id === null || id.endsWith('current')) continue;
              const moves = await select(container, id);
              if (moves > 2 || container.textContent?.includes(FALLBACK)) {
                looped.push(`${name} ${width}x${height} ${share} ${id}: ${moves}`);
                break;
              }
              await select(container, id);
            }
            unmount();
          }
        }
      }
    }
    expect(looped).toEqual([]);
    expect(errors).toEqual([]);
  }, 300_000);
});

const hover = (container: HTMLElement, id: string) =>
  act(async () => {
    trackOf(container, id).dispatchEvent(new MouseEvent('mouseenter'));
  });
const unhover = (container: HTMLElement, id: string) =>
  act(async () => {
    trackOf(container, id).dispatchEvent(new MouseEvent('mouseleave'));
  });
const cuesShown = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-cue]')].map((cue) => cue.getAttribute('data-cue')).sort();
const box = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-testid="link-detail"]');

describe('the detail box and the panel at the bottom of the map', () => {
  it('sit 8 px over its bottom with no edge cue, and above the cues while one shows there', async () => {
    // The whole map in a desktop's window: no cue.
    const small = await drawn(SMALL, 1280, 700);
    expect(cuesShown(small.container)).toEqual([]);
    await hover(small.container, 'n0');
    expect(box(small.container)?.getAttribute('data-at')).toBe('bottom');
    expect(box(small.container)?.style.bottom).toBe('8px');
    await unhover(small.container, 'n0');
    await select(small.container, 'n0');
    expect(panelOf(small.container)?.getAttribute('data-at')).toBe('overlay');
    expect(panelOf(small.container)?.style.bottom).toBe('8px');
    small.unmount();

    // Down a phone's column, "N more ↓" at the bottom: both sit above it.
    const column = await drawn(SPREAD, 400, 500);
    expect(cuesShown(column.container)).toContain('down');
    await hover(column.container, 'n0');
    expect(box(column.container)?.getAttribute('data-at')).toBe('bottom');
    expect(box(column.container)?.style.bottom).toBe('28px');
    await unhover(column.container, 'n0');
    // A track below the analysed one: its panel at the bottom.
    await select(column.container, 'n8');
    expect(cuesShown(column.container)).toContain('down');
    expect(panelOf(column.container)?.getAttribute('data-at')).toBe('overlay');
    expect(panelOf(column.container)?.style.bottom).toBe('28px');
    expect(errors).toEqual([]);
  });

  it('from md up, raise the panel at the right for "N more →" or "N more ↓" only, not for "← N more"', async () => {
    // happy-dom's window is 1024 px wide: the panel lies at the map's right.
    expect(window.innerWidth).toBeGreaterThanOrEqual(768);
    const { container } = await drawn(SPREAD, 900, 600);
    // The latest track: the view goes to the map's right end, the earlier tracks past its left.
    await select(container, 'n12');
    expect(cuesShown(container)).toEqual(['left']);
    expect(panelOf(container)?.style.bottom).toBe('8px');
    // The earliest: the later ones past its right.
    await select(container, 'n0');
    expect(cuesShown(container)).toContain('right');
    expect(panelOf(container)?.style.bottom).toBe('28px');
    expect(errors).toEqual([]);
  });

  it('switch with the stylesheet at 48rem: with a 20 px root font, an 800 px window has the panel across the map, above "← N more"', async () => {
    // md is then 960 px: the panel takes the map's width, over "← N more" unless it rises.
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(800);
    rootPx = 20;
    panelWidth = 784 - 16;
    const { container } = await drawn(SPREAD, 784, 600);
    await select(container, 'n12');
    expect(cuesShown(container)).toEqual(['left']);
    const panel = panelOf(container) as HTMLElement;
    expect(panel.getAttribute('data-at')).toBe('overlay');
    expect(panel.style.bottom).toBe('28px');
    // "← N more"'s strip at the map's bottom ends below the panel.
    const strip = container.querySelector<HTMLElement>('[data-cue="left"]')
      ?.parentElement as HTMLElement;
    expect(Number.parseFloat(panel.style.bottom)).toBeGreaterThan(
      Number.parseFloat(strip.style.bottom) + Number.parseFloat(strip.style.height),
    );
    // The default 16 px: md is 768 px, the panel at the map's right, clear of "← N more".
    panelWidth = 400;
    await setRootFont(16);
    expect(cuesShown(container)).toEqual(['left']);
    expect(panelOf(container)?.style.bottom).toBe('8px');
    expect(errors).toEqual([]);
  });

  it('a panel at its cap is shorter by as much as it rises: a short map keeps the selected card whole between the year labels and it', async () => {
    // A map 320 px tall, the panel's words longer than its cap (60% of the map), the panel
    // across the map: every card is under it.
    panelWidth = 900 - 16;
    const { container } = await drawn(SPREAD, 900, 320);
    for (const id of ['n1', 'n0']) {
      await select(container, id);
      const panel = panelOf(container) as HTMLElement;
      const top = 320 - Number.parseFloat(panel.style.bottom) - panel.offsetHeight;
      const [cardTop, bottom] = cardSpan(container, id);
      expect(bottom, `${id} above its panel`).toBeLessThanOrEqual(top);
      expect(cardTop, `${id} below the pinned year labels`).toBeGreaterThanOrEqual(
        pinnedBandEnd(container),
      );
      expect(panel.style.maxHeight).toBe('calc(60% - 20px)');
    }
    expect(errors).toEqual([]);
  });
});

describe("a card's cut credit", () => {
  it('says "Artist and year shortened" where the line cut ends in its year, and "Artist shortened" undated', async () => {
    const LONG =
      'The Philharmonic Orchestra Of A City With A Name Long Enough To Need Several Lines, Its Choir And Its Soloists';
    const data = {
      nodes: [
        {
          id: 'musicbrainz:recording/current',
          group: 1,
          label: 'Song (1990)',
          size: 40,
          year: 1990,
        },
        { ...node('dated', 4), trackTitle: 'Symphony No. 5', trackArtist: LONG, year: 1980 },
        { ...node('undated', 4), trackTitle: 'Symphony No. 6', trackArtist: LONG },
        { ...node('other', 4, 'Other - Someone (2000)'), year: 2000 },
      ],
      links: ['dated', 'undated', 'other'].map((id) =>
        link(id, 'musicbrainz:recording/current', { type: 'influence' }),
      ),
    };
    // A phone's column: no card is wider than it.
    const { container } = await drawn(data, 340, 700);
    const said = (id: string) =>
      [...trackOf(container, id).querySelectorAll('text.card-shortened')]
        .map((line) => line.textContent)
        .join(' ');
    expect(trackOf(container, 'dated').getAttribute('data-shortened')).toBe('artist and year');
    expect(said('dated')).toBe('Artist and year shortened');
    expect(trackOf(container, 'undated').getAttribute('data-shortened')).toBe('artist');
    expect(said('undated')).toBe('Artist shortened');
  });
});
