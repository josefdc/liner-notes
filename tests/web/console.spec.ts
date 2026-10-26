import { expect, type Page, test } from "@playwright/test";
import { collectProblems, releaseStream, replayedRecording, useMockApi } from "./mock";

// The run log on a replay of the recorded demo run: a line the server repeats shows once, the
// log keeps its latest lines and says how many it dropped, no model id is shown, and new lines
// scroll the log itself, never the page around it. The replayed result says it is a recording.

const ANALYZE = "/api/analyze/stream";
// The most lines the log keeps (apps/web/src/hooks/agent/runLog.ts LOG_LIMIT).
const LOG_LIMIT = 100;
// More lines than the log keeps, sent after the opening of the recording.
const EXTRA = LOG_LIMIT + 20;
const REPEATED = "Searching: sample history on the web";
// Model ids as providers name them ("gemini-2.5-flash", "gpt-4o", "claude-…").
const MODEL_ID =
  /\b(gemini|gpt|claude|llama|mistral|mixtral|deepseek|qwen|gemma|command-r|o[134])[-.\d]/i;

// How long the EXTRA lines may take to arrive: a slow machine handles each line in more than the
// mock's 10 ms between two of them.
const ALL_LINES_MS = 30_000;

const tool = (message: string) => ({ type: "status", node: "research_tool", message });

/**
 * The recorded run with its research line repeated by the server, a pause (`more`) after its
 * opening, EXTRA more lines after the pause, and a pause (`finish`) before its result.
 */
function replayStream() {
  const { events, recordedAt } = replayedRecording();
  const out: Array<Record<string, unknown>> = [];
  for (const event of events) {
    if (event.type === "complete") {
      out.push(
        ...Array.from({ length: EXTRA }, (_, n) => tool(`Reading source ${n + 1} of ${EXTRA}`)),
        { $wait: "finish" },
      );
    }
    out.push(event);
    if (event.message === REPEATED) out.push(tool(REPEATED), { $wait: "more" });
  }
  return { events: out, recordedAt };
}

/** The scroll positions of the page and of every box around the run log. */
function scrollsAroundLog(page: Page) {
  return page.getByRole("log").evaluate((log) => {
    const boxes: number[] = [window.scrollY];
    for (let box = log.parentElement; box; box = box.parentElement) boxes.push(box.scrollTop);
    return boxes;
  });
}

// Short windows (a phone, a tablet and a laptop window with the browser's bars): the progress
// screen is taller than each, so the page around the log can scroll.
for (const [width, height] of [
  [390, 600],
  [820, 560],
  [1440, 560],
] as const) {
  test(`a replayed run's log at ${width} px: each line once, bounded, no model id, the page held still`, async ({
    page,
  }) => {
    const problems = collectProblems(page);
    await page.setViewportSize({ width, height });
    const { events, recordedAt } = replayStream();
    await useMockApi(page, { suggestions: [], eventGapMs: 10, streams: { [ANALYZE]: events } });
    await page.goto("/");
    await page.getByPlaceholder(/Song title/).fill("One More Time Daft Punk");
    await page.getByRole("button", { name: "Analyze", exact: true }).click();

    const log = page.getByRole("log");
    await expect(log).toContainText(REPEATED);
    // Paused after the repeat: the line the server sent twice in a row is shown once.
    await expect.soft(log.getByText(REPEATED, { exact: true })).toHaveCount(1);
    await expect(page.locator("[data-progress-status]")).toBeFocused();

    // The page and every box around the log are scrolled to their top, where the log's end is
    // out of view: a line that scrolled anything but the log would move them.
    await log.evaluate((element) => {
      window.scrollTo(0, 0);
      for (let box = element.parentElement; box; box = box.parentElement) box.scrollTop = 0;
    });
    // Something around the log can scroll: a scroll into view would move it.
    const range = await log.evaluate((element) => {
      let most = document.documentElement.scrollHeight - window.innerHeight;
      for (let box = element.parentElement; box; box = box.parentElement) {
        most = Math.max(most, box.scrollHeight - box.clientHeight);
      }
      return most;
    });
    expect(range, "the page around the log can scroll").toBeGreaterThan(40);
    const still = await scrollsAroundLog(page);

    // Sampled on every frame while the lines arrive.
    await page.evaluate(() => {
      const samples: number[][] = [];
      const log = document.querySelector('[role="log"]') as HTMLElement;
      const sample = () => {
        const boxes = [window.scrollY];
        for (let box = log.parentElement; box; box = box.parentElement) boxes.push(box.scrollTop);
        samples.push(boxes);
        (window as unknown as { __sampling: number }).__sampling = requestAnimationFrame(sample);
      };
      (window as unknown as { __samples: number[][] }).__samples = samples;
      sample();
    });
    await releaseStream(page, "more");
    await expect(log).toContainText(`Reading source ${EXTRA} of ${EXTRA}`, {
      timeout: ALL_LINES_MS,
    });
    const samples = await page.evaluate(() => {
      const w = window as unknown as { __sampling: number; __samples: number[][] };
      cancelAnimationFrame(w.__sampling);
      return w.__samples;
    });
    expect(samples.length).toBeGreaterThan(5);
    expect.soft(samples.filter((sample) => sample.join() !== still.join())).toEqual([]);
    expect.soft(await scrollsAroundLog(page)).toEqual(still);

    // The log itself follows the newest line.
    const end = await log.evaluate((box) => box.scrollHeight - box.scrollTop - box.clientHeight);
    expect.soft(end).toBeLessThanOrEqual(2);

    // Bounded: the latest LOG_LIMIT lines, and a note of how many came before them.
    await expect.soft(log.locator("[data-log-label]")).toHaveCount(LOG_LIMIT);
    const written = await page
      .getByText(/^\d+ events$/)
      .textContent()
      .then((text) => Number.parseInt(text ?? "", 10));
    expect(written).toBeGreaterThan(EXTRA);
    await expect
      .soft(log.locator("[data-log-dropped]"))
      .toHaveText(`${written - LOG_LIMIT} earlier lines not shown`);

    // No model id on the progress screen, in the log or anywhere else.
    expect.soft(await page.locator("#root").innerText()).not.toMatch(MODEL_ID);

    await releaseStream(page, "finish");
    await page.getByRole("button", { name: "Open the results" }).click();
    const notice = page.getByRole("region", { name: "Recorded run" }).first();
    await expect(notice).toBeVisible();
    const date = new Date(recordedAt).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
      timeZone: "UTC",
    });
    await expect(notice).toContainText(`Recorded run · ${date} · replayed`);
    expect(await page.locator("#root").innerText()).not.toMatch(MODEL_ID);
    expect(problems).toEqual([]);
  });
}

test("a reader who scrolled up in the log stays at the line they read while lines arrive", async ({
  page,
}) => {
  await page.setViewportSize({ width: 820, height: 900 });
  const { events } = replayStream();
  await useMockApi(page, { suggestions: [], eventGapMs: 10, streams: { [ANALYZE]: events } });
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("One More Time Daft Punk");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();

  const log = page.getByRole("log");
  await expect(log).toContainText(REPEATED);
  // The reader scrolls the log up, as a wheel or a finger would.
  await log.hover();
  await page.mouse.wheel(0, -2000);
  await expect.poll(() => log.evaluate((box) => box.scrollTop)).toBe(0);
  await releaseStream(page, "more");
  await expect(log).toContainText(`Reading source ${EXTRA} of ${EXTRA}`, {
    timeout: ALL_LINES_MS,
  });
  expect(await log.evaluate((box) => box.scrollTop)).toBe(0);

  // Back at the end, the newest lines are followed again.
  await page.mouse.wheel(0, 100_000);
  await expect
    .poll(() => log.evaluate((box) => box.scrollHeight - box.scrollTop - box.clientHeight))
    .toBeLessThanOrEqual(2);
  await releaseStream(page, "finish");
  await expect(log).toContainText("Recorded analysis replayed");
  await expect
    .poll(() => log.evaluate((box) => box.scrollHeight - box.scrollTop - box.clientHeight))
    .toBeLessThanOrEqual(2);
});

test("log labels and their icons keep off the measured cyan and the sourced amber", async ({
  page,
}) => {
  const { events } = replayStream();
  await useMockApi(page, { suggestions: [], eventGapMs: 10, streams: { [ANALYZE]: events } });
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("One More Time Daft Punk");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  const log = page.getByRole("log");
  await expect(log).toContainText(REPEATED);
  const colours = await page.evaluate(() => {
    const probe = document.createElement("span");
    document.body.append(probe);
    const tone = (token: string) => {
      probe.style.color = `var(${token})`;
      return getComputedStyle(probe).color;
    };
    const hues = { measured: tone("--color-cyber"), sourced: tone("--color-analog") };
    probe.remove();
    const labels = [...document.querySelectorAll('[role="log"] [data-log-label]')].map(
      (label) => getComputedStyle(label).color,
    );
    return { hues, labels };
  });
  expect(colours.labels.length).toBeGreaterThan(5);
  for (const colour of colours.labels) {
    expect(colour).not.toBe(colours.hues.measured);
    expect(colour).not.toBe(colours.hues.sourced);
  }
});
