import { expect, type Locator, type Page } from "@playwright/test";

// What the song-relations map's first view checks (#240): at rest, each card is wholly in the
// visible map area or wholly out of it, by the boxes the browser lays out, never cut by its edge.

/**
 * Every card of the map drawn in `graph` that the edge of the visible map area cuts, as
 * "<id> <card box> in <area>"; none when each card is wholly in or wholly out. The visible map
 * area is the map's box (the svg's parent, which hides what runs past it) inside the window,
 * below the band a heading laid over its top takes (`heading`: the Player's panel heading).
 * Read once the page has settled (two frames).
 */
export async function cardsCutAtRest(graph: Locator, heading?: Locator): Promise<string[]> {
  await settle(graph.page());
  const below = await bottomOf(heading);
  return graph.evaluate((svg, below) => {
    const wrapper = (svg.parentElement as Element).getBoundingClientRect();
    const area = {
      left: Math.max(wrapper.left, 0),
      top: Math.max(wrapper.top, below, 0),
      right: Math.min(wrapper.right, window.innerWidth),
      bottom: Math.min(wrapper.bottom, window.innerHeight),
    };
    const round = (box: { left: number; top: number; right: number; bottom: number }) =>
      [box.left, box.top, box.right, box.bottom].map(Math.round).join(",");
    const cut: string[] = [];
    for (const card of svg.querySelectorAll("g.nodes > g")) {
      const box = (card.querySelector("rect.card") as Element).getBoundingClientRect();
      const inside =
        box.left >= area.left - 0.5 &&
        box.right <= area.right + 0.5 &&
        box.top >= area.top - 0.5 &&
        box.bottom <= area.bottom + 0.5;
      const outside =
        box.right <= area.left + 0.5 ||
        box.left >= area.right - 0.5 ||
        box.bottom <= area.top + 0.5 ||
        box.top >= area.bottom - 0.5;
      if (!inside && !outside) {
        cut.push(`${card.getAttribute("data-node-id")} ${round(box)} in ${round(area)}`);
      }
    }
    return cut;
  }, below);
}

/** How many cards the visible map area shows whole at rest (see `cardsCutAtRest`). */
export async function wholeCardsAtRest(graph: Locator, heading?: Locator): Promise<number> {
  await settle(graph.page());
  const below = await bottomOf(heading);
  return graph.evaluate((svg, below) => {
    const wrapper = (svg.parentElement as Element).getBoundingClientRect();
    const top = Math.max(wrapper.top, below);
    return [...svg.querySelectorAll("g.nodes > g > rect.card")].filter((card) => {
      const box = card.getBoundingClientRect();
      return (
        box.left >= wrapper.left - 0.5 &&
        box.right <= wrapper.right + 0.5 &&
        box.top >= top - 0.5 &&
        box.bottom <= wrapper.bottom + 0.5
      );
    }).length;
  }, below);
}

/** Where a heading laid over the map ends on screen (none: no band). */
async function bottomOf(heading?: Locator) {
  const box = heading ? await heading.boundingBox() : null;
  return box ? box.y + box.height : Number.NEGATIVE_INFINITY;
}

/**
 * Puts the map at rest in the window: its fonts loaded, the pointer off it, and its box scrolled
 * wholly into view (again while a resize is still settling the page). Fails when the map's box
 * never fits the window.
 */
export async function mapAtRest(graph: Locator) {
  const page = graph.page();
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.mouse.move(0, 0);
  await expect
    .poll(
      async () => {
        await graph.evaluate((svg) =>
          (svg.parentElement as Element).scrollIntoView({ block: "nearest" }),
        );
        await settle(page);
        return graph.evaluate((svg) => {
          const box = (svg.parentElement as Element).getBoundingClientRect();
          return (
            box.top >= -0.5 &&
            box.left >= -0.5 &&
            box.bottom <= innerHeight + 0.5 &&
            box.right <= innerWidth + 0.5
          );
        });
      },
      { message: "the map's box is wholly in the window" },
    )
    .toBe(true);
}

/** Two frames: React has drawn, and the map has placed its view. */
function settle(page: Page) {
  return page.evaluate(
    () =>
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))),
  );
}
