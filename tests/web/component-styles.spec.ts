import { expect, type Page, test } from "@playwright/test";
import { hoverCard } from "./hover";
import {
  analyzeAndOpenDashboard,
  animationsSettled,
  dashboardHeading,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";

// Computed-style checks for the shared components: transitions, the connected-track card's hover,
// the small badge's size and the neutral badge's contrast, and the Dashboard skeleton's spacing.

/** The full-result fixture with an explicit track, so a small badge sits in the hero's text-sm. */
function explicitResult() {
  const fixture = loadFixture("full-result");
  const complete = fixture.streams["/api/analyze/stream"].find(
    (event: { type: string }) => event.type === "complete",
  );
  complete.data.explicit = true;
  return fixture;
}

test("buttons transition colour, glow, lift and press, the focus ring fastest", async ({
  page,
}) => {
  await useMockApi(page, loadFixture("full-result"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  const button = page.getByRole("button", { name: "View full analysis" });
  const transition = await button.evaluate((element) => {
    const style = getComputedStyle(element);
    return { property: style.transitionProperty, duration: style.transitionDuration };
  });
  expect(transition).toEqual({
    property: "color, background-color, border-color, box-shadow, translate, scale",
    duration: "0.15s, 0.15s, 0.15s, 0.1s, 0.15s, 0.15s",
  });
});

test.describe("the connected-track card", () => {
  test.beforeEach(async ({ page }) => {
    await useMockApi(page, loadFixture("full-result"));
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Bright Lines");
  });

  test("animates its lift", async ({ page }) => {
    const card = page.getByRole("button", { name: /Older Record/ });
    const lifted = card.locator("> div").first();
    const transition = await lifted.evaluate((element) => getComputedStyle(element).transition);
    expect(transition).toContain("translate 0.25s");
  });

  test("stays hovered with the pointer just above its bottom edge", async ({ page }) => {
    const card = page.getByRole("button", { name: /Older Record/ });
    // Rest the pointer 2 px above the bottom edge of the card as it sits before the lift.
    const { point } = await hoverCard(page, card, (box) => ({
      x: box.x + box.width / 2,
      y: box.y + box.height - 2,
    }));
    await expect(card.getByText("Analyze this track", { exact: true })).toBeVisible();
    // The lift (4 px) must not move the card out from under the pointer: nudge the pointer
    // sideways, as a resting hand does, and check the hover each time.
    const samples: boolean[] = [];
    for (let i = 0; i < 12; i += 1) {
      await page.mouse.move(point.x + (i % 2), point.y);
      await page.waitForTimeout(50);
      samples.push((await card.getAttribute("data-hovered")) === "true");
    }
    expect(samples).toEqual(Array(12).fill(true));
  });
});

/**
 * Small badges (bordered, text-chrome) and their height, in document order. Plain text-chrome
 * lines (a value's provenance) are not badges.
 */
const smallBadges = (page: Page) =>
  page.locator("span.border.text-chrome").evaluateAll((elements) =>
    elements.map((element) => ({
      text: element.textContent?.trim().slice(0, 30),
      height: element.getBoundingClientRect().height,
    })),
  );

test("the search screen draws its background glow", async ({ page }) => {
  await useMockApi(page, loadFixture("full-result"));
  await page.goto("/");
  // A gradient whose stops do not resolve (Tailwind v3's var(--tw-gradient-stops) pattern) is
  // valid CSS and computes to none.
  const image = await page
    .getByTestId("background-ambience")
    .evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(image).toMatch(/^radial-gradient\(circle/);
});

test("small badges have one height wherever they sit", async ({ page }) => {
  await useMockApi(page, explicitResult());
  await analyzeAndOpenDashboard(page, "Bright Lines");
  const badges = await smallBadges(page);
  expect(badges.map((badge) => badge.text)).toContain("EXPLICIT");
  // 16 px of chrome text (12 px type), 4 px padding above and below, a 1 px border.
  for (const badge of badges) expect(badge, badge.text).toMatchObject({ height: 26 });
});

// An all-white album cover, the worst case behind the translucent hero and Player backgrounds.
const WHITE_COVER = "https://i.scdn.co/image/white-cover";
const WHITE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="100%" height="100%" fill="#fff"/></svg>';

/**
 * Serves every image from `origin` as a white square. The function it returns checks, on the view
 * about to be measured, that the white cover was requested and is drawn there: an <img> from
 * `origin` on screen, loaded and decoded. A route that stops matching the cover's URL, or a view
 * that stops showing the cover, then fails instead of measuring against no cover at all.
 */
async function serveWhiteCover(page: Page, origin: string) {
  let served = 0;
  await page.route(`${origin}**`, (route) => {
    served += 1;
    return route.fulfill({ contentType: "image/svg+xml", body: WHITE_SVG });
  });
  return async () => {
    await expect.poll(() => served, "the white cover is requested").toBeGreaterThan(0);
    await expect
      .poll(
        () =>
          page.evaluate(
            (origin) =>
              [...document.images].filter(
                (image) =>
                  image.currentSrc.startsWith(origin) &&
                  image.complete &&
                  image.naturalWidth > 0 &&
                  image.getClientRects().length > 0,
              ).length,
            origin,
          ),
        { message: "the white cover is drawn" },
      )
      .toBeGreaterThan(0);
  };
}

/** A fixture whose result shows the white cover. */
function withWhiteCover(fixture: ReturnType<typeof loadFixture>) {
  const complete = fixture.streams["/api/analyze/stream"].find(
    (event: { type: string }) => event.type === "complete",
  );
  complete.data.coverUrl = WHITE_COVER;
  return fixture;
}

type Rgba = { r: number; g: number; b: number; a: number };
const channel = (value: number) => {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (c: Rgba) =>
  0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
const over = (top: Rgba, bottom: Rgba): Rgba => ({
  r: top.r * top.a + bottom.r * (1 - top.a),
  g: top.g * top.a + bottom.g * (1 - top.a),
  b: top.b * top.a + bottom.b * (1 - top.a),
  a: 1,
});

/**
 * Waits until what is drawn behind the text is final: every image on the page decoded (the
 * Player's blurred background cover shows only once its image is in), and so every SVG <image>
 * and CSS url() background (loaded through the same cache), and the page's animations settled.
 */
async function backgroundSettled(page: Page) {
  await page.evaluate(() => {
    const urls = new Set<string>();
    for (const image of document.querySelectorAll("svg image")) {
      const href = image.getAttribute("href") ?? image.getAttribute("xlink:href");
      if (href) urls.add(new URL(href, document.baseURI).href);
    }
    for (const element of document.querySelectorAll("*")) {
      for (const pseudo of [null, "::before", "::after"]) {
        const { backgroundImage } = getComputedStyle(element, pseudo);
        for (const [, url] of backgroundImage.matchAll(/url\("([^"]*)"\)/g)) urls.add(url);
      }
    }
    const loads = [...urls].map((url) => {
      const image = new Image();
      image.src = url;
      return image;
    });
    return Promise.all(
      [...document.images, ...loads].map((image) => image.decode().catch(() => {})),
    );
  });
  await animationsSettled(page);
}

/** The widest spread between a colour's channels for it to count as grey (see below). */
const NEUTRAL_SPREAD = 40;

/** Batched elements keep at least this many pixels apart (see neutralBadgeContrast). */
const MEASURE_GAP = 8;

/**
 * WCAG contrast of the grey text in each neutral badge, against what the page actually draws
 * behind it: the badge's text and icons are hidden, the area inside its border is screenshotted
 * (cover image, blur and every translucent layer included), and its brightest pixel is the
 * background. Coloured values inside a badge (cyan, amber, pink) are not measured here unless
 * `coloured` is set; a colour that cannot be read is an error.
 *
 * The pointer is first moved off the page's content and focus is dropped, so every badge is
 * measured at rest: a test that hovers or focuses on purpose says so with `keepHover` or
 * `keepFocus`, and a badge hovered or focused otherwise is an error. Then it waits once for the
 * background to settle, and the badges in view together are measured from one screenshot: the
 * first one not yet measured is scrolled into view, and every other one fully in view that keeps
 * MEASURE_GAP px from the badges already picked is read (its text and colour, as drawn now),
 * hidden and measured with it. So each badge's area shows what it would on its own (only its own
 * text and icons hidden), with a few screenshots per page instead of one per badge. An area's
 * pixels are those at least half inside it, and an area with none is an error. The results are
 * in document order.
 */
async function neutralBadgeContrast(
  page: Page,
  selector = "span.border-white\\/15",
  { keepHover = false, keepFocus = false, coloured = false } = {},
) {
  if (!keepHover) await page.mouse.move(0, 0);
  if (!keepFocus) {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  }
  await backgroundSettled(page);
  await page.addStyleTag({
    content:
      "[data-measuring],[data-measuring] *{color:transparent!important;text-decoration-color:transparent!important;text-shadow:none!important;transition:none!important}[data-measuring] svg{visibility:hidden!important}",
  });
  const badges = page.locator(selector);
  type Found = Array<{ text: string; color: string }>;
  const texts: Array<Found | undefined> = Array(await badges.count()).fill(undefined);
  const backgrounds: Array<Rgba | undefined> = texts.map(() => undefined);
  for (
    let first = backgrounds.indexOf(undefined);
    first !== -1;
    first = backgrounds.indexOf(undefined)
  ) {
    await badges.nth(first).scrollIntoViewIfNeeded();
    const pending = backgrounds.flatMap((background, i) => (background ? [] : [i]));
    // The first pending badge, and each other one fully in view (not clipped by the viewport
    // or a scrolling box) and MEASURE_GAP px clear of those picked; their text and colour are
    // read as drawn now, then they are hidden together.
    const picked = await badges.evaluateAll(
      (elements, { pending, gap, keepHover, keepFocus }) => {
        // A computed colour as rgb()/rgba(): one the browser reports otherwise (oklab() for
        // text-white/40) is drawn on a 1 px canvas and read back in sRGB.
        const asRgb = (color: string) => {
          if (/^rgba?\(/.test(color)) return color;
          const context = new OffscreenCanvas(1, 1).getContext("2d");
          if (!context) throw new Error("no 2d context");
          context.fillStyle = "rgb(1, 2, 3)";
          context.fillStyle = color;
          if (context.fillStyle === "#010203") throw new Error(`cannot read the colour ${color}`);
          context.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
          return `rgba(${r}, ${g}, ${b}, ${a / 255})`;
        };
        const inView = (element: Element, box: DOMRect) => {
          if (box.top < 0 || box.left < 0) return false;
          if (box.bottom > innerHeight || box.right > innerWidth) return false;
          for (let up = element.parentElement; up; up = up.parentElement) {
            const style = getComputedStyle(up);
            if (`${style.overflowX} ${style.overflowY}` === "visible visible") continue;
            const clip = up.getBoundingClientRect();
            if (box.top < clip.top || box.left < clip.left) return false;
            if (box.bottom > clip.bottom || box.right > clip.right) return false;
          }
          return true;
        };
        const apart = (a: DOMRect, b: DOMRect) =>
          a.right + gap <= b.left ||
          b.right + gap <= a.left ||
          a.bottom + gap <= b.top ||
          b.bottom + gap <= a.top;
        const chosen: Array<{ index: number; box: DOMRect }> = [];
        for (const index of pending) {
          const element = elements[index];
          if (element.getClientRects().length === 0) throw new Error("a neutral badge has no box");
          const box = element.getBoundingClientRect();
          if (chosen.length > 0 && !inView(element, box)) continue;
          if (!chosen.every((other) => apart(other.box, box))) continue;
          chosen.push({ index, box });
        }
        return chosen.map(({ index, box }) => {
          const element = elements[index];
          const label = element.textContent?.trim().slice(0, 60);
          if (!keepHover && element.matches(":hover")) throw new Error(`"${label}" is hovered`);
          if (!keepFocus && element.matches(":focus-within")) {
            throw new Error(`"${label}" has the focus`);
          }
          const found: Array<{ text: string; color: string }> = [];
          const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
          for (let text = walker.nextNode(); text; text = walker.nextNode()) {
            if (!text.textContent?.trim() || !text.parentElement) continue;
            found.push({
              text: text.textContent.trim(),
              color: asRgb(getComputedStyle(text.parentElement).color),
            });
          }
          element.setAttribute("data-measuring", "");
          return { index, found, x: box.x, y: box.y, width: box.width, height: box.height };
        });
      },
      { pending, gap: MEASURE_GAP, keepHover, keepFocus },
    );
    // One screenshot of the smallest whole-pixel area around them, inside the viewport.
    const viewport = page.viewportSize();
    if (!viewport) throw new Error("no viewport");
    const left = Math.max(0, Math.floor(Math.min(...picked.map((box) => box.x))));
    const top = Math.max(0, Math.floor(Math.min(...picked.map((box) => box.y))));
    const right = Math.min(
      viewport.width,
      Math.ceil(Math.max(...picked.map((b) => b.x + b.width))),
    );
    const bottom = Math.min(
      viewport.height,
      Math.ceil(Math.max(...picked.map((b) => b.y + b.height))),
    );
    const clip = { x: left, y: top, width: right - left, height: bottom - top };
    const label = (box: (typeof picked)[number]) =>
      `"${box.found.map(({ text }) => text).join(" ")}"`;
    if (clip.width <= 0 || clip.height <= 0) {
      throw new Error(`${picked.map(label).join(", ")}: nothing of it in view to measure`);
    }
    const png = await page.screenshot({ clip, animations: "disabled" });
    await badges.evaluateAll((elements) => {
      for (const element of elements) element.removeAttribute("data-measuring");
    });
    // The brightest pixel inside each picked badge's border (2 px in from its box), or null
    // when no whole pixel is inside it.
    const brightest: Array<Rgba | null> = await page.evaluate(
      async ({ base64, boxes, clip }) => {
        const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
        const bitmap = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext("2d");
        if (!context) throw new Error("no 2d context");
        context.drawImage(bitmap, 0, 0);
        const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
        const scale = bitmap.width / clip.width;
        return boxes.map((box) => {
          const x = box.x - clip.x;
          const y = box.y - clip.y;
          const left = Math.max(0, Math.round((x + 2) * scale));
          const top = Math.max(0, Math.round((y + 2) * scale));
          const right = Math.min(bitmap.width, Math.round((x + box.width - 2) * scale));
          const bottom = Math.min(bitmap.height, Math.round((y + box.height - 2) * scale));
          if (right <= left || bottom <= top) return null;
          let best = { r: 0, g: 0, b: 0, a: 1 };
          for (let y = top; y < bottom; y += 1) {
            for (let x = left; x < right; x += 1) {
              const j = (y * bitmap.width + x) * 4;
              if (data[j] + data[j + 1] + data[j + 2] > best.r + best.g + best.b) {
                best = { r: data[j], g: data[j + 1], b: data[j + 2], a: 1 };
              }
            }
          }
          return best;
        });
      },
      { base64: png.toString("base64"), boxes: picked, clip },
    );
    picked.forEach((box, i) => {
      const background = brightest[i];
      if (!background) throw new Error(`${label(box)}: no whole pixel inside its border`);
      texts[box.index] = box.found;
      backgrounds[box.index] = background;
    });
  }
  const result: Array<{ text: string; ratio: number }> = [];
  texts.forEach((found, i) => {
    const background = backgrounds[i] as Rgba;
    for (const { text, color } of found ?? []) {
      const match = /^rgba?\(([^)]+)\)$/.exec(color);
      if (!match) throw new Error(`"${text}": cannot read its colour ${color}`);
      const [r, g, b, a = 1] = match[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      // Coloured text (cyan, amber, green, pink) is not measured here; grey, even a slightly
      // tinted one (Tailwind's gray-400 is rgb(156, 163, 175)), is.
      if (!coloured && Math.max(r, g, b) - Math.min(r, g, b) > NEUTRAL_SPREAD) continue;
      const foreground = over({ r, g, b, a }, background);
      const [light, dark] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
      result.push({ text, ratio: Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100 });
    }
  });
  return result;
}

for (const fixture of ["full-result", "missing-states"]) {
  for (const cover of ["no cover", "a white cover"]) {
    test(`neutral badge text meets 4.5:1 on the Dashboard and the Player (${fixture}, ${cover})`, async ({
      page,
    }) => {
      const whiteCoverShown = await serveWhiteCover(page, "https://i.scdn.co/");
      const data = fixture === "full-result" ? explicitResult() : loadFixture(fixture);
      await useMockApi(page, cover === "no cover" ? data : withWhiteCover(data));
      await page.setViewportSize({ width: 1440, height: 900 });
      await analyzeAndOpenDashboard(page, "Track");
      if (cover !== "no cover") await whiteCoverShown();
      const dashboard = await neutralBadgeContrast(page);
      await openPlayer(page);
      if (cover !== "no cover") await whiteCoverShown();
      const player = await neutralBadgeContrast(page);
      expect(dashboard.length).toBeGreaterThan(0);
      expect(player.length).toBeGreaterThan(0);
      for (const { text, ratio } of [...dashboard, ...player]) {
        expect(ratio, `"${text}"`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
}

const DASHBOARD_MODULE =
  /\/(?:assets\/Dashboard-[\w-]+\.js|src\/components\/Dashboard\.tsx)(?:\?|$)/;

test("the Dashboard skeleton has the Dashboard's padding and gaps", async ({ page }) => {
  await useMockApi(page, loadFixture("full-result"));
  await page.setViewportSize({ width: 1440, height: 900 });
  // Hold the Dashboard module so its loading skeleton stays on screen: the built chunk the tests
  // are served (assets/Dashboard-<hash>.js), or the source file on a dev server.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let holding = false;
  await page.route(DASHBOARD_MODULE, async (route) => {
    holding = true;
    await held;
    await route.continue();
  });
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Bright Lines");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.getByRole("button", { name: "Open the results" }).click();

  // Measured only while the module is held: a pattern that no longer matches the chunk's name
  // fails here instead of measuring whatever else is on screen.
  await expect.poll(() => holding).toBe(true);
  const skeleton = page.locator("div.animate-progress-shimmer").first().locator("xpath=../../..");
  await expect(skeleton).toBeVisible();
  const spacing = await skeleton.evaluate((element) => {
    const style = getComputedStyle(element);
    return { padding: style.padding, gap: style.rowGap };
  });
  release();
  await expect(dashboardHeading(page)).toBeVisible();
  const dashboard = dashboardHeading(page).locator("xpath=ancestor::section[1]/..");
  const loaded = await dashboard.evaluate((element) => {
    const style = getComputedStyle(element);
    return { left: style.paddingLeft, top: style.paddingTop, gap: style.rowGap };
  });
  expect(spacing.gap).toBe(loaded.gap);
  expect(spacing.padding.split(" ")[0]).toBe(loaded.top);
  expect(spacing.padding).toContain(loaded.left);
});

// The lines that say what a value is (measured, model estimate, its confidence, basis and
// method) or why it is missing, and the headings of the audio-model scores.
const PROVENANCE_TEXT = [
  "[data-value-kind] > span.max-w-60",
  'section[aria-label$="(model estimate)"] > p',
  'p:text-is("Audio-model estimates (scores, not probabilities)")',
  // The timeline's preview-lane header and its notes ("No key moments — <reason>").
  '[aria-label="Song structure"] [role="group"] > div:first-child > span',
  '[aria-label="Song structure"] > p',
].join(", ");

for (const fixture of ["measured-v2", "partly-measured-v2", "gated-v2"]) {
  for (const cover of ["no cover", "a white cover"]) {
    test(`provenance and missing-value lines meet 4.5:1 (${fixture}, ${cover})`, async ({
      page,
    }) => {
      const whiteCoverShown = await serveWhiteCover(page, "https://i.scdn.co/");
      const data = loadFixture(fixture);
      await useMockApi(page, cover === "no cover" ? data : withWhiteCover(data));
      await page.setViewportSize({ width: 1440, height: 900 });
      await analyzeAndOpenDashboard(page, "Track");
      if (cover !== "no cover") await whiteCoverShown();
      const dashboard = await neutralBadgeContrast(page, PROVENANCE_TEXT);
      await openPlayer(page);
      if (cover !== "no cover") await whiteCoverShown();
      const player = await neutralBadgeContrast(page, PROVENANCE_TEXT);
      expect(dashboard.length).toBeGreaterThan(4);
      expect(player.length).toBeGreaterThan(2);
      for (const { text, ratio } of [...dashboard, ...player]) {
        expect(ratio, `"${text}"`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
}

// The genealogy's words: the connected-track cards' relation badges and provenance lines on the
// Dashboard; the legend, the link list and a focused link's detail in the Player.
const GENEALOGY_TEXT = {
  dashboard: "span[data-link-kind], p[data-link-relation], p[data-link-provenance]",
  player: [
    '[aria-label="Link legend"] li',
    '[data-testid="links-hidden"]',
    '[data-testid="genealogy-kinds"]',
    "#panel-genealogy details summary",
    '[aria-label="Genealogy links"] li',
  ].join(", "),
  detail: '[data-testid="link-detail"]',
};

for (const cover of ["no cover", "a white cover"]) {
  test(`genealogy relation, legend and link text meet 4.5:1 (${cover})`, async ({ page }) => {
    // Three passes: the Dashboard's cards at rest, then each card hovered and measured on its own
    // (a settle and a screenshot per card), then the Player's legend, list and link detail. In a
    // full parallel run on a loaded machine that comes close to the default limit.
    test.slow();
    const whiteCoverShown = await serveWhiteCover(page, "https://i.scdn.co/");
    // Sourced and inferred relations both, so both badge styles are on the Dashboard.
    const data = loadFixture("genealogy-kinds");
    const complete = data.streams["/api/analyze/stream"].find(
      (event: { type: string }) => event.type === "complete",
    );
    const { genealogy } = complete.data;
    genealogy.nodes = genealogy.nodes.filter((node: { id: string }) =>
      [
        "current",
        "sample-sourced",
        "sample-inferred",
        "influence-inferred",
        "backwards",
        "rejected",
      ].includes(node.id),
    );
    const kept = new Set(genealogy.nodes.map((node: { id: string }) => node.id));
    genealogy.links = genealogy.links.filter(
      (link: { source: string; target: string }) => kept.has(link.source) && kept.has(link.target),
    );
    await useMockApi(page, cover === "no cover" ? data : withWhiteCover(data));
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Track");
    if (cover !== "no cover") await whiteCoverShown();
    const dashboard = await neutralBadgeContrast(page, GENEALOGY_TEXT.dashboard);
    // A hovered card lightens behind its badge, relation and provenance: each card, hovered.
    const cards = page.getByRole("button").filter({ has: page.locator("[data-link-kind]") });
    const hoveredText = `[data-hovered] :is(${GENEALOGY_TEXT.dashboard})`;
    for (let i = 0; i < (await cards.count()); i += 1) {
      const card = cards.nth(i);
      await card.scrollIntoViewIfNeeded();
      const box = await card.boundingBox();
      if (!box) throw new Error("a connected card has no box");
      const pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(pointer.x, pointer.y);
      await expect(card).toHaveAttribute("data-hovered", "true");
      // neutralBadgeContrast waits for the hover's transitions (backgroundSettled) itself.
      const hovered = await neutralBadgeContrast(page, hoveredText, { keepHover: true });
      expect(hovered.length, `card ${i + 1}, hovered`).toBeGreaterThan(0);
      // Measured hovered: the card is still the one under the pointer.
      const stillHovered = await card.evaluate(
        (element, { x, y }) =>
          element.matches(":hover") && element.contains(document.elementFromPoint(x, y)),
        pointer,
      );
      expect(stillHovered, `card ${i + 1} stays under the pointer`).toBe(true);
      dashboard.push(...hovered);
    }
    await page.mouse.move(0, 0);
    await openPlayer(page);
    if (cover !== "no cover") await whiteCoverShown();
    // The list opens over the graph; then, closed again, a focused link's detail.
    const summary = page.getByText(/^Links as a list/);
    await summary.click();
    const player = await neutralBadgeContrast(page, GENEALOGY_TEXT.player);
    await summary.click();
    await page.locator("#panel-genealogy g.link-targets line").first().focus();
    player.push(...(await neutralBadgeContrast(page, GENEALOGY_TEXT.detail, { keepFocus: true })));
    // Inferred badges, every relation and provenance line (sourced badges are amber, not
    // measured here).
    expect(dashboard.length).toBeGreaterThanOrEqual(8);
    // Two kinds and three relations in the legend, the summary, three links and the detail.
    expect(player.length).toBeGreaterThanOrEqual(10);
    for (const { text, ratio } of [...dashboard, ...player]) {
      expect(ratio, `"${text}"`).toBeGreaterThanOrEqual(4.5);
    }
  });
}

// Where each claim comes from: its verifier status, its sources and their tier, a conflict with
// the measurement, the credits, and the rejected claims (opened), in the Player's analysis panel.
const CLAIM_TEXT = [
  "[data-claim-kind] > div > span.text-chrome",
  "[data-claim-kind] > div > span.border-white\\/15",
  "[data-claim-kind] > p",
  "#panel-context section li > p",
  "#panel-context section > p.text-chrome",
  "#panel-context section > h2",
  "#panel-context > p.text-chrome",
  'section[aria-label="Rejected claims"] p',
  'section[aria-label="Rejected claims"] button',
].join(", ");

for (const cover of ["no cover", "a white cover"]) {
  test(`claim provenance and rejected-claim text meet 4.5:1 (${cover})`, async ({ page }) => {
    // Reaching the Player's claims takes most of this test on a loaded machine; measuring their
    // eighty-odd lines adds another 5–6 s.
    test.slow();
    const whiteCoverShown = await serveWhiteCover(page, "https://i.scdn.co/");
    const data = loadFixture("provenance");
    await useMockApi(page, cover === "no cover" ? data : withWhiteCover(data));
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Track");
    await openPlayer(page);
    if (cover !== "no cover") await whiteCoverShown();
    await page.getByRole("button", { name: /Rejected by the verifier/ }).click();
    const measured = await neutralBadgeContrast(page, CLAIM_TEXT);
    const texts = measured.map(({ text }) => text);
    for (const line of [
      "not checked",
      "Partly supported",
      "MusicBrainz · primary record",
      "1 cited source is not in this result",
      "Rejected by the verifier (6)",
      "Credits",
      "More claims",
      "1 fact is not shown",
    ]) {
      expect(
        texts.some((text) => text.includes(line)),
        line,
      ).toBe(true);
    }
    for (const { text, ratio } of measured) {
      expect(ratio, `"${text}"`).toBeGreaterThanOrEqual(4.5);
    }
  });
}

// Every badge says what it is by meaning (data-variant): the chips of how a value or a claim is
// known (measured, sourced, inferred, not confirmed, missing) and the warnings beside them. Their
// coloured words are measured too: on the Dashboard, the hero's value chips (with a white cover
// behind them, at rest and hovered) and the Fingerprint's estimate chips; in the Player, the
// claim, credit and warning chips.
for (const cover of ["no cover", "a white cover"]) {
  test(`the Dashboard's provenance chips meet 4.5:1, at rest and hovered (${cover})`, async ({
    page,
  }) => {
    const whiteCoverShown = await serveWhiteCover(page, "https://i.scdn.co/");
    const data = loadFixture("measured-v2");
    await useMockApi(page, cover === "no cover" ? data : withWhiteCover(data));
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Track");
    if (cover !== "no cover") await whiteCoverShown();
    const atRest = await neutralBadgeContrast(page, "[data-variant]", { coloured: true });
    // A chip that opens its provenance brightens under the pointer.
    await page.getByRole("button", { name: /^Measured: how BPM/ }).hover();
    const hovered = await neutralBadgeContrast(page, "button:hover [data-variant]", {
      keepHover: true,
      coloured: true,
    });
    const texts = atRest.map(({ text }) => text);
    for (const words of ["Measured", "Model estimate"]) {
      expect(texts, words).toContain(words);
    }
    expect(hovered.map(({ text }) => text)).toContain("Measured");
    for (const { text, ratio } of [...atRest, ...hovered]) {
      expect(ratio, `"${text}"`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test(`the Player's claim chips and warning badges meet 4.5:1 (${cover})`, async ({ page }) => {
    test.slow();
    const whiteCoverShown = await serveWhiteCover(page, "https://i.scdn.co/");
    const data = loadFixture("provenance");
    await useMockApi(page, cover === "no cover" ? data : withWhiteCover(data));
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Track");
    await openPlayer(page);
    if (cover !== "no cover") await whiteCoverShown();
    const measured = await neutralBadgeContrast(page, "#panel-context [data-variant]", {
      coloured: true,
    });
    const texts = measured.map(({ text }) => text);
    for (const words of ["Sourced", "Model inference", "Conflict", "Not supported"]) {
      expect(texts, words).toContain(words);
    }
    for (const { text, ratio } of measured) {
      expect(ratio, `"${text}"`).toBeGreaterThanOrEqual(4.5);
    }
  });
}

/**
 * The contrast of a focus ring, drawn as the keyboard shows it: the element is reached with Tab
 * (so :focus-visible applies), its ring (the widest unblurred box-shadow) and the ring offset
 * inside it are read, then the ring is hidden and the pixels under its band are screenshotted.
 * The ring is composited over each of those pixels and compared with that pixel (what lies
 * beside the ring) and with the offset colour when there is an offset. Returns the lowest ratio.
 */
async function focusRingContrast(page: Page, target: ReturnType<Page["locator"]>) {
  for (let presses = 0; !(await target.evaluate((el) => el === document.activeElement)); ) {
    presses += 1;
    if (presses > 60) throw new Error("Tab does not reach the element");
    await page.keyboard.press("Tab");
  }
  // Focused by the page itself (a picker takes the focus when it opens): away and back by Tab,
  // as a keyboard user would see it.
  if (!(await target.evaluate((el) => el.matches(":focus-visible")))) {
    await page.keyboard.press("Tab");
    await page.keyboard.press("Shift+Tab");
  }
  expect(await target.evaluate((el) => el.matches(":focus-visible"))).toBe(true);
  await target.scrollIntoViewIfNeeded();
  await animationsSettled(page);
  const read = await target.evaluate((element) => {
    const asRgba = (color: string) => {
      const context = new OffscreenCanvas(1, 1).getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.fillStyle = "rgb(1, 2, 3)";
      context.fillStyle = color;
      if (context.fillStyle === "#010203") throw new Error(`cannot read the colour ${color}`);
      context.clearRect(0, 0, 1, 1);
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };
    // Splits the computed box-shadow at its top-level commas (colours have commas of their own).
    const value = getComputedStyle(element).boxShadow;
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const char of value) {
      if (char === "(") depth += 1;
      if (char === ")") depth -= 1;
      if (char === "," && depth === 0) {
        parts.push(current.trim());
        current = "";
      } else current += char;
    }
    if (current.trim()) parts.push(current.trim());
    const shadows = parts
      .filter((part) => part !== "none")
      .map((part) => {
        const color = /^(rgba?|oklab|oklch|color|lab|lch)\([^)]*\)/.exec(part)?.[0] ?? "";
        const lengths = part
          .replace(color, "")
          .trim()
          .split(/\s+/)
          .filter((token) => token.endsWith("px"))
          .map(Number.parseFloat);
        return {
          color: asRgba(color),
          blur: lengths[2] ?? 0,
          spread: lengths[3] ?? 0,
          inset: part.includes("inset"),
        };
      })
      .filter((shadow) => !shadow.inset && shadow.blur === 0 && shadow.color.a > 0);
    const box = element.getBoundingClientRect();
    return { shadows, box: { x: box.x, y: box.y, width: box.width, height: box.height } };
  });
  const rings = [...read.shadows].sort((a, b) => b.spread - a.spread);
  const ring = rings[0];
  if (!ring) throw new Error("no focus ring");
  const offset = rings.find((shadow) => shadow.spread < ring.spread && shadow.color.a === 1);
  const inner = offset?.spread ?? 0;
  // The band the ring covers, outside the element's border box.
  await target.evaluate((element) => {
    (element as HTMLElement).style.setProperty("box-shadow", "none", "important");
  });
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("no viewport");
  const { x, y, width, height } = read.box;
  const clip = {
    x: Math.max(0, Math.floor(x - ring.spread)),
    y: Math.max(0, Math.floor(y - ring.spread)),
    width: Math.ceil(width + 2 * ring.spread),
    height: Math.ceil(height + 2 * ring.spread),
  };
  clip.width = Math.min(clip.width, viewport.width - clip.x);
  clip.height = Math.min(clip.height, viewport.height - clip.y);
  const png = await page.screenshot({ clip, animations: "disabled" });
  await target.evaluate((element) => (element as HTMLElement).style.removeProperty("box-shadow"));
  const band: Rgba[] = await page.evaluate(
    async ({ base64, box, clip, inner, outer }) => {
      const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      const scale = bitmap.width / clip.width;
      const found: Array<{ r: number; g: number; b: number; a: number }> = [];
      for (let py = 0; py < bitmap.height; py += 1) {
        for (let px = 0; px < bitmap.width; px += 1) {
          // Distance outside the border box, in CSS pixels, of this pixel's centre.
          const cx = clip.x + (px + 0.5) / scale;
          const cy = clip.y + (py + 0.5) / scale;
          const dx = Math.max(box.x - cx, cx - (box.x + box.width), 0);
          const dy = Math.max(box.y - cy, cy - (box.y + box.height), 0);
          const distance = Math.max(dx, dy);
          if (distance <= inner || distance >= outer) continue;
          const j = (py * bitmap.width + px) * 4;
          found.push({ r: data[j], g: data[j + 1], b: data[j + 2], a: 1 });
        }
      }
      return found;
    },
    { base64: png.toString("base64"), box: read.box, clip, inner, outer: ring.spread },
  );
  if (band.length === 0) throw new Error("no pixels under the focus ring");
  const ratio = (a: Rgba, b: Rgba) => {
    const [light, dark] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (light + 0.05) / (dark + 0.05);
  };
  let lowest = Number.POSITIVE_INFINITY;
  for (const pixel of band) {
    const drawn = over(ring.color, pixel);
    lowest = Math.min(lowest, ratio(drawn, pixel));
    if (offset) lowest = Math.min(lowest, ratio(drawn, offset.color));
  }
  return Math.round(lowest * 100) / 100;
}

test("the Dashboard's focus rings reach 3:1 against what is beside them", async ({ page }) => {
  test.slow();
  await useMockApi(page, loadFixture("full-result"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await analyzeAndOpenDashboard(page, "Bright Lines");
  const rings: Array<[string, number]> = [];
  // In the order Tab reaches them.
  rings.push([
    "the hero's BPM chip",
    await focusRingContrast(page, page.getByRole("button", { name: /^Measured.*: how BPM/ })),
  ]);
  rings.push([
    "View full analysis",
    await focusRingContrast(page, page.getByRole("button", { name: "View full analysis" })),
  ]);
  rings.push([
    "the hero's Spotify link",
    await focusRingContrast(page, page.getByRole("link", { name: "SPOTIFY" })),
  ]);
  rings.push([
    "a connected track",
    await focusRingContrast(page, page.getByRole("button", { name: /Older Record/ })),
  ]);
  rings.push([
    "the activity log's toggle",
    await focusRingContrast(page, page.getByRole("button", { name: /^Expand activity log/ })),
  ]);
  for (const [name, ratio] of rings) expect(ratio, name).toBeGreaterThanOrEqual(3);
});

test("the Player's focus rings reach 3:1 against what is beside them", async ({ page }) => {
  test.slow();
  const rings: Array<[string, number]> = [];
  await useMockApi(page, loadFixture("decrypt-after-model-unavailable"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await analyzeAndOpenDashboard(page, "Track");
  await openPlayer(page);
  rings.push([
    "More facts",
    await focusRingContrast(page, page.getByRole("button", { name: "More facts", exact: true })),
  ]);
  for (const [name, ratio] of rings) expect(ratio, name).toBeGreaterThanOrEqual(3);
});

test("the track picker's focus rings reach 3:1 against what is beside them", async ({ page }) => {
  await useMockApi(page, loadFixture("hitl"));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Hurt");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  const picker = page.getByRole("listbox", { name: "Is this the right track?" });
  await expect(picker).toBeVisible();
  const rings: Array<[string, number]> = [];
  rings.push(["a candidate", await focusRingContrast(page, picker.getByRole("option").first())]);
  rings.push([
    "Search again",
    await focusRingContrast(page, page.getByRole("button", { name: "Search again" })),
  ]);
  for (const [name, ratio] of rings) expect(ratio, name).toBeGreaterThanOrEqual(3);
});

test("the paused banner's focus rings reach 3:1 against what is beside them", async ({ page }) => {
  // Its recorded track, and "or try a different song" below it.
  await useMockApi(page, loadFixture("budget-paused"));
  await page.setViewportSize({ width: 1440, height: 900 });
  const rings: Array<[string, number]> = [];
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Some Other Song");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  const banner = page.getByRole("region", { name: "Live analysis paused" });
  await expect(banner).toBeVisible();
  rings.push([
    "the paused banner's recorded track",
    await focusRingContrast(page, banner.getByRole("button", { name: /Bright Lines/ })),
  ]);
  rings.push([
    "or try a different song",
    await focusRingContrast(page, page.getByRole("button", { name: "or try a different song" })),
  ]);
  for (const [name, ratio] of rings) expect(ratio, name).toBeGreaterThanOrEqual(3);
});

/**
 * The contrast of each song section's boundary against what is drawn behind the bar: its border
 * (when it has one) or its fill, whichever stands out more, composited over the brightest pixel
 * behind the section (the bar hidden). Sections are focusable, so WCAG 1.4.11 asks 3:1.
 */
async function sectionBoundaries(page: Page) {
  const bar = page.getByRole("group", { name: "Song structure" }).getByRole("list").first();
  await bar.scrollIntoViewIfNeeded();
  await backgroundSettled(page);
  const sections = await bar.getByRole("listitem").evaluateAll((items) => {
    const asRgba = (color: string) => {
      const context = new OffscreenCanvas(1, 1).getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
      return { r, g, b, a: a / 255 };
    };
    return items.map((item) => {
      const style = getComputedStyle(item);
      const box = item.getBoundingClientRect();
      return {
        label: item.getAttribute("aria-label") ?? "",
        border: Number.parseFloat(style.borderTopWidth) >= 1 ? asRgba(style.borderTopColor) : null,
        fill: asRgba(style.backgroundColor),
        box: { x: box.x, y: box.y, width: box.width, height: box.height },
      };
    });
  });
  // A handle: once hidden, the bar is no longer found by its role.
  const handle = await bar.elementHandle();
  if (!handle) throw new Error("no song structure bar");
  await handle.evaluate((element) => {
    (element as HTMLElement).style.visibility = "hidden";
  });
  const result: Array<{ label: string; ratio: number }> = [];
  for (const section of sections) {
    const { x, y, width, height } = section.box;
    const clip = {
      x: Math.floor(x),
      y: Math.floor(y),
      width: Math.max(1, Math.ceil(width)),
      height: Math.max(1, Math.ceil(height)),
    };
    const png = await page.screenshot({ clip, animations: "disabled" });
    const behind: Rgba = await page.evaluate(async (base64) => {
      const blob = await (await fetch(`data:image/png;base64,${base64}`)).blob();
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.drawImage(bitmap, 0, 0);
      const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
      let best = { r: 0, g: 0, b: 0, a: 1 };
      for (let j = 0; j < data.length; j += 4) {
        if (data[j] + data[j + 1] + data[j + 2] > best.r + best.g + best.b) {
          best = { r: data[j], g: data[j + 1], b: data[j + 2], a: 1 };
        }
      }
      return best;
    }, png.toString("base64"));
    const ratio = (colour: Rgba) => {
      const drawn = over(colour, behind);
      const [light, dark] = [luminance(drawn), luminance(behind)].sort((p, q) => q - p);
      return (light + 0.05) / (dark + 0.05);
    };
    const best = Math.max(ratio(section.fill), section.border ? ratio(section.border) : 0);
    result.push({ label: section.label, ratio: Math.round(best * 100) / 100 });
  }
  await handle.evaluate((element) => {
    (element as HTMLElement).style.removeProperty("visibility");
  });
  return result;
}

for (const fixture of ["full-result", "missing-states"]) {
  test(`song sections stand out 3:1 against the page (${fixture})`, async ({ page }) => {
    await useMockApi(page, loadFixture(fixture));
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Track");
    await openPlayer(page);
    const sections = await sectionBoundaries(page);
    expect(sections.length).toBeGreaterThan(1);
    for (const { label, ratio } of sections) expect(ratio, label).toBeGreaterThanOrEqual(3);
  });
}

/**
 * The provenance fixture with a "sample" fact whose text names an entity of every colour, and
 * whose claim is sourced, so its entities link to the cited source.
 */
function withEntities() {
  const fixture = loadFixture("provenance");
  const complete = fixture.streams["/api/analyze/stream"].find(
    (event: { type: string }) => event.type === "complete",
  );
  const entities = [
    ["Old Record", "sample"],
    ["tape echo", "technique"],
    ["Some Album", "album"],
    ["Ada Example", "artist"],
    ["Juno", "synth"],
    ["Ben Example", "producer"],
    ["1999", "year"],
  ];
  complete.data.factoids[0] = {
    ...complete.data.factoids[0],
    type: "sample",
    content: `Old Record, tape echo, Some Album, Ada Example, Juno, Ben Example, 1999.`,
    entities: entities.map(([text, type], i) => ({ id: `e${i}`, text, type })),
    claimId: "c-entities",
  };
  complete.data.claims.push({
    id: "c-entities",
    text: "Old Record is sampled.",
    about: "sample",
    kind: "sourced",
    origin: "model",
    evidenceIds: ["ev-review"],
    verdict: "supported",
    verdictReason: null,
    numericCheck: "n/a",
  });
  return { fixture, entities: entities.map(([text]) => text) };
}

test("a fact's entity chips and type label meet 4.5:1, at rest and hovered", async ({ page }) => {
  const { fixture, entities } = withEntities();
  await useMockApi(page, fixture);
  await page.setViewportSize({ width: 1440, height: 900 });
  await analyzeAndOpenDashboard(page, "Track");
  await openPlayer(page);
  const chip = (text: string) => `#panel-context a[data-entity-type][aria-label^="${text} ("]`;
  const atRest = await neutralBadgeContrast(
    page,
    [...entities.map(chip), "#panel-context span.ml-auto.rounded-full"].join(", "),
    { coloured: true },
  );
  expect(atRest.map(({ text }) => text)).toEqual(expect.arrayContaining([...entities, "SAMPLE"]));
  const hovered = [];
  for (const text of entities) {
    await page.locator(chip(text)).hover();
    hovered.push(
      ...(await neutralBadgeContrast(page, chip(text), { keepHover: true, coloured: true })),
    );
  }
  expect(hovered.map(({ text }) => text)).toEqual(entities);
  for (const { text, ratio } of atRest)
    expect(ratio, `"${text}" at rest`).toBeGreaterThanOrEqual(4.5);
  for (const { text, ratio } of hovered)
    expect(ratio, `"${text}" hovered`).toBeGreaterThanOrEqual(4.5);
});

// The album cover's words: "Cover not available" in its frame, or the Cover Art Archive credit
// under a cover from the archive (a white one, the worst case behind the translucent layers).
for (const cover of ["no cover", "a white archive cover"]) {
  test(`album cover text meets 4.5:1 on the Dashboard and the Player (${cover})`, async ({
    page,
  }) => {
    const whiteCoverShown = await serveWhiteCover(page, "https://coverartarchive.org/");
    const data = loadFixture("recorded-cover");
    if (cover === "no cover") {
      const complete = data.streams["/api/analyze/stream"].find(
        (event: { type: string }) => event.type === "complete",
      );
      complete.data.coverUrl = "";
    }
    await useMockApi(page, data);
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Track");
    if (cover !== "no cover") await whiteCoverShown();
    const dashboard = await neutralBadgeContrast(page, "[data-cover-text]");
    await openPlayer(page);
    if (cover !== "no cover") await whiteCoverShown();
    await page.waitForTimeout(500);
    const player = await neutralBadgeContrast(page, "[data-cover-text]");
    const expected = cover === "no cover" ? "Cover not available" : "Cover: Cover Art Archive";
    for (const measured of [dashboard, player]) {
      // The credit's "(opens in a new tab)" is for screen readers only.
      expect(measured.map(({ text }) => text).filter((text) => !text.startsWith("("))).toEqual([
        expected,
      ]);
    }
    for (const { text, ratio } of [...dashboard, ...player]) {
      expect(ratio, `"${text}"`).toBeGreaterThanOrEqual(4.5);
    }
  });
}
