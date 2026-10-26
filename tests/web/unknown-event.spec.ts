import { expect, type Page, test } from "@playwright/test";
import { collectProblems, fullResultData, loadFixture, streamLog, useMockApi } from "./mock";

// The app reads the API's streams with the contract's event union: an event of a type it does
// not know, or one that does not fit the contract, is skipped (and logged once); repeats of an
// event (same run, same seq), events of another run and a second `complete` of the run are
// ignored. The mocked API adds the run id and seq the API sends (../mock-sse/envelope.ts).
//
// Once a run has its result the app ignores everything else its streams send, so a second
// `complete` of the same run changes nothing whatever the stream guard does; the guard is what
// keeps out a `complete` of another run that arrives first.
const ANALYZE = "/api/analyze/stream";
const RESUME = "/api/analyze/stream/resume";
const RUN = "3f6c1d2e-0000-4000-8000-0000000000aa";
const COMPLETE_LOG = "Analysis complete.";
const result = fullResultData() as { title: string };
const hitl = loadFixture("hitl");
const candidates = hitl.streams[ANALYZE].find(
  (event: { type: string }) => event.type === "interrupt",
).candidates as Array<{ id: string }>;

async function search(page: Page, query: string) {
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill(query);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
}

async function openDashboard(page: Page) {
  await page.getByRole("button", { name: "Open the results" }).click();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
}

test("an unknown event type is ignored, logged once, and the run goes on to its result", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: RUN },
        // A type from a newer server, sent twice, and a known type that does not fit the
        // contract (a status without its message): all skipped.
        { $unchecked: { type: "lyrics-preview", text: "Not for this client" } },
        { $unchecked: { type: "lyrics-preview", text: "Again" } },
        { $unchecked: { type: "status", node: "scout", code: "SPOTIFY-SEARCH" } },
        {
          type: "status",
          node: "scout",
          message: "Searching for the track",
          code: "SPOTIFY-SEARCH",
        },
        { type: "complete", data: result },
        { type: "done" },
      ],
    },
  });
  await search(page, "Hurt");

  await expect(page.getByRole("button", { name: "Open the results" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The analysis did not finish" })).toHaveCount(0);
  await expect(page.getByText("Searching for the track")).toHaveCount(1);
  // A status without a message is not shown as a placeholder line.
  await expect(page.getByText("Processing...")).toHaveCount(0);
  await expect(page.getByText(COMPLETE_LOG, { exact: true })).toHaveCount(1);
  expect(
    (await streamLog(page)).filter((entry) => entry === `${ANALYZE} lyrics-preview`),
  ).toHaveLength(2);
  // Each kind of skipped message is logged once.
  expect(problems).toEqual([
    expect.stringMatching(/^warning: .*\(lyrics-preview\): unknown type/),
    expect.stringMatching(/^warning: .*\(status\): does not fit the contract/),
  ]);

  await openDashboard(page);
  await expect(page.getByText(result.title).first()).toBeVisible();
});

test("a duplicate complete for the same run is ignored", async ({ page }) => {
  const problems = collectProblems(page);
  const duplicate = { ...result, title: "Duplicate Result" };
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: RUN },
        { type: "status", node: "composer", message: "Composing", code: "LLM-RESPONSE" },
        { type: "complete", data: result },
        // The same event again (same seq), then a second result of the run.
        { type: "complete", data: duplicate, seq: 2 },
        { type: "complete", data: duplicate },
        { type: "done" },
      ],
    },
  });
  await search(page, "Hurt");

  await expect(page.getByRole("button", { name: "Open the results" })).toBeVisible();
  await expect
    .poll(async () => (await streamLog(page)).filter((entry) => entry === `${ANALYZE} complete`))
    .toHaveLength(3);
  await expect(page.getByText(COMPLETE_LOG, { exact: true })).toHaveCount(1);
  await openDashboard(page);
  await expect(page.getByText(result.title).first()).toBeVisible();
  await expect(page.getByText("Duplicate Result")).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("a complete of another run that arrives before the run's own is ignored", async ({ page }) => {
  const problems = collectProblems(page);
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: RUN },
        { type: "status", node: "composer", message: "Composing", code: "LLM-RESPONSE" },
        // A result of an older run on this connection, then the run's own.
        {
          type: "complete",
          runId: "older-run",
          seq: 2,
          data: { ...result, title: "Older Run Result" },
        },
        { type: "complete", runId: RUN, seq: 3, data: result },
        { type: "done", runId: RUN, seq: 4 },
      ],
    },
  });
  await search(page, "Hurt");

  await expect(page.getByRole("button", { name: "Open the results" })).toBeVisible();
  await expect
    .poll(async () => (await streamLog(page)).filter((entry) => entry === `${ANALYZE} done`))
    .toHaveLength(1);
  await expect(page.getByText(COMPLETE_LOG, { exact: true })).toHaveCount(1);
  await openDashboard(page);
  await expect(page.getByText(result.title).first()).toBeVisible();
  await expect(page.getByText("Older Run Result")).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("a result from a newer API that this page reads leniently is shown", async ({ page }) => {
  const problems = collectProblems(page);
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: RUN },
        // A run mode added by a newer API: additive in the contract, unknown to this page.
        {
          $unchecked: {
            type: "complete",
            data: { ...result, run: { id: RUN, mode: "replay-v2", fallback: false } },
          },
        },
        { type: "done" },
      ],
    },
  });
  await search(page, "Hurt");

  await expect(page.getByRole("button", { name: "Open the results" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "The analysis did not finish" })).toHaveCount(0);
  expect(problems).toEqual([
    expect.stringMatching(/^warning: .*\(complete\): does not fit the contract; read leniently/),
  ]);
  await openDashboard(page);
  await expect(page.getByText(result.title).first()).toBeVisible();
});

test("a result this page cannot read asks for a reload", async ({ page }) => {
  collectProblems(page);
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: RUN },
        { $unchecked: { type: "complete", data: "not a result" } },
        { type: "done" },
      ],
    },
  });
  await search(page, "Hurt");

  await expect(page.getByRole("heading", { name: "The analysis did not finish" })).toBeVisible();
  await expect(page.getByText(/This page is out of date. Reload the page/)).toBeVisible();
  await expect(page.getByText("The analysis ended without a result.")).toHaveCount(0);
});

test("a repeated event and an event of another run are ignored on the resume stream", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: RUN },
        {
          type: "interrupt",
          reason: "disambiguation",
          threadId: RUN,
          candidates,
          message: "Multiple songs found. Please select the correct one.",
        },
        { type: "done" },
      ],
      [RESUME]: [
        { type: "resuming", threadId: RUN },
        { type: "status", node: "engineer", message: "Analyzing audio", code: "AUDIO-INIT" },
        // Repeated by a proxy: same run, same seq.
        {
          type: "status",
          node: "engineer",
          message: "Analyzing audio",
          code: "AUDIO-INIT",
          seq: 1,
        },
        // A result of an older run on this connection.
        { type: "complete", runId: "older-run", data: { ...result, title: "Older Run Result" } },
        { type: "complete", data: result },
        { type: "done" },
      ],
    },
  });
  await search(page, "Hurt");
  await expect(page.getByText("Is this the right track?")).toBeVisible();
  await page.keyboard.press("Enter");

  await expect(page.getByRole("button", { name: "Open the results" })).toBeVisible();
  await expect(page.getByText("Analyzing audio")).toHaveCount(1);
  await expect(page.getByText(COMPLETE_LOG, { exact: true })).toHaveCount(1);
  await openDashboard(page);
  await expect(page.getByText(result.title).first()).toBeVisible();
  await expect(page.getByText("Older Run Result")).toHaveCount(0);
  expect(problems).toEqual([]);
});
