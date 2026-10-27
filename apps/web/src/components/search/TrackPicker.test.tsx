import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SearchCandidate } from '../../hooks/agent/types';
import { TrackPicker } from './TrackPicker';

const track = (id: string, artist: string, releaseYear = '2002'): SearchCandidate => ({
  id,
  title: 'Hurt',
  artist,
  album: 'An album',
  coverUrl: '',
  releaseYear,
});
const FIVE = [
  track('c1', 'Johnny Cash'),
  track('c2', 'Nine Inch Nails', '1994'),
  track('c3', 'Christina Aguilera', '2006'),
  track('c4', 'Leona Lewis', '2011'),
  track('c5', 'Thousand Foot Krutch', '2003'),
];

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderPicker(candidates = FIVE) {
  const onPick = vi.fn();
  const onSearchAgain = vi.fn();
  const view = render(
    <TrackPicker candidates={candidates} onPick={onPick} onSearchAgain={onSearchAgain} />,
  );
  return { onPick, onSearchAgain, view };
}

const options = () => screen.getAllByRole('option');
const selected = () => options().findIndex((row) => row.getAttribute('aria-selected') === 'true');
const press = (key: string) => fireEvent.keyDown(document.activeElement as Element, { key });

describe('TrackPicker', () => {
  it('is a listbox named by its question, with a row per candidate', () => {
    renderPicker();
    const list = screen.getByRole('listbox', { name: 'Is this the right track?' });
    expect(list.getAttribute('aria-describedby')).toBeTruthy();
    expect(options()).toHaveLength(5);
    expect(options()[4].textContent).toContain('Thousand Foot Krutch • 2003');
  });

  it('gives the first row the focus when it appears, and keeps one Tab stop', () => {
    renderPicker();
    expect(document.activeElement).toBe(options()[0]);
    expect(options().map((row) => row.tabIndex)).toEqual([0, -1, -1, -1, -1]);
    expect(selected()).toBe(0);
  });

  it('moves the focus and the selection with the arrows, Home and End, wrapping at the ends', () => {
    renderPicker();
    const steps: Array<[string, number]> = [
      ['ArrowDown', 1],
      ['ArrowDown', 2],
      ['End', 4],
      ['ArrowDown', 0],
      ['ArrowUp', 4],
      ['Home', 0],
      ['ArrowUp', 4],
    ];
    for (const [key, expected] of steps) {
      press(key);
      expect(document.activeElement, key).toBe(options()[expected]);
      expect(selected(), key).toBe(expected);
      expect(options()[expected].tabIndex, key).toBe(0);
    }
  });

  it('picks the highlighted row with Enter, and any row with a click', () => {
    const { onPick } = renderPicker();
    press('ArrowDown');
    press('Enter');
    expect(onPick).toHaveBeenLastCalledWith(FIVE[1]);
    fireEvent.click(options()[3]);
    expect(onPick).toHaveBeenLastCalledWith(FIVE[3]);
    expect(onPick).toHaveBeenCalledTimes(2);
  });

  it('leaves for the search with Escape, from a row or from Search again, and with the button', () => {
    const { onSearchAgain, onPick } = renderPicker();
    press('Escape');
    expect(onSearchAgain).toHaveBeenCalledTimes(1);
    const again = screen.getByRole('button', { name: 'Search again' });
    again.focus();
    press('Escape');
    expect(onSearchAgain).toHaveBeenCalledTimes(2);
    fireEvent.click(again);
    expect(onSearchAgain).toHaveBeenCalledTimes(3);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('leaves Enter on Search again to the button: the highlighted row is not picked', () => {
    const { onPick } = renderPicker();
    press('ArrowDown');
    const again = screen.getByRole('button', { name: 'Search again' });
    again.focus();
    // The key reaches every handler around the button; none of them may pick a row.
    fireEvent.keyDown(again, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
    // The same key on the row does pick it, so the check above can fail.
    fireEvent.keyDown(options()[1], { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith(FIVE[1]);
  });

  it('takes Space on a row without picking it, so the page does not scroll', () => {
    const { onPick } = renderPicker();
    press('ArrowDown');
    // fireEvent returns false when a handler prevented the default action.
    expect(fireEvent.keyDown(options()[1], { key: ' ' })).toBe(false);
    expect(onPick).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(options()[1]);
  });

  it('never picks a row by itself, however long it stays open', () => {
    vi.useFakeTimers();
    const { onPick } = renderPicker();
    act(() => {
      vi.advanceTimersByTime(10 * 60_000);
    });
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.queryByText(/pick the top match|paused/i)).toBeNull();
    expect(screen.getByText('Nothing is analyzed until you choose a track.')).toBeTruthy();
  });

  it('shows rows sharing an ISRC as one, the earliest release, in the place of the first', () => {
    // One recording, listed as its single and on its album: one row, the album's (2011).
    const single = {
      ...track('m-single', 'M83', '2012'),
      title: 'Midnight City',
      isrc: 'GB55H1100002',
      releaseDate: '2012-01-17',
      explicit: false,
      durationMs: 243_000,
    };
    const album = { ...single, id: 'm-album', releaseYear: '2011', releaseDate: '2011-10-18' };
    // Another recording of the song (a live take): another ISRC, its own row.
    const liveIsrc = {
      ...single,
      id: 'm-live',
      album: 'Live',
      isrc: 'GB55H1300009',
      releaseYear: '2013',
      releaseDate: '2013',
    };
    const { onPick } = renderPicker([
      single,
      track('c2', 'Nine Inch Nails', '1994'),
      album,
      liveIsrc,
    ]);
    expect(options().map((row) => row.textContent)).toEqual([
      expect.stringContaining('M83 • 2011'),
      expect.stringContaining('Nine Inch Nails • 1994'),
      expect.stringContaining('M83 • 2013'),
    ]);
    press('Enter');
    expect(onPick).toHaveBeenCalledWith(album);
  });

  it('never merges rows without an ISRC, even with the same title and artist', () => {
    // Two takes the server cannot tell apart (no ISRC): both stay, the picker is where to choose.
    const studio = { ...track('t-full', 'Test Artist', '2001'), title: 'Bright Lines' };
    const live = { ...studio, id: 't-live-take', album: 'Live at the Hall', releaseYear: '2004' };
    const { onPick } = renderPicker([studio, live]);
    expect(options().map((row) => row.textContent)).toEqual([
      expect.stringContaining('Test Artist • 2001'),
      expect.stringContaining('Test Artist • 2004'),
    ]);
    press('End');
    press('Enter');
    expect(onPick).toHaveBeenCalledWith(live);
  });

  it('lists a track id once', () => {
    renderPicker([
      track('c1', 'Johnny Cash'),
      track('c2', 'Nine Inch Nails'),
      track('c1', 'Johnny Cash'),
    ]);
    expect(options()).toHaveLength(2);
  });

  it('names the list by its question, and only the list', () => {
    renderPicker();
    expect(screen.getByRole('listbox').getAttribute('aria-labelledby')).toBe(
      screen.getByRole('heading', { name: 'Is this the right track?' }).id,
    );
    expect(screen.queryByRole('region')).toBeNull();
  });

  it('offers Escape in its hint only when there is a way back to the search', () => {
    const onPick = vi.fn();
    render(<TrackPicker candidates={FIVE} onPick={onPick} />);
    const hint = document.getElementById(
      screen.getByRole('listbox').getAttribute('aria-describedby') ?? '',
    );
    expect(hint?.textContent).toBe('Arrow keys to move, Enter to analyze');
    cleanup();
    renderPicker();
    const withEscape = document.getElementById(
      screen.getByRole('listbox').getAttribute('aria-describedby') ?? '',
    );
    expect(withEscape?.textContent).toBe(
      'Arrow keys to move, Enter to analyze, Esc to search again',
    );
  });

  it('starts a new list at its first row, with the focus there', () => {
    const { view, onPick } = renderPicker();
    press('End');
    const next = [track('d1', 'Someone'), track('d2', 'Someone Else')];
    view.rerender(<TrackPicker candidates={next} onPick={onPick} />);
    expect(options()).toHaveLength(2);
    expect(selected()).toBe(0);
    expect(document.activeElement).toBe(options()[0]);
    // Without a way back to the search, Escape does nothing and there is no button.
    expect(screen.queryByRole('button', { name: 'Search again' })).toBeNull();
  });
});
