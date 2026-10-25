import { expect, type Page, test } from "@playwright/test";
import {
  apiRequests,
  collectProblems,
  fullResultData,
  loadFixture,
  streamLog,
  useMockApi,
} from "./mock";

// The API's stream protocol: heartbeats as data messages, the picker announced by
// `interrupt` alone (with the thread and the candidates), exactly one `complete`, and
// refusals or failures sent as `{ type: "error", code, error }` followed by `done`.
const ANALYZE = "/api/analyze/stream";
const RESUME = "/api/analyze/stream/resume";
const THREAD = "3f6c1d2e-0000-4000-8000-000000000001";
const hitl = loadFixture("hitl");
const candidates = hitl.streams[ANALYZE].find(
  (event: { type: string }) => event.type === "interrupt",
).candidates as Array<{ id: string }>;
const result = fullResultData();

const pickerStream = [
  { type: "connected", threadId: THREAD },
  { type: "heartbeat" },
  { type: "status", node: "scout", message: "Searching for the track", code: "SPOTIFY-SEARCH" },
  {
    type: "interrupt",
    reason: "disambiguation",
    threadId: THREAD,
    candidates,
    message: "Multiple songs found.",
  },
  { type: "done" },
];

const failure = (code: string, error: string) => [
  { type: "connected", threadId: THREAD },
  { type: "heartbeat" },
  { type: "error", code, error },
  { type: "done" },
];

async function search(page: Page, query: string) {
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill(query);
  await page.getByRole("button", { name: "ANALYZE_SONG" }).click();
}

test("an interrupt-only picker with data heartbeats resumes to one result", async ({ page }) => {
  const problems = collectProblems(page);
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: pickerStream,
      [RESUME]: [
        { type: "heartbeat" },
        { type: "resuming", threadId: THREAD },
        { type: "status", node: "engineer", message: "Analyzing audio", code: "AUDIO-INIT" },
        { type: "complete", data: result },
        { type: "heartbeat" },
        { type: "done" },
      ],
    },
  });
  await search(page, "Hurt");
  await expect(page.getByText("Is this the right track?")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("button", { name: "PROCEED TO COMMAND CENTER" })).toBeVisible();
  await page.waitForTimeout(400);
  const log = await apiRequests(page);
  expect(log.filter((entry) => entry.startsWith(`stream ${RESUME}`))).toEqual([
    `stream ${RESUME}?threadId=${THREAD}&selectedTrackId=${candidates[1].id}&pickedBy=click`,
  ]);
  expect(log.filter((entry) => entry.startsWith("fetch /api/analyze"))).toEqual([]);
  expect((await streamLog(page)).filter((entry) => entry.endsWith("reconnect"))).toEqual([]);
  await expect(page.getByText("Analysis complete. Ready for deployment.")).toHaveCount(1);
  expect(problems).toEqual([]);
});

test("a refused resume shows its error with the hint for its code, and retry searches again", async ({
  page,
}) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: pickerStream,
      [RESUME]: [
        {
          type: "error",
          code: "choice_expired",
          error: "This choice has expired or was not found. Please search again.",
        },
        { type: "done" },
      ],
    },
  });
  await search(page, "Hurt");
  await expect(page.getByText("Is this the right track?")).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(page.getByText("SIGNAL LOST")).toBeVisible();
  await expect(page.getByText(/This choice has expired/)).toBeVisible();
  // The code decides the hint, not the words "not found" in the message.
  await expect(page.getByText("That choice is no longer open. Search again.")).toBeVisible();
  await expect(page.getByText(/Verify track name/)).toHaveCount(0);

  await page.getByRole("button", { name: "RETRY ANALYSIS" }).click();
  await expect(page.getByText("Is this the right track?")).toBeVisible();
  const log = await apiRequests(page);
  expect(log.filter((entry) => entry.startsWith(`stream ${ANALYZE}?`))).toHaveLength(2);
  expect(log.filter((entry) => entry.startsWith("fetch /api/analyze"))).toEqual([]);
});

for (const { code, error, hint } of [
  {
    code: "no_match",
    error: "No song matched the search.",
    hint: "No signal detected. Verify track name and artist.",
  },
  {
    code: "timeout",
    error: "The analysis took too long.",
    hint: "An upstream service is not answering. Try again later.",
  },
  {
    code: "upstream_unavailable",
    error: "A music service could not be reached.",
    hint: "An upstream service is not answering. Try again later.",
  },
  {
    code: "failed",
    error: "The analysis failed.",
    hint: "Unexpected interference. The system is ready to retry.",
  },
]) {
  test(`a failure with code ${code} shows its hint`, async ({ page }) => {
    await useMockApi(page, { suggestions: [], streams: { [ANALYZE]: failure(code, error) } });
    await search(page, "Hurt");
    await expect(page.getByText("SIGNAL LOST")).toBeVisible();
    await expect(page.getByText(error)).toBeVisible();
    await expect(page.getByText(hint)).toBeVisible();
  });
}

test("the search box takes at most 200 characters", async ({ page }) => {
  await useMockApi(page, { suggestions: [], streams: {} });
  await page.goto("/");
  const input = page.getByPlaceholder(/Song title/);
  await expect(input).toHaveAttribute("maxlength", "200");
  await input.pressSequentially("a".repeat(210), { delay: 0 });
  expect((await input.inputValue()).length).toBe(200);
});
