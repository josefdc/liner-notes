import { expect, type Page, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  animationsSettled,
  apiRequests,
  collectProblems,
  dashboardHeading,
  fullResultData,
  loadFixture,
  releaseStream,
  useMockApi,
} from "./mock";

// The Dashboard's own behaviour. A connected track's card starts its analysis at once, with no
// undo toast and no Ctrl+Z shortcut: Stop on the progress screen, then "Back to the last result"
// on the search, is the way back. The card names the track by its own title and artist, and its
// relation in the words the graph uses. On phones the album row is centred under the title.

const ANALYZE = "/api/analyze/stream";
const status = (node: string, message: string, code?: string) => ({
  type: "status",
  node,
  message,
  ...(code ? { code } : {}),
});

type Result = { genealogy: { nodes: Array<Record<string, unknown>> } };

/**
 * The first run: Bright Lines, with one connected track, "Older Record - Someone (1984)", whose
 * node names its title and artist (`trackTitle`, `trackArtist`): a card takes the artist from
 * there only, never from the label.
 */
const firstResult = structuredClone(fullResultData()) as Result;
firstResult.genealogy.nodes = firstResult.genealogy.nodes.map((node) =>
  node.id === "origin1" ? { ...node, trackTitle: "Older Record", trackArtist: "Someone" } : node,
);
const firstRun = [
  { type: "connected", threadId: "t-first" },
  status("scout", "Found the track on Spotify", "SPOTIFY-FOUND"),
  { type: "complete", data: firstResult },
  { type: "done" },
];

/**
 * The connected track's run, held after its first lines until the test releases it. Its result
 * is another track's (Older Record), so a restore that showed it instead of the earlier result
 * would be seen.
 */
const heldRun = [
  { type: "connected", threadId: "t-held" },
  status("scout", "Reading the track from Spotify", "NET-100"),
  { $wait: "held" },
  status("historian", "A line after the stop", "RESEARCH-FOUND"),
  {
    type: "complete",
    data: {
      ...(fullResultData() as Record<string, unknown>),
      id: "4iV5W9uYEdYUVa79Axb7Rh",
      title: "Older Record",
      artist: "Someone",
    },
  },
  { type: "done" },
];

/** True when a Ctrl+Z (Cmd+Z on a Mac) pressed now is taken by the page. */
async function undoIsTaken(page: Page) {
  return page.evaluate(() => {
    const event = new KeyboardEvent("keydown", {
      key: "z",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event.defaultPrevented;
  });
}

test("a connected track's card analyses it with no undo toast; Stop and the last result bring it back", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, {
    suggestions: [],
    streams: { [ANALYZE]: { opens: [firstRun, heldRun] } },
  });
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await expect(dashboardHeading(page)).toHaveText("Bright Lines");

  // The card names the track by its own title and artist, and its relation as the graph does.
  const card = page.getByRole("button").filter({ hasText: "Relation:" });
  await expect(card).toHaveCount(1);
  await expect(card.locator("[data-card-title]")).toHaveText("Older Record");
  await expect(card.locator("[data-card-artist]")).toHaveText("Someone");
  await expect(card.locator("[data-link-kind]")).toHaveText("Relation: Possible sample");

  await card.click();
  await expect(page.getByRole("log")).toContainText("Reading the track from Spotify");
  // No undo toast, no announcement of one, and Ctrl+Z is left to the browser.
  await expect(page.getByRole("button", { name: /undo/i })).toHaveCount(0);
  await expect(page.getByText(/Ctrl\+Z|Analyzing Older Record/)).toHaveCount(0);
  expect(await undoIsTaken(page)).toBe(false);
  await page.keyboard.press("Control+z");
  await expect(page.getByRole("log")).toContainText("Reading the track from Spotify");
  expect((await apiRequests(page)).filter((entry) => entry.startsWith("stream "))).toHaveLength(2);

  // Stop, then back to the last result: the earlier result, whatever the stopped run sends.
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await releaseStream(page, "held");
  const back = page.getByRole("button", { name: "Back to the last result" });
  await expect(back).toBeVisible();
  await back.click();
  await expect(dashboardHeading(page)).toHaveText("Bright Lines");
  await expect(page.getByRole("heading", { level: 1, name: "Older Record" })).toHaveCount(0);
  await expect(page.getByText("A line after the stop")).toHaveCount(0);
  expect(await undoIsTaken(page)).toBe(false);
  await expect(page.getByRole("button", { name: /undo/i })).toHaveCount(0);
  expect(problems).toEqual([]);
});

// Phones, from the smallest supported width to the common large ones.
for (const width of [320, 390, 414]) {
  test(`the album row is centred under the title at ${width} px`, async ({ page }) => {
    await useMockApi(page, loadFixture("full-result"));
    await page.setViewportSize({ width, height: 800 });
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await animationsSettled(page);
    // The row under the title and the artist: the album, the year and the explicit badge.
    const row = dashboardHeading(page).locator("xpath=following-sibling::div[1]");
    await expect(row).toContainText("Test Album");
    // The middle of what the row shows (its children), against the middle of the window.
    const offset = await row.evaluate((element) => {
      const boxes = [...element.children].map((child) => child.getBoundingClientRect());
      const left = Math.min(...boxes.map((box) => box.left));
      const right = Math.max(...boxes.map((box) => box.right));
      return (left + right) / 2 - document.documentElement.clientWidth / 2;
    });
    expect(Math.abs(offset)).toBeLessThanOrEqual(2);
    // And it stays left-aligned with the title from md up.
    await page.setViewportSize({ width: 1024, height: 800 });
    await expect
      .poll(async () => {
        const [rowBox, titleBox] = await Promise.all([
          row.locator(":scope > *").first().boundingBox(),
          dashboardHeading(page).boundingBox(),
        ]);
        return Math.round((rowBox?.x ?? 0) - (titleBox?.x ?? 0));
      })
      .toBe(0);
  });
}
