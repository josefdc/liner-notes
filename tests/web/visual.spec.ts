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
// at 2x, at 1440 px only. Parts of the Dashboard and the Player below the fold (the radar
// chart, the connected tracks' cards, the preview's timeline, the Player's connections) are
// compared on their own at 768, 1024 and 1440 px, at ratio 1. The page's clock is fixed, in UTC,
// and motion is reduced. Nothing is masked: with the clock fixed nothing on these views changes
// from run to run (the Dashboard's activity log shows no time while it is closed).

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
            await expect(page).toHaveScreenshot(`${view.name}-${width}-${suffix}.png`, { scale });
            expect(problems).toEqual([]);
          });
        }
      });
    }
  });
}

/** The widths whose sections below the fold are compared too, at ratio 1. */
const SECTION_SIZES = SIZES.filter(([width]) => [768, 1024, 1440].includes(width));

type Section = {
  name: string;
  view: "dashboard" | "player";
  /** The section's parts: the screenshot covers the box around all of them. */
  parts: (page: Page) => Locator[];
};

/** The Player's right column's direct child that holds `inner`. */
const playerPart = (page: Page, inner: Locator) =>
  page.locator("#panel-player > div").filter({ has: inner });

// Parts of the Dashboard and the Player that no window-sized screenshot reaches at these sizes:
// each is scrolled into view and compared on its own.
const SECTIONS: Section[] = [
  {
    // The radar chart whole, with its labels.
    name: "dashboard-fingerprint",
    view: "dashboard",
    parts: (page) => [page.getByRole("region", { name: "Sonic Fingerprint" })],
  },
  {
    // The connected tracks' cards, each with its relation and provenance chip.
    name: "dashboard-connections",
    view: "dashboard",
    parts: (page) => [
      page
        .locator("div")
        .filter({ has: page.getByRole("heading", { level: 2, name: "Connections" }) })
        .filter({ has: page.locator("[aria-busy]") })
        .last(),
    ],
  },
  {
    // The preview's control and the song's timeline under it.
    name: "player-preview",
    view: "player",
    parts: (page) => [
      playerPart(
        page,
        page.getByRole("button", { name: /preview$/ }).or(page.getByText("Preview unavailable")),
      ),
      playerPart(page, page.locator('fieldset[aria-label="Song structure"]')),
    ],
  },
  {
    // The connections: the related tracks' row with its provenance chips, the legend and the
    // list of links.
    name: "player-connections",
    view: "player",
    parts: (page) => [page.locator("#panel-genealogy")],
  },
];

test.describe("sections below the fold, device pixel ratio 1", () => {
  for (const [width, height] of SECTION_SIZES) {
    test.describe(`${width} px`, () => {
      test.use({ viewport: { width, height } });
      for (const section of SECTIONS) {
        test(`${section.name} at ${width} px matches its baseline`, async ({ page }) => {
          const problems = collectProblems(page);
          await page.clock.setFixedTime(NOW);
          await useMockApi(page, loadFixture("full-result"));
          await analyzeAndOpenDashboard(page, "Bright Lines");
          if (section.view === "player") await openPlayer(page);
          const parts = section.parts(page);
          for (const part of parts) await expect(part).toHaveCount(1);
          await parts[parts.length - 1].scrollIntoViewIfNeeded();
          await parts[0].scrollIntoViewIfNeeded();
          await atRest(page);
          const boxes = await Promise.all(parts.map((part) => part.boundingBox()));
          const clip = {
            x: Math.min(...boxes.map((box) => box?.x ?? Number.NaN)),
            y: Math.min(...boxes.map((box) => box?.y ?? Number.NaN)),
            right: Math.max(...boxes.map((box) => (box ? box.x + box.width : Number.NaN))),
            bottom: Math.max(...boxes.map((box) => (box ? box.y + box.height : Number.NaN))),
          };
          // The whole section is in the window, so the screenshot shows all of it.
          expect(clip.y, `${section.name} starts in the window`).toBeGreaterThanOrEqual(0);
          expect(clip.bottom, `${section.name} ends in the window`).toBeLessThanOrEqual(height);
          await expect(page).toHaveScreenshot(`${section.name}-${width}-dpr1.png`, {
            clip: {
              x: clip.x,
              y: clip.y,
              width: clip.right - clip.x,
              height: clip.bottom - clip.y,
            },
          });
          expect(problems).toEqual([]);
        });
      }
    });
  }
});
