import { expect, type Page, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  animationsSettled,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";
import { offline } from "./offline";

// In forced-colors mode (Windows High Contrast) the browser drops box-shadow, so the
// `focus-visible:ring-*` focus rings disappear; only an outline is left to show where the
// keyboard focus is. Every control on the main screens must keep one that is painted: a style
// other than `none`, a width above zero, a colour that is not transparent, and a box that no
// ancestor clips (an `overflow-hidden` panel cuts an outline drawn outside the control).
// `outline-none` takes it away; `outline-hidden` keeps a transparent outline that forced-colors
// mode draws in the system colour. The map's cards and links are SVG, which forced-colors mode
// does not recolour: they show their own focus ring instead, and no outline.
// Outside forced-colors mode the same controls draw no outline and keep their ring.

const ANALYZE = "/api/analyze/stream";
const fullResult = loadFixture("full-result");
/** A result whose map is drawn as cards (the full result's is a single row of buttons). */
const kindsResult = loadFixture("genealogy-kinds");
const MAP_TRACK = "5eFgHiJkLmNoPqRsTuVwXy";
/** The map's own elements, which show their focus with a ring drawn in the SVG. */
const MAP_ITEMS = "g.nodes > g, g.link-targets > path";

type Stop = {
  what: string;
  cls: string;
  outlineStyle: string;
  outlineWidth: number;
  outlineAlpha: number;
  boxShadow: string;
  focusVisible: boolean;
  role: string | null;
  chip: boolean;
  mapItem: boolean;
  /** Not shown at all: wholly clipped (a collapsed panel's scroller, a visually hidden h1). */
  hidden: boolean;
  /** Ancestors (or the window) that cut the outline's box, as "<tag.classes>: <side> <px>". */
  clippedBy: string[];
};

/** Installs `window.__describeFocus`, which reports on the focused element. */
async function installProbe(page: Page) {
  await page.addInitScript((mapItems) => {
    const alpha = (colour: string) => {
      if (colour === "transparent") return 0;
      const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(colour);
      if (slash) return Number(slash[1]) / (slash[2] ? 100 : 1);
      const rgba = /^rgba\([^)]*,\s*([\d.]+)\)$/.exec(colour);
      return rgba ? Number(rgba[1]) : 1;
    };
    (window as unknown as { __describeFocus: () => unknown }).__describeFocus = () => {
      const element = document.activeElement;
      if (!element || element === document.body || element === document.documentElement) {
        return null;
      }
      const style = getComputedStyle(element);
      const name = (
        element.getAttribute("aria-label") ??
        element.getAttribute("placeholder") ??
        element.textContent ??
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 60);
      const width = Number.parseFloat(style.outlineWidth) || 0;
      const offset = Number.parseFloat(style.outlineOffset) || 0;
      // The outline's outer edge: past the border box by its offset and width.
      const grow = style.outlineStyle === "none" ? 0 : Math.max(width + offset, 0);
      const rect = element.getBoundingClientRect();
      const box = {
        left: rect.left - grow,
        top: rect.top - grow,
        right: rect.right + grow,
        bottom: rect.bottom + grow,
      };
      const clippedBy: string[] = [];
      const cut = (label: string, clip: typeof box) => {
        const sides = (
          [
            ["left", clip.left - box.left],
            ["top", clip.top - box.top],
            ["right", box.right - clip.right],
            ["bottom", box.bottom - clip.bottom],
          ] as const
        ).filter(([, by]) => by > 0.5);
        if (sides.length > 0) {
          clippedBy.push(
            `${label}: ${sides.map(([side, by]) => `${side} ${by.toFixed(1)}px`).join(", ")}`,
          );
        }
      };
      // Each ancestor that clips: one that hides its overflow cuts at its padding box; a
      // scroller cuts at the edge of what it scrolls to (an outline does not add to that).
      // The element's own box, cut the same way at the current scroll, tells whether it is
      // shown at all: a focusable element that is not shown has no outline to see.
      let shown = { ...rect.toJSON() } as typeof box;
      const clipTo = (clip: typeof box, now: typeof box) => {
        shown = {
          left: Math.max(shown.left, now.left),
          top: Math.max(shown.top, now.top),
          right: Math.min(shown.right, now.right),
          bottom: Math.min(shown.bottom, now.bottom),
        };
        return clip;
      };
      for (let a = element.parentElement; a; a = a.parentElement) {
        if (a === document.body || a === document.documentElement) continue;
        const own = getComputedStyle(a);
        if (own.overflowX === "visible" && own.overflowY === "visible") continue;
        const r = a.getBoundingClientRect();
        const left = r.left + a.clientLeft;
        const top = r.top + a.clientTop;
        const now = {
          left,
          top,
          right: left + (a.clientWidth || r.width),
          bottom: top + (a.clientHeight || r.height),
        };
        const scrollsX = /auto|scroll/.test(own.overflowX);
        const scrollsY = /auto|scroll/.test(own.overflowY);
        const classes = (a.getAttribute("class") ?? "").split(/\s+/).slice(0, 4).join(".");
        cut(
          `${a.tagName.toLowerCase()}.${classes}`,
          clipTo(
            {
              left: scrollsX ? left - a.scrollLeft : now.left,
              top: scrollsY ? top - a.scrollTop : now.top,
              right: scrollsX ? left - a.scrollLeft + a.scrollWidth : now.right,
              bottom: scrollsY ? top - a.scrollTop + a.scrollHeight : now.bottom,
            },
            now,
          ),
        );
      }
      const page = document.documentElement;
      cut(
        "the window",
        clipTo(
          {
            left: -scrollX,
            top: -scrollY,
            right: page.scrollWidth - scrollX,
            bottom: page.scrollHeight - scrollY,
          },
          { left: 0, top: 0, right: innerWidth, bottom: innerHeight },
        ),
      );
      const hidden = shown.right - shown.left < 1 || shown.bottom - shown.top < 1;
      // The charts' own keyboard layer (Recharts) draws the browser's ring round shapes that
      // reach past the chart's SVG, which clips them: not ours to move, so not counted.
      if (element.closest(".recharts-wrapper")) clippedBy.length = 0;
      return {
        what: `${element.tagName.toLowerCase()} "${name}"`,
        cls: element.getAttribute("class") ?? "",
        outlineStyle: style.outlineStyle,
        outlineWidth: width,
        outlineAlpha: alpha(style.outlineColor),
        boxShadow: style.boxShadow,
        focusVisible: element.matches(":focus-visible"),
        role: element.getAttribute("role"),
        chip: element.querySelector("[data-provenance]") !== null,
        mapItem: element.matches(mapItems),
        hidden,
        clippedBy,
      };
    };
  }, MAP_ITEMS);
}

/** The focused element, read once its transitions (the outline's among them) have ended. */
async function focusedStop(page: Page): Promise<Stop | null> {
  await animationsSettled(page);
  return page.evaluate(() =>
    (window as unknown as { __describeFocus: () => Stop | null }).__describeFocus(),
  );
}

/**
 * Presses Tab until the focus comes back to a control it has been on, and returns each control
 * it was on. Past the last control the focus may leave the page for a press; the next one
 * brings it back to the first. Fails if `max` presses do not go all the way round.
 */
async function tabThrough(page: Page, max: number): Promise<Stop[]> {
  await page.evaluate(() => {
    (window as unknown as { __tabSeen: WeakSet<Element> }).__tabSeen = new WeakSet();
  });
  const stops: Stop[] = [];
  let left = 0;
  let complete = false;
  for (let i = 0; i < max && !complete; i += 1) {
    await page.keyboard.press("Tab");
    const where = await page.evaluate(() => {
      const seen = (window as unknown as { __tabSeen: WeakSet<Element> }).__tabSeen;
      const element = document.activeElement;
      if (!element || element === document.body) return "page";
      if (seen.has(element)) return "seen";
      seen.add(element);
      return "new";
    });
    if (where === "seen") complete = true;
    else if (where === "page") {
      left += 1;
      complete = left > 1;
    } else {
      const stop = await focusedStop(page);
      if (stop) stops.push(stop);
    }
  }
  expect(complete, `Tab goes all the way round within ${max} presses`).toBe(true);
  return stops;
}

/**
 * Focuses, by script, every element on the screen that can take the focus and is shown
 * (including the headings and panels that take it with tabIndex=-1, and the controls Tab skips),
 * and returns each of them. The keyboard was used last, so each matches :focus-visible as it
 * would after a key press.
 */
async function focusEach(page: Page): Promise<Stop[]> {
  const count = await page.evaluate((mapItems) => {
    const list = [
      ...document.querySelectorAll<HTMLElement | SVGElement>(
        'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]',
      ),
    ].filter(
      (element) =>
        !element.matches(":disabled") &&
        !element.closest("[inert]") &&
        !element.matches(mapItems) &&
        element.getClientRects().length > 0 &&
        getComputedStyle(element).visibility !== "hidden",
    );
    (window as unknown as { __focusables: Element[] }).__focusables = list;
    return list.length;
  }, MAP_ITEMS);
  const stops: Stop[] = [];
  for (let i = 0; i < count; i += 1) {
    const focused = await page.evaluate((index) => {
      const element = (window as unknown as { __focusables: Array<HTMLElement | SVGElement> })
        .__focusables[index];
      if (!element.isConnected) return false;
      element.focus();
      return document.activeElement === element;
    }, i);
    if (!focused) continue;
    const stop = await focusedStop(page);
    if (stop) stops.push(stop);
  }
  return stops;
}

/** The problems with each stop's focus outline in forced-colors mode. */
function outlineProblems(stops: Stop[]): string[] {
  const problems: string[] = [];
  for (const stop of stops) {
    if (!stop.focusVisible) problems.push(`${stop.what}: does not match :focus-visible`);
    if (stop.outlineStyle === "none" || !(stop.outlineWidth > 0)) {
      problems.push(`${stop.what}: no outline (${stop.outlineStyle} ${stop.outlineWidth}px)`);
    } else if (!(stop.outlineAlpha > 0)) {
      problems.push(`${stop.what}: a transparent outline`);
    }
    for (const clip of stop.clippedBy) problems.push(`${stop.what}: outline cut by ${clip}`);
  }
  return [...new Set(problems)];
}

function expectOutlines(stops: Stop[], screen: string) {
  expect(stops.length, `the focus reaches controls on ${screen}`).toBeGreaterThan(0);
  for (const what of new Set(stops.filter((stop) => stop.hidden).map((stop) => stop.what))) {
    test.info().annotations.push({ type: "focusable but not shown", description: what });
  }
  expect
    .soft(
      outlineProblems(stops.filter((stop) => !stop.mapItem && !stop.hidden)),
      `focus outlines on ${screen} that forced-colors mode does not paint`,
    )
    .toEqual([]);
}

/** Every Tab stop and every focusable element of the screen shown, checked. */
async function checkScreen(page: Page, screen: string, max = 200) {
  await animationsSettled(page);
  const tabbed = await tabThrough(page, max);
  const scripted = await focusEach(page);
  expectOutlines([...tabbed, ...scripted], screen);
  return { tabbed, scripted };
}

/** The analysis held before its result: the progress screen stays. */
function heldRun() {
  const events = fullResult.streams[ANALYZE];
  return {
    ...fullResult,
    streams: { [ANALYZE]: [...events.slice(0, 3), { $wait: "never" }] },
  };
}

/** The genealogy-kinds result stored under MAP_TRACK, for its own map page. */
function mapPageApi() {
  const events = kindsResult.streams[ANALYZE] as Array<{ type: string; data?: object }>;
  const analysis = { ...events.find((event) => event.type === "complete")?.data, id: MAP_TRACK };
  return {
    suggestions: [],
    eventGapMs: 0,
    streams: {},
    runs: {
      [MAP_TRACK]: {
        success: true,
        run: {
          id: `thread-${MAP_TRACK}`,
          status: "completed",
          mode: "live",
          spotifyId: MAP_TRACK,
          createdAt: "2026-10-27T19:30:00.000Z",
          finishedAt: "2026-10-27T19:31:00.000Z",
        },
        analysis,
      },
    },
  };
}

/**
 * Steps through every card and link of the map on screen with the arrow keys, and checks that
 * each shows its own focus ring and has no outline (one would be transparent on SVG).
 */
async function checkMapItems(page: Page) {
  const graph = page.locator('svg[aria-label="Connections graph"]').first();
  await expect(graph.locator("g.nodes > g").first()).toBeVisible();
  const total = await graph.locator(MAP_ITEMS).count();
  const onMap = () =>
    page.evaluate(() => document.activeElement?.closest("g.nodes, g.link-targets") != null);
  for (let i = 0; i < 200 && !(await onMap()); i += 1) await page.keyboard.press("Tab");
  expect(await onMap(), "Tab reaches the map").toBe(true);
  await page.keyboard.press("Home");

  const seen = new Map<string, { what: string; ring: string; outline: Stop | null }>();
  for (let i = 0; i <= total; i += 1) {
    if (i > 0) await page.keyboard.press("ArrowRight");
    const item = await page.evaluate(() => {
      const element = document.activeElement as SVGElement | null;
      if (!element?.matches("g.nodes > g, g.link-targets > path")) return null;
      const id =
        element.getAttribute("data-node-id") ?? `link ${element.getAttribute("data-link-index")}`;
      let ring: string;
      if (element.matches("g.nodes > g")) {
        const rect = element.querySelector<SVGElement>(".focus-ring");
        const style = rect ? getComputedStyle(rect) : null;
        ring =
          style && style.opacity === "1" && style.stroke !== "none" && style.display !== "none"
            ? "ring"
            : `no ring (opacity ${style?.opacity}, stroke ${style?.stroke})`;
      } else {
        const opacity = Number(getComputedStyle(element).strokeOpacity);
        ring = opacity > 0 ? "ring" : `no band (stroke-opacity ${opacity})`;
      }
      return { id, what: element.getAttribute("aria-label")?.slice(0, 60) ?? id, ring };
    });
    if (!item || seen.has(item.id)) continue;
    seen.set(item.id, { what: item.what, ring: item.ring, outline: await focusedStop(page) });
  }
  const items = [...seen.values()];
  expect(items.length, "the arrow keys reach every card and link").toBe(total);
  expect(
    items.filter((item) => item.ring !== "ring").map((item) => `${item.what}: ${item.ring}`),
    "map items without their focus ring",
  ).toEqual([]);
  expect(
    items
      .filter((item) => item.outline && item.outline.outlineStyle !== "none")
      .map(
        (item) =>
          `${item.what}: ${item.outline?.outlineStyle}, alpha ${item.outline?.outlineAlpha}`,
      ),
    "map items with an outline",
  ).toEqual([]);
}

test.describe("forced-colors mode", () => {
  test.use({ forcedColors: "active", reducedMotion: "reduce" });

  test.beforeEach(async ({ page }) => {
    await offline(page);
    await installProbe(page);
  });

  test("every control on the landing, Dashboard and Player screens keeps a painted focus outline", async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await useMockApi(page, fullResult);
    await page.goto("/");
    expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);

    const landing = await checkScreen(page, "the landing screen");
    expect(landing.tabbed.some((stop) => stop.role === "combobox")).toBe(true);

    await analyzeAndOpenDashboard(page, "Bright Lines", { reload: false });
    const dashboard = await checkScreen(page, "the Dashboard");
    expect(
      dashboard.tabbed.some((stop) => stop.chip),
      "a provenance chip is among the Dashboard's stops",
    ).toBe(true);
    expect(
      dashboard.tabbed.some((stop) => stop.what.includes("activity log")),
      "the activity log's toggle is among the Dashboard's stops",
    ).toBe(true);
    expect(dashboard.scripted.some((stop) => stop.what.startsWith("h1 "))).toBe(true);

    await openPlayer(page);
    const player = await checkScreen(page, "the Player");
    expect(
      player.tabbed.some((stop) => stop.role === "listitem"),
      "the timeline's sections are among the Player's stops",
    ).toBe(true);
  });

  test("the progress screen keeps a painted focus outline", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await useMockApi(page, heldRun());
    await page.goto("/");
    await page.getByPlaceholder(/Song title/).fill("Bright Lines");
    await page.getByRole("button", { name: "Analyze", exact: true }).click();
    await expect(page.locator("[data-progress-status]")).toBeVisible();
    await checkScreen(page, "the progress screen");
  });

  test("the Player on a phone, its tabs among its controls, keeps a painted focus outline", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await useMockApi(page, fullResult);
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    const { tabbed } = await checkScreen(page, "the Player at 390 px");
    expect(tabbed.some((stop) => stop.role === "tab")).toBe(true);

    // The tabs the arrow keys reach.
    await page.getByRole("tab", { selected: true }).focus();
    const tabs: Stop[] = [];
    for (const key of ["ArrowRight", "ArrowRight", "Home"]) {
      await page.keyboard.press(key);
      const stop = await focusedStop(page);
      if (stop) tabs.push(stop);
    }
    expect(tabs.every((stop) => stop.role === "tab")).toBe(true);
    expectOutlines(tabs, "the Player's tabs");
  });

  test("the map's cards and links in the Player show their own focus ring", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await useMockApi(page, kindsResult);
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    await checkMapItems(page);
  });

  test("the map page keeps a painted focus outline, and its cards and links their focus ring", async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await useMockApi(page, mapPageApi());
    await page.goto(`/t/${MAP_TRACK}/map`);
    await expect(page.getByRole("heading", { level: 1, name: /^Song relations of/ })).toBeFocused();
    await checkScreen(page, "the map page");
    await checkMapItems(page);
  });
});

test.describe("normal mode", () => {
  test.use({ reducedMotion: "reduce" });

  test.beforeEach(async ({ page }) => {
    await offline(page);
    await installProbe(page);
  });

  test("the controls that keep an outline for forced-colors mode draw none, and keep their ring", async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await useMockApi(page, fullResult);
    await page.goto("/");
    const stops: Stop[] = [];
    const sweep = async () => {
      await animationsSettled(page);
      stops.push(...(await tabThrough(page, 200)), ...(await focusEach(page)));
    };
    await sweep();
    await analyzeAndOpenDashboard(page, "Bright Lines", { reload: false });
    await sweep();
    await openPlayer(page);
    await sweep();

    const kept = stops.filter((stop) => /(^|\s)focus-visible:outline-hidden(\s|$)/.test(stop.cls));
    expect(kept.length).toBeGreaterThan(20);
    const problems: string[] = [];
    for (const stop of kept) {
      if (!stop.focusVisible) problems.push(`${stop.what}: does not match :focus-visible`);
      if (stop.outlineStyle !== "none") problems.push(`${stop.what}: outline ${stop.outlineStyle}`);
      // A ring: a box-shadow whose colour is not transparent, with a spread.
      const shadows = stop.boxShadow
        .split(/,(?![^(]*\))/)
        .filter((shadow) => !/rgba\(0, 0, 0, 0\)|\/ 0\)/.test(shadow));
      const ring = shadows.some((shadow) => /\)\s+0px\s+0px\s+0px\s+[1-9]/.test(shadow));
      if (/(^|\s)focus-visible:ring-\d/.test(stop.cls) && !ring) {
        problems.push(`${stop.what}: no focus ring (${stop.boxShadow})`);
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });
});
