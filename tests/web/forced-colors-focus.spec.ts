import { expect, type Page, test } from "@playwright/test";
import { analyzeAndOpenDashboard, loadFixture, openPlayer, useMockApi } from "./mock";

// In forced-colors mode (Windows High Contrast) the browser drops box-shadow, so the
// `focus-visible:ring-*` focus rings disappear; only an outline is left to show where the
// keyboard focus is. Every control the keyboard reaches on the main screens must keep one:
// a computed outline style other than `none` and a width above zero. `outline-none` takes it
// away; `outline-hidden` keeps a transparent outline that forced-colors mode draws.

test.use({ forcedColors: "active", reducedMotion: "reduce" });

const fullResult = loadFixture("full-result");

type Stop = {
  what: string;
  outlineStyle: string;
  outlineWidth: string;
  focusVisible: boolean;
  role: string | null;
  chip: boolean;
};

/** The focused element's outline, or null when the focus is on the page itself. */
function focusedStop(page: Page): Promise<Stop | null> {
  return page.evaluate(() => {
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
    return {
      what: `${element.tagName.toLowerCase()} "${name}"`,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      focusVisible: element.matches(":focus-visible"),
      role: element.getAttribute("role"),
      chip: element.querySelector("[data-provenance]") !== null,
    };
  });
}

/**
 * Presses Tab until the focus comes back to a control it has been on (or `max` presses), and
 * returns each control it was on. Past the last control the focus may leave the page for a
 * press; the next one brings it back to the first.
 */
async function tabThrough(page: Page, max: number): Promise<Stop[]> {
  await page.evaluate(() => {
    (window as unknown as { __tabSeen: WeakSet<Element> }).__tabSeen = new WeakSet();
  });
  const stops: Stop[] = [];
  let left = 0;
  for (let i = 0; i < max; i += 1) {
    await page.keyboard.press("Tab");
    const where = await page.evaluate(() => {
      const seen = (window as unknown as { __tabSeen: WeakSet<Element> }).__tabSeen;
      const element = document.activeElement;
      if (!element || element === document.body) return "page";
      if (seen.has(element)) return "seen";
      seen.add(element);
      return "new";
    });
    if (where === "seen") break;
    if (where === "page") {
      left += 1;
      if (left > 1) break;
      continue;
    }
    const stop = await focusedStop(page);
    if (stop) stops.push(stop);
  }
  return stops;
}

/** The stops without a visible outline, as "<element>: <style> <width>". */
function withoutOutline(stops: Stop[]): string[] {
  return stops
    .filter((stop) => stop.outlineStyle === "none" || !(Number.parseFloat(stop.outlineWidth) > 0))
    .map((stop) => `${stop.what}: ${stop.outlineStyle} ${stop.outlineWidth}`);
}

function expectOutlines(stops: Stop[], screen: string) {
  expect(stops.length, `the keyboard reaches controls on ${screen}`).toBeGreaterThan(0);
  expect(
    stops.filter((stop) => !stop.focusVisible).map((stop) => stop.what),
    `every control the keyboard reaches on ${screen} matches :focus-visible`,
  ).toEqual([]);
  expect.soft(withoutOutline(stops), `controls on ${screen} without a focus outline`).toEqual([]);
}

test("every control the keyboard reaches keeps a focus outline in forced-colors mode", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, fullResult);
  await page.goto("/");
  expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);

  // The landing screen: the search box and the links and buttons around it.
  const landing = await tabThrough(page, 60);
  expect(
    landing.some((stop) => stop.role === "combobox"),
    "the search box is among the landing screen's stops",
  ).toBe(true);
  expectOutlines(landing, "the landing screen");

  // The Dashboard, its provenance chips among its controls.
  await analyzeAndOpenDashboard(page, "Bright Lines", { reload: false });
  const dashboard = await tabThrough(page, 150);
  expect(
    dashboard.some((stop) => stop.chip),
    "a provenance chip is among the Dashboard's stops",
  ).toBe(true);
  expectOutlines(dashboard, "the Dashboard");

  // The Player: its controls, the connections map's stop, its links.
  await openPlayer(page);
  const player = await tabThrough(page, 200);
  expectOutlines(player, "the Player");
});

test("the map's cards keep a focus outline in forced-colors mode", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  // A result whose map is drawn as cards (the full result's is a single row of buttons).
  await useMockApi(page, loadFixture("genealogy-kinds"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);

  // The map's one tab stop, reached with the keyboard, then the arrow keys from card to card.
  await expect(page.locator("g.nodes > g").first()).toBeVisible();
  const stops: Stop[] = [];
  const onMap = () =>
    page.evaluate(() => document.activeElement?.closest("g.nodes, g.link-targets") != null);
  for (let i = 0; i < 200 && !(await onMap()); i += 1) {
    await page.keyboard.press("Tab");
  }
  expect(await onMap(), "Tab reaches the map").toBe(true);
  const first = await focusedStop(page);
  if (first) stops.push(first);
  for (const key of ["ArrowRight", "ArrowRight", "ArrowDown", "ArrowLeft"]) {
    await page.keyboard.press(key);
    const stop = await focusedStop(page);
    if (stop) stops.push(stop);
  }
  const cards = stops.filter((stop) => stop.what.startsWith("g "));
  expect(
    cards.length,
    `the arrow keys reach cards (${stops.map((stop) => stop.what).join(", ")})`,
  ).toBeGreaterThan(1);
  expectOutlines(stops, "the map");
});

test("the Player's phone tabs keep a focus outline in forced-colors mode", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await useMockApi(page, fullResult);
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);

  const tab = page.getByRole("tab", { selected: true });
  await expect(tab).toBeVisible();
  let reached = false;
  for (let i = 0; i < 200 && !reached; i += 1) {
    await page.keyboard.press("Tab");
    reached = await tab.evaluate((element) => element === document.activeElement);
  }
  expect(reached, "Tab reaches the open tab").toBe(true);
  const stops: Stop[] = [];
  for (const key of ["", "ArrowRight", "ArrowRight", "Home"]) {
    if (key) await page.keyboard.press(key);
    const stop = await focusedStop(page);
    if (stop) stops.push(stop);
  }
  expect(stops.every((stop) => stop.role === "tab")).toBe(true);
  expectOutlines(stops, "the Player's tabs");
});
