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
 * A suggestion as the API sends it, with its ISRC and release date when Spotify gave them: both
 * are fields of the contract's SearchCandidate.
 */
const record = (
  id: string,
  title: string,
  extra: Pick<SearchCandidate, 'isrc' | 'releaseDate'>,
): SearchCandidate => ({ ...song(id, title), ...extra });

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

  it('merges rows without an ISRC with the same title and artist, and with the one recording of that title (case and spacing aside)', () => {
    expect(
      ids([
        song('a', 'Midnight City', 'M83'),
        song('b', ' midnight  city ', 'm83'),
        song('c', 'Midnight City', 'M83, Eric Prydz'),
        song('d', 'Midnight City (Live)', 'M83'),
        record('e', 'Midnight City', { isrc: 'GB55H1100002' }),
      ]),
    ).toEqual(['a', 'c', 'd']);
  });

  it("never merges rows without an ISRC in the picker's mode ('apart'), but still merges one ISRC", () => {
    const rows = [
      song('a', 'Midnight City', 'M83'),
      song('b', ' midnight  city ', 'm83'),
      record('e', 'Midnight City', { isrc: 'GB55H1100002', releaseDate: '2012-01-17' }),
      record('f', 'Midnight City', { isrc: 'gb55h1100002', releaseDate: '2011-10-18' }),
      record('g', 'Midnight City', { isrc: 'GB55H1300009' }),
      song('a', 'Midnight City', 'M83'),
    ];
    expect(mergeDuplicates(rows, 'apart').map((row) => row.id)).toEqual(['a', 'b', 'f', 'g']);
  });

  /** Every order of `list`. */
  const orders = <T>(list: T[]): T[][] =>
    list.length <= 1
      ? [list]
      : list.flatMap((item, index) =>
          orders([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [
            item,
            ...rest,
          ]),
        );

  it('never puts two different ISRCs together, whatever order Spotify lists the rows in', () => {
    // A row without an ISRC whose title and artist match two recordings cannot tell which one
    // it is: it stays a row of its own instead of joining (and bridging) either.
    const sets = [
      [
        record('noIsrc', 'Hurt', { isrc: null, releaseDate: '2002' }),
        record('studio', 'Hurt', { isrc: 'USAT29900609', releaseDate: '2002-11-05' }),
        record('live', 'Hurt', { isrc: 'USAT20200001', releaseDate: '2003-06-01' }),
      ],
      [
        record('studio', 'Hurt', { isrc: 'USAT29900609', releaseDate: '2005' }),
        record('noIsrc', 'Hurt', { isrc: null, releaseDate: '2001' }),
        record('live', 'Hurt', { isrc: 'USAT20200001', releaseDate: '2003' }),
      ],
    ];
    for (const rows of sets) {
      for (const order of orders(rows)) {
        expect([...ids(order)].sort(), order.map((row) => row.id).join(',')).toEqual([
          'live',
          'noIsrc',
          'studio',
        ]);
      }
    }
  });

  it('groups the same way in every order; only which of two equal rows is kept may change', () => {
    const rows = [
      record('album', 'Midnight City', { isrc: 'GB55H1100002' }),
      record('single', 'Midnight City', { isrc: 'gb55h1100002' }),
      record('undated', 'midnight city', {}),
      record('remix', 'Midnight City', { isrc: 'GB55H1200001' }),
      record('other', 'Wait', {}),
    ];
    // Each kept row stands for its group: its recording, or the title of an ISRC-less row.
    const groups = (list: SearchCandidate[]) =>
      mergeDuplicates(list)
        .map((row) => row.isrc?.toUpperCase() ?? `title:${row.title}`)
        .sort();
    const expected = groups(rows);
    expect(expected).toEqual(['GB55H1100002', 'GB55H1200001', 'title:Wait', 'title:midnight city']);
    for (const order of orders(rows)) {
      expect(groups(order), order.map((row) => row.id).join(',')).toEqual(expected);
    }
  });

  it('keeps the earliest release of a duplicate, in the place of the first one listed', () => {
    expect(
      ids([
        song('first', 'Wait'),
        record('late', 'Intro', { releaseDate: '2016-04-08' }),
        record('early', 'intro', { releaseDate: '2011-10-18' }),
      ]),
    ).toEqual(['first', 'early']);
    // A year alone is as early as any day in it: Spotify's order decides.
    expect(
      ids([
        record('day', 'Intro', { releaseDate: '2011-10-18' }),
        record('year', 'Intro', { releaseDate: '2011' }),
      ]),
    ).toEqual(['day']);
    // A recorded track's year counts as its date.
    expect(
      ids([
        record('later', 'Intro', { releaseDate: '2016-04-08' }),
        { ...song('recorded', 'Intro'), releaseYear: '2011' },
      ]),
    ).toEqual(['recorded']);
    // A row with both reads its release date, not its year.
    expect(
      ids([
        { ...record('both', 'Intro', { releaseDate: '2016-04-08' }), releaseYear: '2011' },
        record('dated', 'Intro', { releaseDate: '2012-01-01' }),
      ]),
    ).toEqual(['dated']);
    // A date of 0000 is unknown, and the row's year is not read in its place.
    expect(
      ids([
        record('dated', 'Intro', { isrc: 'USAT29900609', releaseDate: '2012-01-01' }),
        {
          ...record('unknown', 'Intro', { isrc: 'USAT29900609', releaseDate: '0000' }),
          releaseYear: '2011',
        },
      ]),
    ).toEqual(['dated']);
  });

  // The web does not parse this answer (apiClient.ts casts it to its own type); parsing here
  // checks that the contract's schema keeps the date the merge reads.
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
    expect(ids([midnight('album', '2011-10-18'), midnight('compilation', '0000')])).toEqual([
      'album',
    ]);
    expect(ids([midnight('album', '2011-10-18'), midnight('compilation', '0000-00-00')])).toEqual([
      'album',
    ]);
  });

  it('keeps Spotify order when either date is missing', () => {
    expect(
      ids([record('undated', 'Intro', {}), record('dated', 'Intro', { releaseDate: '2011' })]),
    ).toEqual(['undated']);
    expect(
      ids([record('dated', 'Intro', { releaseDate: '2016' }), record('undated', 'Intro', {})]),
    ).toEqual(['dated']);
    expect(ids([song('a', 'One'), song('b', 'one')])).toEqual(['a']);
  });

  it('folds case the same way in every locale', () => {
    const original = String.prototype.toLocaleLowerCase;
    // A Turkish default locale lowercases "I" to a dotless "ı".
    String.prototype.toLocaleLowerCase = function (this: string) {
      return original.call(this, 'tr');
    } as typeof original;
    try {
      expect(ids([song('a', 'INTRO', 'XX'), song('b', 'intro', 'xx')])).toEqual(['a']);
    } finally {
      String.prototype.toLocaleLowerCase = original;
    }
  });

  it('lists a track id once', () => {
    expect(mergeDuplicates([song('a', 'One'), song('a', 'Two')]).map((s) => s.title)).toEqual([
      'One',
    ]);
  });
});
