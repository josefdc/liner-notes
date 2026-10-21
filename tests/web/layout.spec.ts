import { expect, type Locator, test } from "@playwright/test";
import { analyzeAndOpenDashboard, loadFixture, useMockApi } from "./mock";

// The Dashboard's spacing comes from token classes such as `p-(--space-md)`. Written in the
// Tailwind v3 form (`p-[--space-md]`) they compile to invalid CSS and the padding is dropped, so
// the heading sits on the window edge. At phone width the page is taller than the window: the
// hero must keep its full height (it clips what overflows it) and the panels below must not
// collapse onto the Spotify button. These checks read computed styles and positions, not pixels.
const fixture = loadFixture("missing-states");
// Has a connected track, whose card shows the "CLICK TO ANALYZE" overlay on hover.
const withConnections = loadFixture("full-result");

// Animations end at once, so positions are final when they are read.
test.use({ reducedMotion: "reduce" });

const padding = (locator: Locator) =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      top: style.paddingTop,
      right: style.paddingRight,
      bottom: style.paddingBottom,
      left: style.paddingLeft,
    };
  });

for (const { width, height, page: pagePadding, hero } of [
  // md and up: --space-2xl (48px) around the page (40px below) and inside the hero.
  { width: 1440, height: 900, page: ["48px", "48px", "40px", "48px"], hero: "48px" },
  // Phone: --space-md (16px) around the page (80px below, above the fixed bar), --space-xl (32px)
  // inside the hero.
  { width: 390, height: 844, page: ["16px", "16px", "80px", "16px"], hero: "32px" },
]) {
  test(`the Dashboard keeps its padding at ${width} px`, async ({ page }) => {
    await useMockApi(page, fixture);
    await page.setViewportSize({ width, height });
    await analyzeAndOpenDashboard(page, "Quiet Signal");

    const heading = page.getByRole("heading", { name: "Command Center" });
    const dashboard = heading.locator("xpath=ancestor::header[1]/..");
    const [top, right, bottom, left] = pagePadding;
    expect(await padding(dashboard)).toEqual({ top, right, bottom, left });

    // The heading is inset from the window edge by that padding.
    const headingBox = await heading.boundingBox();
    expect(headingBox?.x).toBeGreaterThanOrEqual(Number.parseFloat(left));

    const heroSection = page.locator("section").filter({ has: page.getByText("NOW PLAYING") });
    expect(await padding(heroSection)).toEqual({
      top: hero,
      right: hero,
      bottom: hero,
      left: hero,
    });
  });

  test(`the Spotify button is not covered at ${width} px`, async ({ page }) => {
    await useMockApi(page, fixture);
    await page.setViewportSize({ width, height });
    await analyzeAndOpenDashboard(page, "Quiet Signal");

    const heading = page.getByRole("heading", { name: "Command Center" });
    const dashboard = heading.locator("xpath=ancestor::header[1]/..");
    const spotify = page.getByRole("link", { name: "SPOTIFY" });
    const hero = page.locator("section").filter({ has: spotify });

    // The hero shows all of its content: nothing is cut off by its overflow-hidden box.
    const heroSize = await hero.evaluate((element) => [element.scrollHeight, element.clientHeight]);
    expect(heroSize[0]).toBeLessThanOrEqual(heroSize[1]);

    // Scroll the page (not the hero, which a plain scrollIntoView would also scroll) so that the
    // button is in the middle of the window.
    await dashboard.evaluate((box) => {
      const link = box.querySelector('a[href*="open.spotify.com"]');
      if (!link) return;
      const offset = link.getBoundingClientRect().top - box.getBoundingClientRect().top;
      box.scrollTop += offset - box.clientHeight / 2;
    });
    const link = await spotify.boundingBox();
    const panel = await page.getByRole("region", { name: "Sonic Fingerprint" }).boundingBox();
    if (!link || !panel) throw new Error("the Spotify button or the fingerprint panel is missing");
    expect(panel.y).toBeGreaterThanOrEqual(link.y + link.height);

    // What is drawn at the button's centre and inner corners is the button itself.
    const points = [
      [link.x + link.width / 2, link.y + link.height / 2],
      [link.x + 2, link.y + 2],
      [link.x + link.width - 2, link.y + link.height - 2],
    ];
    for (const [x, y] of points) {
      const onTop = await spotify.evaluate(
        (element, [px, py]) => {
          const hit = document.elementFromPoint(px, py);
          return hit !== null && element.contains(hit);
        },
        [x, y],
      );
      expect(onTop, `the Spotify button is on top at (${x}, ${y})`).toBe(true);
    }
  });

  test(`the card's CLICK TO ANALYZE label stays on one line at ${width} px`, async ({ page }) => {
    await useMockApi(page, withConnections);
    await page.setViewportSize({ width, height });
    await analyzeAndOpenDashboard(page, "Bright Lines");

    await page.getByRole("button", { name: /Older Record/ }).hover();
    const label = page.getByText("CLICK TO ANALYZE", { exact: true });
    await expect(label).toBeVisible();
    const lines = await label.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      // One rectangle per line box the text occupies.
      return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    });
    expect(lines).toBe(1);
  });
}
