import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readGenealogy } from './links';
import { contextOf, link, node } from './testing';
import { listeningPlan, unavailableText, useABListening } from './useABListening';

/** The page's preview element: each clip asked to play, in order; a test ends or fails it. */
let played: string[] = [];
let element: FakeAudio | null = null;
class FakeAudio {
  src = '';
  volume = 1;
  paused = true;
  ended = false;
  error: { code: number } | null = null;
  currentTime = 0;
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    element = this;
  }
  play() {
    played.push(this.src);
    this.paused = false;
    this.ended = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
  removeAttribute() {}
  load() {}
}
const end = () =>
  act(() => {
    if (!element) throw new Error('no element');
    element.ended = true;
    element.onended?.();
  });

const A = { id: 'a', name: 'Source (1984)', url: 'https://previews.example.test/a.mp3' };
const B = { id: 'b', name: 'This (2011)', url: 'https://previews.example.test/b.mp3' };

beforeEach(() => {
  played = [];
  element = null;
  vi.stubGlobal('Audio', FakeAudio);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('A/B listening', () => {
  it('plays the first preview, then the second, then stops', async () => {
    const { result } = renderHook(() => useABListening());
    act(() => result.current.start([A, B]));
    expect(played).toEqual([A.url]);
    expect(result.current.playing).toEqual({ steps: [A, B], index: 0 });
    await end();
    expect(played).toEqual([A.url, B.url]);
    expect(result.current.playing?.index).toBe(1);
    await end();
    expect(played).toEqual([A.url, B.url]);
    expect(result.current.playing).toBeNull();
  });

  it('stops on stop: the second preview never plays', async () => {
    const { result } = renderHook(() => useABListening());
    act(() => result.current.start([A, B]));
    act(() => result.current.stop());
    expect(element?.paused).toBe(true);
    expect(result.current.playing).toBeNull();
    await end();
    expect(played).toEqual([A.url]);
  });

  it('says which preview could not be played, and plays no further', async () => {
    const { result } = renderHook(() => useABListening());
    act(() => result.current.start([A, B]));
    act(() => {
      if (!element) throw new Error('no element');
      element.error = { code: 4 };
      element.onerror?.();
    });
    expect(result.current.playing).toBeNull();
    expect(result.current.message).toBe('The preview of Source (1984) could not be played.');
    expect(played).toEqual([A.url]);
  });
});

describe('the pair to hear', () => {
  const nodes = [
    node('this', 1, 'This - Me (2011)'),
    node('older', 2, 'Older - Someone (1984)'),
    node('remix', 3, 'Remix - Someone (2015)'),
  ];
  const [sample, remix] = readGenealogy(
    {
      nodes,
      links: [
        link('older', 'this', {
          type: 'sample',
          kind: 'sourced',
          origin: 'code',
          evidenceIds: ['ev-mb-1'],
        }),
        link('this', 'remix', {
          type: 'remix',
          kind: 'sourced',
          origin: 'code',
          evidenceIds: ['ev-mb-1'],
        }),
      ],
    },
    contextOf(),
  ).links;
  const current = { id: 'this', name: 'This', url: 'https://previews.example.test/this.mp3' };
  const older = { id: 'older', name: 'Older', url: 'https://previews.example.test/older.mp3' };
  const later = { id: 'remix', name: 'Remix', url: 'https://previews.example.test/remix.mp3' };

  it('starts with the earlier record: the sample, then this track', () => {
    const plan = listeningPlan({ selected: older, current, link: sample, replay: false });
    expect(plan).toEqual({ kind: 'ready', label: 'Hear the sample', steps: [older, current] });
  });

  it('starts with this track before a later one ("Hear both")', () => {
    const plan = listeningPlan({ selected: later, current, link: remix, replay: false });
    expect(plan).toEqual({ kind: 'ready', label: 'Hear both', steps: [current, later] });
  });

  it('is skipped, with the reason, when a preview is missing or in a replay', () => {
    const missing = listeningPlan({
      selected: { ...older, url: null },
      current,
      link: sample,
      replay: false,
    });
    expect(missing).toEqual({ kind: 'missing', names: ['Older'] });
    expect(unavailableText(missing)).toBe('No preview is available for Older.');
    const replay = listeningPlan({ selected: older, current, link: sample, replay: true });
    expect(unavailableText(replay)).toBe(
      'Previews play in a live analysis: a replay does not keep them.',
    );
  });
});
