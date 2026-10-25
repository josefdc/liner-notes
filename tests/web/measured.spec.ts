import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { analysisIssues, AudioFeatures, TrackAnalysis } from "@liner-notes/contract";
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  fullResultData,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";

// Measured audio values on the result screens. A result with its measurement (the `audio`
// block) shows each value with its confidence and basis, or as missing with why; model scores
// are labelled model estimates; the preview lane spans the measured window. A result without
// the block (older APIs) never shows a value as more than it is.
const measured = loadFixture("measured-v2");
const partly = loadFixture("partly-measured-v2");

type Event = { type: string; data?: Record<string, unknown> };

const resultOf = (fixture: { streams: Record<string, Event[]> }) =>
  fixture.streams["/api/analyze/stream"].find((event) => event.type === "complete")?.data;

/** full-result with its result changed: a result from an API that sends no `audio` block. */
function withResult(changes: Record<string, unknown>) {
  const fixture = loadFixture("full-result");
  const events = fixture.streams["/api/analyze/stream"] as Event[];
  return {
    ...fixture,
    streams: {
      ...fixture.streams,
      "/api/analyze/stream": events.map((event) =>
        event.type === "complete" ? { ...event, data: { ...event.data, ...changes } } : event,
      ),
    },
  };
}

/** A screenshot of the page, or of one part of it (scrolled into view). */
async function screenshot(page: Page, testInfo: TestInfo, name: string, part?: Locator) {
  const dir = process.env.MEASURED_SHOTS_DIR ?? testInfo.project.outputDir;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `measured-${name}.png`);
  if (part) await part.screenshot({ path });
  else await page.screenshot({ path, fullPage: true });
}

/** The item of a list of values that starts with a label ("BPM", "Key", ...). */
const valueItem = (list: Locator, label: string) =>
  list.getByRole("listitem").filter({ hasText: new RegExp(`^${label}\\b`) });

test("the mock results are results the API may send", () => {
  for (const fixture of [measured, partly]) {
    const data = resultOf(fixture);
    // TrackAnalysis reads an unreadable `audio` as null, so the block is checked on its own too.
    expect(AudioFeatures.safeParse(data?.audio).success).toBe(true);
    expect(analysisIssues(TrackAnalysis.parse(data))).toEqual([]);
  }
});

test.describe("a measured result", () => {
  test.beforeEach(async ({ page }) => {
    await useMockApi(page, measured);
  });

  test("the Dashboard shows each value with its confidence and basis", async ({
    page,
  }, testInfo) => {
    const problems = collectProblems(page);
    await analyzeAndOpenDashboard(page, "Bright Lines");

    const values = page.getByRole("list", { name: "Audio values" });
    await expect(valueItem(values, "BPM")).toHaveText(
      "BPM 105.2Measured · confidence 0.62 · signal, 29.8 s preview",
    );
    await expect(valueItem(values, "Key")).toHaveText(
      "Key A MinorMeasured · strength 0.71 · signal, 29.8 s preview",
    );
    // Loudness, measured, replaces the 0-1 energy score.
    await expect(valueItem(values, "Loudness")).toHaveText(
      "Loudness -13.6 dBFS RMSMeasured · direct measure · signal, 29.8 s preview",
    );
    await expect(values).not.toContainText("Energy");

    const scores = page.getByRole("list", { name: "Audio-model estimates" });
    await expect(valueItem(scores, "Dance")).toHaveText(
      "Dance 0.58Model estimate · score, not a probability · model discogs-effnet-bs64-1, 29.8 s preview",
    );
    await expect(valueItem(scores, "Mood")).toContainText("Mood 5.20 on 1–9");
    await expect(scores).not.toContainText("Measured");

    const fingerprint = page.getByRole("region", { name: "Sonic Fingerprint" });
    await expect(fingerprint).toContainText("Model estimate");
    const styles = fingerprint.getByRole("region", { name: "Styles (model estimate)" });
    await expect(styles).toContainText("Model estimate · scores, not probabilities");
    await expect(styles.getByRole("listitem")).toHaveText([
      "Electronic / Synth-pop 0.61",
      "Electronic / Dream Pop 0.22",
      "Pop / Indie Pop 0.09",
    ]);
    await expect(fingerprint.getByRole("region", { name: "Tags (model estimate)" })).toContainText(
      "electronic 0.70",
    );
    // Scores, not shares of a whole: no radar, no percentages.
    await expect(fingerprint.locator(".recharts-wrapper")).toHaveCount(0);
    await expect(fingerprint).not.toContainText("%");

    await expect(page.getByRole("region", { name: "Missing data" })).toHaveCount(0);
    await screenshot(page, testInfo, "dashboard");
    await screenshot(page, testInfo, "fingerprint", fingerprint);
    expect(problems).toEqual([]);
  });

  test("the Player's preview lane spans the measured window", async ({ page }, testInfo) => {
    const problems = collectProblems(page);
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);

    const timeline = page.getByRole("group", { name: "Song structure" });
    const lane = timeline.getByRole("group", { name: "Preview window (29.8 s, measured)" });
    await expect(lane).toContainText("position in the song unknown");
    await expect(lane).toContainText("29.8 s");
    await expect(lane.getByRole("img")).toHaveCount(2);
    // 18.6 s into a 29.75 s window.
    await expect(lane.getByRole("img").nth(1)).toHaveAttribute(
      "style",
      new RegExp(`left: ${((18.6 / 29.75) * 100).toFixed(2)}`),
    );
    await expect(timeline).not.toContainText("about 30 s");
    await expect(page.getByText("DEEP_DIVE_MODE")).toContainText("29.8 s preview");
    await expect(valueItem(page.getByRole("list", { name: "Audio values" }), "BPM")).toContainText(
      "Measured · confidence 0.62",
    );
    await screenshot(page, testInfo, "player");
    await screenshot(page, testInfo, "timeline", timeline);
    expect(problems).toEqual([]);
  });
});

test("a partly measured result says what was not measured and why", async ({ page }, testInfo) => {
  await useMockApi(page, partly);
  await analyzeAndOpenDashboard(page, "Half Signal");

  const values = page.getByRole("list", { name: "Audio values" });
  // Its audioSource is "unavailable", but the tempo is in the measurement: it is shown.
  await expect(valueItem(values, "BPM")).toHaveText(
    "BPM 123Measured · no confidence given · signal, 22.4 s preview",
  );
  await expect(valueItem(values, "Key")).toHaveText(
    "Key not measured— not detected in the preview",
  );
  await expect(valueItem(values, "Loudness")).toContainText("Measured");
  await expect(page.getByRole("list", { name: "Audio-model estimates" })).toHaveText(
    "Model scores not measured— the audio models are not loaded",
  );
  const fingerprint = page.getByRole("region", { name: "Sonic Fingerprint" });
  await expect(fingerprint).toContainText("Styles not measured— the audio models are not loaded");
  await expect(fingerprint).toContainText("Tags not measured— the audio models are not loaded");
  const notices = page.getByRole("region", { name: "Missing data" });
  await expect(notices).toContainText("Audio partly measured");
  await expect(notices).toContainText("Not measured: key, mood, arousal");
  await screenshot(page, testInfo, "partly-dashboard");
  await screenshot(page, testInfo, "partly-fingerprint", fingerprint);

  await openPlayer(page);
  const lane = page
    .getByRole("group", { name: "Song structure" })
    .getByRole("group", { name: "Preview window (22.4 s, measured)" });
  await expect(lane.getByRole("img")).toHaveCount(2);
  await expect(page.getByText("DEEP_DIVE_MODE")).toHaveText(
    "DEEP_DIVE_MODE // 123 BPM // 22.4 s preview",
  );
  await screenshot(page, testInfo, "partly-player");
  await screenshot(page, testInfo, "partly-timeline", lane);
});

test.describe("a result without the audio block", () => {
  test('shows no value as measured when audioSource is "unavailable" and nothing ran', async ({
    page,
  }, testInfo) => {
    // The values a result carries do not make it measured: the analysis did not run.
    await useMockApi(
      page,
      withResult({ audioSource: "unavailable", audioUnavailableReason: "no_preview" }),
    );
    await analyzeAndOpenDashboard(page, "Bright Lines");

    const values = page.getByRole("list", { name: "Audio values" });
    await expect(valueItem(values, "BPM")).toHaveText("BPM not measured— no audio preview");
    await expect(values.locator('[data-value-kind="measured"]')).toHaveCount(0);
    await expect(page.getByTitle(/^Measured from the audio preview/)).toHaveCount(0);
    await expect(page.locator("#root")).not.toContainText("105");
    await expect(page.getByRole("region", { name: "Missing data" })).toContainText(
      "No audio preview is available for this track.",
    );
    await screenshot(page, testInfo, "unavailable-dashboard");
  });

  test("shows its measured values with their confidence and basis unknown", async ({ page }) => {
    await useMockApi(page, loadFixture("full-result"));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    const values = page.getByRole("list", { name: "Audio values" });
    await expect(valueItem(values, "BPM")).toHaveText(
      "BPM 105Measured · confidence and basis unknown",
    );
    await expect(valueItem(values, "Energy")).toHaveText(
      "Energy 71%Measured · confidence and basis unknown",
    );
    await openPlayer(page);
    // Without the window's length the lane still says it is not known.
    await expect(
      page.getByRole("group", { name: "Audio preview (about 30 s)" }).getByRole("img"),
    ).toHaveCount(2);
  });

  test("shows a saturated energy as missing, with why", async ({ page }, testInfo) => {
    const data = fullResultData() as Record<string, unknown>;
    expect(data.energy).toBe(0.71);
    await useMockApi(page, withResult({ energy: 1 }));
    await analyzeAndOpenDashboard(page, "Bright Lines");

    const values = page.getByRole("list", { name: "Audio values" });
    await expect(valueItem(values, "Energy")).toHaveText(
      "Energy not shown— energy saturates on loud masters",
    );
    await expect(page.locator("#root")).not.toContainText("100%");
    await screenshot(page, testInfo, "saturated-dashboard");
  });
});
