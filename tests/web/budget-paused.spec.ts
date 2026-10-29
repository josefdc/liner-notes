import { expect, type Page, test } from "@playwright/test";
import {
  animationsSettled,
  apiRequests,
  collectProblems,
  dashboardHeading,
  loadFixture,
  openPlayer,
  openResults,
  releaseStream,
  streamLog,
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
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
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
  await expect(page.getByRole("heading", { name: "The analysis did not finish" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Try again" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open the results" })).toHaveCount(0);
  const tracks = banner.getByRole("list", { name: "Recorded tracks" });
  await expect(tracks.getByRole("button")).toHaveCount(1);
  await expect(tracks).toContainText("Bright Lines");
  await expect(tracks).toContainText("Test Artist • recorded 22 Oct 2026");
  expect(await apiRequests(page)).toContain("fetch /api/replays");

  // The banner is announced and takes the focus from the search form it replaces.
  await expect(banner.getByRole("alert")).toContainText("Live analysis paused");
  await expect(banner.getByRole("heading", { name: "Live analysis paused" })).toBeFocused();
  // From the banner, the keyboard reaches the recorded track, then "or try a different song",
  // whose focus is visible.
  await page.keyboard.press("Tab");
  await expect(tracks.getByRole("button", { name: /Bright Lines/ })).toBeFocused();
  await page.keyboard.press("Tab");
  const other = page.getByRole("button", { name: "or try a different song" });
  await expect(other).toBeFocused();
  expect(await other.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe("none");
  await page.keyboard.press("Shift+Tab");
  expect(await other.evaluate((el) => getComputedStyle(el).boxShadow)).toBe("none");

  // Picking it analyses its title and artist, which the API answers with the recording.
  await tracks.getByRole("button", { name: /Bright Lines/ }).click();
  await expect(page.getByRole("log")).toContainText(
    "Replaying an analysis recorded on 2026-10-22T14:03:00.000Z (commit abc1234)",
  );
  expect(await apiRequests(page)).toContain(
    "stream /api/analyze/stream?query=Bright%20Lines%20Test%20Artist",
  );
  await openResults(page);
  await expect(dashboardHeading(page)).toBeVisible();
  await animationsSettled(page);

  const dashboardLabel = page.getByRole("region", { name: "Recorded run" });
  await expect(dashboardLabel).toContainText("Recorded run · 22 Oct 2026 · replayed");
  await expect(dashboardLabel).toContainText("commit abc1234");
  await expect(dashboardLabel).toContainText("Nothing was analyzed live for it.");

  await openPlayer(page);
  const playerLabel = page.getByRole("region", { name: "Recorded run" });
  await expect(playerLabel).toContainText("Recorded run · 22 Oct 2026 · replayed");

  // "More facts" of a replayed result ask for its recording only; every recorded fact is
  // already shown, so the API sends none, and the Player says why.
  const insights = page.locator("#panel-context");
  await insights.getByRole("button", { name: "Find more facts", exact: true }).click();
  await expect(insights).toContainText(
    "No more facts: this result is a recording, and every fact recorded with it is shown.",
  );
  expect((await apiRequests(page)).filter((r) => r.includes("/factoids/"))).toEqual([
    expect.stringMatching(/^stream \/api\/factoids\/more\/stream\?.*&mode=replay$/),
  ]);
  expect(problems).toEqual([]);
});

test("live_disabled is explained, and a live result carries no recording label", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, {
    replays: fixture.replays,
    streams: {
      "/api/analyze/stream": { opens: [liveDisabled, fullResult] },
      // A live result while the budget is spent: the refusal, never recorded facts.
      "/api/factoids/more/stream": [
        { type: "error", code: "budget_exhausted", error: "Live model calls are paused for now." },
        { type: "done" },
      ],
    },
  });
  await page.goto("/");
  await search(page, "Some Other Song");

  const banner = page.getByRole("region", { name: "Live analysis is off here" });
  await expect(banner).toContainText(
    "does not analyze songs live right now: it only replays recorded runs",
  );
  await expect(banner.getByRole("list", { name: "Recorded tracks" })).toContainText("Bright Lines");

  // Another song, on a server that analyses it live this time: no recording label.
  await page.getByRole("button", { name: "or try a different song" }).click();
  await search(page, "Bright Lines");
  await openResults(page);
  await expect(dashboardHeading(page)).toBeVisible();
  await expect(page.getByRole("region", { name: "Recorded run" })).toHaveCount(0);
  await openPlayer(page);
  await expect(page.getByRole("region", { name: "Recorded run" })).toHaveCount(0);
  const insights = page.locator("#panel-context");
  await insights.getByRole("button", { name: "Find more facts", exact: true }).click();
  await expect(insights).toContainText(
    "More facts unavailable: live model calls are paused, budget reached",
  );
  expect(problems).toEqual([]);
});

test("while a recording plays, the progress screen says it is a replay, not a live analysis, and its button opens the result", async ({
  page,
}) => {
  const problems = collectProblems(page);
  const [refusal, replay] = fixture.streams["/api/analyze/stream"].opens;
  // Held right after the recorded scout step, which a live run shows as a Spotify search.
  const held = [...replay.slice(0, 3), { $wait: "rest" }, ...replay.slice(3)];
  // The page's timers run on a clock the test holds once the replay is under way: the progress
  // screen moves on to the Dashboard by itself 3.5 s after the run completes, and a slow machine
  // must not let it go before the screen has been read.
  await page.clock.install();
  await useMockApi(page, {
    ...fixture,
    streams: { ...fixture.streams, "/api/analyze/stream": { opens: [refusal, held] } },
  });
  await page.goto("/");
  await search(page, "Some Other Song");
  await page.getByRole("button", { name: /Bright Lines/ }).click();

  const replaying = "Replaying a recorded analysis — nothing runs live...";
  // The status line on screen; screen readers hear the replay from the run log's first line.
  await expect(page.getByText(replaying, { exact: true }).filter({ visible: true })).toBeVisible();
  await expect(page.getByRole("log")).toContainText("nothing below runs live");
  await expect(page.getByText(/Searching Spotify for your track/)).toHaveCount(0);

  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 5000));
  const sent = async () =>
    (await streamLog(page)).filter((entry) => entry === "/api/analyze/stream done").length;
  const before = await sent();
  await releaseStream(page, "rest");
  // Runs the clock on, 50 ms at a time (the mock's pace), until the replay's stream has sent its
  // last event: the result comes just before it, so the 3.5 s after the result are far off.
  for (let step = 0; (await sent()) === before; step += 1) {
    expect(step, "the replay's stream sends its last event").toBeLessThan(60);
    await page.clock.runFor(50);
  }
  const ready = page.locator("span", { hasText: "Replay complete. Opening the results" });
  await expect(ready).toBeAttached();
  await expect(page.getByText("Analysis complete. Opening the results")).toHaveCount(0);
  await expect(page.getByRole("log")).toContainText(
    "Recorded analysis replayed. Nothing was analyzed live.",
  );
  await expect(page.getByRole("log")).not.toContainText("Analysis complete");
  // Revealed whole: the line fits the 40ch the reveal animation stops at.
  await animationsSettled(page);
  expect(await ready.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  // Still on the progress screen: nothing moved on while it was read.
  await expect(page.getByRole("log")).toBeVisible();

  // "Open the results" shows 0.4 s after the result, and opens it. Clicked directly, with the
  // clock held well short of the 3.5 s after which the screen moves on by itself: only the
  // button can have taken the progress screen away. (The Dashboard then loads on the clock.)
  await page.clock.runFor(400);
  await page.getByRole("button", { name: "Open the results" }).click();
  await expect(page.getByRole("log")).toHaveCount(0);
  await page.clock.resume();
  await expect(dashboardHeading(page)).toBeVisible();
  await expect(page.getByRole("region", { name: "Recorded run" })).toContainText(
    "Recorded run · 22 Oct 2026 · replayed",
  );
  expect(problems).toEqual([]);
});

test("the paused state still explains itself when the banner's code cannot be loaded", async ({
  page,
}) => {
  await useMockApi(page, fixture);
  await page.goto("/");
  // A page older than the deployed version, or a dropped connection: the chunk is gone.
  await page.route(/BudgetBanner/, (route) => route.abort());
  await search(page, "Some Other Song");

  const paused = page.getByRole("region", { name: "Live analysis paused" });
  await expect(paused).toContainText("The budget for live analysis is spent");
  await expect(paused).toContainText(
    "The recorded tracks could not be loaded. Try again, or reload the page",
  );
  await expect(page.getByRole("button", { name: "or try a different song" })).toBeVisible();

  // The text asks for a reload: the button for it is there, and it brings back a fresh page.
  await page.unroute(/BudgetBanner/);
  await paused.getByRole("button", { name: "Reload the page" }).click();
  await expect(paused).toHaveCount(0);
  await expect(page.getByPlaceholder(/Song title/)).toHaveValue("");
});

test("on a phone, the recording label stays visible on every Player tab", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useMockApi(page, fixture);
  await page.goto("/");
  await search(page, "Some Other Song");
  await page.getByRole("button", { name: /Bright Lines/ }).click();
  await openResults(page);
  await openPlayer(page);
  for (const tab of ["Analysis", "Player", "Connections"]) {
    await page.getByRole("tab", { name: tab }).click();
    await expect(page.getByRole("region", { name: "Recorded run" })).toBeVisible();
    await expect(page.getByRole("region", { name: "Recorded run" })).toContainText(
      "Recorded run · 22 Oct 2026 · replayed",
    );
  }
});

test("a track picked after the budget tripped replays its recording", async ({ page }) => {
  const problems = collectProblems(page);
  await useMockApi(page, loadFixture("budget-paused-picker"));
  await page.goto("/");
  await search(page, "Bright Lines");
  // The studio take (2001), the one with a recording.
  await page.getByRole("option", { name: /Test Artist • 2001/ }).click();

  // The resume is refused (budget spent); the recording of that very track is replayed.
  await expect(page.getByRole("log")).toContainText(
    "Live analysis is unavailable: replaying the recording of the selected track.",
  );
  await expect(page.getByRole("log")).toContainText("Replaying an analysis recorded on");
  expect(await apiRequests(page)).toContain(
    "stream /api/analyze/stream?query=Bright%20Lines%20Test%20Artist",
  );
  await openResults(page);
  await expect(page.getByRole("region", { name: "Recorded run" })).toContainText(
    "Recorded run · 22 Oct 2026 · replayed",
  );
  expect(problems).toEqual([]);
});

test("a picked take without a recording ends paused, never with another take's recording", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, loadFixture("budget-paused-picker"));
  await page.goto("/");
  await search(page, "Bright Lines");
  // The live take (2004): same title and artist as the recorded studio take, no recording.
  await page.getByRole("option", { name: /Test Artist • 2004/ }).click();

  await expect(page.getByRole("region", { name: "Live analysis paused" })).toBeVisible();
  const requests = await apiRequests(page);
  expect(requests).toContain("fetch /api/replays");
  expect(requests.filter((r) => r.startsWith("stream /api/analyze/stream?"))).toHaveLength(1);
  await expect(page.getByRole("button", { name: "Open the results" })).toHaveCount(0);
  expect(problems).toEqual([]);
});
