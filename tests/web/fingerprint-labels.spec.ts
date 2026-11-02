import { expect, type Locator, test } from "@playwright/test";
import { analyzeAndOpenDashboard, collectProblems, loadFixture, useMockApi } from "./mock";

// The Sonic Fingerprint's radar chart keeps each of its axis labels whole: no label's box runs
// past the card's padding, where the card (or the chart's own drawing) would cut it, at a
// phone's, a tablet's and a desktop's width. The full-result fixture's genres are the usual
// ones ("Electronic", "Ambient"). With genres of 16 to 22 characters the radar is still drawn,
// at 36 px or more (RADAR_FLOOR in SonicFingerprint.tsx), its labels wrapped or cut to fit,
// none over another, and each keeps its whole name for screen readers.

const ANALYZE = "/api/analyze/stream";
const RADAR_FLOOR = 36;
const LONG_GENRES = [
  "Alternative Rock",
  "Progressive House",
  "Singer-Songwriter",
  "Electronic Dance Music",
  "Contemporary R&B",
];

/** The full-result fixture with `genres` as its genre profile. */
function withGenres(genres: string[]) {
  const fixture = loadFixture("full-result");
  for (const event of fixture.streams[ANALYZE]) {
    if (event.type === "complete") {
      event.data.genreProfile = genres.map((genre, index) => ({ genre, value: 80 - index * 12 }));
    }
  }
  return fixture;
}

/**
 * The radar's axis labels whose box runs past the card's padding, as "<text>: <box> past
 * <padding box>", and the pairs of labels whose boxes overlap.
 */
function labelProblems(card: Locator) {
  return card.evaluate((section) => {
    const style = getComputedStyle(section);
    const box = section.getBoundingClientRect();
    const px = (value: string) => Number.parseFloat(value);
    const inner = {
      left: box.left + px(style.borderLeftWidth) + px(style.paddingLeft),
      right: box.right - px(style.borderRightWidth) - px(style.paddingRight),
      top: box.top + px(style.borderTopWidth) + px(style.paddingTop),
      bottom: box.bottom - px(style.borderBottomWidth) - px(style.paddingBottom),
    };
    const round = (at: { left: number; top: number; right: number; bottom: number }) =>
      [at.left, at.top, at.right, at.bottom].map(Math.round).join(",");
    const labels = [...section.querySelectorAll(".recharts-polar-angle-axis-tick text")].map(
      (label) => ({ text: label.textContent ?? "", at: label.getBoundingClientRect() }),
    );
    const outside = labels
      .filter(
        ({ at }) =>
          at.left < inner.left - 0.5 ||
          at.right > inner.right + 0.5 ||
          at.top < inner.top - 0.5 ||
          at.bottom > inner.bottom + 0.5,
      )
      .map(({ text, at }) => `${text}: ${round(at)} past ${round(inner)}`);
    const overlaps = labels.flatMap((one, i) =>
      labels
        .slice(i + 1)
        .filter(
          (two) =>
            one.at.left < two.at.right - 0.5 &&
            two.at.left < one.at.right - 0.5 &&
            one.at.top < two.at.bottom - 0.5 &&
            two.at.top < one.at.bottom - 0.5,
        )
        .map((two) => `${one.text} over ${two.text}`),
    );
    return [...outside, ...overlaps];
  });
}

/** The radar's radius as drawn: the length of a spoke of its grid. */
function gridRadius(card: Locator) {
  return card
    .locator(".recharts-polar-grid-angle line")
    .first()
    .evaluate((line) => {
      const at = (name: string) => Number(line.getAttribute(name));
      return Math.hypot(at("x2") - at("x1"), at("y2") - at("y1"));
    });
}

for (const [width, height] of [
  [390, 844],
  [768, 1024],
  [820, 1180],
  [1024, 768],
  [1440, 900],
  [1680, 1050],
] as const) {
  test(`the Sonic Fingerprint's axis labels stay inside its card (${width} px)`, async ({
    page,
  }) => {
    const problems = collectProblems(page);
    await page.setViewportSize({ width, height });
    await useMockApi(page, loadFixture("full-result"));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    const card = page.getByRole("region", { name: "Sonic Fingerprint" });
    await expect(card.locator(".recharts-polar-angle-axis-tick text")).toHaveCount(5);
    // Polled: the radar takes its size from the chart's, measured as it mounts.
    await expect.poll(() => labelProblems(card)).toEqual([]);
    expect(problems).toEqual([]);
  });
}

for (const [width, height] of [
  [390, 844],
  [1024, 768],
  [1440, 900],
] as const) {
  test(`with long genre names the radar is still drawn and its labels fit (${width} px)`, async ({
    page,
  }) => {
    const problems = collectProblems(page);
    await page.setViewportSize({ width, height });
    await useMockApi(page, withGenres(LONG_GENRES));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    const card = page.getByRole("region", { name: "Sonic Fingerprint" });
    await expect(card.locator(".recharts-polar-angle-axis-tick text")).toHaveCount(5);
    await expect.poll(() => labelProblems(card)).toEqual([]);
    expect(await gridRadius(card)).toBeGreaterThanOrEqual(RADAR_FLOOR - 0.5);
    // Each genre's whole name, for screen readers and as a tooltip, wherever its lines are cut.
    const names = await card
      .locator(".recharts-polar-angle-axis-tick")
      .evaluateAll((ticks) =>
        ticks.map(
          (tick) =>
            tick.querySelector("title")?.textContent ??
            tick.querySelector("text")?.textContent ??
            "",
        ),
      );
    expect(names.sort()).toEqual([...LONG_GENRES].sort());
    expect(problems).toEqual([]);
  });
}
