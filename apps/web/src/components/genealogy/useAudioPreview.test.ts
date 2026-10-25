import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAudioPreview } from './useAudioPreview';

/** What the next play() does: play, or fail with an error of this name. */
let nextPlay: 'plays' | string = 'plays';
let lastAudio: FakeAudio | null = null;

class FakeAudio {
  src = '';
  volume = 1;
  paused = true;
  currentTime = 0;
  onplay: (() => void) | null = null;
  onpause: (() => void) | null = null;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    lastAudio = this;
  }
  play() {
    if (nextPlay === 'plays') {
      this.paused = false;
      this.onplay?.();
      return Promise.resolve();
    }
    return Promise.reject(new DOMException('cannot play', nextPlay));
  }
  pause() {
    this.paused = true;
    this.onpause?.();
  }
}

beforeEach(() => {
  nextPlay = 'plays';
  vi.stubGlobal('Audio', FakeAudio);
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const clip = 'https://cdnt-preview.dzcdn.net/api/1/1/a/b/0/n.mp3?hdnea=exp=1~hmac=y';

describe('useAudioPreview', () => {
  it('marks only that node unavailable when its clip cannot be loaded, and retries on the next hover', async () => {
    const { result } = renderHook(() => useAudioPreview());

    nextPlay = 'NotSupportedError';
    await act(async () => result.current.playPreview(clip, 'n1'));
    expect(result.current.hasPreviewSupport).toBe(true);
    expect(result.current.unavailableNodeId).toBe('n1');
    expect(result.current.playingNodeId).toBeNull();

    nextPlay = 'plays';
    await act(async () => result.current.playPreview(clip, 'n1'));
    expect(result.current.unavailableNodeId).toBeNull();
    expect(result.current.playingNodeId).toBe('n1');
    expect(result.current.isPlaying).toBe(true);
  });

  it('marks a clip that fails while loading unavailable', async () => {
    const { result } = renderHook(() => useAudioPreview());

    await act(async () => result.current.playPreview(clip, 'n2'));
    await act(async () => lastAudio?.onerror?.());

    expect(result.current.unavailableNodeId).toBe('n2');
    expect(result.current.hasPreviewSupport).toBe(true);
  });

  it('says audio is blocked only when the browser refuses to play, until a clip plays', async () => {
    const { result } = renderHook(() => useAudioPreview());

    nextPlay = 'NotAllowedError';
    await act(async () => result.current.playPreview(clip, 'n1'));
    expect(result.current.hasPreviewSupport).toBe(false);
    expect(result.current.unavailableNodeId).toBeNull();

    nextPlay = 'plays';
    await act(async () => result.current.playPreview(clip, 'n3'));
    expect(result.current.hasPreviewSupport).toBe(true);
  });

  it('ignores a play that another preview interrupted', async () => {
    const { result } = renderHook(() => useAudioPreview());

    nextPlay = 'AbortError';
    await act(async () => result.current.playPreview(clip, 'n1'));

    expect(result.current.hasPreviewSupport).toBe(true);
    expect(result.current.unavailableNodeId).toBeNull();
  });

  it('never logs the clip link', async () => {
    const { result } = renderHook(() => useAudioPreview());

    nextPlay = 'NotAllowedError';
    await act(async () => result.current.playPreview(clip, 'n1'));

    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toMatch(/dzcdn|hdnea/);
  });
});
