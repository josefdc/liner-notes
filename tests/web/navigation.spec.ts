import { expect, test } from "@playwright/test";
import { analyzeAndOpenDashboard, apiRequests, loadFixture, useMockApi } from "./mock";

// Browser history around a finished analysis and an open track picker.
const ANALYZE = "/api/analyze/stream";
const RESUME = "/api/analyze/stream/resume";
const fullResult = loadFixture("full-result");
const hitl = loadFixture("hitl");

test("back from the result returns to the search without re-running the analysis", async ({
  page,
}) => {
  await useMockApi(page, fullResult);
  await page.goto("/");
  await expect(page.getByPlaceholder(/Song title/)).toBeVisible();
  const lengthAtStart = await page.evaluate(() => history.length);

  await analyzeAndOpenDashboard(page, "Bright Lines", { reload: false });
  // One history entry for the result, none for the steps of the analysis.
  expect.soft(await page.evaluate(() => history.length)).toBe(lengthAtStart + 1);
  const requestsAtResult = await apiRequests(page);

  await page.goBack();
  await expect(page.getByPlaceholder(/Song title/)).toBeVisible();
  // The search does not move on to the result by itself (it used to after 3.5 s).
  await page.waitForTimeout(4500);
  await expect(page.getByPlaceholder(/Song title/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Command Center" })).toHaveCount(0);
  expect(await apiRequests(page)).toEqual(requestsAtResult);

  // Forward shows the same result again, still without a new request.
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  await expect(page.getByText("Bright Lines").first()).toBeVisible();
  expect(await apiRequests(page)).toEqual(requestsAtResult);
});

test("back while the track picker is open keeps the picker", async ({ page }) => {
  // A first search ends in a result; the second one asks the user to pick a track.
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: { opens: [fullResult.streams[ANALYZE], hitl.streams[ANALYZE]] },
      [RESUME]: hitl.streams[RESUME],
    },
  });
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await page.getByRole("button", { name: "NEW SEARCH" }).click();
  await page.getByPlaceholder(/Song title/).fill("Hurt");
  await page.getByRole("button", { name: "ANALYZE_SONG" }).click();
  const picker = page.getByText("Is this the right track?");
  await expect(picker).toBeVisible();

  await page.goBack();
  await page.waitForTimeout(500);
  await expect(picker).toBeVisible();
  await expect(page.getByRole("heading", { name: "Command Center" })).toHaveCount(0);
  const log = await apiRequests(page);
  expect(log.filter((entry) => entry.startsWith(`stream ${RESUME}`))).toEqual([]);
});
