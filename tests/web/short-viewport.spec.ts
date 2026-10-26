import { expect, type Locator, type Page, test } from "@playwright/test";
import { loadFixture, useMockApi } from "./mock";

// Short and narrow windows (a phone on its side, a phone upright): what the search, its error
// and the track picker show must be reachable and in view where it matters, without the test
// scrolling anything.
const ANALYZE = "/api/analyze/stream";
const QUESTION = "Is this the right track?";
const HINT = "Arrow keys to move, Enter to analyze, Esc to close";

const hitl = loadFixture("hitl");
const three = hitl.streams[ANALYZE].find((event: { type: string }) => event.type === "interrupt")
  .candidates as Array<{ id: string; title: string; artist: string }>;
const five = [
  ...three,
  { ...three[0], id: "c4", artist: "Leona Lewis" },
  { ...three[0], id: "c5", artist: "Thousand Foot Krutch" },
];

const box = (page: Page) => page.getByRole("combobox", { name: "Song title and artist" });

/**
 * What keeps an element from being seen whole where it is now, without scrolling: the viewport,
 * or the visible area of any box around it that clips or scrolls. Empty when it is shown whole.
 */
function cutOff(target: Locator) {
  return target.evaluate((element) => {
    const problems: string[] = [];
    const box = element.getBoundingClientRect();
    const areas = [
      { name: "the viewport", top: 0, bottom: innerHeight, left: 0, right: innerWidth },
    ];
    for (let around = element.parentElement; around; around = around.parentElement) {
      const { overflowX, overflowY } = getComputedStyle(around);
      if (overflowX === "visible" && overflowY === "visible") continue;
      const rect = around.getBoundingClientRect();
      const top = rect.top + around.clientTop;
      const left = rect.left + around.clientLeft;
      areas.push({
        name: `${around.tagName} ${around.className}`,
        top,
        bottom: top + around.clientHeight,
        left,
        right: left + around.clientWidth,
      });
    }
    for (const area of areas) {
      if (
        box.top < area.top - 0.5 ||
        box.bottom > area.bottom + 0.5 ||
        box.left < area.left - 0.5 ||
        box.right > area.right + 0.5
      ) {
        problems.push(`cut by ${area.name}`);
      }
    }
    return problems;
  });
}

/**
 * How far an element starts above the top of the content of the nearest box that scrolls it
 * (negative when it is out of reach of that box's scroll); null when no box scrolls it.
 */
function offsetInScrollArea(target: Locator) {
  return target.evaluate((element) => {
    for (let around = element.parentElement; around; around = around.parentElement) {
      const { overflowY } = getComputedStyle(around);
      if (overflowY !== "auto" && overflowY !== "scroll") continue;
      const contentTop = around.getBoundingClientRect().top + around.clientTop - around.scrollTop;
      return element.getBoundingClientRect().top - contentTop;
    }
    return null;
  });
}

test("at 844x390 the error keeps the logo and the title within reach of the scroll", async ({
  page,
}) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: "t-error" },
        { type: "error", code: "upstream_unavailable", error: "Spotify did not answer." },
        { type: "done" },
      ],
    },
  });
  await page.goto("/");
  await box(page).fill("Hurt");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  const errorHeading = page.getByRole("heading", { name: "The analysis did not finish" });
  await expect(errorHeading).toBeFocused();

  const title = page.getByRole("heading", { name: "Liner Notes", level: 1 });
  const logo = page.locator("svg.lucide-network").first();
  for (const element of [logo, title]) {
    expect(await offsetInScrollArea(element)).toBeGreaterThanOrEqual(0);
  }
  // From the top of the scroll, the logo and the title are in view.
  await title.evaluate((element) => {
    let around = element.parentElement;
    while (around && getComputedStyle(around).overflowY !== "auto") around = around.parentElement;
    around?.scrollTo({ top: 0 });
  });
  await expect.poll(() => cutOff(logo)).toEqual([]);
  await expect.poll(() => cutOff(title)).toEqual([]);
});

test("at 844x390 the picker's question stays in view with every candidate", async ({ page }) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: "thread-hitl" },
        {
          type: "interrupt",
          reason: "disambiguation",
          threadId: "thread-hitl",
          candidates: five,
          message: "5 possible tracks from Spotify; choose one",
        },
        { type: "done" },
      ],
    },
  });
  await page.goto("/");
  await box(page).fill("Hurt");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  const list = page.getByRole("listbox", { name: QUESTION });
  await expect(list.getByRole("option").first()).toBeFocused();

  // Once the picker has come into view, nothing scrolled by the test.
  await expect.poll(() => cutOff(page.getByRole("heading", { name: QUESTION }))).toEqual([]);
  for (const row of await list.getByRole("option").all()) {
    expect(await cutOff(row)).toEqual([]);
  }
});

test("at 390x844 the suggestions' keyboard hint is above the fold", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useMockApi(page, { suggestions: three, streams: {} });
  await page.goto("/");
  await box(page).fill("Hurt");
  await expect(page.getByRole("option")).toHaveCount(three.length);

  await expect.poll(() => cutOff(page.getByText(HINT))).toEqual([]);
});
