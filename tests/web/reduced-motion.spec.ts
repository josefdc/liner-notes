import { expect, type Page, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  fullResultData,
  loadFixture,
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

// The connected track's preview clip. Its request is held unanswered, so the clip neither plays
// nor fails, and the hover hint for it stays up.
const PREVIEW = "https://p.scdn.co/mp3-preview/reduced-motion-test";

/** The full result, its connected track with a preview clip (hovering it shows a hint). */
function withPreview() {
  const fixture = loadFixture("full-result");
  const complete = fixture.streams[ANALYZE].find(
    (event: { type: string }) => event.type === "complete",
  );
  const nodes = complete.data.genealogy.nodes as Array<Record<string, unknown>>;
  const origin = nodes.find((node) => node.id === "origin1");
  if (origin) origin.previewUrl = PREVIEW;
  return fixture;
}

/**
 * Opens the Player on the full result (`fixture`, by default the one whose connected track has a
 * preview), once its graph is drawn. `drawnAt` is how many frames had been asked for when the
 * graph was last drawn: building the force simulation asks for one, in which its timer finds
 * nothing to run, and nothing more is asked for unless something moves (a layout played out
 * frame by frame, a zoom gliding to fit).
 */
async function openGraph(
  page: Page,
  reducedMotion: "reduce" | "no-preference",
  fixture: unknown = withPreview(),
) {
  await page.emulateMedia({ reducedMotion });
  await watchMotion(page);
  await page.route("https://p.scdn.co/**", () => {});
  await useMockApi(page, fixture);
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await page.getByRole("button", { name: "VIEW FULL ANALYSIS" }).click();
  const graph = graphOf(page);
  await expect(graph.locator("g.nodes > g")).toHaveCount(2);
  const drawnAt = await page.evaluate(() => (window as unknown as { __drawnAt: number }).__drawnAt);
  expect(drawnAt).toBeGreaterThanOrEqual(0);
  const framesBefore = await frames(page);
  return { graph, drawnAt, framesBefore };
}

/** The connected track's node (the current track's is the first). */
const connected = (graph: ReturnType<typeof graphOf>) => graph.locator("g.nodes > g").last();

test("the genealogy graph lays itself out in frames without reduced motion (control)", async ({
  page,
}) => {
  const { framesBefore } = await openGraph(page, "no-preference");
  // The layout plays out over many frames (about five seconds), and the zoom glides to fit.
  await expect.poll(() => frames(page)).toBeGreaterThan(framesBefore);
});

test("the genealogy graph is drawn settled under reduced motion: no frame asked for once it is drawn", async ({
  page,
}) => {
  const { drawnAt } = await openGraph(page, "reduce");
  const first = await graphPlaces(page);
  expect(first.nodes.every((place) => place?.startsWith("translate("))).toBe(true);
  expect(first.zoom).toMatch(/^translate\(.*\) scale\(/);
  // Longer than the zoom's glide to fit (500 ms from the drawing) would take.
  await page.waitForTimeout(700);
  expect(await graphPlaces(page)).toEqual(first);
  expect(await frames(page)).toBe(drawnAt);
});

test("a hover hint appears at once under reduced motion", async ({ page }) => {
  const { graph, framesBefore } = await openGraph(page, "reduce");
  await connected(graph).hover();
  const hint = graph.locator(".preview-indicator");
  await expect(hint).toHaveCount(1);
  expect(await hint.evaluate((text) => getComputedStyle(text).opacity)).toBe("1");
  await page.waitForTimeout(400);
  expect(await frames(page)).toBe(framesBefore);
});

test("a drag moves the dragged track alone under reduced motion", async ({ page }) => {
  const { graph, framesBefore } = await openGraph(page, "reduce");
  const before = await graphPlaces(page);
  const box = await connected(graph).boundingBox();
  if (!box) throw new Error("no node box");
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const after = await graphPlaces(page);
  // The current track stays; the dragged one is where it was left; nothing played out.
  expect(after.nodes[0]).toBe(before.nodes[0]);
  expect(after.nodes[1]).not.toBe(before.nodes[1]);
  expect(after.zoom).toBe(before.zoom);
  expect(await frames(page)).toBe(framesBefore);
});

test("a drag under reduced motion places the names again for where the track was left", async ({
  page,
}) => {
  // The plain full result: no preview to play while the track is dragged.
  const { graph } = await openGraph(page, "reduce", loadFixture("full-result"));
  const names = () =>
    graph.evaluate((svg) =>
      [...svg.querySelectorAll("g.node-label")].map((name) => name.getAttribute("visibility")),
    );
  expect(await names()).toEqual([null, null]);
  const from = await connected(graph).boundingBox();
  const onto = await graph.locator("g.nodes > g").first().boundingBox();
  if (!from || !onto) throw new Error("no node box");
  // The connected track dropped on the current one: their names would overlap.
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(onto.x + onto.width / 2 + 5, onto.y + onto.height / 2 + 5, { steps: 6 });
  await page.mouse.up();
  // One name is left: the dragged track's, which the pointer is on.
  expect(await names()).toEqual(["hidden", null]);
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
  await page.mouse.dblclick(box.x + 20, box.y + 20);
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
