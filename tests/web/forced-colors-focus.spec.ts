import { expect, type Locator, type Page, test } from "@playwright/test";
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
/** A result with model style and tag scores: a taller Sonic Fingerprint panel. */
const measuredResult = loadFixture("measured-v2");
/** The layer that draws the open activity log's list outline above its entries. */
const LOG_LAYER = '#activity-log-content .overflow-y-auto + [aria-hidden="true"]';
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
      __ringColour: (ring: Element) => string;
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

    /**
     * An SVG ring's colour as drawn: its stroke, with the stroke colour's own alpha times its
     * stroke-opacity and the opacity of it and each ancestor up to the document's root; none
     * at all when it is not visible or its stroke has no width.
     */
    w.__ringColour = (ring: Element) => {
      const s = getComputedStyle(ring);
      const rgba = parse(s.stroke);
      if (s.display === "none" || !rgba) return "transparent";
      let alpha = rgba[3] * Number(s.strokeOpacity);
      if (s.visibility !== "visible" || !(Number.parseFloat(s.strokeWidth) > 0)) alpha = 0;
      for (let at: Element | null = ring; at; at = at.parentElement) {
        alpha *= Number(getComputedStyle(at).opacity);
      }
      return `rgba(${rgba.slice(0, 3).join(", ")}, ${alpha})`;
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
  return (await outlinePixels(page)).sides;
}

/**
 * `paintedSides`, with `gaps`: per side, the pixels along its straight part (the element's box
 * less its corner radius, within the window) at which the band does not paint across its whole
 * width. Something that covers the outline there, or cuts it by even a pixel, leaves a gap.
 *
 * The band is the focused element's outline, or, given `drawnBy` and while it is shown, that
 * element's: a layer that draws the focused element's outline for it. A `solid` outline's band is
 * checked to its corner radius. Chrome rounds the corners of an `auto` ring (the browser's own)
 * whatever the radius: measured on the log list's 1px ring, 1px past its inset at each end, so an
 * `auto` band is checked to AUTO_RING_CORNER px further in.
 */
async function outlinePixels(page: Page, drawnBy?: string) {
  await animationsSettled(page);
  const geometry = await page.evaluate((layer) => {
    const drawn = layer ? document.querySelector(layer) : null;
    const element =
      drawn && getComputedStyle(drawn).display !== "none"
        ? drawn
        : (document.activeElement as Element);
    const s = getComputedStyle(element);
    const r = element.getBoundingClientRect();
    const width = Number.parseFloat(s.outlineWidth) || 0;
    const offset = Number.parseFloat(s.outlineOffset) || 0;
    const radius = Math.max(
      ...[
        s.borderTopLeftRadius,
        s.borderTopRightRadius,
        s.borderBottomRightRadius,
        s.borderBottomLeftRadius,
      ].map((value) => Number.parseFloat(value) || 0),
    );
    return {
      x: r.x,
      y: r.y,
      w: r.width,
      h: r.height,
      width,
      offset,
      radius,
      auto: s.outlineStyle === "auto",
    };
  }, drawnBy);
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
    async ({ a, b, g, clip, AUTO_RING_CORNER }) => {
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
      // How many of each band's pixels paint at each column (top and bottom sides) or row (left
      // and right).
      const hit = {
        top: new Map<number, number>(),
        right: new Map<number, number>(),
        bottom: new Map<number, number>(),
        left: new Map<number, number>(),
      };
      const add = (side: Map<number, number>, at: number) => side.set(at, (side.get(at) ?? 0) + 1);
      for (let y = 0; y < ia.height; y += 1) {
        for (let x = 0; x < ia.width; x += 1) {
          const i = (y * ia.width + x) * 4;
          if (pa[i] === pb[i] && pa[i + 1] === pb[i + 1] && pa[i + 2] === pb[i + 2]) continue;
          const px = x + 0.5;
          const py = y + 0.5;
          const across = px > left - outerEdge && px < right + outerEdge;
          const down = py > top - outerEdge && py < bottom + outerEdge;
          if (across && py > top - outerEdge && py < top - inner) {
            sides.top += 1;
            add(hit.top, x);
          }
          if (across && py > bottom + inner && py < bottom + outerEdge) {
            sides.bottom += 1;
            add(hit.bottom, x);
          }
          if (down && px > left - outerEdge && px < left - inner) {
            sides.left += 1;
            add(hit.left, y);
          }
          if (down && px > right + inner && px < right + outerEdge) {
            sides.right += 1;
            add(hit.right, y);
          }
        }
      }
      // Each side's straight part, in the screenshot's whole pixels: the box less its corner
      // radius, or less the inset of an outline drawn inside it. At each pixel along it, every
      // pixel across the band must paint, those beyond the window included (they cannot).
      const span = (from: number, to: number, size: number) => {
        const at: number[] = [];
        for (let p = Math.max(0, Math.ceil(from)); p < Math.min(size, Math.floor(to)); p += 1) {
          at.push(p);
        }
        return at;
      };
      const corner = Math.max(g.radius, -outerEdge, 0) + (g.auto ? AUTO_RING_CORNER : 0);
      const columns = span(left + corner, right - corner, ia.width);
      const rows = span(top + corner, bottom - corner, ia.height);
      const depth = (from: number, to: number) => {
        let count = 0;
        for (let p = Math.floor(from) - 1; p <= Math.ceil(to); p += 1) {
          if (p + 0.5 > from && p + 0.5 < to) count += 1;
        }
        return count;
      };
      const whole = {
        top: depth(top - outerEdge, top - inner),
        right: depth(right + inner, right + outerEdge),
        bottom: depth(bottom + inner, bottom + outerEdge),
        left: depth(left - outerEdge, left - inner),
      };
      const short = (side: keyof typeof hit, along: number[]) =>
        along.filter((at) => (hit[side].get(at) ?? 0) < whole[side]).length;
      const gaps = {
        top: short("top", columns),
        right: short("right", rows),
        bottom: short("bottom", columns),
        left: short("left", rows),
      };
      return { sides, gaps };
    },
    {
      a: `data:image/png;base64,${focused.toString("base64")}`,
      b: `data:image/png;base64,${plain.toString("base64")}`,
      g: geometry,
      clip,
      AUTO_RING_CORNER,
    },
  );
}

/**
 * Checks that the focused element's outline (or `drawnBy`'s, see `outlinePixels`) paints on all
 * four sides.
 */
async function expectPainted(page: Page, what: string, painted: string[], drawnBy?: string) {
  const { sides } = await outlinePixels(page, drawnBy);
  const bare = Object.entries(sides)
    .filter(([, count]) => count === 0)
    .map(([side]) => side);
  painted.push(`${what}: ${JSON.stringify(sides)}`);
  expect.soft(bare, `${what}: sides of its outline that paint nothing`).toEqual([]);
}

/**
 * How much further in `outlinePixels` checks an `auto` ring's sides, for its rounded corners: the
 * 1px measured. With none, every side of the list's ring had a 2px gap, one at each end.
 */
const AUTO_RING_CORNER = 1;

/**
 * Checks that the focused element's outline (or `drawnBy`'s, see `outlinePixels`) paints on all
 * four sides, and along the whole straight part of each: nothing covers or cuts any of it.
 */
async function expectWhole(page: Page, what: string, painted: string[], drawnBy?: string) {
  const { sides, gaps } = await outlinePixels(page, drawnBy);
  painted.push(`${what}: ${JSON.stringify(sides)}, gaps ${JSON.stringify(gaps)}`);
  expect
    .soft(
      Object.entries(sides)
        .filter(([, count]) => count === 0)
        .map(([side]) => side),
      `${what}: sides of its outline that paint nothing`,
    )
    .toEqual([]);
  expect
    .soft(
      Object.entries(gaps)
        .filter(([, count]) => count > 0)
        .map(([side, count]) => `${side} ${count}px`),
      `${what}: lengths of its outline's sides not painted across its width (covered or cut)`,
    )
    .toEqual([]);
}

/**
 * Waits until `locator`'s box, its scroll height and the size of each chart in it have stayed
 * the same for ten frames: after a resize, a chart redraws to its new size a little later.
 */
async function layoutSettled(page: Page, locator: Locator) {
  await animationsSettled(page);
  await locator.evaluate(
    (element) =>
      new Promise<void>((resolve, reject) => {
        const read = () => {
          const r = element.getBoundingClientRect();
          const charts = [...element.querySelectorAll("svg")].map((svg) => {
            const box = svg.getBoundingClientRect();
            return `${box.width}x${box.height}`;
          });
          return `${r.width}x${r.height} ${element.scrollHeight} ${charts.join(",")}`;
        };
        let last = read();
        let same = 0;
        const started = performance.now();
        const tick = () => {
          const now = read();
          same = now === last ? same + 1 : 0;
          last = now;
          if (same >= 10) resolve();
          else if (performance.now() - started > 10_000)
            reject(new Error(`no settled layout: ${now}`));
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );
}

/**
 * What of an element's content it does not show above or below: overflow past the bottom of its
 * padding box (which it hides, and nothing scrolls), and each piece of text drawn wholly or
 * partly above or below that box. Text a screen reader alone reads (sr-only) is left out.
 */
async function hiddenContent(locator: Locator) {
  return locator.evaluate((element) => {
    const out: string[] = [];
    if (element.scrollHeight > element.clientHeight) {
      out.push(
        `overflow: scrollHeight ${element.scrollHeight} > clientHeight ${element.clientHeight}`,
      );
    }
    const top = element.getBoundingClientRect().top + element.clientTop;
    const bottom = top + element.clientHeight;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = (node.textContent ?? "").replace(/\s+/g, " ").trim();
      const parent = node.parentElement;
      if (!text || !parent) continue;
      if (parent.closest(".sr-only")) continue;
      if (getComputedStyle(parent).visibility !== "visible") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width < 1 || rect.height < 1) continue;
        const past = rect.top < top - 0.5 || rect.bottom > bottom + 0.5;
        if (past) {
          out.push(
            `"${text.slice(0, 40)}" at ${rect.top.toFixed(0)}..${rect.bottom.toFixed(0)}, the panel shows ${top.toFixed(0)}..${bottom.toFixed(0)}`,
          );
          break;
        }
      }
    }
    return out;
  });
}

/**
 * full-result with six more status lines before its result (the API numbers the events): the
 * log's list shows its latest six entries, whose dots can be scrolled across either edge.
 */
function longLog() {
  const events = (fullResult.streams[ANALYZE] as Array<Record<string, unknown>>).map(
    ({ runId: _runId, seq: _seq, ...event }) => event,
  );
  const statuses = events.filter((event) => event.type === "status");
  const extra = [
    "Reading the audio features",
    "Tracing the samples",
    "Checking the credits",
    "Looking up the release history",
    "Comparing the sources",
    "Writing the notes",
  ].map((message, index) => ({ ...statuses[index % statuses.length], message }));
  const at = events.findIndex((event) => event.type === "complete");
  return {
    ...fullResult,
    streams: { [ANALYZE]: [...events.slice(0, at), ...extra, ...events.slice(at)] },
  };
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
      const w = window as unknown as {
        __contrast: (colour: string) => number;
        __ringColour: (ring: Element) => string;
      };
      const element = document.activeElement as SVGElement | null;
      if (!element?.matches("g.nodes > g, g.link-targets > path")) return null;
      const id =
        element.getAttribute("data-node-id") ?? `link ${element.getAttribute("data-link-index")}`;
      // The ring's colour as drawn, composited over the Canvas for its contrast.
      const ring = element.matches("g.nodes > g")
        ? element.querySelector<SVGElement>(".focus-ring")
        : element;
      if (!ring) return { id, what: id, ring: "no ring", contrast: 0, stroke: "" };
      const colour = w.__ringColour(ring);
      const alpha = Number(/([\d.]+)\)$/.exec(colour)?.[1] ?? 0);
      return {
        id,
        what: element.getAttribute("aria-label")?.slice(0, 60) ?? id,
        ring: alpha > 0 ? "ring" : `no ring (${colour})`,
        contrast: w.__contrast(colour),
        stroke: colour,
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

    // Open, the log's list is a scroller and a Tab stop of its own.
    await page.getByRole("button", { name: /activity log/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#activity-log-content")).not.toHaveAttribute("inert");
    await animationsSettled(page);
    const inLog = (await tabThrough(page, 200)).filter((stop) => stop.inLog);
    expect(inLog.length, "the open activity log's list is a Tab stop").toBeGreaterThan(0);
    expectOutlines(inLog, "the open activity log");

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
    await page.getByRole("button", { name: /activity log/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#activity-log-content")).not.toHaveAttribute("inert");
    // The log has opened before the list takes the focus. Focused before its open height is laid
    // out, the list is scrolled into view only as far as the page's height with the log closed
    // allows, and once the log opens the list's bottom lies below the view.
    await animationsSettled(page);
    const list = page.locator("#activity-log-content .overflow-y-auto");
    await list.focus();
    await expect(list).toBeFocused();
    // The outline seen is the one the layer above the entries draws for the list.
    await expectPainted(page, "activity log list", painted, LOG_LAYER);

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

  for (const [name, fixture, chart, noRoom] of [
    // full-result's panel draws its genre profile as a radar chart; measured-v2's lists the
    // audio models' style and tag scores instead.
    // The outline needs the panel's content and 4px either side within the screen's view (the
    // window less its footer). measured-v2's content (model style and tag scores) is 792px tall
    // at 1024px wide and 583px at 1280px: more than the 743px view at 1024×768 and the 475px
    // view at 1280×500, so no scroll can show its whole outline there. Those two only check that
    // all of the content shows (and that the panel is that tall, which is why).
    ["full-result", fullResult, true, []],
    ["measured-v2", measuredResult, false, ["1024×768", "1280×500"]],
  ] as const) {
    test(`with the activity log open, the Sonic Fingerprint panel shows all of its content and its whole outline (${name})`, async ({
      page,
    }) => {
      test.setTimeout(180_000);
      const painted: string[] = [];
      await page.setViewportSize({ width: 1440, height: 900 });
      await useMockApi(page, fixture);
      await analyzeAndOpenDashboard(page, "Bright Lines");
      const toggle = page.getByRole("button", { name: /activity log/ });
      await toggle.focus();
      await page.keyboard.press("Enter");
      await expect(page.locator("#activity-log-content")).not.toHaveAttribute("inert");
      const panel = page.getByRole("region", { name: "Sonic Fingerprint" });

      for (const [width, height] of [
        [1440, 900],
        [1024, 768],
        [1280, 500],
      ] as const) {
        const size = `${width}×${height}`;
        await page.setViewportSize({ width, height });
        await layoutSettled(page, panel);

        // The panel never hides any of its content, in forced-colors mode or not: it hides its
        // overflow, and nothing scrolls it.
        // Only what is hidden above or below is checked: at 1024px wide the radar draws an axis
        // label ("Electronic", full-result) past the panel's right side in either mode, as on
        // main. That is the chart's own sizing (its radius against the narrow column), which
        // the panel's height does not decide.
        for (const forcedColors of ["active", "none"] as const) {
          await page.emulateMedia({ forcedColors });
          await layoutSettled(page, panel);
          expect
            .soft(
              await hiddenContent(panel),
              `${name} at ${size}, forced colors ${forcedColors}: content the panel hides`,
            )
            .toEqual([]);
          // A chart is drawn, at least as tall as its area's minimum (300px from md, and every
          // size here is md or wider): a panel sized by its content must still give it a height
          // to draw in.
          const drawn = await panel
            .locator("svg.recharts-surface")
            .evaluateAll((svgs) =>
              svgs.map((svg) => Math.round(svg.getBoundingClientRect().height)),
            );
          expect
            .soft(
              drawn,
              `${name} at ${size}, forced colors ${forcedColors}: the charts drawn, by height`,
            )
            .toEqual(chart ? [expect.any(Number)] : []);
          if (chart) {
            expect
              .soft(
                drawn[0],
                `${name} at ${size}, forced colors ${forcedColors}: the chart's height`,
              )
              .toBeGreaterThanOrEqual(300);
          }
        }
        await page.emulateMedia({ forcedColors: "active" });
        await layoutSettled(page, panel);

        // The panel takes the focus by script (after its chart's "Try again"): after the log's
        // toggle, and with the screen scrolled to its top and to its end.
        for (const from of ["after the log's toggle", "from the top", "from the end"] as const) {
          const what = `${name} at ${size}, the panel focused ${from}`;
          if (from === "after the log's toggle") await toggle.focus();
          await panel.evaluate((element, start) => {
            if (start === "after the log's toggle") return;
            (document.activeElement as HTMLElement | null)?.blur();
            const screen = element.closest(".overflow-y-auto") as HTMLElement;
            screen.scrollTop = start === "from the top" ? 0 : screen.scrollHeight;
          }, from);
          await panel.focus();
          await expect(panel).toBeFocused();
          const fit = await panel.evaluate((element) => {
            const s = getComputedStyle(element);
            const grow = Math.max(
              (Number.parseFloat(s.outlineWidth) || 0) + (Number.parseFloat(s.outlineOffset) || 0),
              0,
            );
            const screen = (
              element.closest(".overflow-y-auto") as HTMLElement
            ).getBoundingClientRect();
            const box = element.getBoundingClientRect();
            return {
              outline: [box.top - grow, box.bottom + grow],
              view: [screen.top, screen.bottom],
            };
          });
          const outlined = fit.outline[1] - fit.outline[0];
          const room = fit.view[1] - fit.view[0];
          if ((noRoom as readonly string[]).includes(size)) {
            // The content alone is taller than the view: the outline cannot be shown whole, and
            // only that is left unchecked.
            expect
              .soft(outlined, `${what}: the panel with its outline, in a ${room}px view`)
              .toBeGreaterThan(room);
            continue;
          }
          const stop = await focusedStop(page);
          expectOutlines(stop ? [stop] : [], what);
          expect
            .soft(
              fit.outline[0] >= fit.view[0] && fit.outline[1] <= fit.view[1],
              `${what}: its outline (${fit.outline.join("..")}) in the screen's view (${fit.view.join("..")})`,
            )
            .toBe(true);
          await expectWhole(page, what, painted);
        }
      }
      test.info().annotations.push({ type: "painted pixels", description: painted.join("\n") });
    });
  }

  test("the open activity log's list shows its whole outline at rest, scrolled, and under its dots", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const painted: string[] = [];
    await page.setViewportSize({ width: 1440, height: 900 });
    await useMockApi(page, longLog());
    await analyzeAndOpenDashboard(page, "Bright Lines");
    const toggle = page.getByRole("button", { name: /activity log/ });
    await toggle.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#activity-log-content")).not.toHaveAttribute("inert");
    await animationsSettled(page);
    await expect(page.locator("#activity-log-content [data-log-code]")).toHaveCount(6);
    // The layer draws the list's outline only while the list has the focus: none yet.
    const layer = page.locator(LOG_LAYER);
    await expect(toggle).toBeFocused();
    await expect(layer).toBeHidden();

    // Tab goes from the toggle to the list, as before.
    await page.keyboard.press("Tab");
    const list = page.locator("#activity-log-content .overflow-y-auto");
    await expect(list).toBeFocused();
    const range = await list.evaluate((element) => element.scrollHeight - element.clientHeight);
    expect(range, "the list scrolls").toBeGreaterThan(0);

    // Scroll positions that put an entry's dot (positioned, z-10) across the list's top edge
    // and across its bottom edge, where it would cover an outline drawn below it.
    const across = await list.evaluate((element, band) => {
      const dots = [...element.querySelectorAll("[data-log-code] > :first-child")];
      const box = element.getBoundingClientRect();
      const height = element.clientHeight;
      const max = element.scrollHeight - height;
      // Each dot's top in the list's scrolled content.
      const tops = dots.map((dot) => dot.getBoundingClientRect().top - box.top + element.scrollTop);
      const pick = (want: (top: number) => number) =>
        tops.map(want).find((at) => at >= 0 && at <= max);
      return {
        // The dot from 2px above the top edge, and 6px above the bottom edge: across the band.
        top: pick((top) => Math.round(top + 2)),
        bottom: pick((top) => Math.round(top - (height - band - 4))),
      };
    }, 2);
    expect(across.top, "a scroll position puts a dot across the top edge").toBeDefined();
    expect(across.bottom, "a scroll position puts a dot across the bottom edge").toBeDefined();

    for (const [where, at, edge] of [
      ["at rest", 0, null],
      ["scrolled to the middle", Math.round(range / 2), null],
      ["scrolled to the end", range, null],
      ["with a dot across its top edge", across.top as number, "top"],
      ["with a dot across its bottom edge", across.bottom as number, "bottom"],
    ] as const) {
      await list.evaluate((element, top) => {
        element.scrollTop = top;
      }, at);
      expect(await list.evaluate((element) => element.scrollTop)).toBe(at);
      if (edge) {
        // The dot is there, across the band the outline takes inside that edge.
        const crossing = await list.evaluate((element, side) => {
          const box = element.getBoundingClientRect();
          const band = side === "top" ? [box.top, box.top + 2] : [box.bottom - 2, box.bottom];
          return [...element.querySelectorAll("[data-log-code] > :first-child")].some((dot) => {
            const r = dot.getBoundingClientRect();
            return (
              r.top < band[1] && r.bottom > band[0] && r.left >= box.left && r.right <= box.right
            );
          });
        }, edge);
        expect(crossing, `a dot lies across the list's ${edge} edge`).toBe(true);
      }
      const stop = await focusedStop(page);
      expectOutlines(stop ? [stop] : [], `the activity log's list ${where}`);
      // The band checked is the 2px the list's outline is drawn in, by the layer above the
      // entries; without the layer (or while it is not shown), the list's own outline.
      await expectWhole(page, `activity log list ${where}`, painted, LOG_LAYER);
    }

    // Back on the toggle, the list shows no outline: one focus indicator, on the toggle.
    await page.keyboard.press("Shift+Tab");
    await expect(toggle).toBeFocused();
    await expect(layer).toBeHidden();
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

    // A map ring's contrast counts its stroke colour's own alpha, its stroke-opacity and the
    // opacity of its groups, composited over the Canvas.
    const rings = await page.evaluate(() => {
      const w = window as unknown as {
        __contrast: (colour: string) => number;
        __ringColour: (ring: Element) => string;
      };
      document.body.innerHTML = `
        <svg width="300" height="60">
          <rect id="faint" x="5" y="5" width="40" height="40" fill="none" style="stroke: rgba(128, 128, 128, 0.05)" />
          <rect id="faded" x="55" y="5" width="40" height="40" fill="none" stroke="rgb(0, 0, 0)" stroke-opacity="0.2" />
          <g opacity="0.1"><rect id="group" x="105" y="5" width="40" height="40" fill="none" stroke="rgb(0, 0, 0)" /></g>
          <rect id="solid" x="155" y="5" width="40" height="40" fill="none" stroke="rgb(0, 0, 0)" />
          <rect id="unseen" x="205" y="5" width="40" height="40" fill="none" stroke="rgb(0, 0, 0)" visibility="hidden" />
          <rect id="thin" x="255" y="5" width="40" height="40" fill="none" stroke="rgb(0, 0, 0)" stroke-width="0" />
        </svg>
        <div style="opacity: 0.1">
          <svg width="60" height="60">
            <rect id="outer" x="5" y="5" width="40" height="40" fill="none" stroke="rgb(0, 0, 0)" />
          </svg>
        </div>`;
      return Object.fromEntries(
        ["faint", "faded", "group", "solid", "unseen", "thin", "outer"].map((id) => {
          const colour = w.__ringColour(document.getElementById(id) as Element);
          return [id, `${colour} ${w.__contrast(colour).toFixed(2)}`];
        }),
      );
    });
    expect(rings).toEqual({
      faint: "rgba(128, 128, 128, 0.05) 1.06",
      faded: "rgba(0, 0, 0, 0.2) 1.61",
      group: "rgba(0, 0, 0, 0.1) 1.25",
      solid: "rgba(0, 0, 0, 1) 21.00",
      unseen: "rgba(0, 0, 0, 0) 1.00",
      thin: "rgba(0, 0, 0, 0) 1.00",
      outer: "rgba(0, 0, 0, 0.1) 1.25",
    });
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
    // (A card the pointed or selected track is not joined to fades, its ring with it.)
    expect(
      [...strokes].filter((stroke) => !/^rgba\(0, 240, 255, (?:0\.3|0\.45|1)\)$/.test(stroke)),
    ).toEqual([]);
    expect([...strokes]).toEqual(
      expect.arrayContaining(["rgba(0, 240, 255, 0.3)", "rgba(0, 240, 255, 1)"]),
    );
    expect(items.filter((item) => item.outline?.outlineStyle !== "none")).toEqual([]);
  });
});
