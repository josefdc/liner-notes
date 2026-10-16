import { expect, test } from "@playwright/test";
import { analyzeAndOpenDashboard, apiRequests, loadFixture, useMockApi } from "./mock";

// Browser history around a finished analysis.
test.beforeEach(async ({ page }) => {
  await useMockApi(page, loadFixture("full-result"));
});

test("back from the result returns to the search without re-running the analysis", async ({
  page,
}) => {
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
