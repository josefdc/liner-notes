import { expect, type Locator, type Page } from "@playwright/test";

// What the song-relations map's first view checks (#240): at rest, each card is wholly in the
// visible map area or wholly out of it, by the boxes the browser lays out, never cut by its edge.

/** A card of the map, and where it lies against the visible map area (see `cardsAtRest`). */
interface CardAtRest {
  id: string;
  /** The analysed track's card (tagged "This track"). */
  analysed: boolean;
  state: "in" | "out" | "cut";
  box: string;
  area: string;
  /** The card's box and the visible map area on screen (px): left, top, right, bottom. */
  edges: { card: readonly number[]; area: readonly number[] };
}

/**
 * Every card of the map drawn in `graph`, and whether it lies wholly in the visible map area,
 * wholly out of it, or across its edge. The visible map area is the map's box (the svg's parent,
 * which hides what runs past it) inside the window, below the bands laid over its top (`heading`:
 * the Player's panel heading; the map's own line over the axis, the year labels' band while
 * they are pinned over the cards, and down a column the band of "↑ N more"). A card under an edge cue's button ("4 more →") is cut too: the
 * button hides part of it. Fails when the map has no card.
 * Read once the page has settled (two frames).
 */
async function cardsAtRest(graph: Locator, heading?: Locator): Promise<CardAtRest[]> {
  await settle(graph.page());
  const below = await bottomOf(heading);
  const cards = await graph.evaluate((svg, below) => {
    const wrapper = (svg.parentElement as Element).getBoundingClientRect();
    // The bands over the map's top: the line over the axis, and the pinned labels' band.
    const note = svg.parentElement?.querySelector('[data-testid="axis-note"]');
    const backdrop = svg.querySelector("g.lineage-axis > rect");
    const pinned = backdrop !== null && Number(backdrop.getAttribute("fill-opacity")) > 0;
    // Down a column, the band "↑ N more" takes over the view's top (opaque).
    const band = svg.parentElement?.querySelector("[data-cue-band]");
    // The edge cues' buttons, over the map.
    const cues = [...(svg.parentElement?.querySelectorAll("[data-cue]") ?? [])].map((cue) =>
      cue.getBoundingClientRect(),
    );
    const area = {
      left: Math.max(wrapper.left, 0),
      top: Math.max(
        wrapper.top,
        below,
        0,
        note ? note.getBoundingClientRect().bottom : 0,
        pinned ? (backdrop as Element).getBoundingClientRect().bottom : 0,
        band ? band.getBoundingClientRect().bottom : 0,
      ),
      right: Math.min(wrapper.right, window.innerWidth),
      bottom: Math.min(wrapper.bottom, window.innerHeight),
    };
    const round = (box: { left: number; top: number; right: number; bottom: number }) =>
      [box.left, box.top, box.right, box.bottom].map(Math.round).join(",");
    return [...svg.querySelectorAll("g.nodes > g")].map((card) => {
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
      const underCue = cues.some(
        (cue) =>
          box.left < cue.right - 0.5 &&
          cue.left < box.right - 0.5 &&
          box.top < cue.bottom - 0.5 &&
          cue.top < box.bottom - 0.5,
      );
      return {
        id: card.getAttribute("data-node-id") ?? "",
        analysed: card.querySelector("text.sub-label")?.textContent === "This track",
        state: outside ? "out" : inside && !underCue ? "in" : "cut",
        box: round(box),
        area: round(area),
        edges: {
          card: [box.left, box.top, box.right, box.bottom],
          area: [area.left, area.top, area.right, area.bottom],
        },
      } as const;
    });
  }, below);
  expect(cards.length, "the map has cards").toBeGreaterThan(0);
  return cards;
}

/**
 * Every card of the map that the edge of the visible map area cuts (see `cardsAtRest`), as
 * "<id> <card box> in <area>"; none when each card is wholly in or wholly out.
 */
export async function cardsCutAtRest(graph: Locator, heading?: Locator): Promise<string[]> {
  return (await cardsAtRest(graph, heading))
    .filter((card) => card.state === "cut")
    .map((card) => `${card.id} ${card.box} in ${card.area}`);
}

/** The cards the visible map area shows whole at rest (see `cardsAtRest`), by id. */
export async function cardsInView(graph: Locator, heading?: Locator): Promise<string[]> {
  return (await cardsAtRest(graph, heading))
    .filter((card) => card.state === "in")
    .map((card) => card.id);
}

/**
 * Where the analysed track's card lies at rest against the visible map area (see
 * `cardsAtRest`): "in" when wholly in view. Fails when the map has no such card.
 */
export async function analysedAtRest(graph: Locator, heading?: Locator): Promise<string> {
  const analysed = (await cardsAtRest(graph, heading)).filter((card) => card.analysed);
  expect(analysed.length, "the analysed track's card").toBe(1);
  return analysed[0].state;
}

/**
 * The year labels shown over a column none of whose cards is in view, at least in part (across
 * the page): none should be, as such a label would say nothing is known for that year.
 */
export async function labelsOverEmptyColumns(graph: Locator, heading?: Locator) {
  const states = await cardsAtRest(graph, heading);
  return graph.evaluate((svg, states) => {
    const [left, top, right, bottom] = states[0].area.split(",").map(Number);
    const shown = new Set(states.filter((card) => card.state !== "out").map((card) => card.id));
    return [...svg.querySelectorAll<SVGTextElement>("text.year-tick")]
      .filter((tick) => {
        const box = tick.getBoundingClientRect();
        const centre = (box.left + box.right) / 2;
        if (getComputedStyle(tick).visibility === "hidden") return false;
        if (centre < left || centre > right || box.top > bottom || box.bottom < top - 40) {
          return false;
        }
        // The column's cards: those under the label, across the axis.
        const column = [...svg.querySelectorAll("g.nodes > g")].filter((card) => {
          const at = (card.querySelector("rect.card") as Element).getBoundingClientRect();
          return at.left <= centre && at.right >= centre;
        });
        return !column.some((card) => shown.has(card.getAttribute("data-node-id") ?? ""));
      })
      .map((tick) => tick.textContent ?? "");
  }, states);
}

/**
 * The cards past each edge of the visible map area at rest (see `cardsAtRest`), each counted
 * once: past the right or the left first, else past the bottom or the top (a card partly past
 * an edge, or hidden under a band over the top, counts for it); and the edge cues shown, each
 * with the count its name gives and its box on screen.
 */
export async function edgeCuesAtRest(graph: Locator, heading?: Locator) {
  const cards = await cardsAtRest(graph, heading);
  const counted = { left: 0, right: 0, up: 0, down: 0 };
  for (const { edges } of cards) {
    const [left, top, right, bottom] = edges.card;
    const area = edges.area;
    if (right > area[2] + 0.5) counted.right += 1;
    else if (left < area[0] - 0.5) counted.left += 1;
    else if (bottom > area[3] + 0.5) counted.down += 1;
    else if (top < area[1] - 0.5) counted.up += 1;
  }
  const shown = await graph.evaluate((svg) =>
    [...(svg.parentElement?.querySelectorAll<HTMLElement>("[data-cue]") ?? [])].map((cue) => {
      const box = cue.getBoundingClientRect();
      return {
        side: cue.getAttribute("data-cue") ?? "",
        count: Number(/\d+/.exec(cue.getAttribute("aria-label") ?? "")?.[0]),
        box: [box.left, box.top, box.right, box.bottom],
        map: (() => {
          const at = (svg.parentElement as Element).getBoundingClientRect();
          return [at.left, at.top, at.right, at.bottom];
        })(),
      };
    }),
  );
  return { counted, shown, area: cards[0].edges.area };
}

/** How many cards the visible map area shows whole at rest (see `cardsAtRest`). */
export async function wholeCardsAtRest(graph: Locator, heading?: Locator): Promise<number> {
  return (await cardsInView(graph, heading)).length;
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
