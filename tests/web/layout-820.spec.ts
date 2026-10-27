import { expect, type Page, test } from "@playwright/test";
import { clippedLines } from "./clipping";
import {
  analyzeAndOpenDashboard,
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
        "#player-header, [data-player-columns], [role=tabpanel], [role=tablist]",
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

// A title of three lines or more at these widths, and a long artist.
const LONG = {
  title: `${"Superlongunbrokenwordtitle".repeat(4)} (Extended Club Mix)`,
  artist: "Somebody Featuring Somebody Else and the Rest of the Band",
};
const SHORT = { title: "Bright Lines", artist: "Test Artist" };

// The header band above the columns has a fixed height: a long title must not take the panels'
// height. The height the panels get (the panels' area, and the player panel itself) is at least
// what it was with the long title in three lines (381 px at 1024×600; 535 px at 1280×720, where
// it took two) and close to what a one-line title leaves, which keeps its height (450 and 570 px).
for (const [width, height, long, short] of [
  [1024, 600, 410, 449],
  [1280, 720, 535, 569],
]) {
  for (const [track, least] of [
    [LONG, long],
    [SHORT, short],
  ] as const) {
    test(`at ${width}×${height} a ${track === LONG ? "long" : "short"} title leaves the panels their height`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await useMockApi(page, withTrack(track));
      await analyzeAndOpenDashboard(page, "Bright Lines");
      await openPlayer(page);
      const title = page.getByRole("heading", { level: 1 });
      // Read whole, shown whole on hover, in two lines at most.
      await expect(title).toHaveText(track.title);
      await expect(title).toHaveAttribute("title", track.title);
      const lines = await title.evaluate((element) => {
        const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight);
        return Math.round(element.getBoundingClientRect().height / lineHeight);
      });
      expect(lines).toBeLessThanOrEqual(2);
      const panel = page.locator("#panel-player");
      const area = await panel.evaluate((element) => element.parentElement?.clientHeight ?? 0);
      expect(area).toBeGreaterThanOrEqual(least);
      expect((await panel.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(least);
    });
  }
}

// On phones each tab's panel opens with a heading on screen, so the open section is named where
// it is shown, not only in the tab bar.
for (const [width, height] of [
  [320, 568],
  [390, 844],
]) {
  test(`on a ${width} px phone each tab shows a heading`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await openRecording(page);
    for (const [tab, panel, heading] of [
      ["Analysis", "panel-context", "Facts"],
      ["Player", "panel-player", "Player"],
      ["Connections", "panel-genealogy", "Connections"],
    ]) {
      await page.getByRole("tab", { name: tab }).click();
      const open = page.locator(`#${panel}`);
      await expect(open).toBeVisible();
      const first = open.getByRole("heading").first();
      await expect(first).toHaveText(heading);
      await expect(first).toBeVisible();
      const box = await first.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThan(1);
      expect(box?.height ?? 0).toBeGreaterThan(1);
    }
  });
}

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
