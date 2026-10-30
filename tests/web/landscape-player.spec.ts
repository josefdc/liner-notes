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

/** A fixture (full-result by default) with fields of its result replaced. */
function patched(patch: Record<string, unknown>, name = "full-result") {
  const fixture = loadFixture(name);
  const events = fixture.streams[ANALYZE] as Array<{ type: string; data?: object }>;
  fixture.streams[ANALYZE] = events.map((event) =>
    event.type === "complete" ? { ...event, data: { ...event.data, ...patch } } : event,
  );
  return fixture;
}

/** The full-result fixture with the result's title and artist replaced. */
function withTrack(track: { title: string; artist: string }) {
  return patched(track);
}

/**
 * A result whose model answers were replayed from a recording with no stored date: the widest
 * label the app writes ("Model answers replayed · recording date not stored").
 */
const MODEL_ANSWERS = {
  run: {
    id: "thread-model-answers",
    mode: "replay",
    replayed: "model_answers",
    recordedAt: null,
    commit: null,
    analyzerVersion: null,
  },
};

/** WCAG 1.4.12's text spacing, set over the page's own. */
const TEXT_SPACING = `
  * { line-height: 1.5 !important; letter-spacing: 0.12em !important; word-spacing: 0.16em !important; }
  p { margin-bottom: 2em !important; }
`;

/** Whether the element shows all of its text: nothing cut by a clamp or its own box. */
function whole(target: Locator) {
  return target.evaluate(
    (element) =>
      element.scrollHeight <= element.clientHeight + 1 &&
      element.scrollWidth <= element.clientWidth + 1,
  );
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

// Titles of ordinary length (up to about 40 characters) are shown whole in the band, also with
// WCAG 1.4.12's text spacing; on a touch screen there is no hover to read a cut title.
const ORDINARY = [
  { title: "Everybody Wants to Rule the World", artist: "Tears for Fears" },
  { title: "Bohemian Rhapsody - Remastered 2011", artist: "Queen" },
  { title: "Everybody Wants to Rule the World - 2014", artist: "Tears for Fears" },
];

for (const [width, height] of SIZES) {
  for (const track of ORDINARY) {
    test(`at ${width}×${height} "${track.title}" is shown whole`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await useMockApi(page, withTrack(track));
      await analyzeAndOpenDashboard(page, "Bright Lines");
      await openPlayer(page);
      const title = page.getByRole("heading", { level: 1, name: track.title });
      expect(await whole(title)).toBe(true);
      expect(await inView(title)).toBe(true);
      await page.addStyleTag({ content: TEXT_SPACING });
      expect(await whole(title)).toBe(true);
      expect(await inView(title)).toBe(true);
    });
  }

  test(`at ${width}×${height} with WCAG 1.4.12 text spacing the demo title is shown whole`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await openRecording(page);
    await page.addStyleTag({ content: TEXT_SPACING });
    const title = page.getByRole("heading", { level: 1, name: "One More Time" });
    expect(await whole(title)).toBe(true);
    expect(await inView(title)).toBe(true);
    // Nothing else in the band is cut, nor runs past the window.
    expect(await clippedLines(page)).toEqual([]);
    for (const element of [
      page.getByRole("region", { name: "Recorded run" }).filter({ visible: true }),
      page.getByTestId("player-audio-line"),
      page.locator("#player-header").getByRole("button", { name: "Connections" }),
    ]) {
      expect(await inView(element)).toBe(true);
    }
  });

  // A title too long for one line is cut in the band; the Player column shows it whole, under
  // the cover, where it scrolls with the column (as on phones).
  test(`at ${width}×${height} a title cut in the band is shown whole in the Player column`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await useMockApi(page, withTrack(LONG));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    const shown = page.locator("#panel-player").getByText(LONG.title, { exact: true });
    await shown.scrollIntoViewIfNeeded();
    await expect(shown).toBeVisible();
    expect(await whole(shown)).toBe(true);
    expect(await inView(shown)).toBe(true);
  });

  // A connections legend with every kind of relation and a hidden link: the legend stays compact
  // in the short window, so the drawing keeps 140 px.
  test(`at ${width}×${height} the graph of a result with every kind of link keeps 140 px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await useMockApi(page, loadFixture("genealogy-kinds"));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    const area = page.locator("[data-player-columns]");
    expect(await area.evaluate((element) => element.clientHeight)).toBeGreaterThanOrEqual(280);
    await area.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const graph = page.locator('#panel-genealogy svg[aria-label="Connections graph"]');
    await expect(graph).toBeVisible();
    expect((await graph.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(140);
    const row = await page.locator("#panel-genealogy").boundingBox();
    expect(row?.height ?? 0).toBeLessThan(await area.evaluate((element) => element.clientHeight));
  });
}

// The widest recording label, with a full audio line (BPM, key, preview): the label wraps rather
// than take the title's room, the title keeps a readable width, and the audio line and the way to
// the connections stay in the window. The label is read where it is on main: after the artist,
// before the audio line.
for (const [width, height] of [[768, 400], ...SIZES] as const) {
  test(`at ${width}×${height} the widest recording label leaves the title its room`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await useMockApi(page, patched(MODEL_ANSWERS, "measured-v2"));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    const label = page
      .getByRole("region", { name: "Replayed model answers" })
      .filter({ visible: true });
    await expect(label).toHaveCount(1);
    await expect(label).toContainText("recording date not stored");
    const title = page.getByRole("heading", { level: 1 });
    // 12rem
    expect((await title.boundingBox())?.width ?? 0).toBeGreaterThanOrEqual(192);
    const audio = page.getByTestId("player-audio-line");
    await expect(audio).toContainText("BPM");
    for (const element of [
      title,
      label,
      audio,
      page.locator("#player-header").getByRole("button", { name: "Connections" }),
      page.getByRole("button", { name: /Back to summary/ }),
      page.getByRole("button", { name: "New search" }),
    ]) {
      expect(await inView(element)).toBe(true);
    }
    expect(await clippedLines(page)).toEqual([]);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      ),
    ).toBe(0);
    expect(
      await page.locator("[data-player-columns]").evaluate((element) => element.clientHeight),
    ).toBeGreaterThanOrEqual(280);
    // In the page's order: the artist, the label, then the audio line.
    const order = await page.evaluate(() => {
      const artist = document.querySelector("#player-header h1 + p");
      const shownLabel = [
        ...document.querySelectorAll('section[aria-label="Replayed model answers"]'),
      ].find((section) => section.getClientRects().length > 0);
      const line = document.querySelector('[data-testid="player-audio-line"]');
      if (!artist || !shownLabel || !line) return null;
      const follows = (a: Node, b: Node) =>
        Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
      return follows(artist, shownLabel) && follows(shownLabel, line);
    });
    expect(order).toBe(true);
  });
}
