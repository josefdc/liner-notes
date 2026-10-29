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
import {
  analysedAtRest,
  cardsCutAtRest,
  cardsInView,
  edgeCuesAtRest,
  labelsOverEmptyColumns,
  mapAtRest,
  wholeCardsAtRest,
} from "./mapAtRest";
import { offline } from "./offline";

// The song-relations map as a lineage (#217): each track a card on a year axis, across the page
// from md up (a full-width row below the columns) and down a phone's tab. On every width, for the
// genealogy-kinds result, every recorded showcase run (fixtures/replays: One More Time on every
// width, the others at 390, 1280, 1440 and 1920 px), a rich map (MusicBrainz years, second
// hops, undated tracks, a 92-character title and a 50-letter word) and a wide one (13 tracks
// over thirty years, a 137-character title):
// - at rest, each card is wholly in the visible map area or wholly out of it, the analysed
//   track's card in it, and no year's label over a column with no card in view (#240);
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
      const year = card.getAttribute("data-year");
      const read = (name: string, whole: string | null) => {
        const lines = [...card.querySelectorAll<SVGTSpanElement>(`text.${name} tspan`)];
        // The lines joined back: a space between two lines where the words had one (none
        // between two lines of CJK text, broken between its characters), none after a hyphen
        // the wrap put in. The card's own " · " before the year (the artist line's last one)
        // is left out where a line breaks at it, and never starts a line; any other "·" is the
        // record's, drawn as it is.
        const record = (whole ?? "").trim().replace(/\s+/g, " ");
        const separatorAt =
          name === "card-meta" && year && record.endsWith(` · ${year}`)
            ? record.length - ` · ${year}`.length
            : -1;
        let joined = "";
        let separatorStarts = false;
        lines.forEach((line, i) => {
          const text = line.textContent ?? "";
          const hyphen = line.hasAttribute("data-hyphen");
          joined += hyphen ? text.slice(0, -1) : text;
          const next = lines[i + 1]?.textContent?.[0] ?? "";
          if (i < lines.length - 1 && !hyphen) {
            if (joined.length === separatorAt) {
              if (next === "·") separatorStarts = true;
              joined += next === "·" ? " " : " · ";
            } else if (!record.startsWith(`${joined}${next}`)) joined += " ";
          }
        });
        return {
          lines: lines.length,
          cut: lines.some((line) => line.textContent?.includes("…")),
          whole: !separatorStarts && joined === record,
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
        year,
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
  "artist and year": "Artist and year shortened",
  "title and artist": "Title and artist shortened",
  "title, artist and year": "Title, artist and year shortened",
};

/**
 * Every card's cut words said on it: a card whose title or artist and year ends in "…" says
 * which, in words (the year too where the cut line ended with it); one with its words whole
 * says nothing.
 */
async function checkCutsSaid(page: Page, what: string) {
  for (const card of await cardWords(page)) {
    const artist = card.year ? "artist and year" : "artist";
    const cut =
      card.title.cut && card.meta.cut
        ? card.year
          ? "title, artist and year"
          : "title and artist"
        : card.title.cut
          ? "title"
          : card.meta.cut
            ? artist
            : null;
    expect(card.shortened, `${what}: ${card.id} says what is cut`).toBe(cut);
    expect(card.said, `${what}: ${card.id}'s words for it`).toBe(cut ? SHORTENED[cut] : "");
  }
}

/**
 * Across the page, the line that says the years are in order, not to scale: in the window, in
 * the map's box over its year labels, just above them.
 */
async function checkAxisNote(page: Page) {
  const note = page.locator("#panel-genealogy").getByTestId("axis-note");
  await expect(note).toHaveText("Years in order, not to scale.");
  await expect(note).toBeInViewport();
  const [box, wrapper, tick] = await Promise.all([
    note.boundingBox(),
    graphOf(page).evaluate((svg) => {
      const box = (svg.parentElement as Element).getBoundingClientRect();
      return { top: box.top, bottom: box.bottom };
    }),
    graphOf(page)
      .locator("text.year-tick")
      .evaluateAll((ticks) => Math.min(...ticks.map((tick) => tick.getBoundingClientRect().top))),
  ]);
  if (!box) throw new Error("no axis note");
  expect(box.y).toBeGreaterThanOrEqual(wrapper.top);
  expect(box.y + box.height, "over the year labels").toBeLessThanOrEqual(tick + 1);
  expect(tick - (box.y + box.height), "just above the year labels").toBeLessThanOrEqual(40);
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
/** The showcases drawn as a map (more than two relations), not a compact row. */
const DRAWN = Object.fromEntries(Object.entries(SHOWN).filter(([, { sparse }]) => !sparse));

/**
 * The cards main's first view showed whole at rest on the rich map in the Player's panel (at
 * 390x844, 1280x800, 1440x900 and 1920x1080), counted before #240: the first view shows at
 * least as many.
 */
const MAIN_WHOLE_RICH: Partial<Record<number, number>> = { 390: 4, 1280: 2, 1440: 2, 1920: 5 };

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
      const before = showcase === "rich" ? MAIN_WHOLE_RICH[width] : undefined;
      if (before !== undefined) {
        expect(
          await wholeCardsAtRest(graph, headingBand(page)),
          "cards whole at rest, against main's first view",
        ).toBeGreaterThanOrEqual(before);
      }
      expect(await analysedAtRest(graph, headingBand(page)), "the analysed track at rest").toBe(
        "in",
      );
      expect(await labelsOverEmptyColumns(graph, headingBand(page))).toEqual([]);
      // Across the page, "not to scale" is said over the axis, in view at rest.
      if (!vertical) await checkAxisNote(page);
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

/** `from` to `to` (both kept) in steps of `step`. */
const steps = (from: number, to: number, step: number) =>
  Array.from({ length: Math.floor((from - to) / step) + 1 }, (_, i) => from - i * step);

/** The window sizes a resize at rest is swept over (#240), from where each sweep starts. */
const SWEEPS = {
  width: { start: [1440, 900], sizes: steps(1900, 1000, 37).map((w) => [w, 900]) },
  height: { start: [1440, 900], sizes: steps(1000, 560, 23).map((h) => [1440, h]) },
  phone: { start: [390, 844], sizes: steps(900, 560, 17).map((h) => [390, h]) },
} as const;

/** Each card's place and size on the map (map px, the drawing's own units), by id. */
const cardPlaces = (page: Page) =>
  graphOf(page).evaluate((svg) =>
    [...svg.querySelectorAll("g.nodes > g")]
      .map((card) => {
        const rect = card.querySelector("rect.card") as Element;
        return `${card.getAttribute("data-node-id")} ${card.getAttribute("transform")} ${rect.getAttribute("width")}x${rect.getAttribute("height")}`;
      })
      .join("\n"),
  );

for (const [showcase, { open, cards: cardCount }] of Object.entries(DRAWN)) {
  for (const [sweep, { start, sizes }] of Object.entries(SWEEPS)) {
    test(`a ${sweep} sweep at rest keeps the ${showcase} map's first view: no card cut, the analysed track in view, the drawing kept while no card moves`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      const problems = collectProblems(page);
      // The pointer off the map before it is drawn: at rest, nothing is pointed at.
      await page.mouse.move(0, 0);
      await page.setViewportSize({ width: start[0], height: start[1] });
      await open(page);
      await page.mouse.move(0, 0);
      if (sweep === "phone") await page.getByRole("tab", { name: "Connections" }).click();
      const graph = graphOf(page);
      await expect(graph.locator("g.nodes > g")).toHaveCount(cardCount);
      await mapAtRest(graph);
      const drawing = graph.locator(":scope > g");
      await drawing.evaluate((g) => g.setAttribute("data-kept", ""));
      let places = await cardPlaces(page);
      // The sizes the map's drawing takes in a step: the page around it may settle in two
      // (the legend's lines that a short window hides), each a room of its own.
      await graph.evaluate((svg) => {
        const sizes: string[] = [];
        (window as unknown as { mapSizes: string[] }).mapSizes = sizes;
        new MutationObserver(() => {
          const size = `${svg.getAttribute("width")}x${svg.getAttribute("height")}`;
          if (sizes.at(-1) !== size) sizes.push(size);
        }).observe(svg, { attributes: true, attributeFilter: ["width", "height"] });
      });
      for (const [width, height] of sizes) {
        const at = `${showcase} at ${width}×${height}`;
        await page.evaluate(() => {
          (window as unknown as { mapSizes: string[] }).mapSizes.length = 0;
        });
        await page.setViewportSize({ width, height });
        await mapAtRest(graph);
        // (Polled: the map is laid out for the new room once the browser reports its size.)
        await expect
          .poll(() => cardsCutAtRest(graph, headingBand(page)), { message: `${at}: cut cards` })
          .toEqual([]);
        expect(await analysedAtRest(graph, headingBand(page)), `${at}: the analysed track`).toBe(
          "in",
        );
        await expect(graph, `${at}: still the first view`).toHaveAttribute("data-view", "first");
        // Laid out again only when a card moves: no card moved, the same drawing (unless the
        // map took a room in between).
        const now = await cardPlaces(page);
        const rooms = await page.evaluate(
          () => (window as unknown as { mapSizes: string[] }).mapSizes.length,
        );
        if (now === places && rooms <= 1) {
          await expect(graph.locator(":scope > g[data-kept]"), `${at}: drawn again`).toHaveCount(1);
        } else {
          places = now;
          await drawing.evaluate((g) => g.setAttribute("data-kept", ""));
        }
      }
      expect(problems).toEqual([]);
    });
  }
}

/** The wide map's card with a Japanese title and artist (wide characters: two cells each). */
const CJK_TITLE =
  "夜明けの街角で踊る二人の物語（シティポップ・リミックス・エクステンデッド・バージョン）〜真夜中のサウンドトラック・スペシャル・エディション〜";

for (const [width, height] of [
  [390, 844],
  [1280, 800],
] as const) {
  test(`at ${width} px a Japanese title stays inside its card, ${width >= 1280 ? "whole" : "cut and said so"}`, async ({
    page,
  }) => {
    await page.mouse.move(0, 0);
    await page.setViewportSize({ width, height });
    await SHOWCASES.wide.open(page);
    if (width < 768) await page.getByRole("tab", { name: "Connections" }).click();
    const graph = graphOf(page);
    await expect(graph.locator("g.nodes > g")).toHaveCount(SHOWCASES.wide.cards);
    const card = graph.locator('g.nodes > g[data-node-id="h4"]');
    expect(await card.getAttribute("data-title")).toBe(CJK_TITLE);
    await card.focus();
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const words = (await cardWords(page)).find((each) => each.id === "h4");
    if (!words) throw new Error("no card h4");
    // Nothing on a card but the record's words: no hyphen inside Japanese (it breaks between
    // characters), no line ending on the "·" before the year; a cut title ends in "…". Every
    // card of the map, the marker line ("Title shortened") and the tag aside; a hyphen only
    // where the card breaks a long word written in Latin letters.
    const drawn = await graph.locator("g.nodes > g").evaluateAll((cards) =>
      cards.map((g) => {
        const lines = (kind: string) =>
          [...g.querySelectorAll(`text.${kind} tspan`)].map((tspan) => ({
            text: tspan.textContent ?? "",
            hyphen: tspan.hasAttribute("data-hyphen"),
          }));
        return {
          id: g.getAttribute("data-node-id") ?? "",
          record: g.getAttribute("data-title") ?? "",
          title: lines("card-title"),
          meta: lines("card-meta"),
          year: g.getAttribute("data-year"),
        };
      }),
    );
    const bare = (text: string) => text.replace(/\s+/g, "");
    for (const { id, record, title, meta, year } of drawn) {
      for (const line of title) {
        if (line.hyphen) {
          expect(line.text, `${id}: a hyphen only in a word not in CJK`).not.toMatch(
            /[\u2e80-\u9fff\uac00-\ud7a3\uff00-\uffef]-$/,
          );
        }
      }
      const joined = bare(
        title.map((line) => (line.hyphen ? line.text.slice(0, -1) : line.text)).join(""),
      );
      if (joined.endsWith("…")) expect(bare(record).startsWith(joined.slice(0, -1)), id).toBe(true);
      else expect(joined, id).toBe(bare(record));
      for (const line of meta) {
        expect(line.text.trimEnd().endsWith("·"), `${id}: ${line.text}`).toBe(false);
        // (The card's own "·" before the year: a "·" of the record may start a line.)
        if (year) expect(line.text.trim(), `${id}: ${line.text}`).not.toBe(`· ${year}`);
      }
    }
    const h4 = drawn.find((each) => each.id === "h4");
    expect(h4?.title.some((line) => line.text.includes("-"))).toBe(false);
    // The "·" before the year where both share a line, left out where the year starts one.
    expect(bare((h4?.meta ?? []).map((line) => line.text).join(""))).toMatch(
      /^山田花子とミッドナイト・オーケストラ·?\d{4}$/,
    );
    // Drawn inside the card, as it is measured: a wide character takes two cells.
    expect(words.title.past, words.title.joined).toBeLessThanOrEqual(0);
    expect(words.meta.past, words.meta.joined).toBeLessThanOrEqual(0);
    if (width >= 1280) {
      expect(words.title.whole, words.title.joined).toBe(true);
      expect(words.shortened).toBeNull();
    } else {
      expect(words.title.cut).toBe(true);
      expect(words.shortened).toBe("title");
      expect(words.said).toBe("Title shortened");
      // In italics: the map's own words, not the record's.
      await expect(card.locator("text.card-shortened")).toHaveAttribute("font-style", "italic");
    }
  });
}

test("the reader's view is kept through a resize once they have moved it", async ({ page }) => {
  const problems = collectProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await SHOWCASES.wide.open(page);
  const graph = graphOf(page);
  await expect(graph.locator("g.nodes > g")).toHaveCount(SHOWCASES.wide.cards);
  const view = () => graph.locator(":scope > g").evaluate((g) => g.getAttribute("transform") ?? "");
  // The reader moves the view (the keyboard brings the last card in): a resize keeps it.
  await graph.locator('g.nodes > g[data-node-id="h4"]').focus();
  await graph.locator('g.nodes > g[data-node-id="h4"]').blur();
  await expect(graph).toHaveAttribute("data-view", "reader");
  const moved = await view();
  await graph.locator(":scope > g").evaluate((g) => g.setAttribute("data-kept", ""));
  await page.setViewportSize({ width: 1280, height: 760 });
  await expect.poll(view).not.toBe(moved);
  await expect(graph.locator(":scope > g[data-kept]")).toHaveCount(1);
  expect(problems).toEqual([]);
});

// A card focused at rest (the first Tab stop, already in view: the view does not move) and the
// window resized: the reader is at work in the map, so the drawing, the focus, its detail box
// and the keyboard's place are kept.
for (const [what, from, to] of [
  ["wider", [1440, 900], [1480, 900]],
  ["narrower", [1440, 900], [1400, 900]],
  ["shorter", [1440, 900], [1440, 860]],
  ["shorter phone", [390, 844], [390, 800]],
] as const) {
  test(`a card focused at rest keeps the focus, its detail box and the arrow keys through a ${what} window`, async ({
    page,
  }) => {
    const problems = collectProblems(page);
    await page.mouse.move(0, 0);
    await page.setViewportSize({ width: from[0], height: from[1] });
    await SHOWCASES.wide.open(page);
    await page.mouse.move(0, 0);
    if (from[0] < 768) await page.getByRole("tab", { name: "Connections" }).click();
    const graph = graphOf(page);
    const tracks = graph.locator("g.nodes > g");
    await expect(tracks).toHaveCount(SHOWCASES.wide.cards);
    await mapAtRest(graph);
    await expect(graph).toHaveAttribute("data-view", "first");
    const first = graph.locator('g.nodes > g[tabindex="0"]');
    const id = await first.getAttribute("data-node-id");
    await first.focus();
    const card = graph.locator(`g.nodes > g[data-node-id="${id}"]`);
    const detail = page.getByTestId("link-detail");
    await expect(card).toBeFocused();
    await expect(detail).toBeVisible();
    await graph.locator(":scope > g").evaluate((g) => g.setAttribute("data-kept", ""));

    await page.setViewportSize({ width: to[0], height: to[1] });
    await expect
      .poll(() => graph.evaluate((svg) => Math.round(svg.getBoundingClientRect().height)))
      .not.toBe(0);
    await mapAtRest(graph);
    await expect(card).toBeFocused();
    await expect(detail).toBeVisible();
    await expect(graph.locator(":scope > g[data-kept]")).toHaveCount(1);
    // The arrow keys move on from it.
    const order = await tracks.evaluateAll((cards) =>
      cards.map((each) => each.getAttribute("data-node-id")),
    );
    await page.keyboard.press("ArrowRight");
    await expect(
      graph.locator(`g.nodes > g[data-node-id="${order[order.indexOf(id) + 1]}"]`),
    ).toBeFocused();
    expect(problems).toEqual([]);
  });
}

test("a hover holds the layout only while the pointer is on the map; a press holds it for good", async ({
  page,
}) => {
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await SHOWCASES.wide.open(page);
  await page.mouse.move(0, 0);
  const graph = graphOf(page);
  await expect(graph.locator("g.nodes > g")).toHaveCount(SHOWCASES.wide.cards);
  await mapAtRest(graph);
  await expect(graph).toHaveAttribute("data-view", "first");
  // On a card: the drawing is held through a resize (the card stays under the pointer).
  await graph.locator('g.nodes > g[tabindex="0"]').hover();
  await expect(graph).toHaveAttribute("data-view", "reader");
  await graph.locator(":scope > g").evaluate((g) => g.setAttribute("data-kept", ""));
  const wide = await graph.getAttribute("width");
  await page.setViewportSize({ width: 1400, height: 860 });
  // (Once the map has taken the new room.)
  await expect(graph).not.toHaveAttribute("width", wide ?? "");
  await expect(graph.locator(":scope > g[data-kept]")).toHaveCount(1);
  // Off the map, having done nothing: the first view again, for the room the map has now.
  await page.mouse.move(0, 0);
  await expect(graph).toHaveAttribute("data-view", "first");
  await mapAtRest(graph);
  expect(await cardsCutAtRest(graph, headingBand(page))).toEqual([]);
  expect(await analysedAtRest(graph, headingBand(page))).toBe("in");
  // Later resizes keep the first view's rule: no card cut.
  for (const [w, h] of [
    [1280, 800],
    [1366, 700],
    [1600, 900],
    [1200, 650],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await mapAtRest(graph);
    await expect(graph).toHaveAttribute("data-view", "first");
    // (Polled: the map is laid out for the new room once the browser reports its size.)
    await expect
      .poll(() => cardsCutAtRest(graph, headingBand(page)), { message: `${w}x${h}` })
      .toEqual([]);
  }
  // A finger on the map that scrolls the page (no tap): at rest again once it lifts.
  const box = await graph.boundingBox();
  if (!box) throw new Error("no map");
  const at = { clientX: box.x + 5, clientY: box.y + box.height - 40 };
  await graph.dispatchEvent("pointerdown", { pointerType: "touch", ...at });
  await expect(graph).toHaveAttribute("data-view", "reader");
  await graph.dispatchEvent("pointercancel", { pointerType: "touch", ...at });
  await expect(graph).toHaveAttribute("data-view", "first");

  // A press of the mouse: the reader is at work in the map, for good.
  await graph.dispatchEvent("pointerdown", { pointerType: "mouse", ...at });
  await graph.dispatchEvent("pointerup", { pointerType: "mouse", ...at });
  await page.mouse.move(0, 0);
  await graph.dispatchEvent("pointerleave", { pointerType: "mouse", ...at });
  await expect(graph).toHaveAttribute("data-view", "reader");
});

test("a card focused when the map is laid out again (a narrower phone) keeps the focus", async ({
  page,
}) => {
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 390, height: 844 });
  await SHOWCASES.wide.open(page);
  await page.getByRole("tab", { name: "Connections" }).click();
  const graph = graphOf(page);
  await expect(graph.locator("g.nodes > g")).toHaveCount(SHOWCASES.wide.cards);
  const card = graph.locator('g.nodes > g[data-node-id="s2"]');
  await card.focus();
  await expect(card).toBeFocused();
  await graph.locator(":scope > g").evaluate((g) => g.setAttribute("data-kept", ""));
  // Narrower cards: a new drawing, the same card focused, its detail box shown.
  await page.setViewportSize({ width: 340, height: 844 });
  await expect(graph.locator(":scope > g[data-kept]")).toHaveCount(0);
  await expect(card).toBeFocused();
  await expect(page.getByTestId("link-detail")).toBeVisible();
});

test("the edge cues say how many cards lie past each edge, and pan to them from the keyboard", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await SHOWCASES.wide.open(page);
  await page.mouse.move(0, 0);
  const graph = graphOf(page);
  await expect(graph.locator("g.nodes > g")).toHaveCount(SHOWCASES.wide.cards);
  await mapAtRest(graph);
  const cues = page.getByTestId("map-cues");
  const right = cues.locator('[data-cue="right"]');
  // As many as the cards wholly past the right edge (none is cut at rest).
  const past = await graph.evaluate((svg) => {
    const edge = (svg.parentElement as Element).getBoundingClientRect().right;
    return [...svg.querySelectorAll("g.nodes > g > rect.card")].filter(
      (card) => card.getBoundingClientRect().left >= edge - 0.5,
    ).length;
  });
  expect(past).toBeGreaterThan(0);
  await expect(right).toHaveText(`${past} more →`);
  await expect(right).toHaveAccessibleName(
    `${past} more ${past === 1 ? "track" : "tracks"} in later years: pan right to them`,
  );
  await expect(cues.locator('[data-cue="left"]')).toHaveCount(0);
  const view = () => graph.locator(":scope > g").evaluate((g) => g.getAttribute("transform") ?? "");
  // A click pans the view right: the reader's view from then (a resize keeps it).
  const before = await view();
  await right.click();
  await expect.poll(view).not.toBe(before);
  await expect(graph).toHaveAttribute("data-view", "reader");
  // Cards now lie past the left edge too: a cue for them.
  await expect(cues.locator('[data-cue="left"]')).toBeVisible();
  // From the map, the next Tab stop is a cue; Enter pans the view too.
  await graph.locator('g.nodes > g[tabindex="0"]').focus();
  await page.keyboard.press("Tab");
  const first = cues.getByRole("button").first();
  await expect(first).toBeFocused();
  const then = await view();
  await page.keyboard.press("Enter");
  await expect.poll(view).not.toBe(then);
  // The focus still on the cue, or (nothing left past its edge, the cue gone) on a card it
  // brought into view.
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.activeElement?.hasAttribute("data-cue") ||
          document.activeElement?.closest("g.nodes > g") !== null,
      ),
    )
    .toBe(true);
  expect(problems).toEqual([]);
});

// Each edge cue pressed again and again, on every map and width where one shows: the view
// stops where no card is cut (nor lies under a cue), the analysed track's card kept in view
// while a stop allows it; once nothing is left past its edge, the focus is on the first card
// that came into view, and its name says what arrived.
for (const [showcase, { open, cards: cardCount }] of Object.entries(DRAWN)) {
  for (const [width, height] of [
    [390, 844],
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ] as const) {
    test(`at ${width} px each edge cue of the ${showcase} map pans to a stop that cuts no card`, async ({
      page,
    }) => {
      test.setTimeout(240_000);
      const problems = collectProblems(page);
      await page.mouse.move(0, 0);
      await page.setViewportSize({ width, height });
      await open(page);
      await page.mouse.move(0, 0);
      if (width < 768) await page.getByRole("tab", { name: "Connections" }).click();
      const graph = graphOf(page);
      await expect(graph.locator("g.nodes > g")).toHaveCount(cardCount);
      await mapAtRest(graph);
      const cues = page.getByTestId("map-cues");
      let pressed = 0;
      for (const side of ["right", "down", "left", "up"] as const) {
        for (let press = 0; press < 8; press += 1) {
          const cue = cues.locator(`[data-cue="${side}"]`);
          if ((await cue.count()) === 0) break;
          const analysedBefore = await analysedAtRest(graph, headingBand(page));
          await cue.focus();
          await page.keyboard.press("Enter");
          pressed += 1;
          await mapAtRest(graph);
          // At these sizes the first "↓" used to drop the analysed card for one more card below:
          // it keeps it.
          if (
            side === "down" &&
            press === 0 &&
            analysedBefore === "in" &&
            ((showcase === "rich" && width === 1440) || (showcase === "wide" && width === 1920))
          ) {
            expect(await analysedAtRest(graph, headingBand(page)), "the analysed card kept").toBe(
              "in",
            );
          }
          expect(
            await cardsCutAtRest(graph, headingBand(page)),
            `cut after ${side} #${press + 1}`,
          ).toEqual([]);
          await expect(graph).toHaveAttribute("data-view", "reader");
          // Each cue's name says how many tracks lie past its edge, "it" for one.
          for (const name of await cues
            .getByRole("button")
            .evaluateAll((buttons) =>
              buttons.map((button) => button.getAttribute("aria-label") ?? ""),
            )) {
            expect(name).toMatch(
              /^(1 more track [^:]*: pan (left|right|up|down) to it|([2-9]|\d\d+) more tracks [^:]*: pan (left|right|up|down) to them)$/,
            );
          }
          // Each cue counts every card past its edge, those hidden under a band over the top
          // too; "↑" sits at the top left, the others at the bottom ("←" left, "→" and "↓"
          // right).
          const { counted, shown, area } = await edgeCuesAtRest(graph, headingBand(page));
          for (const sideShown of ["left", "right", "up", "down"] as const) {
            const at = shown.find((one) => one.side === sideShown);
            expect(at?.count ?? 0, `${sideShown} cue's count`).toBe(counted[sideShown]);
            if (!at) continue;
            const [left, top, right, bottom] = at.box;
            const map = at.map;
            if (sideShown === "up") {
              // At the left, or (down a column, on a phone) at the right in the cards' gutter.
              expect(Math.min(left - map[0], map[2] - right), "↑ at a side").toBeLessThan(16);
              expect(Math.abs(top - area[1]), "↑ at the top").toBeLessThan(40);
            } else {
              expect(
                Math.abs(Math.min(map[3], area[3]) - bottom),
                `${sideShown} at the bottom`,
              ).toBeLessThan(4);
              if (sideShown === "left") expect(left - map[0], "← at the left").toBeLessThan(16);
              else expect(map[2] - right, `${sideShown} at the right`).toBeLessThan(200);
            }
          }
          if ((await cue.count()) === 0) {
            // Gone: the focus on a card, wholly in view.
            const focused = graph.locator("g.nodes > g:focus");
            await expect(focused, `focus after ${side} #${press + 1}`).toHaveCount(1);
            const id = await focused.getAttribute("data-node-id");
            const shown = await cardsInView(graph, headingBand(page));
            expect(shown, `${id} in view`).toContain(id);
          } else {
            await expect(cue).toBeFocused();
          }
        }
      }
      if (pressed === 0) await expect(cues.getByRole("button")).toHaveCount(0);
      expect(problems).toEqual([]);
    });
  }
}

// The first "↓" on the wide map at 1920 px: a stop that brings the next cards in and keeps
// "This track" in view wins over one that drops it, though a card far off to the right (which
// no pan down shows) runs over that stop's bottom edge.
test("the first pan down the wide map at 1920 px keeps the analysed card in view", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await SHOWCASES.wide.open(page);
  await page.mouse.move(0, 0);
  const graph = graphOf(page);
  await expect(graph.locator("g.nodes > g")).toHaveCount(SHOWCASES.wide.cards);
  await mapAtRest(graph);
  expect(await analysedAtRest(graph, headingBand(page))).toBe("in");
  const before = await cardsInView(graph, headingBand(page));
  const down = page.getByTestId("map-cues").locator('[data-cue="down"]');
  await down.focus();
  await page.keyboard.press("Enter");
  await mapAtRest(graph);
  expect(await analysedAtRest(graph, headingBand(page)), "the analysed card kept").toBe("in");
  expect(await cardsCutAtRest(graph, headingBand(page))).toEqual([]);
  const after = await cardsInView(graph, headingBand(page));
  expect(after.filter((id) => !before.includes(id)).length, "cards brought in").toBeGreaterThan(0);
  // The focused card's box at the top of the map lies below "↑ N more", never over it.
  const up = page.getByTestId("map-cues").locator('[data-cue="up"]');
  const detail = page.getByTestId("link-detail");
  await expect(up).toBeVisible();
  await expect(detail).toHaveAttribute("data-at", "top");
  const [cue, box] = [await up.boundingBox(), await detail.boundingBox()];
  expect(cue && box && box.y >= cue.y + cue.height, "the box below the cue").toBe(true);
  expect(problems).toEqual([]);
});

/** The edge cues' buttons not wholly on top at their centre (another element covers them). */
const coveredCues = async (page: Page) => {
  await page.evaluate(
    () =>
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))),
  );
  return page
    .getByTestId("map-cues")
    .locator("[data-cue]")
    .evaluateAll((buttons) =>
      buttons
        .filter((button) => {
          button.scrollIntoView({ block: "nearest" });
          const box = button.getBoundingClientRect();
          const at = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return at === null || at.closest("[data-cue]") !== button;
        })
        .map((button) => button.getAttribute("data-cue")),
    );
};

// A detail box or the selected track's panel at the bottom of the map never covers an edge
// cue: it sits above the cues there, where a mouse and the keyboard find them.
for (const [showcase, width, height] of [
  // (The rich map's panel opens at the bottom right, where "N more ↓" sits.)
  ["rich", 1440, 900],
  ["wide", 1440, 900],
  ["rich", 390, 844],
] as const) {
  test(`at ${width} px on the ${showcase} map no box or panel covers an edge cue`, async ({
    page,
  }) => {
    const problems = collectProblems(page);
    await page.mouse.move(0, 0);
    await page.setViewportSize({ width, height });
    await SHOWCASES[showcase].open(page);
    if (width < 768) await page.getByRole("tab", { name: "Connections" }).click();
    await page.mouse.move(0, 0);
    const graph = graphOf(page);
    await expect(graph.locator("g.nodes > g")).toHaveCount(SHOWCASES[showcase].cards);
    await graph.scrollIntoViewIfNeeded();
    await mapAtRest(graph);
    const cues = page.getByTestId("map-cues").locator("[data-cue]");
    expect(await cues.count()).toBeGreaterThan(0);
    expect(await coveredCues(page), "at rest").toEqual([]);

    // A cue pressed from the keyboard: the card it gives the focus to has its box, which
    // covers no cue, the one that just appeared included.
    const side = width < 768 ? "up" : "right";
    for (let press = 1; press <= 3; press += 1) {
      const cue = page.getByTestId("map-cues").locator(`[data-cue="${side}"]`);
      if ((await cue.count()) === 0) break;
      await cue.focus();
      await page.keyboard.press("Enter");
      await mapAtRest(graph);
      expect(await coveredCues(page), `press ${press}`).toEqual([]);
    }

    // A track selected: its panel opens over the map's bottom, above the cues.
    const related = async (each: string) =>
      (await graph.locator(`g.nodes > g[data-node-id="${each}"][role="button"]`).count()) > 0;
    let id: string | undefined;
    for (const each of await cardsInView(graph, headingBand(page))) {
      if (await related(each)) {
        id = each;
        break;
      }
    }
    if (!id) throw new Error("no related card in view");
    const card = graph.locator(`g.nodes > g[data-node-id="${id}"]`);
    await card.focus();
    await card.blur();
    await card.click();
    await expect(page.getByTestId("node-detail")).toBeVisible();
    await mapAtRest(graph);
    expect(await cues.count(), "cues with a track selected").toBeGreaterThan(0);
    expect(await coveredCues(page), "a track selected").toEqual([]);
    expect(problems).toEqual([]);
  });
}

// A long title in the analysed track's own year makes that year wider than the analysed card:
// the first view is judged on the map laid out for it (the year moves at the view's edge as a
// whole), so the analysed card is still wholly in view.
test("the analysed card stays in the first view when a long title widens its year", async ({
  page,
}) => {
  const fixture = loadFixture("genealogy-wide");
  for (const event of fixture.streams[ANALYZE]) {
    if (event.type !== "complete") continue;
    for (const node of event.data.genealogy.nodes) if (node.id === "d1") node.year = 1994;
  }
  await page.mouse.move(0, 0);
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, fixture);
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  await page.mouse.move(0, 0);
  const graph = graphOf(page);
  await expect(graph.locator("g.nodes > g")).toHaveCount(SHOWCASES.wide.cards);
  for (const width of [950, 945, 940, 935, 930]) {
    await page.setViewportSize({ width, height: 700 });
    await mapAtRest(graph);
    expect(await analysedAtRest(graph, headingBand(page)), `${width}x700`).toBe("in");
    expect(await cardsCutAtRest(graph, headingBand(page)), `${width}x700`).toEqual([]);
  }
});

test("the map-at-rest checks fail on a map with no card", async ({ page }) => {
  await page.setContent('<div><svg aria-label="Connections graph"></svg></div>');
  const graph = page.locator("svg");
  await expect(cardsCutAtRest(graph)).rejects.toThrow(/the map has cards/);
  await expect(wholeCardsAtRest(graph)).rejects.toThrow(/the map has cards/);
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
