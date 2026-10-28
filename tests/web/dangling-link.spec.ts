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
  // One relation drawn: the compact row, with its two tracks and the one relation.
  const row = page.locator('#panel-genealogy [data-testid="lineage-row"]');
  await expect(row.locator("[data-lineage-card]")).toHaveCount(2);
  await expect(row.locator("[data-relation-chip]")).toHaveCount(1);
  expect(problems.filter((p) => p.includes("node not found"))).toEqual([]);
});
