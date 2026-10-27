import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SearchCandidate } from '../../hooks/agent/types';
import { SearchBox } from './SearchBox';
import { SUGGEST_DELAY_MS, type SuggestionFetcher } from './useSuggestions';

const song = (id: string, title: string, artist = 'Johnny Cash'): SearchCandidate => ({
  id,
  title,
  artist,
  album: 'An album',
  coverUrl: '',
});
const HURT = [song('c1', 'Hurt'), song('c2', 'Hurt', 'Nine Inch Nails')];

interface Call {
  query: string;
  limit: number | undefined;
  signal: AbortSignal | undefined;
  resolve: (results: SearchCandidate[]) => void;
}

/** A suggestion fetcher the test answers by hand; an aborted request rejects, as fetch does. */
function manualFetcher() {
  const calls: Call[] = [];
  const fetcher = vi.fn(
    (query: string, limit?: number, signal?: AbortSignal) =>
      new Promise<SearchCandidate[]>((resolve, reject) => {
        signal?.addEventListener('abort', () =>
          reject(new DOMException('The operation was aborted.', 'AbortError')),
        );
        calls.push({ query, limit, signal, resolve });
      }),
  );
  return { calls, fetcher };
}

function Harness({
  fetcher,
  onPick,
  onSearch,
}: {
  fetcher: SuggestionFetcher;
  onPick: (candidate: SearchCandidate) => void;
  onSearch: (query: string) => void;
}) {
  const [value, setValue] = useState('');
  return (
    <div>
      <SearchBox
        value={value}
        onValueChange={setValue}
        onSearch={onSearch}
        onPick={onPick}
        fetchSuggestions={fetcher}
      />
      <button type="button">Elsewhere</button>
    </div>
  );
}

const pause = () => act(() => vi.advanceTimersByTime(SUGGEST_DELAY_MS));
const box = () => screen.getByRole('combobox');
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const key = (name: string, init: Record<string, unknown> = {}) =>
  fireEvent.keyDown(box(), { key: name, ...init });
const listbox = () => screen.queryByRole('listbox');

/** Renders the box, types "Hurt" and answers with two suggestions. */
async function withSuggestions() {
  const { calls, fetcher } = manualFetcher();
  const onPick = vi.fn();
  const onSearch = vi.fn();
  render(<Harness fetcher={fetcher} onPick={onPick} onSearch={onSearch} />);
  act(() => box().focus());
  type('Hurt');
  await pause();
  await act(async () => calls[0].resolve(HURT));
  expect(listbox()).not.toBeNull();
  return { calls, fetcher, onPick, onSearch };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('SearchBox: Escape', () => {
  it('keeps the list closed: the request under way is dropped and no later answer opens it', async () => {
    const { calls } = await withSuggestions();
    type('Hurt N');
    await pause();
    expect(calls[1].query).toBe('Hurt N');
    key('Escape');
    expect(listbox()).toBeNull();
    expect(calls[1].signal?.aborted).toBe(true);

    // Typing had not paused yet when Escape came: nothing is asked for afterwards either.
    type('Hurt Ni');
    key('Escape');
    await pause();
    await pause();
    expect(calls).toHaveLength(2);
    expect(listbox()).toBeNull();
    expect(box().getAttribute('aria-expanded')).toBe('false');
  });

  it('an arrow opens the list again, asking for the current text when its answer is missing', async () => {
    const { calls } = await withSuggestions();
    type('Hurt N');
    key('Escape');
    key('ArrowDown');
    // Asked at once, without waiting for typing to pause.
    expect(calls.map((call) => call.query)).toEqual(['Hurt', 'Hurt N']);
    await act(async () => calls[1].resolve([song('c2', 'Hurt', 'Nine Inch Nails')]));
    expect(listbox()).not.toBeNull();
    expect(screen.getAllByRole('option')).toHaveLength(1);
  });

  it('an arrow opens the list again at once when it holds the answer for the current text', async () => {
    const { calls } = await withSuggestions();
    key('Escape');
    key('ArrowUp');
    expect(calls).toHaveLength(1);
    const options = screen.getAllByRole('option');
    expect(box().getAttribute('aria-activedescendant')).toBe(options[1].id);
  });
});

describe('SearchBox: leaving the box', () => {
  it('closes the list when the focus moves elsewhere', async () => {
    await withSuggestions();
    expect(box().getAttribute('aria-expanded')).toBe('true');
    act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
    expect(listbox()).toBeNull();
    expect(box().getAttribute('aria-expanded')).toBe('false');
  });

  it('keeps the list open while the focus is on one of its options', async () => {
    await withSuggestions();
    // As a screen reader that moves the focus with its cursor does.
    act(() => screen.getAllByRole('option')[1].focus());
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(box().getAttribute('aria-expanded')).toBe('true');

    // Leaving the list for elsewhere closes it.
    act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
    expect(listbox()).toBeNull();
  });

  it('shows the list again when the focus comes back, without asking again', async () => {
    const { calls } = await withSuggestions();
    act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
    expect(listbox()).toBeNull();
    act(() => box().focus());
    expect(screen.getAllByRole('option')).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it('lets a request under way finish after the focus left, and shows its answer only on return', async () => {
    const { calls } = await withSuggestions();
    type('Hurt N');
    await pause();
    act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
    expect(calls[1].signal?.aborted).toBe(false);
    await act(async () => calls[1].resolve([HURT[1]]));
    // The answer is kept, not shown, while the focus is away.
    expect(listbox()).toBeNull();
    expect(box().getAttribute('aria-expanded')).toBe('false');

    act(() => box().focus());
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  it('does not open the list for an answer that comes after the focus left', async () => {
    const { calls, fetcher } = manualFetcher();
    render(<Harness fetcher={fetcher} onPick={vi.fn()} onSearch={vi.fn()} />);
    act(() => box().focus());
    type('Hurt');
    await pause();
    act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
    await act(async () => calls[0].resolve(HURT));
    expect(box().getAttribute('aria-expanded')).toBe('false');
    expect(listbox()).toBeNull();
  });

  it('still picks a suggestion with the mouse: pressing it keeps the focus in the box', async () => {
    const { onPick } = await withSuggestions();
    const option = screen.getAllByRole('option')[1];
    const press = fireEvent.mouseDown(option);
    // The press's default (moving the focus) is prevented, so the box is not left.
    expect(press).toBe(false);
    fireEvent.click(option);
    expect(onPick).toHaveBeenCalledWith(HURT[1]);
  });

  it('pressing the hint or the list itself does not take the focus either', async () => {
    await withSuggestions();
    expect(fireEvent.mouseDown(screen.getByText(/Arrow keys to move/))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByRole('listbox'))).toBe(false);
  });

  it('keeps the listbox out of the Tab order', async () => {
    await withSuggestions();
    expect(screen.getByRole('listbox').getAttribute('tabindex')).toBe('-1');
  });
});

describe('SearchBox: text answered with no suggestions', () => {
  it('asks nothing again for it on arrow keys or focus', async () => {
    const { calls, fetcher } = manualFetcher();
    render(<Harness fetcher={fetcher} onPick={vi.fn()} onSearch={vi.fn()} />);
    act(() => box().focus());
    type('Zzzzqx');
    await pause();
    await act(async () => calls[0].resolve([]));

    for (let press = 0; press < 5; press++) key('ArrowDown');
    key('ArrowUp');
    act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
    act(() => box().focus());
    await pause();
    expect(calls).toHaveLength(1);
    expect(listbox()).toBeNull();
  });
});

describe('SearchBox: text whose request failed', () => {
  it('asks nothing again for it on arrow keys or focus, and keeps saying suggestions failed', async () => {
    const { fetcher } = manualFetcher();
    const failing = vi.fn((query: string, limit?: number, signal?: AbortSignal) => {
      void fetcher(query, limit, signal);
      return Promise.reject(new Error('HTTP 429'));
    });
    render(<Harness fetcher={failing} onPick={vi.fn()} onSearch={vi.fn()} />);
    act(() => box().focus());
    type('Hurt');
    await pause();
    await act(async () => {});
    expect(screen.getByRole('status').textContent).toMatch(/unavailable/);

    for (let press = 0; press < 5; press++) key('ArrowDown');
    act(() => screen.getByRole('button', { name: 'Elsewhere' }).focus());
    act(() => box().focus());
    await pause();
    await act(async () => {});
    expect(failing).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('status').textContent).toMatch(/unavailable/);

    // An edit asks again.
    type('Hurts');
    await pause();
    expect(failing).toHaveBeenCalledTimes(2);
  });
});

describe('SearchBox: input methods (IME)', () => {
  it('leaves Enter to an IME composition: no suggestion is picked', async () => {
    const { onPick } = await withSuggestions();
    key('ArrowDown');
    const enter = key('Enter', { isComposing: true, keyCode: 229 });
    expect(onPick).not.toHaveBeenCalled();
    expect(enter).toBe(true);
  });

  it('leaves the arrow keys to an IME composition', async () => {
    await withSuggestions();
    expect(key('ArrowDown', { isComposing: true })).toBe(true);
    expect(key('ArrowDown', { keyCode: 229 })).toBe(true);
    expect(box().getAttribute('aria-activedescendant')).toBeNull();
  });
});

describe('SearchBox: editing the text', () => {
  it('drops the highlight, so Enter searches the typed text instead of an older suggestion', async () => {
    const { onPick } = await withSuggestions();
    key('ArrowDown');
    expect(box().getAttribute('aria-activedescendant')).not.toBeNull();

    type('Hurt Nine Inch');
    expect(box().getAttribute('aria-activedescendant')).toBeNull();
    expect(screen.queryAllByRole('option', { selected: true })).toHaveLength(0);
    // Not taken by the list: the form submits the text.
    expect(key('Enter')).toBe(true);
    expect(onPick).not.toHaveBeenCalled();
  });
});

describe('SearchBox: options and announcements', () => {
  it('names each option after its track, so its id stays with it when the list changes', async () => {
    const { calls } = await withSuggestions();
    const idOf = (name: RegExp) => screen.getByRole('option', { name }).id;
    const before = idOf(/Nine Inch Nails/);
    expect(before).toMatch(/c2$/);

    type('Hurt N');
    await pause();
    await act(async () => calls[1].resolve([HURT[1], HURT[0]]));
    expect(idOf(/Nine Inch Nails/)).toBe(before);
  });

  it('tells a clean and an explicit version under one ISRC apart, by name and length', async () => {
    const { calls } = await withSuggestions();
    // One song on one album, as Spotify lists both editions: only the version differs.
    const clean = {
      ...song('clean', 'Hurt'),
      isrc: 'USUM70207211',
      explicit: false,
      durationMs: 218_000,
    };
    const explicit = { ...clean, id: 'explicit', explicit: true, durationMs: 219_400 };
    type('Hurt J');
    await pause();
    await act(async () => calls[1].resolve([clean, explicit]));

    const [first, second] = screen.getAllByRole('option');
    expect(screen.getByRole('option', { name: /3:38/ })).toBe(first);
    expect(screen.getByRole('option', { name: /3:39/ })).toBe(second);
    expect(screen.queryAllByRole('option', { name: /Explicit/ })).toEqual([second]);
    expect(first.textContent).not.toMatch(/Explicit/);
  });

  it('gives option ids that are valid for any track id', async () => {
    const { calls } = await withSuggestions();
    type('Odd');
    await pause();
    await act(async () =>
      calls[1].resolve([song('a b', 'One'), song('a_b', 'Two'), song('a:b', 'Three')]),
    );
    const ids = screen.getAllByRole('option').map((option) => option.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).not.toMatch(/\s/);
  });

  it('describes the box with the keyboard hint while the list is open', async () => {
    await withSuggestions();
    const hint = screen.getByText('Arrow keys to move, Enter to analyze, Esc to close');
    expect(hint.id).not.toBe('');
    expect(box().getAttribute('aria-describedby')).toBe(hint.id);
    key('Escape');
    expect(box().getAttribute('aria-describedby')).toBeNull();
  });

  it('announces how many suggestions there are, again only when the number changes', async () => {
    const { calls } = await withSuggestions();
    const region = screen.getByRole('status');
    expect(region.textContent).toBe('2 suggestions');

    const changes: MutationRecord[] = [];
    const observer = new MutationObserver((records) => changes.push(...records));
    observer.observe(region, { childList: true, subtree: true, characterData: true });
    type('Hurt ');
    type('Hurt N');
    await pause();
    await act(async () => calls[1].resolve([HURT[1], HURT[0]]));
    await act(async () => {});
    expect(changes).toHaveLength(0);

    type('Hurt Ni');
    await pause();
    await act(async () => calls[2].resolve([HURT[1]]));
    expect(region.textContent).toBe('1 suggestion');
    observer.disconnect();
  });

  it('asks the API for more suggestions than it shows, and shows at most five', async () => {
    const { calls, fetcher } = manualFetcher();
    render(<Harness fetcher={fetcher} onPick={vi.fn()} onSearch={vi.fn()} />);
    act(() => box().focus());
    type('Hurt');
    await pause();
    expect(calls[0].limit).toBe(10);
    await act(async () =>
      calls[0].resolve(
        Array.from({ length: 10 }, (_, index) => song(`t${index}`, `Hurt ${index}`)),
      ),
    );
    expect(screen.getAllByRole('option')).toHaveLength(5);
  });
});
