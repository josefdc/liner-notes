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
// connections and the recording label; it has no credit or history claims, so the provenance
// mock stands in for those.

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

test("the recorded run's notes: sections in order, a hedged sample with its source", async ({
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

  // The sample the model reported, which no card shows: named as a possible sample (its claim is
  // the model's, not confirmed by a source), with the record it cites beside it.
  const samples = page.getByRole("region", { name: "Samples and covers" });
  expect(await listed(page, "Samples and covers")).toEqual([
    "Possible sampleDaft Punk’s recording samples “More Spell on You” by Eddie Johns.",
  ]);
  await expect(samples.locator("[data-claim-kind]")).toHaveAttribute("data-claim-kind", "inferred");
  await expect(samples.locator('a[data-source="musicbrainz"]')).toHaveAttribute(
    "href",
    "https://musicbrainz.org/recording/60fa767a-d85d-4991-82bc-4294e0b11ae7",
  );
  // The other sample claim is on a fact card: counted, not listed twice.
  await expect(samples).toContainText("1 claim of this section is shown with the facts above.");

  // The recording has no credit or history claims: each section says so, and lists nothing.
  await expect(page.getByRole("region", { name: "Credits" })).toContainText(
    "No credits found in this result.",
  );
  const history = page.getByRole("region", { name: "History" });
  await expect(history).toContainText("No history was found in this result.");
  await expect(history.getByRole("listitem")).toHaveCount(0);

  // The connections stay reachable without a pointer: the graph's tracks are in the Tab order,
  // and its links are written out as a list.
  const genealogy = page.locator("#panel-genealogy");
  await expect(genealogy.locator('svg [tabindex="0"]')).toHaveCount(1);
  await expect(genealogy.getByText(/Links as a list \(2\)/)).toBeVisible();

  // The result is labelled as the recording it is.
  await expect(page.getByText(/Recorded run/).first()).toBeVisible();
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
