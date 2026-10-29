import { expect, type Page, test } from "@playwright/test";
import { collectProblems, dashboardHeading, loadFixture, openResults, useMockApi } from "./mock";
import { offline } from "./offline";

// A part of the page whose code chunk failed to load (a dropped connection, a deploy that
// replaced the hashed files) is shown again without a reload once its code can be fetched: its
// fallback says it could not be loaded and offers "Try again" and "Reload the page", and a new
// search that reaches the screen loads it too.

const full = loadFixture("full-result");
const budgetPaused = loadFixture("budget-paused");
/** A stored run of the track STORED_ID, which its address `/t/<id>` opens (deeplink.spec.ts). */
const stored = loadFixture("stored-run");
const STORED_ID = "4cOdK2wGLETKBW3PvgPWqT";

/**
 * Refuses the chunk whose address matches `pattern` until `allow()`: the browser reports it as
 * not arriving, as with a dropped connection. Counts the requests for it. Between `hold()` and
 * `release()` its requests wait unanswered (`waiting()` counts them), as on a slow connection.
 */
async function failChunk(page: Page, pattern: RegExp) {
  const state = { blocked: true, refused: 0, served: 0, waiting: 0 };
  let gate: Promise<void> | null = null;
  let open = () => {};
  await page.route(pattern, async (route) => {
    if (gate) {
      state.waiting++;
      await gate;
      state.waiting--;
    }
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
    hold: () => {
      gate = new Promise((resolve) => {
        open = resolve;
      });
    },
    release: () => {
      gate = null;
      open();
    },
    waiting: () => state.waiting,
    counts: () => ({ refused: state.refused, served: state.served }),
  };
}

/** Counts the promise rejections no code handled, from the page's first script on. */
async function countUnhandledRejections(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __unhandled: string[] };
    w.__unhandled = [];
    window.addEventListener("unhandledrejection", (event) =>
      w.__unhandled.push(String(event.reason)),
    );
  });
  return () => page.evaluate(() => (window as unknown as { __unhandled: string[] }).__unhandled);
}

/** The element that has the focus, by what a test can name it. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return "the page";
    if (active.hasAttribute("data-loading-view")) return "the loading view";
    return active.getAttribute("aria-label") ?? active.tagName;
  });

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
 * for the refused request, and the failed import as the boundary and React log it. A page error
 * (an uncaught error or an unhandled rejection, such as a preload's) is always one.
 */
const otherProblems = (problems: string[], chunk: string) =>
  problems.filter(
    (line) =>
      line !== "error: Failed to load resource: net::ERR_INTERNET_DISCONNECTED" &&
      !(
        line.startsWith("error: ") &&
        line.includes("Failed to fetch dynamically imported module") &&
        line.includes(chunk)
      ),
  );

const screenFallback = (page: Page) =>
  page.getByRole("alert").filter({ hasText: "This screen could not be loaded" });

test("a Dashboard whose code failed to load is shown on Try again, without a reload", async ({
  page,
}) => {
  const problems = collectProblems(page);
  const unhandled = await countUnhandledRejections(page);
  await offline(page);
  await useMockApi(page, full);
  const chunk = await failChunk(page, /\/assets\/Dashboard-[\w-]+\.js$/);
  await page.goto("/");
  await markDocument(page);
  await search(page, "Bright Lines");
  await openResults(page, screenFallback(page));

  const fallback = screenFallback(page);
  await expect(fallback).toBeVisible();
  await expect(fallback).toContainText("The connection may have dropped");
  await expect(fallback.getByRole("button", { name: "Try again" })).toBeFocused();
  await expect(fallback.getByRole("button", { name: "Reload the page" })).toBeVisible();
  expect(chunk.counts().served).toBe(0);

  // The connection is back, and slow: "Try again" loads the code again. Meanwhile the loading
  // view holds the focus, as on opening the result; the Dashboard's heading takes it once in.
  chunk.allow();
  chunk.hold();
  await fallback.getByRole("button", { name: "Try again" }).click();
  await expect.poll(() => chunk.waiting()).toBe(1);
  expect(await focused(page)).toBe("the loading view");
  chunk.release();
  await expect(dashboardHeading(page)).toBeFocused();
  await expect(fallback).toHaveCount(0);
  expect(chunk.counts().served).toBe(1);
  expect(await sameDocument(page)).toBe(true);
  expect(otherProblems(problems, "Dashboard-")).toEqual([]);
  // The preload of the refused chunk failed too, and was caught.
  expect(chunk.counts().refused).toBeGreaterThan(1);
  expect(await unhandled()).toEqual([]);
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
  await openResults(page, screenFallback(page));
  const fallback = screenFallback(page);
  await expect(fallback).toBeVisible();

  // The way back to the search is still offered.
  await fallback.getByRole("button", { name: "New search" }).click();
  await expect(page.getByPlaceholder(/Song title/)).toBeFocused();

  chunk.allow();
  await search(page, "Bright Lines");
  await openResults(page);
  await expect(dashboardHeading(page)).toBeFocused();
  await expect(fallback).toHaveCount(0);
  expect(await sameDocument(page)).toBe(true);
  expect(otherProblems(problems, "Dashboard-")).toEqual([]);
});

test("a Player whose code failed to load is shown on Try again, without a reload", async ({
  page,
}) => {
  const problems = collectProblems(page);
  const unhandled = await countUnhandledRejections(page);
  await offline(page);
  await useMockApi(page, full);
  const chunk = await failChunk(page, /\/assets\/Player-[\w-]+\.js$/);
  await page.goto("/");
  await markDocument(page);
  await search(page, "Bright Lines");
  await openResults(page);
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
  // The Player's preloads (as the analysis ends, and on the Dashboard) failed too, and were
  // caught.
  expect(chunk.counts().refused).toBe(3);
  expect(await unhandled()).toEqual([]);
});

test("Reload the page reloads it", async ({ page }) => {
  await offline(page);
  await useMockApi(page, full);
  await failChunk(page, /\/assets\/Dashboard-[\w-]+\.js$/);
  await page.goto("/");
  await markDocument(page);
  await search(page, "Bright Lines");
  await openResults(page, screenFallback(page));
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
  await openResults(page);

  const region = page.getByRole("region", { name: "Sonic Fingerprint" });
  const fallback = region.getByRole("alert");
  await expect(fallback).toContainText("The Sonic Fingerprint could not be loaded");
  // The rest of the Dashboard stays, and its heading keeps the focus.
  await expect(dashboardHeading(page)).toBeFocused();
  await expect(screenFallback(page)).toHaveCount(0);
  // This result is under a placeholder id, kept at no address: a reload would lose it, so the
  // panel does not offer one.
  await expect(fallback.getByRole("button", { name: "Try again" })).toBeVisible();
  await expect(fallback.getByRole("button", { name: "Reload the page" })).toHaveCount(0);

  chunk.allow();
  await fallback.getByRole("button", { name: "Try again" }).click();
  // The panel takes the focus from the button that is gone, not the page.
  expect(await focused(page)).toBe("Sonic Fingerprint");
  await expect(region.getByRole("alert")).toHaveCount(0);
  await expect(region.locator(".recharts-wrapper")).toBeVisible();
  await expect(region).toBeFocused();
  // One import that failed (not repeated while the Dashboard came in), and one that loaded.
  expect(chunk.counts()).toEqual({ refused: 1, served: 1 });
  expect(otherProblems(problems, "SonicFingerprint-")).toEqual([]);
});

test("a Sonic Fingerprint whose code fails after the Dashboard is in leaves the focus on its heading", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await offline(page);
  await useMockApi(page, full);
  const chunk = await failChunk(page, /\/assets\/SonicFingerprint-[\w-]+\.js$/);
  // A slow connection: the chart's code is still on its way when the Dashboard is in.
  chunk.hold();
  await page.goto("/");
  await search(page, "Bright Lines");
  await openResults(page);
  await expect(dashboardHeading(page)).toBeFocused();
  await expect.poll(() => chunk.waiting()).toBe(1);

  // Then it fails: the panel says so, and the focus stays on the Dashboard's heading.
  chunk.release();
  const region = page.getByRole("region", { name: "Sonic Fingerprint" });
  await expect(region.getByRole("alert")).toContainText(
    "The Sonic Fingerprint could not be loaded",
  );
  await expect(dashboardHeading(page)).toBeFocused();
  expect(chunk.counts()).toEqual({ refused: 1, served: 0 });

  // From the keyboard: the panel takes the focus, and shows it.
  chunk.allow();
  const unfocusedBorder = await region.evaluate((el) => getComputedStyle(el).borderTopColor);
  await region.getByRole("button", { name: "Try again" }).focus();
  await page.keyboard.press("Enter");
  await expect(region.locator(".recharts-wrapper")).toBeVisible();
  await expect(region).toBeFocused();
  expect(await region.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
  expect(await region.evaluate((el) => getComputedStyle(el).borderTopColor)).not.toBe(
    unfocusedBorder,
  );
  expect(otherProblems(problems, "SonicFingerprint-")).toEqual([]);
});

test("a Sonic Fingerprint that fails to draw again keeps the focus on its Try again", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await offline(page);
  await useMockApi(page, full);
  // The chart's code arrives, but throws on every draw.
  await page.route(/\/assets\/SonicFingerprint-[\w-]+\.js$/, (route) =>
    route.fulfill({
      contentType: "text/javascript",
      body: "export default function Broken() { throw new Error('the chart failed'); }",
    }),
  );
  await page.goto("/");
  await search(page, "Bright Lines");
  await openResults(page);
  await expect(dashboardHeading(page)).toBeFocused();
  const region = page.getByRole("region", { name: "Sonic Fingerprint" });
  await expect(region.getByRole("alert")).toContainText("The Sonic Fingerprint could not be drawn");

  await region.getByRole("button", { name: "Try again" }).focus();
  await page.keyboard.press("Enter");
  // Drawn afresh, the fallback's Try again has the focus again, not the page.
  await expect(region.getByRole("alert")).toContainText("The Sonic Fingerprint could not be drawn");
  await expect(region.getByRole("button", { name: "Try again" })).toBeFocused();
  expect(problems.filter((line) => !line.includes("the chart failed"))).toEqual([]);
});

test("the Sonic Fingerprint of a result kept at its address offers a reload that shows it again", async ({
  page,
}) => {
  await offline(page);
  await useMockApi(page, stored);
  await failChunk(page, /\/assets\/SonicFingerprint-[\w-]+\.js$/);
  await page.goto(`/t/${STORED_ID}`);
  await expect(dashboardHeading(page)).toHaveText("Bright Lines");
  const address = page.url();
  const region = page.getByRole("region", { name: "Sonic Fingerprint" });
  await expect(region.getByRole("alert")).toContainText(
    "The Sonic Fingerprint could not be loaded",
  );

  await markDocument(page);
  await region.getByRole("button", { name: "Reload the page" }).click();
  await page.waitForLoadState("load");
  expect(await sameDocument(page)).toBe(false);
  // The reload shows the same result again, from its address.
  expect(page.url()).toBe(address);
  await expect(dashboardHeading(page)).toHaveText("Bright Lines");
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
