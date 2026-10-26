import { expect, type Page, test } from "@playwright/test";
import { animationsSettled, apiRequests, loadFixture, useMockApi } from "./mock";

// The search box is a labelled combobox (WAI-ARIA 1.2): the focus stays in the box while the
// arrow keys move through its suggestions, which aria-activedescendant names.
const candidates = loadFixture("hitl").streams["/api/analyze/stream"].find(
  (event: { type: string }) => event.type === "interrupt",
).candidates as Array<{ id: string; title: string; artist: string }>;
const HINT = "Arrow keys to move, Enter to analyze, Esc to close";

const box = (page: Page) => page.getByRole("combobox", { name: "Song title and artist" });

/** Types into the box and waits for its suggestions. */
async function openSuggestions(page: Page) {
  await useMockApi(page, { suggestions: candidates, streams: {} });
  await page.goto("/");
  await box(page).fill("Hurt");
  await expect(page.getByRole("option")).toHaveCount(candidates.length);
}

const suggestRequests = async (page: Page) =>
  (await apiRequests(page)).filter((entry) => entry === "fetch /api/search/suggest").length;

test("the search box is a combobox with a name, collapsed until it has suggestions", async ({
  page,
}) => {
  await useMockApi(page, { suggestions: candidates, streams: {} });
  await page.goto("/");

  const input = box(page);
  await expect(input).toBeVisible();
  await expect(page.getByLabel("Song title and artist")).toHaveCount(1);
  await expect(input).toHaveAttribute("aria-autocomplete", "list");
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(input).not.toHaveAttribute("aria-activedescendant");

  await input.fill("Hurt");
  const listbox = page.getByRole("listbox");
  await expect(listbox).toBeVisible();
  await expect(input).toHaveAttribute("aria-expanded", "true");
  await expect(input).toHaveAttribute("aria-controls", (await listbox.getAttribute("id")) ?? "");
});

test("aria-activedescendant follows the highlight while the focus stays in the box", async ({
  page,
}) => {
  await openSuggestions(page);
  const input = box(page);
  const options = page.getByRole("option");

  const ids = await options.evaluateAll((elements) => elements.map((element) => element.id));
  expect(ids.every((id) => id !== "")).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);

  const expectHighlight = async (index: number) => {
    await expect(input).toHaveAttribute("aria-activedescendant", ids[index]);
    await expect(options.nth(index)).toHaveAttribute("aria-selected", "true");
    await expect(page.locator('[role="option"][aria-selected="true"]')).toHaveCount(1);
    await expect(input).toBeFocused();
  };

  await page.keyboard.press("ArrowDown");
  await expectHighlight(0);
  await page.keyboard.press("ArrowDown");
  await expectHighlight(1);
  await page.keyboard.press("ArrowUp");
  await expectHighlight(0);
  // Both ends wrap.
  await page.keyboard.press("ArrowUp");
  await expectHighlight(candidates.length - 1);
  await page.keyboard.press("ArrowDown");
  await expectHighlight(0);
});

test("the keyboard hint is beside the listbox, not one of its options", async ({ page }) => {
  await openSuggestions(page);
  const listbox = page.getByRole("listbox");

  await expect(page.getByText(HINT)).toBeVisible();
  await expect(listbox.getByText(HINT)).toHaveCount(0);
  // Everything in the listbox is an option.
  const roles = await listbox.evaluate((element) =>
    Array.from(element.children, (child) => child.getAttribute("role")),
  );
  expect(roles).toEqual(candidates.map(() => "option"));
});

test("a suggestion taken with Tab fills the box and the list stays closed", async ({ page }) => {
  await openSuggestions(page);
  const input = box(page);
  const requestsBefore = await suggestRequests(page);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Tab");
  await expect(input).toHaveValue(`${candidates[0].title} ${candidates[0].artist}`);
  await expect(input).toBeFocused();
  await expect(page.getByRole("listbox")).toHaveCount(0);

  // Well past the pause after typing that asks for suggestions.
  await page.waitForTimeout(1000);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(input).not.toHaveAttribute("aria-activedescendant");
  expect(await suggestRequests(page)).toBe(requestsBefore);
  // Nothing was analysed: Tab only fills the box.
  expect((await apiRequests(page)).filter((entry) => entry.startsWith("stream "))).toEqual([]);
});

test("Escape closes the list and keeps the text; an arrow key opens it again", async ({ page }) => {
  await openSuggestions(page);
  const input = box(page);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(input).toHaveAttribute("aria-expanded", "false");
  await expect(input).not.toHaveAttribute("aria-activedescendant");
  await expect(input).toHaveValue("Hurt");

  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    (await page.getByRole("option").first().getAttribute("id")) ?? "",
  );
});

test("the open list is opaque over the Analyze button", async ({ page }) => {
  await openSuggestions(page);
  await animationsSettled(page);
  const listbox = page.getByRole("listbox");
  const button = page.getByRole("button", { name: "Analyze", exact: true });

  // The button sits under the list.
  const buttonBox = await button.boundingBox();
  if (!buttonBox) throw new Error("the Analyze button has no box");
  const covered = await listbox.evaluate(
    (element, point) => {
      const popup = element.parentElement;
      const top = document.elementFromPoint(point.x, point.y);
      return !!popup && !!top && popup.contains(top);
    },
    { x: buttonBox.x + buttonBox.width / 2, y: buttonBox.y + buttonBox.height / 2 },
  );
  expect(covered).toBe(true);

  // The first background between the options and the page is fully opaque, and so is
  // everything around it.
  const alpha = await listbox.evaluate((element) => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (getComputedStyle(node).opacity !== "1") return 0;
    }
    for (let node: Element | null = element; node; node = node.parentElement) {
      const colour = getComputedStyle(node).backgroundColor;
      const parts = colour.match(/[\d.]+/g)?.map(Number) ?? [];
      const a = parts.length === 4 ? parts[3] : 1;
      if (colour !== "transparent" && a > 0) return a;
    }
    return 0;
  });
  expect(alpha).toBe(1);
});

test("Tab with nothing highlighted closes the list and moves to Analyze, in view", async ({
  page,
}) => {
  // Five suggestions at a 20 px default font: the list is taller than its box and scrolls.
  const five = [...candidates, ...candidates.slice(0, 2)].map((candidate, index) => ({
    ...candidate,
    id: `t${index}`,
    title: `${candidate.title} ${index}`,
  }));
  await useMockApi(page, { suggestions: five, streams: {} });
  await page.addInitScript(() => {
    document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.style.fontSize = "20px";
    });
  });
  await page.goto("/");
  await box(page).fill("Hurt");
  await expect(page.getByRole("option")).toHaveCount(5);
  const scrolls = await page
    .getByRole("listbox")
    .evaluate((element) => element.scrollHeight > element.clientHeight);
  expect(scrolls).toBe(true);

  await page.keyboard.press("Tab");
  const button = page.getByRole("button", { name: "Analyze", exact: true });
  await expect(button).toBeFocused();
  await expect(box(page)).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  const inView = await button.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const top = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return !!top && element.contains(top);
  });
  expect(inView).toBe(true);
});

test("a list closed with Escape stays closed when the answer for newer text comes", async ({
  page,
}) => {
  await useMockApi(page, { suggestions: candidates, streams: {} });
  await page.goto("/");
  await box(page).fill("Hurt");
  await expect(page.getByRole("option")).toHaveCount(candidates.length);
  const requestsBefore = await suggestRequests(page);

  await box(page).pressSequentially(" N");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.waitForTimeout(800);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  expect(await suggestRequests(page)).toBe(requestsBefore);
});

test("Enter after editing searches the typed text, not the suggestion highlighted before", async ({
  page,
}) => {
  await openSuggestions(page);
  await page.keyboard.press("ArrowDown");
  // Enter before typing pauses, while the list for "Hurt" is still up.
  await box(page).pressSequentially(" Nine");
  expect(await box(page).getAttribute("aria-activedescendant")).toBeNull();
  await page.keyboard.press("Enter");

  await expect
    .poll(async () =>
      (await apiRequests(page)).filter((entry) => entry.startsWith("stream /api/analyze/stream")),
    )
    .toEqual([
      expect.stringMatching(/^stream \/api\/analyze\/stream\?query=Hurt(\+|%20)Nine(&|$)/),
    ]);
  const [request] = (await apiRequests(page)).filter((entry) => entry.startsWith("stream "));
  expect(request).not.toContain("trackId");
});

test("the box's polite region says how many suggestions there are", async ({ page }) => {
  await openSuggestions(page);
  await expect(page.getByRole("status")).toHaveText(`${candidates.length} suggestions`);
});
