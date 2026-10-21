import { expect, type Page, test } from "@playwright/test";
import { analyzeAndOpenDashboard, loadFixture, openPlayer, useMockApi } from "./mock";

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
    // Measure the card at rest: away from the pointer (left over from the last click) and from
    // the window's edges.
    await page.mouse.move(0, 0);
    await card.evaluate((element) => {
      const page = element.closest(".overflow-y-auto");
      if (page) page.scrollTop += element.getBoundingClientRect().top - page.clientHeight / 4;
    });
    await page.waitForTimeout(800); // the card's fade-in has ended
    const box = await card.boundingBox();
    if (!box) throw new Error("no connected-track card");
    const x = box.x + box.width / 2;
    const y = box.y + box.height - 2;
    await page.mouse.move(x, y);
    const label = page.getByText("CLICK TO ANALYZE", { exact: true });
    await expect(label).toBeVisible();
    // The lift (4 px) must not move the card out from under the pointer: nudge the pointer
    // sideways, as a resting hand does, and check the hover each time.
    const samples: boolean[] = [];
    for (let i = 0; i < 12; i += 1) {
      await page.mouse.move(x + (i % 2), y);
      await page.waitForTimeout(50);
      samples.push(await label.isVisible());
    }
    expect(samples).toEqual(Array(12).fill(true));
  });
});

/** Small badges (text-chrome) and their height, in document order. */
const smallBadges = (page: Page) =>
  page.locator("span.text-chrome").evaluateAll((elements) =>
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

/** WCAG contrast of each neutral badge's text against its composited background. */
const neutralBadgeContrast = (page: Page) =>
  page.locator("span.border-white\\/15").evaluateAll((elements) => {
    type Rgba = { r: number; g: number; b: number; a: number };
    const parse = (value: string): Rgba | null => {
      const match = /rgba?\(([^)]+)\)/.exec(value);
      if (!match) return null;
      const [r, g, b, a = 1] = match[1]
        .split(/[\s,/]+/)
        .filter(Boolean)
        .map(Number);
      return { r, g, b, a };
    };
    const over = (top: Rgba, bottom: Rgba): Rgba => ({
      r: top.r * top.a + bottom.r * (1 - top.a),
      g: top.g * top.a + bottom.g * (1 - top.a),
      b: top.b * top.a + bottom.b * (1 - top.a),
      a: 1,
    });
    const channel = (value: number) => {
      const v = value / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    const luminance = (c: Rgba) =>
      0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
    const result: Array<{ text: string; ratio: number }> = [];
    for (const badge of elements) {
      const chain: Element[] = [];
      for (let node: Element | null = badge; node; node = node.parentElement) chain.unshift(node);
      let background: Rgba = { r: 255, g: 255, b: 255, a: 1 };
      for (const node of chain) {
        const color = parse(getComputedStyle(node).backgroundColor);
        if (color && color.a > 0) background = over(color, background);
      }
      // Every text node inside the badge, with the colour it is drawn in.
      const walker = document.createTreeWalker(badge, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!text.textContent?.trim() || !text.parentElement) continue;
        const color = parse(getComputedStyle(text.parentElement).color);
        if (!color) continue;
        // Coloured values (cyan, amber, pink) are checked by their own variants; this is the grey.
        if (!(color.r === color.g && color.g === color.b)) continue;
        const foreground = over(color, background);
        const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
        result.push({
          text: text.textContent.trim(),
          ratio: Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100,
        });
      }
    }
    return result;
  });

for (const fixture of ["full-result", "missing-states"]) {
  test(`neutral badge text meets 4.5:1 on the Dashboard and the Player (${fixture})`, async ({
    page,
  }) => {
    await useMockApi(page, fixture === "full-result" ? explicitResult() : loadFixture(fixture));
    await analyzeAndOpenDashboard(page, "Track");
    const dashboard = await neutralBadgeContrast(page);
    await openPlayer(page);
    const player = await neutralBadgeContrast(page);
    expect(dashboard.length).toBeGreaterThan(0);
    expect(player.length).toBeGreaterThan(0);
    for (const { text, ratio } of [...dashboard, ...player]) {
      expect(ratio, `"${text}"`).toBeGreaterThanOrEqual(4.5);
    }
  });
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
