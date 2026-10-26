import { expect, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  apiRequests,
  fullResultData,
  loadFixture,
  releaseStream,
  streamLog,
  useMockApi,
} from "./mock";

// Browser history around a finished analysis and an open track picker.
const ANALYZE = "/api/analyze/stream";
const RESUME = "/api/analyze/stream/resume";
const fullResult = loadFixture("full-result");
const hitl = loadFixture("hitl");

test("back from the result returns to the search without re-running the analysis", async ({
  page,
}) => {
  await useMockApi(page, fullResult);
  await page.goto("/");
  await expect(page.getByRole("combobox", { name: "Song title and artist" })).toBeVisible();
  const lengthAtStart = await page.evaluate(() => history.length);

  await analyzeAndOpenDashboard(page, "Bright Lines", { reload: false });
  // One history entry for the result, none for the steps of the analysis.
  expect.soft(await page.evaluate(() => history.length)).toBe(lengthAtStart + 1);
  const requestsAtResult = await apiRequests(page);

  await page.goBack();
  await expect(page.getByRole("combobox", { name: "Song title and artist" })).toBeVisible();
  // The search does not move on to the result by itself (it used to after 3.5 s).
  await page.waitForTimeout(4500);
  await expect(page.getByRole("combobox", { name: "Song title and artist" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Command Center" })).toHaveCount(0);
  expect(await apiRequests(page)).toEqual(requestsAtResult);

  // Forward shows the same result again, still without a new request.
  await page.goForward();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  await expect(page.getByText("Bright Lines").first()).toBeVisible();
  expect(await apiRequests(page)).toEqual(requestsAtResult);
});

test("back while the track picker is open keeps the picker", async ({ page }) => {
  // A first search ends in a result; the second one asks the user to pick a track.
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: { opens: [fullResult.streams[ANALYZE], hitl.streams[ANALYZE]] },
      [RESUME]: hitl.streams[RESUME],
    },
  });
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await page.getByRole("button", { name: "NEW SEARCH" }).click();
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Hurt");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  const picker = page.getByText("Is this the right track?");
  await expect(picker).toBeVisible();

  await page.goBack();
  await page.waitForTimeout(500);
  await expect(picker).toBeVisible();
  await expect(page.getByRole("heading", { name: "Command Center" })).toHaveCount(0);
  const log = await apiRequests(page);
  expect(log.filter((entry) => entry.startsWith(`stream ${RESUME}`))).toEqual([]);
});

// Arriving from another site: the first search has no entry of the app behind it.
const ELSEWHERE = "data:text/html,<title>elsewhere</title><p>elsewhere</p>";

test("back on the first search after arriving keeps the open picker in the app", async ({
  page,
}) => {
  await useMockApi(page, hitl);
  await page.goto(ELSEWHERE);
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Hurt");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  const picker = page.getByText("Is this the right track?");
  await expect(picker).toBeVisible();

  await page.goBack();
  await page.waitForTimeout(500);
  expect(page.url()).not.toMatch(/^data:/);
  await expect(picker).toBeVisible();
  expect((await apiRequests(page)).filter((entry) => entry.includes(RESUME))).toEqual([]);
});

test("back on the first search after arriving keeps the running analysis", async ({ page }) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: "thread-first" },
        {
          type: "status",
          node: "scout",
          message: "Searching for the track",
          code: "SPOTIFY-SEARCH",
        },
        { $wait: "result" },
        { type: "complete", data: fullResultData() },
        { type: "done" },
      ],
    },
  });
  await page.goto(ELSEWHERE);
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Bright Lines");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(page.getByText("Searching for the track")).toBeVisible();

  await page.goBack();
  await page.waitForTimeout(500);
  expect(page.url()).not.toMatch(/^data:/);
  expect(await streamLog(page)).not.toContain(`${ANALYZE} closed`);

  // The run goes on and its result is shown, in a single history entry after the search.
  await releaseStream(page, "result");
  await page.getByRole("button", { name: "Open the results" }).click();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole("combobox", { name: "Song title and artist" })).toBeVisible();
  expect(page.url()).not.toMatch(/^data:/);
});

test("back on a search started after going back to the search keeps the picker", async ({
  page,
}) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: { opens: [fullResult.streams[ANALYZE], hitl.streams[ANALYZE]] },
      [RESUME]: hitl.streams[RESUME],
    },
  });
  await page.goto(ELSEWHERE);
  await page.goto("/");
  await analyzeAndOpenDashboard(page, "Bright Lines", { reload: false });
  await page.goBack();
  await expect(page.getByRole("combobox", { name: "Song title and artist" })).toBeVisible();

  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Hurt");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  const picker = page.getByText("Is this the right track?");
  await expect(picker).toBeVisible();
  await page.goBack();
  await page.waitForTimeout(500);
  expect(page.url()).not.toMatch(/^data:/);
  await expect(picker).toBeVisible();
});
