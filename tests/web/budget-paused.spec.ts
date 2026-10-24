import { expect, type Page, test } from "@playwright/test";
import {
  animationsSettled,
  apiRequests,
  collectProblems,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";

// Live analysis unavailable: the API answers an analysis with `budget_exhausted` (the budget is
// spent) or `live_disabled` (a server that only replays recordings). The page says why, offers
// the recorded showcase tracks (GET /api/replays) and never shows a result in place of the
// analysis. A recorded track then replays, and every result screen says it is a recording.
const fixture = loadFixture("budget-paused");
const fullResult = loadFixture("full-result").streams["/api/analyze/stream"];

/** The API's answer to an analysis on a server that only replays recordings. */
const liveDisabled = [
  {
    type: "error",
    code: "live_disabled",
    error: "Live analysis is not available here. Only the recorded showcase tracks can be shown.",
  },
  { type: "done" },
];

async function search(page: Page, query: string) {
  await page.getByPlaceholder(/Song title/).fill(query);
  await page.getByRole("button", { name: "ANALYZE_SONG" }).click();
}

test("a spent budget pauses live analysis, offers the recorded tracks and labels the replay", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, fixture);
  await page.goto("/");
  await search(page, "Some Other Song");

  const banner = page.getByRole("region", { name: "Live analysis paused" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("The budget for live analysis is spent");
  await expect(banner).toContainText("not a live analysis");
  // Not an error to retry, and no result: only the recorded tracks are offered.
  await expect(page.getByText("SIGNAL LOST")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "RETRY ANALYSIS" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "PROCEED TO COMMAND CENTER" })).toHaveCount(0);
  const tracks = banner.getByRole("list", { name: "Recorded tracks" });
  await expect(tracks.getByRole("button")).toHaveCount(1);
  await expect(tracks).toContainText("Bright Lines");
  await expect(tracks).toContainText("Test Artist • recorded 22 Oct 2026");
  expect(await apiRequests(page)).toContain("fetch /api/replays");

  // Picking it analyses its title and artist, which the API answers with the recording.
  await tracks.getByRole("button", { name: /Bright Lines/ }).click();
  await expect(page.getByRole("log")).toContainText(
    "Replaying an analysis recorded on 2026-10-22T14:03:00.000Z (commit abc1234)",
  );
  expect(await apiRequests(page)).toContain(
    "stream /api/analyze/stream?query=Bright%20Lines%20Test%20Artist",
  );
  await page.getByRole("button", { name: "PROCEED TO COMMAND CENTER" }).click();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  await animationsSettled(page);

  const dashboardLabel = page.getByRole("region", { name: "Recorded run" });
  await expect(dashboardLabel).toContainText("Recorded run · 22 Oct 2026 · replayed");
  await expect(dashboardLabel).toContainText("commit abc1234");
  await expect(dashboardLabel).toContainText("Nothing was analysed live for it.");

  await openPlayer(page);
  const playerLabel = page.getByRole("region", { name: "Recorded run" });
  await expect(playerLabel).toContainText("Recorded run · 22 Oct 2026 · replayed");

  // "More facts" from a server that only replays: said, not shown as a failure.
  const insights = page.locator("#panel-context");
  await insights.getByRole("button", { name: /DECRYPT MORE/ }).click();
  await expect(insights).toContainText(
    "More facts unavailable: live model calls are off on this server",
  );
  expect(problems).toEqual([]);
});

test("live_disabled is explained, and a live result carries no recording label", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, {
    replays: fixture.replays,
    streams: { "/api/analyze/stream": { opens: [liveDisabled, fullResult] } },
  });
  await page.goto("/");
  await search(page, "Some Other Song");

  const banner = page.getByRole("region", { name: "Live analysis is off here" });
  await expect(banner).toContainText("does not analyse songs live: it only replays recorded runs");
  await expect(banner.getByRole("list", { name: "Recorded tracks" })).toContainText("Bright Lines");

  // Another song, on a server that analyses it live this time: no recording label.
  await page.getByRole("button", { name: "or try a different song" }).click();
  await search(page, "Bright Lines");
  await page.getByRole("button", { name: "PROCEED TO COMMAND CENTER" }).click();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Recorded run" })).toHaveCount(0);
  expect(problems).toEqual([]);
});
