import { expect, type Page, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  fullResultData,
  holdClock,
  loadFixture,
  releaseStream,
  runUntilResultsButton,
  useMockApi,
} from "./mock";

// With "reduce motion" set, nothing on the page moves by itself: no smooth scroll the page
// starts (the track picker, the run log), no frame loop (the genealogy graph's hints and its
// zoom), no chart animation, and the stylesheet's own animations and transitions end at once
// (the progress bar, the spinners). The graph's hint is shown without the setting too, to show
// that what the tests measure does move then.

const ANALYZE = "/api/analyze/stream";
const RESUME = "/api/analyze/stream/resume";

/**
 * Counts the page's animation frames and records each scroll into view it asks for, and how many
 * frames had been asked for when the genealogy graph was last drawn (`__drawnAt`).
 */
async function watchMotion(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as { __frames: number; __scrolls: string[]; __drawnAt: number };
    w.__frames = 0;
    w.__scrolls = [];
    w.__drawnAt = -1;
    const frame = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      w.__frames++;
      return frame(callback);
    };
    // Read once the drawing code has run to its end (a mutation observer's turn comes after it).
    new MutationObserver((records) => {
      const drawn = records.some((record) =>
        [...record.addedNodes].some(
          (added) => added instanceof Element && added.querySelector?.("g.nodes"),
        ),
      );
      if (drawn) w.__drawnAt = w.__frames;
    }).observe(document, { subtree: true, childList: true });
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
  // The page's time is held once the run waits (see `holdClock`).
  await page.clock.install();
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

  // The run completes, its time held: the completion screen is read before the results open by
  // themselves.
  await holdClock(page);
  await releaseStream(page, "end");
  await runUntilResultsButton(page);
  await expect(page.getByRole("log")).toBeVisible();
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

/**
 * The genealogy-kinds result with three connected tracks, so the map is drawn (with two
 * relations or fewer it is a compact row): one a sourced sample says this one uses (an origin,
 * its hover hint fading in), and two the model proposed. None has a preview clip.
 */
function withSourcedOrigin() {
  const fixture = loadFixture("genealogy-kinds");
  const complete = fixture.streams[ANALYZE].find(
    (event: { type: string }) => event.type === "complete",
  );
  const genealogy = complete.data.genealogy as {
    nodes: Array<{ id: string }>;
    links: Array<{ source: string; target: string }>;
  };
  const keep = new Set(["current", "sample-sourced", "sample-inferred", "influence-inferred"]);
  genealogy.nodes = genealogy.nodes.filter((node) => keep.has(node.id));
  genealogy.links = genealogy.links.filter(
    (link) => keep.has(link.source) && keep.has(link.target),
  );
  return fixture;
}

/**
 * Opens the Player on that result once its graph is drawn. `drawnAt` is how many frames had
 * been asked for when the graph was last drawn: nothing more is asked for unless something moves
 * (a hint fading in, a zoom gliding).
 */
async function openGraph(page: Page, reducedMotion: "reduce" | "no-preference") {
  await page.emulateMedia({ reducedMotion });
  await watchMotion(page);
  await useMockApi(page, withSourcedOrigin());
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await page.getByRole("button", { name: "View full analysis" }).click();
  const graph = graphOf(page);
  await expect(graph.locator("g.nodes > g")).toHaveCount(4);
  // The map's row, below the columns, in view to be pointed at.
  await graph.scrollIntoViewIfNeeded();
  const drawnAt = await page.evaluate(() => (window as unknown as { __drawnAt: number }).__drawnAt);
  expect(drawnAt).toBeGreaterThanOrEqual(0);
  const framesBefore = await frames(page);
  return { graph, drawnAt, framesBefore };
}

/** The origin's card. */
const origin = (graph: ReturnType<typeof graphOf>) =>
  graph.locator('g.nodes > g[data-node-id="sample-sourced"]');

test("a double click on the genealogy graph zooms in over frames without reduced motion (control)", async ({
  page,
}) => {
  const { graph, framesBefore } = await openGraph(page, "no-preference");
  const box = await graph.boundingBox();
  if (!box) throw new Error("no graph box");
  // An empty corner of the graph, away from the tracks.
  await page.mouse.dblclick(box.x + 6, box.y + box.height - 6);
  await expect.poll(() => frames(page)).toBeGreaterThan(framesBefore);
});

test("the genealogy graph is drawn settled under reduced motion: no frame asked for once it is drawn", async ({
  page,
}) => {
  const { drawnAt } = await openGraph(page, "reduce");
  const first = await graphPlaces(page);
  expect(first.nodes.every((place) => place?.startsWith("translate("))).toBe(true);
  expect(first.zoom).toMatch(/^translate\(.*\) scale\(/);
  await page.waitForTimeout(700);
  expect(await graphPlaces(page)).toEqual(first);
  expect(await frames(page)).toBe(drawnAt);
});

test("pointing at a card shows its relations at once under reduced motion", async ({ page }) => {
  // A track a sourced sample says this one uses: pointing at it names its relations in chips,
  // and selecting it draws its ring; nothing fades in.
  const { graph, framesBefore } = await openGraph(page, "reduce");
  await origin(graph).dispatchEvent("mouseenter");
  await expect(graph.locator("g.link-chips g.chip").first()).toBeVisible();
  await origin(graph).dispatchEvent("click");
  await expect(origin(graph)).toHaveAttribute("aria-pressed", "true");
  await expect(origin(graph).locator("rect.select-ring")).toHaveAttribute("opacity", "1");
  await page.waitForTimeout(400);
  expect(await frames(page)).toBe(framesBefore);
});

test("a drag on a card pans the map and leaves every card at its year, under reduced motion", async ({
  page,
}) => {
  const { graph, framesBefore } = await openGraph(page, "reduce");
  const before = await graphPlaces(page);
  // This track's card, in the first view.
  const box = await graph.locator('g.nodes > g[data-node-id="current"]').boundingBox();
  if (!box) throw new Error("no card box");
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await graphPlaces(page);
  // The cards keep their places on the map; the view moved; nothing played out; and the drag
  // (a press on a card) selected nothing.
  await expect(graph.locator('g.nodes > g[aria-pressed="true"]')).toHaveCount(0);
  await expect(page.getByTestId("node-detail")).toHaveCount(0);
  expect(after.nodes).toEqual(before.nodes);
  expect(after.zoom).not.toBe(before.zoom);
  expect(await frames(page)).toBe(framesBefore);
});

test("a double click zooms in one step under reduced motion", async ({ page }) => {
  const { graph, framesBefore } = await openGraph(page, "reduce");
  await graph.evaluate((svg) => {
    const zoom = svg.querySelector(":scope > g") as Element;
    const seen: string[] = [];
    (window as unknown as { __zooms: string[] }).__zooms = seen;
    new MutationObserver(() => seen.push(zoom.getAttribute("transform") ?? "")).observe(zoom, {
      attributes: true,
      attributeFilter: ["transform"],
    });
  });
  const box = await graph.boundingBox();
  if (!box) throw new Error("no graph box");
  // An empty corner of the graph, away from the tracks.
  await page.mouse.dblclick(box.x + 6, box.y + box.height - 6);
  await page.waitForTimeout(500);
  const zooms = await page.evaluate(() => (window as unknown as { __zooms: string[] }).__zooms);
  expect(zooms).toHaveLength(1);
  expect(await frames(page)).toBe(framesBefore);
});

// Recharts draws the chart at once under reduced motion by itself (its `isAnimationActive`
// defaults to "auto", which reads the setting): this pins that behaviour of the library. The
// outline may be drawn again as the chart takes its size; an animation draws dozens of shapes
// in between (with animation forced on, this test sees about 50).
test("the genre chart is drawn at once under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  // Every shape the chart's outline takes, from the first one drawn.
  await page.addInitScript(() => {
    const shapes: string[] = [];
    (window as unknown as { __shapes: string[] }).__shapes = shapes;
    const record = () => {
      for (const path of document.querySelectorAll(".recharts-radar-polygon path")) {
        const d = path.getAttribute("d") ?? "";
        if (shapes.at(-1) !== d) shapes.push(d);
      }
    };
    new MutationObserver(record).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["d"],
    });
  });
  await useMockApi(page, loadFixture("full-result"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await expect(page.locator(".recharts-radar-polygon path").first()).toBeVisible();
  await page.waitForTimeout(900);
  const shapes = await page.evaluate(() => (window as unknown as { __shapes: string[] }).__shapes);
  expect(shapes.length).toBeLessThanOrEqual(3);
});
