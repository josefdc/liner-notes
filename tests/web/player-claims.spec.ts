import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  collectProblems,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";

// Each fact shows the claim it states: its chip (sourced, or the model's inference), a type badge
// read from the claim (a sample the model guessed is a possible sample) and, when the claim is
// sourced, its entities link to the cited source instead of a web search.

// Animations end at once, so positions are final when they are read.
test.use({ reducedMotion: "reduce" });

type Event = { type: string; data?: Record<string, unknown> };

const SOURCE_URL = "https://www.whosampled.com/sample/12345/";
const evidence = [
  {
    id: "ev-whosampled",
    source: "tavily",
    sourceTier: "web",
    url: SOURCE_URL,
    title: "Bright Lines sample of Old Record",
    retrievedAt: "2026-10-20T12:00:00.000Z",
    excerpt: "Bright Lines samples Old Record by The Older Band.",
    recordRef: null,
  },
];
const modelClaim = (id: string, changes: Record<string, unknown>) => ({
  id,
  text: "Bright Lines samples Old Record.",
  about: "sample",
  kind: "inferred",
  origin: "model",
  evidenceIds: [],
  verdict: null,
  verdictReason: null,
  numericCheck: "n/a",
  ...changes,
});
const sourcedClaim = (id: string) =>
  modelClaim(id, { kind: "sourced", evidenceIds: ["ev-whosampled"], verdict: "supported" });
const card = (id: string, title: string, claimId: string) => ({
  id,
  title,
  content: `${title}: the hook samples Old Record by The Older Band.`,
  type: "sample",
  claimId,
  entities: [{ id: `${id}-e1`, text: "Old Record", type: "sample", searchQuery: "Old Record" }],
});

/** full-result with one fact whose claim is sourced and one whose claim is the model's guess. */
function withClaims(more?: Event[]) {
  const fixture = loadFixture("full-result");
  const events = fixture.streams["/api/analyze/stream"] as Event[];
  return {
    ...fixture,
    streams: {
      ...fixture.streams,
      "/api/analyze/stream": events.map((event) =>
        event.type === "complete"
          ? {
              ...event,
              data: {
                ...event.data,
                evidence,
                claims: [sourcedClaim("c-known"), modelClaim("c-guess", {})],
                factoids: [
                  card("f1", "Known Sample", "c-known"),
                  card("f2", "Guessed Sample", "c-guess"),
                ],
              },
            }
          : event,
      ),
      ...(more ? { "/api/factoids/more/stream": more } : {}),
    },
  };
}

/** The card that holds a title, in the Player's analysis panel. */
const cardOf = (page: Page, title: string) =>
  page.locator("#panel-context [data-factoid-category]").filter({ hasText: title });

/** Checks a card whose claim is sourced: its chip, its badge and its link to the source. */
async function expectSourced(card: Locator) {
  await expect(card.locator("[data-claim-kind]")).toHaveAttribute("data-claim-kind", "sourced");
  await expect(card.locator('[data-provenance="sourced"]')).toHaveText("Sourced");
  await expect(card.locator("[data-factoid-type]")).toHaveText("SAMPLE");
  const link = card.getByRole("link", {
    name: "Old Record (sample), opens the cited source in a new tab",
  });
  await expect(link).toHaveAttribute("href", SOURCE_URL);
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
}

/**
 * Text in the analysis panel that reaches past the box that clips it, and badges cut short:
 * none should be. Screen-reader-only text and text hidden at rest are skipped.
 */
function clipped(page: Page) {
  return page.locator("#panel-context").evaluate((panel) => {
    const found: string[] = [];
    const walker = document.createTreeWalker(panel, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim();
      const parent = node.parentElement;
      if (!text || !parent || parent.closest("svg, .sr-only")) continue;
      let clip: HTMLElement | null = parent;
      while (clip && getComputedStyle(clip).overflowX === "visible") clip = clip.parentElement;
      if (!clip) continue;
      const box = clip.getBoundingClientRect();
      const left = box.left + clip.clientLeft;
      const right = left + clip.clientWidth;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const line of range.getClientRects()) {
        if (line.width === 0) continue;
        const over = Math.max(left - line.left, line.right - right);
        if (over > 0.5) found.push(`${text.slice(0, 50)} (${Math.round(over)} px)`);
      }
    }
    for (const badge of panel.querySelectorAll<HTMLElement>("[data-factoid-type]")) {
      if (badge.scrollWidth > badge.clientWidth + 0.5) found.push(`badge ${badge.textContent}`);
    }
    if (panel.scrollWidth > panel.clientWidth) found.push("the panel scrolls sideways");
    return found;
  });
}

for (const [width, height] of [
  [390, 844],
  [1440, 900],
] as const) {
  test(`at ${width} px each fact shows its claim's chip, badge and source link`, async ({
    page,
  }) => {
    const problems = collectProblems(page);
    await page.setViewportSize({ width, height });
    await useMockApi(page, withClaims());
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await openPlayer(page);
    if (width < 768) await page.getByRole("tab", { name: "Analysis" }).click();

    const known = cardOf(page, "Known Sample");
    await known.scrollIntoViewIfNeeded();
    await expect(known).toBeVisible();
    await expectSourced(known);

    const guessed = cardOf(page, "Guessed Sample");
    await guessed.scrollIntoViewIfNeeded();
    await expect(guessed.locator('[data-provenance="inferred"]')).toHaveText("Model inference");
    await expect(guessed.locator("[data-factoid-type]")).toHaveText("POSSIBLE SAMPLE");
    await expect(guessed.getByRole("link")).toHaveCount(0);
    await expect(guessed.getByRole("button")).toHaveCount(0);
    await expect(guessed).toContainText("Old Record");

    // No web search anywhere on the page.
    await expect(page.locator('a[href*="google.com"]')).toHaveCount(0);
    expect(await clipped(page)).toEqual([]);
    expect(problems).toEqual([]);
  });
}

test("a fact more facts added shows the claim it came with", async ({ page }) => {
  const problems = collectProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(
    page,
    withClaims([
      { type: "connected", nextRound: 1, roundsLeft: true } as Event,
      {
        type: "factoid",
        data: card("fc-aaaaaaaaaaaa", "Added Sample", "fc-aaaaaaaaaaaa"),
        claim: sourcedClaim("fc-aaaaaaaaaaaa"),
      } as Event,
      { type: "done" },
    ]),
  );
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);

  await page
    .locator("#panel-context")
    .getByRole("button", { name: "Find more facts", exact: true })
    .click();
  const added = page
    .getByRole("region", { name: "More facts" })
    .locator("[data-factoid-category]")
    .filter({ hasText: "Added Sample" });
  await expect(added).toBeVisible();
  await expectSourced(added);
  expect(await clipped(page)).toEqual([]);
  expect(problems).toEqual([]);
});
