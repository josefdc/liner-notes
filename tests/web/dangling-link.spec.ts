import { expect, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";

// The genealogy has a link from "ghost", a node id that is not in the node list. The graph must
// draw the links it can and leave that one out, without taking the rest of the app down.
const fixture = loadFixture("dangling-link");

test("a genealogy link to a missing node does not blank the app", async ({ page }) => {
  await useMockApi(page, fixture);
  const problems = collectProblems(page);

  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);

  await expect(page.getByRole("heading", { name: "Bright Lines" })).toBeVisible();
  const graph = page.locator("#panel-genealogy svg");
  await expect(graph.locator("g.nodes > g")).toHaveCount(2);
  await expect(graph.locator("g.links line")).toHaveCount(1);
  expect(problems.filter((p) => p.includes("node not found"))).toEqual([]);
});
