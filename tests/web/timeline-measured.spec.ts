import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  loadFixture,
  openPlayer,
  replayedRecording,
  useMockApi,
} from "./mock";
import { offline } from "./offline";

// The recorded run's cover, and any other outside address, are answered on the page: nothing
// leaves the machine.
test.beforeEach(async ({ page }) => {
  await offline(page);
});

// The Player's preview lane draws what the audio service measured on the preview: the beat
// grid, the energy contour and the neutral sections, in the measured colour, on the preview's
// own time axis. The song's sections above are drawn only when the model wrote them, in the
// inferred colour; a template's (this recording's) are not drawn at all. A layer that was not
// measured draws nothing.

const MEASURED = "rgb(0, 240, 255)";

async function screenshot(page: Page, testInfo: TestInfo, name: string, part?: Locator) {
  const dir = process.env.TIMELINE_SHOTS_DIR ?? testInfo.project.outputDir;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `timeline-${name}.png`);
  if (part) await part.screenshot({ path });
  else await page.screenshot({ path, fullPage: true });
}

/** The box of each element, and of the lane and the window, to check nothing is cut off. */
async function boxes(lane: Locator) {
  return lane.evaluate((root) => {
    const box = (element: Element) => {
      const { left, right, top, bottom, width, height } = element.getBoundingClientRect();
      return { left, right, top, bottom, width, height };
    };
    return {
      lane: box(root),
      layers: [...root.querySelectorAll("[data-measured-layer]")].map((element) => ({
        name: element.getAttribute("data-measured-layer"),
        ...box(element),
      })),
      labels: [...root.querySelectorAll('[data-measured-layer="sections"] span')].map((span) => ({
        fits: span.scrollWidth <= (span.parentElement as HTMLElement).clientWidth,
      })),
      viewport: window.innerWidth,
      pageWidth: document.documentElement.scrollWidth,
    };
  });
}

for (const width of [390, 1440]) {
  test(`the recorded run's preview lane draws its measured beats, energy and sections (${width} px)`, async ({
    page,
  }, testInfo) => {
    const problems = collectProblems(page);
    await page.setViewportSize({ width, height: 900 });
    // The recording's cover is the Cover Art Archive's: answered here, never from the network.
    await page.route("https://coverartarchive.org/**", (route) =>
      route.fulfill({
        contentType: "image/svg+xml",
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
      }),
    );
    const { events } = replayedRecording();
    await useMockApi(page, {
      suggestions: [],
      eventGapMs: 0,
      streams: { "/api/analyze/stream": events },
    });
    await analyzeAndOpenDashboard(page, "One More Time Daft Punk");
    await openPlayer(page);

    const timeline = page.getByRole("group", { name: "Song structure" });
    // The recording measured a 29.986 s window.
    const lane = timeline.getByRole("group", { name: "Preview window (30 s, measured)" });
    await lane.scrollIntoViewIfNeeded();
    await expect(lane).toBeVisible();

    // Its 61 beats, every one inside the window, as ticks in the measured colour.
    const beats = lane.getByRole("img", { name: /^Beat grid: 61 beats measured in the preview/ });
    await expect(beats).toBeVisible();
    await expect(beats.locator("line")).toHaveCount(61);
    await expect(beats.locator("line").first()).toHaveAttribute("x1", "0.418");
    await expect(beats).toHaveAttribute("viewBox", "0 0 29.986 1");
    expect(await beats.evaluate((svg) => getComputedStyle(svg).stroke)).toBe(MEASURED);

    // The energy contour, one point per hop of the 322 measured.
    const energy = lane.getByRole("img", { name: /^Energy \(RMS\)/ });
    await expect(energy).toBeVisible();
    const points = await energy
      .locator("polyline")
      .evaluate((line) => (line.getAttribute("points") ?? "").split(" ").length);
    expect(points).toBe(322);

    // The neutral sections the analysis found, on the same axis.
    const sections = lane.getByRole("list", { name: "Sections measured in the preview" });
    await expect(sections.getByRole("listitem")).toHaveText(["A", "B", "A"]);
    const labels = await sections
      .getByRole("listitem")
      .evaluateAll((items) => items.map((item) => item.getAttribute("aria-label")));
    expect(labels).toEqual([
      "Section A, 0:00 to 0:10 (measured)",
      "Section B, 0:10 to 0:14 (measured)",
      "Section A, 0:14 to 0:29 (measured)",
    ]);
    await expect(lane.locator('[data-measured-layer="legend"]')).toContainText("Measured");
    await expect(lane.locator('[data-measured-layer="legend"]')).toContainText("61 beats");

    // The song's sections are a template in this recording: none is drawn or named. The only
    // list in the timeline is the measured sections of the preview.
    await expect(timeline.getByRole("list")).toHaveCount(1);
    await expect(timeline.locator("[data-segment-tint]")).toHaveCount(0);
    // The line is about the whole song, and says the preview's sections below are measured.
    await expect(timeline.locator('[data-structure="not-analyzed"]')).toHaveText(
      "Song sections not analyzed(the preview's sections below are measured)",
    );
    // No song axis is drawn (nothing is placed on it): the song's length is said in words.
    await expect(timeline.locator("[data-song-length]")).toHaveText("Song length 5:20");
    await expect(timeline).not.toContainText(/Intro|Verse|Chorus|Bridge|Outro|Template/);

    // Nothing is cut off: every layer inside the lane, the lane inside the window, no
    // horizontal scroll, and each section's label inside its band.
    const drawn = await boxes(lane);
    expect(drawn.layers.map((layer) => layer.name)).toEqual([
      "sections",
      "energy",
      "beats",
      "legend",
    ]);
    for (const layer of drawn.layers) {
      expect(layer.width, layer.name ?? "").toBeGreaterThan(0);
      expect(layer.height, layer.name ?? "").toBeGreaterThan(0);
      expect(layer.left, layer.name ?? "").toBeGreaterThanOrEqual(drawn.lane.left - 0.5);
      expect(layer.right, layer.name ?? "").toBeLessThanOrEqual(drawn.lane.right + 0.5);
    }
    // The layers drawn over time share the lane's full width, so their times line up.
    for (const layer of drawn.layers.filter((l) => l.name !== "legend")) {
      expect(Math.abs(layer.width - drawn.lane.width), layer.name ?? "").toBeLessThan(1);
    }
    expect(drawn.lane.left).toBeGreaterThanOrEqual(0);
    expect(drawn.lane.right).toBeLessThanOrEqual(drawn.viewport);
    expect(drawn.pageWidth).toBeLessThanOrEqual(drawn.viewport);
    expect(drawn.labels.every((label) => label.fits)).toBe(true);

    await screenshot(page, testInfo, `measured-${width}`, timeline);
    await screenshot(page, testInfo, `player-${width}`);
    expect(problems).toEqual([]);
  });
}

test("a result that measured only its sections draws them, and no beats or energy", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, loadFixture("withheld-key-v2"));
  await analyzeAndOpenDashboard(page, "Cowbell Loop");
  await openPlayer(page);

  const timeline = page.getByRole("group", { name: "Song structure" });
  const lane = timeline.getByRole("group", { name: "Preview window (29.8 s, measured)" });
  await expect(
    lane.getByRole("list", { name: "Sections measured in the preview" }).getByRole("listitem"),
  ).toHaveText(["A", "B"]);
  await expect(lane.locator("[data-measured-layer]")).toHaveCount(2);
  await expect(lane.getByRole("img", { name: /^(Beat grid|Energy \(RMS\))/ })).toHaveCount(0);
  await expect(lane.locator('[data-measured-layer="legend"]')).not.toContainText(/beat|energy/i);
  // The model's sections stay in the inferred colour, with the model's chip.
  const song = timeline.getByRole("list").first();
  const tints = await song
    .getByRole("listitem")
    .evaluateAll((items) => items.map((item) => item.getAttribute("data-segment-tint")));
  expect(new Set(tints)).toEqual(new Set(["inferred"]));
  await expect(timeline.locator("[data-provenance]").first()).toHaveAttribute(
    "data-provenance",
    "inferred",
  );
  expect(problems).toEqual([]);
});
