import { expect, type Locator, type Page, test } from "@playwright/test";
import { clippedLines } from "./clipping";
import {
  analyzeAndOpenDashboard,
  loadFixture,
  openPlayer,
  replayedRecording,
  useMockApi,
} from "./mock";
import { offline } from "./offline";

// A phone held sideways (844×390, 932×430): from md up the Player shows its columns, and the nav
// and the track's header above them share one band, so the panels' scrolling area keeps most of
// the height and the connections graph a drawing that shows something. On main the nav and the
// header took 168 px of the 390 (a 198 px area, a 50 px drawing). The track's title stays the
// page's first heading, in view in the band, read whole and shown whole on hover.

// Animations end at once, so positions are final when they are read.
test.use({ reducedMotion: "reduce" });

// Nothing leaves the machine: the recording's cover is answered on the page.
test.beforeEach(async ({ page }) => {
  await offline(page);
});

const ANALYZE = "/api/analyze/stream";
const SIZES = [
  [844, 390],
  [932, 430],
] as const;

/** The recorded demo run: a replayed result, with its label, and a drawn connections graph. */
async function openRecording(page: Page) {
  const { events } = replayedRecording();
  await useMockApi(page, { suggestions: [], eventGapMs: 0, streams: { [ANALYZE]: events } });
  await analyzeAndOpenDashboard(page, "One More Time Daft Punk");
  await openPlayer(page);
}

/** The full-result fixture with the result's title and artist replaced. */
function withTrack(track: { title: string; artist: string }) {
  const fixture = loadFixture("full-result");
  const events = fixture.streams[ANALYZE] as Array<{ type: string; data?: object }>;
  fixture.streams[ANALYZE] = events.map((event) =>
    event.type === "complete" ? { ...event, data: { ...event.data, ...track } } : event,
  );
  return fixture;
}

const LONG = {
  title: `${"Superlongunbrokenwordtitle".repeat(4)} (Extended Club Mix)`,
  artist: "Somebody Featuring Somebody Else and the Rest of the Band",
};

/** Whether the element is shown whole in the window, without scrolling. */
function inView(target: Locator) {
  return target.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return (
      box.width > 0 &&
      box.height > 0 &&
      box.top >= -0.5 &&
      box.left >= -0.5 &&
      box.bottom <= innerHeight + 0.5 &&
      box.right <= innerWidth + 0.5
    );
  });
}

/** Whether the page's first heading, in the page's order, is its h1. */
function h1First(page: Page) {
  return page.evaluate(() => document.querySelector("h1, h2, h3, h4, h5, h6")?.tagName === "H1");
}

for (const [width, height] of SIZES) {
  test(`at ${width}×${height} the panels' area is at least 280 px tall and the graph's drawing at least 140 px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await openRecording(page);
    const area = page.locator("[data-player-columns]");
    expect(await area.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(280);

    // The graph's row, scrolled into view at the bottom of the area: its drawing (not the
    // legend under it) at least 140 px tall, and the row shorter than the area, so a strip of
    // the area beside it is left to scroll by.
    await area.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const graph = page.locator('#panel-genealogy svg[aria-label="Connections graph"]');
    await expect(graph).toBeVisible();
    expect((await graph.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(140);
    const row = await page.locator("#panel-genealogy").boundingBox();
    const shown = await area.evaluate((element) => element.clientHeight);
    expect(row?.height ?? 0).toBeLessThan(shown);

    // The band keeps what it said: the title (the first heading), the way back, the recording's
    // label (once), the audio line and the way to the connections, each in view.
    expect(await h1First(page)).toBe(true);
    const shownLabels = page
      .getByRole("region", { name: "Recorded run" })
      .filter({ visible: true });
    await expect(shownLabels).toHaveCount(1);
    for (const element of [
      page.getByRole("heading", { level: 1, name: "One More Time" }),
      page.getByRole("button", { name: /Back to summary/ }),
      page.getByRole("button", { name: "New search" }),
      shownLabels,
      page.getByTestId("player-audio-line"),
      page.locator("#player-header").getByRole("button", { name: "Connections" }),
    ]) {
      expect(await inView(element)).toBe(true);
    }
    expect(await clippedLines(page)).toEqual([]);
    // Nothing runs past the window sideways.
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBe(0);
  });

  // The header is one line of title in the band: a long title is cut there with an ellipsis, read
  // whole (the heading's name) and shown whole on hover (its title), and stays the first heading.
  test(`at ${width}×${height} a long title takes one line in view, read whole`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await useMockApi(page, withTrack(LONG));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    const title = page.getByRole("heading", { level: 1, name: LONG.title });
    await expect(title).toBeVisible();
    await expect(title).toHaveAttribute("title", LONG.title);
    expect(await h1First(page)).toBe(true);
    expect(await inView(title)).toBe(true);
    const lines = await title.evaluate((element) => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      return Math.round(element.getBoundingClientRect().height / lineHeight);
    });
    expect(lines).toBe(1);
    await expect(page.locator("#player-header p").first()).toHaveAttribute("title", LONG.artist);
    expect(
      await page.locator("[data-player-columns]").evaluate((e) => e.clientHeight),
    ).toBeGreaterThanOrEqual(280);
  });
}
