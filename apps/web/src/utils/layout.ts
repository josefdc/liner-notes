import { useSyncExternalStore } from 'react';

// The Player's layout by the window's width, read with the breakpoints its classes use
// (Tailwind's md, 48rem, and xl, 80rem), so script and stylesheet switch at the same width:
// - 'tabs' below md: one panel at a time, chosen with the phone tabs;
// - 'columns' from md up to xl: the notes and the player side by side, the connections below,
//   the whole area scrolling as one;
// - 'triptych' from xl: three columns, each scrolling on its own.

export type PlayerLayout = 'tabs' | 'columns' | 'triptych';

const MD = '(min-width: 48rem)';
const XL = '(min-width: 80rem)';

function list(query: string): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query)
    : null;
}

/** The Player's layout at the window's width now ('tabs' where it cannot be read). */
export function playerLayout(): PlayerLayout {
  if (list(XL)?.matches) return 'triptych';
  return list(MD)?.matches ? 'columns' : 'tabs';
}

function subscribe(onChange: () => void): () => void {
  const lists = [list(MD), list(XL)];
  for (const item of lists) item?.addEventListener('change', onChange);
  return () => {
    for (const item of lists) item?.removeEventListener('change', onChange);
  };
}

/** The Player's layout, following the window's width while the page is open. */
export function usePlayerLayout(): PlayerLayout {
  return useSyncExternalStore(subscribe, playerLayout, () => 'tabs');
}
