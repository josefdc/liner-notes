import { expect, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  loadFixture,
  releaseStream,
  replayedRecording,
  useMockApi,
} from "./mock";
import { offline } from "./offline";

// The recorded run's cover, and any other outside address, are answered on the page: nothing
// leaves the machine.
test.beforeEach(async ({ page }) => {
  await offline(page);
});

// A replayed run's activity log shows when each line was sent in the recorded run: the time
// since that run started, carried by its events (`elapsedMs`). A line with no recorded time
// (the replay's own notice, the page's own lines) shows none, and no line says "Just now" or
// how long ago the replay sent it.

test("a replayed run's activity log shows the recorded time since the run started", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, loadFixture("recorded-timings"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await expect(page.getByRole("region", { name: "Recorded run" })).toBeVisible();

  await page.getByRole("button", { name: /^Expand activity log/ }).click();
  const entries = page.getByRole("region", { name: "Activity log entries" });
  const timeOf = (message: string) =>
    entries.locator("[data-log-code]", { hasText: message }).locator("[data-log-time]");

  await expect(timeOf("Looking up cover art on Spotify")).toHaveText("+1 min 15 s");
  await expect(timeOf("Writing the liner notes")).toHaveText("+13.8 s");
  await expect(timeOf("Measured 105 BPM in A minor")).toHaveText("+12.4 s");
  await expect(timeOf("Found the track on Spotify")).toHaveText("+0.3 s");
  // The line the recorded result writes, at the time the recorded run sent it.
  await expect(timeOf("Recorded analysis replayed")).toHaveText("+1 min 16 s");
  await expect(entries).not.toContainText("Just now");
  await expect(entries).not.toContainText(/\bago\b/);
  expect(problems).toEqual([]);
});

// The API sends a recording's own times (its atMs when an event has none); a stream that still
// carries none, as from an older server, shows none.
test("a replayed stream without times shows no time on any line, never 'Just now'", async ({
  page,
}) => {
  const fixture = loadFixture("recorded-timings");
  for (const event of fixture.streams["/api/analyze/stream"]) delete event.elapsedMs;
  await useMockApi(page, fixture);
  await analyzeAndOpenDashboard(page, "Bright Lines");

  await page.getByRole("button", { name: /^Expand activity log/ }).click();
  const entries = page.getByRole("region", { name: "Activity log entries" });
  await expect(
    entries.getByText("Looking up cover art on Spotify for the genealogy"),
  ).toBeVisible();
  await expect(entries.locator("[data-log-time]")).toHaveCount(0);
  await expect(entries).not.toContainText("Just now");
  await expect(entries).not.toContainText(/\bago\b|\+\d/);
});

test("the committed recording replays with each line at the time its recording measured", async ({
  page,
}) => {
  const problems = collectProblems(page);
  // The recording's cover is the Cover Art Archive's: answered here, never from the network.
  await page.route("https://coverartarchive.org/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    }),
  );
  const { events } = replayedRecording();
  await useMockApi(page, {
    suggestions: [],
    eventGapMs: 10,
    streams: { "/api/analyze/stream": events },
  });
  await analyzeAndOpenDashboard(page, "One More Time Daft Punk");

  await page.getByRole("button", { name: /^Expand activity log/ }).click();
  const entries = page.getByRole("region", { name: "Activity log entries" });
  const timeOf = (message: string) =>
    entries.locator("[data-log-code]", { hasText: message }).locator("[data-log-time]");
  await expect(timeOf("Looking up cover art on Spotify for the genealogy")).toHaveText("+29.5 s");
  await expect(timeOf("Writing the liner notes")).toHaveText("+20.4 s");
  await expect(entries).not.toContainText("Just now");
  await expect(entries).not.toContainText(/\bago\b/);
  expect(problems).toEqual([]);
});

test("the progress log shows a replayed line's recorded time, and no time without one", async ({
  page,
}) => {
  await page.route("https://coverartarchive.org/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    }),
  );
  const { events } = replayedRecording();
  await useMockApi(page, {
    suggestions: [],
    eventGapMs: 10,
    streams: { "/api/analyze/stream": events },
  });
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("One More Time Daft Punk");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open the results" })).toBeVisible();

  const log = page.getByRole("log");
  const timeOf = (message: string) =>
    log.locator("[data-log-id]", { hasText: message }).locator("[data-log-time]");
  await expect(timeOf("Looking up cover art on Spotify for the genealogy")).toHaveText("+29.5 s");
  await expect(timeOf("Reading the track from Spotify")).toHaveText("+0.0 s");
  // The page's own line has no recorded time: it shows none, never the viewer's clock.
  await expect(log.locator("[data-log-id]", { hasText: "Searching for" })).toBeVisible();
  await expect(timeOf("Searching for")).toHaveCount(0);
  const times = await log.locator("[data-log-time]").allTextContents();
  expect(times.length).toBeGreaterThan(5);
  expect(times.filter((time) => !/^\+\d/.test(time))).toEqual([]);
});

test("the progress log keeps its labels in one column on a phone, a minute into a recorded run", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = loadFixture("recorded-timings");
  const events = fixture.streams["/api/analyze/stream"];
  // Held before the result, so the progress screen stays.
  events.splice(
    events.findIndex((event: { type: string }) => event.type === "complete"),
    0,
    { $wait: "finish" },
  );
  await useMockApi(page, fixture);
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Bright Lines");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();

  const log = page.getByRole("log");
  await expect(
    log.locator("[data-log-id]", { hasText: "Looking up cover art" }).locator("[data-log-time]"),
  ).toHaveText("+1 min 15 s");
  // Where each line's label starts, once the newest line has slid in.
  const starts = () =>
    log
      .locator("[data-log-label]")
      .evaluateAll((labels) =>
        labels.map((label) => Math.round(label.getBoundingClientRect().left)),
      );
  expect((await starts()).length).toBeGreaterThan(5);
  await expect.poll(async () => new Set(await starts()).size).toBe(1);
  await releaseStream(page, "finish");
});
