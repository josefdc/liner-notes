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
const gated = loadFixture("gated-v2");
const withheldKey = loadFixture("withheld-key-v2");
const ANALYZER = "analyzer 2.1.0+essentia.models-5c5c0c7f";

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
  for (const fixture of [measured, partly, gated, withheldKey]) {
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
    // The confidence on the estimator's own scale, said to be uncalibrated; the method and the
    // analyzer as text.
    await expect(valueItem(values, "BPM")).toHaveText(
      "BPM 105.2Measured · estimator confidence 3.30 of 5.32, not calibrated · signal, 29.8 s preview" +
        `essentia.RhythmExtractor2013 · ${ANALYZER} · the confidence does not flag half or double tempo`,
    );
    await expect(valueItem(values, "Key")).toHaveText(
      "Key A MinorMeasured · key strength 0.71 of 1, not a probability · signal, 29.8 s preview" +
        `essentia.KeyExtractor, edma profile · ${ANALYZER}`,
    );
    // Loudness, measured, replaces the 0-1 energy score.
    await expect(valueItem(values, "Loudness")).toHaveText(
      "Loudness -13.6 dBFS RMSMeasured · direct measure · signal, 29.8 s preview" +
        `essentia.RMS, mean RMS 0.210 · ${ANALYZER}`,
    );
    await expect(values).not.toContainText("Energy");

    const scores = page.getByRole("list", { name: "Audio-model estimates" });
    await expect(valueItem(scores, "Dance")).toHaveText(
      "Dance 0.58Model estimate · score, not a probability · model discogs-effnet-bs64-1, 29.8 s preview" +
        ANALYZER,
    );
    await expect(valueItem(scores, "Mood")).toContainText("Mood 5.20 on 1–9");
    await expect(scores).not.toContainText("Measured");

    const fingerprint = page.getByRole("region", { name: "Sonic Fingerprint" });
    await expect(fingerprint).toContainText("Model estimate");
    await expect(fingerprint).toContainText(
      "Style and tag scores from audio models run on the preview",
    );
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
      "Measured · estimator confidence 3.30 of 5.32, not calibrated",
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
    // Its service ran without the models: the analyzer version names no model set.
    "BPM 123Measured · no confidence given · signal, 22.4 s previewessentia.RhythmExtractor2013 · analyzer 2.1.0+essentia",
  );
  await expect(valueItem(values, "Key")).toHaveText(
    "Key not measured— not detected in the preview",
  );
  await expect(valueItem(values, "Loudness")).toContainText("Measured");
  await expect(page.getByRole("list", { name: "Audio-model estimates" })).toHaveText(
    "Model scores not available— the audio models are not loaded",
  );
  const fingerprint = page.getByRole("region", { name: "Sonic Fingerprint" });
  // The subtitle never says the models ran.
  await expect(fingerprint).toContainText(
    "Style and tag scores not available: the audio models are not loaded",
  );
  await expect(fingerprint).not.toContainText("models run on the preview");
  await expect(fingerprint).toContainText("Styles not available— the audio models are not loaded");
  await expect(fingerprint).toContainText("Tags not available— the audio models are not loaded");
  // The notice names only what is missing: the tempo was measured.
  const notices = page.getByRole("region", { name: "Missing data" });
  await expect(notices).toHaveText(
    "Audio partly measured" +
      "The analysis ran but did not detect the key." +
      "Not measured: key." +
      "Audio-model estimates not available: mood, arousal, danceability, acousticness, instrumental, style scores, tag scores (the audio models are not loaded).",
  );
  await expect(notices).not.toContainText("tempo");
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

test("a withheld key says which check withheld it, and a withheld mood head says why", async ({
  page,
}, testInfo) => {
  await useMockApi(page, withheldKey);
  await analyzeAndOpenDashboard(page, "Cowbell Loop");

  const values = page.getByRole("list", { name: "Audio values" });
  // The audio service's reason, in this page's words (the check that fired, never a cause it did
  // not test): never "not detected" alone.
  await expect(valueItem(values, "Key")).toHaveText(
    "Key not measured— its partials held still and moved together, so no key",
  );
  await expect(valueItem(values, "BPM")).toContainText("BPM 105.2Measured");
  const estimates = page.getByRole("list", { name: "Audio-model estimates" });
  await expect(valueItem(estimates, "Mood")).toHaveText(
    "Mood not available— outside the range its model produces",
  );
  await expect(valueItem(estimates, "Arousal")).toContainText("6.10 on 1–9");
  const notices = page.getByRole("region", { name: "Missing data" });
  await expect(notices).toHaveText(
    "Audio partly measured" +
      "Not measured: key (its partials held still and moved together, so no key)." +
      "Audio-model estimates not available: mood (outside the range its model produces).",
  );
  await expect(notices).not.toContainText("did not detect");
  await screenshot(page, testInfo, "withheld-key-dashboard");
});

test("a preview the gate stopped measures nothing, and every view says why", async ({
  page,
}, testInfo) => {
  const problems = collectProblems(page);
  await useMockApi(page, gated);
  await analyzeAndOpenDashboard(page, "Quiet Room");

  const notices = page.getByRole("region", { name: "Missing data" });
  await expect(notices).toHaveText(
    "Audio not measuredNothing was measured on the preview: the preview is silent.",
  );
  const values = page.getByRole("list", { name: "Audio values" });
  await expect(valueItem(values, "BPM")).toHaveText("BPM not measured— the preview is silent");
  await expect(valueItem(values, "Key")).toHaveText("Key not measured— the preview is silent");
  await expect(valueItem(values, "Loudness")).toHaveText(
    "Loudness not measured— the preview is silent",
  );
  await expect(page.locator('[data-value-kind="measured"]')).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Audio-model estimates" })).toHaveText(
    "Model scores not available— the preview is silent",
  );
  const fingerprint = page.getByRole("region", { name: "Sonic Fingerprint" });
  await expect(fingerprint).toContainText(
    "Style and tag scores not available: the preview is silent",
  );
  await screenshot(page, testInfo, "gated-dashboard");
  await screenshot(page, testInfo, "gated-fingerprint", fingerprint);

  await openPlayer(page);
  const timeline = page.getByRole("group", { name: "Song structure" });
  await expect(timeline).toContainText("No key moments — the preview is silent");
  await expect(timeline).not.toContainText("detected");
  await expect(page.getByRole("region", { name: "Missing data" })).toContainText(
    "Audio not measured",
  );
  await screenshot(page, testInfo, "gated-player");
  await screenshot(page, testInfo, "gated-timeline", timeline);
  expect(problems).toEqual([]);
});

test("a measurement the contract cannot read is not shown as measured", async ({
  page,
}, testInfo) => {
  // One malformed block (sections) makes the whole measurement unreadable, as the contract
  // reads it: the copies next to it are not confirmed by anything.
  const fixture = structuredClone(measured);
  const data = resultOf(fixture) as { audio: Record<string, unknown> };
  data.audio.sections = { segments: "A", method: "novelty", basis: "signal" };
  expect(AudioFeatures.safeParse(data.audio).success).toBe(false);
  await useMockApi(page, fixture);
  await analyzeAndOpenDashboard(page, "Bright Lines");

  await expect(page.locator('[data-value-kind="measured"]')).toHaveCount(0);
  const values = page.getByRole("list", { name: "Audio values" });
  await expect(valueItem(values, "BPM")).toHaveText(
    "BPM 105.2Not confirmed as measured · confidence and basis unknown",
  );
  await expect(page.getByRole("region", { name: "Missing data" })).toContainText(
    "Audio values not confirmed",
  );
  await expect(page.getByRole("region", { name: "Styles (model estimate)" })).toHaveCount(0);
  await screenshot(page, testInfo, "unreadable-dashboard");
});

test("a measurement without mood scores, and with a zero level, says exactly that", async ({
  page,
}, testInfo) => {
  const fixture = structuredClone(measured);
  const data = resultOf(fixture) as { audio: Record<string, unknown> } & Record<string, unknown>;
  const fingerprint = data.audio.fingerprint as Record<string, unknown>;
  data.audio.fingerprint = { ...fingerprint, styles: null, moods: null };
  data.audio.loudness = { rmsMean: 0, method: "essentia.RMS", basis: "signal" };
  Object.assign(data, { danceability: null, acousticness: null });
  expect(analysisIssues(TrackAnalysis.parse(data))).toEqual([]);
  await useMockApi(page, fixture);
  await analyzeAndOpenDashboard(page, "Bright Lines");

  const values = page.getByRole("list", { name: "Audio values" });
  await expect(valueItem(values, "Loudness")).toHaveText(
    "Loudness not shown— a level of zero has no dBFS value",
  );
  // Tag scores are shown: the missing ones are the mood scores, not every model score.
  await expect(page.getByRole("list", { name: "Audio-model estimates" })).toHaveText(
    "Mood scores not available",
  );
  const panel = page.getByRole("region", { name: "Sonic Fingerprint" });
  await expect(panel).toContainText("Tag scores from audio models run on the preview");
  await expect(panel).not.toContainText("Style and tag scores from");
  const notices = page.getByRole("region", { name: "Missing data" });
  await expect(notices).toContainText("Not shown: loudness (a level of zero has no dBFS value).");
  await expect(notices).not.toContainText("Not measured: loudness");
  await screenshot(page, testInfo, "mood-missing-zero-level-dashboard");
});

test.describe("a result with a null audio block", () => {
  test("keeps the values it says were estimated as estimates", async ({ page }, testInfo) => {
    await useMockApi(page, withResult({ audio: null, audioSource: "estimated" }));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    const values = page.getByRole("list", { name: "Audio values" });
    await expect(valueItem(values, "BPM")).toHaveText("BPM not measured— estimated, not measured");
    await expect(page.getByRole("region", { name: "Missing data" })).toContainText(
      "Estimated, not measured — not shown.",
    );
    await expect(page.locator("#root")).not.toContainText("105");
    await screenshot(page, testInfo, "null-estimated-dashboard");
  });

  test("shows the copies of an analysis that ran as not confirmed, model scores as estimates", async ({
    page,
  }, testInfo) => {
    await useMockApi(page, withResult({ audio: null }));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    const values = page.getByRole("list", { name: "Audio values" });
    await expect(valueItem(values, "BPM")).toHaveText(
      "BPM 105Not confirmed as measured · confidence and basis unknown",
    );
    await expect(valueItem(values, "Loudness")).toHaveText("Loudness not measured");
    const scores = page.getByRole("list", { name: "Audio-model estimates" });
    await expect(valueItem(scores, "Mood")).toContainText("Model estimate");
    await expect(page.locator('[data-value-kind="measured"]')).toHaveCount(0);
    await openPlayer(page);
    await expect(page.getByRole("group", { name: "Song structure" })).toContainText(
      "No key moments — the audio was not measured",
    );
    await screenshot(page, testInfo, "null-analyzed-dashboard-player");
  });
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

    // The Player draws none of its key moments: nothing was measured.
    await openPlayer(page);
    const timeline = page.getByRole("group", { name: "Song structure" });
    await expect(timeline).toContainText("No key moments — no audio preview");
    await expect(timeline).not.toContainText("key moments measured");
    await expect(timeline.getByRole("img", { name: /Energy peak/ })).toHaveCount(0);
    await expect(page.getByText("DEEP_DIVE_MODE")).toHaveText("DEEP_DIVE_MODE // BPM not measured");
    await screenshot(page, testInfo, "unavailable-player");
  });

  test("shows its measured values with their confidence and basis unknown", async ({
    page,
  }, testInfo) => {
    await useMockApi(page, loadFixture("full-result"));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    const values = page.getByRole("list", { name: "Audio values" });
    await expect(valueItem(values, "BPM")).toHaveText(
      "BPM 105Measured · confidence and basis unknown",
    );
    // The first analyzer's energy: on its own 0-1 scale, never a percentage or "Measured".
    await expect(valueItem(values, "Energy")).toHaveText(
      "Energy 0.71v1 energy score (0–1, saturates on loud masters) · confidence and basis unknown",
    );
    await screenshot(page, testInfo, "legacy-dashboard");
    // Its model scores are estimates, never measured.
    const scores = page.getByRole("list", { name: "Audio-model estimates" });
    await expect(valueItem(scores, "Mood")).toHaveText(
      "Mood Mellow 0.34Model estimate · score, not a probability · basis unknown",
    );
    await expect(scores).not.toContainText("Measured");
    await expect(scores.locator('[data-value-kind="measured"]')).toHaveCount(0);
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
