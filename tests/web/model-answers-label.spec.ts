import { expect, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";

// A run whose model answers were replayed from stored answers (development and evaluation): the
// rest ran live. Its result says so, with when and from which commit the answers were recorded,
// and never presents it as a whole recording.
const fixture = loadFixture("full-result");
const events = fixture.streams["/api/analyze/stream"] as Array<{ type: string; data?: object }>;
const run = {
  id: "thread-model-answers",
  mode: "replay",
  replayed: "model_answers",
  recordedAt: "2026-03-01T10:00:00.000Z",
  commit: "abc123def456",
  analyzerVersion: null,
};

test("replayed model answers are labelled with when and where they were recorded", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, {
    ...fixture,
    streams: {
      ...fixture.streams,
      "/api/analyze/stream": events.map((event) =>
        event.type === "complete" ? { ...event, data: { ...event.data, run } } : event,
      ),
    },
  });
  await analyzeAndOpenDashboard(page, "Bright Lines");

  const label = page.getByRole("region", { name: "Replayed model answers" });
  await expect(label).toContainText("Model answers replayed · recorded 1 Mar 2026");
  await expect(label).toContainText("(commit abc123def456)");
  await expect(label).not.toContainText("Nothing was analysed live");
  await expect(label).not.toContainText("Recorded run ·");
  await expect(page.getByRole("region", { name: "Recorded run" })).toHaveCount(0);
  // Its audio was measured in this run, not when the answers were recorded.
  await expect(
    page.getByTitle("Measured from the audio preview", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByTitle(/when this run was recorded/)).toHaveCount(0);

  await openPlayer(page);
  await expect(page.getByRole("region", { name: "Replayed model answers" })).toContainText(
    "Model answers replayed · recorded 1 Mar 2026",
  );
  expect(problems).toEqual([]);
});
