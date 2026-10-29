import { useSyncExternalStore } from 'react';

// The Player's layout by the window's width, read with the breakpoint its classes use
// (Tailwind's md, 48rem), so script and stylesheet switch at the same width:
// - 'tabs' below md: one panel at a time, chosen with the phone tabs;
// - 'columns' from md up: the notes and the player side by side, the connections in a row
//   below them, the whole area scrolling as one.

export type PlayerLayout = 'tabs' | 'columns';

const MD = '(min-width: 48rem)';

// One list per query, made on first use: a render reads them several times. They are made
// again when `window.matchMedia` itself is replaced (a test's stand-in).
let source: Window['matchMedia'] | null = null;
const byQuery = new Map<string, MediaQueryList>();

function list(query: string): MediaQueryList | null {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return null;
  if (source !== window.matchMedia) {
    source = window.matchMedia;
    byQuery.clear();
  }
  let item = byQuery.get(query);
  if (item === undefined) {
    item = window.matchMedia(query);
    byQuery.set(query, item);
  }
  return item;
}

/** The Player's layout at the window's width now ('tabs' where it cannot be read). */
export function playerLayout(): PlayerLayout {
  return list(MD)?.matches ? 'columns' : 'tabs';
}

function subscribe(onChange: () => void): () => void {
  const lists = [list(MD)];
  for (const item of lists) item?.addEventListener('change', onChange);
  return () => {
    for (const item of lists) item?.removeEventListener('change', onChange);
  };
}

/** The Player's layout, following the window's width while the page is open. */
export function usePlayerLayout(): PlayerLayout {
  return useSyncExternalStore(subscribe, playerLayout, () => 'tabs');
}

/** True from md up (48rem), where the classes' `md:` variants apply (false where unread). */
export function mdUp(): boolean {
  return list(MD)?.matches ?? false;
}

/**
 * `mdUp`, following the window's width while the page is open. A change of the browser's
 * default font size moves the breakpoint too, but sends no change event (Chromium): the next
 * render reads it.
 */
export function useMdUp(): boolean {
  return useSyncExternalStore(subscribe, mdUp, () => false);
}

const NO_HOVER = '(hover: none)';

/** True when the main pointer cannot hover: a touch screen. */
export function noHover(): boolean {
  return list(NO_HOVER)?.matches ?? false;
}

function subscribeHover(onChange: () => void): () => void {
  const item = list(NO_HOVER);
  item?.addEventListener('change', onChange);
  return () => item?.removeEventListener('change', onChange);
}

/** True when the main pointer cannot hover (a touch screen), following the setting. */
export function useNoHover(): boolean {
  return useSyncExternalStore(subscribeHover, noHover, () => false);
}

const SHORT = '(max-height: 32rem)';

/**
 * True where a band above a screen must stay small: below md, or in a window 32rem tall or
 * less (a phone held sideways).
 */
export function compactBand(): boolean {
  return !(list(MD)?.matches ?? false) || (list(SHORT)?.matches ?? false);
}

function subscribeCompact(onChange: () => void): () => void {
  const lists = [list(MD), list(SHORT)];
  for (const item of lists) item?.addEventListener('change', onChange);
  return () => {
    for (const item of lists) item?.removeEventListener('change', onChange);
  };
}

/** `compactBand`, following the window's size while the page is open. */
export function useCompactBand(): boolean {
  return useSyncExternalStore(subscribeCompact, compactBand, () => true);
}
