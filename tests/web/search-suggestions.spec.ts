import { expect, test } from "@playwright/test";
import { apiRequests, loadFixture, useMockApi } from "./mock";

// Search suggestions while typing: a failed request says so instead of looking like
// "no matches".
const hitl = loadFixture("hitl");
const candidates = hitl.streams["/api/analyze/stream"].find(
  (event: { type: string }) => event.type === "interrupt",
).candidates;
const unavailable = "Suggestions are unavailable right now. You can still search.";

test("a failing suggestion request shows that suggestions are unavailable", async ({ page }) => {
  await useMockApi(page, {
    suggestions: candidates,
    streams: {},
    fetchStatus: { "/api/search/suggest": 500 },
  });
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Hurt");

  await expect(page.getByText(unavailable)).toBeVisible();
  expect(await apiRequests(page)).toContain("fetch /api/search/suggest");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "ANALYZE_SONG" })).toBeEnabled();
});

test("suggestions that load show the list and no error", async ({ page }) => {
  await useMockApi(page, { suggestions: candidates, streams: {} });
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Hurt");

  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(candidates.length);
  await expect(page.getByText(unavailable)).toHaveCount(0);
});
