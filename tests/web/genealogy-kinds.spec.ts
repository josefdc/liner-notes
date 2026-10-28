import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { analysisIssues, TrackAnalysis } from "@liner-notes/contract";
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  apiRequests,
  collectProblems,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";

// Genealogy links by kind and relation. The fixture has, for each relation (sample,
// interpolation, cover, remix, shared producer, influence), one sourced link built from a
// record and citing evidence in the pack, and one the model proposed. Then links that are not
// what they say: one cites an id missing from the pack, one cites nothing, one the model marked
// sourced with no verdict behind it, one whose years contradict its direction, and one whose
// claim the verifier contradicted (not shown). One model link has a supported claim: sourced.
// A link that is not sourced is drawn grey and dashed as an influence, whatever relation it
// states (the sample's amber is the sourced colour), and named in words as the possible
// relation it states ("possible sample", as the fact cards say),
// its relation stated as a sentence naming both tracks, and its provenance shown on hover and
// focus and in a list; the Dashboard names a documented relation as known only for a sourced
// link, and as a possible one otherwise. The map is a lineage on a year axis: each track a card,
// drawn over the links, its relation named in a chip only while a link or a card is pointed at
// or focused.
const fixture = loadFixture("genealogy-kinds");
const ANALYZE = "/api/analyze/stream";
const CURRENT = "Bright Lines (2011)";
// As a claim chip names the item: its tier only for a sourced link.
const MB = "ev-mb-1 (MusicBrainz)";
const MB_SOURCED = "ev-mb-1 (MusicBrainz · primary record)";
const SHS_SOURCED =
  "ev-shs-1 (SecondHandSongs · primary record · about the song, not this recording)";

type Event = { type: string; data?: Record<string, unknown> };
type Link = Record<string, unknown> & { source: string; target: string };
type Node = Record<string, unknown> & { id: string };

const resultOf = (data: { streams: Record<string, Event[]> }) =>
  data.streams[ANALYZE].find((event) => event.type === "complete")?.data as {
    genealogy: { nodes: Node[]; links: Link[] };
  };

/** The fixture with only the given nodes (and the analyzed track) and the links between them. */
function withNodes(ids: string[]) {
  const copy = loadFixture("genealogy-kinds");
  const { genealogy } = resultOf(copy);
  const keep = new Set(["current", ...ids]);
  genealogy.nodes = genealogy.nodes.filter((node) => keep.has(node.id));
  genealogy.links = genealogy.links.filter((l) => keep.has(l.source) && keep.has(l.target));
  return copy;
}

async function screenshot(page: Page, testInfo: TestInfo, name: string, part?: Locator) {
  const dir = process.env.GENEALOGY_SHOTS_DIR ?? testInfo.project.outputDir;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `genealogy-${name}.png`);
  if (part) await part.screenshot({ path });
  else await page.screenshot({ path, fullPage: true });
}

// [kind, relation drawn, dash, chip] for each shown link, in the fixture's order (the link
// whose claim was contradicted is not shown).
const DRAWN = [
  ["sourced", "sample", "none", "Sample"],
  ["sourced", "interpolation", "none", "Interpolation"],
  ["sourced", "cover", "none", "Cover"],
  ["sourced", "remix", "none", "Remix"],
  ["sourced", "producer", "none", "Shared producer"],
  ["sourced", "influence", "none", "Influence"],
  ["inferred", "influence", "6 4", "Possible sample"],
  ["inferred", "influence", "6 4", "Possible interpolation"],
  ["inferred", "influence", "6 4", "Possible cover"],
  ["inferred", "influence", "6 4", "Possible remix"],
  ["inferred", "producer", "6 4", "Possible shared producer"],
  ["inferred", "influence", "6 4", "Possible influence"],
  ["inferred", "influence", "6 4", "Possible sample"], // cites an id not in the pack
  ["inferred", "influence", "6 4", "Possible sample"], // says sourced, cites nothing
  ["inferred", "influence", "6 4", "Possible sample"], // the model's "sourced", no verdict
  ["sourced", "sample", "none", "Sample"], // the model's, with a supported claim
  ["inferred", "influence", "6 4", "Related, direction unknown"], // years contradict it
];

const graphOf = (page: Page) =>
  page.locator('#panel-genealogy svg[aria-label="Connections graph"]');

/** The zoom's scale of the graph, or NaN before the graph has set its first view. */
const fitScale = (page: Page) =>
  graphOf(page)
    .locator(":scope > g")
    .evaluate((g) => Number(/scale\(([\d.]+)/.exec(g.getAttribute("transform") ?? "")?.[1]));

/** Page time that covers any glide of the view (a double click's zoom is a quarter second). */
const LAYOUT_MS = 2_000;

/**
 * Where the graph sits in its panel (the svg) on screen: the zoom's scale, the centre of the
 * tracks' cards less the panel's centre (px), and how many cards lie past the panel's edge.
 */
const placeInPanel = (page: Page) =>
  graphOf(page).evaluate((svg) => {
    const panel = svg.getBoundingClientRect();
    const discs = [...svg.querySelectorAll("g.nodes > g > rect.card")].map((card) =>
      card.getBoundingClientRect(),
    );
    const scale = /scale\(([\d.]+)/.exec(
      svg.querySelector(":scope > g")?.getAttribute("transform") ?? "",
    )?.[1];
    return {
      size: [panel.width, panel.height],
      k: Number(scale),
      offset: [
        (Math.min(...discs.map((d) => d.left)) + Math.max(...discs.map((d) => d.right))) / 2 -
          (panel.left + panel.right) / 2,
        (Math.min(...discs.map((d) => d.top)) + Math.max(...discs.map((d) => d.bottom))) / 2 -
          (panel.top + panel.bottom) / 2,
      ],
      outside: discs.filter(
        (d) =>
          d.left < panel.left - 1 ||
          d.right > panel.right + 1 ||
          d.top < panel.top - 1 ||
          d.bottom > panel.bottom + 1,
      ).length,
    };
  });

/**
 * Marks the graph drawn now, before a resize, and says where it sits in its panel: a resize that
 * keeps the axis and the cards' width keeps the drawing and its zoom.
 */
async function markDrawing(page: Page) {
  await graphOf(page)
    .locator(":scope > g")
    .evaluate((g) => g.setAttribute("data-kept", ""));
  return placeInPanel(page);
}

/**
 * Waits until the graph is drawn and its view is set: the zoom's transform is set and holds
 * still. The page's clock (installed in beforeEach) is first run forward past any glide.
 */
async function graphFitted(page: Page) {
  // From md up the map is a row below the columns: scrolled into view, so what is on it can be
  // pointed at, and the pointer off it, so nothing is pointed at by chance.
  await graphOf(page).scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  const fitted = async () => {
    await page.clock.runFor(LAYOUT_MS);
    return graphOf(page)
      .locator(":scope > g")
      .evaluate(async (g) => {
        const before = g.getAttribute("transform");
        await new Promise((resolve) => setTimeout(resolve, 400));
        const after = g.getAttribute("transform");
        return before !== null && before === after && after.includes("scale(") ? after : null;
      });
  };
  // Inside the test's 30 s, so a graph that never settles fails here, with this message.
  await expect
    .poll(fitted, { message: "the graph is drawn and its fit holds still", timeout: 15_000 })
    .not.toBeNull();
}

test("the mock result is one the API may send, but for the four links planted on purpose", () => {
  const analysis = TrackAnalysis.parse(resultOf(fixture));
  expect(analysis.genealogy.links).toHaveLength(DRAWN.length + 1);
  expect(analysisIssues(analysis)).toEqual([
    'genealogy.links[12].evidenceIds: cites "ev-ghost", not in the pack',
    "genealogy.links[13].evidenceIds: a sourced link cites nothing",
    "genealogy.links[14].kind: model link marked sourced without a supported claim",
    "genealogy.links[16].kind: link marked sourced without a supported claim",
  ]);
});

test.describe("the genealogy graph", () => {
  test.beforeEach(async ({ page }) => {
    // A clock graphFitted can run forward; until then it keeps real time.
    await page.clock.install();
    await useMockApi(page, fixture);
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
  });

  test("draws every link by its kind and the relation it is shown as", async ({
    page,
  }, testInfo) => {
    const problems = collectProblems(page);
    const graph = graphOf(page);
    const lines = graph.locator("g.links path");
    await expect(lines).toHaveCount(DRAWN.length);
    const drawn = await lines.evaluateAll((elements) =>
      elements.map((line) => [
        line.getAttribute("data-link-kind"),
        line.getAttribute("data-link-type"),
        line.getAttribute("stroke-dasharray"),
      ]),
    );
    expect(drawn).toEqual(DRAWN.map(([kind, type, dash]) => [kind, type, dash]));
    // No relation is written on the map at rest: each link names it, hedged when it is not
    // sourced, in a chip while it is focused (the view brings it in) or pointed at.
    await graphFitted(page);
    await expect(graph.locator("g.link-chips g.chip")).toHaveCount(0);
    const targets = graph.locator("g.link-targets path");
    for (const [index, [, , , label]] of DRAWN.entries()) {
      await targets.nth(index).focus();
      await expect(graph.locator(`g.link-chips g.chip[data-link-index="${index}"]`)).toHaveText(
        label,
      );
    }
    await targets.last().blur();
    await expect(graph.locator("g.link-chips g.chip")).toHaveCount(0);
    await expect(page.getByTestId("links-hidden")).toHaveText(
      "1 link not shown: the claim behind it was rejected or cannot be read.",
    );
    // Sourced links are shown: the panel's label does not call the whole graph an inference.
    await expect(page.getByTestId("genealogy-kinds")).toHaveText("Sourced and not sourced links");
    // The track only the rejected link related is left out with it.
    await expect(graph.locator('g.nodes > g[data-node-id="rejected"]')).toHaveCount(0);
    // A track is marked as an origin (amber glow, and its card says so) only when a sourced
    // link says this one uses it: group 2 is not enough.
    const halo = (id: string) => graph.locator(`g.nodes > g[data-node-id="${id}"] > rect.card`);
    await expect(halo("sample-sourced")).toHaveAttribute("style", /glow-amber/);
    await expect(halo("model-verified")).toHaveAttribute("style", /glow-amber/);
    const tag = (id: string) => graph.locator(`g.nodes > g[data-node-id="${id}"] .sub-label`);
    await expect(tag("sample-sourced")).toHaveText("Origin");
    await expect(tag("current")).toHaveText("This track");
    // A track that remixes this one (a sourced link, the other way) is no origin either.
    for (const id of [
      "sample-inferred",
      "ghost-cite",
      "model-sourced",
      "backwards",
      "remix-sourced",
    ]) {
      await expect(halo(id), id).toHaveAttribute("style", /filter: none/);
      await expect(tag(id), id).toHaveCount(0);
    }
    expect(problems).toEqual([]);
    await graphFitted(page);
    await screenshot(page, testInfo, "player", page.locator("#panel-genealogy"));
  });

  /**
   * The graph's cards and chips drawn now, each with its box on screen, and whether each card's
   * words are shown and on top: no link, chip or other card is the topmost element at any point
   * of a card's text.
   */
  const graphBoxes = (page: Page) =>
    graphOf(page).evaluate((svg) => {
      const panel = svg.getBoundingClientRect();
      const boxOf = (element: Element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
      };
      const cards = [...svg.querySelectorAll("g.nodes > g")].map((card) => {
        const words = card.querySelector("g.node-label");
        // Points along the middle of each line of words that are inside the panel.
        const covered = [...card.querySelectorAll("tspan, text.sub-label")].flatMap((line) => {
          const box = line.getBoundingClientRect();
          return [0.1, 0.5, 0.9].flatMap((at) => {
            const [x, y] = [box.x + box.width * at, box.y + box.height / 2];
            if (x < panel.left || x > panel.right || y < panel.top || y > panel.bottom) return [];
            const hit = document.elementFromPoint(x, y);
            return hit && !card.contains(hit) ? [hit.tagName] : [];
          });
        });
        return {
          id: card.getAttribute("data-node-id"),
          shown: words !== null && getComputedStyle(words).visibility !== "hidden",
          covered,
          box: boxOf(card.querySelector("rect.card") as Element),
        };
      });
      const chips = [...svg.querySelectorAll("g.link-chips g.chip")].map((chip) => ({
        text: chip.textContent,
        box: boxOf(chip.querySelector("rect") as Element),
      }));
      return { cards, chips };
    });

  /** Whether two boxes overlap on screen. */
  const overlap = (
    a: { x: number; y: number; right: number; bottom: number },
    b: { x: number; y: number; right: number; bottom: number },
  ) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;

  // #217: no line, chip or card over a name, and no name hidden (the map used to let a line's
  // label sit over a name, and hid the names that gave way).
  for (const width of [320, 768, 1024, 1440]) {
    test(`at ${width} px shows every name, with no line, chip or other card over it`, async ({
      page,
    }) => {
      if (width !== 1440) {
        await page.setViewportSize({ width, height: 900 });
        if (width < 768) await page.getByRole("tab", { name: "Connections" }).click();
      }
      await graphFitted(page);
      const { cards, chips } = await graphBoxes(page);
      expect(cards).toHaveLength(18);
      expect(chips).toEqual([]);
      for (const card of cards) {
        // Never hidden, and nothing drawn over its words.
        expect(card.shown, `${card.id} shown`).toBe(true);
        expect(card.covered, `what covers ${card.id}`).toEqual([]);
        for (const other of cards) {
          if (other !== card) {
            expect(overlap(card.box, other.box), `${card.id} and ${other.id}`).toBe(false);
          }
        }
      }
      // Focusing a track (the view brings it in) and pointing at it shows its relations in
      // chips, never over a card; the names stay.
      const track = graphOf(page).locator('g.nodes > g[data-node-id="sample-sourced"]');
      await expect(track).toHaveAttribute("aria-label", /\S/);
      await track.focus();
      await track.dispatchEvent("mouseenter");
      const pointed = await graphBoxes(page);
      expect(pointed.chips.length).toBeGreaterThan(0);
      for (const chip of pointed.chips) {
        for (const card of pointed.cards) {
          expect(overlap(chip.box, card.box), `chip "${chip.text}" over ${card.id}`).toBe(false);
        }
      }
      expect(pointed.cards.every((card) => card.shown)).toBe(true);
      await track.dispatchEvent("mouseleave");
      await track.blur();
      expect((await graphBoxes(page)).chips).toEqual([]);
    });
  }

  test("keeps the drawing and its zoom when its row widens, and lays the years down a phone's tab", async ({
    page,
  }) => {
    // At 1440 px the map is a full-width row, its years from left to right, wider than the
    // panel, this track (2011) near its right end; at 1920 px the same drawing is kept at the
    // same zoom, its right end still at the panel's (no empty band opens past it). On a phone
    // the years run from top to bottom: drawn again.
    await graphFitted(page);
    const placed = await markDrawing(page);
    expect(placed.outside).toBeGreaterThan(0);
    const ends = () =>
      graphOf(page).evaluate((svg) => {
        const panel = svg.getBoundingClientRect();
        const cards = [...svg.querySelectorAll("g.nodes rect.card")].map((card) =>
          card.getBoundingClientRect(),
        );
        return {
          left: Math.min(...cards.map((card) => card.left)) - panel.left,
          right: panel.right - Math.max(...cards.map((card) => card.right)),
        };
      });
    const before = await ends();
    await page.setViewportSize({ width: 1920, height: 900 });
    await graphFitted(page);
    await expect(graphOf(page).locator(":scope > g[data-kept]")).toHaveCount(1);
    const now = await placeInPanel(page);
    expect(now.k).toBe(placed.k);
    expect(now.size[0]).toBeGreaterThan(placed.size[0]);
    const after = await ends();
    expect(after.left).toBeLessThan(0);
    expect(Math.abs(after.right - before.right)).toBeLessThanOrEqual(2);
    const years = () =>
      graphOf(page)
        .locator("text.year-tick")
        .evaluateAll((ticks) =>
          ticks.map((tick) => {
            const box = tick.getBoundingClientRect();
            return { label: tick.textContent, x: box.x, y: box.y };
          }),
        );
    const row = await years();
    expect(row.map((tick) => tick.label)).toEqual([
      "1977",
      "1979",
      "1982",
      "1983",
      "1984",
      "1990",
      "2011",
      "2015",
      "2020",
    ]);
    expect(row[1].x).toBeGreaterThan(row[0].x);
    expect(row[1].y).toBeCloseTo(row[0].y, 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: "Connections" }).click();
    await graphFitted(page);
    await expect(graphOf(page).locator(":scope > g[data-kept]")).toHaveCount(0);
    const column = await years();
    expect(column[1].y).toBeGreaterThan(column[0].y);
  });

  test("has a legend in words for the lines and every relation shown", async ({ page }) => {
    const legend = page.getByRole("group", { name: "Link legend" });
    await expect(legend).toBeVisible();
    await expect(
      legend.getByRole("list", { name: "How a link is known" }).getByRole("listitem"),
    ).toHaveText([
      "Solid: Sourced — cites evidence in this result",
      "Dashed: Not sourced — each line's details say why",
    ]);
    await expect(legend.getByRole("list", { name: "Relations" }).getByRole("listitem")).toHaveText([
      "Sample",
      "Interpolation",
      "Cover",
      "Remix",
      "Shared producer",
      // Grey is drawn for the stated influences and for the relations that are not sourced.
      "Influence, or not sourced (any relation)",
    ]);
  });

  test("shows a link's relation and provenance under the mouse", async ({ page }, testInfo) => {
    await graphFitted(page);
    const detail = page.getByTestId("link-detail");
    // A real pointer on a link, at the first point along it where nothing else (a track,
    // another link) is on top: the browser's own hit-testing decides what is hovered. The last
    // link is drawn above the others (seventeen links meet at this track's card), and lies in
    // the first view, by this track.
    const point = await graphOf(page)
      .locator("g.link-targets path")
      .last()
      .evaluate((line: SVGPathElement) => {
        const length = line.getTotalLength();
        const matrix = line.getScreenCTM();
        const panel = line.ownerSVGElement?.getBoundingClientRect();
        if (!matrix || !panel) throw new Error("no screen matrix");
        const seen: string[] = [];
        // Along the part of the link in the panel's view (the map may run past it).
        for (let step = 1; step <= 19; step += 1) {
          const at = line.getPointAtLength((length * step) / 20);
          const x = at.x * matrix.a + at.y * matrix.c + matrix.e;
          const y = at.x * matrix.b + at.y * matrix.d + matrix.f;
          if (x < panel.left || x > panel.right || y < panel.top || y > panel.bottom) continue;
          const hit = document.elementFromPoint(x, y);
          if (hit === line) return { x, y };
          seen.push(
            `${Math.round(x)},${Math.round(y)}: ${hit?.tagName} ${hit?.outerHTML.slice(0, 80)}`,
          );
        }
        throw new Error(`the link is covered all along:\n${seen.join("\n")}`);
      });
    await page.mouse.move(point.x, point.y);
    await expect(detail).toHaveText(
      "Backwards Sample - Someone (2020) and Bright Lines (2011) are related (direction unknown)" +
        "Model inference · stated as a sample; the years (2020 and 2011) do not fit this " +
        `direction; cites ${MB}, not checked by a verifier`,
    );
    // Its chip names it, clear of the cards.
    await expect(graphOf(page).locator("g.link-chips g.chip")).toHaveText(
      "Related, direction unknown",
    );
    await screenshot(page, testInfo, "hover", page.locator("#panel-genealogy"));
    await page.mouse.move(5, 5);
    await expect(detail).toHaveCount(0);
  });

  test("is one tab stop; arrow keys move between tracks and links; Enter analyses a track", async ({
    page,
  }, testInfo) => {
    const graph = graphOf(page);
    const tracks = graph.locator("g.nodes > g");
    const targets = graph.locator("g.link-targets path");
    const detail = page.getByTestId("link-detail");
    // Keys act on the settled graph, not on one still being laid out.
    await graphFitted(page);
    await expect(graph.locator('[tabindex="0"]')).toHaveCount(1);

    // Tab into the graph from what comes before it, and out of it in one press.
    await tracks.first().focus();
    await expect(tracks.first()).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(tracks.first()).not.toBeFocused();
    await page.keyboard.press("Tab");
    await expect(tracks.first()).toBeFocused();
    // The track named whole, as its card says it.
    await expect(detail).toHaveText("Bright Lines by Test Artist (2011)The analyzed track");

    await page.keyboard.press("ArrowRight");
    await expect(tracks.nth(1)).toBeFocused();
    await expect(detail).toContainText(`${CURRENT} samples Sourced Sample - Someone (1984)`);
    await expect(detail).toContainText("Enter: analyze this track");
    await screenshot(page, testInfo, "focus-track", page.locator("#panel-genealogy"));

    // End: the last link; its provenance stays while focused, whatever the pointer does.
    await page.keyboard.press("End");
    await expect(targets.last()).toBeFocused();
    await expect(detail).toHaveText(
      "Backwards Sample - Someone (2020) and Bright Lines (2011) are related (direction unknown)" +
        "Model inference · stated as a sample; the years (2020 and 2011) do not fit this " +
        "direction; " +
        `cites ${MB}, not checked by a verifier`,
    );
    await page.mouse.move(5, 5);
    await expect(detail).toContainText("direction unknown");
    await screenshot(page, testInfo, "focus-link", page.locator("#panel-genealogy"));

    await page.keyboard.press("Tab");
    await expect(page.getByText("Links as a list (17)")).toBeFocused();
    await expect(detail).toHaveCount(0);

    // Enter on a track analyses it.
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => (await apiRequests(page)).filter((r) => r.startsWith(`stream ${ANALYZE}?`)))
      .toHaveLength(2);
  });

  test("gives screen readers the summary and the focused item, not every drawn word", async ({
    page,
  }) => {
    const snapshot = await page.locator("#panel-genealogy").ariaSnapshot();
    expect(snapshot).toContain("Connections: 17 related tracks.");
    expect(snapshot).toContain(
      `Sourced Sample - Someone (1984): ${CURRENT} samples Sourced Sample - Someone (1984) (Sourced).`,
    );
    expect(snapshot).toContain(
      `Sourced Remix - Someone (2015): Sourced Remix - Someone (2015) remixes ${CURRENT} (Sourced).`,
    );
    // The line labels and the tracks' drawn labels are hidden.
    // "possible remix" is drawn on a line only (the accessible names say "Possible remix").
    expect(snapshot).not.toContain("possible remix");
    expect(snapshot).not.toContain("Connected");
    expect(snapshot).not.toContain("Sourced Samp…");
  });

  test("lists every link as a sentence; opening the list keeps the graph as it is", async ({
    page,
  }, testInfo) => {
    const graph = graphOf(page);
    await graphFitted(page);
    // Zoom in and mark the drawing: a rebuilt graph would lose both.
    await graph.hover({ position: { x: 150, y: 200 } });
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(300);
    const zoomed = await graph.locator(":scope > g").getAttribute("transform");
    await graph.locator("g.nodes").evaluate((element) => element.setAttribute("data-kept", "yes"));

    const summary = page.getByText("Links as a list (17)");
    await summary.click();
    const items = page.getByRole("list", { name: "Genealogy links" }).getByRole("listitem");
    await expect(items).toHaveCount(DRAWN.length);
    await expect(graph.locator('g.nodes[data-kept="yes"]')).toHaveCount(1);
    expect(await graph.locator(":scope > g").getAttribute("transform")).toBe(zoomed);

    await expect(items.nth(0)).toHaveText(
      `${CURRENT} samples Sourced Sample - Someone (1984). Sourced · cites ${MB_SOURCED}.`,
    );
    // The remix is newer than the track it remixes: Bright Lines (2011) → the 2015 remix.
    await expect(items.nth(3)).toHaveText(
      `Sourced Remix - Someone (2015) remixes ${CURRENT}. Sourced · cites ${MB_SOURCED}.`,
    );
    await expect(items.nth(6)).toHaveText(
      `Possible sample: ${CURRENT} may sample Inferred Sample - Someone Else (1990). ` +
        "Model inference · no evidence cited.",
    );
    await expect(items.nth(11)).toContainText(
      `Model inference · cites ${MB}, not checked by a verifier.`,
    );
    await expect(items.nth(13)).toContainText("says sourced but cites no evidence");
    await expect(items.nth(14)).toContainText(
      "Model inference · proposed by the model; no " + "verifier verdict supports it",
    );
    await expect(items.nth(15)).toHaveText(
      `${CURRENT} samples Verified Model Sample - Someone (1982). Sourced · cites ${MB_SOURCED}.`,
    );
    // The link the verifier rejected is not listed.
    await expect(items.filter({ hasText: "Rejected Sample" })).toHaveCount(0);
    await screenshot(page, testInfo, "list", page.locator("#panel-genealogy"));

    await summary.click();
    await expect(graph.locator('g.nodes[data-kept="yes"]')).toHaveCount(1);
  });

  for (const [width, height] of [
    [390, 844],
    [320, 568],
  ]) {
    test(`on a ${width}×${height} phone the graph fills the tab, readable, list above the tab bar`, async ({
      page,
    }, testInfo) => {
      await graphFitted(page);
      await page.setViewportSize({ width, height });
      await page.getByRole("tab", { name: "Connections" }).click();
      const panel = page.locator("#panel-genealogy");
      const tabBar = page.getByRole("tablist", { name: "Player sections" });
      await expect(page.getByRole("group", { name: "Link legend" })).toBeVisible();
      await graphFitted(page);
      // Laid out again for the phone: the years from top to bottom.
      const ticks = await graphOf(page)
        .locator("text.year-tick")
        .evaluateAll((list) => list.map((tick) => tick.getBoundingClientRect().y));
      expect(ticks[1]).toBeGreaterThan(ticks[0]);
      const [panelBox, barBox, graphBox] = await Promise.all([
        panel.boundingBox(),
        tabBar.boundingBox(),
        graphOf(page).boundingBox(),
      ]);
      if (!panelBox || !barBox || !graphBox) throw new Error("no layout");
      // The genealogy reaches the tab bar (no empty band) and the graph has room.
      expect(Math.abs(panelBox.y + panelBox.height - barBox.y)).toBeLessThanOrEqual(2);
      expect(graphBox.height).toBeGreaterThanOrEqual(height >= 800 ? 400 : 180);
      // The fit leaves the graph at a readable scale.
      expect(await fitScale(page)).toBeGreaterThanOrEqual(0.5);
      await screenshot(page, testInfo, `phone-${width}`, panel);

      await page.getByText("Links as a list (17)").click();
      const list = page.getByRole("list", { name: "Genealogy links" });
      const listBox = await list.boundingBox();
      if (!listBox) throw new Error("no list");
      expect(listBox.y + listBox.height).toBeLessThanOrEqual(barBox.y);
      expect(listBox.y).toBeGreaterThanOrEqual(panelBox.y);
      await screenshot(page, testInfo, `phone-${width}-list`, panel);
    });
  }
});

test.describe("a related track's preview", () => {
  // The clip's request is held unanswered, so the clip neither plays through nor fails.
  const CLIP = "https://p.scdn.co/mp3-preview/genealogy-kinds-test";

  test("plays from its button in the list of previews, by click and from the keyboard, never on hover", async ({
    page,
  }) => {
    const withPreview = loadFixture("genealogy-kinds");
    const sample = resultOf(withPreview).genealogy.nodes.find(
      (node) => node.id === "sample-sourced",
    );
    if (!sample) throw new Error("no sample-sourced track in the fixture");
    sample.previewUrl = CLIP;
    const clipRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().startsWith("https://p.scdn.co/")) clipRequests.push(request.url());
    });
    await page.route("https://p.scdn.co/**", () => {});
    await useMockApi(page, withPreview);
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    const problems = collectProblems(page);

    // The pointer on the track plays nothing. The track is an origin: its hint says a click
    // explores it (it analyses the track), and no hint offers a preview there.
    const track = graphOf(page).locator('g.nodes > g[data-node-id="sample-sourced"]');
    // In view first (the hint is placed in view, near its card).
    await track.focus();
    await track.blur();
    await track.dispatchEvent("mouseenter");
    await expect(page.getByTestId("link-detail")).toBeVisible();
    await page.waitForTimeout(500);
    expect(clipRequests).toEqual([]);
    await expect(graphOf(page).locator(".preview-indicator")).toHaveText(/Analyze this track/);
    await expect(graphOf(page)).not.toContainText(/PREVIEW/);
    await track.dispatchEvent("mouseleave");

    await page.getByText("Previews (1)").click();
    const button = page.getByRole("list", { name: "Track previews" }).getByRole("button", {
      name: "Play preview of Sourced Sample - Someone (1984)",
    });
    await expect(button).toHaveCount(1);
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => clipRequests).toContain(CLIP);
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");

    // From the keyboard: Enter plays it, Space stops it.
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Space");
    await expect(button).toHaveAttribute("aria-pressed", "false");
    expect(problems).toEqual([]);
  });
});

test.describe("connected tracks on the Dashboard", () => {
  test("name a documented relation only for a sourced link, as a sentence, best known first", async ({
    page,
  }, testInfo) => {
    await useMockApi(page, fixture);
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Bright Lines");
    // Four cards out of the 17 related tracks (the one only a rejected link related is left out).
    await expect(page.getByText("4 of 17 related tracks")).toBeVisible();
    const cards = page.getByRole("button").filter({ hasText: "Relation:" });
    await expect(cards.locator("[data-link-kind]")).toHaveText([
      "Relation: Sample",
      "Relation: Interpolation",
      "Relation: Sample",
      "Relation: Cover",
    ]);
    await expect(cards.locator("[data-link-relation]")).toHaveText([
      `${CURRENT} samples Sourced Sample - Someone (1984)`,
      `${CURRENT} interpolates Sourced Interpolation - Someone (1984)`,
      `${CURRENT} samples Verified Model Sample - Someone (1982)`,
      `${CURRENT} covers Sourced Cover - Someone (1984)`,
    ]);
    await expect(cards.locator("[data-link-provenance]")).toHaveText([
      `Sourced · cites ${MB_SOURCED}`,
      `Sourced · cites ${SHS_SOURCED}`,
      `Sourced · cites ${MB_SOURCED}`,
      `Sourced · cites ${SHS_SOURCED}`,
    ]);
    await screenshot(page, testInfo, "dashboard-sourced", cards.first().locator(".."));
  });

  test("label what the model or an unbacked link relates as inferred, whatever the group", async ({
    page,
  }, testInfo) => {
    // All are in group 2 ("it samples"): none has a sourced link that holds. The track only a
    // rejected link related is left out.
    await useMockApi(
      page,
      withNodes(["sample-inferred", "model-sourced", "backwards", "rejected"]),
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await expect(page.locator("#root")).not.toContainText(" samples ");
    const cards = page.getByRole("button").filter({ hasText: "Relation:" });
    await expect(cards.locator("[data-link-kind]")).toHaveText([
      "Relation: Possible sample",
      "Relation: Possible sample",
      "Relation: Related, direction unknown",
    ]);
    await expect(page.locator("#root")).not.toContainText("Rejected Sample");
    await expect(cards.locator("[data-link-provenance]")).toHaveText([
      "Model inference · no evidence cited",
      "Model inference · proposed by the model; no " +
        `verifier verdict supports it; cites ${MB}, not checked by a verifier`,
      "Model inference · stated as a sample; the years (2020 and 2011) do not fit this " +
        "direction; " +
        `cites ${MB}, not checked by a verifier`,
    ]);
    await screenshot(page, testInfo, "dashboard-inferred", cards.first().locator(".."));
  });
});
