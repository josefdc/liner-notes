import type { Page } from "@playwright/test";

// What the Player's layout specs check: no line of text cut by the box that clips it.

/**
 * Every line of text in the Player's panels (and its header above them) that reaches past the sides of the box that clips it
 * (its nearest ancestor whose overflow is not visible), with the amount. Text that is meant to be
 * cut (an ellipsis, a line clamp), text hidden at rest and screen-reader-only text are skipped.
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
        if (style.textOverflow === "ellipsis" || style.webkitLineClamp !== "none") continue;
        // Not shown at rest (a hover tooltip).
        let shown = true;
        for (let el: HTMLElement | null = parent; el && shown; el = el.parentElement) {
          shown = getComputedStyle(el).opacity !== "0";
        }
        if (!shown) continue;
        let clip: HTMLElement | null = parent;
        while (clip && getComputedStyle(clip).overflowX === "visible") clip = clip.parentElement;
        if (!clip) continue;
        const box = clip.getBoundingClientRect();
        const left = box.left + clip.clientLeft;
        const right = left + clip.clientWidth;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const line of range.getClientRects()) {
          if (line.width === 0) continue;
          const over = Math.max(left - line.left, line.right - right);
          if (over > 0.5) clipped.push(`${text.slice(0, 50)} (${Math.round(over)} px)`);
        }
      }
    }
    return clipped;
  }, ids);
}
