import { expect, type Page, test } from "@playwright/test";
import { hoverCard } from "./hover";
import {
  analyzeAndOpenDashboard,
  animationsSettled,
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
  const button = page.getByRole("button", { name: "VIEW FULL ANALYSIS" });
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
    await expect(card.getByText("CLICK TO ANALYZE", { exact: true })).toBeVisible();
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

test("small badges have one height wherever they sit", async ({ page }) => {
  await useMockApi(page, explicitResult());
  await analyzeAndOpenDashboard(page, "Bright Lines");
  const badges = await smallBadges(page);
  expect(badges.map((badge) => badge.text)).toContain("EXPLICIT");
  for (const badge of badges) expect(badge, badge.text).toMatchObject({ height: 24 });
});

// An all-white album cover, the worst case behind the translucent hero and Player backgrounds.
const WHITE_COVER = "https://i.scdn.co/image/white-cover";
const WHITE_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="640"><rect width="100%" height="100%" fill="#fff"/></svg>';

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
 * WCAG contrast of the grey text in each neutral badge, against what the page actually draws
 * behind it: the badge's text and icons are hidden, the area inside its border is screenshotted
 * (cover image, blur and every translucent layer included), and its brightest pixel is the
 * background. Coloured values inside a badge (cyan, amber, pink) are not measured here.
 */
async function neutralBadgeContrast(page: Page, selector = "span.border-white\\/15") {
  await page.addStyleTag({
    content:
      "[data-measuring],[data-measuring] *{color:transparent!important;text-decoration-color:transparent!important;text-shadow:none!important;transition:none!important}[data-measuring] svg{visibility:hidden!important}",
  });
  const badges = page.locator(selector);
  const result: Array<{ text: string; ratio: number }> = [];
  for (let i = 0; i < (await badges.count()); i += 1) {
    const badge = badges.nth(i);
    await badge.scrollIntoViewIfNeeded();
    const texts = await badge.evaluate((element) => {
      const found: Array<{ text: string; color: string }> = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent?.trim() || !text.parentElement) continue;
        found.push({
          text: text.textContent.trim(),
          color: getComputedStyle(text.parentElement).color,
        });
      }
      element.setAttribute("data-measuring", "");
      return found;
    });
    const box = await badge.boundingBox();
    if (!box) throw new Error("a neutral badge has no box");
    const png = await page.screenshot({
      clip: { x: box.x + 2, y: box.y + 2, width: box.width - 4, height: box.height - 4 },
      animations: "disabled",
    });
    await badge.evaluate((element) => element.removeAttribute("data-measuring"));
    const background: Rgba = await page.evaluate(async (base64) => {
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
    for (const { text, color } of texts) {
      const match = /rgba?\(([^)]+)\)/.exec(color);
      if (!match) continue;
      const [r, g, b, a = 1] = match[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      if (!(r === g && g === b)) continue;
      const foreground = over({ r, g, b, a }, background);
      const [light, dark] = [luminance(foreground), luminance(background)].sort((x, y) => y - x);
      result.push({ text, ratio: Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100 });
    }
  }
  return result;
}

for (const fixture of ["full-result", "missing-states"]) {
  for (const cover of ["no cover", "a white cover"]) {
    test(`neutral badge text meets 4.5:1 on the Dashboard and the Player (${fixture}, ${cover})`, async ({
      page,
    }) => {
      await page.route("https://i.scdn.co/**", (route) =>
        route.fulfill({ contentType: "image/svg+xml", body: WHITE_SVG }),
      );
      const data = fixture === "full-result" ? explicitResult() : loadFixture(fixture);
      await useMockApi(page, cover === "no cover" ? data : withWhiteCover(data));
      await page.setViewportSize({ width: 1440, height: 900 });
      await analyzeAndOpenDashboard(page, "Track");
      const dashboard = await neutralBadgeContrast(page);
      await openPlayer(page);
      // The Player's background cover fades in.
      await page.waitForTimeout(500);
      const player = await neutralBadgeContrast(page);
      expect(dashboard.length).toBeGreaterThan(0);
      expect(player.length).toBeGreaterThan(0);
      for (const { text, ratio } of [...dashboard, ...player]) {
        expect(ratio, `"${text}"`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
}

test("the Dashboard skeleton has the Dashboard's padding and gaps", async ({ page }) => {
  await useMockApi(page, loadFixture("full-result"));
  await page.setViewportSize({ width: 1440, height: 900 });
  // Hold the Dashboard module so its loading skeleton stays on screen.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(/\/src\/components\/Dashboard\.tsx/, async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Bright Lines");
  await page.getByRole("button", { name: "ANALYZE_SONG" }).click();
  await page.getByRole("button", { name: "PROCEED TO COMMAND CENTER" }).click();

  const skeleton = page.locator("div.animate-progress-shimmer").first().locator("xpath=../../..");
  await expect(skeleton).toBeVisible();
  const spacing = await skeleton.evaluate((element) => {
    const style = getComputedStyle(element);
    return { padding: style.padding, gap: style.rowGap };
  });
  release();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  const dashboard = page
    .getByRole("heading", { name: "Command Center" })
    .locator("xpath=ancestor::header[1]/..");
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
      await page.route("https://i.scdn.co/**", (route) =>
        route.fulfill({ contentType: "image/svg+xml", body: WHITE_SVG }),
      );
      const data = loadFixture(fixture);
      await useMockApi(page, cover === "no cover" ? data : withWhiteCover(data));
      await page.setViewportSize({ width: 1440, height: 900 });
      await analyzeAndOpenDashboard(page, "Track");
      const dashboard = await neutralBadgeContrast(page, PROVENANCE_TEXT);
      await openPlayer(page);
      await page.waitForTimeout(500);
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
    await page.route("https://i.scdn.co/**", (route) =>
      route.fulfill({ contentType: "image/svg+xml", body: WHITE_SVG }),
    );
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
    const dashboard = await neutralBadgeContrast(page, GENEALOGY_TEXT.dashboard);
    // A hovered card lightens behind its badge.
    const inferred = page
      .getByRole("button")
      .filter({ has: page.locator('[data-link-kind="inferred"]') });
    await inferred.first().hover();
    await animationsSettled(page);
    dashboard.push(...(await neutralBadgeContrast(page, 'span[data-link-kind="inferred"]')));
    await page.mouse.move(0, 0);
    await openPlayer(page);
    await page.waitForTimeout(500);
    // The list opens over the graph; then, closed again, a focused link's detail.
    const summary = page.getByText(/^Links as a list/);
    await summary.click();
    const player = await neutralBadgeContrast(page, GENEALOGY_TEXT.player);
    await summary.click();
    await page.locator("#panel-genealogy g.link-targets line").first().focus();
    player.push(...(await neutralBadgeContrast(page, GENEALOGY_TEXT.detail)));
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
  "#panel-context section > h4",
  "#panel-context > p.text-chrome",
  'section[aria-label="Rejected claims"] p',
  'section[aria-label="Rejected claims"] button',
].join(", ");

for (const cover of ["no cover", "a white cover"]) {
  test(`claim provenance and rejected-claim text meet 4.5:1 (${cover})`, async ({ page }) => {
    // Some fifty lines, each screenshotted on its own.
    test.slow();
    await page.route("https://i.scdn.co/**", (route) =>
      route.fulfill({ contentType: "image/svg+xml", body: WHITE_SVG }),
    );
    const data = loadFixture("provenance");
    await useMockApi(page, cover === "no cover" ? data : withWhiteCover(data));
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Track");
    await openPlayer(page);
    await page.getByRole("button", { name: /Rejected by the verifier/ }).click();
    await page.waitForTimeout(500);
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
