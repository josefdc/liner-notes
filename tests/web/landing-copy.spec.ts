import { expect, type Page, test } from "@playwright/test";
import { apiRequests, loadFixture, useMockApi } from "./mock";

// The landing names the product, offers a search that works from the first click, and explains
// failures in plain words: never the prototype's copy, never the browser's raw error text.
const ANALYZE = "/api/analyze/stream";
const ERROR_HEADING = "The analysis did not finish";

const refused = (code: string, error: string) => [{ type: "error", code, error }, { type: "done" }];

// Submits with Enter, so a test reaches its own checks whatever the button is called.
async function search(page: Page, query: string) {
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill(query);
  await page.getByPlaceholder(/Song title/).press("Enter");
  // The error block is up: its "or try a different song" link is there before and after.
  await expect(page.getByRole("button", { name: "or try a different song" })).toBeVisible();
}

test("the landing is titled Liner Notes and says what it does", async ({ page }) => {
  await useMockApi(page, { suggestions: [], streams: {} });
  await page.goto("/");

  await expect(page).toHaveTitle("Liner Notes");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Liner Notes");
  await expect(page.getByText(/measured, sourced or inferred/)).toBeVisible();
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/Sonic Agent|\bDNA\b|ANALYZE_SONG/i);
});

test("the Analyze button is enabled on first load, and an empty search says what to type", async ({
  page,
}) => {
  await useMockApi(page, { suggestions: [], streams: {} });
  await page.goto("/");

  const button = page.getByRole("button", { name: "Analyze", exact: true });
  await expect(button).toBeEnabled();
  await button.click();

  const input = page.getByPlaceholder(/Song title/);
  const message = page.getByRole("alert");
  await expect(message).toHaveText(/Type a song title and its artist/);
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  await expect(input).toHaveAccessibleDescription(/Type a song title and its artist/);
  expect((await apiRequests(page)).filter((entry) => entry.startsWith("stream"))).toEqual([]);

  // Typing clears the message.
  await input.fill("Hurt");
  await expect(message).toHaveCount(0);
  await expect(input).not.toHaveAttribute("aria-invalid");
});

test("a connection failure shows a plain hint, never the browser's error text", async ({
  page,
}) => {
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  await useMockApi(page, { suggestions: [], streams: {} });
  // The analysis server cannot be reached: opening the stream fails as fetch does offline.
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() {
        throw new TypeError("Failed to fetch");
      }
    } as unknown as typeof EventSource;
  });
  await search(page, "Hurt");

  await expect(page.getByText(/Failed to fetch/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: ERROR_HEADING })).toBeVisible();
  await expect(
    page.getByText(
      "The connection to the analysis server failed. Check your internet connection, then try again.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  // The raw text is kept for whoever debugs it, in the console.
  expect(warnings.some((warning) => warning.includes("Failed to fetch"))).toBe(true);
});

test("a rate-limited search says to wait a minute", async ({ page }) => {
  await useMockApi(page, {
    suggestions: [],
    streams: { [ANALYZE]: refused("rate_limited", "Too many requests. Please try again later.") },
  });
  await search(page, "Hurt");

  await expect(page.getByText("Too many requests. Please try again later.")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: ERROR_HEADING })).toBeVisible();
  await expect(
    page.getByText("Too many requests. Wait a minute, then try again.", { exact: true }),
  ).toBeVisible();
});

test("a refused origin says to open the site at its usual address", async ({ page }) => {
  await useMockApi(page, {
    suggestions: [],
    streams: { [ANALYZE]: refused("forbidden_origin", "Requests from this site are not allowed.") },
  });
  await search(page, "Hurt");

  await expect(page.getByRole("heading", { name: ERROR_HEADING })).toBeVisible();
  await expect(page.getByText(/does not accept requests from this page/)).toBeVisible();
});

test("an exception's own text is never shown, only logged", async ({ page }) => {
  const warnings: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  const raw = "Failed to construct 'EventSource': The URL is invalid.";
  await useMockApi(page, { suggestions: [], streams: {} });
  await page.addInitScript((text) => {
    window.EventSource = class {
      constructor() {
        throw new SyntaxError(text);
      }
    } as unknown as typeof EventSource;
  }, raw);
  await search(page, "Hurt");

  await expect(page.getByText(/Failed to construct/)).toHaveCount(0);
  await expect(page.getByRole("heading", { name: ERROR_HEADING })).toBeVisible();
  await expect(
    page.getByText("Something went wrong. Try again, or search for a different song."),
  ).toBeVisible();
  expect(warnings.some((warning) => warning.includes(raw))).toBe(true);
});

test("a recording that is not the picked track says so in its own words", async ({ page }) => {
  // The budget trips while the picker is open; the recording replayed for the picked take turns
  // out to be another track, so it is not shown.
  const fixture = structuredClone(loadFixture("budget-paused-picker"));
  const replay = fixture.streams[ANALYZE].opens[1] as Array<{
    type: string;
    data?: { id: string };
  }>;
  const complete = replay.find((event) => event.type === "complete");
  if (!complete?.data) throw new Error("the fixture's replay has no result");
  complete.data.id = "t-another-track";
  await useMockApi(page, fixture);
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Bright Lines");
  await page.getByPlaceholder(/Song title/).press("Enter");
  await page.getByRole("button", { name: /Test Artist • 2001/ }).click();

  await expect(page.getByRole("heading", { name: ERROR_HEADING })).toBeVisible();
  await expect(
    page.getByText("The recording found is not the track you picked, so it is not shown."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Open the results" })).toHaveCount(0);
});
