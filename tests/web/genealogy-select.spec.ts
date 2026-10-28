import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  apiRequests,
  collectProblems,
  loadFixture,
  openPlayer,
  replayedRecording,
  useMockApi,
} from "./mock";
import { offline } from "./offline";

// Selecting a track on the song-relations map (#217): a click, a tap or Enter selects a card and
// opens its details in the map's panel (never an analysis); "Analyze this track" there is the
// one way the map starts one. The panel says how each relation is known (the record and its
// retrieval date for a code link, the verifier's verdict for a model link), keeps clear of the
// selected card, takes the focus and gives it back. A/B listening plays the two previews in
// order, and in a replay says they play in a live analysis. Filters change what the map, the
// list and the counts show.

test.use({ reducedMotion: "reduce" });

const ANALYZE = "/api/analyze/stream";

test.beforeEach(async ({ page }) => {
  await offline(page);
});

const graphOf = (page: Page) =>
  page.locator('#panel-genealogy svg[aria-label="Connections graph"]');
const cardOf = (page: Page, id: string) =>
  graphOf(page).locator(`g.nodes > g[data-node-id="${id}"]`);
const panelOf = (page: Page) => page.getByTestId("node-detail");
const analyses = async (page: Page) =>
  (await apiRequests(page)).filter((entry) => entry.startsWith(`stream ${ANALYZE}?`));

type Box = { x: number; y: number; width: number; height: number };
const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width - 0.5 &&
  b.x < a.x + a.width - 0.5 &&
  a.y < b.y + b.height - 0.5 &&
  b.y < a.y + a.height - 0.5;

/** Two frames: React has drawn the panel, and the map has moved the card clear of it. */
const settled = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done(null)))),
  );

async function screenshot(page: Page, testInfo: TestInfo, name: string, part?: Locator) {
  const dir = process.env.GENEALOGY_SHOTS_DIR ?? testInfo.project.outputDir;
  mkdirSync(dir, { recursive: true });
  await (part ?? page.locator("#panel-genealogy")).screenshot({
    path: join(dir, `select-${name}.png`),
  });
}

/** The panel and the selected card on screen: the panel never covers the card. */
async function expectClear(page: Page, id: string) {
  await settled(page);
  const [panel, card] = await Promise.all([
    panelOf(page).boundingBox(),
    cardOf(page, id).locator("rect.card").boundingBox(),
  ]);
  if (!panel || !card) throw new Error("no layout");
  expect(overlap(panel, card), `the panel covers ${id}`).toBe(false);
}

const SHOWCASES = {
  "genealogy-kinds": {
    open: async (page: Page) => {
      await useMockApi(page, loadFixture("genealogy-kinds"));
      await analyzeAndOpenDashboard(page, "Bright Lines");
      await openPlayer(page);
    },
    code: { id: "sample-sourced", retrieved: "20 Oct 2026" },
    model: { id: "model-verified", verdict: "Verifier: supported by its sources" },
    replay: false,
  },
  rich: {
    open: async (page: Page) => {
      await useMockApi(page, loadFixture("genealogy-rich"));
      await analyzeAndOpenDashboard(page, "Bright Lines");
      await openPlayer(page);
    },
    code: { id: "s2", retrieved: "20 Oct 2026" },
    model: {
      id: "i1",
      verdict: "Verifier: not checked; no claim in this result states this relation",
    },
    replay: false,
  },
  "one-more-time": {
    open: async (page: Page) => {
      const { events } = replayedRecording();
      await useMockApi(page, { suggestions: [], eventGapMs: 0, streams: { [ANALYZE]: events } });
      await analyzeAndOpenDashboard(page, "One More Time Daft Punk");
      await openPlayer(page);
    },
    code: { id: "mb-cd6c8d5c-fd3b-4ec4-bb57-7a59451f7edb", retrieved: "27 Oct 2026" },
    model: null,
    replay: true,
  },
} as const;

for (const [showcase, { open, code, model, replay }] of Object.entries(SHOWCASES)) {
  for (const [width, height] of [
    [390, 844],
    [1024, 768],
    [1440, 900],
  ] as const) {
    test(`at ${width} px on ${showcase} a click or Enter selects, the panel shows the evidence and stays clear, Analyze analyses`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      const problems = collectProblems(page);
      await page.setViewportSize({ width, height });
      await open(page);
      if (width < 768) await page.getByRole("tab", { name: "Connections" }).click();
      const card = cardOf(page, code.id);
      await expect(card).toHaveCount(1);
      await graphOf(page).scrollIntoViewIfNeeded();
      expect(await analyses(page)).toHaveLength(1);

      // A click selects the card: no analysis starts, the panel opens with the focus.
      // (The card is first brought into the map's view, as the keyboard brings it.)
      await card.focus();
      await card.blur();
      await card.click();
      await expect(card).toHaveAttribute("aria-pressed", "true");
      const panel = panelOf(page);
      await expect(panel).toBeVisible();
      await expect(panel).toBeFocused();
      expect(await analyses(page)).toHaveLength(1);
      await expectClear(page, code.id);

      // The code link: "Sourced from" the record, its source a link, and the day it was read.
      const sourced = panel.locator("[data-sourced-from]").first();
      await expect(sourced).toContainText("Sourced from");
      await expect(sourced).toContainText(`retrieved ${code.retrieved}`);
      await expect(sourced.locator("a[href^='https://']").first()).toBeVisible();
      // In a replay the pair cannot play, and the panel says where it does.
      if (replay) {
        await expect(panel.locator("[data-listening-unavailable]")).toHaveText(
          "Previews play in a live analysis: a replay does not keep them.",
        );
        await expect(panel.getByRole("button", { name: /Hear/ })).toHaveCount(0);
      }
      await screenshot(page, testInfo, `${showcase}-${width}-panel`);

      // Escape closes it, and the focus is back on the card.
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(card).toBeFocused();
      await expect(card).toHaveAttribute("aria-pressed", "false");

      // Enter selects it again: the focus moves into the panel; still no analysis.
      await page.keyboard.press("Enter");
      await expect(panel).toBeFocused();
      expect(await analyses(page)).toHaveLength(1);
      await expectClear(page, code.id);

      // A model link: the verifier's verdict.
      if (model) {
        const other = cardOf(page, model.id);
        await page.getByRole("button", { name: "Close details" }).click();
        await other.focus();
        await page.keyboard.press("Enter");
        await expect(panel.locator("[data-verifier]").first()).toContainText(model.verdict);
        await expectClear(page, model.id);
        await page.keyboard.press("Escape");
        await expect(other).toBeFocused();
        await page.keyboard.press("Escape");
        await card.focus();
        await page.keyboard.press("Enter");
      }

      // "Analyze this track" analyses it.
      await panel.getByRole("button", { name: "Analyze this track" }).click();
      await expect.poll(async () => (await analyses(page)).length).toBe(2);
      expect(problems).toEqual([]);
    });
  }

  for (const [width, height] of [
    [390, 844],
    [1440, 900],
  ] as const) {
    test(`at ${width} px on ${showcase} the filters change the counts, and "Sourced only" hides every inferred link`, async ({
      page,
    }, testInfo) => {
      test.setTimeout(120_000);
      await page.setViewportSize({ width, height });
      await open(page);
      if (width < 768) await page.getByRole("tab", { name: "Connections" }).click();
      const graph = graphOf(page);
      await expect(graph.locator("g.nodes > g").first()).toBeVisible();
      const lines = graph.locator("g.links path");
      const total = await lines.count();
      const sourcedCount = await graph.locator('g.links path[data-link-kind="sourced"]').count();
      const cards = await graph.locator("g.nodes > g").count();
      await expect(page.getByText(`Links as a list (${total})`)).toBeVisible();

      await page.getByRole("button", { name: "Filter links" }).click();
      const first = page.getByRole("checkbox").first();
      const label = (await first.locator("xpath=..").textContent()) ?? "";
      const count = Number(/\((\d+)\)$/.exec(label)?.[1]);
      expect(count).toBeGreaterThan(0);
      await first.uncheck();
      await expect(page.getByTestId("filter-status")).toHaveText(
        `Showing ${total - count} of ${total} links`,
      );
      await expect(lines).toHaveCount(total - count);
      await expect(page.getByText(`Links as a list (${total - count})`)).toBeVisible();
      // The analysed track stays, whatever is hidden.
      await expect(graph.locator("g.nodes > g:not([aria-pressed])")).toHaveCount(1);
      await screenshot(page, testInfo, `${showcase}-${width}-filters`);
      await first.check();

      await page.getByRole("checkbox", { name: "Sourced only" }).check();
      await expect(lines).toHaveCount(sourcedCount);
      await expect(graph.locator('g.links path:not([data-link-kind="sourced"])')).toHaveCount(0);
      await expect(page.getByTestId("filter-status")).toHaveText(
        `Showing ${sourcedCount} of ${total} links`,
      );
      if (sourcedCount < total) {
        expect(await graph.locator("g.nodes > g").count()).toBeLessThan(cards);
      }
      await page.getByRole("button", { name: "Clear filters" }).click();
      await expect(lines).toHaveCount(total);
      await expect(page.getByTestId("filter-status")).toHaveText(`Showing all ${total} links`);
    });
  }
}

/** The genealogy-rich result with preview clips (never real ones): this track and Funky Drummer. */
function richWithPreviews() {
  const fixture = loadFixture("genealogy-rich");
  const complete = fixture.streams[ANALYZE].find(
    (event: { type: string }) => event.type === "complete",
  );
  complete.data.previewUrl = "https://previews.example.test/bright-lines.mp3";
  const source = complete.data.genealogy.nodes.find((node: { id: string }) => node.id === "s2");
  source.previewUrl = "https://previews.example.test/funky-drummer.mp3";
  return fixture;
}

/**
 * The audio element, stubbed: it loads nothing, records each clip asked to play, and a test ends
 * the clip playing (`window.__endClip()`).
 */
async function stubAudio(page: Page) {
  await page.addInitScript(() => {
    const played: string[] = [];
    const state = new WeakMap<HTMLMediaElement, { src: string; paused: boolean; ended: boolean }>();
    const of = (element: HTMLMediaElement) => {
      let found = state.get(element);
      if (!found) {
        found = { src: "", paused: true, ended: false };
        state.set(element, found);
      }
      return found;
    };
    const proto = HTMLMediaElement.prototype;
    let last: HTMLMediaElement | null = null;
    Object.defineProperty(proto, "src", {
      configurable: true,
      get() {
        return of(this).src;
      },
      set(value: string) {
        of(this).src = String(value);
        of(this).ended = false;
      },
    });
    for (const name of ["paused", "ended"] as const) {
      Object.defineProperty(proto, name, {
        configurable: true,
        get() {
          return of(this)[name];
        },
      });
    }
    Object.defineProperty(proto, "error", { configurable: true, get: () => null });
    proto.play = function play(this: HTMLMediaElement) {
      const s = of(this);
      played.push(s.src);
      s.paused = false;
      last = this;
      this.dispatchEvent(new Event("play"));
      return Promise.resolve();
    };
    proto.pause = function pause(this: HTMLMediaElement) {
      const s = of(this);
      if (s.paused) return;
      s.paused = true;
      this.dispatchEvent(new Event("pause"));
    };
    proto.load = () => {};
    const w = window as unknown as { __played: string[]; __endClip: () => void };
    w.__played = played;
    w.__endClip = () => {
      if (!last) return;
      const s = of(last);
      s.paused = true;
      s.ended = true;
      last.dispatchEvent(new Event("ended"));
    };
  });
}

const playedClips = (page: Page) =>
  page.evaluate(() => (window as unknown as { __played: string[] }).__played.slice());
const endClip = (page: Page) =>
  page.evaluate(() => (window as unknown as { __endClip: () => void }).__endClip());

test("A/B listening plays the sample, then this track, in order, and Escape stops it", async ({
  page,
}, testInfo) => {
  const problems = collectProblems(page);
  await stubAudio(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, richWithPreviews());
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  const card = cardOf(page, "s2");
  await card.focus();
  await page.keyboard.press("Enter");
  const panel = panelOf(page);
  const status = panel.locator("[data-listening-status]");
  await panel.getByRole("button", { name: "Hear the sample" }).click();
  await expect(status).toHaveText("Playing: Funky Drummer, Parts 1 & 2 (1970) (1 of 2)");
  expect(await playedClips(page)).toEqual(["https://previews.example.test/funky-drummer.mp3"]);
  await screenshot(page, testInfo, "ab-1440");
  await endClip(page);
  await expect(status).toHaveText("Playing: Bright Lines (2011) (2 of 2)");
  expect(await playedClips(page)).toEqual([
    "https://previews.example.test/funky-drummer.mp3",
    "https://previews.example.test/bright-lines.mp3",
  ]);
  await endClip(page);
  await expect(status).toHaveText("");
  await expect(panel.getByRole("button", { name: "Hear the sample" })).toBeVisible();

  // Escape stops it, and the panel stays; the next Escape closes the panel.
  await panel.getByRole("button", { name: "Hear the sample" }).click();
  await expect(panel.getByRole("button", { name: "Stop" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(panel.getByRole("button", { name: "Hear the sample" })).toBeVisible();
  await expect(status).toHaveText("");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(card).toBeFocused();
  expect(problems).toEqual([]);
});

test.describe("on a touch screen", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("a tap selects a track and shows its chips and panel; it analyses nothing", async ({
    page,
  }, testInfo) => {
    await useMockApi(page, loadFixture("genealogy-rich"));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    await page.getByRole("tab", { name: "Connections" }).tap();
    const card = cardOf(page, "s2");
    await card.focus();
    await card.blur();
    await card.tap();
    await expect(card).toHaveAttribute("aria-pressed", "true");
    await expect(panelOf(page)).toBeVisible();
    await expectClear(page, "s2");
    await screenshot(page, testInfo, "tap-390");
    await expect(graphOf(page).locator("g.link-chips g.chip").first()).toBeVisible();
    expect(await analyses(page)).toHaveLength(1);
  });
});
