import { expect, type Page, test } from "@playwright/test";
import {
  apiRequests,
  collectProblems,
  fullResultData,
  loadFixture,
  releaseStream,
  useMockApi,
} from "./mock";

// Shareable addresses: `/` is the search, `/t/<spotifyId>` a track's result. Opening a track's
// address shows its latest stored result (GET /api/runs/by-track/<id>, which runs nothing); a
// track without one says so and offers Analyze, which alone starts a run.
const ANALYZE = "/api/analyze/stream";
// A stored run of one track, and an analysis stream for another that has none.
const stored = loadFixture("stored-run");
/** The track the fixture holds a stored run of ("Bright Lines" by Test Artist). */
const STORED_ID = "4cOdK2wGLETKBW3PvgPWqT";
/** A well-formed Spotify track id without a stored run: the fixture's stream analyses it. */
const MISSING_ID = "7ouMYWpwJ422jRcDASZB7P";

const MISSING_TITLE = "No stored analysis for this track yet";
const resultHeading = (page: Page) => page.getByRole("heading", { name: "Command Center" });
const searchBox = (page: Page) => page.getByRole("combobox", { name: "Song title and artist" });
const streams = (log: string[]) => log.filter((entry) => entry.startsWith("stream "));
const byTrack = (id: string) => `fetch /api/runs/by-track/${id}`;

/** An analysis stream whose result is the full-result fixture's, for the track `id`. */
function streamFor(id: string) {
  return [
    { type: "connected", threadId: `thread-${id}` },
    { type: "status", node: "scout", message: "Searching for the track", code: "SPOTIFY-SEARCH" },
    { type: "complete", data: { ...(fullResultData() as object), id } },
    { type: "done" },
  ];
}

test("a stored run opens at its address with no analysis, and a reload keeps it", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, stored);
  await page.goto(`/t/${STORED_ID}`);

  await expect(resultHeading(page)).toBeVisible();
  await expect(resultHeading(page)).toBeFocused();
  await expect(page.getByText("Bright Lines").first()).toBeVisible();
  // Its address now carries the track's name, for sharing.
  await expect(page).toHaveURL(`/t/${STORED_ID}?q=Bright+Lines+Test+Artist`);
  let requests = await apiRequests(page);
  expect(requests).toContain(byTrack(STORED_ID));
  expect(streams(requests)).toEqual([]);

  await page.reload();
  await expect(resultHeading(page)).toBeVisible();
  await expect(resultHeading(page)).toBeFocused();
  await expect(page.getByText("Bright Lines").first()).toBeVisible();
  requests = await apiRequests(page);
  expect(requests).toContain(byTrack(STORED_ID));
  expect(streams(requests)).toEqual([]);
  expect(problems).toEqual([]);
});

test("a reload of the Player keeps the Player", async ({ page }) => {
  await useMockApi(page, stored);
  await page.goto(`/t/${STORED_ID}`);
  await page.getByRole("button", { name: "VIEW FULL ANALYSIS" }).click();
  const back = page.getByRole("button", { name: /BACK TO BASE/ });
  await expect(back).toBeVisible();

  await page.reload();
  await expect(back).toBeVisible();
  expect(streams(await apiRequests(page))).toEqual([]);
});

test("a track without a stored run says so: nothing runs until Analyze", async ({ page }) => {
  const problems = collectProblems(page);
  await useMockApi(page, stored);
  await page.goto(`/t/${MISSING_ID}?q=Midnight%20City%20M83`);

  const heading = page.getByRole("heading", { name: MISSING_TITLE });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page.getByText("Named in the link: Midnight City M83")).toBeVisible();
  await expect(page.getByText(`Spotify track id: ${MISSING_ID}`)).toBeVisible();
  const analyze = page.getByRole("button", { name: "Analyze", exact: true });
  await expect(analyze).toBeVisible();

  // Well past anything that could start on its own: only the stored run was asked for.
  await page.waitForTimeout(1500);
  expect([...new Set(await apiRequests(page))]).toEqual([byTrack(MISSING_ID)]);

  // Analyze runs that very track, under the link's words for it.
  await analyze.click();
  await expect(page.locator("[data-progress-status]")).toBeFocused();
  expect(streams(await apiRequests(page))).toEqual([
    `stream ${ANALYZE}?query=Midnight%20City%20M83&trackId=${MISSING_ID}&pickedBy=click`,
  ]);
  await page.getByRole("button", { name: "Open the results" }).click();
  await expect(resultHeading(page)).toBeFocused();
  await expect(page).toHaveURL(`/t/${MISSING_ID}?q=Bright+Lines+Test+Artist`);

  // Back from the result goes to the search, not to the screen that had no stored analysis.
  await page.goBack();
  await expect(searchBox(page)).toBeVisible();
  await expect(page).toHaveURL("/");
  expect(problems).toEqual([]);
});

test("Analyze on a link without words asks for the track by its id", async ({ page }) => {
  await useMockApi(page, stored);
  await page.goto(`/t/${MISSING_ID}`);
  await expect(page.getByRole("heading", { name: MISSING_TITLE })).toBeVisible();
  await expect(page.getByText("Named in the link")).toHaveCount(0);

  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("Searching for the track");
  expect(streams(await apiRequests(page))).toEqual([
    `stream ${ANALYZE}?query=${MISSING_ID}&trackId=${MISSING_ID}&pickedBy=click`,
  ]);
});

test("a link whose id is not a Spotify track id says so and leads to the search", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, stored);
  await page.goto("/t/not-a-track");

  const heading = page.getByRole("heading", { name: "This link does not lead to a track" });
  await expect(heading).toBeVisible();
  await expect(heading).toBeFocused();
  await expect(page.getByText("Spotify track id: not-a-track")).toBeVisible();
  await expect(page.getByRole("button", { name: "Analyze", exact: true })).toHaveCount(0);
  // Nothing to ask the API about.
  expect(await apiRequests(page)).toEqual([]);

  await page.getByRole("button", { name: "Search for a song" }).click();
  await expect(searchBox(page)).toBeFocused();
  await expect(page).toHaveURL("/");
  expect(problems).toEqual([]);
});

test("a stored run that cannot be read says so, and Try again reads it again", async ({ page }) => {
  await useMockApi(page, {
    ...stored,
    fetchStatus: { [`/api/runs/by-track/${STORED_ID}`]: 500 },
  });
  await page.goto(`/t/${STORED_ID}`);

  const heading = page.getByRole("heading", { name: "The stored analysis could not be loaded" });
  await expect(heading).toBeFocused();
  await expect(page.getByRole("button", { name: "Analyze", exact: true })).toHaveCount(0);
  expect(streams(await apiRequests(page))).toEqual([]);

  // The server answers again.
  await page.evaluate(() => {
    (window as unknown as { __mockApi: { fetchStatus: object } }).__mockApi.fetchStatus = {};
  });
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(resultHeading(page)).toBeFocused();
  expect(streams(await apiRequests(page))).toEqual([]);
});

test("while the stored run loads, its screen holds the focus", async ({ page }) => {
  await useMockApi(page, { ...stored, runWaits: { [STORED_ID]: "stored" } });
  await page.goto(`/t/${STORED_ID}`);
  const loading = page.getByRole("heading", { name: "Loading the stored analysis..." });
  await expect(loading).toBeFocused();
  await releaseStream(page, "stored");
  await expect(resultHeading(page)).toBeFocused();
});

test("while the stored run loads, Search for a song leads out of it", async ({ page }) => {
  // An API that does not answer: the screen still has a way out.
  await useMockApi(page, { ...stored, runWaits: { [STORED_ID]: "never" } });
  await page.goto(`/t/${STORED_ID}`);
  await expect(page.getByRole("heading", { name: "Loading the stored analysis..." })).toBeFocused();
  await page.getByRole("button", { name: "Search for a song" }).click();
  await expect(searchBox(page)).toBeFocused();
  await expect(page).toHaveURL("/");
});

test("Analyze on a link whose words are cut at the API's limit never splits a character", async ({
  page,
}) => {
  // 199 letters, then an emoji (two UTF-16 code units) across the 200th: the emoji is left
  // out whole, not cut in half (which could not be sent at all).
  const words = `${"a".repeat(199)}\u{1F600}tail`;
  await useMockApi(page, stored);
  await page.goto(`/t/${MISSING_ID}?q=${encodeURIComponent(words)}`);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(page.getByRole("log")).toContainText("Searching for the track");
  expect(streams(await apiRequests(page))).toEqual([
    `stream ${ANALYZE}?query=${"a".repeat(199)}&trackId=${MISSING_ID}&pickedBy=click`,
  ]);
});

test("Back past another track's result to a link's result shows that link's track", async ({
  page,
}) => {
  const other = "1aBcDeFgHiJkLmNoPqRsTu";
  await useMockApi(page, {
    ...stored,
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: "thread-other" },
        {
          type: "status",
          node: "scout",
          message: "Searching for the track",
          code: "SPOTIFY-SEARCH",
        },
        {
          type: "complete",
          data: { ...(fullResultData() as object), id: other, title: "Other Song" },
        },
        { type: "done" },
      ],
    },
  });
  await page.goto(`/t/${STORED_ID}`);
  await expect(resultHeading(page)).toBeFocused();
  await page.getByRole("button", { name: "NEW SEARCH" }).click();
  await searchBox(page).fill("Other Song");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.getByRole("button", { name: "Open the results" }).click();
  await expect(page).toHaveURL(`/t/${other}?q=Other+Song+Test+Artist`);
  await expect(page.getByText("Other Song").first()).toBeVisible();

  // Two entries back, past the search: the link's own track, never the one on screen before.
  await page.evaluate(() => history.go(-2));
  await expect(page).toHaveURL(`/t/${STORED_ID}?q=Bright+Lines+Test+Artist`);
  await expect(resultHeading(page)).toBeFocused();
  await expect(page.getByText("Bright Lines").first()).toBeVisible();
  await expect(page.getByText("Other Song")).toHaveCount(0);
});

test("a result whose id is not a Spotify track id keeps the search's address", async ({ page }) => {
  // The picker's rows in the hitl fixture have ids such as "c2": no link could load them.
  await useMockApi(page, loadFixture("hitl"));
  await page.goto("/");
  await searchBox(page).fill("Hurt");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.getByRole("option", { name: /Nine Inch Nails/ }).click();
  await page.getByRole("button", { name: "Open the results" }).click();
  await expect(resultHeading(page)).toBeFocused();
  await expect(page).toHaveURL("/");

  await page.reload();
  await expect(searchBox(page)).toBeFocused();
  await expect(
    page.getByRole("heading", { name: "This link does not lead to a track" }),
  ).toHaveCount(0);
});

for (const outcome of [
  { name: "no stored run", title: MISSING_TITLE, failWith: null },
  { name: "a failure", title: "The stored analysis could not be loaded", failWith: 500 },
]) {
  test(`after loading, ${outcome.name} is announced: a new heading takes the focus`, async ({
    page,
  }) => {
    await useMockApi(page, { ...stored, runWaits: { [MISSING_ID]: "answer" } });
    await page.goto(`/t/${MISSING_ID}`);
    const loading = page.getByRole("heading", { name: "Loading the stored analysis..." });
    await expect(loading).toBeFocused();
    // The loading heading, and every focus move from here on.
    await page.evaluate(() => {
      const w = window as unknown as { __loading: Element | null; __focusIns: string[] };
      w.__loading = document.activeElement;
      w.__focusIns = [];
      document.addEventListener("focusin", (event) =>
        w.__focusIns.push((event.target as Element).textContent ?? ""),
      );
    });
    if (outcome.failWith) {
      await page.evaluate(
        ([path, status]) => {
          (window as unknown as { __mockApi: { fetchStatus: object } }).__mockApi.fetchStatus = {
            [path]: status,
          };
        },
        [`/api/runs/by-track/${MISSING_ID}`, outcome.failWith] as const,
      );
    }
    await releaseStream(page, "answer");

    const heading = page.getByRole("heading", { name: outcome.title });
    await expect(heading).toBeFocused();
    // Another element than the loading heading, which a screen reader reads as it takes the
    // focus: a renamed heading that already had the focus would be read by none.
    expect(
      await page.evaluate(() => {
        const w = window as unknown as { __loading: Element | null; __focusIns: string[] };
        return { same: document.activeElement === w.__loading, focusIns: w.__focusIns };
      }),
    ).toEqual({ same: false, focusIns: [outcome.title] });
  });
}

test("a link's result takes the focus even when its code takes more than ten seconds", async ({
  page,
}) => {
  test.setTimeout(60_000);
  await useMockApi(page, stored);
  await page.route(/\/assets\/Dashboard-[^/]*\.js$/, async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 11_500));
    await route.continue();
  });
  await page.goto(`/t/${STORED_ID}`);
  await expect(page.getByRole("status", { name: "Loading the results" })).toBeFocused({
    timeout: 8000,
  });
  await page.evaluate(() => {
    const w = window as unknown as { __seen: string[] };
    w.__seen = [];
    const note = () => {
      w.__seen.push(document.activeElement?.tagName ?? "none");
      requestAnimationFrame(note);
    };
    requestAnimationFrame(note);
  });
  await expect(resultHeading(page)).toBeFocused({ timeout: 20_000 });
  expect(
    await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen.includes("BODY")),
  ).toBe(false);
});

test("a stored result whose measured copies have no measurement is not shown", async ({ page }) => {
  // An older row: no measurement, yet the top-level copies say BPM 105 and A minor. The
  // contract's RunResponse accepts it; its measured-value rule does not.
  const body = structuredClone(stored.runs[STORED_ID]);
  Object.assign(body.analysis, { audio: null, bpm: 105, key: "A Minor", energy: 0.8 });
  await useMockApi(page, { ...stored, runs: { [STORED_ID]: body } });
  await page.goto(`/t/${STORED_ID}`);
  await expect(
    page.getByRole("heading", { name: "The stored analysis could not be loaded" }),
  ).toBeFocused();
  await expect(page.getByText(/BPM\s*105/)).toHaveCount(0);
  await expect(resultHeading(page)).toHaveCount(0);
});

test("an address the app does not know opens the search", async ({ page }) => {
  await useMockApi(page, stored);
  await page.goto("/somewhere/else");
  await expect(searchBox(page)).toBeFocused();
  await expect(page).toHaveURL("/");
});

test("Back and Forward move between the search and a result, with no new request", async ({
  page,
}) => {
  await useMockApi(page, { ...stored, streams: { [ANALYZE]: streamFor(STORED_ID) } });
  await page.goto("/");
  await searchBox(page).fill("Bright Lines");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.getByRole("button", { name: "Open the results" }).click();
  await expect(resultHeading(page)).toBeFocused();
  await expect(page).toHaveURL(`/t/${STORED_ID}?q=Bright+Lines+Test+Artist`);
  const requestsAtResult = await apiRequests(page);

  await page.goBack();
  await expect(searchBox(page)).toBeFocused();
  await expect(page).toHaveURL("/");

  await page.goForward();
  await expect(resultHeading(page)).toBeFocused();
  await expect(page).toHaveURL(`/t/${STORED_ID}?q=Bright+Lines+Test+Artist`);
  expect(await apiRequests(page)).toEqual(requestsAtResult);

  // A reload there reads the stored run: the result stays, and nothing is analyzed again.
  await page.reload();
  await expect(resultHeading(page)).toBeVisible();
  expect(streams(await apiRequests(page))).toEqual([]);
});

test("from a link's result, a new search and Back show the result again", async ({ page }) => {
  await useMockApi(page, stored);
  await page.goto(`/t/${STORED_ID}`);
  await expect(resultHeading(page)).toBeFocused();
  await page.getByRole("button", { name: "NEW SEARCH" }).click();
  await expect(searchBox(page)).toBeFocused();
  await expect(page).toHaveURL("/");
  const requests = await apiRequests(page);

  await page.goBack();
  await expect(resultHeading(page)).toBeFocused();
  await expect(page).toHaveURL(`/t/${STORED_ID}?q=Bright+Lines+Test+Artist`);
  expect(await apiRequests(page)).toEqual(requests);
});

test("a reload of a result the API holds no stored run of starts no analysis", async ({ page }) => {
  // The API has not stored the result (yet): the reload says so instead of starting a run.
  await useMockApi(page, { suggestions: [], streams: { [ANALYZE]: streamFor(MISSING_ID) } });
  await page.goto("/");
  await searchBox(page).fill("Bright Lines");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.getByRole("button", { name: "Open the results" }).click();
  await expect(page).toHaveURL(`/t/${MISSING_ID}?q=Bright+Lines+Test+Artist`);

  await page.reload();
  await expect(page.getByRole("heading", { name: MISSING_TITLE })).toBeVisible();
  await expect(page.getByText("Named in the link: Bright Lines Test Artist")).toBeVisible();
  expect(streams(await apiRequests(page))).toEqual([]);
});
