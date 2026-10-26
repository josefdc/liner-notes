import { expect, type Page, test } from "@playwright/test";
import { apiRequests, collectProblems, fullResultData, releaseStream, useMockApi } from "./mock";

// The progress screen and its run log say what the run is doing: the picker in the server's
// words, measuring only while a measurement runs, waiting and replaying as such, and a progress
// bar that never moves back.

const ANALYZE = "/api/analyze/stream";
const candidate = {
  id: "4iV5W9uYEdYUVa79Axb7Rh",
  title: "Hurt",
  artist: "Johnny Cash",
  album: "American IV",
  coverUrl: "",
};

async function search(page: Page, query: string) {
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill(query);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
}

// The visible status line follows the live region that repeats it for screen readers.
const statusLine = (page: Page) => page.locator('div.sr-only[aria-live="polite"] + div');
const progress = (page: Page) =>
  page.getByRole("progressbar").getAttribute("aria-valuenow").then(Number);
const runLog = (page: Page) => page.locator('section[aria-label="Analysis log"]');

test("a picker with one candidate says so in the server's words, and waits", async ({ page }) => {
  const problems = collectProblems(page);
  const message = "One possible track from Spotify; confirm it or search again";
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: "t-one" },
        { type: "status", node: "scout", code: "SPOTIFY-SEARCH", message: "Searching Spotify" },
        {
          type: "interrupt",
          reason: "disambiguation",
          threadId: "t-one",
          candidates: [candidate],
          message,
        },
        { type: "done" },
      ],
    },
  });
  await search(page, "Hurt");
  await expect(page.getByText("Is this the right track?")).toBeVisible();

  const line = page.getByRole("log").locator("[data-log-label]").last();
  await expect(line.locator("xpath=..")).toContainText(message);
  await expect(line).toHaveText("Spotify");
  await expect(statusLine(page)).toHaveText(message);
  await expect(page.locator('div.sr-only[aria-live="polite"]')).toHaveText(message);
  await expect(page.getByText(/Several tracks|Multiple matches/)).toHaveCount(0);
  await expect(page.getByText(/warning/i)).toHaveCount(0);
  await expect(runLog(page)).toContainText("Waiting for your pick");
  await expect(runLog(page)).not.toContainText(/Running|Run in progress/);
  expect(problems).toEqual([]);
});

// The opening of the recorded demo run, in the API's order: the historian reports before any
// await, the engineer only after its health probe and preview lookup (research at 328 ms,
// AUDIO-INIT at 753 ms, the engineer's result at 10 877 ms).
const status = (node: string, message: string, code?: string) => ({
  type: "status",
  node,
  message,
  ...(code ? { code } : {}),
});
const OPENING = [
  { type: "connected", threadId: "t-steps" },
  status("scout", "Reading the track from Spotify", "NET-100"),
  status("scout", "Found the track on Spotify: One More Time by Daft Punk", "SPOTIFY-FOUND"),
];
const MEASURING = "Measuring tempo, key and energy from the preview clip...";
const SEARCHING = "Searching sources for samples, credits and history...";

/** Reads the status line and the bar at each pause of the stream, in order. */
async function stepsAt(page: Page, waits: string[]) {
  const seen: Array<{ line: string; bar: number }> = [];
  for (const wait of waits) {
    await expect(page.getByRole("log")).toContainText(`[${wait}]`);
    seen.push({ line: (await statusLine(page).textContent()) ?? "", bar: await progress(page) });
    await releaseStream(page, wait);
  }
  return seen;
}

const marker = (wait: string) => [status("research_tool", `[${wait}]`), { $wait: wait }];

test("a picker with one candidate can be left to search again, from the keyboard", async ({
  page,
}) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: "t-again" },
        {
          type: "interrupt",
          reason: "disambiguation",
          threadId: "t-again",
          candidates: [candidate],
          message: "One possible track from Spotify; confirm it or search again",
        },
        { type: "done" },
      ],
    },
  });
  await search(page, "Hurt");
  await expect(page.getByText("Is this the right track?")).toBeVisible();
  const again = page.getByRole("button", { name: "Search again" });
  await expect(again).toBeVisible();
  // Reached with Tab from the picker, and used with Enter.
  for (
    let step = 0;
    step < 5 && !(await again.evaluate((el) => el === document.activeElement));
    step++
  ) {
    await page.keyboard.press("Tab");
  }
  await expect(again).toBeFocused();
  await page.keyboard.press("Enter");

  const input = page.getByPlaceholder(/Song title/);
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Hurt");
  await expect(page.getByText("Is this the right track?")).toHaveCount(0);
  // The countdown is cancelled: nothing is picked after it would have run out.
  await page.waitForTimeout(6000);
  expect((await apiRequests(page)).filter((entry) => entry.includes("resume"))).toEqual([]);
});

test("the measurement shows while research runs, in the API's order, and the bar never moves back", async ({
  page,
}) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        ...OPENING,
        status("historian", "Starting the research: Last.fm, MusicBrainz", "RESEARCH-START"),
        ...marker("research"),
        status("engineer", "Measuring tempo and key from the preview clip", "AUDIO-INIT"),
        status("research_manager", "Starting the research steps"),
        status("research_manager", "Choosing follow-up step 1 of at most 2"),
        ...marker("measuring"),
        status(
          "engineer",
          "Measured 123 BPM; key not given: one pitch line without stable notes",
          "AUDIO-ERROR",
        ),
        ...marker("measured"),
        { type: "complete", data: fullResultData() },
        { type: "done" },
      ],
    },
  });
  await search(page, "One More Time");
  const seen = await stepsAt(page, ["research", "measuring", "measured"]);
  expect(seen.map(({ line }) => line)).toEqual([SEARCHING, MEASURING, SEARCHING]);
  const bars = seen.map(({ bar }) => bar);
  expect(bars).toEqual([...bars].sort((a, b) => a - b));
});

test("after a research cache hit, the measurement shows for as long as it runs", async ({
  page,
}) => {
  const stored = "Using the research stored by an earlier run";
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        ...OPENING,
        status("historian", stored, "RESEARCH-FOUND"),
        ...marker("stored"),
        status("engineer", "Measuring tempo and key from the preview clip", "AUDIO-INIT"),
        ...marker("measuring"),
        status("engineer", "Measured from the preview: 123 BPM, A minor", "AUDIO-COMPLETE"),
        ...marker("measured"),
        { type: "complete", data: fullResultData() },
        { type: "done" },
      ],
    },
  });
  await search(page, "One More Time");
  const seen = await stepsAt(page, ["stored", "measuring", "measured"]);
  expect(seen.map(({ line }) => line)).toEqual([stored, MEASURING, stored]);
  const bars = seen.map(({ bar }) => bar);
  expect(bars).toEqual([...bars].sort((a, b) => a - b));
});

test("a replay says it replays the recorded run, not that it is running", async ({ page }) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: "t-replay" },
        {
          type: "status",
          node: "replay",
          code: "SYS-INIT",
          message: "Replaying an analysis recorded on 2026-10-01; nothing below runs live.",
        },
        { type: "status", node: "scout", code: "SPOTIFY-FOUND", message: "Found the track" },
        { $wait: "end" },
        { type: "complete", data: fullResultData() },
        { type: "done" },
      ],
    },
  });
  await search(page, "Bright Lines");
  await expect(page.getByRole("log")).toContainText("Found the track");
  await expect(runLog(page)).toContainText("Replaying the recorded run");
  await expect(runLog(page)).not.toContainText(/Running|Run in progress/);
  await releaseStream(page, "end");
});

for (const width of [390, 1440]) {
  test(`a long step label stays clear of its message at ${width} px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await useMockApi(page, {
      suggestions: [],
      streams: {
        [ANALYZE]: [
          { type: "connected", threadId: "t-wide" },
          {
            type: "status",
            node: "verifier",
            code: "LLM-ERROR",
            message: "Two claims got no verdict",
          },
          {
            type: "status",
            node: "verifier",
            code: "LLM-WARN",
            message: "One claim was judged on part of its sources",
          },
          { $wait: "end" },
        ],
      },
    });
    await search(page, "Bright Lines");
    for (const text of ["Model check error", "Model check warning"]) {
      const label = page.getByRole("log").locator("[data-log-label]", { hasText: text });
      await expect(label).toBeVisible();
      const message = label.locator("xpath=following-sibling::span[1]");
      const [a, b] = [await label.boundingBox(), await message.boundingBox()];
      if (!a || !b) throw new Error("no box");
      expect(a.x + a.width, text).toBeLessThanOrEqual(b.x);
      // The label wraps inside its own box: nothing spills over its edge.
      expect(await label.evaluate((el) => el.scrollWidth <= el.clientWidth), text).toBe(true);
    }
    await releaseStream(page, "end");
  });
}
