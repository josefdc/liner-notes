import { type RefObject, useLayoutEffect, useState } from 'react';

/** The nearest ancestor that clips its content, or null. */
function clippingAncestor(element: HTMLElement): HTMLElement | null {
  for (let parent = element.parentElement; parent; parent = parent.parentElement) {
    const { overflowY } = getComputedStyle(parent);
    if (
      overflowY === 'hidden' ||
      overflowY === 'auto' ||
      overflowY === 'scroll' ||
      overflowY === 'clip'
    ) {
      return parent;
    }
  }
  return null;
}

/**
 * On narrow screens (below the `md` breakpoint), the height that takes `ref`'s element down to
 * the bottom of the ancestor that clips it: there its parent may have no height of its own, and
 * a height of 100% would leave the element as short as its content. Null on wider screens, and
 * whenever that height cannot be measured (then the element keeps its CSS height).
 */
export function useFillHeight(ref: RefObject<HTMLElement | null>, query = '(max-width: 767px)') {
  const [height, setHeight] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(query);
    const clip = clippingAncestor(element);
    const update = () => {
      if (!media.matches || !clip) return setHeight(null);
      const top = element.getBoundingClientRect().top;
      const bottom = clip.getBoundingClientRect().bottom;
      const fill = Math.floor(bottom - top);
      // A hidden panel measures nothing; keep the last height until it shows again.
      if (fill > 0 && element.offsetParent !== null) setHeight(fill);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (clip) observer.observe(clip);
    media.addEventListener('change', update);
    return () => {
      observer.disconnect();
      media.removeEventListener('change', update);
    };
  }, [ref, query]);
  return height;
}
