import { SearchSuggestResponse, type SearchCandidate } from '@liner-notes/contract';
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeDuplicates, SUGGEST_DELAY_MS, useSuggestions } from './useSuggestions';

const song = (id: string, title: string, artist = 'M83', album = 'An album'): SearchCandidate => ({
  id,
  title,
  artist,
  album,
  coverUrl: '',
});

/**
 * A suggestion as the API sends it (Spotify's summary of the track): its ISRC and release date
 * when Spotify gave them, and the version, clean and 4:03 long unless changed.
 */
const record = (
  id: string,
  title: string,
  extra: Pick<SearchCandidate, 'isrc' | 'releaseDate' | 'explicit' | 'durationMs'>,
): SearchCandidate => ({ ...song(id, title), explicit: false, durationMs: 243_000, ...extra });

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

  it('lists one recording Spotify returns twice once, keeping its earliest release', async () => {
    const { calls, fetcher } = manualFetcher();
    const { result, rerender } = render(fetcher);

    rerender({ text: 'Midnight City M83' });
    await pause();
    // As MusicBrainz lists them: the album track and the single are one recording (one ISRC);
    // the remix is another.
    await act(async () =>
      calls[0].resolve([
        record('album', 'Midnight City', { isrc: 'GB55H1100002', releaseDate: '2011-10-18' }),
        record('remix', 'Midnight City - Eric Prydz Private Remix', {
          isrc: 'GB55H1200001',
          releaseDate: '2012-04-02',
        }),
        record('single', 'Midnight City', { isrc: 'GB55H1100002', releaseDate: '2011-09-27' }),
        record('other', 'Wait', { isrc: 'GB55H1100004', releaseDate: '2011-10-18' }),
      ]),
    );
    // The single came out first: it takes the album track's place.
    expect(result.current.suggestions.map((s) => s.id)).toEqual(['single', 'remix', 'other']);
  });

  it('ends loading and says suggestions failed when the fetcher throws at once', async () => {
    const throwing = vi.fn(() => {
      throw new Error('boom');
    });
    const { result, rerender } = renderHook(({ text }) => useSuggestions(text, throwing), {
      initialProps: { text: '' },
    });
    rerender({ text: 'Hurt' });
    await pause();
    await act(async () => {});
    expect(throwing).toHaveBeenCalledTimes(1);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.failed).toBe(true);
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
  const ids = (list: SearchCandidate[]) => mergeDuplicates(list).map((s) => s.id);

  it('merges one ISRC, and never two different ISRCs: a live take and the album take both stay', () => {
    expect(
      ids([
        record('album', 'Hurt', { isrc: 'USAT29900609', releaseDate: '2002-11-05' }),
        record('live', 'Hurt', { isrc: 'USAT20200001', releaseDate: '2003-06-01' }),
        record('again', 'Hurt - Remastered', { isrc: 'usat29900609', releaseDate: '2010-01-01' }),
      ]),
    ).toEqual(['album', 'live']);
  });

  it('keeps an explicit and a clean version apart, though they share an ISRC, as the picker does', () => {
    expect(
      ids([
        record('clean', 'Hurt', { isrc: 'USAT29900609', releaseDate: '2002-11-05' }),
        record('explicit', 'Hurt', {
          isrc: 'USAT29900609',
          releaseDate: '2002-11-05',
          explicit: true,
        }),
      ]),
    ).toEqual(['clean', 'explicit']);
  });

  it('keeps two edits apart (3:30 and 5:10), though they share an ISRC', () => {
    expect(
      ids([
        record('edit', 'Hurt', { isrc: 'USAT29900609', durationMs: 210_000 }),
        record('full', 'Hurt', { isrc: 'USAT29900609', durationMs: 310_000 }),
      ]),
    ).toEqual(['edit', 'full']);
  });

  it('never merges rows without an ISRC or a length, even with the same title and artist', () => {
    expect(ids([song('a', 'Midnight City'), song('b', ' midnight  city ')])).toEqual(['a', 'b']);
    expect(
      ids([
        record('a', 'Midnight City', { isrc: 'GB55H1100002', durationMs: undefined }),
        record('b', 'Midnight City', { isrc: 'GB55H1100002', durationMs: undefined }),
      ]),
    ).toEqual(['a', 'b']);
  });

  it('keeps the earliest release of a duplicate, in the place of the first one listed', () => {
    expect(
      ids([
        song('first', 'Wait'),
        record('late', 'Intro', { isrc: 'GB55H1100003', releaseDate: '2016-04-08' }),
        record('early', 'intro', { isrc: 'GB55H1100003', releaseDate: '2011-10-18' }),
      ]),
    ).toEqual(['first', 'early']);
  });

  // The web does not parse this answer (apiClient.ts casts it to its own type); parsing here
  // checks that the contract's schema keeps the fields the merge reads.
  it("keeps the earliest release of an answer the contract's SearchSuggestResponse accepts", () => {
    const answer = SearchSuggestResponse.parse({
      success: true,
      suggestions: [
        record('single', 'Midnight City', { isrc: 'GB55H1100002', releaseDate: '2011-10-18' }),
        record('album', 'Midnight City', { isrc: 'GB55H1100002', releaseDate: '2011-08-16' }),
      ],
    });
    expect(ids(answer.suggestions)).toEqual(['album']);
  });

  it("takes a release date of 0000, Spotify's unknown date, as missing", () => {
    const midnight = (id: string, releaseDate: string) =>
      record(id, 'Midnight City', { isrc: 'GB55H1100002', releaseDate });
    expect(ids([midnight('compilation', '0000'), midnight('album', '2011-10-18')])).toEqual([
      'album',
    ]);
    expect(ids([midnight('compilation', '0000-00-00'), midnight('album', '2011-10-18')])).toEqual([
      'album',
    ]);
  });

  it('lists a track id once', () => {
    expect(mergeDuplicates([song('a', 'One'), song('a', 'Two')]).map((s) => s.title)).toEqual([
      'One',
    ]);
  });
});
