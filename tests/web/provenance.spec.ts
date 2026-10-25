import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { analysisIssues, TrackAnalysis } from "@liner-notes/contract";
import { expect, type Locator, type Page, type TestInfo, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";

// Where each claim of a result comes from, on the contract fixture `provenance`: a claim of
// each kind (measured, sourced, inferred) shows its kind, its sources and their tier as text; a
// value that was not measured shows why; a conflict with the measurement shows both values; a
// claim the verifier contradicted, whatever its kind, appears only in the rejected claims,
// which name how many they hold.
const provenance = loadFixture("provenance");

type Event = { type: string; data?: Record<string, unknown> };

const resultOf = (fixture: { streams: Record<string, Event[]> }) =>
  fixture.streams["/api/analyze/stream"].find((event) => event.type === "complete")?.data;

/** full-result with its result changed. */
function fullResultWith(changes: Record<string, unknown>) {
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
  const dir = process.env.PROVENANCE_SHOTS_DIR ?? testInfo.project.outputDir;
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `provenance-${name}.png`);
  if (part) {
    await part.scrollIntoViewIfNeeded();
    await part.screenshot({ path });
  } else await page.screenshot({ path, fullPage: true });
}

/** The list item of a region that holds a claim's text. */
const claimItem = (region: Locator, text: string) =>
  region.getByRole("listitem").filter({ hasText: text });

test("the mock result is a result the API may send, with only the faults planted in it", () => {
  const data = resultOf(provenance);
  // Each planted fault is one the reader must show for what it is: a web search result as a
  // web page, claims as inference, and cards whose claim cannot be read not at all.
  expect(analysisIssues(TrackAnalysis.parse(data))).toEqual([
    "evidence[4].sourceTier: a web search result is not a primary record",
    "claims[1].field: key was not measured",
    'claims[6].evidenceIds: cites "ev-gone", which is not in the evidence pack',
    "claims[7].verdict: a model claim is sourced only when supported or partial",
    'factoids[3].claimId: unknown claim "c-future-rejected"',
    'factoids[5].claimId: unknown claim "c-future"',
  ]);
});

test.describe("a result with claims", () => {
  test.beforeEach(async ({ page }) => {
    await useMockApi(page, provenance);
    await page.setViewportSize({ width: 1440, height: 900 });
    await analyzeAndOpenDashboard(page, "Paper Lanterns");
    await openPlayer(page);
  });

  test("a claim of each kind shows its kind, its sources and their tier", async ({
    page,
  }, testInfo) => {
    const problems = collectProblems(page);
    const more = page.getByRole("region", { name: "More claims" });
    const credits = page.getByRole("region", { name: "Credits" });

    // measured: the value as measured, with its confidence and basis
    const tempo = claimItem(more, "The preview was measured at 123 BPM.");
    await expect(tempo.locator("[data-claim-kind]")).toHaveAttribute("data-claim-kind", "measured");
    await expect(tempo).toContainText(
      "BPM 123Measured · no confidence given · signal, 22.4 s preview",
    );

    // sourced: a link to the record, named with the source and its tier
    const writers = claimItem(credits, "Written by Ada Example and Ben Example.");
    await expect(writers).toContainText("Sourced");
    await expect(writers).toContainText(
      "taken from the source record · not checked by the verifier",
    );
    // A record of the song, not of this recording, says so.
    const link = writers.getByRole("link", {
      name: "MusicBrainz · primary record · about the song, not this recording — Paper Lanterns (work), opens in a new tab",
    });
    await expect(link).toHaveAttribute(
      "href",
      "https://musicbrainz.org/work/6c5d2a64-0f6e-4c1b-9a43-1f2e3d4c5b6a",
    );
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    const producer = claimItem(credits, "Produced by Cleo Example");
    // Which part the verifier did not find, from its reason.
    await expect(producer).toContainText(
      "Partly supported: The release credits name the producer; no engineer is listed.",
    );
    await expect(producer).toContainText("Discogs · primary record · about a whole release");
    // A credit claim shown on a card is not listed again.
    await expect(page.getByText("Vocals by Ivy Example.")).toHaveCount(1);
    await expect(credits).toContainText("1 credit is shown with the facts above.");
    // A code-built credit the verifier did not support is never plainly sourced.
    const mastered = claimItem(credits, "Mastered by Gil Example.");
    await expect(mastered).toContainText("SourcedNot supported");
    await expect(mastered).toContainText(
      "Not supported by its sources: The release credits list no mastering engineer.",
    );
    // A web search result labelled a primary record is shown as a web page.
    const blog = claimItem(more, "A blog calls it the band's breakthrough.");
    await expect(blog).toContainText("Web search · web page");
    await expect(blog).not.toContainText("primary record");
    const card = page
      .locator("#panel-context .group")
      .filter({ hasText: "The album was recorded in two days." });
    await expect(card).toContainText("Sourced");
    await expect(
      card.getByRole("link", { name: /^Web search · editorial — Test Album review/ }),
    ).toBeVisible();

    // inferred: model claims, and sourced claims that cannot be shown as sourced
    for (const [text, label, status] of [
      ["The song was a club favourite in 2011.", "Model inference", "not checked by the verifier"],
      ["The single reached the top 40.", "Inferred", "1 cited source is not in this result"],
      [
        "The song was recorded at Abbey Road.",
        "Model inference",
        "Not supported by its sources: The release record does not name a studio.",
      ],
    ]) {
      const item = claimItem(more, text);
      await expect(item.locator("[data-claim-kind]")).toHaveAttribute(
        "data-claim-kind",
        "inferred",
      );
      await expect(item.locator("[data-claim-kind] span.border").first()).toHaveText(label);
      await expect(item).toContainText(status);
      await expect(item).not.toContainText("Sourced");
      await expect(item).not.toContainText("primary record");
    }
    // A card without a claim, beside cards with claims, is labelled on its own.
    await expect(
      page.locator("#panel-context .group").filter({ hasText: "Studio Intel" }),
    ).toContainText("Model inference");
    await expect(page.locator("#panel-context h3 + span")).toHaveCount(0);

    // A source address that is not http or https is named, never linked.
    const film = claimItem(more, "It was used in a 2012 short film.");
    await expect(film).toContainText("Genius · primary record (record track/song/998877)");
    await expect(film.locator("[href]")).toHaveCount(0);

    await screenshot(page, testInfo, "player");
    await screenshot(page, testInfo, "credits", credits);
    await screenshot(page, testInfo, "claims", more);
    expect(problems).toEqual([]);
  });

  test("a value that was not measured shows why", async ({ page }, testInfo) => {
    const key = claimItem(
      page.getByRole("region", { name: "More claims" }),
      "The preview's key, as measured.",
    );
    // Written by code, but its value was not measured: inferred, not the model's.
    await expect(key).toContainText("Inferred");
    await expect(key).not.toContainText("Model inference");
    await expect(key.locator('[data-value-kind="missing"]')).toHaveText(
      "Key not measured— not detected in the preview",
    );
    // The value itself, with the result's measured values.
    await expect(
      page
        .getByRole("list", { name: "Audio values" })
        .getByRole("listitem")
        .filter({ hasText: /^Key/ }),
    ).toHaveText("Key not measured— not detected in the preview");
    await screenshot(page, testInfo, "missing", key);
  });

  test("a conflict with the measurement shows both values", async ({ page }, testInfo) => {
    const more = page.getByRole("region", { name: "More claims" });
    const sleeve = claimItem(more, "The sleeve gives the tempo as 246 BPM.");
    await expect(sleeve).toContainText("Conflict");
    // The measured side is the result's own measurement, as the audio values show it.
    await expect(sleeve).toContainText(
      "Conflict with the measurement: the claim says 246 · measured 123 BPM (essentia.RhythmExtractor2013, 22.4 s preview)",
    );
    await expect(sleeve).toContainText(
      "taken from the source record · no verifier verdict on its text",
    );
    await expect(sleeve).not.toContainText("not checked");
    const noValues = claimItem(more, "It feels like 61 BPM.");
    await expect(noValues).toContainText(
      "Conflict with the measurement: the result does not give the claim's value · measured 123 BPM (essentia.RhythmExtractor2013, 22.4 s preview)",
    );
    // Numbers that agree with the measurement raise no conflict; the check ran.
    const roughly = claimItem(more, "It runs at roughly 123 BPM.");
    await expect(roughly).not.toContainText("Conflict");
    await expect(roughly).toContainText("no verifier verdict on its text");
    await expect(roughly).toContainText("agrees with the measurement · measured 123 BPM");
    // A model sentence stating a wrong measurement, which no check compared, is shown beside
    // the measured value.
    const wrong = claimItem(more, "The preview analysis measured the track at 128 BPM.");
    await expect(wrong).toContainText("Model inference");
    await expect(wrong).toContainText(
      "not compared with the measurement · measured 123 BPM (essentia.RhythmExtractor2013, 22.4 s preview)",
    );
    await screenshot(page, testInfo, "not-compared", wrong);
    await screenshot(page, testInfo, "conflict", sleeve);
  });

  test("contradicted claims appear only in the rejected claims, with their count", async ({
    page,
  }, testInfo) => {
    const rejectedTexts = [
      "Paper Lanterns was first released in 1998.",
      "Mixed by Eve Example.",
      "A horn stab from a 1975 record plays at the bridge.",
      "The band toured Japan in 2009.",
      "The song runs at 90 BPM.",
    ];
    // Five it can read, and one it cannot.
    const button = page.getByRole("button", { name: "Rejected by the verifier (6)" });
    await expect(button).toHaveAttribute("aria-expanded", "false");
    // Collapsed: none of them, nor a card, sample or relation that states one, is on the page.
    for (const text of [
      ...rejectedTexts,
      "A 1998 release",
      "A lighthouse",
      "The band toured Japan in 2012.",
    ]) {
      await expect(page.getByText(text)).toBeHidden();
    }
    const timeline = page.getByRole("group", { name: "Song structure" });
    await expect(timeline.getByRole("img", { name: /^Sample: Vocal chop/ })).toHaveCount(1);
    await expect(timeline.getByRole("img", { name: /Horn stab/ })).toHaveCount(0);
    const graph = page.locator("#panel-genealogy svg");
    await expect(graph.locator("g.nodes > g")).toHaveCount(3);
    await expect(graph.locator("g.links line")).toHaveCount(2);
    await expect(page.locator("#panel-genealogy")).not.toContainText("Rejected Source");
    await expect(page.locator("#panel-genealogy")).toContainText("Kept Influence - Other (2005)");
    // A card whose claim cannot be read is left out, and the page says so.
    await expect(page.locator("#panel-context")).toContainText(
      "1 fact is not shown: this page cannot read the claim it states.",
    );
    await expect(page.getByText("Leaving home")).toHaveCount(0);
    await screenshot(page, testInfo, "rejected-collapsed", button);

    await button.click();
    await expect(button).toHaveAttribute("aria-expanded", "true");
    const panel = page.locator(`[id="${await button.getAttribute("aria-controls")}"]`);
    await expect(panel).toBeVisible();
    await expect(panel.getByRole("listitem")).toHaveCount(5);
    await expect(panel).toContainText("1 more rejected claim could not be read by this page.");
    for (const text of rejectedTexts) {
      // Shown once, in the panel.
      await expect(page.getByText(text)).toHaveCount(1);
      await expect(panel.getByText(text)).toBeVisible();
    }
    await expect(panel).toContainText(
      "Contradicted by its sources: The release credits name Fay Example as the mixer.",
    );
    await expect(panel).toContainText(
      "Contradicted by the measurement: the claim says 90 · measured 123 BPM (essentia.RhythmExtractor2013, 22.4 s preview)",
    );
    // A contradicted credit is not a credit.
    await expect(page.getByRole("region", { name: "Credits" })).not.toContainText("Eve Example");
    await expect(page.getByText("A 1998 release")).toHaveCount(0);
    await screenshot(
      page,
      testInfo,
      "rejected-open",
      page.getByRole("region", { name: "Rejected claims" }),
    );
  });
});

test("on a phone the rejected claims are reachable from the Analysis tab", async ({
  page,
}, testInfo) => {
  await useMockApi(page, provenance);
  await page.setViewportSize({ width: 390, height: 844 });
  await analyzeAndOpenDashboard(page, "Paper Lanterns");
  await openPlayer(page);
  await page.getByRole("tab", { name: "Analysis" }).click();
  const button = page.getByRole("button", { name: "Rejected by the verifier (6)" });
  await button.scrollIntoViewIfNeeded();
  await expect(button).toBeInViewport();
  await button.focus();
  await page.keyboard.press("Enter");
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByText("Mixed by Eve Example.")).toBeVisible();
  // No horizontal scroll on the panel.
  const overflow = await page
    .locator("#panel-context")
    .evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await screenshot(page, testInfo, "mobile-rejected");
});

test("a result without claims says that no credits were found", async ({ page }) => {
  await useMockApi(page, loadFixture("full-result"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  await expect(page.getByRole("region", { name: "Credits" })).toHaveText(
    "CreditsNo credits found in this result.",
  );
  await expect(page.getByRole("button", { name: /Rejected by the verifier/ })).toHaveCount(0);
});

test("model-written credit lists are shown as inference with no source", async ({
  page,
}, testInfo) => {
  await useMockApi(
    page,
    fullResultWith({ credits: { producers: ["Cleo Example"], writers: ["Ada Example"] } }),
  );
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  const credits = page.getByRole("region", { name: "Credits" });
  await expect(credits).toContainText("Model inferencemodel-written, no source cited");
  await expect(credits).toContainText("ProducersCleo ExampleWritersAda Example");
  await expect(credits).not.toContainText("Sourced");
  await screenshot(page, testInfo, "uncited-credits", credits);
});

test("a result built without the model says its facts have no citations", async ({ page }) => {
  await useMockApi(page, loadFixture("decrypt-after-model-unavailable"));
  await analyzeAndOpenDashboard(page, "Quiet Signal");
  await openPlayer(page);
  const insights = page.locator("#panel-context");
  await expect(insights).toContainText("From source data");
  await expect(insights).toContainText(
    "No citations: the facts taken from source records do not link to them.",
  );
});
