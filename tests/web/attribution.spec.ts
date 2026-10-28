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

// Where the data comes from: the Player's notes end with "Data from", one entry per provider whose
// data the page shows, each linked back to the provider (Spotify to the track's own page): the
// sources the listed claims and the drawn links cite, Spotify when the result links to the track,
// and the provider of the preview when the page plays it or shows what was measured on it. A
// provider whose data is not shown is not listed. Each claim keeps its own source link.

// Animations end at once, so positions are final when they are read.
test.use({ reducedMotion: "reduce" });

// Nothing leaves the machine: the recording's cover and any other outside address are answered
// on the page.
test.beforeEach(async ({ page }) => {
  await offline(page);
});

const ANALYZE = "/api/analyze/stream";
// A Deezer clip address: never fetched (the page is kept off the network, above).
const DEEZER_CLIP = "https://cdnt-preview.dzcdn.net/api/1/1/a/b/0/7.mp3";

/** The providers "Data from" lists: each as its name and its link (null: named, not linked). */
async function providers(page: Page) {
  const list = page.getByRole("list", { name: "Data providers" });
  await expect(list).toBeVisible();
  return list.getByRole("listitem").evaluateAll((items) =>
    items.map((item) => ({
      provider: item.getAttribute("data-provider"),
      text: item.textContent?.replace(", opens in a new tab", "").trim(),
      href: item.querySelector("a")?.getAttribute("href") ?? null,
    })),
  );
}

/** A fixture's result event, to change before the mock serves it. */
function completeOf(fixture: { streams: Record<string, Array<{ type: string; data?: unknown }>> }) {
  const complete = fixture.streams[ANALYZE].find((event) => event.type === "complete");
  return complete?.data as Record<string, unknown> & {
    claims: Array<Record<string, unknown>>;
    evidence: Array<Record<string, unknown>>;
  };
}

test("the recorded run credits MusicBrainz, its cover's archive, Spotify and Deezer's preview, and no uncited source", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const { events } = replayedRecording();
  await useMockApi(page, { suggestions: [], eventGapMs: 0, streams: { [ANALYZE]: events } });
  await analyzeAndOpenDashboard(page, "One More Time Daft Punk");
  await openPlayer(page);

  // The claims and links cite MusicBrainz; the cover shown is the Cover Art Archive's (answered
  // on the page here); the track is Spotify's match, linked there; the audio was measured on
  // Deezer's preview (the result's `preview`), so Deezer is credited though no clip plays. The
  // web pages in the evidence pack are cited by no claim: no web search is credited.
  expect(await providers(page)).toEqual([
    { provider: "musicbrainz", text: "MusicBrainz", href: "https://musicbrainz.org" },
    {
      provider: "coverartarchive",
      text: "Cover Art Archive (cover art)",
      href: "https://coverartarchive.org/release/bd3bb36e-16c8-438f-850e-dfbf4d1478f0",
    },
    {
      provider: "spotify",
      text: "Spotify (track details)",
      href: "https://open.spotify.com/track/0DiWol3AO6WpXZgp0goxAV",
    },
    { provider: "deezer", text: "Deezer (preview)", href: "https://www.deezer.com" },
  ]);
  // Each link back opens in a new tab, and gives the opened page no hold on this one.
  for (const link of await page
    .getByRole("list", { name: "Data providers" })
    .getByRole("link")
    .all()) {
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  // Each claim keeps its own source link beside it: one MusicBrainz link per listed claim.
  const listedClaims = page
    .getByRole("region", { name: "Samples and covers" })
    .getByRole("listitem")
    .filter({ has: page.locator(":scope > p") });
  await expect(listedClaims).toHaveCount(16);
  for (const claim of await listedClaims.all()) {
    await expect(claim.locator('a[data-source="musicbrainz"]')).toHaveCount(1);
  }
  // A replayed result says it is a recording.
  await expect(page.getByLabel("Recorded run").first()).toContainText("Recorded run");
  expect(problems).toEqual([]);
});

test("a Last.fm source a shown claim cites is credited and linked; Discogs and the rest as cited", async ({
  page,
}) => {
  const fixture = loadFixture("provenance");
  const result = completeOf(fixture);
  result.evidence.push({
    id: "ev-lastfm",
    source: "lastfm",
    sourceTier: "editorial",
    url: "https://www.last.fm/music/Test+Artist/_/Paper+Lanterns",
    title: "Paper Lanterns — Last.fm",
    retrievedAt: "2026-10-20T12:00:00.000Z",
    excerpt: "Listeners tag it as dream pop.",
    recordRef: null,
  });
  result.claims.push({
    id: "c-lastfm",
    text: "Listeners on Last.fm tag it as dream pop.",
    about: "trivia",
    kind: "sourced",
    origin: "code",
    evidenceIds: ["ev-lastfm"],
    verdict: null,
    verdictReason: null,
    numericCheck: "n/a",
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, fixture);
  await analyzeAndOpenDashboard(page, "Paper Lanterns");
  await openPlayer(page);

  // The audio was measured on a preview the result names no provider for: said as such, and no
  // provider (Deezer) is guessed.
  expect(await providers(page)).toEqual([
    { provider: "musicbrainz", text: "MusicBrainz", href: "https://musicbrainz.org" },
    { provider: "discogs", text: "Discogs", href: "https://www.discogs.com" },
    { provider: "lastfm", text: "Last.fm", href: "https://www.last.fm" },
    { provider: "genius", text: "Genius", href: "https://genius.com" },
    {
      provider: "spotify",
      text: "Spotify (track details)",
      href: "https://open.spotify.com/track/t-provenance",
    },
    {
      provider: "preview",
      text: "A preview clip (the audio was measured on it; this result does not name its provider)",
      href: null,
    },
    {
      provider: "tavily",
      text: "Web search (each page is linked beside its claim)",
      href: null,
    },
  ]);
  // The claim keeps its own link to the Last.fm page.
  await expect(
    page
      .locator("#panel-context li")
      .filter({ hasText: "dream pop" })
      .locator('a[data-source="lastfm"]'),
  ).toHaveAttribute("href", "https://www.last.fm/music/Test+Artist/_/Paper+Lanterns");
});

test("a provider whose data is not shown is not credited", async ({ page }) => {
  const fixture = loadFixture("provenance");
  const result = completeOf(fixture);
  // Only the claims citing nothing are left, the track names no Spotify page and nothing was
  // measured: no provider's data is on the page.
  result.claims = result.claims.filter(
    (claim) => Array.isArray(claim.evidenceIds) && claim.evidenceIds.length === 0,
  );
  result.spotifyUrl = undefined;
  result.audio = null;
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, fixture);
  await analyzeAndOpenDashboard(page, "Paper Lanterns");
  await openPlayer(page);

  await expect(page.locator("#panel-context")).toContainText("More claims");
  await expect(page.getByRole("region", { name: "Data from" })).toHaveCount(0);
  await expect(page.getByRole("list", { name: "Data providers" })).toHaveCount(0);
});

test("Deezer is credited for the preview the page plays, and not without one", async ({ page }) => {
  const withClip = loadFixture("full-result");
  completeOf(withClip).previewUrl = DEEZER_CLIP;
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, withClip);
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  await expect(page.getByRole("button", { name: "Play preview" })).toBeVisible();
  const deezer = page.locator('[data-provider="deezer"]');
  await expect(deezer).toHaveText("Deezer, opens in a new tab (preview)");
  await expect(deezer.getByRole("link")).toHaveAttribute("href", "https://www.deezer.com");
});

test("no preview and no measurement: no preview is credited", async ({ page }) => {
  // The full result with its analysis not run (no clip found): nothing was measured.
  const fixture = loadFixture("full-result");
  Object.assign(completeOf(fixture), {
    audioSource: "unavailable",
    audioUnavailableReason: "no_preview",
    bpm: null,
    key: null,
    energy: null,
    valence: null,
    danceability: null,
    acousticness: null,
    keyMoments: [],
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, fixture);
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  await expect(page.getByText("Preview unavailable")).toBeVisible();
  await expect(page.getByTestId("player-audio-line")).toHaveText("BPM not measured");
  await expect(page.locator('[data-provider="deezer"]')).toHaveCount(0);
  await expect(page.locator('[data-provider="preview"]')).toHaveCount(0);
});

// A result from before the measurement block (no `audio`, audioSource "analyzed") shows its BPM
// and key as measured: the clip they were measured on is credited, its provider not guessed.
test("a result from before the measurement block credits the preview its values were measured on", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, loadFixture("full-result"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  await expect(page.getByTestId("player-audio-line")).toContainText("105 BPM");
  await expect(page.locator('[data-provider="preview"]')).toHaveText(
    "A preview clip (the audio was measured on it; this result does not name its provider)",
  );
  await expect(page.locator('[data-provider="deezer"]')).toHaveCount(0);
});
