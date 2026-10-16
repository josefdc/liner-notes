import { expect, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";

// Results the web app must render honestly whatever the API version: the earlier payload with
// estimated audio values (also served from its result cache), and a result with lists missing.

test("audio values estimated by an earlier version are not shown as measured", async ({ page }) => {
  await useMockApi(page, loadFixture("legacy-estimated"));
  await analyzeAndOpenDashboard(page, "Old Estimate");

  const stats = page.getByRole("list", { name: "Audio values" });
  await expect(stats).toContainText("BPM not measured");
  await expect(stats).toContainText("Key not measured");
  await expect(stats).toContainText("Energy not measured");
  const notices = page.getByRole("region", { name: "Missing data" });
  await expect(notices).toContainText("Audio values not measured");
  await expect(notices).toContainText(
    "Estimated by an earlier version of the analysis — not a measurement.",
  );
  await expect(page.locator("#root")).not.toContainText("117");
  await expect(page.locator("#root")).not.toContainText("A Minor");

  await openPlayer(page);
  await expect(page.getByRole("list", { name: "Audio values" })).toContainText("BPM not measured");
  await expect(page.locator("#root")).not.toContainText("117");
  // The lyric factoid of the earlier version is dropped, not shown as trivia.
  await expect(page.locator("#root")).toContainText("Studio Intel");
  await expect(page.locator("#root")).not.toContainText("Lyrical Analysis");
});

test("a result with missing lists renders, graph included", async ({ page }) => {
  await useMockApi(page, loadFixture("sparse-result"));
  const problems = collectProblems(page);
  await analyzeAndOpenDashboard(page, "Sparse Result");
  await openPlayer(page);

  await expect(page.getByRole("heading", { name: "Sparse Result" })).toBeVisible();
  await expect(page.getByRole("group", { name: "Song structure" })).toContainText(
    "STRUCTURE DATA UNAVAILABLE",
  );
  const graph = page.locator("#panel-genealogy svg");
  await expect(graph.locator("g.nodes > g")).toHaveCount(2);
  await expect(graph.locator("g.links line")).toHaveCount(0);
  expect(problems.filter((p) => p.startsWith("pageerror"))).toEqual([]);
});
