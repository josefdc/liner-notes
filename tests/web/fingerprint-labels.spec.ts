import { expect, test } from "@playwright/test";
import { analyzeAndOpenDashboard, collectProblems, loadFixture, useMockApi } from "./mock";

// The Sonic Fingerprint's radar chart keeps each of its axis labels whole: no label's box runs
// past the card's padding, where the card (or the chart's own drawing) would cut it, at a
// phone's, a tablet's and a desktop's width. The full-result fixture's genres include the longest
// a model profile has here ("Electronic", "Ambient").

const fullResult = loadFixture("full-result");

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
    await useMockApi(page, fullResult);
    await analyzeAndOpenDashboard(page, "Bright Lines");
    const card = page.getByRole("region", { name: "Sonic Fingerprint" });
    const labels = card.locator(".recharts-polar-angle-axis-tick text");
    await expect(labels).toHaveCount(5);
    const outside = await card.evaluate((section) => {
      const style = getComputedStyle(section);
      const box = section.getBoundingClientRect();
      const inner = {
        left:
          box.left +
          Number.parseFloat(style.borderLeftWidth) +
          Number.parseFloat(style.paddingLeft),
        right:
          box.right -
          Number.parseFloat(style.borderRightWidth) -
          Number.parseFloat(style.paddingRight),
        top:
          box.top + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop),
        bottom:
          box.bottom -
          Number.parseFloat(style.borderBottomWidth) -
          Number.parseFloat(style.paddingBottom),
      };
      return [...section.querySelectorAll(".recharts-polar-angle-axis-tick text")]
        .map((label) => ({ text: label.textContent ?? "", at: label.getBoundingClientRect() }))
        .filter(
          ({ at }) =>
            at.left < inner.left - 0.5 ||
            at.right > inner.right + 0.5 ||
            at.top < inner.top - 0.5 ||
            at.bottom > inner.bottom + 0.5,
        )
        .map(
          ({ text, at }) =>
            `${text}: ${[at.left, at.top, at.right, at.bottom].map(Math.round).join(",")} past ${[
              inner.left,
              inner.top,
              inner.right,
              inner.bottom,
            ]
              .map(Math.round)
              .join(",")}`,
        );
    });
    expect(outside).toEqual([]);
    expect(problems).toEqual([]);
  });
}
