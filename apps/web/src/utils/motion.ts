import { useSyncExternalStore } from 'react';

// The reader's "reduce motion" setting, for the motion the page drives from script: smooth
// scrolls, D3 transitions and layouts, chart animations. The stylesheet stops CSS animations
// and transitions by itself (styles/index.css).

const REDUCE = '(prefers-reduced-motion: reduce)';

function query(): MediaQueryList | null {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCE)
    : null;
}

/** The reader asked for reduced motion. */
export function prefersReducedMotion(): boolean {
  return query()?.matches ?? false;
}

/** How a scroll the page starts itself moves: smoothly, or at once under reduced motion. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? 'auto' : 'smooth';
}

function subscribe(onChange: () => void): () => void {
  const list = query();
  list?.addEventListener('change', onChange);
  return () => list?.removeEventListener('change', onChange);
}

/** The reader asked for reduced motion; follows the setting while the page is open. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => false);
}
