import { expect, type Page, test } from "@playwright/test";
import { clippedLines } from "./clipping";
import {
  analyzeAndOpenDashboard,
  dashboardHeading,
  loadFixture,
  openPlayer,
  replayedRecording,
  useMockApi,
} from "./mock";
import { offline } from "./offline";

// The Player's layout by width. Below md (768 px): one panel at a time, chosen with the tabs, each
// with a heading of its own on screen. From md up to xl (1280 px): two columns, the notes and the
// player, with the connections as a full-width row below them. From xl: three columns. At every
// width no line of text is cut and nothing runs past the window sideways. The track's header
// above the columns stays short: a long title takes no more than two lines of the panels' height.

// Animations end at once, so positions are final when they are read.
test.use({ reducedMotion: "reduce" });

// Nothing leaves the machine: the recording's cover and any other outside address are answered
// on the page.
test.beforeEach(async ({ page }) => {
  await offline(page);
});

const ANALYZE = "/api/analyze/stream";
const WIDTHS = [768, 820, 1024, 1280, 1440];

type Box = { x: number; y: number; width: number; height: number };

/** The box of each of the Player's panels. */
async function panels(page: Page) {
  const box = async (id: string) => {
    const found = await page.locator(`#${id}`).boundingBox();
    if (!found) throw new Error(`#${id} has no box`);
    return found as Box;
  };
  return {
    notes: await box("panel-context"),
    player: await box("panel-player"),
    connections: await box("panel-genealogy"),
  };
}

/**
 * The Player's boxes that scroll sideways (their content is wider than they are, and they let it
 * scroll), and how far the page itself does. Boxes that let nothing scroll pass their overflow on
 * to the box around them, so the page and the scrolling boxes are where it shows.
 */
function overflow(page: Page) {
  return page.evaluate(() => {
    const root = document.documentElement;
    const scrolls = (element: HTMLElement) => {
      const { overflowX } = getComputedStyle(element);
      return overflowX === "auto" || overflowX === "scroll";
    };
    const wide = [
      ...document.querySelectorAll<HTMLElement>(
        // By id: from md up the panels are columns, not tab panels.
        "#player-header, [data-player-columns], #panel-context, #panel-player, #panel-genealogy, [role=tablist]",
      ),
    ]
      .filter(
        (element) =>
          element.getClientRects().length > 0 &&
          scrolls(element) &&
          element.scrollWidth > element.clientWidth + 1,
      )
      .map((element) => element.id || element.getAttribute("role") || element.tagName);
    return { page: root.scrollWidth - root.clientWidth, wide };
  });
}

async function openRecording(page: Page) {
  const { events } = replayedRecording();
  await useMockApi(page, { suggestions: [], eventGapMs: 0, streams: { [ANALYZE]: events } });
  await analyzeAndOpenDashboard(page, "One More Time Daft Punk");
  await openPlayer(page);
}

test("at 820 px the notes and the player are two columns, with the connections below", async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 1180 });
  await openRecording(page);
  const { notes, player, connections } = await panels(page);
  // Side by side, at the same height, the notes on the left, each half the window.
  expect(Math.abs(notes.y - player.y)).toBeLessThan(1);
  expect(notes.x).toBeLessThan(player.x);
  expect(notes.width).toBeGreaterThanOrEqual(400);
  expect(player.width).toBeGreaterThanOrEqual(400);
  expect(Math.round(notes.width + player.width)).toBe(820);
  // The connections: one row, the window's whole width, below both columns, tall enough for
  // the graph.
  expect(connections.x).toBe(0);
  expect(Math.round(connections.width)).toBe(820);
  expect(connections.y).toBeGreaterThanOrEqual(
    Math.max(notes.y + notes.height, player.y + player.height) - 1,
  );
  expect(connections.height).toBeGreaterThanOrEqual(352);
  // The panels' area scrolls down to them, and their heading and graph are there.
  await page.locator("#panel-genealogy").scrollIntoViewIfNeeded();
  await expect(page.getByRole("heading", { name: "Connections" })).toBeVisible();
  await expect(page.locator('#panel-genealogy svg[aria-label="Connections graph"]')).toBeVisible();
});

for (const width of [1280, 1440]) {
  test(`at ${width} px the Player shows three columns`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openRecording(page);
    const { notes, player, connections } = await panels(page);
    expect(Math.abs(notes.y - player.y)).toBeLessThan(1);
    expect(Math.abs(player.y - connections.y)).toBeLessThan(1);
    expect(notes.x).toBeLessThan(player.x);
    expect(player.x).toBeLessThan(connections.x);
    // A quarter, a half and a quarter of the window.
    expect(Math.round(notes.width)).toBe(width / 4);
    expect(Math.round(player.width)).toBe(width / 2);
    expect(Math.round(connections.width)).toBe(width / 4);
  });
}

for (const width of WIDTHS) {
  for (const showcase of ["recording", "provenance"] as const) {
    test(`at ${width} px nothing in the Player is cut or runs past the window (${showcase})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      if (showcase === "recording") await openRecording(page);
      else {
        await useMockApi(page, loadFixture("provenance"));
        await analyzeAndOpenDashboard(page, "Paper Lanterns");
        await openPlayer(page);
      }
      await expect(page.locator("#panel-context")).toBeVisible();
      // Open what opens, so its lines are checked too: the rejected claims, and the graph's
      // links as a list (whose lines name long record ids).
      const rejected = page.getByRole("button", { name: /Rejected by the verifier/ });
      if ((await rejected.count()) > 0) await rejected.click();
      const linkList = page.locator("#panel-genealogy summary", { hasText: "Links as a list" });
      if ((await linkList.count()) > 0) await linkList.click();
      expect(await clippedLines(page)).toEqual([]);
      expect(await overflow(page)).toEqual({ page: 0, wide: [] });
    });
  }
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

// A title of three lines or more at these widths unclamped (four at 1024 px, three at 1280 px),
// and a long artist.
const LONG = {
  title: `${"Superlongunbrokenwordtitle".repeat(6)} (Extended Club Mix)`,
  artist: "Somebody Featuring Somebody Else and the Rest of the Band",
};
const SHORT = { title: "Bright Lines", artist: "Test Artist" };

/** The height the panels get: the panels' area, and the player panel itself. */
async function panelHeights(page: Page) {
  const panel = page.locator("#panel-player");
  const area = await panel.evaluate((element) => element.parentElement?.clientHeight ?? 0);
  return { area, player: (await panel.boundingBox())?.height ?? 0 };
}

// The header band above the columns has a fixed height: a long title must not take the panels'
// height. With the title cut at two lines the panels keep what a two-line title leaves (on main,
// unclamped, this title left 346 px at 1024×600 and 501 px at 1280×720), and a one-line title
// keeps what it had (450 and 570 px).
for (const [width, height, long, short] of [
  [1024, 600, 410, 449],
  [1280, 720, 534, 569],
]) {
  test(`at ${width}×${height} a long title leaves the panels their height`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await useMockApi(page, withTrack(LONG));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    const heights = await panelHeights(page);
    expect(heights.area).toBeGreaterThanOrEqual(long);
    expect(heights.player).toBeGreaterThanOrEqual(long);
    // In two lines at most.
    const lines = await page.getByRole("heading", { level: 1 }).evaluate((element) => {
      const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
      return Math.round(element.getBoundingClientRect().height / lineHeight);
    });
    expect(lines).toBeLessThanOrEqual(2);
  });

  // A guard: a one-line title takes no more of the height than it did before the cut.
  test(`at ${width}×${height} a short title keeps the panels' height`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await useMockApi(page, withTrack(SHORT));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    const heights = await panelHeights(page);
    expect(heights.area).toBeGreaterThanOrEqual(short);
    expect(heights.player).toBeGreaterThanOrEqual(short);
  });
}

// The title cut at two lines is read whole (the heading's text) and shown whole on hover.
test("a long title cut in the header is read whole and shown whole on hover", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 600 });
  await useMockApi(page, withTrack(LONG));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  const title = page.getByRole("heading", { level: 1 });
  await expect(title).toHaveText(LONG.title);
  await expect(title).toHaveAttribute("title", LONG.title);
  await expect(page.locator("#player-header p").first()).toHaveAttribute("title", LONG.artist);
});

// At 320 px the two buttons above the panels each keep their label on one line and stay inside
// the window: no label broken in two, no button past the edge.
test("at 320 px the Back to summary and New search buttons fit their row", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await useMockApi(page, loadFixture("full-result"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  for (const name of [/Back to summary/, /New search/]) {
    const button = page.getByRole("button", { name });
    const fit = await button.evaluate((element) => {
      // The lines the label's text takes (its icon is not text).
      const tops = new Set<number>();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim() || node.parentElement?.closest(".hidden, [hidden]")) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          if (rect.width > 0) tops.add(Math.round(rect.top));
        }
      }
      const lines = tops;
      const box = element.getBoundingClientRect();
      return {
        lines: lines.size,
        inside: box.left >= 0 && box.right <= document.documentElement.clientWidth,
        whole: element.scrollWidth <= element.clientWidth + 1,
      };
    });
    expect(fit, String(name)).toEqual({ lines: 1, inside: true, whole: true });
  }
  expect(await overflow(page)).toEqual({ page: 0, wide: [] });
  // The Player tab keeps the height it had (446 px).
  const box = await page.locator("#panel-player").boundingBox();
  expect(box?.height ?? 0).toBeGreaterThanOrEqual(440);
});

// On a 280 px screen (a folding phone's outer screen) the two buttons do not fit one row: the
// second moves under the first, each label still on one line and inside the window.
test("at 280 px the second button above the panels moves under the first", async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 653 });
  await useMockApi(page, loadFixture("full-result"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  const back = await page.getByRole("button", { name: /Back to summary/ }).boundingBox();
  const search = await page.getByRole("button", { name: /New search/ }).boundingBox();
  if (!back || !search) throw new Error("a button is missing");
  expect(search.y).toBeGreaterThanOrEqual(back.y + back.height - 1);
  for (const box of [back, search]) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(280);
  }
  expect(await overflow(page)).toEqual({ page: 0, wide: [] });
});

/** The full-result fixture with its connected track's link citing `ids`, and `claims` added. */
function withLinkCiting(ids: string[], claims: Array<Record<string, unknown>> = []) {
  const fixture = loadFixture("full-result");
  const complete = fixture.streams[ANALYZE].find(
    (event: { type: string }) => event.type === "complete",
  );
  complete.data.genealogy.links[0].evidenceIds = ids;
  complete.data.claims = claims;
  return fixture;
}

// A record id is one word with no place to break: in the graph's list of links, in a narrow
// column, it breaks anywhere rather than run past the list.
test("at 1280 px the links list breaks a long record id inside its column", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await useMockApi(page, withLinkCiting([`ev${"x".repeat(150)}`]));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  await page.locator("#panel-genealogy summary", { hasText: "Links as a list" }).click();
  const list = page.getByRole("list", { name: "Genealogy links" });
  await expect(list).toContainText("xxxxxxxx");
  expect(await clippedLines(page, ["panel-genealogy"])).toEqual([]);
  expect(await list.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
});

// A claim with a word longer than any column (a pasted run of letters) wraps inside it.
for (const width of [390, 820, 1280]) {
  test(`at ${width} px a claim with a 102-letter word stays inside its column`, async ({
    page,
  }) => {
    const fixture = loadFixture("provenance");
    const complete = fixture.streams[ANALYZE].find(
      (event: { type: string }) => event.type === "complete",
    );
    const word = "a".repeat(102);
    for (const claim of complete.data.claims as Array<{ id: string; text: string }>) {
      if (["c-writers", "c-blog", "c-sample-kept", "c-club"].includes(claim.id)) {
        claim.text = `${claim.text} ${word}`;
      }
    }
    await page.setViewportSize({ width, height: 900 });
    await useMockApi(page, fixture);
    await analyzeAndOpenDashboard(page, "Paper Lanterns");
    await openPlayer(page);
    if (width < 768) await page.getByRole("tab", { name: "Analysis" }).click();
    await expect(page.locator("#panel-context")).toContainText(word.slice(0, 40));
    expect(await clippedLines(page, ["panel-context"])).toEqual([]);
    expect(await overflow(page)).toEqual({ page: 0, wide: [] });
  });
}

/** The scale of the graph's zoom (1 before any zoom), from its drawing's transform. */
function graphScale(page: Page) {
  return page.locator('#panel-genealogy svg[aria-label="Connections graph"] > g').evaluate((g) => {
    const match = /scale\(([\d.]+)/.exec(g.getAttribute("transform") ?? "");
    return match ? Number(match[1]) : 1;
  });
}

/** The panels' area: how far it is scrolled, and how far it can be. */
function areaScroll(page: Page) {
  return page.locator("[data-player-columns]").evaluate((area) => ({
    top: Math.round(area.scrollTop),
    end: area.scrollHeight - area.clientHeight,
  }));
}

/** Puts the pointer over the middle of the graph's drawing. */
async function pointAtGraph(page: Page) {
  const box = await page
    .locator('#panel-genealogy svg[aria-label="Connections graph"]')
    .boundingBox();
  if (!box) throw new Error("the graph is not drawn");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
}

// From md up to xl the connections are a full-width row in a scrolling area: the wheel over the
// graph scrolls the area (it would otherwise be stuck there, zooming), and Ctrl with the wheel
// zooms the graph. (Touch: below.)
for (const [width, height] of [
  [1024, 600],
  [820, 1180],
]) {
  test(`at ${width}×${height} the wheel over the graph scrolls the panels, Ctrl with it zooms`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await openRecording(page);
    // The area scrolled to its bottom, where the graph's row is, the pointer over the graph.
    await page.locator("[data-player-columns]").evaluate((area) => {
      area.scrollTop = area.scrollHeight;
    });
    await pointAtGraph(page);
    const scale = await graphScale(page);
    const before = await areaScroll(page);
    expect(before.top).toBe(before.end);
    // Up and down again: the area scrolls each way, and the graph keeps its zoom.
    for (let turn = 0; turn < 4; turn++) await page.mouse.wheel(0, -200);
    await expect.poll(async () => (await areaScroll(page)).top).toBeLessThan(before.top);
    for (let turn = 0; turn < 40; turn++) await page.mouse.wheel(0, 300);
    await expect.poll(async () => (await areaScroll(page)).top).toBe(before.end);
    expect(await graphScale(page)).toBe(scale);

    await pointAtGraph(page);
    const scrolled = await areaScroll(page);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -100);
    await page.keyboard.up("Control");
    await expect.poll(() => graphScale(page)).toBeGreaterThan(scale);
    expect((await areaScroll(page)).top).toBe(scrolled.top);
    // The graph's hint says so (shown while the pointer is on no track).
    await page.mouse.move(1, 1);
    await expect(page.getByText("Ctrl or ⌘ + scroll to zoom")).toBeAttached();
  });
}

// From xl the graph is a column of its own and nothing scrolls behind it (nor on a phone's
// Connections tab): there the wheel zooms the graph, and the hint says so.
test("at 1440 px the wheel over the graph zooms it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRecording(page);
  await pointAtGraph(page);
  const scale = await graphScale(page);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => graphScale(page)).toBeGreaterThan(scale);
  await page.mouse.move(1, 1);
  await expect(page.getByText("Scroll to zoom", { exact: true })).toBeVisible();
  await expect(page.getByText("Ctrl or ⌘ + scroll to zoom")).toHaveCount(0);
});

test("on a phone's Connections tab the wheel zooms the graph", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRecording(page);
  await page.getByRole("tab", { name: "Connections" }).click();
  await pointAtGraph(page);
  const scale = await graphScale(page);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => graphScale(page)).toBeGreaterThan(scale);
});

// On a phone the Player tab never scrolls sideways: a timeline tooltip, hidden at rest, reaches a
// few pixels past it, and a sideways swipe or wheel must not move the tab.
for (const width of [320, 390]) {
  test(`on a ${width} px phone the Player tab does not scroll sideways`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await openRecording(page);
    const panel = page.locator("#panel-player");
    const box = await panel.boundingBox();
    if (!box) throw new Error("the Player tab is not shown");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(300, 0);
    await page.waitForTimeout(200);
    expect(await panel.evaluate((element) => element.scrollLeft)).toBe(0);
    expect(await overflow(page)).toEqual({ page: 0, wide: [] });
  });
}

/** A one-finger swipe from (x, y), moving the finger by `dy` px (down when positive). */
async function swipe(page: Page, x: number, y: number, dy: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
  for (let step = 1; step <= 12; step++) {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchMove",
      touchPoints: [{ x, y: y + (dy * step) / 12 }],
    });
    await page.waitForTimeout(16);
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  await page.waitForTimeout(400);
  await cdp.detach();
}

/** How far the graph's drawing is panned down (d3's zoom state on the svg). */
function graphPan(page: Page) {
  return page
    .locator('#panel-genealogy svg[aria-label="Connections graph"]')
    .evaluate((svg) =>
      Math.round((svg as SVGSVGElement & { __zoom?: { y: number } }).__zoom?.y ?? 0),
    );
}

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true });

  // From md up to xl one finger over the graph scrolls the panels' area, as anywhere else on the
  // page (it would otherwise pan the graph, and on a landscape phone the graph fills the view),
  // and the graph's row leaves part of the area beside it to grab. Two fingers pinch the graph.
  for (const [width, height] of [
    [844, 390],
    [820, 1180],
    [1024, 768],
  ] as const) {
    test(`at ${width}×${height} one finger over the graph scrolls the panels`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openRecording(page);
      const area = page.locator("[data-player-columns]");
      const row = await page.locator("#panel-genealogy").boundingBox();
      const shown = await area.evaluate((element) => element.clientHeight);
      expect(row?.height ?? 0).toBeLessThan(shown);
      // At the bottom of the area, the graph in view; a finger drawn down over the graph.
      await area.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
      });
      const graph = await page
        .locator('#panel-genealogy svg[aria-label="Connections graph"]')
        .boundingBox();
      const areaBox = await area.boundingBox();
      if (!graph || !areaBox) throw new Error("the graph is not drawn");
      // The finger lands on the drawing itself, not on the legend under it.
      expect(graph.height).toBeGreaterThan(20);
      const top = Math.max(graph.y, areaBox.y);
      const bottom = Math.min(graph.y + graph.height, areaBox.y + areaBox.height);
      const before = await areaScroll(page);
      const pan = await graphPan(page);
      await swipe(page, graph.x + graph.width / 2, top + 10, Math.max(40, bottom - top - 20));
      expect((await areaScroll(page)).top).toBeLessThan(before.top);
      expect(await graphPan(page)).toBe(pan);
      // The hint names the touch gestures; on a short screen it is left out, so as not to cover
      // the drawing.
      const hint = page.getByText("Pinch with two fingers to zoom");
      await expect(hint).toBeAttached();
      if (height > 512) await expect(hint).toBeVisible();
      else await expect(hint).toBeHidden();
      await expect(page.getByText("Ctrl or ⌘ + scroll to zoom")).toHaveCount(0);
    });
  }

  // On a phone's Connections tab nothing scrolls behind the graph: one finger pans it.
  test("on a phone's Connections tab one finger pans the graph", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openRecording(page);
    await page.getByRole("tab", { name: "Connections" }).click();
    const graph = await page
      .locator('#panel-genealogy svg[aria-label="Connections graph"]')
      .boundingBox();
    if (!graph) throw new Error("the graph is not drawn");
    const pan = await graphPan(page);
    // From an empty corner of the drawing (a track there would be dragged instead).
    await swipe(page, graph.x + 20, graph.y + 40, 120);
    expect(await graphPan(page)).toBeGreaterThan(pan);
  });
});

// Escape closes what is open where the reader is; something open far out of view (the links list
// at the bottom, the reader at the top) is left open, and Escape goes back to the summary, as
// when nothing is open: it never jumps the page to a toggle about 2000 px away.
test("Escape with an open list out of view goes back, and does not jump the page", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openRecording(page);
  const area = page.locator("[data-player-columns]");
  await area.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await page.locator("#panel-genealogy summary", { hasText: "Links as a list" }).click();
  await area.evaluate((element) => {
    element.scrollTop = 0;
  });
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await expect(dashboardHeading(page)).toBeVisible();
  await expect(page.getByRole("button", { name: /Back to summary/ })).toHaveCount(0);
});

test("Escape with an open list in view closes it and stays", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await openRecording(page);
  const area = page.locator("[data-player-columns]");
  await area.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const list = page.locator("#panel-genealogy details", { hasText: "Links as a list" });
  await list.locator("summary").click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const top = await area.evaluate((element) => element.scrollTop);
  await page.keyboard.press("Escape");
  await expect(list).not.toHaveAttribute("open", "");
  await expect(page.getByRole("button", { name: /Back to summary/ })).toBeVisible();
  expect(await area.evaluate((element) => element.scrollTop)).toBe(top);
});
