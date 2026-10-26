import { expect, type Page, test } from "@playwright/test";
import {
  apiRequests,
  collectProblems,
  fullResultData,
  releaseStream,
  replayedRecording,
  streamLog,
  useMockApi,
} from "./mock";

// Stop on the progress screen closes the run's stream (the API aborts a run whose client has
// gone: RunControl in apps/api/src/http/routes/analyze.ts), brings the search back with the
// keyboard in its box, and leaves nothing of the stopped run to arrive later. A new search
// then runs as usual.

const ANALYZE = "/api/analyze/stream";
const status = (node: string, message: string, code?: string) => ({
  type: "status",
  node,
  message,
  ...(code ? { code } : {}),
});

/** A run paused at `hold` after its first lines, then lines and a result that must never show. */
const stoppedRun = [
  { type: "connected", threadId: "t-stop" },
  status("scout", "Reading the track from Spotify", "NET-100"),
  status("historian", "Starting the research: Last.fm, MusicBrainz", "RESEARCH-START"),
  { $wait: "hold" },
  status("historian", "A line after the stop", "RESEARCH-FOUND"),
  { type: "complete", data: fullResultData() },
  { type: "done" },
];

/** The run the next search gets. */
const nextRun = [
  { type: "connected", threadId: "t-next" },
  status("scout", "Found the track on Spotify", "SPOTIFY-FOUND"),
  { type: "complete", data: fullResultData() },
  { type: "done" },
];

async function search(page: Page, query: string) {
  await page.getByPlaceholder(/Song title/).fill(query);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
}

/** What the analysis stream did after the app closed it. */
async function afterClose(page: Page) {
  const entries = (await streamLog(page)).filter((entry) => entry.startsWith(ANALYZE));
  const closed = entries.indexOf(`${ANALYZE} closed`);
  expect(closed, entries.join("\n")).toBeGreaterThan(-1);
  return entries.slice(closed + 1);
}

/** Stops the run, checks the search is back with the keyboard in it and the stream closed. */
async function stopAndCheck(page: Page, query: string, wait: string) {
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  // From the keyboard: the status line has the focus, and Stop is the next stop.
  await expect(page.locator("[data-progress-status]")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(stop).toBeFocused();
  await page.keyboard.press("Enter");

  const input = page.getByPlaceholder(/Song title/);
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(query);
  await expect(page.getByRole("log")).toHaveCount(0);

  // The stream is closed at once, and whatever the server would still send never arrives.
  expect(await afterClose(page)).toEqual([]);
  await releaseStream(page, wait);
  await page.waitForTimeout(600);
  expect(await afterClose(page)).toEqual([]);
  await expect(page.getByRole("log")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open the results" })).toHaveCount(0);
  await expect(page.getByText("A line after the stop")).toHaveCount(0);
  await expect(input).toBeFocused();
  // One request: the stopped run is not opened again (EventSource reconnects only when not closed).
  expect((await apiRequests(page)).filter((entry) => entry.startsWith("stream "))).toHaveLength(1);
}

test("Stop closes the run's stream, brings the search back, and a new search runs", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, {
    suggestions: [],
    streams: { [ANALYZE]: { opens: [stoppedRun, nextRun] } },
  });
  await page.goto("/");
  await search(page, "Hurt");
  await expect(page.getByRole("log")).toContainText("Starting the research");

  await stopAndCheck(page, "Hurt", "hold");

  // A new search works as usual.
  await search(page, "One More Time");
  await expect(page.getByRole("log")).toContainText("Found the track on Spotify");
  await expect(page.getByRole("log")).not.toContainText("A line after the stop");
  await page.getByRole("button", { name: "Open the results" }).click();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("a replayed run can be stopped too", async ({ page }) => {
  const problems = collectProblems(page);
  const { events } = replayedRecording();
  // Paused once the replay notice and the first steps have arrived.
  const research = events.findIndex((event) => event.code === "RESEARCH-START");
  const replay = [
    ...events.slice(0, research + 1),
    { $wait: "replay" },
    ...events.slice(research + 1),
  ];
  await useMockApi(page, {
    suggestions: [],
    streams: { [ANALYZE]: { opens: [replay, nextRun] } },
  });
  await page.goto("/");
  await search(page, "One More Time Daft Punk");
  await expect(page.getByRole("log")).toContainText("Starting the research");
  await expect(page.locator('section[aria-label="Analysis log"]')).toContainText(
    "Replaying the recorded run",
  );

  await stopAndCheck(page, "One More Time Daft Punk", "replay");

  await search(page, "One More Time");
  await expect(page.getByRole("button", { name: "Open the results" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("Stop is not offered once the run has completed, nor beside the picker", async ({ page }) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: {
        opens: [
          [
            { type: "connected", threadId: "t-pick" },
            {
              type: "interrupt",
              reason: "disambiguation",
              threadId: "t-pick",
              candidates: [
                {
                  id: "4iV5W9uYEdYUVa79Axb7Rh",
                  title: "Hurt",
                  artist: "Johnny Cash",
                  album: "American IV",
                  coverUrl: "",
                },
              ],
              message: "One possible track from Spotify; confirm it or search again",
            },
            { type: "done" },
          ],
          nextRun,
        ],
      },
    },
  });
  await page.goto("/");
  await search(page, "Hurt");
  await expect(page.getByText("Is this the right track?")).toBeVisible();
  // The picker has its own way back to the search.
  await expect(page.getByRole("button", { name: "Search again" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);

  await page.getByRole("button", { name: "Search again" }).click();
  await search(page, "One More Time");
  await expect(page.getByRole("button", { name: "Open the results" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
});
