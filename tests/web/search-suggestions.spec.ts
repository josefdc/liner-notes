import { expect, test } from "@playwright/test";
import { abortedRequests, apiRequests, loadFixture, releaseStream, useMockApi } from "./mock";

// Search suggestions while typing: a failed request says so instead of looking like
// "no matches".
const hitl = loadFixture("hitl");
const candidates = hitl.streams["/api/analyze/stream"].find(
  (event: { type: string }) => event.type === "interrupt",
).candidates;
const unavailable = "Suggestions are unavailable right now. You can still search.";

test("a failing suggestion request shows that suggestions are unavailable", async ({ page }) => {
  await useMockApi(page, {
    suggestions: candidates,
    streams: {},
    fetchStatus: { "/api/search/suggest": 500 },
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Hurt");

  await expect(page.getByText(unavailable)).toBeVisible();
  expect(await apiRequests(page)).toContain("fetch /api/search/suggest");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  // The search itself still runs.
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect
    .poll(async () => (await apiRequests(page)).filter((entry) => entry.startsWith("stream ")))
    .toEqual([expect.stringMatching(/^stream \/api\/analyze\/stream\?query=Hurt(&|$)/)]);
});

test("suggestions that load show the list and no error", async ({ page }) => {
  await useMockApi(page, { suggestions: candidates, streams: {} });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Hurt");

  await expect(page.getByRole("listbox")).toBeVisible();
  await expect(page.getByRole("option")).toHaveCount(candidates.length);
  await expect(page.getByText(unavailable)).toHaveCount(0);
});

test("a late answer for an earlier query does not replace the current suggestions", async ({
  page,
}) => {
  const [cash, nin] = candidates;
  await useMockApi(page, {
    suggestions: [],
    streams: {},
    suggestionsByQuery: { Hurt: [cash], "Hurt Nine": [nin] },
    // The answer for "Hurt" arrives only after the one for "Hurt Nine".
    suggestWaits: { Hurt: "first" },
  });
  await page.goto("/");
  const input = page.getByRole("combobox", { name: "Song title and artist" });
  const suggestRequests = async () =>
    (await apiRequests(page)).filter((entry) => entry === "fetch /api/search/suggest").length;

  await input.fill("Hurt");
  await expect.poll(suggestRequests).toBe(1);
  await input.fill("Hurt Nine");
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option")).toContainText(nin.artist);

  await releaseStream(page, "first");
  await page.waitForTimeout(300);
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option")).toContainText(nin.artist);
});

test("a suggestion chosen with the keyboard is analysed by its Spotify track id", async ({
  page,
}) => {
  const suggestion = { ...candidates[0], id: "28cnXtME493VX9NOw9cIUh" };
  await useMockApi(page, { suggestions: [suggestion], streams: {} });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Hurt");
  await expect(page.getByRole("option")).toHaveCount(1);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  const query = encodeURIComponent(`${suggestion.title} ${suggestion.artist}`);
  await expect
    .poll(async () =>
      (await apiRequests(page)).filter((entry) => entry.startsWith("stream /api/analyze/stream")),
    )
    // A deliberate click on that track: no note that its text matched it loosely.
    .toEqual([`stream /api/analyze/stream?query=${query}&trackId=${suggestion.id}&pickedBy=click`]);
});

test("typing on aborts the request for the earlier text", async ({ page }) => {
  const [cash, nin] = candidates;
  await useMockApi(page, {
    suggestions: [],
    streams: {},
    suggestionsByQuery: { Hurt: [cash], "Hurt Nine": [nin] },
    // The answer for "Hurt" is held until the test lets it go.
    suggestWaits: { Hurt: "first" },
  });
  await page.goto("/");
  const input = page.getByRole("combobox", { name: "Song title and artist" });
  await input.fill("Hurt");
  await expect
    .poll(async () =>
      (await apiRequests(page)).filter((entry) => entry === "fetch /api/search/suggest"),
    )
    .toHaveLength(1);

  await input.fill("Hurt Nine");
  await expect.poll(() => abortedRequests(page)).toEqual(["/api/search/suggest?query=Hurt"]);
  await expect(page.getByRole("option")).toHaveCount(1);
  await expect(page.getByRole("option")).toContainText(nin.artist);
});

test("one recording Spotify lists twice is suggested once, from its earliest release", async ({
  page,
}) => {
  // "Midnight City M83" as MusicBrainz records it: the album track and the single are one
  // recording (ISRC GB55H1100002, both clean, one length); the remix is another recording.
  const song = { artist: "M83", coverUrl: "", explicit: false, durationMs: 243_000 };
  await useMockApi(page, {
    suggestions: [
      {
        ...song,
        id: "album",
        title: "Midnight City",
        album: "Hurry Up, We're Dreaming",
        isrc: "GB55H1100002",
        releaseDate: "2011-10-18",
      },
      {
        ...song,
        id: "remix",
        title: "Midnight City - Eric Prydz Private Remix",
        album: "Remixes",
        isrc: "GB55H1200001",
        releaseDate: "2012-04-02",
      },
      {
        ...song,
        id: "single",
        title: "Midnight City",
        album: "Midnight City (single)",
        isrc: "GB55H1100002",
        releaseDate: "2011-09-27",
      },
    ],
    streams: {},
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Midnight City M83");

  const options = page.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText("Midnight City (single)");
  await expect(options.nth(1)).toContainText("Eric Prydz");
});

test("two takes with different ISRCs both stay suggestions", async ({ page }) => {
  const take = { title: "Hurt", artist: "Johnny Cash", coverUrl: "" };
  await useMockApi(page, {
    suggestions: [
      { ...take, id: "album", album: "American IV", isrc: "USAT29900609" },
      { ...take, id: "live", album: "Live at the Fillmore", isrc: "USAT20200001" },
    ],
    streams: {},
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Hurt Johnny Cash");

  await expect(page.getByRole("option")).toHaveCount(2);
});

test("a typed search does not show the track an earlier suggestion picked", async ({ page }) => {
  const picked = { ...candidates[0], id: "28cnXtME493VX9NOw9cIUh" };
  await useMockApi(page, {
    suggestions: [picked],
    streams: {
      "/api/analyze/stream": {
        opens: [
          [{ type: "error", code: "no_match", error: "No match" }, { type: "done" }],
          [
            { type: "connected", threadId: "thread-typed" },
            {
              type: "status",
              node: "scout",
              message: "Searching for the track",
              code: "SPOTIFY-SEARCH",
            },
            { $wait: "never" },
          ],
        ],
      },
    },
  });
  await page.goto("/");
  const input = page.getByRole("combobox", { name: "Song title and artist" });
  await input.fill("Hurt");
  await page.getByRole("option").click();
  await page.getByRole("button", { name: "Search again" }).click();

  await input.fill("Midnight City M83");
  await page.keyboard.press("Escape");
  // Escape stops the suggestions asked for while typing: none open over the button later.
  await page.waitForTimeout(350);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(page.getByText("Searching for the track")).toBeVisible();
  await expect(page.getByText(picked.artist, { exact: true })).toHaveCount(0);
});
