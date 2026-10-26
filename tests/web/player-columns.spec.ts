import { expect, type Page, test } from "@playwright/test";
import { analyzeAndOpenDashboard, loadFixture, openPlayer, useMockApi } from "./mock";

// From md (768 px) the Player shows its three panels side by side, and below lg the side columns
// are narrow (the left one is a quarter of the window). Provenance lines, measured-value lines and
// badges must wrap inside their column there: a column scrolls vertically and clips sideways, so
// a line wider than it loses its end (a measured value, an analyser name) without an ellipsis.

// Animations end at once, so positions are final when they are read.
test.use({ reducedMotion: "reduce" });

/**
 * Every line of text in the Player's panels that reaches past the sides of the box that clips it
 * (its nearest ancestor whose overflow is not visible), with the amount. Text that is meant to be
 * cut (an ellipsis, a line clamp), text hidden at rest and screen-reader-only text are skipped.
 */
function clippedLines(page: Page) {
  return page.evaluate(() => {
    const clipped: string[] = [];
    const panels = ["panel-context", "panel-player", "panel-genealogy"]
      .map((id) => document.getElementById(id))
      .filter((panel): panel is HTMLElement => panel !== null);
    for (const panel of panels) {
      const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent?.trim();
        const parent = node.parentElement;
        if (!text || !parent || parent.closest("svg, .sr-only")) continue;
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
  });
}

for (const width of [768, 1024]) {
  for (const fixture of ["provenance", "genealogy-kinds"]) {
    test(`at ${width} px no line in the Player's columns is cut (${fixture})`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await useMockApi(page, loadFixture(fixture));
      await analyzeAndOpenDashboard(page, "Bright Lines");
      await openPlayer(page);
      await expect(page.locator("#panel-context")).toBeVisible();
      expect(await clippedLines(page)).toEqual([]);
    });
  }
}

// A fact's card in the Player's left column: its title is read whole (it wraps rather than being
// cut), and its type chip moves below the title rather than into the card's padding.
for (const width of [768, 900, 1024, 1280]) {
  test(`at ${width} px a fact's title is whole and its type chip stays inside the card`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await useMockApi(page, loadFixture("full-result"));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    const headers = page.locator("#panel-context [data-factoid-header]");
    await expect(headers.first()).toBeVisible();
    const cards = await headers.evaluateAll((list) =>
      list.map((header) => {
        const card = header.parentElement as HTMLElement;
        const style = getComputedStyle(card);
        const box = card.getBoundingClientRect();
        const left =
          box.left +
          Number.parseFloat(style.borderLeftWidth) +
          Number.parseFloat(style.paddingLeft);
        const right =
          box.right -
          Number.parseFloat(style.borderRightWidth) -
          Number.parseFloat(style.paddingRight);
        const inside = (element: Element | null) => {
          const rect = element?.getBoundingClientRect();
          return (
            rect !== undefined &&
            rect.width > 0 &&
            rect.left >= left - 0.5 &&
            rect.right <= right + 0.5
          );
        };
        const title = header.querySelector("[data-factoid-title]") as HTMLElement;
        const chip = header.querySelector("[data-factoid-type]") as HTMLElement;
        return {
          title: title.textContent ?? "",
          whole:
            title.scrollWidth <= title.clientWidth + 0.5 &&
            getComputedStyle(title).textOverflow !== "ellipsis",
          titleInside: inside(title),
          chipInside: inside(chip),
          chipWhole: chip.scrollWidth <= chip.clientWidth + 0.5,
        };
      }),
    );
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) {
      expect(card, card.title).toMatchObject({
        whole: true,
        titleInside: true,
        chipInside: true,
        chipWhole: true,
      });
    }
  });
}
