import { expect, type Page, test } from "@playwright/test";
import {
  apiRequests,
  collectProblems,
  fullResultData,
  loadFixture,
  releaseStream,
  streamLog,
  useMockApi,
} from "./mock";

// How the app handles the life of its event streams: which stream an event closes, what a
// broken stream leads to, and results that are missing or arrive twice.
const ANALYZE = "/api/analyze/stream";
const RESUME = "/api/analyze/stream/resume";
const COMPLETE_LOG = "Analysis complete. Ready for deployment.";

const hitl = loadFixture("hitl");
const candidates = hitl.streams[ANALYZE].find(
  (event: { type: string }) => event.type === "interrupt",
).candidates as Array<{ id: string; title: string; artist: string; releaseYear: string }>;
const result = fullResultData();

const pickerEvents = [
  { type: "connected", threadId: "thread-hitl" },
  { type: "status", node: "scout", message: "Searching for the track", code: "SPOTIFY-SEARCH" },
  {
    type: "interrupt",
    reason: "disambiguation",
    threadId: "thread-hitl",
    candidates,
    message: "Multiple songs found. Please select the correct one.",
  },
];

const posts = (log: string[]) => log.filter((entry) => entry.startsWith("fetch /api/analyze"));
const resumes = (log: string[]) => log.filter((entry) => entry.startsWith(`stream ${RESUME}`));
const analyses = (log: string[]) => log.filter((entry) => entry.startsWith(`stream ${ANALYZE}?`));
const finished = (log: string[], path: string) =>
  log.some((entry) => entry === `${path} closed` || entry === `${path} ended`);

async function search(page: Page, query: string) {
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill(query);
  await page.getByRole("button", { name: "ANALYZE_SONG" }).click();
}

test("a candidate picked before the analysis stream ends opens one resume and shows the result once", async ({
  page,
}) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      // The picker appears on "interrupt"; "done" is held back until after the pick.
      [ANALYZE]: [...pickerEvents, { $wait: "analysis-done" }, { type: "done" }],
      [RESUME]: [
        { type: "resuming", threadId: "thread-hitl" },
        { type: "status", node: "engineer", message: "Analyzing audio", code: "AUDIO-INIT" },
        { $wait: "resume-result" },
        { type: "complete", data: result },
        { type: "done" },
      ],
    },
  });
  await search(page, "Hurt");

  const second = candidates[1];
  await page
    .getByRole("button", { name: `${second.title} ${second.artist} • ${second.releaseYear}` })
    .click();
  await expect
    .poll(() => apiRequests(page))
    .toContain(`stream ${RESUME}?threadId=thread-hitl&selectedTrackId=${second.id}`);

  // The analysis stream now sends its "done" and ends, while the resume is still running.
  await releaseStream(page, "analysis-done");
  await expect.poll(async () => finished(await streamLog(page), ANALYZE)).toBe(true);
  await releaseStream(page, "resume-result");

  await expect.soft(page.getByRole("button", { name: "PROCEED TO COMMAND CENTER" })).toBeVisible();
  const log = await apiRequests(page);
  expect.soft(resumes(log)).toHaveLength(1);
  expect.soft(posts(log)).toEqual([]);
  await expect.soft(page.getByText(COMPLETE_LOG)).toHaveCount(1);
  await expect(page.getByText("SIGNAL LOST")).toHaveCount(0);
});

test("a stream that fails shows an error with a retry instead of starting a second analysis", async ({
  page,
}) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: {
        opens: [
          // The connection drops before any result.
          [
            { type: "connected", threadId: "thread-1" },
            { type: "status", node: "scout", message: "Searching", code: "SPOTIFY-SEARCH" },
          ],
          [
            { type: "connected", threadId: "thread-2" },
            { type: "complete", data: result },
            { type: "done" },
          ],
        ],
      },
    },
  });
  await search(page, "Bright Lines");

  await expect(page.getByText("SIGNAL LOST")).toBeVisible();
  await expect.poll(async () => finished(await streamLog(page), ANALYZE)).toBe(true);
  // Leave time for anything the error might still set off.
  await page.waitForTimeout(300);
  expect(posts(await apiRequests(page))).toEqual([]);
  expect(analyses(await apiRequests(page))).toHaveLength(1);
  // The broken stream was closed, so it did not reconnect (a new run on the server).
  expect(await streamLog(page)).not.toContain(`${ANALYZE} reconnect`);

  await page.getByRole("button", { name: "RETRY ANALYSIS" }).click();
  await expect(page.getByRole("button", { name: "PROCEED TO COMMAND CENTER" })).toBeVisible();
  const log = await apiRequests(page);
  expect(analyses(log)).toHaveLength(2);
  expect(posts(log)).toEqual([]);
});

test("a complete event without a result shows an error with a retry", async ({ page }) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: "thread-empty" },
        { type: "status", node: "composer", message: "Composing", code: "GEMINI-CONNECT" },
        // Not an event the API sends: the app skips it, so the run ends without a result.
        { $unchecked: { type: "complete" } },
        { type: "done" },
      ],
    },
  });
  await search(page, "Bright Lines");

  await expect(page.getByText("SIGNAL LOST")).toBeVisible();
  await expect(page.getByRole("button", { name: "RETRY ANALYSIS" })).toBeVisible();
  await expect(page.getByRole("button", { name: "PROCEED TO COMMAND CENTER" })).toHaveCount(0);
  expect(posts(await apiRequests(page))).toEqual([]);
});

test("a duplicate complete for the thread is ignored when the picker times out", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [...pickerEvents, { type: "done" }],
      // A second result for the run (the API sends one; a repeat must not count twice).
      [RESUME]: [
        { type: "resuming", threadId: "thread-hitl" },
        { type: "complete", data: result },
        { type: "complete", data: result },
        { type: "done" },
      ],
    },
  });
  await search(page, "Hurt");
  await expect(page.getByText("Is this the right track?")).toBeVisible();

  // Nobody picks: the countdown chooses the highlighted (first) candidate.
  await expect
    .soft(page.getByRole("button", { name: "PROCEED TO COMMAND CENTER" }))
    .toBeVisible({ timeout: 10_000 });
  await expect.poll(async () => finished(await streamLog(page), RESUME)).toBe(true);
  await page.waitForTimeout(300);

  const log = await apiRequests(page);
  expect
    .soft(resumes(log))
    .toEqual([`stream ${RESUME}?threadId=thread-hitl&selectedTrackId=${candidates[0].id}`]);
  expect.soft(posts(log)).toEqual([]);
  expect((await streamLog(page)).filter((entry) => entry === `${RESUME} complete`)).toHaveLength(2);
  await expect.soft(page.getByText(COMPLETE_LOG)).toHaveCount(1);
  expect(problems).toEqual([]);
});
