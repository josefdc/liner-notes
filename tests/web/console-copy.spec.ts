import { expect, type Page, test } from "@playwright/test";
import { collectProblems, fullResultData, releaseStream, useMockApi } from "./mock";

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
  await page.getByRole("button", { name: "ANALYZE_SONG" }).click();
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

test("measuring is said only while a measurement runs, and the bar never moves back", async ({
  page,
}) => {
  const engineer = (code: string, message: string) => ({
    type: "status",
    node: "engineer",
    code,
    message,
  });
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: "t-steps" },
        { type: "status", node: "scout", code: "SPOTIFY-FOUND", message: "Found the track" },
        engineer("AUDIO-COMPLETE", "Measured in an earlier run: 123 BPM, A minor"),
        { $wait: "cache" },
        engineer("AUDIO-INIT", "Measuring tempo and key from the preview clip"),
        { $wait: "measuring" },
        { type: "status", node: "historian", code: "RESEARCH-START", message: "Searching sources" },
        engineer("AUDIO-COMPLETE", "Measured from the preview: 123 BPM, A minor"),
        { $wait: "parallel" },
        { type: "complete", data: fullResultData() },
        { type: "done" },
      ],
    },
  });
  await search(page, "Bright Lines");

  const seen: number[] = [];
  await expect(statusLine(page)).toHaveText("Reading the audio...");
  seen.push(await progress(page));

  await releaseStream(page, "cache");
  await expect(statusLine(page)).toHaveText(
    "Measuring tempo, key and energy from the preview clip...",
  );
  seen.push(await progress(page));

  await releaseStream(page, "measuring");
  await expect(page.getByRole("log")).toContainText("Measured from the preview");
  await expect(statusLine(page)).toHaveText(
    "Searching sources for samples, credits and history...",
  );
  seen.push(await progress(page));

  expect(seen).toEqual([...seen].sort((a, b) => a - b));
  expect(seen.at(-1)).toBe(70);
  await releaseStream(page, "parallel");
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
