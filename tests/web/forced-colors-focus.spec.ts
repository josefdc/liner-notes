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
// keyboard focus is. Every control on the main screens must keep one, checked on its computed
// style and clip geometry: a style other than `none`, a width above zero, a colour with 3:1
// against the forced Canvas, no clip-path, clip or opacity 0 on it or an ancestor, and a box
// that no clipping ancestor of its containing-block chain cuts, nor the window. A sample of
// controls is also checked on the pixels the outline paints. `outline-none` takes the outline
// away; `outline-hidden` keeps a transparent one that forced-colors mode draws in a system
// colour. The map's cards and links are SVG, which forced-colors mode does not recolour: they
// show their own focus ring instead, in the Highlight colour there (index.css).
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
  /** The outline colour's contrast with the Canvas colour (composited over it). */
  outlineContrast: number;
  boxShadow: string;
  focusVisible: boolean;
  role: string | null;
  chip: boolean;
  mapItem: boolean;
  /** Inside the activity log's collapsible entries. */
  inLog: boolean;
  /** Not shown at all: wholly clipped, or under clip-path, clip or opacity 0. */
  hidden: string | null;
  /** Whether it is one of the screen's elements expected not to be shown (`notShown`). */
  expectedHidden: boolean;
  /** What cuts the outline's box, as "<tag.classes>: <side> <px>". */
  clippedBy: string[];
};

/**
 * Installs `window.__describeFocus`, which reports on the focused element, and
 * `window.__notShown`, the selectors of the elements expected not to be shown.
 */
async function installProbe(page: Page) {
  await page.addInitScript((mapItems) => {
    const w = window as unknown as {
      __describeFocus: () => unknown;
      __notShown: string[];
      __colour: (colour: string) => number[] | null;
      __contrast: (colour: string, behind?: string) => number;
    };
    w.__notShown = [];
    const parse = (colour: string): number[] | null => {
      if (colour === "transparent") return [0, 0, 0, 0];
      const rgb = /^rgba?\(([^)]*)\)$/.exec(colour);
      if (rgb) {
        const [r, g, b, a = "1"] = rgb[1].split(/[\s,/]+/).filter(Boolean);
        return [Number(r), Number(g), Number(b), Number(a)];
      }
      const srgb = /^color\(srgb ([^)]*)\)$/.exec(colour);
      if (srgb) {
        const [r, g, b, a = "1"] = srgb[1].split(/[\s/]+/).filter(Boolean);
        return [Number(r) * 255, Number(g) * 255, Number(b) * 255, Number(a)];
      }
      return null;
    };
    w.__colour = parse;
    const canvas = () => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = "Canvas";
      document.body.append(probe);
      const colour = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return colour;
    };
    const luminance = ([r, g, b]: number[]) => {
      const [lr, lg, lb] = [r, g, b].map((v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
    };
    /** The contrast of `colour`, composited over `behind` (the Canvas colour), with it. */
    w.__contrast = (colour: string, behind = canvas()) => {
      const fg = parse(colour);
      const bg = parse(behind);
      if (!fg || !bg) return 0;
      const mixed = fg.slice(0, 3).map((v, i) => v * fg[3] + bg[i] * (1 - fg[3]));
      const [a, b] = [luminance(mixed), luminance(bg)].sort((x, y) => y - x);
      return (a + 0.05) / (b + 0.05);
    };

    /** Whether `a` is the containing block a box positioned `position` would have, if a parent. */
    const holdsFixed = (s: CSSStyleDeclaration) =>
      s.transform !== "none" ||
      s.perspective !== "none" ||
      s.filter !== "none" ||
      (s.backdropFilter ?? "none") !== "none" ||
      /paint|layout|strict|content/.test(s.contain) ||
      /transform|perspective|filter/.test(s.willChange) ||
      (s.containerType ?? "normal") !== "normal" ||
      (s.contentVisibility ?? "visible") !== "visible";
    const contains = (s: CSSStyleDeclaration, position: string) =>
      position === "fixed"
        ? holdsFixed(s)
        : position === "absolute"
          ? s.position !== "static" || holdsFixed(s)
          : true;
    const clipsPaint = (s: CSSStyleDeclaration) =>
      /paint|strict|content/.test(s.contain) || (s.contentVisibility ?? "visible") !== "visible";

    w.__describeFocus = () => {
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
      const label = (a: Element) =>
        `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ""}.${(a.getAttribute("class") ?? "")
          .split(/\s+/)
          .slice(0, 4)
          .join(".")}`;
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
      const cut = (by: string, clip: typeof box) => {
        const sides = (
          [
            ["left", clip.left - box.left],
            ["top", clip.top - box.top],
            ["right", box.right - clip.right],
            ["bottom", box.bottom - clip.bottom],
          ] as const
        ).filter(([, px]) => px > 0.5);
        if (sides.length > 0) {
          clippedBy.push(
            `${by}: ${sides.map(([side, px]) => `${side} ${px.toFixed(1)}px`).join(", ")}`,
          );
        }
      };
      // What the element itself shows: its box, cut by the same clips at the current scroll.
      let shown = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
      const narrow = (now: typeof box) => {
        shown = {
          left: Math.max(shown.left, now.left),
          top: Math.max(shown.top, now.top),
          right: Math.min(shown.right, now.right),
          bottom: Math.min(shown.bottom, now.bottom),
        };
      };
      // Whatever hides it all: a clip-path, a clip or opacity 0 on it or any ancestor.
      const blockers: string[] = [];
      for (let a: Element | null = element; a; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.clipPath !== "none") blockers.push(`clip-path on ${label(a)}`);
        if (s.clip !== "auto" && s.clip !== "") blockers.push(`clip on ${label(a)}`);
        if (Number(s.opacity) === 0) blockers.push(`opacity 0 on ${label(a)}`);
      }
      // The clips of its containing-block chain: an ancestor that hides its overflow or contains
      // its paint cuts at its padding box; a scroller at the edge of what it scrolls to (an
      // outline does not add to that). An ancestor that is not in the chain (a fixed box's
      // parents, an absolute box's static parents) does not clip it.
      let position = style.position;
      for (let a = element.parentElement; a; a = a.parentElement) {
        if (a === document.body || a === document.documentElement) continue;
        const s = getComputedStyle(a);
        if (!contains(s, position)) continue;
        position = s.position;
        const hides = s.overflowX !== "visible" || s.overflowY !== "visible" || clipsPaint(s);
        if (!hides) continue;
        const r = a.getBoundingClientRect();
        const left = r.left + a.clientLeft;
        const top = r.top + a.clientTop;
        const now = {
          left,
          top,
          right: left + (a.clientWidth || r.width),
          bottom: top + (a.clientHeight || r.height),
        };
        const scrollsX = /auto|scroll/.test(s.overflowX);
        const scrollsY = /auto|scroll/.test(s.overflowY);
        narrow(now);
        cut(label(a), {
          left: scrollsX ? left - a.scrollLeft : now.left,
          top: scrollsY ? top - a.scrollTop : now.top,
          right: scrollsX ? left - a.scrollLeft + a.scrollWidth : now.right,
          bottom: scrollsY ? top - a.scrollTop + a.scrollHeight : now.bottom,
        });
      }
      // The window: the viewport for a fixed box, else the document's scrolled extent.
      const viewport = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      const page = document.documentElement;
      narrow(viewport);
      cut(
        "the window",
        position === "fixed"
          ? viewport
          : {
              left: -scrollX,
              top: -scrollY,
              right: page.scrollWidth - scrollX,
              bottom: page.scrollHeight - scrollY,
            },
      );
      const hidden =
        blockers[0] ??
        (shown.right - shown.left < 1 || shown.bottom - shown.top < 1 ? "wholly clipped" : null);
      // The charts' own keyboard layer (Recharts) draws the browser's ring round shapes that
      // reach past the chart's SVG: only that SVG's clip is not counted for them.
      const ownClips = element.closest(".recharts-wrapper")
        ? clippedBy.filter((clip) => !clip.startsWith("svg.recharts-surface"))
        : clippedBy;
      return {
        what: `${element.tagName.toLowerCase()} "${name}"`,
        cls: element.getAttribute("class") ?? "",
        outlineStyle: style.outlineStyle,
        outlineWidth: width,
        outlineContrast: w.__contrast(style.outlineColor),
        boxShadow: style.boxShadow,
        focusVisible: element.matches(":focus-visible"),
        role: element.getAttribute("role"),
        chip: element.querySelector("[data-provenance]") !== null,
        mapItem: element.matches(mapItems),
        inLog: element.closest("#activity-log-content") !== null,
        hidden,
        expectedHidden: w.__notShown.some((selector) => element.matches(selector)),
        clippedBy: ownClips,
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
 * Focuses, by script, every element on the screen that can take the focus and is rendered
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
    if (stop.hidden) {
      if (!stop.expectedHidden) problems.push(`${stop.what}: not shown (${stop.hidden})`);
      continue;
    }
    if (stop.expectedHidden) problems.push(`${stop.what}: shown, but listed as not shown`);
    if (!stop.focusVisible) problems.push(`${stop.what}: does not match :focus-visible`);
    if (stop.outlineStyle === "none" || !(stop.outlineWidth > 0)) {
      problems.push(`${stop.what}: no outline (${stop.outlineStyle} ${stop.outlineWidth}px)`);
    } else if (!(stop.outlineContrast >= 3)) {
      problems.push(`${stop.what}: outline ${stop.outlineContrast.toFixed(2)}:1 on the Canvas`);
    }
    for (const clip of stop.clippedBy) problems.push(`${stop.what}: outline cut by ${clip}`);
  }
  return [...new Set(problems)];
}

/**
 * Checks the stops of a screen. `notShown` pins the selectors of the elements that can take
 * the focus there without being shown; each must be met, hidden, and nothing else may be.
 */
function expectOutlines(stops: Stop[], screen: string, notShown: string[] = []) {
  expect(stops.length, `the focus reaches controls on ${screen}`).toBeGreaterThan(0);
  const checked = stops.filter((stop) => !stop.mapItem);
  expect.soft(outlineProblems(checked), `focus outlines on ${screen} that do not show`).toEqual([]);
  if (notShown.length > 0) {
    expect
      .soft(
        checked.filter((stop) => stop.hidden && stop.expectedHidden).length,
        `the elements listed as not shown on ${screen} (${notShown.join(", ")}) are met`,
      )
      .toBeGreaterThanOrEqual(notShown.length);
  }
}

/** Every Tab stop and every focusable element of the screen shown, checked. */
async function checkScreen(page: Page, screen: string, notShown: string[] = []) {
  await page.evaluate((selectors) => {
    (window as unknown as { __notShown: string[] }).__notShown = selectors;
  }, notShown);
  await animationsSettled(page);
  const tabbed = await tabThrough(page, 200);
  const scripted = await focusEach(page);
  expectOutlines([...tabbed, ...scripted], screen, notShown);
  return { tabbed, scripted };
}

/**
 * The pixels the focused element's outline paints on each side: a screenshot of it focused
 * against one with every outline turned off (the caret hidden in both), counted in the band
 * each side's outline takes.
 */
async function paintedSides(page: Page) {
  await animationsSettled(page);
  const geometry = await page.evaluate(() => {
    const element = document.activeElement as Element;
    const s = getComputedStyle(element);
    const r = element.getBoundingClientRect();
    const width = Number.parseFloat(s.outlineWidth) || 0;
    const offset = Number.parseFloat(s.outlineOffset) || 0;
    return { x: r.x, y: r.y, w: r.width, h: r.height, width, offset };
  });
  const outer = geometry.width + Math.max(geometry.offset, 0) + 2;
  const viewport = page.viewportSize() ?? { width: 1440, height: 900 };
  const x0 = Math.max(0, Math.floor(geometry.x - outer));
  const y0 = Math.max(0, Math.floor(geometry.y - outer));
  const clip = {
    x: x0,
    y: y0,
    width: Math.min(viewport.width, Math.ceil(geometry.x + geometry.w + outer)) - x0,
    height: Math.min(viewport.height, Math.ceil(geometry.y + geometry.h + outer)) - y0,
  };
  const caret = await page.addStyleTag({ content: "*{caret-color:transparent!important}" });
  const focused = await page.screenshot({ clip });
  const off = await page.addStyleTag({ content: "*{outline-style:none!important}" });
  const plain = await page.screenshot({ clip });
  await off.evaluate((element) => (element as Element).remove());
  await caret.evaluate((element) => (element as Element).remove());
  return page.evaluate(
    async ({ a, b, g, clip }) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.src = src;
        });
      const pixels = (image: HTMLImageElement) => {
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d") as CanvasRenderingContext2D;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const [ia, ib] = await Promise.all([load(a), load(b)]);
      const [pa, pb] = [pixels(ia), pixels(ib)];
      // The outline's band on each side, in the screenshot's pixels.
      const left = g.x - clip.x;
      const top = g.y - clip.y;
      const right = left + g.w;
      const bottom = top + g.h;
      const inner = g.offset;
      const outerEdge = g.offset + g.width;
      const sides = { top: 0, right: 0, bottom: 0, left: 0 };
      for (let y = 0; y < ia.height; y += 1) {
        for (let x = 0; x < ia.width; x += 1) {
          const i = (y * ia.width + x) * 4;
          if (pa[i] === pb[i] && pa[i + 1] === pb[i + 1] && pa[i + 2] === pb[i + 2]) continue;
          const px = x + 0.5;
          const py = y + 0.5;
          const across = px > left - outerEdge && px < right + outerEdge;
          const down = py > top - outerEdge && py < bottom + outerEdge;
          if (across && py > top - outerEdge && py < top - inner) sides.top += 1;
          if (across && py > bottom + inner && py < bottom + outerEdge) sides.bottom += 1;
          if (down && px > left - outerEdge && px < left - inner) sides.left += 1;
          if (down && px > right + inner && px < right + outerEdge) sides.right += 1;
        }
      }
      return sides;
    },
    {
      a: `data:image/png;base64,${focused.toString("base64")}`,
      b: `data:image/png;base64,${plain.toString("base64")}`,
      g: geometry,
      clip,
    },
  );
}

/** Checks that the focused element's outline paints on all four sides. */
async function expectPainted(page: Page, what: string, painted: string[]) {
  const sides = await paintedSides(page);
  const bare = Object.entries(sides)
    .filter(([, count]) => count === 0)
    .map(([side]) => side);
  painted.push(`${what}: ${JSON.stringify(sides)}`);
  expect.soft(bare, `${what}: sides of its outline that paint nothing`).toEqual([]);
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

type MapItem = {
  what: string;
  ring: string;
  contrast: number;
  stroke: string;
  outline: Stop | null;
};

/**
 * Steps through every card and link of the map on screen with the arrow keys and returns each
 * once: its focus ring (a card's .focus-ring, a link's band), that ring's contrast with the
 * Canvas, and its outline.
 */
async function mapItems(page: Page): Promise<MapItem[]> {
  const graph = page.locator('svg[aria-label="Connections graph"]').first();
  await expect(graph.locator("g.nodes > g").first()).toBeVisible();
  const total = await graph.locator(MAP_ITEMS).count();
  const onMap = () =>
    page.evaluate(() => document.activeElement?.closest("g.nodes, g.link-targets") != null);
  for (let i = 0; i < 200 && !(await onMap()); i += 1) await page.keyboard.press("Tab");
  expect(await onMap(), "Tab reaches the map").toBe(true);
  await page.keyboard.press("Home");

  const seen = new Map<string, MapItem>();
  for (let i = 0; i <= total; i += 1) {
    if (i > 0) await page.keyboard.press("ArrowRight");
    await animationsSettled(page);
    const item = await page.evaluate(() => {
      const w = window as unknown as { __contrast: (colour: string) => number };
      const element = document.activeElement as SVGElement | null;
      if (!element?.matches("g.nodes > g, g.link-targets > path")) return null;
      const id =
        element.getAttribute("data-node-id") ?? `link ${element.getAttribute("data-link-index")}`;
      // The ring's colour as drawn: its stroke at its stroke-opacity and opacity.
      const ring = element.matches("g.nodes > g")
        ? element.querySelector<SVGElement>(".focus-ring")
        : element;
      if (!ring) return { id, what: id, ring: "no ring", contrast: 0, stroke: "" };
      const s = getComputedStyle(ring);
      const alpha = Number(s.strokeOpacity) * Number(s.opacity);
      const shown = s.display !== "none" && s.stroke !== "none" && alpha > 0;
      const rgb = /^rgba?\(([^)]*)\)$/.exec(s.stroke)?.[1].split(/[\s,/]+/) ?? [];
      const colour = rgb.length >= 3 ? `rgba(${rgb.slice(0, 3).join(", ")}, ${alpha})` : s.stroke;
      return {
        id,
        what: element.getAttribute("aria-label")?.slice(0, 60) ?? id,
        ring: shown ? "ring" : `no ring (stroke ${s.stroke}, opacity ${alpha})`,
        contrast: w.__contrast(colour),
        stroke: `${s.stroke} at ${alpha}`,
      };
    });
    if (!item || seen.has(item.id)) continue;
    seen.set(item.id, { ...item, outline: await focusedStop(page) });
  }
  const items = [...seen.values()];
  expect(items.length, "the arrow keys reach every card and link").toBe(total);
  return items;
}

/** Checks that each map card and link shows its focus ring at 3:1 on the Canvas, no outline. */
function expectMapRings(items: MapItem[]) {
  expect(
    items.filter((item) => item.ring !== "ring").map((item) => `${item.what}: ${item.ring}`),
    "map items without their focus ring",
  ).toEqual([]);
  expect(
    items
      .filter((item) => !(item.contrast >= 3))
      .map((item) => `${item.what}: ${item.stroke}, ${item.contrast.toFixed(2)}:1`),
    "map focus rings under 3:1 on the Canvas",
  ).toEqual([]);
  expect(
    items
      .filter((item) => item.outline && item.outline.outlineStyle !== "none")
      .map((item) => `${item.what}: ${item.outline?.outlineStyle}`),
    "map items with an outline",
  ).toEqual([]);
  const lowest = Math.min(...items.map((item) => item.contrast));
  test.info().annotations.push({
    type: "lowest focus ring contrast",
    description: `${lowest.toFixed(2)}:1 (${items.length} items)`,
  });
}

test.describe("forced-colors mode", () => {
  test.use({ forcedColors: "active", reducedMotion: "reduce" });

  test.beforeEach(async ({ page }) => {
    await offline(page);
    await installProbe(page);
  });

  test("every control on the landing, Dashboard and Player screens keeps its focus outline", async ({
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
    // An empty group of the chart's keyboard layer takes the focus without being drawn.
    const dashboard = await checkScreen(page, "the Dashboard", [
      ".recharts-wrapper g:empty, .recharts-wrapper g:not(:has(*))",
    ]);
    expect(
      dashboard.tabbed.some((stop) => stop.chip),
      "a provenance chip is among the Dashboard's stops",
    ).toBe(true);
    expect(
      dashboard.tabbed.some((stop) => stop.what.includes("activity log")),
      "the activity log's toggle is among the Dashboard's stops",
    ).toBe(true);
    await expect(page.locator("#activity-log-content")).toHaveAttribute("inert", "");
    expect(
      dashboard.tabbed.filter((stop) => stop.inLog).map((stop) => stop.what),
      "the collapsed activity log's entries are not a Tab stop",
    ).toEqual([]);
    expect(dashboard.scripted.some((stop) => stop.what.startsWith("h1 "))).toBe(true);

    await openPlayer(page);
    const player = await checkScreen(page, "the Player");
    expect(
      player.tabbed.some((stop) => stop.role === "listitem"),
      "the timeline's sections are among the Player's stops",
    ).toBe(true);
  });

  test("the progress screen keeps its focus outline", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await useMockApi(page, heldRun());
    await page.goto("/");
    await page.getByPlaceholder(/Song title/).fill("Bright Lines");
    await page.getByRole("button", { name: "Analyze", exact: true }).click();
    await expect(page.locator("[data-progress-status]")).toBeVisible();
    await checkScreen(page, "the progress screen");
  });

  test("the Player on a phone, its tabs among its controls, keeps its focus outline", async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 390, height: 844 });
    await useMockApi(page, fullResult);
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    // On a phone the track's band is for screen readers only: its h1 takes the focus unseen.
    const { tabbed } = await checkScreen(page, "the Player at 390 px", ["#player-header h1"]);
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

  test("the outline paints on all four sides of a sample of controls", async ({ page }) => {
    test.setTimeout(150_000);
    const painted: string[] = [];
    await page.setViewportSize({ width: 1440, height: 900 });
    await useMockApi(page, fullResult);
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.locator('a[href="#main-content"]');
    await skip.focus();
    // It floats over the page, as its focus:fixed says.
    expect(await skip.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
    await expectPainted(page, "skip link", painted);
    await page.getByRole("combobox", { name: "Song title and artist" }).focus();
    await expectPainted(page, "search box", painted);
    await page.getByRole("link", { name: /^Source/ }).focus();
    await expectPainted(page, "Source link", painted);

    await analyzeAndOpenDashboard(page, "Bright Lines", { reload: false });
    await page.keyboard.press("Tab");
    await page.getByRole("button", { name: /activity log/ }).focus();
    await expectPainted(page, "activity log toggle", painted);
    await page.getByRole("button", { name: /how BPM was obtained/ }).focus();
    await expectPainted(page, "provenance chip", painted);
    await page.getByRole("button", { name: "View full analysis" }).focus();
    await expectPainted(page, "View full analysis", painted);

    await openPlayer(page);
    await page.keyboard.press("Tab");
    for (const segment of await page.locator('[role="listitem"][tabindex="0"]').all()) {
      await segment.focus();
      await expectPainted(page, "timeline section", painted);
    }
    await page.getByRole("button", { name: /How this was estimated \(Acoustic\)/ }).focus();
    await expectPainted(page, "How this was estimated", painted);
    await page.locator("[data-card-id]").first().focus();
    await expectPainted(page, "lineage card", painted);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("tab", { selected: true }).focus();
    await expectPainted(page, "phone tab", painted);
    test.info().annotations.push({ type: "painted pixels", description: painted.join("\n") });
  });

  test("the checks see what hides an outline: clips, opacity, a Canvas colour, an overlay", async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.setViewportSize({ width: 800, height: 600 });
    await useMockApi(page, fullResult);
    await page.goto("/");
    await page.evaluate(() => {
      document.body.innerHTML = `
        <style>
          body { margin: 0; }
          .box { position: absolute; width: 200px; height: 40px; }
          button { width: 120px; height: 24px; margin: 8px; outline: 2px solid; outline-offset: 2px; }
        </style>
        <div class="box" style="top: 10px; left: 20px"><button id="plain">plain</button></div>
        <div class="box" style="top: 60px; left: 20px; clip-path: inset(0)"><button id="clip-path">clip-path</button></div>
        <div class="box" style="top: 110px; left: 20px; opacity: 0"><button id="opacity">opacity 0</button></div>
        <button id="sr-only" style="position: absolute; top: 160px; left: 20px; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0)">sr-only</button>
        <div class="box" style="top: 210px; left: 20px"><button id="canvas" style="outline-color: Canvas">Canvas</button></div>
        <div class="box" style="top: 260px; left: 20px; contain: paint; width: 120px; height: 24px; padding: 0"><button id="contain" style="margin: 0">contain</button></div>
        <div class="box" style="top: 310px; left: 20px; overflow: hidden; width: 10px; height: 10px">
          <button id="fixed-free" style="position: fixed; top: 320px; left: 300px">fixed, free</button>
          <button id="fixed-edge" style="position: fixed; top: 0; left: 300px; margin: 0">fixed, at the edge</button>
        </div>
        <div class="box" style="top: 360px; left: 20px"><button id="overlay">overlay</button>
          <div style="position: absolute; inset: -6px; background: Canvas; z-index: 2"></div></div>`;
    });
    const problemsOf = async (id: string) => {
      await page.keyboard.press("Shift");
      await page.locator(`#${id}`).focus();
      const stop = await focusedStop(page);
      return stop
        ? outlineProblems([stop]).map((problem) => problem.split(": ").slice(1).join(": "))
        : ["not focused"];
    };
    expect(await problemsOf("plain")).toEqual([]);
    expect(await problemsOf("clip-path")).toEqual(["not shown (clip-path on div.box)"]);
    expect(await problemsOf("opacity")).toEqual(["not shown (opacity 0 on div.box)"]);
    expect((await problemsOf("sr-only"))[0]).toMatch(/^not shown \(clip on button#sr-only/);
    expect((await problemsOf("canvas"))[0]).toMatch(/^outline 1\.00:1 on the Canvas$/);
    expect((await problemsOf("contain"))[0]).toMatch(/^outline cut by div\.box: /);
    expect(await problemsOf("fixed-free")).toEqual([]);
    expect((await problemsOf("fixed-edge"))[0]).toMatch(/^outline cut by the window: top/);
    // An overlay leaves the geometry whole: the pixels show that nothing is painted.
    expect(await problemsOf("overlay")).toEqual([]);
    expect(Object.values(await paintedSides(page))).toEqual([0, 0, 0, 0]);
    await page.locator("#plain").focus();
    expect(Object.values(await paintedSides(page)).every((count) => count > 0)).toBe(true);
  });

  test("a selected lineage card is told apart from a focused one", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await useMockApi(page, fullResult);
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    const card = page.locator("[data-card-id]").first();
    const look = () =>
      card.evaluate((element) => {
        const s = getComputedStyle(element);
        return `${s.outlineStyle} ${s.outlineWidth} offset ${s.outlineOffset}`;
      });
    await page.keyboard.press("Tab");
    await card.focus();
    await animationsSettled(page);
    const focused = await look();
    await page.keyboard.press("Enter");
    await expect(card).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: /Back to summary/ }).focus();
    await animationsSettled(page);
    const selected = await look();
    expect(selected.split(" ")[0], "the selected card's outline").not.toBe("none");
    expect(selected.split(" ")[0], `selected (${selected}) vs focused (${focused})`).not.toBe(
      focused.split(" ")[0],
    );
  });

  for (const colorScheme of ["light", "dark"] as const) {
    test.describe(`on a ${colorScheme} theme`, () => {
      test.use({ colorScheme });

      test("the map's cards and links in the Player show their own focus ring at 3:1", async ({
        page,
      }) => {
        test.setTimeout(150_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await useMockApi(page, kindsResult);
        await analyzeAndOpenDashboard(page, "Bright Lines");
        await openPlayer(page);
        expectMapRings(await mapItems(page));
      });

      test("the map page keeps its focus outlines, and its cards and links their ring at 3:1", async ({
        page,
      }) => {
        test.setTimeout(150_000);
        await page.setViewportSize({ width: 1440, height: 900 });
        await useMockApi(page, mapPageApi());
        await page.goto(`/t/${MAP_TRACK}/map`);
        await expect(
          page.getByRole("heading", { level: 1, name: /^Song relations of/ }),
        ).toBeFocused();
        await checkScreen(page, "the map page");
        const canvas = await page.evaluate(() => {
          const probe = document.createElement("div");
          probe.style.backgroundColor = "Canvas";
          document.body.append(probe);
          const colour = getComputedStyle(probe).backgroundColor;
          probe.remove();
          return colour;
        });
        test.info().annotations.push({ type: "Canvas", description: canvas });
        expectMapRings(await mapItems(page));
      });
    });
  }
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

  test("the map's focus ring keeps its colours", async ({ page }) => {
    test.setTimeout(150_000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await useMockApi(page, kindsResult);
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    const items = await mapItems(page);
    const strokes = new Set(items.map((item) => item.stroke));
    // The measured cyan: the cards' ring at full strength, a focused link's band at 0.3.
    expect([...strokes].sort()).toEqual(["rgb(0, 240, 255) at 0.3", "rgb(0, 240, 255) at 1"]);
    expect(items.filter((item) => item.outline?.outlineStyle !== "none")).toEqual([]);
  });
});
