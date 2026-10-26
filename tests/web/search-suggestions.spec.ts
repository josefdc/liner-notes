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

test("a song Spotify lists twice is suggested once", async ({ page }) => {
  // As for "Midnight City M83": the album track, then the same song from its single.
  const song = { artist: "M83", coverUrl: "" };
  await useMockApi(page, {
    suggestions: [
      { ...song, id: "album", title: "Midnight City", album: "Hurry Up, We're Dreaming" },
      { ...song, id: "remix", title: "Midnight City - Eric Prydz Private Remix", album: "Remixes" },
      { ...song, id: "single", title: "Midnight City", album: "Midnight City" },
    ],
    streams: {},
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Midnight City M83");

  const options = page.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.nth(0)).toContainText("Hurry Up, We're Dreaming");
  await expect(options.nth(1)).toContainText("Eric Prydz");
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
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(page.getByText("Searching for the track")).toBeVisible();
  await expect(page.getByText(picked.artist, { exact: true })).toHaveCount(0);
});
