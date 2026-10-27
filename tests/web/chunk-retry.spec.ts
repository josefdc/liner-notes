import { expect, type Page, test } from "@playwright/test";
import { collectProblems, dashboardHeading, loadFixture, useMockApi } from "./mock";
import { offline } from "./offline";

// A part of the page whose code chunk failed to load (a dropped connection, a deploy that
// replaced the hashed files) is shown again without a reload once its code can be fetched: its
// fallback says it could not be loaded and offers "Try again" and "Reload the page", and a new
// search that reaches the screen loads it too.

const full = loadFixture("full-result");
const budgetPaused = loadFixture("budget-paused");

/**
 * Refuses the chunk whose address matches `pattern` until `allow()`: the browser reports it as
 * not arriving, as with a dropped connection. Counts the requests for it.
 */
async function failChunk(page: Page, pattern: RegExp) {
  const state = { blocked: true, refused: 0, served: 0 };
  await page.route(pattern, (route) => {
    if (state.blocked) {
      state.refused++;
      return route.abort("internetdisconnected");
    }
    state.served++;
    return route.continue();
  });
  return {
    allow: () => {
      state.blocked = false;
    },
    counts: () => ({ refused: state.refused, served: state.served }),
  };
}

/** Marks the document: the mark is gone after a reload. */
const markDocument = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { __sameDocument: boolean }).__sameDocument = true;
  });
const sameDocument = (page: Page) =>
  page.evaluate(() => (window as unknown as { __sameDocument?: boolean }).__sameDocument === true);

async function search(page: Page, query: string) {
  await page.getByPlaceholder(/Song title/).fill(query);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
}

/**
 * The console errors and page errors other than those of the refused chunk: the browser's line
 * for the refused request, and the failed import, which the boundary and React report (and the
 * app's preloads of the result views, which do not catch it).
 */
const otherProblems = (problems: string[], chunk: string) =>
  problems.filter(
    (line) =>
      !line.endsWith("net::ERR_INTERNET_DISCONNECTED") &&
      !(line.includes("Failed to fetch dynamically imported module") && line.includes(chunk)),
  );

const screenFallback = (page: Page) =>
  page.getByRole("alert").filter({ hasText: "This screen could not be loaded" });

test("a Dashboard whose code failed to load is shown on Try again, without a reload", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await offline(page);
  await useMockApi(page, full);
  const chunk = await failChunk(page, /\/assets\/Dashboard-[\w-]+\.js$/);
  await page.goto("/");
  await markDocument(page);
  await search(page, "Bright Lines");
  await page.getByRole("button", { name: "Open the results" }).click();

  const fallback = screenFallback(page);
  await expect(fallback).toBeVisible();
  await expect(fallback).toContainText("The connection may have dropped");
  await expect(fallback.getByRole("button", { name: "Try again" })).toBeFocused();
  await expect(fallback.getByRole("button", { name: "Reload the page" })).toBeVisible();
  expect(chunk.counts().served).toBe(0);

  // The connection is back: "Try again" loads the code and shows the Dashboard, whose heading
  // takes the focus as on opening it.
  chunk.allow();
  await fallback.getByRole("button", { name: "Try again" }).click();
  await expect(dashboardHeading(page)).toBeFocused();
  await expect(fallback).toHaveCount(0);
  expect(chunk.counts().served).toBe(1);
  expect(await sameDocument(page)).toBe(true);
  expect(otherProblems(problems, "Dashboard-")).toEqual([]);
});

test("a new search that reaches the Dashboard shows it once its code can be loaded", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await offline(page);
  await useMockApi(page, full);
  const chunk = await failChunk(page, /\/assets\/Dashboard-[\w-]+\.js$/);
  await page.goto("/");
  await markDocument(page);
  await search(page, "Bright Lines");
  await page.getByRole("button", { name: "Open the results" }).click();
  const fallback = screenFallback(page);
  await expect(fallback).toBeVisible();

  // The way back to the search is still offered.
  await fallback.getByRole("button", { name: "New search" }).click();
  await expect(page.getByPlaceholder(/Song title/)).toBeFocused();

  chunk.allow();
  await search(page, "Bright Lines");
  await page.getByRole("button", { name: "Open the results" }).click();
  await expect(dashboardHeading(page)).toBeFocused();
  await expect(fallback).toHaveCount(0);
  expect(await sameDocument(page)).toBe(true);
  expect(otherProblems(problems, "Dashboard-")).toEqual([]);
});

test("a Player whose code failed to load is shown on Try again, without a reload", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await offline(page);
  await useMockApi(page, full);
  const chunk = await failChunk(page, /\/assets\/Player-[\w-]+\.js$/);
  await page.goto("/");
  await markDocument(page);
  await search(page, "Bright Lines");
  await page.getByRole("button", { name: "Open the results" }).click();
  await expect(dashboardHeading(page)).toBeVisible();
  await page.getByRole("button", { name: "View full analysis" }).click();

  const fallback = screenFallback(page);
  await expect(fallback).toBeVisible();
  await expect(fallback.getByRole("button", { name: "Try again" })).toBeFocused();
  expect(chunk.counts().served).toBe(0);

  chunk.allow();
  await fallback.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("button", { name: /Back to summary/ }).first()).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
  await expect(fallback).toHaveCount(0);
  expect(chunk.counts().served).toBe(1);
  expect(await sameDocument(page)).toBe(true);
  expect(otherProblems(problems, "Player-")).toEqual([]);
});

test("Reload the page reloads it", async ({ page }) => {
  await offline(page);
  await useMockApi(page, full);
  await failChunk(page, /\/assets\/Dashboard-[\w-]+\.js$/);
  await page.goto("/");
  await markDocument(page);
  await search(page, "Bright Lines");
  await page.getByRole("button", { name: "Open the results" }).click();
  const fallback = screenFallback(page);
  await expect(fallback).toBeVisible();
  const address = page.url();

  const reloaded = page.waitForRequest((request) => request.isNavigationRequest());
  await fallback.getByRole("button", { name: "Reload the page" }).click();
  expect((await reloaded).url()).toBe(address);
  await page.waitForLoadState("load");
  expect(await sameDocument(page)).toBe(false);
});

test("a Sonic Fingerprint whose code failed to load leaves the Dashboard, and loads on Try again", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await offline(page);
  await useMockApi(page, full);
  const chunk = await failChunk(page, /\/assets\/SonicFingerprint-[\w-]+\.js$/);
  await page.goto("/");
  await search(page, "Bright Lines");
  await page.getByRole("button", { name: "Open the results" }).click();

  const region = page.getByRole("region", { name: "Sonic Fingerprint" });
  const fallback = region.getByRole("alert");
  await expect(fallback).toContainText("The Sonic Fingerprint could not be loaded");
  // The rest of the Dashboard stays, and its heading keeps the focus.
  await expect(dashboardHeading(page)).toBeFocused();
  await expect(screenFallback(page)).toHaveCount(0);

  chunk.allow();
  await fallback.getByRole("button", { name: "Try again" }).click();
  await expect(region.getByRole("alert")).toHaveCount(0);
  await expect(region.locator(".recharts-wrapper")).toBeVisible();
  // One import that failed (not repeated while the Dashboard came in), and one that loaded.
  expect(chunk.counts()).toEqual({ refused: 1, served: 1 });
  expect(otherProblems(problems, "SonicFingerprint-")).toEqual([]);
});

test("the paused banner whose code failed to load loads on Try again", async ({ page }) => {
  const problems = collectProblems(page);
  await offline(page);
  await useMockApi(page, budgetPaused);
  const chunk = await failChunk(page, /\/assets\/BudgetBanner-[\w-]+\.js$/);
  await page.goto("/");
  await search(page, "Some Other Song");

  const paused = page.getByRole("region", { name: "Live analysis paused" });
  await expect(paused).toContainText("The recorded tracks could not be loaded");
  await expect(paused.getByRole("heading", { name: "Live analysis paused" })).toBeFocused();

  chunk.allow();
  await paused.getByRole("button", { name: "Try again" }).click();
  await expect(paused.getByRole("list", { name: "Recorded tracks" })).toContainText("Bright Lines");
  await expect(paused.getByRole("heading", { name: "Live analysis paused" })).toBeFocused();
  expect(chunk.counts()).toEqual({ refused: 1, served: 1 });
  expect(otherProblems(problems, "BudgetBanner-")).toEqual([]);
});
