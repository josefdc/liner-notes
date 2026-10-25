import { expect, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";

// A complete result: measured audio values, audio-model scores, a genre profile and segments
// written by the model. Model output must be labelled as inference, measured values as measured.
const fixture = loadFixture("full-result");

test.beforeEach(async ({ page }) => {
  await useMockApi(page, fixture);
});

test("the Dashboard labels measured values, model scores and the model's genre profile", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await analyzeAndOpenDashboard(page, "Bright Lines");

  const stats = page.getByRole("list", { name: "Audio values" });
  await expect(stats).toContainText("105");
  await expect(stats).toContainText("A Minor");
  await expect(stats).toContainText("0.71");
  await expect(stats).not.toContainText("71%");
  await expect(stats).not.toContainText("not measured");

  const scores = page.getByRole("list", { name: "Audio-model estimates" });
  await expect(scores).toContainText("0.62");
  await expect(scores).toContainText("Mellow");
  await expect(scores).not.toContainText("62%");

  const fingerprint = page.getByRole("region", { name: "Sonic Fingerprint" });
  await expect(fingerprint).toContainText("Model inference");
  await expect(fingerprint.locator(".recharts-wrapper")).toHaveCount(1);

  await expect(page.getByRole("region", { name: "Missing data" })).toHaveCount(0);
  expect(problems).toEqual([]);
});

test("the Player labels model-written segments and keeps every marker", async ({ page }) => {
  const problems = collectProblems(page);
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);

  const timeline = page.getByRole("group", { name: "Song structure" });
  await expect(timeline).toContainText("Model inference");
  await expect(timeline).toContainText("4:00");
  // The sample on the song timeline; the two key moments (same time) on the preview lane.
  await expect(timeline.getByRole("img")).toHaveCount(3);
  const preview = timeline.getByRole("group", { name: "Audio preview (about 30 s)" });
  await expect(preview.getByRole("img")).toHaveCount(2);
  await expect(timeline).toContainText("Sample times: model inference");
  // The insights and the genealogy are labelled as model output.
  await expect(page.locator("#panel-context")).toContainText("Model inference");
  // A factoid stating measured values is kept.
  await expect(page.locator("#panel-context")).toContainText("Sonic Profile");
  await expect(page.locator("#panel-genealogy")).toContainText("Model inference");
  expect(problems.filter((p) => /same key|width\(-?\d+\)/.test(p))).toEqual([]);
});
