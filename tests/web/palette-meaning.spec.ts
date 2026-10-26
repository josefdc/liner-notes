import { expect, test } from "@playwright/test";
import { analyzeAndOpenDashboard, loadFixture, openPlayer, useMockApi } from "./mock";

// Colour says how something is known: cyan measured, amber sourced, violet inferred (what a
// model wrote), neutral otherwise. These checks read the colours the screens draw with.
const INFERRED = "rgb(196, 164, 252)";
const MEASURED = "rgb(0, 240, 255)";

test("the model's genre profile is drawn in the inferred violet, not the measured cyan", async ({
  page,
}) => {
  await useMockApi(page, loadFixture("full-result"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  const radar = page
    .getByRole("region", { name: "Sonic Fingerprint" })
    .locator(".recharts-radar-polygon path")
    .first();
  await expect(radar).toBeVisible();
  const paint = await radar.evaluate((path) => {
    const style = getComputedStyle(path);
    return { stroke: style.stroke, fill: style.fill };
  });
  expect(paint).toEqual({ stroke: INFERRED, fill: INFERRED });
});

test("the Player's timeline draws the model's sections and sample times in violet, measured moments in cyan", async ({
  page,
}) => {
  await useMockApi(page, loadFixture("full-result"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  const timeline = page.getByRole("group", { name: "Song structure" });
  await expect(timeline.locator("[data-provenance]").first()).toHaveAttribute(
    "data-provenance",
    "inferred",
  );
  // Every section is a tint of the inferred violet, whatever colour the result sent.
  const hues = await timeline.getByRole("listitem").evaluateAll((items) =>
    items.map((item) => {
      const context = new OffscreenCanvas(1, 1).getContext("2d");
      if (!context) throw new Error("no 2d context");
      context.fillStyle = getComputedStyle(item).backgroundColor;
      context.fillRect(0, 0, 1, 1);
      const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
      return { r, g, b };
    }),
  );
  // Violet: blue strongest, red next, green least; never cyan (green and blue together) or amber.
  expect(hues.length).toBeGreaterThan(0);
  for (const { r, g, b } of hues) {
    expect(b).toBeGreaterThan(r);
    expect(r).toBeGreaterThan(g);
  }
  const markers = await timeline.getByRole("img").evaluateAll((items) =>
    items.map((item) => ({
      label: item.getAttribute("aria-label") ?? "",
      colour: getComputedStyle(item.querySelector("svg") as Element).color,
    })),
  );
  expect(markers.length).toBeGreaterThan(1);
  for (const { label, colour } of markers) {
    expect(colour, label).toBe(label.includes("inferred by the model") ? INFERRED : MEASURED);
  }
});

test("at 768 px a source note breaks only between its parts, and a link keeps its icon at its end", async ({
  page,
}) => {
  await useMockApi(page, loadFixture("provenance"));
  await page.setViewportSize({ width: 768, height: 900 });
  await analyzeAndOpenDashboard(page, "Track");
  await openPlayer(page);
  const notes = page.locator("#panel-context [data-source-note]");
  expect(await notes.count()).toBeGreaterThan(0);
  // The rejected claims' notes too.
  await page.getByRole("button", { name: /Rejected by the verifier/ }).click();
  const problems = await notes.evaluateAll((elements) =>
    elements.flatMap((note) => {
      const found: string[] = [];
      // A note inside a closed panel (the rejected claims) is not laid out.
      if (note.getClientRects().length === 0) return found;
      const name = note.textContent ?? "";
      const time = note.querySelector("time");
      if (time && time.getClientRects().length !== 1) found.push(`${name}: the date breaks`);
      const link = note.querySelector("a");
      const icon = link?.querySelector("[data-external-icon]");
      if (link && icon) {
        const lines = [...link.getClientRects()].filter((rect) => rect.width > 0);
        const last = lines[lines.length - 1];
        const box = icon.getBoundingClientRect();
        if (box.top < last.top - 2 || box.bottom > last.bottom + 2 || box.left < last.left) {
          found.push(`${name}: the icon is not on the link's last line`);
        }
      }
      return found;
    }),
  );
  expect(problems).toEqual([]);
});
