import { expect, type Page, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  DEMO_SLUG,
  loadFixture,
  openPlayer,
  PREVIOUS_SHOWCASES,
  replayedRecording,
  showcaseRecordings,
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
// Two showcases: the recorded run as recorded before the golden run
// (fixtures/pinned/9971adea845d/one-more-time-daft-punk.json, whose exact text this pins) for samples,
// covers, connections and the recording label; the same checks of order and relations run on the
// demo as the golden run recorded it (fixtures/replays), and each showcase is checked on its own. It has no history claims and no credit: its one
// "credit" was the album the track appears on, a release fact the model filed as a credit, and
// the replay leaves it out with the other model claims that restate a code-built claim. So the
// provenance mock stands in for credits and history. The genealogy-kinds mock holds the samples
// no verdict supports.

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

async function openRecording(
  page: Page,
  slug?: string,
  query = "One More Time Daft Punk",
  dir?: string,
) {
  const { events } = replayedRecording(slug, undefined, dir);
  await useMockApi(page, {
    suggestions: [],
    eventGapMs: 0,
    streams: { "/api/analyze/stream": events },
  });
  await analyzeAndOpenDashboard(page, query);
  await openPlayer(page);
}

/** The fact cards above the notes: each as its badge and its text, and how many badges it shows. */
function shownCards(page: Page) {
  return page.locator("#panel-context [data-factoid-category]").evaluateAll((found) =>
    found.map((card) => ({
      badges: card.querySelectorAll("[data-factoid-type]").length,
      text: `${card.querySelector("[data-factoid-type]")?.textContent?.trim()}: ${card.textContent}`,
    })),
  );
}

/** Every claim the notes list, in any section: each as its label and its text. */
function everyClaimListed(page: Page) {
  return page
    .locator("#panel-context li")
    .evaluateAll((items) =>
      items
        .filter((item) => item.querySelector(":scope > p"))
        .map((item) => item.querySelector(":scope > p")?.textContent?.trim() ?? ""),
    );
}

test("the recorded run's notes: sections in order, its samples and covers with their sources", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // One More Time as recorded before the golden run, whose exact claims and cards this pins.
  await openRecording(page, DEMO_SLUG, undefined, PREVIOUS_SHOWCASES);

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

  // The relations no card shows, built from the MusicBrainz records: each named as what it is
  // (no "Possible"), sourced, with the record it cites beside it. The model's claims that only
  // restated one of them are left out: each fact is listed once, by its record, and never also
  // as a guess ("Possible …") beside it.
  const samples = page.getByRole("region", { name: "Samples and covers" });
  const rows = await listed(page, "Samples and covers");
  expect(rows).toHaveLength(13);
  expect(rows[0]).toBe(
    'Sample"One More Time" by Daft Punk samples "More Spell on You" by Eddie Johns.',
  );
  for (const row of rows) expect(row).toMatch(/^(Sample|Remix|Cover)[^ ]/);
  // Every claim the notes list, in any section, and every fact card, "Possible" ones included: a
  // relation a record documents is listed once, by its record, and never named "Possible" beside
  // it. The model's one card ("MusicBrainz documents … as a source sampled in this recording of
  // …") only restated the Eddie Johns record: it is left out with its claim, so no card is shown.
  const cards = await shownCards(page);
  expect(cards).toEqual([]);
  // The Facts panel says so, not that none was found, and more may still be asked for.
  const facts = page.locator("#panel-context");
  await expect(
    facts.getByText("Every fact found here is already listed with its source below.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(facts.getByText("No facts were found for this track.")).toHaveCount(0);
  await expect(facts.getByRole("button", { name: "Find more facts", exact: true })).toBeVisible();
  const everyClaim = await everyClaimListed(page);
  expect(everyClaim.length).toBeGreaterThan(rows.length);
  for (const fact of [/More Spell on You/, /Circo Loco/, /London Elektricity/]) {
    expect(
      everyClaim.filter((claim) => fact.test(claim)),
      String(fact),
    ).toHaveLength(1);
  }
  for (const claim of everyClaim) expect(claim).not.toMatch(/^possible (sample|cover|remix)/i);
  const items = samples.getByRole("listitem").filter({ has: page.locator(":scope > p") });
  await expect(items).toHaveCount(13);
  for (const item of await items.all()) {
    await expect(item.locator('a[data-source="musicbrainz"]')).toHaveCount(1);
    await expect(item).toContainText("Sourced");
  }

  await expect(
    items
      .filter({ hasText: '"More Spell on You" by Eddie Johns.' })
      .first()
      .locator('a[data-source="musicbrainz"]'),
  ).toHaveAttribute(
    "href",
    "https://musicbrainz.org/recording/60fa767a-d85d-4991-82bc-4294e0b11ae7",
  );
  // No claim of this section is on a card.
  await expect(samples).not.toContainText("shown with the facts above");

  // The release the track appears on is stated once, in "More claims", by its MusicBrainz record:
  // the model's two copies (one filed as a credit, on a fact card) are left out. The recording has
  // no credit and no history claim: each section says so, and lists nothing.
  const release = (await listed(page, "More claims")).filter((row) => /Discovery/.test(row));
  expect(release).toEqual([
    'Track"One More Time" by Daft Punk appears on the official album "Discovery" (2001-02-26).',
  ]);
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
  await expect(genealogy.getByText(/Links as a list \(9\)/)).toBeVisible();
  // On the map too, each relation is drawn once, by its record: no second node or inferred link
  // of the model's beside it.
  const links = genealogy.locator('ul[aria-label="Genealogy links"] > li');
  await expect(links).toHaveCount(9);
  expect(
    await links.evaluateAll((all) => all.map((link) => link.getAttribute("data-link-kind"))),
  ).toEqual(Array(9).fill("sourced"));
  for (const fact of [/More Spell on You/, /Circo Loco/]) {
    await expect(links.filter({ hasText: fact }), String(fact)).toHaveCount(1);
  }
  const nodes = await genealogy
    .locator("svg g.nodes > g[data-node-id]")
    .evaluateAll((all) => all.map((node) => node.getAttribute("data-node-id")));
  expect(nodes).toHaveLength(10);
  expect(new Set(nodes).size).toBe(nodes.length);

  // The result is labelled as the recording it is.
  await expect(page.getByText(/Recorded run/).first()).toBeVisible();
  expect(problems).toEqual([]);
});

test("the demo's notes as served now: sections in order, each relation by its record", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // One More Time as the golden run recorded it (fixtures/replays), the demo the page opens.
  await openRecording(page, DEMO_SLUG);

  await expect(page.getByRole("heading", { level: 1 })).toHaveText("One More Time");
  expect(await sectionHeadings(page)).toEqual([
    "H2:Facts",
    "H2:Credits",
    "H2:Samples and covers",
    "H2:History",
    "H2:More claims",
    "H2:Data from",
  ]);
  // Each relation its MusicBrainz records document: named as what it is, sourced, its record
  // beside it, the Eddie Johns sample first.
  const samples = page.getByRole("region", { name: "Samples and covers" });
  const rows = await listed(page, "Samples and covers");
  expect(rows).toHaveLength(13);
  expect(rows[0]).toBe(
    'Sample"One More Time" by Daft Punk samples "More Spell on You" by Eddie Johns.',
  );
  for (const row of rows) expect(row).toMatch(/^(Sample|Remix|Cover)[^ ]/);
  const items = samples.getByRole("listitem").filter({ has: page.locator(":scope > p") });
  await expect(items).toHaveCount(13);
  for (const item of await items.all()) {
    await expect(item.locator('a[data-source="musicbrainz"]')).toHaveCount(1);
    await expect(item).toContainText("Sourced");
  }
  await expect(
    items
      .filter({ hasText: '"More Spell on You" by Eddie Johns.' })
      .first()
      .locator('a[data-source="musicbrainz"]'),
  ).toHaveAttribute(
    "href",
    "https://musicbrainz.org/recording/60fa767a-d85d-4991-82bc-4294e0b11ae7",
  );
  const everyClaim = await everyClaimListed(page);
  for (const claim of everyClaim) expect(claim).not.toMatch(/^possible (sample|cover|remix)/i);
  for (const fact of [/More Spell on You/, /Circo Loco/, /London Elektricity/]) {
    expect(
      everyClaim.filter((claim) => fact.test(claim)),
      String(fact),
    ).toHaveLength(1);
  }
  // Two cards, each with one badge: the sample card (which restates the Eddie Johns record in
  // words the reader does not know yet) and the album card, partly supported and shown so.
  const cards = await shownCards(page);
  expect(cards.map((card) => card.badges)).toEqual([1, 1]);
  expect(cards[0].text).toMatch(/^SAMPLE: .*More Spell on You/);
  expect(cards[1].text).toMatch(/^CREDITS: .*Discovery.*Partly supported/);
  // Its one credit is the album card, said so where credits are listed; no history claim.
  await expect(page.getByRole("region", { name: "Credits" })).toContainText(
    "1 credit is shown with the facts above.",
  );
  const history = page.getByRole("region", { name: "History" });
  await expect(history).toContainText("No history was found in this result.");
  await expect(history.getByRole("listitem")).toHaveCount(0);

  // The map: nine links, each built from a record, each relation drawn once.
  const genealogy = page.locator("#panel-genealogy");
  await expect(genealogy.getByText(/Links as a list \(9\)/)).toBeVisible();
  const links = genealogy.locator('ul[aria-label="Genealogy links"] > li');
  await expect(links).toHaveCount(9);
  expect(
    await links.evaluateAll((all) => all.map((link) => link.getAttribute("data-link-kind"))),
  ).toEqual(Array(9).fill("sourced"));
  for (const fact of [/More Spell on You/, /Circo Loco/]) {
    await expect(links.filter({ hasText: fact }), String(fact)).toHaveCount(1);
  }
  const nodes = await genealogy
    .locator("svg g.nodes > g[data-node-id]")
    .evaluateAll((all) => all.map((node) => node.getAttribute("data-node-id")));
  expect(nodes).toHaveLength(10);
  expect(new Set(nodes).size).toBe(nodes.length);
  await expect(page.getByText(/Recorded run/).first()).toBeVisible();
  expect(problems).toEqual([]);
});

// Each showcase recording (fixtures/replays: the golden run's, one entry here for every slug):
// every relation its records document is listed once in the notes, by its record, and never named
// "Possible" there or on a card. A card that states a record's relation is named as the record
// names it (Hung Up's ABBA sample, One More Time's Eddie Johns sample); the others are named by
// their own subject. Each fact is found by its other track's artist or title: the map's second hop
// lists other tracks that sample the same records, by title alone. A fact given as
// `{ fact, alsoIn }` is also stated by one model claim the notes list beside its record, in
// another subject, which one claim per fact does not read as the record: Hung Up's history claim
// "MusicBrainz lists three remixes of this recording: …", supported by the three records it
// cites, is about history, not a relation, and lists the records in a sentence of its own, so
// neither a restatement nor a mark (agent/restatements.ts reads a relation's own subjects and
// templates only). That claim is pinned here for that fact alone, listed once, and never named
// "Possible"; every other fact is still listed once.
type Fact = RegExp | { fact: RegExp; alsoIn: RegExp };
const DOCUMENTED: Record<string, { facts: Fact[]; cards: RegExp[] }> = {
  "hung-up-madonna": {
    facts: [
      /ABBA/,
      {
        fact: /SDP extended vocal/,
        alsoIn: /^HistoryMusicBrainz lists three remixes of this recording/,
      },
    ],
    cards: [/^SAMPLE: .*ABBA/i, /^TRIVIA: .*Chus & Ceballos/i],
  },
  "natural-blues-moby": {
    facts: [/Vera Hall/, /Paolo Nutini/, /Little Hurricane/],
    cards: [/^TRIVIA: .*remixes/i],
  },
  "one-more-time-daft-punk": {
    facts: [/More Spell on You/, /Circo Loco/, /Get It Get It/],
    // The sample card restates the Eddie Johns record in words the reader does not know yet
    // ("… as a recording sampled in …": UNREAD in apps/api/src/replay/restated-showcases.test.ts).
    cards: [/^SAMPLE: .*More Spell on You/i, /^CREDITS: .*Discovery/i],
  },
  "praise-you-fatboy-slim": {
    facts: [/Camille Yarbrough/, /Fedde Le Grand/, /Super Mash Bros/],
    // A production claim the judge found partly supported: shown so beside its source.
    cards: [/^PRODUCTION: .*Balance & Rehearsal.*Partly supported/i],
  },
  "the-verve-bitter-sweet-symphony": {
    facts: [/Andrew Oldham/, /Once Again/, /James Lavelle/],
    cards: [],
  },
};

for (const { slug, query } of showcaseRecordings()) {
  test(`the ${slug} recording lists each documented relation once, never as possible`, async ({
    page,
  }) => {
    const problems = collectProblems(page);
    const expected = DOCUMENTED[slug];
    expect(expected, slug).toBeDefined();
    await page.setViewportSize({ width: 1440, height: 900 });
    await openRecording(page, slug, query);

    const cards = await shownCards(page);
    expect(cards).toHaveLength(expected.cards.length);
    cards.forEach((card, i) => {
      expect(card.badges, card.text).toBe(1);
      expect(card.text).toMatch(expected.cards[i]);
      expect(card.text).not.toMatch(/^possible/i);
    });
    const everyClaim = await everyClaimListed(page);
    for (const claim of everyClaim) expect(claim).not.toMatch(/^possible (sample|cover|remix)/i);
    for (const each of expected.facts) {
      const { fact, alsoIn } = each instanceof RegExp ? { fact: each, alsoIn: null } : each;
      if (alsoIn) {
        const restating = everyClaim.filter((claim) => alsoIn.test(claim));
        expect(restating, String(alsoIn)).toHaveLength(1);
        expect(restating[0], String(alsoIn)).toMatch(fact);
      }
      const listed = everyClaim.filter((claim) => fact.test(claim) && !alsoIn?.test(claim));
      expect(listed, String(fact)).toHaveLength(1);
      expect(listed[0], String(fact)).toMatch(/^(Sample|Remix|Cover)[^ ]/);
      // Shown with the facts above only by a card that says more, as expected above.
      const carded = cards.filter((card) => fact.test(card.text));
      expect(carded.length, String(fact)).toBeLessThanOrEqual(1);
    }
    expect(problems).toEqual([]);
  });
}

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
