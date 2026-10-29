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

const FALLBACK = 'The connections graph could not be drawn';
/** The map in its error boundary, as the Player draws it, at `width` x `height`. */
async function drawn(data: ReturnType<typeof mapOf>, width: number, height: number) {
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

let errors: string[] = [];
beforeEach(() => {
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('ResizeObserver', SizedObserver);
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
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
    // A phone's column 234 px tall, its panel 140 px: the pan to the card hid "N more ↓",
    // which moved the panel, and the card was placed again, back and forth for good.
    panelWords = 140;
    const { container } = await drawn(SAME_YEAR_TAIL, 400, 234);
    const moves = await select(container, 'n9');
    expect(moves).toBeLessThanOrEqual(2);
    expect(container.textContent).not.toContain(FALLBACK);
    expect(errors).toEqual([]);
    expect(panelOf(container)?.getAttribute('data-at')).toBe('overlay');
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
