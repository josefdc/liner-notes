import { expect, type Page, test } from "@playwright/test";
import { apiRequests, loadFixture, routeRunTokens, useMockApi } from "./mock";

// The landing names the product, offers a search that works from the first click, and explains
// failures in plain words: the server's own message when it says something true and specific,
// the page's words for the app's own failures, never an exception's raw text. The error block
// takes the focus, and its button is the step that can help.
const ANALYZE = "/api/analyze/stream";
const ERROR_HEADING = "The analysis did not finish";

const CONNECTION_LOST =
  "The connection to the analysis server was lost. The problem may be on your side or on the server's. Try again in a moment.";
const STREAM_OPEN_FAILED = "The analysis could not be started. Try again in a moment.";
const NO_RESULT = "The analysis ended without a result. Try again, or search for a different song.";
const NO_MATCH = "No song matched your search. Check the title and artist, then search again.";
const WRONG_TRACK =
  "The recording found is not the track you picked, so it is not shown. Search again to pick another take.";
const OUTDATED =
  "This page is out of date. Reload the page to get the new version, then search again.";

const refused = (code: string, error: string) => [{ type: "error", code, error }, { type: "done" }];

// Submits with Enter, so a test reaches its own checks whatever the button is called.
async function search(page: Page, query: string) {
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill(query);
  await page.getByPlaceholder(/Song title/).press("Enter");
  await expect(page.getByRole("heading", { name: ERROR_HEADING })).toBeVisible();
}

const ACTIONS = ["Try again", "Search again", "Reload the page"] as const;

/**
 * The error block says `lines` and nothing else, has the focus on its heading (which the lines
 * describe), and offers `action` as its one primary button.
 */
async function expectErrorBlock(page: Page, lines: string[], action: (typeof ACTIONS)[number]) {
  const heading = page.getByRole("heading", { name: ERROR_HEADING });
  const block = heading.locator("xpath=..");
  await expect(block.locator("p")).toHaveText(lines);
  for (const name of ACTIONS) {
    await expect(block.getByRole("button", { name, exact: true })).toHaveCount(
      name === action ? 1 : 0,
    );
  }
  // "Search again" is already the way to a different song: no second link beside it.
  await expect(block.getByRole("button", { name: "or try a different song" })).toHaveCount(
    action === "Search again" ? 0 : 1,
  );
  await expect(heading).toBeFocused();
  await expect(heading).toHaveAccessibleDescription(lines.join(" "));
}

test("the landing is titled Liner Notes and says what it does", async ({ page }) => {
  await useMockApi(page, { suggestions: [], streams: {} });
  await page.goto("/");

  await expect(page).toHaveTitle("Liner Notes");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Liner Notes");
  await expect(
    page.getByText(
      "Type a song and its artist. Liner Notes traces the song's samples, credits, history and sound, and shows which claims are measured, sourced or inferred.",
    ),
  ).toBeVisible();
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/Sonic Agent|\bDNA\b|ANALYZE_SONG/i);
});

test("the Analyze button is enabled on first load, and an empty search says what to type once", async ({
  page,
}) => {
  await useMockApi(page, { suggestions: [], streams: {} });
  await page.goto("/");

  const button = page.getByRole("button", { name: "Analyze", exact: true });
  await expect(button).toBeEnabled();
  await button.click();

  const input = page.getByPlaceholder(/Song title/);
  const message = page.getByRole("alert");
  await expect(message).toHaveText(
    "Type a song title and its artist first, for example: Midnight City M83.",
  );
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-invalid", "true");
  // The alert speaks the sentence; the field does not repeat it as its description.
  await expect(input).toHaveAccessibleDescription("");
  expect((await apiRequests(page)).filter((entry) => entry.startsWith("stream"))).toEqual([]);

  // Typing clears the message, and it stays cleared when the box is emptied again.
  await input.fill("Hurt");
  await input.fill("");
  await expect(message).toHaveCount(0);
  await expect(input).not.toHaveAttribute("aria-invalid");
});

test("a connection lost to the analysis server says so without blaming either side", async ({
  page,
}) => {
  // The browser's own EventSource, with no server behind the stream: it fires `error`.
  await page.route("**/api/search/suggest**", (route) =>
    route.fulfill({ json: { success: true, suggestions: [] } }),
  );
  await routeRunTokens(page);
  await page.route("**/api/analyze/stream?**", (route) => route.abort("internetdisconnected"));
  await search(page, "Hurt");

  await expectErrorBlock(page, [CONNECTION_LOST], "Try again");
});

for (const raw of ["Failed to fetch", "Failed to construct 'EventSource': The URL is invalid."]) {
  test(`an exception thrown while opening the stream never shows its text (${raw})`, async ({
    page,
  }) => {
    const warnings: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "warning") warnings.push(message.text());
    });
    await useMockApi(page, { suggestions: [], streams: {} });
    await page.addInitScript((text) => {
      window.EventSource = class {
        constructor() {
          throw new TypeError(text);
        }
      } as unknown as typeof EventSource;
    }, raw);
    await search(page, "Hurt");

    await expect(page.getByText(raw)).toHaveCount(0);
    await expectErrorBlock(page, [STREAM_OPEN_FAILED], "Try again");
    // The raw text is kept for whoever debugs it, in the console.
    expect(warnings.some((warning) => warning.includes(raw))).toBe(true);
  });
}

test("a rate-limited search shows the server's own words, once", async ({ page }) => {
  await useMockApi(page, {
    suggestions: [],
    streams: { [ANALYZE]: refused("rate_limited", "Too many requests. Please try again later.") },
  });
  await search(page, "Hurt");

  await expectErrorBlock(page, ["Too many requests. Please try again later."], "Try again");
  await expect(page.getByText(/Wait a minute|a few minutes/)).toHaveCount(0);
});

test("a refused origin says to open the site at its usual address", async ({ page }) => {
  await useMockApi(page, {
    suggestions: [],
    streams: { [ANALYZE]: refused("forbidden_origin", "Requests from this site are not allowed.") },
  });
  await search(page, "Hurt");

  await expectErrorBlock(
    page,
    [
      "The analysis server does not accept requests from this page. Open Liner Notes at its usual address, then search again.",
    ],
    "Search again",
  );
});

test("a stream that ends without a result says so", async ({ page }) => {
  await useMockApi(page, {
    suggestions: [],
    // Not a stream the API sends: it ends with no outcome.
    streams: {
      [ANALYZE]: [{ type: "connected", threadId: "t" }, { $unchecked: { type: "done" } }],
    },
  });
  await search(page, "Hurt");

  await expectErrorBlock(page, [NO_RESULT], "Try again");
});

test("a search with no candidates says no song matched, and Search again keeps the text", async ({
  page,
}) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: "t" },
        {
          $unchecked: {
            type: "interrupt",
            reason: "disambiguation",
            threadId: "t",
            candidates: [],
            message: "No songs found.",
          },
        },
        { type: "done" },
      ],
    },
  });
  await search(page, "Hurt");

  await expectErrorBlock(page, [NO_MATCH], "Search again");
  await page.getByRole("button", { name: "Search again" }).click();
  await expect(page.getByRole("heading", { name: ERROR_HEADING })).toHaveCount(0);
  const input = page.getByPlaceholder(/Song title/);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Hurt");
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
  await page.getByRole("option", { name: /Test Artist • 2001/ }).click();

  await expectErrorBlock(page, [WRONG_TRACK], "Search again");
  await expect(page.getByRole("button", { name: "Open the results" })).toHaveCount(0);
});

test("a page that cannot read the result offers to reload", async ({ page }) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: "t" },
        { $unchecked: { type: "complete", data: "not a result" } },
        { type: "done" },
      ],
    },
  });
  await search(page, "Hurt");

  await expectErrorBlock(page, [OUTDATED], "Reload the page");
  await page.getByRole("button", { name: "Reload the page" }).click();
  await expect(page.getByRole("heading", { name: ERROR_HEADING })).toHaveCount(0);
  await expect(page.getByPlaceholder(/Song title/)).toHaveValue("");
});

test("a failed search clears the note that suggestions are unavailable", async ({ page }) => {
  // The API is down: the suggestions fail first, then the analysis (its run token first).
  await page.route("**/api/search/suggest**", (route) => route.abort("internetdisconnected"));
  await page.route("**/api/runs", (route) => route.abort("internetdisconnected"));
  await page.route("**/api/analyze/stream?**", (route) => route.abort("internetdisconnected"));
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Hurt");
  const unavailable = page.getByText(
    "Suggestions are unavailable right now. You can still search.",
  );
  await expect(unavailable).toBeVisible();
  await page.getByPlaceholder(/Song title/).press("Enter");

  await expectErrorBlock(page, [CONNECTION_LOST], "Try again");
  // It said the search would still work; the block now says why it did not.
  await expect(unavailable).toHaveCount(0);
});

test("a retry that fails again at once takes the focus back to the heading", async ({ page }) => {
  await useMockApi(page, { suggestions: [], streams: {} });
  await page.addInitScript(() => {
    window.EventSource = class {
      constructor() {
        throw new TypeError("Failed to fetch");
      }
    } as unknown as typeof EventSource;
  });
  await search(page, "Hurt");
  await expectErrorBlock(page, [STREAM_OPEN_FAILED], "Try again");

  // The retry fails inside the click, so the block stays up: the new failure is announced too.
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByRole("heading", { name: ERROR_HEADING })).toBeFocused();
});
