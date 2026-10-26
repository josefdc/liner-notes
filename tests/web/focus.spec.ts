import { expect, type Page, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";

// Where the keyboard focus goes when the screen changes under it: never to the page itself
// (BODY), where a keyboard or screen-reader user would have to start over from the top.
const fullResult = loadFixture("full-result");
const resultHeading = (page: Page) => page.getByRole("heading", { name: "Command Center" });
const progressStatus = (page: Page) => page.locator("[data-progress-status]");

/** Starts noting, on every frame, whether the focus is on the page itself. */
async function watchFocus(page: Page) {
  await page.evaluate(() => {
    const seen: string[] = [];
    (window as unknown as { __focusSeen: string[] }).__focusSeen = seen;
    const note = () => {
      seen.push(document.activeElement?.tagName ?? "none");
      requestAnimationFrame(note);
    };
    requestAnimationFrame(note);
  });
}

/** Whether the focus was seen on the page itself since watchFocus. */
function focusFellToPage(page: Page) {
  return page.evaluate(() =>
    (window as unknown as { __focusSeen: string[] }).__focusSeen.includes("BODY"),
  );
}

test("the results that open by themselves take the focus, even when their code is slow to load", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, fullResult);
  // The result's code arrives well after the results open (3.5 s after completion).
  await page.route(/\/assets\/Dashboard-[^/]*\.js$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    await route.continue();
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Bright Lines");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(progressStatus(page)).toBeFocused();
  await watchFocus(page);

  // Nothing clicked: the results open by themselves.
  await expect(page.getByRole("status", { name: "Loading the results" })).toBeFocused({
    timeout: 8000,
  });
  await expect(resultHeading(page)).toBeFocused({ timeout: 10_000 });
  expect(await focusFellToPage(page)).toBe(false);
  expect(problems).toEqual([]);
});

test("a run started from the Dashboard moves the focus to its progress", async ({ page }) => {
  await useMockApi(page, fullResult);
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await expect(resultHeading(page)).toBeFocused();
  await watchFocus(page);

  await page.getByRole("button", { name: /Older Record/ }).click();
  await expect(progressStatus(page)).toBeFocused();
  expect(await focusFellToPage(page)).toBe(false);
});

test("a run started from the Player moves the focus to its progress", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, fullResult);
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  const node = page.getByRole("button", { name: /Press Enter to analyze it/ }).first();
  await node.focus();
  await watchFocus(page);

  await page.keyboard.press("Enter");
  await expect(progressStatus(page)).toBeFocused();
  expect(await focusFellToPage(page)).toBe(false);
});

test("after a pick ends paused, the focus waits on the loading line, then the banner takes it", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, loadFixture("budget-paused-picker"));
  await page.route(/BudgetBanner/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue();
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Bright Lines");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(page.getByRole("option").first()).toBeFocused();
  const take = page.getByRole("option", { name: /Test Artist • 2004/ });
  await watchFocus(page);
  // The live take: no recording, so the run ends paused.
  await take.click();

  await expect(
    page.getByRole("status").filter({ hasText: "Loading the recorded tracks" }),
  ).toBeFocused();
  const banner = page.getByRole("region", { name: "Live analysis paused" });
  await expect(banner.getByRole("heading", { name: "Live analysis paused" })).toBeFocused();
  expect(await focusFellToPage(page)).toBe(false);
  expect(problems).toEqual([]);
});

test("when the paused banner cannot be loaded after a pick, its explanation takes the focus", async ({
  page,
}) => {
  await useMockApi(page, loadFixture("budget-paused-picker"));
  await page.route(/BudgetBanner/, (route) => route.abort());
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Bright Lines");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(page.getByRole("option").first()).toBeFocused();
  const take = page.getByRole("option", { name: /Test Artist • 2004/ });
  await watchFocus(page);
  await take.click();

  const paused = page.getByRole("region", { name: "Live analysis paused" });
  await expect(paused).toContainText("The recorded tracks could not be loaded");
  await expect(paused.getByRole("heading", { name: "Live analysis paused" })).toBeFocused();
  expect(await focusFellToPage(page)).toBe(false);
});
