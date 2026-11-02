import { expect, type Locator, type Page, test } from "@playwright/test";
import { mapAtRest } from "./mapAtRest";
import {
  analyzeAndOpenDashboard,
  animationsSettled,
  collectProblems,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";

// Visual baselines: each view, as the deterministic mock fixtures draw it, compared pixel by
// pixel with the PNG committed under __screenshots__/visual.spec.ts. Rendered and compared only
// in the pinned Playwright container (`npm run test:visual`; the `visual` project exists only
// there), so the browser, its fonts and its rasteriser are the same locally and in CI. A change
// that is meant to change a view updates its baselines with `npm run test:visual:update`.
//
// Each view at six widths, the window only (not the whole page): at device pixel ratio 1; at 2
// stored at CSS-pixel size (`scale: "css"`), which keeps the layout of ratio 2 (where text wraps,
// say) but is drawn at 1x by Chromium, so a view whose layout does not change with the ratio
// gives the same file as at 1 (git stores it once); and at 2 stored at device-pixel size, drawn
// at 2x, at 1440 px only. The page's clock is fixed and motion is reduced; the Dashboard's
// activity log is masked, as its face is the run's live log.

const ANALYZE = "/api/analyze/stream";

/** The widths, each with a window height of its usual screen. */
const SIZES = [
  [768, 1024],
  [1024, 768],
  [1280, 800],
  [1380, 900],
  [1440, 900],
  [1680, 1050],
] as const;

/** The width whose views are also stored at device-pixel size at ratio 2. */
const DEVICE_PIXEL_WIDTH = 1440;

/** The time the page's clock shows throughout (timers still run). */
const NOW = new Date("2026-10-27T19:30:00.000Z");

/** A stored result with the genealogy-rich map (16 tracks), and its address. */
const RICH = "6fGhIjKlMnOpQrStUvWxYz";

/** The genealogy-rich fixture's result, as a stored run of the track RICH. */
function richRun() {
  const events = loadFixture("genealogy-rich").streams[ANALYZE] as Array<{
    type: string;
    data?: Record<string, unknown>;
  }>;
  const analysis = { ...events.find((event) => event.type === "complete")?.data, id: RICH };
  return {
    success: true,
    run: {
      id: `thread-${RICH}`,
      status: "completed",
      mode: "live",
      spotifyId: RICH,
      createdAt: "2026-10-27T19:30:00.000Z",
      finishedAt: "2026-10-27T19:31:00.000Z",
    },
    analysis,
  };
}

const mapApi = () => ({ suggestions: [], eventGapMs: 0, streams: {}, runs: { [RICH]: richRun() } });

const mapGraph = (page: Page) =>
  page.locator('[data-map-view] svg[aria-label="Connections graph"]');

async function search(page: Page, query: string) {
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill(query);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
}

type View = {
  name: string;
  /** Opens the view and waits until it is drawn. */
  open: (page: Page) => Promise<void>;
  /** What changes from one run to the next, covered in the screenshot. */
  mask?: (page: Page) => Locator[];
};

const VIEWS: View[] = [
  {
    name: "search",
    open: async (page) => {
      await useMockApi(page, { suggestions: [], streams: {} });
      await page.goto("/");
      await expect(page.getByRole("combobox", { name: "Song title and artist" })).toBeVisible();
    },
  },
  {
    name: "picker",
    open: async (page) => {
      await useMockApi(page, loadFixture("hitl"));
      await search(page, "Hurt");
      await expect(page.getByRole("listbox", { name: "Is this the right track?" })).toBeVisible();
    },
  },
  {
    name: "dashboard",
    open: async (page) => {
      await useMockApi(page, loadFixture("full-result"));
      await analyzeAndOpenDashboard(page, "Bright Lines");
    },
    // The activity log's box: its toggle's parent.
    mask: (page) => [page.locator("button[aria-controls='activity-log-content']").locator("..")],
  },
  {
    name: "player",
    open: async (page) => {
      await useMockApi(page, loadFixture("full-result"));
      await analyzeAndOpenDashboard(page, "Bright Lines");
      await openPlayer(page);
    },
  },
  {
    name: "map",
    open: async (page) => {
      await useMockApi(page, mapApi());
      await page.goto(`/t/${RICH}/map`);
      await expect(mapGraph(page).locator("g.nodes > g")).toHaveCount(16);
      await mapAtRest(mapGraph(page));
    },
  },
  {
    name: "map-selected",
    open: async (page) => {
      await useMockApi(page, mapApi());
      await page.goto(`/t/${RICH}/map`);
      const graph = mapGraph(page);
      await expect(graph.locator("g.nodes > g")).toHaveCount(16);
      await mapAtRest(graph);
      await graph
        .locator('g.nodes > g[data-node-id]:not([data-node-id="current"])')
        .first()
        .focus();
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("node-detail")).toBeVisible();
    },
  },
];

/** The page as it rests: fonts loaded, entrance animations over, the pointer off the view. */
async function atRest(page: Page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.mouse.move(0, 0);
  await animationsSettled(page);
}

for (const [ratio, scale] of [
  [1, "css"],
  [2, "css"],
  [2, "device"],
] as const) {
  const sizes =
    scale === "device" ? SIZES.filter(([width]) => width === DEVICE_PIXEL_WIDTH) : SIZES;
  // "dpr2" is stored at CSS-pixel size, "dpr2-device" at device-pixel size.
  const suffix = ratio === 1 ? "dpr1" : scale === "css" ? "dpr2" : "dpr2-device";
  test.describe(`device pixel ratio ${ratio}, stored at ${scale}-pixel size`, () => {
    test.use({ deviceScaleFactor: ratio });
    for (const [width, height] of sizes) {
      test.describe(`${width} px`, () => {
        test.use({ viewport: { width, height } });
        for (const view of VIEWS) {
          test(`${view.name} at ${width} px matches its baseline`, async ({ page }) => {
            const problems = collectProblems(page);
            await page.clock.setFixedTime(NOW);
            await view.open(page);
            await atRest(page);
            await expect(page).toHaveScreenshot(`${view.name}-${width}-${suffix}.png`, {
              scale,
              mask: view.mask?.(page),
            });
            expect(problems).toEqual([]);
          });
        }
      });
    }
  });
}
