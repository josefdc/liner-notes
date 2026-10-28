import { expect, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";

// Results the web app must render honestly whatever the API version: a payload with estimated
// audio values (audioSource "estimated", also served from the result cache) and the fallback
// factoids that repeat them, and a result with lists missing.

test("estimated audio values are not shown as measured, not even in factoids", async ({ page }) => {
  await useMockApi(page, loadFixture("legacy-estimated"));
  await analyzeAndOpenDashboard(page, "Old Estimate");

  const stats = page.getByRole("list", { name: "Audio values" });
  await expect(stats).toContainText("BPM not measured");
  await expect(stats).toContainText("Key not measured");
  await expect(stats).toContainText("Energy not measured");
  const notices = page.getByRole("region", { name: "Missing data" });
  await expect(notices).toContainText("Audio values not measured");
  await expect(notices).toContainText("Estimated, not measured — not shown.");
  await expect(page.locator("#root")).not.toContainText("117");
  await expect(page.locator("#root")).not.toContainText("A Minor");

  await openPlayer(page);
  await expect(page.getByRole("list", { name: "Audio values" })).toContainText("BPM not measured");
  await expect(page.locator("#root")).not.toContainText("117");
  // Factoids that repeat the estimates, and the lyric factoid, are dropped.
  const insights = page.locator("#panel-context");
  await expect(insights).toContainText("Studio Intel");
  await expect(insights).not.toContainText("Sonic Profile");
  await expect(insights).not.toContainText("Track Signature");
  await expect(insights).not.toContainText("Lyrical Analysis");
  await expect(page.locator("#root")).not.toContainText("A Minor");
  await expect(page.locator("#root")).not.toContainText("54%");
});

test("a result with missing lists renders, graph included", async ({ page }) => {
  await useMockApi(page, loadFixture("sparse-result"));
  const problems = collectProblems(page);
  await analyzeAndOpenDashboard(page, "Sparse Result");
  await openPlayer(page);

  await expect(page.getByRole("heading", { name: "Sparse Result" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Song structure" })).toContainText(
    "Song sections not analyzed",
  );
  // No relation: the compact row, with its two tracks and no relation drawn.
  const row = page.locator('#panel-genealogy [data-testid="lineage-row"]');
  await expect(row.locator("[data-lineage-card]")).toHaveCount(2);
  await expect(row.locator("[data-relation-chip]")).toHaveCount(0);
  expect(problems.filter((p) => p.startsWith("pageerror"))).toEqual([]);
});
