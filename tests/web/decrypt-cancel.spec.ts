import { expect, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  dashboardHeading,
  loadFixture,
  openPlayer,
  streamLog,
  useMockApi,
} from "./mock";

// "More facts" streams factoids from the model. Leaving the Player ends that stream, quietly.
const DECRYPT = "/api/factoids/more/stream";
const fixture = loadFixture("decrypt-after-model-unavailable");
const [connected, firstFactoid] = fixture.streams[DECRYPT];

test("leaving the Player closes a running decrypt stream without an error", async ({ page }) => {
  const problems = collectProblems(page);
  await useMockApi(page, {
    ...fixture,
    streams: {
      ...fixture.streams,
      // One factoid, then the stream stays open until the test releases it (it never does).
      [DECRYPT]: [connected, firstFactoid, { $wait: "rest" }, { type: "done" }],
    },
  });
  await analyzeAndOpenDashboard(page, "Quiet Signal");
  await openPlayer(page);

  const insights = page.locator("#panel-context");
  await insights.getByRole("button", { name: "Find more facts", exact: true }).click();
  await expect(page.getByRole("region", { name: "More facts" })).toContainText("Hidden Sample");

  await page.getByRole("button", { name: /Back to summary/ }).click();
  await expect(dashboardHeading(page)).toBeVisible();
  await expect.poll(() => streamLog(page)).toContain(`${DECRYPT} closed`);

  // Back in the Player, a new decrypt starts only after the first one was closed.
  await openPlayer(page);
  await page
    .locator("#panel-context")
    .getByRole("button", { name: "Find more facts", exact: true })
    .click();
  await expect
    .poll(async () => (await streamLog(page)).filter((entry) => entry === `${DECRYPT} open`))
    .toHaveLength(2);
  const log = await streamLog(page);
  expect(log.indexOf(`${DECRYPT} closed`)).toBeLessThan(log.lastIndexOf(`${DECRYPT} open`));
  expect(problems).toEqual([]);
});
