import { join } from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import { analyzeAndOpenDashboard, loadFixture, openPlayer, useMockApi } from "./mock";

// A result built without the model and without audio analysis: null bpm/key/energy, no genre
// profile, no key moments, template segments, no duration. Every view must say what is missing
// instead of showing a number, a placeholder chart or a demo track.
const fixture = loadFixture("missing-states");

const NO_PLACEHOLDER_WORDS = /\b(null|NaN|undefined)\b/;

async function screenshot(page: Page, testInfo: TestInfo, name: string) {
  await page.screenshot({
    path: join(testInfo.project.outputDir, `missing-states-${name}.png`),
    fullPage: true,
  });
}

async function expectNoInventedValues(page: Page) {
  const text = await page.locator("#root").innerText();
  expect(text).not.toMatch(NO_PLACEHOLDER_WORDS);
  // Same line only: a year on the line above "BPM not measured" is not a tempo.
  expect(text).not.toMatch(/\d[ \t]*BPM/);
  expect(text).not.toMatch(/\d[ \t]*%/);
  expect(text).not.toContain("Midnight City");
}

test.beforeEach(async ({ page }) => {
  await useMockApi(page, fixture);
});

test("the Dashboard names what is missing and shows no placeholder content", async ({ page }) => {
  await analyzeAndOpenDashboard(page, "Quiet Signal");

  const notices = page.getByRole("region", { name: "Missing data" });
  await expect(notices).toContainText("Model unavailable");
  await expect(notices).toContainText("(quota or rate limit reached)");
  await expect(notices).toContainText("genre profile");
  await expect(notices).toContainText("song structure");
  await expect(notices).toContainText("Audio not analyzed");
  await expect(notices).toContainText("No audio preview is available for this track");
  await expect(notices).toContainText("BPM, key, energy");

  const stats = page.getByRole("list", { name: "Audio values" });
  await expect(stats).toContainText("BPM not measured");
  await expect(stats).toContainText("Key not measured");
  await expect(stats).toContainText("Energy not measured");

  // No flat placeholder radar and no hard-coded recommendations.
  const fingerprint = page.getByRole("region", { name: "Sonic Fingerprint" });
  await expect(fingerprint.getByText("No genre profile", { exact: true })).toBeVisible();
  await expect(page.locator(".recharts-wrapper")).toHaveCount(0);
  await expect(page.getByText("Discovered Gems")).toHaveCount(0);
  // No cover and no connections: there is no image to show at all.
  await expect(page.locator("#root img")).toHaveCount(0);
  await expect(page.getByText("No connected tracks found")).toBeVisible();

  await expectNoInventedValues(page);
});

test("the Player shows not-measured states and no song sections", async ({ page }) => {
  await analyzeAndOpenDashboard(page, "Quiet Signal");
  await openPlayer(page);

  await expect(page.getByRole("heading", { name: "Quiet Signal" })).toBeVisible();
  await expect(page.getByRole("region", { name: "Missing data" })).toContainText(
    "Model unavailable",
  );
  await expect(page.getByRole("list", { name: "Audio values" })).toContainText("BPM not measured");

  const timeline = page.getByRole("group", { name: "Song structure" });
  // The result's structure is a template: no section of it is drawn or named.
  await expect(timeline.locator('[data-structure="not-analyzed"]')).toHaveText(
    "Song sections not analyzed",
  );
  await expect(timeline.getByRole("list")).toHaveCount(0);
  await expect(timeline.getByRole("listitem")).toHaveCount(0);
  await expect(timeline.locator("[data-segment-tint]")).toHaveCount(0);
  await expect(timeline).not.toContainText(/Intro|Main|Outro|Template/);
  // Nothing is placed on the song's time, so no axis is drawn for it: its length is said in
  // words, and it is unknown here (no default length).
  await expect(timeline.locator("[data-song-length]")).toHaveText("Song length unknown");
  await expect(timeline).not.toContainText(/0:00|3:45/);
  // No fake marker: nothing was detected, so nothing is drawn on the timeline.
  await expect(timeline.getByRole("img")).toHaveCount(0);
  await expect(timeline.getByRole("button")).toHaveCount(0);
  await expect(timeline).toContainText("No key moments");

  await expectNoInventedValues(page);
});

test("screenshots of the missing states at desktop and phone widths", async ({
  page,
}, testInfo) => {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await analyzeAndOpenDashboard(page, "Quiet Signal");
    await screenshot(page, testInfo, `dashboard-${width}`);
    await openPlayer(page);
    await screenshot(page, testInfo, `player-${width}`);
  }
});
