import { expect, test } from "@playwright/test";
import { clippedLines } from "./clipping";
import { analyzeAndOpenDashboard, loadFixture, openPlayer, useMockApi } from "./mock";

// From md (768 px) the Player shows its panels side by side: the notes and the player in two
// columns, with the connections in a row below them (at every width from md up).
// Provenance lines, measured-value lines and badges must wrap inside their column: the panels'
// area scrolls vertically and clips sideways, so a line wider than its column loses its end (a
// measured value, an analyser name) without an ellipsis.

// Animations end at once, so positions are final when they are read.
test.use({ reducedMotion: "reduce" });

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
        const textInside = (element: HTMLElement) => {
          const own = element.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          return [...range.getClientRects()].every(
            (line) => line.left >= own.left - 0.5 && line.right <= own.right + 0.5,
          );
        };
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
          // Every line of the title's text lies within the title's box: none runs past it.
          whole: title.scrollWidth <= title.clientWidth + 0.5 && textInside(title),
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

// The keyboard follows the page's order: the panels are in the page in the order they are read,
// the two columns left to right, then the connections' row below them (WCAG 2.4.3), so Tab never
// jumps from the right column back to the left.
test("at 1440 px the Player's panels are in the page in the order they are drawn", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, loadFixture("full-result"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  // (From md up the tabs are hidden, so the panels are plain columns, not tab panels.)
  const panels = page.locator("#panel-context, #panel-player, #panel-genealogy");
  await expect(panels).toHaveCount(3);
  await expect(page.getByRole("tabpanel", { includeHidden: true })).toHaveCount(0);
  const columns = await panels.evaluateAll((list) =>
    list.map((panel, index) => {
      const box = panel.getBoundingClientRect();
      return { id: panel.id, index, x: box.x, y: box.y };
    }),
  );
  // Read row by row (a row is the panels that start at the same height), left to right.
  const drawn = [...columns]
    .sort((a, b) => (Math.abs(a.y - b.y) < 1 ? a.x - b.x : a.y - b.y))
    .map((column) => column.id);
  expect(drawn).toEqual(columns.map((column) => column.id));
  expect(drawn).toEqual(["panel-context", "panel-player", "panel-genealogy"]);
});

const ANALYZE = "/api/analyze/stream";

/** The full-result fixture with the result's title and artist replaced. */
function withTrack(track: { title: string; artist: string }) {
  const fixture = loadFixture("full-result");
  const events = fixture.streams[ANALYZE] as Array<{ type: string; data?: object }>;
  fixture.streams[ANALYZE] = events.map((event) =>
    event.type === "complete" ? { ...event, data: { ...event.data, ...track } } : event,
  );
  return fixture;
}

// A title with a word longer than any column, and a long artist.
const LONG = {
  title: `${"Superlongunbrokenwordtitle".repeat(4)} (Extended Club Mix)`,
  artist: "Somebody Featuring Somebody Else and the Rest of the Band",
};

// The track's title and artist wrap rather than run past the window, even a word longer than the
// line, and the audio line (from md up) stays on one line beside them, from phone to desktop.
// From md up the header stays above the columns, so a title longer than two lines is cut there
// with an ellipsis (and an artist longer than one): each is read whole (the heading's text) and
// shown whole on hover (its title).
for (const width of [390, 768, 1024, 1440]) {
  test(`at ${width} px the Player's title is whole`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await useMockApi(page, withTrack(LONG));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(LONG.title);
    await expect(page.getByRole("heading", { level: 1 })).toHaveAttribute("title", LONG.title);
    // Below md the header is for screen readers only, and the Player tab shows the title.
    const shown = width >= 768 ? ["player-header", "panel-player"] : ["panel-player"];
    if (width < 768) {
      const header = await page.locator("#player-header").boundingBox();
      expect(header?.width ?? 0).toBeLessThanOrEqual(1);
      await expect(page.locator("#panel-player")).toContainText(LONG.title);
    }
    expect(await clippedLines(page, shown)).toEqual([]);
    const overflowing = await page.evaluate(
      (shown) =>
        shown.filter((id) => {
          const element = document.getElementById(id);
          return (
            element !== null &&
            element.getClientRects().length > 0 &&
            element.clientWidth > 1 &&
            element.scrollWidth > element.clientWidth
          );
        }),
      shown,
    );
    expect(overflowing).toEqual([]);
    const line = page.getByTestId("player-audio-line");
    if (width >= 768) {
      const lines = await line.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
      });
      expect(lines).toBe(1);
    } else {
      await expect(line).toBeHidden();
    }
  });
}

// On phones the track's title takes no fixed band above the tabs: the Player tab keeps the
// height it had with the title inside it (446 px at 320×568, 214 px at 568×320), for a short
// title and a long one.
for (const [width, height, least] of [
  [320, 568, 440],
  [568, 320, 208],
]) {
  for (const track of [{ title: "Bright Lines", artist: "Test Artist" }, LONG]) {
    test(`on a ${width}×${height} phone the Player tab keeps its height (${track.title.length} characters)`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await useMockApi(page, withTrack(track));
      await analyzeAndOpenDashboard(page, "Bright Lines");
      await openPlayer(page);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText(track.title);
      const box = await page.locator("#panel-player").boundingBox();
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(least);
    });
  }
}
