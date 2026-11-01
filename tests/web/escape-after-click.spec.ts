import { expect, type Page, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  dashboardHeading,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";
import { offline } from "./offline";

// A click on words that are not a control leaves the focus on no element (the page's body), as
// a browser does: nothing the page wraps around its screens takes it. Escape then does what it
// does with nothing focused: in the Player it goes back to the summary; with a track selected
// on the map, it closes the track's details first. The other specs reach "nothing focused" by
// script (blur()); these get there with a real click.

test.use({ reducedMotion: "reduce" });

test.beforeEach(async ({ page }) => {
  await offline(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});

/** The focused element, by tag and id; "body" when no element has the focus. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return "body";
    return `${active.tagName.toLowerCase()}#${active.id}`;
  });

test("after a click on words in the Player, Escape goes back to the summary", async ({ page }) => {
  await useMockApi(page, loadFixture("full-result"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  await page.getByText("Sample times: model inference").first().click();
  expect.soft(await focused(page), "the focus after the click").toBe("body");
  await page.keyboard.press("Escape");
  await expect(dashboardHeading(page)).toBeVisible();
  await expect(page.getByRole("button", { name: /Back to summary/ })).toHaveCount(0);
});

test("after a click on words with a track selected on the map, Escape closes its details first", async ({
  page,
}) => {
  await useMockApi(page, loadFixture("genealogy-rich"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  const card = page.locator(
    '#panel-genealogy svg[aria-label="Connections graph"] g.nodes > g[data-node-id="s2"]',
  );
  await card.focus();
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("node-detail");
  await expect(panel).toBeVisible();
  await page.getByText("Structure", { exact: true }).first().click();
  expect.soft(await focused(page), "the focus after the click").toBe("body");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  // Only the details closed: the Player is still shown.
  await expect(page.getByRole("button", { name: /Back to summary/ })).toBeVisible();
});
