import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import {
  animationsSettled,
  apiRequests,
  collectProblems,
  dashboardHeading,
  fullResultData,
  replayedRecording,
  useMockApi,
} from "./mock";
import { offline } from "./offline";

// The song-relations map on a page of its own (#217): `/t/<id>/map` opens a stored result's map
// full size, from a link, a reload, Back or Forward; the Player links to it. A track analysed
// from a map's detail panel shows the tracks explored before it as a breadcrumb, kept in the
// history entries (Back and Forward bring it back) and cleared by a new search.

test.use({ reducedMotion: "reduce" });

const ANALYZE = "/api/analyze/stream";
/** The recorded demo run's track (One More Time), stored as a replayed run. */
const OMT = "0DiWol3AO6WpXZgp0goxAV";
const OMT_QUERY = "One+More+Time+Daft+Punk";
/** Its sample source's card on the map, matched to a Spotify track. */
const SOURCE_NODE = "mb-cd6c8d5c-fd3b-4ec4-bb57-7a59451f7edb";
const SOURCE_ID = "5MIgTjcn94EPeSUUo8dx4q";
/** Stored results with one relation (a compact row) and with none. */
const SPARSE = "1aBcDeFgHiJkLmNoPqRsTu";
const BARE = "2bCdEfGhIjKlMnOpQrStUv";
/** A well-formed track id without a stored run. */
const MISSING = "7ouMYWpwJ422jRcDASZB7P";

const omtResult = () =>
  replayedRecording().events.find((event) => event.type === "complete")?.data as Record<
    string,
    unknown
  >;

const storedRun = (analysis: Record<string, unknown>, mode: "live" | "replay") => ({
  success: true,
  run: {
    id: `thread-${analysis.id}`,
    status: "completed",
    mode,
    spotifyId: analysis.id,
    createdAt: "2026-10-27T19:30:00.000Z",
    finishedAt: "2026-10-27T19:31:00.000Z",
  },
  analysis,
});

/** The full-result fixture's result under the track id `id`. */
const fullAs = (id: string, extra: Record<string, unknown> = {}) => ({
  ...(fullResultData() as Record<string, unknown>),
  id,
  ...extra,
});

/** Stored runs of the map's tracks, and the stream that analyses the sample source. */
function mapApi() {
  const full = fullResultData() as { genealogy: { nodes: Array<{ group?: number }> } };
  return {
    suggestions: [],
    eventGapMs: 0,
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: "thread-source" },
        {
          type: "status",
          node: "scout",
          message: "Searching for the track",
          code: "SPOTIFY-SEARCH",
        },
        { type: "complete", data: fullAs(SOURCE_ID) },
        { type: "done" },
      ],
    },
    runs: {
      [OMT]: storedRun(omtResult(), "replay"),
      // What the analysis of the sample source stored, for a reload of its address.
      [SOURCE_ID]: storedRun(fullAs(SOURCE_ID), "live"),
      [SPARSE]: storedRun(fullAs(SPARSE), "live"),
      [BARE]: storedRun(
        fullAs(BARE, {
          genealogy: { nodes: full.genealogy.nodes.filter((node) => node.group === 1), links: [] },
        }),
        "live",
      ),
    },
  };
}

const mapView = (page: Page) => page.locator("[data-map-view]");
const mapHeading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: /^Song relations of/ });
const graphOf = (page: Page) => mapView(page).locator('svg[aria-label="Connections graph"]');
const trailNav = (page: Page) => page.getByRole("navigation", { name: "Explored tracks" });
const analyses = async (page: Page) =>
  (await apiRequests(page)).filter((entry) => entry.startsWith(`stream ${ANALYZE}?`));

async function noSidewaysScroll(page: Page) {
  const { scroll, client } = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(scroll, "the page scrolls sideways").toBeLessThanOrEqual(client);
}

async function shot(page: Page, testInfo: TestInfo, name: string) {
  const dir = process.env.GENEALOGY_SHOTS_DIR ?? testInfo.project.outputDir;
  mkdirSync(dir, { recursive: true });
  await animationsSettled(page);
  await page.screenshot({ path: join(dir, `map-${name}.png`) });
}

test.beforeEach(async ({ page }) => {
  await offline(page);
});

for (const [width, height] of [
  [390, 844],
  [1440, 900],
] as const) {
  test.describe(`at ${width} px`, () => {
    test.beforeEach(async ({ page }) => {
      await page.setViewportSize({ width, height });
      await useMockApi(page, mapApi());
    });

    test("a link to a track's map opens it full size, with everything the map does; a reload keeps it", async ({
      page,
    }, testInfo) => {
      test.setTimeout(90_000);
      const problems = collectProblems(page);
      await page.goto(`/t/${OMT}/map`);

      await expect(mapHeading(page)).toBeFocused();
      await expect(mapHeading(page)).toHaveText("Song relations of One More Time · Daft Punk");
      await expect(page).toHaveURL(`/t/${OMT}/map?q=${OMT_QUERY}`);
      await expect(page).toHaveTitle(
        "Song relations map: One More Time by Daft Punk · Liner Notes",
      );
      const back = page.getByRole("link", { name: "Back to One More Time" });
      await expect(back).toHaveAttribute("href", `/t/${OMT}?q=${OMT_QUERY}`);
      // A replay says so.
      await expect(mapView(page).getByText(/^Recorded run · /)).toBeVisible();

      // The map takes the window's width and the height under the band.
      const graph = graphOf(page);
      await expect(graph).toBeVisible();
      const box = await graph.boundingBox();
      if (!box) throw new Error("no map");
      expect(box.width).toBeGreaterThanOrEqual(width - 2);
      expect(box.height).toBeGreaterThanOrEqual(height * 0.5);
      await noSidewaysScroll(page);
      await shot(page, testInfo, `full-${width}`);

      // Selection, the detail panel, filters and the list, as in the Player.
      const card = graph.locator(`g.nodes > g[data-node-id="${SOURCE_NODE}"]`);
      await card.focus();
      await page.keyboard.press("Enter");
      const panel = page.getByTestId("node-detail");
      await expect(panel).toBeFocused();
      await expect(panel.getByRole("button", { name: "Analyze this track" })).toBeVisible();
      await expect(panel.locator("[data-listening-unavailable]")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(card).toBeFocused();
      await expect(mapView(page).getByRole("button", { name: "Filter links" })).toBeVisible();
      await expect(mapView(page).getByText(/^Links as a list \(\d+\)$/)).toBeVisible();

      await page.reload();
      await expect(mapHeading(page)).toBeFocused();
      await expect(graphOf(page)).toBeVisible();
      await expect(page).toHaveURL(`/t/${OMT}/map?q=${OMT_QUERY}`);
      expect(await analyses(page)).toEqual([]);
      expect(problems).toEqual([]);
    });

    test('"Open the full map" in the Player opens it; Back returns to the Player as it was', async ({
      page,
    }, testInfo) => {
      test.setTimeout(90_000);
      const problems = collectProblems(page);
      await page.goto(`/t/${OMT}`);
      await expect(dashboardHeading(page)).toBeVisible();
      await page.getByRole("button", { name: "View full analysis" }).click();
      const playerBack = page.getByRole("button", { name: /Back to summary/ });
      await expect(playerBack).toBeVisible();
      const connections = page.getByRole("tab", { name: "Connections" });
      if (width < 768) await connections.click();

      const open = page.getByRole("link", { name: "Open the full map" });
      await expect(open).toHaveAttribute("href", `/t/${OMT}/map?q=${OMT_QUERY}`);
      await page.locator("#panel-genealogy").scrollIntoViewIfNeeded();
      await shot(page, testInfo, `player-link-${width}`);
      await open.click();
      await expect(mapHeading(page)).toBeFocused();
      await expect(page).toHaveURL(`/t/${OMT}/map?q=${OMT_QUERY}`);
      await expect(graphOf(page)).toBeVisible();

      await page.goBack();
      await expect(playerBack).toBeVisible();
      await expect(page).toHaveURL(`/t/${OMT}?q=${OMT_QUERY}`);
      await expect(mapView(page)).toHaveCount(0);
      if (width < 768) {
        await expect(connections).toHaveAttribute("aria-selected", "true");
        await expect(open).toBeVisible();
      }

      await page.goForward();
      await expect(mapHeading(page)).toBeVisible();
      // "Back to <title>" goes back to the Player it was opened from.
      await page.getByRole("link", { name: "Back to One More Time" }).click();
      await expect(playerBack).toBeVisible();
      if (width < 768) await expect(connections).toHaveAttribute("aria-selected", "true");
      expect(await analyses(page)).toEqual([]);
      expect(problems).toEqual([]);
    });

    test("Analyze on the full map opens the next track with a breadcrumb; Back and Forward keep both", async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      const problems = collectProblems(page);
      await page.goto(`/t/${OMT}/map`);
      const card = graphOf(page).locator(`g.nodes > g[data-node-id="${SOURCE_NODE}"]`);
      await card.focus();
      await page.keyboard.press("Enter");
      await page
        .getByTestId("node-detail")
        .getByRole("button", { name: "Analyze this track" })
        .click();
      await page.getByRole("button", { name: "Open the results" }).click();
      await expect(dashboardHeading(page)).toBeFocused();
      expect(await analyses(page)).toHaveLength(1);
      expect((await analyses(page))[0]).toContain(`trackId=${SOURCE_ID}`);

      const trail = trailNav(page);
      const expectTrailOfTwo = async () => {
        await expect(trail.getByRole("link")).toHaveCount(2);
        const [first, current] = [trail.getByRole("link").nth(0), trail.getByRole("link").nth(1)];
        await expect(first).toHaveText("One More Time · Daft Punk (map)");
        await expect(first).toHaveAttribute("href", `/t/${OMT}/map?q=${OMT_QUERY}`);
        await expect(first).not.toHaveAttribute("aria-current", /.*/);
        await expect(current).toHaveText("Bright Lines · Test Artist");
        await expect(current).toHaveAttribute("aria-current", "page");
      };
      await expectTrailOfTwo();
      await noSidewaysScroll(page);
      await shot(page, testInfo, `trail-${width}`);

      // A link to the same address, opened anew, has no trail: it lives in this tab's history.
      const shared = await page.context().newPage();
      await offline(shared);
      await useMockApi(shared, mapApi());
      await shared.setViewportSize({ width, height });
      await shared.goto(page.url());
      await expect(dashboardHeading(shared)).toBeVisible();
      await expect(trailNav(shared)).toHaveCount(0);
      await shared.close();

      // Back: the map it was analysed from, with no trail of its own.
      await page.goBack();
      await expect(mapHeading(page)).toHaveText("Song relations of One More Time · Daft Punk");
      await expect(page).toHaveURL(`/t/${OMT}/map?q=${OMT_QUERY}`);
      await expect(trail).toHaveCount(0);
      // Forward: the next track, with its trail.
      await page.goForward();
      await expect(dashboardHeading(page)).toBeVisible();
      await expect(page).toHaveURL(`/t/${SOURCE_ID}?q=Bright+Lines+Test+Artist`);
      await expectTrailOfTwo();
      // A reload keeps the entry's trail.
      await page.reload();
      await expect(dashboardHeading(page)).toBeVisible();
      await expectTrailOfTwo();

      // The trail's track is its full-size map, in an entry of its own.
      await trail.getByRole("link", { name: "One More Time · Daft Punk (map)" }).click();
      await expect(mapHeading(page)).toBeFocused();
      await expect(mapHeading(page)).toHaveText("Song relations of One More Time · Daft Punk");
      await expect(page).toHaveURL(`/t/${OMT}/map?q=${OMT_QUERY}`);
      await expect(trail).toHaveCount(0);
      await page.goBack();
      await expect(dashboardHeading(page)).toBeVisible();
      await expectTrailOfTwo();

      // A new search starts no chain.
      await page.getByRole("button", { name: "New search" }).click();
      await page.getByPlaceholder(/Song title/).fill("Bright Lines");
      await page.getByRole("button", { name: "Analyze", exact: true }).click();
      await page.getByRole("button", { name: "Open the results" }).click();
      await expect(dashboardHeading(page)).toBeVisible();
      await expect(trail).toHaveCount(0);
      // (The page's request log starts at the reload.)
      expect(await analyses(page)).toEqual([`stream ${ANALYZE}?query=Bright%20Lines`]);
      expect(problems).toEqual([]);
    });

    test("a map with one relation is a compact row, one with none says so, and a missing or wrong id says so", async ({
      page,
    }, testInfo) => {
      test.setTimeout(90_000);
      const problems = collectProblems(page);
      await page.goto(`/t/${SPARSE}/map`);
      await expect(mapHeading(page)).toBeFocused();
      await expect(mapView(page).getByTestId("lineage-row")).toBeVisible();
      await expect(graphOf(page)).toHaveCount(0);
      await noSidewaysScroll(page);
      await shot(page, testInfo, `sparse-${width}`);

      await page.goto(`/t/${BARE}/map`);
      await expect(mapHeading(page)).toBeFocused();
      await expect(mapView(page).locator("[data-map-empty]")).toHaveText(
        "No connected tracks were found for this track.",
      );

      await page.goto(`/t/${MISSING}/map`);
      await expect(
        page.getByRole("heading", { name: "No stored analysis for this track yet" }),
      ).toBeFocused();
      await expect(page).toHaveURL(`/t/${MISSING}/map`);
      await expect(mapView(page)).toHaveCount(0);

      await page.goto("/t/not-a-track/map");
      await expect(
        page.getByRole("heading", { name: "This link does not lead to a track" }),
      ).toBeVisible();

      // An address under the map's that the app does not know is the search.
      await page.goto(`/t/${OMT}/map/x`);
      await expect(page.getByRole("combobox", { name: "Song title and artist" })).toBeVisible();
      await expect(page).toHaveURL("/");
      expect(await analyses(page)).toEqual([]);
      expect(problems).toEqual([]);
    });
  });
}
