import type { Page } from "@playwright/test";

// What the Player's layout specs check: no line of text cut by the box that clips it.

/**
 * Every line of text in the Player's panels (and its header above them) that is cut by the box
 * that clips it, with the amount:
 * - sideways: a line reaching past the sides of its nearest ancestor whose horizontal overflow is
 *   not visible (a box that scrolls sideways hides the line's end just the same);
 * - up or down: a line reaching past the top or bottom of its nearest ancestor whose vertical
 *   overflow is not visible, when that box hides what overflows (`hidden`, `clip`) rather than
 *   scrolling to it.
 * Text that is meant to be cut (an ellipsis, a line clamp), text hidden at rest and
 * screen-reader-only text are skipped.
 */
export function clippedLines(
  page: Page,
  ids = ["player-header", "panel-context", "panel-player", "panel-genealogy"],
) {
  return page.evaluate((ids) => {
    const clipped: string[] = [];
    const panels = ids
      .map((id) => document.getElementById(id))
      .filter((panel): panel is HTMLElement => panel !== null);
    for (const panel of panels) {
      const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim();
        const parent = node.parentElement;
        if (!text || !parent || parent.closest("svg, .sr-only")) continue;
        // Screen-reader-only at this width (`md:sr-only`): clipped to nothing on purpose.
        let readOnly = false;
        for (let el: HTMLElement | null = parent; el && !readOnly; el = el.parentElement) {
          readOnly = getComputedStyle(el).clipPath === "inset(50%)";
        }
        if (readOnly) continue;
        const style = getComputedStyle(parent);
        if (style.textOverflow === "ellipsis") continue;
        // Inside a line clamp: cut at its last line on purpose.
        let clamped = false;
        for (let el: HTMLElement | null = parent; el && !clamped; el = el.parentElement) {
          clamped = getComputedStyle(el).webkitLineClamp !== "none";
        }
        if (clamped) continue;
        // Not shown at rest (a hover tooltip).
        let shown = true;
        for (let el: HTMLElement | null = parent; el && shown; el = el.parentElement) {
          shown = getComputedStyle(el).opacity !== "0";
        }
        if (!shown) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const lines = [...range.getClientRects()].filter((line) => line.width > 0);
        let clip: HTMLElement | null = parent;
        while (clip && getComputedStyle(clip).overflowX === "visible") clip = clip.parentElement;
        if (clip) {
          const box = clip.getBoundingClientRect();
          const left = box.left + clip.clientLeft;
          const right = left + clip.clientWidth;
          for (const line of lines) {
            const over = Math.max(left - line.left, line.right - right);
            if (over > 0.5) clipped.push(`${text.slice(0, 50)} (${Math.round(over)} px)`);
          }
        }
        let cut: HTMLElement | null = parent;
        while (cut && getComputedStyle(cut).overflowY === "visible") cut = cut.parentElement;
        const hides = cut !== null && ["hidden", "clip"].includes(getComputedStyle(cut).overflowY);
        if (cut && hides) {
          const box = cut.getBoundingClientRect();
          const top = box.top + cut.clientTop;
          const bottom = top + cut.clientHeight;
          for (const line of lines) {
            // A glyph box a pixel past a tight box (a one-letter label in a bar) cuts no ink.
            const over = Math.max(top - line.top, line.bottom - bottom);
            if (over > 1.5) clipped.push(`${text.slice(0, 50)} (${Math.round(over)} px, vertical)`);
          }
        }
      }
    }
    return clipped;
  }, ids);
}
