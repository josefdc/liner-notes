import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { analysisIssues, TrackAnalysis } from "@liner-notes/contract";
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";

// Genealogy links by kind and relation. The fixture has, for each relation (sample,
// interpolation, cover, remix, shared producer, influence), one sourced link citing evidence in
// the pack and one the model proposed, plus two links that say "sourced" without the evidence
// for it: one cites an id missing from the pack, one cites nothing. A link is drawn as what it
// is shown as (an unsourced sample is an influence), named in words, and its provenance is
// shown on hover and focus and in a list; the Dashboard names a documented relation only for a
// sourced link.
const fixture = loadFixture("genealogy-kinds");
const ANALYZE = "/api/analyze/stream";

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

// [kind, relation drawn, dash] for each link, in the fixture's order.
const DRAWN = [
  ["sourced", "sample", "none"],
  ["sourced", "interpolation", "none"],
  ["sourced", "cover", "none"],
  ["sourced", "remix", "none"],
  ["sourced", "producer", "none"],
  ["sourced", "influence", "none"],
  ["inferred", "influence", "6 4"],
  ["inferred", "influence", "6 4"],
  ["inferred", "influence", "6 4"],
  ["inferred", "influence", "6 4"],
  ["inferred", "producer", "6 4"],
  ["inferred", "influence", "6 4"],
  ["inferred", "influence", "6 4"],
  ["inferred", "influence", "6 4"],
];

test("the mock result is one the API may send, but for the two links planted on purpose", () => {
  const analysis = TrackAnalysis.parse(resultOf(fixture));
  expect(analysis.genealogy.links).toHaveLength(DRAWN.length);
  expect(analysisIssues(analysis)).toEqual([
    'genealogy.links[12].evidenceIds: cites "ev-ghost", not in the pack',
    "genealogy.links[13].evidenceIds: a sourced link cites nothing",
  ]);
});

test.describe("the genealogy graph", () => {
  test.beforeEach(async ({ page }) => {
    await useMockApi(page, fixture);
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
  });

  test("draws every link by its kind and the relation it is shown as", async ({
    page,
  }, testInfo) => {
    const problems = collectProblems(page);
    const graph = page.locator("#panel-genealogy svg");
    const lines = graph.locator("g.links line");
    await expect(lines).toHaveCount(DRAWN.length);
    const drawn = await lines.evaluateAll((elements) =>
      elements.map((line) => [
        line.getAttribute("data-link-kind"),
        line.getAttribute("data-link-type"),
        line.getAttribute("stroke-dasharray"),
      ]),
    );
    expect(drawn).toEqual(DRAWN);
    // Each line names its relation in text, not by colour alone.
    await expect(graph.locator("g.link-labels text")).toHaveText(
      DRAWN.map(([, type]) => (type === "producer" ? "shared producer" : type)),
    );
    // A track is marked as an origin (amber halo) only when a sourced link says this one uses
    // it: group 2 is not enough. (The panel is too narrow for the [ORIGIN] sub-label.)
    const halo = (label: string) =>
      graph.locator("g.nodes > g").filter({ hasText: label }).locator("circle").first();
    await expect(halo("Sourced Samp")).toHaveAttribute("style", /glow-amber/);
    await expect(halo("Inferred Sam")).toHaveAttribute("style", /filter: none/);
    await expect(halo("Ghost Citati")).toHaveAttribute("style", /filter: none/);
    expect(problems).toEqual([]);
    await page.waitForTimeout(1200); // the graph fits itself to the panel
    await screenshot(page, testInfo, "player", page.locator("#panel-genealogy"));
  });

  test("has a legend in words for the lines and every relation shown", async ({ page }) => {
    const legend = page.getByRole("group", { name: "Link legend" });
    await expect(legend).toBeVisible();
    await expect(
      legend.getByRole("list", { name: "How a link is known" }).getByRole("listitem"),
    ).toHaveText([
      "Solid: Sourced — cites evidence in this result",
      "Dashed: Model inference — not backed by evidence",
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

  test("shows a link's provenance on hover and on focus", async ({ page }, testInfo) => {
    const targets = page.locator("#panel-genealogy svg g.link-targets line");
    const detail = page.getByTestId("link-detail");

    await targets.nth(0).dispatchEvent("mouseenter");
    await expect(detail).toHaveText(
      "Sourced Sample - Someone (1984) → Bright Lines - Test Artist (2011)" +
        "Sample · Sourced · cites ev-mb-1 (musicbrainz)",
    );
    await targets.nth(0).dispatchEvent("mouseleave");
    await expect(detail).toHaveCount(0);

    // Keyboard: the links can be tabbed to, and each says what it is.
    await targets.nth(12).focus();
    await expect(targets.nth(12)).toBeFocused();
    await expect(targets.nth(12)).toHaveAttribute(
      "aria-label",
      "Ghost Citation - Nobody (1979) → Bright Lines - Test Artist (2011): Influence. " +
        "Model inference · stated as a sample, shown as an influence; " +
        "cites ev-ghost, not in the evidence pack.",
    );
    await expect(detail).toContainText("cites ev-ghost, not in the evidence pack");
    await screenshot(page, testInfo, "focus", page.locator("#panel-genealogy"));
    await targets.nth(12).blur();
    await expect(detail).toHaveCount(0);
  });

  test("lists every link with its relation and provenance", async ({ page }, testInfo) => {
    const summary = page.getByText("Links as a list (14)");
    await expect(page.getByRole("list", { name: "Genealogy links" })).toBeHidden();
    await summary.click();
    const items = page.getByRole("list", { name: "Genealogy links" }).getByRole("listitem");
    await expect(items).toHaveCount(DRAWN.length);
    await expect(items.nth(0)).toHaveText(
      "Sourced Sample - Someone (1984) → Bright Lines - Test Artist (2011): Sample. " +
        "Sourced · cites ev-mb-1 (musicbrainz).",
    );
    await expect(items.nth(3)).toHaveText(
      "Bright Lines - Test Artist (2011) → Sourced Remix - Someone (1984): Remix. " +
        "Sourced · cites ev-mb-1 (musicbrainz).",
    );
    await expect(items.nth(6)).toHaveText(
      "Inferred Sample - Someone Else (1990) → Bright Lines - Test Artist (2011): Influence. " +
        "Model inference · stated as a sample, shown as an influence; no evidence cited.",
    );
    await expect(items.nth(11)).toContainText(
      "Influence. Model inference · cites ev-mb-1 (musicbrainz), not checked by a verifier.",
    );
    await expect(items.nth(13)).toContainText("says sourced but cites no evidence");
    await screenshot(page, testInfo, "list", page.locator("#panel-genealogy"));
  });

  test("on a phone the legend and the list are in the genealogy tab", async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { name: "Network" }).click();
    await expect(page.getByRole("group", { name: "Link legend" })).toBeVisible();
    await expect(page.getByText("Links as a list (14)")).toBeVisible();
    await page.waitForTimeout(1200);
    await screenshot(page, testInfo, "phone", page.locator("#panel-genealogy"));
  });
});

test.describe("connected tracks on the Dashboard", () => {
  test("name a documented relation only for a sourced link, the best known first", async ({
    page,
  }, testInfo) => {
    await useMockApi(page, fixture);
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Bright Lines");
    const cards = page.getByRole("button").filter({ hasText: "LOGIC:" });
    await expect(cards.locator("[data-link-kind]")).toHaveText([
      "LOGIC: Sampled in this track",
      "LOGIC: Interpolated in this track",
      "LOGIC: Covered by this track",
      "LOGIC: Remixes this track",
    ]);
    await expect(cards.locator("[data-link-provenance]")).toHaveText([
      "Sourced · cites ev-mb-1 (musicbrainz)",
      "Sourced · cites ev-shs-1 (secondhandsongs)",
      "Sourced · cites ev-shs-1 (secondhandsongs)",
      "Sourced · cites ev-mb-1 (musicbrainz)",
    ]);
    await screenshot(page, testInfo, "dashboard-sourced", cards.first().locator(".."));
  });

  test("label tracks the model or an unbacked link relates as inferred, whatever their group", async ({
    page,
  }, testInfo) => {
    // All three are in group 2 ("it samples"): none has a sourced link with evidence.
    await useMockApi(page, withNodes(["sample-inferred", "ghost-cite", "no-cite"]));
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await expect(page.locator("#root")).not.toContainText("Sampled in this track");
    const cards = page.getByRole("button").filter({ hasText: "LOGIC:" });
    await expect(cards.locator("[data-link-kind]")).toHaveText(
      Array(3).fill("LOGIC: Possible influence"),
    );
    await expect(cards.locator("[data-link-provenance]")).toHaveText([
      "Model inference · stated as a sample, shown as an influence; no evidence cited",
      "Model inference · stated as a sample, shown as an influence; cites ev-ghost, not in the evidence pack",
      "Model inference · stated as a sample, shown as an influence; says sourced but cites no evidence",
    ]);
    await screenshot(page, testInfo, "dashboard-inferred", cards.first().locator(".."));
  });
});
