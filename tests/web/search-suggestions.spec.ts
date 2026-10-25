import { expect, test } from "@playwright/test";
import { apiRequests, loadFixture, releaseStream, useMockApi } from "./mock";

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
  await page.getByPlaceholder(/Song title/).fill("Hurt");

  await expect(page.getByText(unavailable)).toBeVisible();
  expect(await apiRequests(page)).toContain("fetch /api/search/suggest");
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "ANALYZE_SONG" })).toBeEnabled();
});

test("suggestions that load show the list and no error", async ({ page }) => {
  await useMockApi(page, { suggestions: candidates, streams: {} });
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Hurt");

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
  const input = page.getByPlaceholder(/Song title/);
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
  await page.getByPlaceholder(/Song title/).fill("Hurt");
  await expect(page.getByRole("option")).toHaveCount(1);

  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");

  const query = encodeURIComponent(`${suggestion.title} ${suggestion.artist}`);
  await expect
    .poll(async () =>
      (await apiRequests(page)).filter((entry) => entry.startsWith("stream /api/analyze/stream")),
    )
    .toEqual([`stream /api/analyze/stream?query=${query}&trackId=${suggestion.id}`]);
});
