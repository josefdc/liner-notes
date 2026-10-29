import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  apiRequests,
  collectProblems,
  DEMO_SLUG,
  loadFixture,
  openPlayer,
  replayedRecording,
  showcaseRecordings,
  useMockApi,
} from "./mock";
import { cardsCutAtRest, mapAtRest, wholeCardsAtRest } from "./mapAtRest";
import { offline } from "./offline";

// The song-relations map as a lineage (#217): each track a card on a year axis, across the page
// from md up (a full-width row below the columns) and down a phone's tab. On every width, for the
// genealogy-kinds result, every recorded showcase run (fixtures/replays: One More Time on every
// width, the others at 390, 1280, 1440 and 1920 px), a rich map (MusicBrainz years, second
// hops, undated tracks, a 92-character title and a 50-letter word) and a wide one (13 tracks
// over thirty years, a 137-character title):
// - at rest, each card is wholly in the visible map area or wholly out of it (#240);
// - no two cards overlap;
// - no relation is written on the map at rest; a chip names it while a card or a link is pointed
//   at or focused: never over a card, another chip or the detail box, and near its link;
// - every card and link the keyboard reaches is brought into view, clear of the detail box, a
//   card with its year's label; down a phone's tab nothing runs past the panel's sides;
// - from 1280 px no title, artist or year is cut: each wraps (four lines of title, three of
//   artist and year at most, on a wider card where it needs one), a long word broken with a
//   hyphen, inside its card.
// With two relations to the analysed track or fewer the map is a compact row instead, and the
// panel is as tall as it.

// Animations end at once, so what is read is where things stay.
test.use({ reducedMotion: "reduce" });

const ANALYZE = "/api/analyze/stream";
/** How far a chip may lie from its link's middle (map px): CHIP_REACH in GenealogyGraph.tsx. */
const CHIP_REACH = 240;

// Nothing leaves the machine: the recording's cover and any other outside address are answered
// on the page.
test.beforeEach(async ({ page }) => {
  await offline(page);
});

const graphOf = (page: Page) =>
  page.locator('#panel-genealogy svg[aria-label="Connections graph"]');

type Box = { x: number; y: number; right: number; bottom: number };

/**
 * Everything the checks read from the map once the page has settled (two frames: React has drawn
 * the detail box, and the map has placed its chips and its view for it), on screen.
 */
const measure = async (page: Page) => {
  await page.evaluate(
    () =>
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))),
  );
  return graphOf(page).evaluate((svg) => {
    const boxOf = (element: Element | null): Box => {
      const box = (element as Element).getBoundingClientRect();
      return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
    };
    const detail = document.querySelector('[data-testid="link-detail"]');
    const focused = document.activeElement;
    const onMap = focused !== null && svg.contains(focused);
    /** A focused link: the middle of its route (where the view brings it), as a small box. */
    const middleOf = (path: Element): Box => {
      const [x, y] = (path.getAttribute("data-mid") ?? "0,0").split(",").map(Number);
      const matrix = (path as SVGGraphicsElement).getScreenCTM();
      const at = matrix ? new DOMPoint(x, y).matrixTransform(matrix) : new DOMPoint(x, y);
      return { x: at.x - 1, y: at.y - 1, right: at.x + 1, bottom: at.y + 1 };
    };
    return {
      wrapper: boxOf(svg.parentElement),
      detail: detail ? boxOf(detail) : null,
      focused: onMap
        ? focused.matches("g.nodes > g")
          ? { kind: "card", box: boxOf(focused.querySelector("rect.card")) }
          : { kind: "link", box: middleOf(focused) }
        : null,
      cards: [...svg.querySelectorAll("g.nodes > g")].map((card) => ({
        id: card.getAttribute("data-node-id") ?? "",
        box: boxOf(card.querySelector("rect.card")),
      })),
      chips: [...svg.querySelectorAll("g.link-chips g.chip")].map((chip) => {
        const rect = chip.querySelector("rect") as SVGRectElement;
        const [x, y] = (
          /translate\(([-\d.e]+),([-\d.e]+)\)/.exec(chip.getAttribute("transform") ?? "") ?? [
            "",
            "0",
            "0",
          ]
        )
          .slice(1)
          .map(Number);
        const near = chip.getAttribute("data-near")?.split(",").map(Number) ?? null;
        const centre = [
          x + Number(rect.getAttribute("width")) / 2,
          y + Number(rect.getAttribute("height")) / 2,
        ];
        return {
          text: chip.textContent ?? "",
          box: boxOf(rect),
          // How far the chip's centre is from its link's middle, in the map's units.
          reach: near ? Math.hypot(centre[0] - near[0], centre[1] - near[1]) : 0,
        };
      }),
      ticks: [...svg.querySelectorAll("text.year-tick")].map((tick) => ({
        label: tick.textContent ?? "",
        box: boxOf(tick),
      })),
      links: [...svg.querySelectorAll("g.links path")].map((path) => boxOf(path)),
    };
  });
};
type Measure = Awaited<ReturnType<typeof measure>>;

const overlap = (a: Box, b: Box) =>
  a.x < b.right - 0.5 && b.x < a.right - 0.5 && a.y < b.bottom - 0.5 && b.y < a.bottom - 0.5;
const insideX = (box: Box, wrapper: Box) =>
  box.x >= wrapper.x - 0.5 && box.right <= wrapper.right + 0.5;
const inside = (box: Box, wrapper: Box) =>
  insideX(box, wrapper) && box.y >= wrapper.y - 0.5 && box.bottom <= wrapper.bottom + 0.5;

/** The chips drawn now: none over a card, another chip or the detail box, none far from its link. */
function checkChips(now: Measure, what: string) {
  for (const [i, chip] of now.chips.entries()) {
    for (const card of now.cards) {
      expect(overlap(chip.box, card.box), `${what}: chip "${chip.text}" over ${card.id}`).toBe(
        false,
      );
    }
    for (const other of now.chips.slice(i + 1)) {
      expect(overlap(chip.box, other.box), `${what}: chips "${chip.text}", "${other.text}"`).toBe(
        false,
      );
    }
    if (now.detail) {
      expect(overlap(chip.box, now.detail), `${what}: chip "${chip.text}" under the detail`).toBe(
        false,
      );
    }
    expect(chip.reach, `${what}: chip "${chip.text}" far from its link`).toBeLessThanOrEqual(
      CHIP_REACH + 1,
    );
  }
}

/** Each card's words as drawn, against its own title and artist and year. */
const cardWords = (page: Page) =>
  graphOf(page).evaluate((svg) =>
    [...svg.querySelectorAll("g.nodes > g")].map((card) => {
      const right = (card.querySelector("rect.card") as Element).getBoundingClientRect().right;
      const read = (name: string, whole: string | null) => {
        const lines = [...card.querySelectorAll<SVGTSpanElement>(`text.${name} tspan`)];
        // The lines joined back: a space between two lines, none after a hyphen the wrap put in.
        const joined = lines
          .map((line, i) => {
            const text = line.textContent ?? "";
            if (line.hasAttribute("data-hyphen")) return text.slice(0, -1);
            return i < lines.length - 1 ? `${text} ` : text;
          })
          .join("");
        return {
          lines: lines.length,
          cut: lines.some((line) => line.textContent?.includes("…")),
          whole: joined === (whole ?? "").trim().replace(/\s+/g, " "),
          joined,
          past: Math.max(
            -Infinity,
            ...lines.map((line) => line.getBoundingClientRect().right - right),
          ),
        };
      };
      return {
        id: card.getAttribute("data-node-id"),
        title: read("card-title", card.getAttribute("data-title")),
        meta: read("card-meta", card.getAttribute("data-meta")),
        // What the card says is shortened, and the words it says it in.
        shortened: card.getAttribute("data-shortened"),
        said: read("card-shortened", null).joined,
      };
    }),
  );

/** What a card says when words are cut on it (what is cut: its words). */
const SHORTENED: Record<string, string> = {
  title: "Title shortened",
  artist: "Artist shortened",
  "title and artist": "Title and artist shortened",
};

/**
 * Every card's cut words said on it: a card whose title or artist and year ends in "…" says
 * which, in words; one with its words whole says nothing.
 */
async function checkCutsSaid(page: Page, what: string) {
  for (const card of await cardWords(page)) {
    const cut =
      card.title.cut && card.meta.cut
        ? "title and artist"
        : card.title.cut
          ? "title"
          : card.meta.cut
            ? "artist"
            : null;
    expect(card.shortened, `${what}: ${card.id} says what is cut`).toBe(cut);
    expect(card.said, `${what}: ${card.id}'s words for it`).toBe(cut ? SHORTENED[cut] : "");
  }
}

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  const dir = process.env.GENEALOGY_SHOTS_DIR ?? testInfo.project.outputDir;
  mkdirSync(dir, { recursive: true });
  await page.locator("#panel-genealogy").screenshot({ path: join(dir, `lineage-${name}.png`) });
}

type Showcase = {
  open: (page: Page) => Promise<void>;
  /** The tracks on its map: one card each. */
  cards: number;
  widths: ReadonlyArray<readonly [number, number]>;
  /** Two relations or fewer: a compact row, not a canvas. */
  sparse?: boolean;
};

const EVERY_WIDTH = [
  [390, 844],
  [820, 1180],
  [1024, 768],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
] as const;
/** A recorded showcase's widths: a phone, and desktop sizes from 1280 px (the demo: all). */
const RECORDING_WIDTHS = [
  [390, 844],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
] as const;

const SHOWCASES = {
  "genealogy-kinds": {
    open: async (page: Page) => {
      await useMockApi(page, loadFixture("genealogy-kinds"));
      await analyzeAndOpenDashboard(page, "Bright Lines");
      await openPlayer(page);
    },
    cards: 18,
    widths: EVERY_WIDTH,
  },
  rich: {
    open: async (page: Page) => {
      await useMockApi(page, loadFixture("genealogy-rich"));
      await analyzeAndOpenDashboard(page, "Bright Lines");
      await openPlayer(page);
    },
    cards: 16,
    widths: EVERY_WIDTH,
  },
  wide: {
    open: async (page: Page) => {
      await useMockApi(page, loadFixture("genealogy-wide"));
      await analyzeAndOpenDashboard(page, "Bright Lines");
      await openPlayer(page);
    },
    cards: 13,
    widths: EVERY_WIDTH,
  },
} satisfies Record<string, Showcase>;

/** Each committed showcase recording, replayed as the API serves it. */
const RECORDED: Record<string, Showcase> = Object.fromEntries(
  showcaseRecordings().map(({ slug, query, nodes, links }) => [
    slug,
    {
      open: async (page: Page) => {
        const { events } = replayedRecording(slug);
        await useMockApi(page, { suggestions: [], eventGapMs: 0, streams: { [ANALYZE]: events } });
        await analyzeAndOpenDashboard(page, query);
        await openPlayer(page);
      },
      cards: nodes,
      widths: slug === DEMO_SLUG ? EVERY_WIDTH : RECORDING_WIDTHS,
      sparse: links <= 2,
    },
  ]),
);

const SHOWN: Record<string, Showcase> = { ...SHOWCASES, ...RECORDED };

/** The band the Player's panel heading lays over the top of the map. */
const headingBand = (page: Page) =>
  page
    .locator("#panel-genealogy > div")
    .filter({ has: page.getByRole("heading", { name: "Connections" }) });

for (const [showcase, { open, cards: cardCount, widths, sparse }] of Object.entries(SHOWN)) {
  for (const [width, height] of widths) {
    const vertical = width < 768;
    if (sparse) {
      test(`at ${width} px the ${showcase} map is a compact row of cards, apart and inside its panel`, async ({
        page,
      }, testInfo) => {
        const problems = collectProblems(page);
        await page.setViewportSize({ width, height });
        await open(page);
        if (vertical) await page.getByRole("tab", { name: "Connections" }).click();
        const panel = page.locator("#panel-genealogy");
        const row = panel.getByTestId("lineage-row");
        await expect(row).toBeVisible();
        const cards = row.locator("[data-lineage-card]");
        await expect(cards).toHaveCount(cardCount);
        const box = await panel.boundingBox();
        const boxes = await cards.evaluateAll((all) =>
          all.map((card) => {
            const b = card.getBoundingClientRect();
            return { x: b.x, y: b.y, right: b.right, bottom: b.bottom };
          }),
        );
        if (!box) throw new Error("no panel");
        const wrapper = {
          x: box.x,
          y: box.y,
          right: box.x + box.width,
          bottom: box.y + box.height,
        };
        for (const [i, card] of boxes.entries()) {
          expect(insideX(card, wrapper), `card ${i} past the panel`).toBe(true);
          for (const other of boxes.slice(i + 1)) {
            expect(overlap(card, other), `cards ${i} and another`).toBe(false);
          }
        }
        await screenshot(page, testInfo, `${showcase}-${width}`);
        expect(problems).toEqual([]);
      });
      continue;
    }
    test(`at ${width} px the ${showcase} map keeps cards, chips and the focused item apart and in view${width >= 1280 ? ", and cuts no words" : ""}`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(240_000);
      const problems = collectProblems(page);
      await page.setViewportSize({ width, height });
      await open(page);
      if (vertical) await page.getByRole("tab", { name: "Connections" }).click();
      const graph = graphOf(page);
      await expect(graph.locator("g.nodes > g")).toHaveCount(cardCount);
      await graph.scrollIntoViewIfNeeded();
      // The pointer off the map: at rest, nothing is pointed at.
      await page.mouse.move(0, 0);
      await page.evaluate(async () => {
        await document.fonts.ready;
      });

      // At rest each card is wholly in view or wholly out of it, and some are in view.
      await mapAtRest(graph);
      expect(await cardsCutAtRest(graph, headingBand(page)), "cards cut at rest").toEqual([]);
      expect(await wholeCardsAtRest(graph, headingBand(page))).toBeGreaterThan(0);
      // No word is cut unsaid.
      await checkCutsSaid(page, `${showcase} at ${width} px`);

      // The axis: across the page from md up, down a phone's tab.
      const rest = await measure(page);
      const [first, second] = rest.ticks;
      if (vertical) expect(second.box.y).toBeGreaterThan(first.box.y);
      else expect(second.box.x).toBeGreaterThan(first.box.x);
      // Cards never meet; no chip at rest.
      for (const [i, card] of rest.cards.entries()) {
        for (const other of rest.cards.slice(i + 1)) {
          expect(overlap(card.box, other.box), `${card.id} and ${other.id}`).toBe(false);
        }
      }
      expect(rest.chips).toEqual([]);
      await screenshot(page, testInfo, `${showcase}-${width}`);

      // Every card pointed at: its chips apart from cards, chips and the detail box, near links.
      let chipsShown = 0;
      const tracks = graph.locator("g.nodes > g");
      for (let i = 0; i < cardCount; i += 1) {
        await tracks.nth(i).dispatchEvent("mouseenter");
        const now = await measure(page);
        chipsShown += now.chips.length;
        checkChips(now, `card ${i}`);
        // The detail box never covers the card pointed at: it goes to the top when the card is
        // low in the view.
        const pointed = now.cards[i];
        if (now.detail && inside(pointed.box, now.wrapper)) {
          expect(overlap(pointed.box, now.detail), `card ${i} under its detail`).toBe(false);
        }
        if (i === 0) await screenshot(page, testInfo, `${showcase}-${width}-hover-first`);
        await tracks.nth(i).dispatchEvent("mouseleave");
      }

      // The keyboard through every card and link: the focused item in view, clear of the detail
      // box; down a phone's tab, the axis's labels, the cards and the links inside the panel.
      await tracks.first().focus();
      const total = cardCount + (await graph.locator("g.link-targets path").count());
      for (let i = 0; i < total; i += 1) {
        const now = await measure(page);
        chipsShown += now.chips.length;
        checkChips(now, `item ${i}`);
        const focused = now.focused;
        expect(focused, `item ${i} focused`).not.toBeNull();
        if (!focused) break;
        expect(inside(focused.box, now.wrapper), `item ${i} in view`).toBe(true);
        if (now.detail) {
          expect(overlap(focused.box, now.detail), `item ${i} under the detail`).toBe(false);
        }
        if (vertical) {
          for (const tick of now.ticks) {
            expect(insideX(tick.box, now.wrapper), `item ${i}: label ${tick.label} cut`).toBe(true);
          }
          for (const card of now.cards) {
            expect(insideX(card.box, now.wrapper), `item ${i}: card ${card.id} cut`).toBe(true);
          }
          for (const link of now.links) {
            expect(insideX(link, now.wrapper), `item ${i}: a link past the panel`).toBe(true);
          }
        } else if (focused.kind === "card") {
          // The year's label above the card is in view with it.
          const label = now.ticks.find(
            (tick) => tick.box.right > focused.box.x && tick.box.x < focused.box.right,
          );
          expect(
            label !== undefined && inside(label.box, now.wrapper),
            `item ${i}: its year in view`,
          ).toBe(true);
        }
        if (i === cardCount) await screenshot(page, testInfo, `${showcase}-${width}-focus-link`);
        await page.keyboard.press("ArrowRight");
      }
      expect(chipsShown).toBeGreaterThan(0);

      // From 1280 px, every title and every artist and year is drawn whole, inside its card.
      if (width >= 1280) {
        for (const card of await cardWords(page)) {
          for (const [part, words, most] of [
            ["title", card.title, 4],
            ["artist and year", card.meta, 3],
          ] as const) {
            expect(words.cut, `${card.id}'s ${part} cut`).toBe(false);
            expect(words.whole, `${card.id}'s ${part} whole: ${words.joined}`).toBe(true);
            expect(words.lines, `${card.id}'s ${part} lines`).toBeLessThanOrEqual(most);
            expect(words.past, `${card.id}'s ${part} past its card`).toBeLessThanOrEqual(0);
          }
        }
      }
      expect(problems).toEqual([]);
    });
  }
}

test("a long title and a long word are read whole, in the card's name and its detail", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await SHOWCASES.rich.open(page);
  const graph = graphOf(page);
  await graph.scrollIntoViewIfNeeded();
  const title =
    "Here Comes the Hotstepper (Heartical Mix) [feat. Somebody Else and the Very Long Collective]";
  const name = `${title} by Ini Kamoze & The Very Long Collective (1994)`;
  const long = graph.locator('g.nodes > g[data-node-id="s1"]');
  expect((await long.getAttribute("aria-label"))?.startsWith(`${name}:`)).toBe(true);
  await long.focus();
  const detail = page.getByTestId("link-detail");
  await expect(detail).toContainText(name);
  // Nothing in the detail box is cut: it is as tall as its words.
  expect(await detail.evaluate((box) => box.scrollHeight <= box.clientHeight + 1)).toBe(true);
  // The 50-letter word wraps with a hyphen, and its card's name has it whole.
  const word = graph.locator('g.nodes > g[data-node-id="d3"]');
  expect(await word.getAttribute("aria-label")).toMatch(
    /^Supercalifragilisticexpialidociouslyremixedforever by Remixer \(2016\):/,
  );
  expect(await word.locator("text.card-title tspan[data-hyphen]").count()).toBeGreaterThan(0);
});

/** The wide map's remix, its title 137 characters long. */
const LONG_TITLE =
  "Bright Lines (Candyland OG Version) (Tarraxa Remixed By DJ Somebody Famous Feat Cristian " +
  "Kizomba and the Very Long Collective) [Extended]";

for (const [width, height] of [
  [390, 844],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
] as const) {
  test(`at ${width} px a 137-character title is ${width >= 1280 ? "whole on its card" : "cut on its card and says so"}, and whole in its name, its detail and its panel`, async ({
    page,
  }, testInfo) => {
    const problems = collectProblems(page);
    expect(LONG_TITLE.length).toBeGreaterThanOrEqual(120);
    await page.setViewportSize({ width, height });
    await SHOWCASES.wide.open(page);
    if (width < 768) await page.getByRole("tab", { name: "Connections" }).click();
    const graph = graphOf(page);
    await expect(graph.locator("g.nodes > g")).toHaveCount(SHOWCASES.wide.cards);
    const card = graph.locator('g.nodes > g[data-node-id="d1"]');
    const name = `${LONG_TITLE} by DJ Somebody Famous (2006)`;
    expect((await card.getAttribute("aria-label"))?.startsWith(`${name}:`)).toBe(true);

    // Brought into view by the keyboard (the pointer off the map): its words, and what it says
    // is cut.
    await page.mouse.move(0, 0);
    await card.focus();
    const words = (await cardWords(page)).find((each) => each.id === "d1");
    if (!words) throw new Error("no card d1");
    if (width >= 1280) {
      // Whole, on a card wide enough for it in four lines, inside the card; nothing said cut.
      expect(words.title.cut).toBe(false);
      expect(words.title.whole, words.title.joined).toBe(true);
      expect(words.title.lines).toBeLessThanOrEqual(4);
      expect(words.title.past).toBeLessThanOrEqual(0);
      expect(words.shortened).toBeNull();
    } else {
      // A phone's column has no room for it in four lines: cut, and the card says so, in view.
      expect(words.title.cut).toBe(true);
      expect(words.shortened).toBe("title");
      expect(words.said).toBe("Title shortened");
      const [cardBox, saidBox] = await Promise.all([
        card.locator("rect.card").boundingBox(),
        card.locator("text.card-shortened").boundingBox(),
      ]);
      if (!cardBox || !saidBox) throw new Error("no card or no words for the cut");
      expect(saidBox.x).toBeGreaterThanOrEqual(cardBox.x);
      expect(saidBox.x + saidBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
      expect(saidBox.y + saidBox.height).toBeLessThanOrEqual(cardBox.y + cardBox.height);
      await expect(card.locator("text.card-shortened")).toBeVisible();
    }
    await screenshot(page, testInfo, `long-title-${width}`);

    // One step away, whole: the detail box of the focused card, and its panel once selected.
    await expect(page.getByTestId("link-detail")).toContainText(name);
    await page.keyboard.press("Enter");
    const panel = page.getByTestId("node-detail");
    await expect(panel.getByRole("heading", { name: LONG_TITLE, exact: true })).toBeVisible();
    expect(problems).toEqual([]);
  });
}

test("a resize at rest shows the first view for the new room, cutting no card; the reader's view is kept", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await SHOWCASES.wide.open(page);
  const graph = graphOf(page);
  await expect(graph.locator("g.nodes > g")).toHaveCount(SHOWCASES.wide.cards);
  const view = () => graph.locator(":scope > g").evaluate((g) => g.getAttribute("transform") ?? "");
  // Wider, narrower, then shorter: each time the first view, from the earliest year.
  for (const [width, height] of [
    [1440, 900],
    [1920, 1080],
    [1280, 800],
    [1366, 700],
  ] as const) {
    await page.setViewportSize({ width, height });
    await mapAtRest(graph);
    // (Polled: the map is laid out for the new room once the browser reports its size.)
    await expect
      .poll(() => cardsCutAtRest(graph, headingBand(page)), { message: `at ${width}×${height}` })
      .toEqual([]);
    expect(await wholeCardsAtRest(graph, headingBand(page))).toBeGreaterThan(0);
    const first = await graph
      .locator("text.year-tick")
      .first()
      .evaluate((tick) => tick.getBoundingClientRect().left);
    expect(first, `at ${width}×${height}: the earliest year in view`).toBeGreaterThanOrEqual(0);
  }
  // The reader moves the view (the keyboard brings the last card in): a resize keeps it.
  await graph.locator('g.nodes > g[data-node-id="h4"]').focus();
  await graph.locator('g.nodes > g[data-node-id="h4"]').blur();
  const moved = await view();
  await graph.locator(":scope > g").evaluate((g) => g.setAttribute("data-kept", ""));
  await page.setViewportSize({ width: 1280, height: 760 });
  await expect.poll(view).not.toBe(moved);
  await expect(graph.locator(":scope > g[data-kept]")).toHaveCount(1);
  expect(problems).toEqual([]);
});

test("a narrower phone lays the map out again, keeping the reader's place, inside the panel", async ({
  page,
}) => {
  await page.setViewportSize({ width: 700, height: 900 });
  await SHOWCASES.rich.open(page);
  await page.getByRole("tab", { name: "Connections" }).click();
  const graph = graphOf(page);
  await expect(graph.locator("g.nodes > g")).toHaveCount(16);
  // The reader moves down the map: the last card brought into view.
  await graph.locator("g.nodes > g").last().focus();
  await graph.locator("g.nodes > g").last().blur();
  const view = () =>
    graph.locator(":scope > g").evaluate((g) => {
      const match = /translate\(([-\d.e]+),([-\d.e]+)\)/.exec(g.getAttribute("transform") ?? "");
      return { x: Number(match?.[1]), y: Number(match?.[2]) };
    });
  const before = await view();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect.poll(async () => (await measure(page)).wrapper.right).toBeLessThanOrEqual(391);
  const now = await measure(page);
  // Laid out again for the narrower panel, the reader's place down the map kept.
  expect((await view()).y).toBe(before.y);
  for (const card of now.cards) {
    expect(insideX(card.box, now.wrapper), `card ${card.id} cut`).toBe(true);
  }
  for (const tick of now.ticks) {
    expect(insideX(tick.box, now.wrapper), `label ${tick.label} cut`).toBe(true);
  }
});

test("from md up a Connections button in the header takes the keyboard to the map", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await SHOWCASES["genealogy-kinds"].open(page);
  const panel = page.locator("#panel-genealogy");
  // Far below the first view: the two columns come first.
  const below = await panel.evaluate((element) => element.getBoundingClientRect().top);
  expect(below).toBeGreaterThan(900);
  // From the track's heading, the button is a few Tab presses on, in the header.
  await page.getByRole("heading", { level: 1 }).focus();
  const link = page.locator("#player-header").getByRole("button", { name: "Connections" });
  for (let i = 0; i < 10 && !(await link.evaluate((a) => a === document.activeElement)); i += 1) {
    await page.keyboard.press("Tab");
  }
  await expect(link).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(panel).toBeFocused();
  // Where the focus went shows: the panel's ring.
  expect(await panel.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
  await expect
    .poll(() => panel.evaluate((element) => Math.round(element.getBoundingClientRect().top)))
    .toBeLessThan(300);
  // The next Tab goes into the map.
  await page.keyboard.press("Tab");
  await expect(page.locator("#panel-genealogy g.nodes > g").first()).toBeFocused();
});

test("one relation to the track with several second hops is drawn, not a compact row", async ({
  page,
}) => {
  const fixture = loadFixture("genealogy-rich");
  const complete = fixture.streams[ANALYZE].find(
    (event: { type: string }) => event.type === "complete",
  );
  const genealogy = complete.data.genealogy as {
    nodes: Array<{ id: string }>;
    links: Array<{ source: string; target: string }>;
  };
  // Funky Drummer feeds this track; Public Enemy and N.W.A sample it too, and each other.
  const keep = new Set(["current", "s2", "h1", "h2"]);
  genealogy.nodes = genealogy.nodes.filter((node) => keep.has(node.id));
  genealogy.links = genealogy.links.filter(
    (link) => keep.has(link.source) && keep.has(link.target),
  );
  expect(
    genealogy.links.filter((l) => l.source === "current" || l.target === "current"),
  ).toHaveLength(1);
  expect(genealogy.links.length).toBeGreaterThan(2);
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, fixture);
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  await expect(graphOf(page).locator("g.nodes > g")).toHaveCount(4);
  await expect(page.locator('#panel-genealogy [data-testid="lineage-row"]')).toHaveCount(0);
  await expect(page.getByTestId("axis-note")).toHaveText("Years in order, not to scale.");
});

/** The genealogy-kinds result with only its first `count` relations to the analysed track. */
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
    // From md up the connections are a row of their own below the columns.
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
    // Its tracks are toggle buttons that select them (their details open under the row), named
    // with their relation for screen readers.
    const sample = row.getByRole("button", {
      name: /^Sourced Sample - Someone \(1984\): Bright Lines/,
    });
    await expect(sample).toBeVisible();
    await screenshot(page, testInfo, `compact-${count}`);
    // A click selects it: its details open under the row, with the focus; nothing is analysed.
    await sample.click();
    await expect(sample).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByTestId("node-detail")).toBeFocused();
    expect(
      (await apiRequests(page)).filter((entry) => entry.startsWith(`stream ${ANALYZE}?`)),
    ).toHaveLength(1);
    await page.keyboard.press("Escape");
    await expect(panel.getByTestId("node-detail")).toHaveCount(0);
    await expect(sample).toBeFocused();
    expect(problems).toEqual([]);
  });
}
