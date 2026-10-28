import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  loadFixture,
  openPlayer,
  replayedRecording,
  useMockApi,
} from "./mock";
import { offline } from "./offline";

// The song-relations map as a lineage (#217): each track a card on a year axis. On every width
// the map is drawn at (a phone, the xl column at 1280, 1440 and 1920 px), for the genealogy-kinds
// result and the recorded One More Time run:
// - no two cards overlap;
// - no relation is written on the map at rest; a chip names it while a card or a link is pointed
//   at or focused, and a chip never lies over a card;
// - from 1280 px no title, artist or year is cut: each wraps to two lines at most, inside its
//   card.
// With two relations or fewer the map is a compact row instead, and the panel is as tall as it.

// Animations end at once, so what is read is where things stay.
test.use({ reducedMotion: "reduce" });

const ANALYZE = "/api/analyze/stream";

// Nothing leaves the machine: the recording's cover and any other outside address are answered
// on the page.
test.beforeEach(async ({ page }) => {
  await offline(page);
});

const graphOf = (page: Page) =>
  page.locator('#panel-genealogy svg[aria-label="Connections graph"]');

type Box = { x: number; y: number; right: number; bottom: number };
const overlap = (a: Box, b: Box) =>
  a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;

/** The cards on screen, and the chips drawn now. */
const drawn = (page: Page) =>
  graphOf(page).evaluate((svg) => {
    const boxOf = (element: Element | null): Box => {
      const box = (element as Element).getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
    };
    return {
      cards: [...svg.querySelectorAll("g.nodes > g")].map((card) => ({
        id: card.getAttribute("data-node-id") ?? "",
        box: boxOf(card.querySelector("rect.card")),
      })),
      chips: [...svg.querySelectorAll("g.link-chips g.chip")].map((chip) => ({
        text: chip.textContent ?? "",
        box: boxOf(chip.querySelector("rect")),
      })),
    };
  });

/**
 * Each card's words as drawn, against the card's own title and artist and year: whether a line
 * was cut ("…"), whether every word is drawn, how many lines each takes, and how far the
 * longest line runs past the card's right edge (px; at most 0 when it fits).
 */
const cardWords = (page: Page) =>
  graphOf(page).evaluate((svg) =>
    [...svg.querySelectorAll("g.nodes > g")].map((card) => {
      const right = (card.querySelector("rect.card") as Element).getBoundingClientRect().right;
      const lines = (name: string) => [
        ...card.querySelectorAll<SVGTSpanElement>(`text.${name} tspan`),
      ];
      const words = (text: string | null) => (text ?? "").replace(/\s+/g, "");
      const read = (name: string, whole: string | null) => {
        const drawnLines = lines(name);
        return {
          lines: drawnLines.length,
          cut: drawnLines.some((line) => line.textContent?.includes("…")),
          whole: words(drawnLines.map((line) => line.textContent).join("")) === words(whole),
          past: Math.max(
            -Infinity,
            ...drawnLines.map((line) => line.getBoundingClientRect().right - right),
          ),
        };
      };
      return {
        id: card.getAttribute("data-node-id"),
        title: read("card-title", card.getAttribute("data-title")),
        meta: read("card-meta", card.getAttribute("data-meta")),
      };
    }),
  );

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const dir = process.env.GENEALOGY_SHOTS_DIR ?? testInfo.project.outputDir;
  mkdirSync(dir, { recursive: true });
  await page.locator("#panel-genealogy").screenshot({ path: join(dir, `lineage-${name}.png`) });
}

const SHOWCASES = {
  "genealogy-kinds": {
    open: async (page: Page) => {
      await useMockApi(page, loadFixture("genealogy-kinds"));
      await analyzeAndOpenDashboard(page, "Bright Lines");
      await openPlayer(page);
    },
    cards: 18,
  },
  "one-more-time": {
    open: async (page: Page) => {
      const { events } = replayedRecording();
      await useMockApi(page, { suggestions: [], eventGapMs: 0, streams: { [ANALYZE]: events } });
      await analyzeAndOpenDashboard(page, "One More Time Daft Punk");
      await openPlayer(page);
    },
    cards: 10,
  },
} as const;

for (const [showcase, { open, cards: cardCount }] of Object.entries(SHOWCASES)) {
  for (const [width, height] of [
    [390, 844],
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    test(`at ${width} px the ${showcase} map has no card over a card and no chip over a card${width >= 1280 ? ", and cuts no words" : ""}`, async ({
      page,
    }, testInfo) => {
      test.slow();
      const problems = collectProblems(page);
      await page.setViewportSize({ width, height });
      await open(page);
      if (width < 768) await page.getByRole("tab", { name: "Connections" }).click();
      const graph = graphOf(page);
      await expect(graph.locator("g.nodes > g")).toHaveCount(cardCount);
      await page.evaluate(async () => {
        await document.fonts.ready;
      });

      // Cards never meet; no chip at rest.
      const rest = await drawn(page);
      for (const [i, card] of rest.cards.entries()) {
        for (const other of rest.cards.slice(i + 1)) {
          expect(overlap(card.box, other.box), `${card.id} and ${other.id}`).toBe(false);
        }
      }
      expect(rest.chips).toEqual([]);
      await screenshot(page, testInfo, `${showcase}-${width}`);

      // A chip, on hover of a card or focus of a link, never lies over a card.
      let chipsShown = 0;
      const checkChips = async (what: string) => {
        const now = await drawn(page);
        chipsShown += now.chips.length;
        for (const chip of now.chips) {
          for (const card of now.cards) {
            expect(
              overlap(chip.box, card.box),
              `${what}: chip "${chip.text}" over ${card.id}`,
            ).toBe(false);
          }
        }
      };
      const tracks = graph.locator("g.nodes > g");
      for (let i = 0; i < cardCount; i += 1) {
        await tracks.nth(i).dispatchEvent("mouseenter");
        await checkChips(`card ${i}`);
        await tracks.nth(i).dispatchEvent("mouseleave");
      }
      const targets = graph.locator("g.link-targets path");
      for (let i = 0; i < (await targets.count()); i += 1) {
        await targets.nth(i).focus();
        await checkChips(`link ${i}`);
        if (i === 0) await screenshot(page, testInfo, `${showcase}-${width}-focus`);
      }
      await targets.last().blur();
      await expect(graph.locator("g.link-chips g.chip")).toHaveCount(0);
      expect(chipsShown).toBeGreaterThan(0);

      // From 1280 px, every title and every artist and year is drawn whole, in two lines at
      // most, inside its card.
      if (width >= 1280) {
        for (const card of await cardWords(page)) {
          for (const [part, words] of [
            ["title", card.title],
            ["artist and year", card.meta],
          ] as const) {
            expect(words.cut, `${card.id}'s ${part} cut`).toBe(false);
            expect(words.whole, `${card.id}'s ${part} whole`).toBe(true);
            expect(words.lines, `${card.id}'s ${part} lines`).toBeLessThanOrEqual(2);
            expect(words.past, `${card.id}'s ${part} past its card`).toBeLessThanOrEqual(0);
          }
        }
      }
      expect(problems).toEqual([]);
    });
  }
}

/** The full result with only the first `count` of the genealogy-kinds relations. */
function withRelations(count: number) {
  const fixture = loadFixture("genealogy-kinds");
  const complete = fixture.streams[ANALYZE].find(
    (event: { type: string }) => event.type === "complete",
  );
  const genealogy = complete.data.genealogy as {
    nodes: Array<{ id: string }>;
    links: Array<{ source: string; target: string }>;
  };
  genealogy.links = genealogy.links.slice(0, count);
  const kept = new Set(genealogy.links.flatMap((link) => [link.source, link.target]));
  genealogy.nodes = genealogy.nodes.filter((node) => kept.has(node.id));
  return fixture;
}

for (const count of [1, 2]) {
  test(`with ${count} relation${count === 1 ? "" : "s"} the map is a compact row, and its panel is as tall as it`, async ({
    page,
  }, testInfo) => {
    const problems = collectProblems(page);
    // From md up to xl the connections are a row of their own below the columns.
    await page.setViewportSize({ width: 1024, height: 900 });
    await useMockApi(page, withRelations(count));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    const panel = page.locator("#panel-genealogy");
    const row = panel.getByTestId("lineage-row");
    await expect(row).toBeVisible();
    await expect(panel.locator('svg[aria-label="Connections graph"]')).toHaveCount(0);
    await expect(row.locator("[data-lineage-card]")).toHaveCount(count + 1);
    // Each relation in the words the cards and the list use, between its two tracks.
    await expect(row.locator("[data-relation-chip]")).toHaveText(
      ["Sample→", "Interpolation→"].slice(0, count),
    );
    await expect(row.locator('[data-lineage-card="current"]')).toContainText("This track");
    // The panel holds its content and no more: no empty canvas below it.
    const fit = await panel.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const content = [...element.children].reduce(
        (bottom, child) => Math.max(bottom, child.getBoundingClientRect().bottom),
        box.top,
      );
      return { height: box.height, gap: box.bottom - content };
    });
    expect(fit.gap).toBeLessThanOrEqual(2);
    expect(fit.height).toBeLessThan(900 - 224);
    // Its tracks are buttons that analyse them, named with their relation for screen readers.
    await expect(
      row.getByRole("button", { name: /^Sourced Sample - Someone \(1984\): Bright Lines/ }),
    ).toBeVisible();
    await screenshot(page, testInfo, `compact-${count}`);
    expect(problems).toEqual([]);
  });
}
