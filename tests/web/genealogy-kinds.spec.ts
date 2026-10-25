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
// A link is drawn as what it is shown as (an unsourced sample is an influence), named in words,
// its relation stated as a sentence naming both tracks, and its provenance shown on hover and
// focus and in a list; the Dashboard names a documented relation only for a sourced link.
const fixture = loadFixture("genealogy-kinds");
const ANALYZE = "/api/analyze/stream";
const CURRENT = "Bright Lines (2011)";
const MB = "ev-mb-1 (MusicBrainz primary record, this recording)";

type Event = { type: string; data?: Record<string, unknown> };
type Link = Record<string, unknown> & { source: string; target: string };
type Node = Record<string, unknown> & { id: string };

const resultOf = (data: { streams: Record<string, Event[]> }) =>
  data.streams[ANALYZE].find((event) => event.type === "complete")?.data as {
    genealogy: { nodes: Node[]; links: Link[] };
  };

/** The fixture with only the given nodes (and the analysed track) and the links between them. */
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

// [kind, relation drawn, dash, line label] for each shown link, in the fixture's order (the
// link whose claim was contradicted is not shown).
const DRAWN = [
  ["sourced", "sample", "none", "sample"],
  ["sourced", "interpolation", "none", "interpolation"],
  ["sourced", "cover", "none", "cover"],
  ["sourced", "remix", "none", "remix"],
  ["sourced", "producer", "none", "shared producer"],
  ["sourced", "influence", "none", "influence"],
  ["inferred", "influence", "6 4", "possible influence"],
  ["inferred", "influence", "6 4", "possible influence"],
  ["inferred", "influence", "6 4", "possible influence"],
  ["inferred", "influence", "6 4", "possible influence"],
  ["inferred", "producer", "6 4", "possible shared producer"],
  ["inferred", "influence", "6 4", "possible influence"],
  ["inferred", "influence", "6 4", "possible influence"], // cites an id not in the pack
  ["inferred", "influence", "6 4", "possible influence"], // says sourced, cites nothing
  ["inferred", "influence", "6 4", "possible influence"], // the model's "sourced", no verdict
  ["sourced", "sample", "none", "sample"], // the model's, with a supported claim
  ["inferred", "influence", "6 4", "related"], // its years contradict its direction
];

const graphOf = (page: Page) =>
  page.locator('#panel-genealogy svg[aria-label="Song genealogy network graph"]');

/** The fit's scale of the graph, or NaN before the graph has fitted itself to the panel. */
const fitScale = (page: Page) =>
  graphOf(page)
    .locator(":scope > g")
    .evaluate((g) => Number(/scale\(([\d.]+)/.exec(g.getAttribute("transform") ?? "")?.[1]));

/**
 * Waits until the layout has settled and the graph has fitted itself to the panel: the fit's
 * transform is set and holds still (it eases in over half a second). Under load the layout
 * takes a while.
 */
async function graphFitted(page: Page) {
  const transform = () =>
    graphOf(page)
      .locator(":scope > g")
      .evaluate(async (g) => {
        const before = g.getAttribute("transform");
        await new Promise((resolve) => setTimeout(resolve, 400));
        const after = g.getAttribute("transform");
        return before !== null && before === after && after.includes("scale(") ? after : null;
      });
  await expect.poll(transform, { timeout: 40_000 }).not.toBeNull();
}

test("the mock result is one the API may send, but for the two links planted on purpose", () => {
  const analysis = TrackAnalysis.parse(resultOf(fixture));
  expect(analysis.genealogy.links).toHaveLength(DRAWN.length + 1);
  expect(analysisIssues(analysis)).toEqual([
    'genealogy.links[12].evidenceIds: cites "ev-ghost", not in the pack',
    "genealogy.links[13].evidenceIds: a sourced link cites nothing",
  ]);
});

test.describe("the genealogy graph", () => {
  test.beforeEach(async ({ page }) => {
    // The force layout settles over a few seconds, longer on a loaded machine.
    test.slow();
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
    const lines = graph.locator("g.links line");
    await expect(lines).toHaveCount(DRAWN.length);
    const drawn = await lines.evaluateAll((elements) =>
      elements.map((line) => [
        line.getAttribute("data-link-kind"),
        line.getAttribute("data-link-type"),
        line.getAttribute("stroke-dasharray"),
      ]),
    );
    expect(drawn).toEqual(DRAWN.map(([kind, type, dash]) => [kind, type, dash]));
    // Each line names its relation in text, hedged when it is not sourced.
    await expect(graph.locator("g.link-labels text")).toHaveText(
      DRAWN.map(([, , , label]) => label),
    );
    await expect(page.getByTestId("links-rejected")).toHaveText(
      "1 link not shown: the verifier contradicted its claim.",
    );
    // A track is marked as an origin (amber halo) only when a sourced link says this one uses
    // it: group 2 is not enough. (The panel is too narrow for the [ORIGIN] sub-label.)
    const halo = (id: string) =>
      graph.locator(`g.nodes > g[data-node-id="${id}"] > circle`).first();
    await expect(halo("sample-sourced")).toHaveAttribute("style", /glow-amber/);
    await expect(halo("model-verified")).toHaveAttribute("style", /glow-amber/);
    for (const id of ["sample-inferred", "ghost-cite", "model-sourced", "rejected", "backwards"]) {
      await expect(halo(id), id).toHaveAttribute("style", /filter: none/);
    }
    expect(problems).toEqual([]);
    await graphFitted(page);
    await screenshot(page, testInfo, "player", page.locator("#panel-genealogy"));
  });

  test("hides overlapping line labels, keeping the best known", async ({ page }) => {
    const graph = graphOf(page);
    await graphFitted(page);
    const boxes = await graph.locator("g.link-labels text").evaluateAll((elements) =>
      elements
        .filter((text) => text.getAttribute("visibility") !== "hidden")
        .map((text) => {
          const box = text.getBoundingClientRect();
          return { x: box.x, y: box.y, right: box.right, bottom: box.bottom };
        }),
    );
    expect(boxes.length).toBeGreaterThan(0);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const [a, b] = [boxes[i], boxes[j]];
        const overlap = a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;
        expect(overlap, `labels ${i} and ${j}`).toBe(false);
      }
    }
  });

  test("has a legend in words for the lines and every relation shown", async ({ page }) => {
    const legend = page.getByRole("group", { name: "Link legend" });
    await expect(legend).toBeVisible();
    await expect(
      legend.getByRole("list", { name: "How a link is known" }).getByRole("listitem"),
    ).toHaveText([
      "Solid: Sourced — cites evidence in this result",
      "Dashed: Not sourced — a model inference, or its evidence is missing or not checked",
    ]);
    await expect(legend.getByRole("list", { name: "Relations" }).getByRole("listitem")).toHaveText([
      "Sample",
      "Interpolation",
      "Cover",
      "Remix",
      "Shared producer",
      "Influence",
    ]);
  });

  test("shows a link's relation and provenance under the mouse", async ({ page }, testInfo) => {
    await graphFitted(page);
    const detail = page.getByTestId("link-detail");
    // A real pointer on the first link, at the first point along it where nothing else (a
    // track, another link) is on top: the browser's own hit-testing decides what is hovered.
    const point = await graphOf(page)
      .locator("g.link-targets line")
      .first()
      .evaluate((line: SVGLineElement) => {
        const length = line.getTotalLength();
        const matrix = line.getScreenCTM();
        if (!matrix) throw new Error("no screen matrix");
        const seen: string[] = [];
        for (let step = 2; step <= 8; step += 1) {
          const at = line.getPointAtLength((length * step) / 10);
          const x = at.x * matrix.a + at.y * matrix.c + matrix.e;
          const y = at.x * matrix.b + at.y * matrix.d + matrix.f;
          const hit = document.elementFromPoint(x, y);
          if (hit === line) return { x, y };
          seen.push(
            `${Math.round(x)},${Math.round(y)}: ${hit?.tagName} ${hit?.outerHTML.slice(0, 80)}`,
          );
        }
        throw new Error(`the first link is covered all along:\n${seen.join("\n")}`);
      });
    await page.mouse.move(point.x, point.y);
    await expect(detail).toHaveText(
      `${CURRENT} samples Sourced Sample - Someone (1984)Sourced · cites ${MB}`,
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
    const targets = graph.locator("g.link-targets line");
    const detail = page.getByTestId("link-detail");
    await expect(graph.locator('[tabindex="0"]')).toHaveCount(1);

    // Tab into the graph from what comes before it, and out of it in one press.
    await tracks.first().focus();
    await expect(tracks.first()).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(tracks.first()).not.toBeFocused();
    await page.keyboard.press("Tab");
    await expect(tracks.first()).toBeFocused();
    await expect(detail).toHaveText(`${CURRENT}The analysed track`);

    await page.keyboard.press("ArrowRight");
    await expect(tracks.nth(1)).toBeFocused();
    await expect(detail).toContainText(`${CURRENT} samples Sourced Sample - Someone (1984)`);
    await expect(detail).toContainText("Enter: analyse this track");
    await screenshot(page, testInfo, "focus-track", page.locator("#panel-genealogy"));

    // End: the last link; its provenance stays while focused, whatever the pointer does.
    await page.keyboard.press("End");
    await expect(targets.last()).toBeFocused();
    await expect(detail).toHaveText(
      "Backwards Sample - Someone (2020) and Bright Lines (2011) are related (direction unknown)" +
        "Not sourced · stated as a sample; its direction contradicts the release years (2020 " +
        `before 2011); cites ${MB}, not checked by a verifier`,
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
    expect(snapshot).toContain("Genealogy network with 18 related tracks.");
    expect(snapshot).toContain("Sourced Sample - Someone (1984) (Sample, Sourced).");
    // The line labels and the tracks' drawn labels are hidden.
    expect(snapshot).not.toContain("possible influence");
    expect(snapshot).not.toContain("[LINK]");
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
      `${CURRENT} samples Sourced Sample - Someone (1984). Sourced · cites ${MB}.`,
    );
    // The remix is newer than the track it remixes: Bright Lines (2011) → the 2015 remix.
    await expect(items.nth(3)).toHaveText(
      `Sourced Remix - Someone (2015) remixes ${CURRENT}. Sourced · cites ${MB}.`,
    );
    await expect(items.nth(6)).toHaveText(
      `Possible influence between Inferred Sample - Someone Else (1990) and ${CURRENT}. ` +
        "Model inference · stated as a sample, shown as an influence; no evidence cited.",
    );
    await expect(items.nth(11)).toContainText(
      `Model inference · cites ${MB}, not checked by a verifier.`,
    );
    await expect(items.nth(13)).toContainText("says sourced but cites no evidence");
    await expect(items.nth(14)).toContainText(
      "Model inference · stated as a sample, shown as an influence; proposed by the model; no " +
        "verifier verdict supports it",
    );
    await expect(items.nth(15)).toHaveText(
      `${CURRENT} samples Verified Model Sample - Someone (1982). Sourced · cites ${MB}.`,
    );
    // The link the verifier rejected is not listed (its track stays, with no relation).
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
      await page.setViewportSize({ width, height });
      await page.getByRole("tab", { name: "Network" }).click();
      const panel = page.locator("#panel-genealogy");
      const tabBar = page.getByRole("tablist", { name: "Player sections" });
      await expect(page.getByRole("group", { name: "Link legend" })).toBeVisible();
      await graphFitted(page);
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

test.describe("connected tracks on the Dashboard", () => {
  test("name a documented relation only for a sourced link, as a sentence, best known first", async ({
    page,
  }, testInfo) => {
    await useMockApi(page, fixture);
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Bright Lines");
    const cards = page.getByRole("button").filter({ hasText: "LOGIC:" });
    await expect(cards.locator("[data-link-kind]")).toHaveText([
      "LOGIC: Sample",
      "LOGIC: Interpolation",
      "LOGIC: Sample",
      "LOGIC: Cover",
    ]);
    await expect(cards.locator("[data-link-relation]")).toHaveText([
      `${CURRENT} samples Sourced Sample - Someone (1984)`,
      `${CURRENT} interpolates Sourced Interpolation - Someone (1984)`,
      `${CURRENT} samples Verified Model Sample - Someone (1982)`,
      `${CURRENT} covers Sourced Cover - Someone (1984)`,
    ]);
    await expect(cards.locator("[data-link-provenance]")).toHaveText([
      `Sourced · cites ${MB}`,
      "Sourced · cites ev-shs-1 (SecondHandSongs primary record, the song)",
      `Sourced · cites ${MB}`,
      "Sourced · cites ev-shs-1 (SecondHandSongs primary record, the song)",
    ]);
    await screenshot(page, testInfo, "dashboard-sourced", cards.first().locator(".."));
  });

  test("label what the model or an unbacked link relates as inferred, whatever the group", async ({
    page,
  }, testInfo) => {
    // All four are in group 2 ("it samples"): none has a sourced link that holds.
    await useMockApi(
      page,
      withNodes(["sample-inferred", "model-sourced", "backwards", "rejected"]),
    );
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await expect(page.locator("#root")).not.toContainText(" samples ");
    const cards = page.getByRole("button").filter({ hasText: "LOGIC:" });
    await expect(cards.locator("[data-link-kind]")).toHaveText([
      "LOGIC: Possible influence",
      "LOGIC: Possible influence",
      "LOGIC: Related, direction unknown",
      "LOGIC: No direct link to this track",
    ]);
    await expect(cards.locator("[data-link-provenance]")).toHaveText([
      "Model inference · stated as a sample, shown as an influence; no evidence cited",
      "Model inference · stated as a sample, shown as an influence; proposed by the model; no " +
        `verifier verdict supports it; cites ${MB}, not checked by a verifier`,
      "Not sourced · stated as a sample; its direction contradicts the release years (2020 " +
        `before 2011); cites ${MB}, not checked by a verifier`,
    ]);
    await screenshot(page, testInfo, "dashboard-inferred", cards.first().locator(".."));
  });
});
