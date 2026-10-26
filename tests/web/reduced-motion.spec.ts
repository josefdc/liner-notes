import { expect, type Page, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  fullResultData,
  loadFixture,
  openPlayer,
  releaseStream,
  useMockApi,
} from "./mock";

// With "reduce motion" set, nothing on the page moves by itself: no smooth scroll the page
// starts (the track picker, the run log), no frame loop (the genealogy graph's layout and its
// zoom to fit), no chart animation, and the stylesheet's own animations and transitions end at
// once (the progress bar, the spinners). The graph test is run without the setting too, to show
// that what it measures does move then.

const ANALYZE = "/api/analyze/stream";
const RESUME = "/api/analyze/stream/resume";

/** Counts the page's animation frames and records each scroll into view it asks for. */
async function watchMotion(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __frames: number; __scrolls: string[] };
    w.__frames = 0;
    w.__scrolls = [];
    const frame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      w.__frames++;
      return frame(callback);
    };
    const intoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions) {
      w.__scrolls.push(typeof options === "object" ? (options.behavior ?? "auto") : "auto");
      return intoView.call(this, options);
    };
  });
}

const frames = (page: Page) =>
  page.evaluate(() => (window as unknown as { __frames: number }).__frames);
const scrolls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __scrolls: string[] }).__scrolls);

/** The page's animations that are still playing. */
const playing = (page: Page) =>
  page.evaluate(() =>
    document
      .getAnimations()
      .filter((animation) => animation.playState === "running")
      .map((animation) => (animation as CSSAnimation).animationName ?? "transition"),
  );

const candidates = [
  { id: "4iV5W9uYEdYUVa79Axb7Rh", title: "Hurt", artist: "Johnny Cash", album: "A", coverUrl: "" },
  {
    id: "5iV5W9uYEdYUVa79Axb7Rh",
    title: "Hurt",
    artist: "Nine Inch Nails",
    album: "B",
    coverUrl: "",
  },
];

test("the picker and the progress screen do not move under reduced motion", async ({ page }) => {
  const problems = collectProblems(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 600 });
  await watchMotion(page);
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: "t-motion" },
        { type: "status", node: "scout", code: "SPOTIFY-SEARCH", message: "Searching Spotify" },
        {
          type: "interrupt",
          reason: "disambiguation",
          threadId: "t-motion",
          candidates,
          message: "Two possible tracks from Spotify; pick one",
        },
        { type: "done" },
      ],
      [RESUME]: [
        { type: "resuming", threadId: "t-motion" },
        ...Array.from({ length: 30 }, (_, n) => ({
          type: "status",
          node: "historian",
          code: "RESEARCH-FOUND",
          message: `Read source ${n + 1}`,
        })),
        { $wait: "end" },
        { type: "complete", data: fullResultData() },
        { type: "done" },
      ],
    },
  });
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Hurt");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();

  // The picker is brought into view at once, not with a smooth scroll.
  await expect(page.getByText("Is this the right track?")).toBeVisible();
  await expect.poll(() => scrolls(page)).not.toEqual([]);
  await page.getByRole("option", { name: /Nine Inch Nails/ }).click();
  await expect(page.getByRole("log")).toContainText("Read source 30");
  expect(await scrolls(page)).not.toContain("smooth");

  // The spinners and the bar's shimmer have stopped; the bar jumps to its place.
  await expect.poll(() => playing(page)).toEqual([]);
  const bar = page.getByRole("progressbar").locator("> div");
  const duration = await bar.evaluate((fill) => getComputedStyle(fill).transitionDuration);
  expect(Number.parseFloat(duration)).toBeLessThan(0.001);

  // Nothing asks for frames while the run waits.
  const before = await frames(page);
  await page.waitForTimeout(500);
  expect(await frames(page)).toBe(before);

  await releaseStream(page, "end");
  await expect(page.getByRole("button", { name: "Open the results" })).toBeVisible();
  await expect.poll(() => playing(page)).toEqual([]);
  expect(problems).toEqual([]);
});

/** The genealogy graph's drawing. */
const graphOf = (page: Page) => page.locator("#panel-genealogy svg:has(g.nodes)");

/** Where each node of the genealogy graph is drawn, and the zoom. */
const graphPlaces = (page: Page) =>
  graphOf(page).evaluate((svg) => ({
    zoom: svg.querySelector(":scope > g")?.getAttribute("transform") ?? null,
    nodes: [...svg.querySelectorAll("g.nodes > g")].map((node) => node.getAttribute("transform")),
  }));

for (const reducedMotion of ["reduce", "no-preference"] as const) {
  test(`the genealogy graph ${reducedMotion === "reduce" ? "is drawn settled, with no frame loop," : "lays itself out in frames"} (motion: ${reducedMotion})`, async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion });
    await watchMotion(page);
    await useMockApi(page, loadFixture("full-result"));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    const graph = graphOf(page);
    await expect(graph.locator("g.nodes > g")).toHaveCount(2);

    const first = await graphPlaces(page);
    const framesBefore = await frames(page);
    await page.waitForTimeout(300);
    const later = await graphPlaces(page);
    const framesAfter = await frames(page);

    if (reducedMotion === "no-preference") {
      // The layout plays out over many frames (about five seconds), and the zoom glides to fit.
      expect(framesAfter).toBeGreaterThan(framesBefore);
      return;
    }
    expect(first.nodes.every((place) => place?.startsWith("translate("))).toBe(true);
    expect(later).toEqual(first);
    expect(framesAfter).toBe(framesBefore);

    // A hover shows its hint at once, with no fade.
    await graph.locator("g.nodes > g").last().hover();
    const hints = graph.locator(".preview-indicator");
    for (const hint of await hints.all()) {
      expect(await hint.evaluate((text) => getComputedStyle(text).opacity)).toBe("1");
    }
    await page.waitForTimeout(200);
    expect(await frames(page)).toBe(framesAfter);
    expect(await graphPlaces(page)).toEqual(first);
  });
}

test("the genre chart is drawn at once under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await useMockApi(page, loadFixture("full-result"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  const shape = page.locator(".recharts-radar-polygon path").first();
  await expect(shape).toBeVisible();
  const first = await shape.getAttribute("d");
  await page.waitForTimeout(300);
  expect(await shape.getAttribute("d")).toBe(first);
});
