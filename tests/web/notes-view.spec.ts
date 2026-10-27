import { expect, type Page, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  loadFixture,
  openPlayer,
  replayedRecording,
  useMockApi,
} from "./mock";
import { offline } from "./offline";

// The liner notes: below the fact cards, the Player's notes panel lists the result's claims in
// sections, in this order: credits, samples and covers, history, then every other claim ("More
// claims"); then the claims the verifier rejected and where the data comes from. Each section
// has an h2 under the track's h1; a relation is named in the words the graph and the cards use,
// hedged ("Possible sample") unless a source supports it; each claim cites its sources beside it.
// A section with nothing to list says so in a sentence: nothing is made up to fill it.
//
// Two showcases: the recorded run (fixtures/replays/one-more-time-daft-punk.json) for samples,
// covers, connections and the recording label. It has no history claims and no real credit: its
// one "credit" is the album the track appears on, a release fact the model filed as a credit
// (shown on a fact card; #216 addresses it). So the provenance mock stands in for credits and
// history. The genealogy-kinds mock holds the samples no verdict supports.

// Animations end at once, so positions are final when they are read.
test.use({ reducedMotion: "reduce" });

// Nothing leaves the machine: the recording's cover and any other outside address are answered
// on the page.
test.beforeEach(async ({ page }) => {
  await offline(page);
});

/** The notes panel's section headings, in the page's order, with their levels. */
function sectionHeadings(page: Page) {
  return page
    .locator("#panel-context")
    .evaluate((panel) =>
      [...panel.querySelectorAll("h2, h3")].map(
        (heading) => `${heading.tagName}:${heading.textContent?.trim()}`,
      ),
    );
}

/** The claims a section lists: each as its label ("Possible sample") and its text. */
function listed(page: Page, section: string) {
  return page
    .getByRole("region", { name: section, exact: true })
    .getByRole("listitem")
    .evaluateAll((items) =>
      items
        .filter((item) => item.querySelector(":scope > p"))
        .map((item) => item.querySelector(":scope > p")?.textContent?.trim() ?? ""),
    );
}

async function openRecording(page: Page) {
  const { events } = replayedRecording();
  await useMockApi(page, {
    suggestions: [],
    eventGapMs: 0,
    streams: { "/api/analyze/stream": events },
  });
  await analyzeAndOpenDashboard(page, "One More Time Daft Punk");
  await openPlayer(page);
}

test("the recorded run's notes: sections in order, its samples and covers with their sources", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await openRecording(page);

  // The h1 is the track; the notes' sections are h2s, in the liner notes' order.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("One More Time");
  expect(await sectionHeadings(page)).toEqual([
    "H2:Facts",
    "H2:Credits",
    "H2:Samples and covers",
    "H2:History",
    "H2:More claims",
    "H2:Data from",
  ]);

  // The relations no card shows, first the model's claims the verifier found supported, then
  // those built from the MusicBrainz records: each named as what it is (no "Possible"), sourced,
  // with the record it cites beside it.
  const samples = page.getByRole("region", { name: "Samples and covers" });
  const rows = await listed(page, "Samples and covers");
  expect(rows).toHaveLength(16);
  expect(rows[0]).toBe("SampleDaft Punk’s recording samples Eddie Johns’s “More Spell on You.”");
  for (const row of rows) expect(row).toMatch(/^(Sample|Remix|Cover)[^ ]/);
  const items = samples.getByRole("listitem").filter({ has: page.locator(":scope > p") });
  await expect(items).toHaveCount(16);
  for (const item of await items.all()) {
    await expect(item.locator('a[data-source="musicbrainz"]')).toHaveCount(1);
    await expect(item).toContainText("Sourced");
  }
  await expect(items.first().locator('a[data-source="musicbrainz"]')).toHaveAttribute(
    "href",
    "https://musicbrainz.org/recording/60fa767a-d85d-4991-82bc-4294e0b11ae7",
  );
  // The sample claim on a fact card is counted, not listed twice.
  await expect(samples).toContainText("1 claim of this section is shown with the facts above.");

  // The recording's one "credit" is a release fact (the album the track appears on) the model
  // filed as a credit (#216 addresses it); it is on a fact card: counted, not listed twice. It has
  // no history claim: the section says so, and lists nothing.
  await expect(page.getByRole("region", { name: "Credits" })).toContainText(
    "1 credit is shown with the facts above.",
  );
  const history = page.getByRole("region", { name: "History" });
  await expect(history).toContainText("No history was found in this result.");
  await expect(history.getByRole("listitem")).toHaveCount(0);

  // The connections stay reachable without a pointer: the graph's tracks are in the Tab order,
  // and its links are written out as a list.
  const genealogy = page.locator("#panel-genealogy");
  await expect(genealogy.locator('svg [tabindex="0"]')).toHaveCount(1);
  await expect(genealogy.getByText(/Links as a list \(9\)/)).toBeVisible();

  // The result is labelled as the recording it is.
  await expect(page.getByText(/Recorded run/).first()).toBeVisible();
  expect(problems).toEqual([]);
});

// A sample the model reported that no verifier verdict supports is hedged ("Possible sample"),
// whether it is a claim or a drawn link, and keeps the record it cites beside it.
test("a sample no verdict supports is listed as possible, with the record it cites", async ({
  page,
}) => {
  const problems = collectProblems(page);
  const fixture = loadFixture("genealogy-kinds");
  const complete = fixture.streams["/api/analyze/stream"].find(
    (event: { type: string }) => event.type === "complete",
  );
  // The model's sample claim, as a run whose judge gave no verdict sends it: inferred.
  for (const claim of complete.data.claims) {
    if (claim.id === "cl-supported") Object.assign(claim, { kind: "inferred", verdict: null });
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, fixture);
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);

  const samples = page.getByRole("region", { name: "Samples and covers" });
  const rows = await listed(page, "Samples and covers");
  expect(rows[0]).toBe("Possible sampleBright Lines samples Verified Model Sample.");
  const claim = samples.getByRole("listitem").filter({ hasText: "Verified Model Sample." }).first();
  await expect(claim.locator("[data-claim-kind]")).toHaveAttribute("data-claim-kind", "inferred");
  await expect(claim.locator('a[data-source="musicbrainz"]')).toHaveAttribute(
    "href",
    "https://musicbrainz.org/recording/00000000-0000-4000-8000-000000000001",
  );
  // The model's link that says it is sourced but has no supporting verdict: hedged too, its
  // citation named.
  expect(rows).toContain(
    "Possible sampleBright Lines (2011) may sample Model Says Sourced - Someone (1983).",
  );
  await expect(
    samples.getByRole("listitem").filter({ hasText: "Model Says Sourced" }),
  ).toContainText("no verifier verdict supports it; cites ev-mb-1 (MusicBrainz)");
  expect(problems).toEqual([]);
});

test("the provenance result's notes: credits, then samples, then history with their sources", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, loadFixture("provenance"));
  await analyzeAndOpenDashboard(page, "Paper Lanterns");
  await openPlayer(page);

  expect(await sectionHeadings(page)).toEqual([
    "H2:Facts",
    "H2:Credits",
    "H2:Samples and covers",
    "H2:History",
    "H2:More claims",
    "H2:Data from",
  ]);

  // Credits first, as written, each with its source.
  expect(await listed(page, "Credits")).toEqual([
    "Written by Ada Example and Ben Example.",
    "Produced by Cleo Example and engineered by Dev Example.",
    "Mastered by Gil Example.",
  ]);

  // The model's guess at a sample, hedged; the sample the verifier contradicted is not here.
  expect(await listed(page, "Samples and covers")).toEqual([
    "Possible sampleA vocal chop from an older record opens the song.",
  ]);

  // The history claims no card shows, each with its source in the margin: its name and tier,
  // linked, and the day it was retrieved. The rejected one (the band's 2009 tour) is not listed.
  expect(await listed(page, "History")).toEqual([
    "HistoryThe single reached the top 40.",
    "HistoryA blog calls it the band's breakthrough.",
  ]);
  const history = page.getByRole("region", { name: "History" });
  const blog = history.getByRole("listitem").filter({ hasText: "breakthrough" });
  await expect(blog.locator("[data-source-note]")).toContainText("Web search · web page");
  await expect(blog.locator("[data-source-note] time")).toHaveCount(1);
  await expect(blog.locator('a[data-source="tavily"]')).toHaveAttribute(
    "href",
    "https://blog.example.net/paper-lanterns",
  );
  await expect(history).toContainText("1 claim of this section is shown with the facts above.");
  await expect(history).not.toContainText("toured Japan");

  // "More claims" holds what is left: no history, sample or credit claim again.
  const more = await listed(page, "More claims");
  expect(more.length).toBeGreaterThan(0);
  for (const text of more) expect(text).not.toMatch(/^(History|Possible sample|Sample|Credit)/);
  expect(problems).toEqual([]);
});

test("a section whose every claim the verifier rejected says so, and invents nothing", async ({
  page,
}) => {
  const fixture = loadFixture("provenance");
  const complete = fixture.streams["/api/analyze/stream"].find(
    (event: { type: string }) => event.type === "complete",
  );
  // Only the contradicted sample is left.
  complete.data.claims = complete.data.claims.filter(
    (claim: { id: string }) => claim.id !== "c-sample-kept",
  );
  complete.data.samples = complete.data.samples.filter(
    (sample: { claimId?: string }) => sample.claimId !== "c-sample-kept",
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, fixture);
  await analyzeAndOpenDashboard(page, "Paper Lanterns");
  await openPlayer(page);

  const samples = page.getByRole("region", { name: "Samples and covers" });
  await expect(samples).toContainText(
    "The samples and covers found were rejected by the verifier (listed below).",
  );
  await expect(samples.getByRole("listitem")).toHaveCount(0);
});

// A result with no claims (stored before claims existed) whose graph draws a sample and whose
// timeline marks one: the samples section lists the drawn relation in the graph's words, hedged
// as the link is not sourced, and never says that none were found.
test("a sample the graph draws without a claim is listed, hedged, with where it comes from", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, loadFixture("full-result"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  const samples = page.getByRole("region", { name: "Samples and covers" });
  expect(await listed(page, "Samples and covers")).toEqual([
    "Possible sampleBright Lines - Test Artist (2011) may sample Older Record - Someone (1984).",
  ]);
  await expect(samples.locator("[data-relation-link]")).toHaveAttribute(
    "data-relation-link",
    "inferred",
  );
  await expect(samples).toContainText("Drawn in Connections · Model inference");
  await expect(samples).not.toContainText("No samples or covers were found");
  // The graph names it the same way.
  await expect(page.locator("#panel-genealogy")).toContainText("Possible sample");
});

test("a sample only the timeline marks is said, not denied", async ({ page }) => {
  const fixture = loadFixture("full-result");
  const complete = fixture.streams["/api/analyze/stream"].find(
    (event: { type: string }) => event.type === "complete",
  );
  complete.data.genealogy.links = [];
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, fixture);
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  const samples = page.getByRole("region", { name: "Samples and covers" });
  await expect(samples).toContainText(
    "The timeline marks 1 possible sample; no claim or connection in this result states it.",
  );
  await expect(samples.getByRole("listitem")).toHaveCount(0);
});

// A sample time the timeline cannot draw (past the song's end) is not counted as marked: it is
// listed in the section with its description, its time said as the model's and not drawn.
test("a sample the timeline cannot draw is listed, not counted as marked", async ({ page }) => {
  const fixture = loadFixture("full-result");
  const complete = fixture.streams["/api/analyze/stream"].find(
    (event: { type: string }) => event.type === "complete",
  );
  complete.data.genealogy.links = [];
  complete.data.samples = [{ time: 9999, description: "A horn stab from an old record" }];
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, fixture);
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  const samples = page.getByRole("region", { name: "Samples and covers" });
  expect(await listed(page, "Samples and covers")).toEqual([
    "Possible sampleA horn stab from an old record.",
  ]);
  await expect(samples).toContainText(
    "Time inferred by the model: 166:39 · outside the song, not drawn",
  );
  await expect(samples).not.toContainText("The timeline marks");
});
