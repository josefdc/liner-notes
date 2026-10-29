import { expect, type Page, test } from "@playwright/test";
import {
  collectProblems,
  holdClock,
  openResults,
  releaseStream,
  replayedRecording,
  runUntilResultsButton,
  useMockApi,
} from "./mock";
import { offline } from "./offline";

// The recorded run's cover, and any other outside address, are answered on the page: nothing
// leaves the machine.
test.beforeEach(async ({ page }) => {
  await offline(page);
});

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

const COVER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="100%" height="100%" fill="#336699"/></svg>';

const tool = (message: string) => ({ type: "status", node: "research_tool", message });

const extra = (n: number) => tool(`Reading source ${n} of ${EXTRA}`);

/**
 * The recorded run with its research line repeated by the server, a pause (`more`) after its
 * opening, EXTRA more lines after the pause, and a pause (`finish`) before its result. With
 * `half`, a pause (`half`) after the first `half` of the EXTRA lines too.
 */
function replayStream(half?: number) {
  const { events, recordedAt } = replayedRecording();
  const out: Array<Record<string, unknown>> = [];
  for (const event of events) {
    if (event.type === "complete") {
      const lines = Array.from({ length: EXTRA }, (_, n) => extra(n + 1));
      if (half) out.push(...lines.slice(0, half), { $wait: "half" }, ...lines.slice(half));
      else out.push(...lines);
      out.push({ $wait: "finish" });
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
    // The recording's cover is the Cover Art Archive's: answered here, never from the network.
    await page.route("https://coverartarchive.org/**", (route) =>
      route.fulfill({ contentType: "image/svg+xml", body: COVER_SVG }),
    );
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
    await openResults(page);
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

/** Opens the progress screen on the recorded run, paused after the first 60 extra lines. */
async function logAtHalf(page: Page, width: number) {
  await page.setViewportSize({ width, height: 900 });
  const { events } = replayStream(60);
  await useMockApi(page, { suggestions: [], eventGapMs: 10, streams: { [ANALYZE]: events } });
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("One More Time Daft Punk");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  const log = page.getByRole("log");
  await expect(log).toContainText(REPEATED);
  await releaseStream(page, "more");
  await expect(log).toContainText(`Reading source 60 of ${EXTRA}`, { timeout: ALL_LINES_MS });
  return log;
}

/** How far the log is from its end, in pixels. */
const fromEnd = (log: ReturnType<Page["getByRole"]>) =>
  log.evaluate((box) => box.scrollHeight - box.scrollTop - box.clientHeight);

/**
 * A line of the log and how far below the top of the log's view it starts: the line with `text`,
 * or else the first line wholly in view.
 */
const lineInView = (log: ReturnType<Page["getByRole"]>, text?: string) =>
  log.evaluate((box, wanted) => {
    const top = box.getBoundingClientRect().top;
    const row = [...box.querySelectorAll<HTMLElement>("[data-log-id]")].find((line) =>
      wanted
        ? line.lastElementChild?.textContent === wanted
        : line.getBoundingClientRect().top >= top + 2,
    );
    return {
      text: row?.lastElementChild?.textContent ?? "",
      offset: row ? row.getBoundingClientRect().top - top : Number.NaN,
    };
  }, text);

test("a reader scrolled up mid-log stays on the line they read while older lines are dropped", async ({
  page,
}) => {
  await page.clock.install();
  const log = await logAtHalf(page, 820);
  // The browser's own scroll anchoring is off, as in a browser without it: the log alone keeps
  // the reader's place.
  await log.evaluate((box) => {
    box.style.overflowAnchor = "none";
  });
  // The reader scrolls up a few lines, as a wheel would, to the middle of the log.
  await log.hover();
  await page.mouse.wheel(0, -300);
  await expect.poll(() => fromEnd(log)).toBeGreaterThan(200);
  const before = await lineInView(log);
  // Still kept once the rest arrives: lines up to "Reading source 20" are dropped then.
  expect(Number(/Reading source (\d+)/.exec(before.text)?.[1])).toBeGreaterThan(25);

  await releaseStream(page, "half");
  await expect(log).toContainText(`Reading source ${EXTRA} of ${EXTRA}`, {
    timeout: ALL_LINES_MS,
  });
  await expect(log.locator("[data-log-dropped]")).toBeVisible();
  const after = await lineInView(log, before.text);
  expect(after.text).toBe(before.text);
  expect(Math.abs(after.offset - before.offset)).toBeLessThanOrEqual(1);

  // Back at the end, the newest lines are followed again.
  await page.mouse.wheel(0, 100_000);
  await expect.poll(() => fromEnd(log)).toBeLessThanOrEqual(2);
  // The run completes: its last lines are read with the page's time held (see `holdClock`).
  await holdClock(page);
  await releaseStream(page, "finish");
  await runUntilResultsButton(page);
  await expect(log).toContainText("Recorded analysis replayed");
  await expect.poll(() => fromEnd(log)).toBeLessThanOrEqual(2);
});

test("a reader at the end stays there when the window narrows and the lines wrap", async ({
  page,
}) => {
  const log = await logAtHalf(page, 1440);
  await expect.poll(() => fromEnd(log)).toBeLessThanOrEqual(2);
  const tall = await log.evaluate((box) => box.scrollHeight);
  // No new line arrives: only the lines' own height changes.
  await page.setViewportSize({ width: 390, height: 900 });
  await expect.poll(() => log.evaluate((box) => box.scrollHeight)).toBeGreaterThan(tall + 100);
  await expect.poll(() => fromEnd(log)).toBeLessThanOrEqual(2);
  await releaseStream(page, "half");
  await releaseStream(page, "finish");
});

test("a reader scrolled up mid-log stays on their line when the window narrows and the lines wrap", async ({
  page,
}) => {
  const log = await logAtHalf(page, 1440);
  await log.evaluate((box) => {
    box.style.overflowAnchor = "none";
  });
  await log.hover();
  await page.mouse.wheel(0, -300);
  await expect.poll(() => fromEnd(log)).toBeGreaterThan(200);
  const before = await lineInView(log);
  // No new line arrives: only the lines' own height changes.
  const tall = await log.evaluate((box) => box.scrollHeight);
  await page.setViewportSize({ width: 390, height: 900 });
  await expect.poll(() => log.evaluate((box) => box.scrollHeight)).toBeGreaterThan(tall + 100);
  await expect
    .poll(async () => Math.abs((await lineInView(log, before.text)).offset - before.offset))
    .toBeLessThanOrEqual(1);
  await releaseStream(page, "half");
  await releaseStream(page, "finish");
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
