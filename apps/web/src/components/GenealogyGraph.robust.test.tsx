import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
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
  it('keeps the zoom, the drawn tracks and their scale, and moves the layout to the new middle', async () => {
    reduceMotion(true);
    const { container } = render(<GenealogyGraph data={data} />);
    const svg = container.querySelector('svg');
    if (!svg) throw new Error('no svg');
    const zoomed = svg.querySelector(':scope > g');
    const tracks = drawnTracks(container);
    expect(tracks).toHaveLength(2);
    const transform = zoomed?.getAttribute('transform');
    expect(transform).toMatch(/scale\(/);
    const ring = relatedTrack(container).querySelector('circle')?.getAttribute('r');

    await act(async () => report?.(400, 300));

    expect(svg.querySelector(':scope > g')).toBe(zoomed);
    expect(zoomed?.getAttribute('transform')).toBe(transform);
    const after = drawnTracks(container);
    expect(after).toHaveLength(2);
    after.forEach((track, i) => {
      expect(track).toBe(tracks[i]);
    });
    // The node scale is the first size's: no smaller tracks on the narrower panel.
    expect(relatedTrack(container).querySelector('circle')?.getAttribute('r')).toBe(ring);
    // The svg takes the new size, and the layout is centred on it.
    expect(svg.getAttribute('width')).toBe('400');
    expect(svg.getAttribute('height')).toBe('300');
    const places = after.map(placeOf);
    const middle = [0, 1].map((axis) => (places[0][axis] + places[1][axis]) / 2);
    expect(middle[0]).toBeCloseTo(200, 0);
    expect(middle[1]).toBeCloseTo(150, 0);
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
  it('never plays a preview when the pointer enters a track', async () => {
    const { container } = render(<GenealogyGraph data={data} />);
    await act(async () => {
      relatedTrack(container).dispatchEvent(new MouseEvent('mouseenter'));
    });
    expect(played).toEqual([]);
  });

  it('plays a preview from its button in the list of links, which says when it is playing', async () => {
    render(<GenealogyGraph data={data} />);
    const button = screen.getByRole('button', {
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
    const view = render(<GenealogyGraph data={data} />);
    const svg = view.container.querySelector('svg');
    if (!svg) throw new Error('no svg');
    // The pointer on a track: its hint fades in (a transition), while the layout plays out.
    await act(async () => {
      relatedTrack(view.container).dispatchEvent(new MouseEvent('mouseenter'));
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
