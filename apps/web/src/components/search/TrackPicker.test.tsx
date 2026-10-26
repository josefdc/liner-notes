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
    // Enter on the button is the button's own: it picks nothing.
    fireEvent.keyDown(again, { key: 'Enter' });
    expect(onPick).not.toHaveBeenCalled();
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

  it('lists a recording once (one ISRC), keeping its first release in the place of its first row', () => {
    const single = {
      ...track('m-single', 'M83', '2012'),
      title: 'Midnight City',
      isrc: 'GB55H1100002',
    };
    const album = { ...single, id: 'm-album', releaseYear: '2011' };
    const cover = {
      ...single,
      id: 'm-cover',
      artist: 'Ellie Goulding',
      releaseYear: '2014',
      isrc: 'GBUM71400001',
    };
    const { onPick } = renderPicker([single, cover, album]);
    expect(options()).toHaveLength(2);
    expect(options()[0].textContent).toContain('M83 • 2011');
    press('Enter');
    expect(onPick).toHaveBeenCalledWith(album);
  });

  it('keeps two takes with one title and artist but no ISRC: the picker is the last place to choose', () => {
    const studio = { ...track('t-full', 'Test Artist', '2001'), title: 'Bright Lines' };
    const live = { ...studio, id: 't-live-take', album: 'Live at the Hall', releaseYear: '2004' };
    renderPicker([studio, live]);
    expect(options().map((row) => row.textContent)).toEqual([
      expect.stringContaining('Test Artist • 2001'),
      expect.stringContaining('Test Artist • 2004'),
    ]);
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
