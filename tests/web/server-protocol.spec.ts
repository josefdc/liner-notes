import { expect, type Page, test } from "@playwright/test";
import {
  apiRequests,
  collectProblems,
  fullResultData,
  holdClock,
  loadFixture,
  runUntilResultsButton,
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
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
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
  await page.clock.install();
  await search(page, "Hurt");
  await expect(page.getByText("Is this the right track?")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  // The completion screen is read with the page's time held (see `holdClock`); the time left
  // for a reconnect is the page's own.
  await holdClock(page);
  await page.keyboard.press("Enter");

  await runUntilResultsButton(page);
  await page.clock.runFor(400);
  const log = await apiRequests(page);
  expect(log.filter((entry) => entry.startsWith(`stream ${RESUME}`))).toEqual([
    `stream ${RESUME}?threadId=${THREAD}&selectedTrackId=${candidates[1].id}&pickedBy=click`,
  ]);
  expect(log.filter((entry) => entry.startsWith("fetch /api/analyze"))).toEqual([]);
  expect((await streamLog(page)).filter((entry) => entry.endsWith("reconnect"))).toEqual([]);
  await expect(page.getByText("Analysis complete.", { exact: true })).toHaveCount(1);
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

  await expect(page.getByRole("heading", { name: "The analysis did not finish" })).toBeVisible();
  // The code decides the words, not the words "not found" in the message.
  await expect(
    page.getByText("That choice is no longer open. Try again to get a fresh list of tracks."),
  ).toBeVisible();
  await expect(page.getByText(/No song matched/)).toHaveCount(0);
  // A code this page has words for shows those words alone, not the server's message too.
  await expect(page.getByText(/This choice has expired/)).toHaveCount(0);

  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByText("Is this the right track?")).toBeVisible();
  const log = await apiRequests(page);
  expect(log.filter((entry) => entry.startsWith(`stream ${ANALYZE}?`))).toHaveLength(2);
  expect(log.filter((entry) => entry.startsWith("fetch /api/analyze"))).toEqual([]);
});

// What the error block says for each code: the page's words where the server's message says
// nothing more, the server's own message where it carries specifics (a wait time, a service),
// with a next step only when the message has none.
for (const { code, error, lines, action } of [
  {
    code: "no_match",
    error: "No song matched that search.",
    lines: ["No song matched your search. Check the title and artist, then search again."],
    action: "Search again",
  },
  {
    code: "timeout",
    error: "The analysis took too long. Please try again.",
    lines: [
      "The analysis took too long and was stopped. Try again, or search for a different song.",
    ],
    action: "Try again",
  },
  {
    code: "upstream_unavailable",
    error: "Spotify is limiting requests right now. Please try again in about 45 s.",
    lines: ["Spotify is limiting requests right now. Please try again in about 45 s."],
    action: "Try again",
  },
  {
    code: "failed",
    error: "The request could not be completed. Please try again.",
    lines: ["The request could not be completed. Please try again."],
    action: "Try again",
  },
  {
    code: "internal_error",
    error: "Something went wrong. Please try again.",
    lines: ["Something went wrong. Please try again."],
    action: "Try again",
  },
  {
    code: "invalid_input",
    error: "The request is not valid.",
    lines: ["The request could not be read. Search again."],
    action: "Search again",
  },
  // Codes this page does not know: the server's message, then the next step. The names of an
  // object's own built-in members are codes like any other.
  ...["some_new_code", "toString", "constructor"].map((code) => ({
    code,
    error: "A new kind of failure.",
    lines: ["A new kind of failure.", "Try again, or search for a different song."],
    action: "Try again",
  })),
]) {
  test(`a failure with code ${code} says what happened and offers ${action}`, async ({ page }) => {
    await useMockApi(page, {
      suggestions: [],
      streams: {
        [ANALYZE]: failure(code, error).map((event) =>
          event.type === "error" && error === "A new kind of failure."
            ? { $unchecked: event }
            : event,
        ),
      },
    });
    await search(page, "Hurt");
    const heading = page.getByRole("heading", { name: "The analysis did not finish" });
    await expect(heading).toBeVisible();
    const block = heading.locator("xpath=..");
    await expect(block.locator("p")).toHaveText(lines);
    await expect(block.getByRole("button", { name: action, exact: true })).toBeVisible();
    // Never a second "try again" after a message that already says it.
    expect(
      (await block.locator("p").allInnerTexts()).join(" ").match(/try again/gi)?.length ?? 0,
    ).toBeLessThanOrEqual(1);
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
