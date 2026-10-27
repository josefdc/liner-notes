import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type PreviewEvents, usePreviewAudio } from './usePreviewAudio';

// The page's one preview element, shared by two users: the Player (P) and the graph (G).

/** Every element made, as one that plays at once; a new clip resets its error and end. */
let made: FakeAudio[] = [];
class FakeAudio {
  #src = '';
  volume = 1;
  paused = true;
  currentTime = 0;
  ended = false;
  error: { code: number } | null = null;
  loads = 0;
  /** How many times a clip was set. */
  sets = 0;
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    made.push(this);
  }
  get src() {
    return this.#src;
  }
  set src(url: string) {
    this.sets += 1;
    this.#src = url;
    this.ended = false;
    this.error = null;
  }
  play() {
    this.paused = false;
    this.onplay?.();
    return Promise.resolve();
  }
  pause() {
    if (this.paused) return;
    this.paused = true;
    this.onpause?.();
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  load() {
    this.loads += 1;
  }
}

/** A user of the element, with what it was told. */
function user(name: string, heard: string[]) {
  const events: PreviewEvents = {
    onPlay: () => heard.push(`${name}:play`),
    onPause: () => heard.push(`${name}:pause`),
    onEnded: () => heard.push(`${name}:ended`),
    onError: () => heard.push(`${name}:error`),
    onStopped: () => heard.push(`${name}:stopped`),
  };
  return renderHook(() => usePreviewAudio(events));
}

/** The elements not yet let go of: not emptied with their handlers removed. */
const live = () => made.filter((audio) => audio.onplay !== null);

beforeEach(() => {
  made = [];
  vi.stubGlobal('Audio', FakeAudio);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('usePreviewAudio', () => {
  it('keeps the element while one user is left, and makes one afresh after the last goes', async () => {
    const heard: string[] = [];
    const player = user('P', heard);
    const graph = user('G', heard);
    expect(made).toHaveLength(1);

    player.unmount();
    // The graph still has the element, and plays through it.
    expect(live()).toHaveLength(1);
    await act(async () => graph.result.current.play('https://clips.test/g.mp3', 0.4));
    expect(made[0].src).toBe('https://clips.test/g.mp3');
    expect(made[0].paused).toBe(false);

    graph.unmount();
    expect(live()).toHaveLength(0);
    expect(made[0].src).toBe('');

    const again = user('P', heard);
    expect(made).toHaveLength(2);
    expect(live()).toEqual([made[1]]);
    again.unmount();
    expect(live()).toHaveLength(0);
  });

  it("stops and empties the graph's own clip when the graph goes, and the Player still plays", async () => {
    const heard: string[] = [];
    const player = user('P', heard);
    const graph = user('G', heard);
    const audio = made[0];
    await act(async () => graph.result.current.play('https://clips.test/g.mp3', 0.4));
    expect(audio.paused).toBe(false);

    graph.unmount();

    expect(audio.paused).toBe(true);
    expect(audio.src).toBe('');
    expect(audio.loads).toBeGreaterThan(0);
    await act(async () => player.result.current.play('https://clips.test/p.mp3', 0.5));
    expect(audio.src).toBe('https://clips.test/p.mp3');
    expect(audio.paused).toBe(false);
    expect(heard.at(-1)).toBe('P:play');
  });

  it("never pauses or stops another user's clip", async () => {
    const heard: string[] = [];
    const player = user('P', heard);
    const graph = user('G', heard);
    const audio = made[0];
    await act(async () => player.result.current.play('https://clips.test/p.mp3', 0.5));
    audio.currentTime = 12;

    await act(async () => graph.result.current.pause());
    await act(async () => graph.result.current.stop());

    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBe(12);
    expect(player.result.current.playing()).toBe(true);
    expect(graph.result.current.playing()).toBe(false);
  });

  it('loads a clip that failed again when it is played again', async () => {
    const heard: string[] = [];
    const graph = user('G', heard);
    const audio = made[0];
    await act(async () => graph.result.current.play('https://clips.test/g.mp3', 0.4));
    const sets = audio.sets;
    audio.error = { code: 4 };

    await act(async () => graph.result.current.play('https://clips.test/g.mp3', 0.4));

    expect(audio.sets).toBe(sets + 1);
    expect(audio.src).toBe('https://clips.test/g.mp3');
    expect(audio.error).toBeNull();
  });

  it("does not charge a late error or end of one user's clip to the user that took over", async () => {
    const heard: string[] = [];
    const player = user('P', heard);
    const graph = user('G', heard);
    const audio = made[0];
    await act(async () => player.result.current.play('https://clips.test/p.mp3', 0.5));
    await act(async () => graph.result.current.play('https://clips.test/g.mp3', 0.4));
    expect(heard).toEqual(['P:play', 'P:stopped', 'G:play']);

    // Events the Player's clip queued before the graph took over, dispatched after.
    await act(async () => audio.onerror?.());
    await act(async () => audio.onended?.());
    expect(heard).toEqual(['P:play', 'P:stopped', 'G:play']);

    // The graph's own clip failing or ending is the graph's.
    audio.error = { code: 4 };
    await act(async () => audio.onerror?.());
    audio.error = null;
    audio.ended = true;
    await act(async () => audio.onended?.());
    expect(heard.slice(3)).toEqual(['G:error', 'G:ended']);
  });
});
