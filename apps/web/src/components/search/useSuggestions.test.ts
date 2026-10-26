import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchCandidate } from '../../hooks/agent/types';
import { mergeDuplicates, SUGGEST_DELAY_MS, useSuggestions } from './useSuggestions';

const song = (id: string, title: string, artist = 'M83', album = 'An album'): SearchCandidate => ({
  id,
  title,
  artist,
  album,
  coverUrl: '',
});

interface Call {
  query: string;
  signal: AbortSignal | undefined;
  resolve: (results: SearchCandidate[]) => void;
  reject: (error: Error) => void;
}

/** A suggestion fetcher the test answers by hand. Like a server that never sees the abort, it
 *  still answers an aborted request when told to. */
function manualFetcher() {
  const calls: Call[] = [];
  const fetcher = vi.fn(
    (query: string, _limit?: number, signal?: AbortSignal) =>
      new Promise<SearchCandidate[]>((resolve, reject) => {
        calls.push({ query, signal, resolve, reject });
      }),
  );
  return { calls, fetcher };
}

function render(fetcher: ReturnType<typeof manualFetcher>['fetcher'], query = '') {
  return renderHook(({ text }) => useSuggestions(text, fetcher), {
    initialProps: { text: query },
  });
}

/** Lets typing pause long enough for suggestions to be asked for. */
const pause = () => act(() => vi.advanceTimersByTime(SUGGEST_DELAY_MS));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useSuggestions', () => {
  it('asks once typing pauses and shows the answer', async () => {
    const { calls, fetcher } = manualFetcher();
    const { result, rerender } = render(fetcher);

    rerender({ text: 'Hu' });
    rerender({ text: 'Hurt' });
    expect(fetcher).not.toHaveBeenCalled();
    await pause();
    expect(calls.map((call) => call.query)).toEqual(['Hurt']);
    expect(result.current.isLoading).toBe(true);

    await act(async () => calls[0].resolve([song('c1', 'Hurt', 'Johnny Cash')]));
    expect(result.current.suggestions.map((s) => s.id)).toEqual(['c1']);
    expect(result.current.open).toBe(true);
    expect(result.current.isLoading).toBe(false);
  });

  it('aborts the request for older text as soon as the text changes, and on unmount', async () => {
    const { calls, fetcher } = manualFetcher();
    const { rerender, unmount } = render(fetcher);

    rerender({ text: 'Hurt' });
    await pause();
    expect(calls[0].signal?.aborted).toBe(false);
    // The next keystroke, before typing pauses again: the older request is already stale.
    rerender({ text: 'Hurt N' });
    expect(calls[0].signal?.aborted).toBe(true);

    await pause();
    expect(calls[1].query).toBe('Hurt N');
    unmount();
    expect(calls[1].signal?.aborted).toBe(true);
  });

  it('ignores a late answer for older text, even one the server sends after the abort', async () => {
    const { calls, fetcher } = manualFetcher();
    const { result, rerender } = render(fetcher);

    rerender({ text: 'Hurt' });
    await pause();
    rerender({ text: 'Hurt Nine' });
    await pause();
    await act(async () => calls[1].resolve([song('c2', 'Hurt', 'Nine Inch Nails')]));

    await act(async () =>
      calls[0].resolve([song('c1', 'Hurt', 'Johnny Cash'), song('c3', 'Hurt', 'Aguilera')]),
    );
    expect(result.current.suggestions.map((s) => s.id)).toEqual(['c2']);

    // Nor does an older request that fails late say that suggestions are unavailable.
    rerender({ text: 'Hurt Nine Inch' });
    await pause();
    await act(async () => calls[2].resolve([song('c2', 'Hurt', 'Nine Inch Nails')]));
    await act(async () => calls[1].reject(new Error('HTTP 502')));
    expect(result.current.failed).toBe(false);
    expect(result.current.suggestions.map((s) => s.id)).toEqual(['c2']);
  });

  it('lists a song Spotify returns twice once, keeping the first in its place', async () => {
    const { calls, fetcher } = manualFetcher();
    const { result, rerender } = render(fetcher);

    rerender({ text: 'Midnight City M83' });
    await pause();
    await act(async () =>
      calls[0].resolve([
        song('album', 'Midnight City', 'M83', "Hurry Up, We're Dreaming"),
        song('remix', 'Midnight City - Eric Prydz Private Remix'),
        song('single', 'Midnight City', 'M83', 'Midnight City'),
        song('other', 'Wait'),
      ]),
    );
    expect(result.current.suggestions.map((s) => s.id)).toEqual(['album', 'remix', 'other']);
  });

  it('says when suggestions fail, and stops saying it once they load', async () => {
    const { calls, fetcher } = manualFetcher();
    const { result, rerender } = render(fetcher);

    rerender({ text: 'Hurt' });
    await pause();
    await act(async () => calls[0].reject(new Error('HTTP 503')));
    expect(result.current.failed).toBe(true);
    expect(result.current.open).toBe(false);

    rerender({ text: 'Hurts' });
    await pause();
    await act(async () => calls[1].resolve([song('c1', 'Hurt')]));
    expect(result.current.failed).toBe(false);
  });

  it('asks nothing for settled text: a picked suggestion does not open the list again', async () => {
    const { calls, fetcher } = manualFetcher();
    const { result, rerender } = render(fetcher);

    rerender({ text: 'Hurt' });
    await pause();
    await act(async () => calls[0].resolve([song('c1', 'Hurt', 'Johnny Cash')]));
    act(() => result.current.settle('Hurt Johnny Cash'));
    rerender({ text: 'Hurt Johnny Cash' });
    await pause();
    await pause();
    expect(calls).toHaveLength(1);
    expect(result.current.open).toBe(false);
    expect(result.current.suggestions).toEqual([]);

    // Edited, it is typed text again.
    rerender({ text: 'Hurt Johnny Cas' });
    await pause();
    expect(calls.map((call) => call.query)).toEqual(['Hurt', 'Hurt Johnny Cas']);
  });

  it('drops a request under way when the text is settled', async () => {
    const { calls, fetcher } = manualFetcher();
    const { result, rerender } = render(fetcher);

    rerender({ text: 'Hurt' });
    await pause();
    act(() => result.current.settle('Hurt'));
    expect(calls[0].signal?.aborted).toBe(true);
    await act(async () => calls[0].resolve([song('c1', 'Hurt')]));
    expect(result.current.open).toBe(false);

    // A search submitted before typing paused asks nothing afterwards.
    rerender({ text: 'Hurt N' });
    act(() => result.current.settle('Hurt N'));
    await pause();
    expect(calls).toHaveLength(1);
  });

  it('asks nothing for the text the box starts with', async () => {
    const { fetcher } = manualFetcher();
    render(fetcher, 'Hurt');
    await pause();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('clears the list for text shorter than two characters', async () => {
    const { calls, fetcher } = manualFetcher();
    const { result, rerender } = render(fetcher);

    rerender({ text: 'Hurt' });
    await pause();
    await act(async () => calls[0].resolve([song('c1', 'Hurt')]));
    rerender({ text: 'H' });
    expect(result.current.suggestions).toEqual([]);
    expect(result.current.open).toBe(false);
    await pause();
    expect(calls).toHaveLength(1);
  });
});

describe('mergeDuplicates', () => {
  it('treats case and spacing as the same song, and a different title or artist as another', () => {
    const merged = mergeDuplicates([
      song('a', 'Midnight City', 'M83'),
      song('b', ' midnight  city ', 'm83'),
      song('c', 'Midnight City', 'M83, Eric Prydz'),
      song('d', 'Midnight City (Live)', 'M83'),
    ]);
    expect(merged.map((s) => s.id)).toEqual(['a', 'c', 'd']);
  });

  it('lists a track id once', () => {
    expect(mergeDuplicates([song('a', 'One'), song('a', 'Two')]).map((s) => s.title)).toEqual([
      'One',
    ]);
  });
});
