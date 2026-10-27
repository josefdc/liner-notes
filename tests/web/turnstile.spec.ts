import { expect, type Page, test } from "@playwright/test";
import {
  apiRequests,
  collectProblems,
  loadFixture,
  runTokens,
  sentTurnstileTokens,
  useMockApi,
} from "./mock";

// Run against the build made with Cloudflare's test site key (the "site-key" project in
// playwright.config.ts). Cloudflare's script is replaced by a route: these tests never contact
// Cloudflare. The stand-in renders each widget as the page asks, records it, and answers with a
// token of its own ("fake-turnstile-token-<n>"), at once or once its button is clicked.
const SITE_KEY = "1x00000000000000000000AA";
const SCRIPT = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
const ANALYZE = "/api/analyze/stream";

const FAKE_TURNSTILE = `(() => {
  const state = (window.__fakeTurnstile ??= {});
  state.renders = [];
  state.removed = [];
  window.turnstile = {
    render(container, options) {
      const n = state.renders.length + 1;
      state.renders.push({ sitekey: options.sitekey, appearance: options.appearance });
      const answer = () => options.callback("fake-turnstile-token-" + n);
      if (state.interactive) {
        setTimeout(() => {
          options["before-interactive-callback"]();
          const button = document.createElement("button");
          button.type = "button";
          button.textContent = "I am a person";
          button.addEventListener("click", () => {
            options["after-interactive-callback"]();
            answer();
          });
          container.append(button);
        }, 20);
      } else {
        setTimeout(answer, 20);
      }
      return "fake-widget-" + n;
    },
    remove(id) {
      state.removed.push(id);
    },
  };
})();`;

type FakeState = { renders: Array<{ sitekey: string; appearance: string }>; removed: string[] };

/**
 * Serves the stand-in for Cloudflare's script, refuses anything else on Cloudflare's host, and
 * returns every request the page made to another host than its own.
 */
async function fakeTurnstile(page: Page, { interactive = false } = {}) {
  const outside: string[] = [];
  page.on("request", (request) => {
    const { hostname } = new URL(request.url());
    if (hostname !== "127.0.0.1") outside.push(request.url());
  });
  await page.addInitScript((asked) => {
    (window as unknown as { __fakeTurnstile: object }).__fakeTurnstile = { interactive: asked };
  }, interactive);
  await page.route("https://challenges.cloudflare.com/**", (route) =>
    route.request().url() === SCRIPT
      ? route.fulfill({ contentType: "text/javascript", body: FAKE_TURNSTILE })
      : route.abort(),
  );
  return outside;
}

const widgets = (page: Page) =>
  page.evaluate(() => (window as unknown as { __fakeTurnstile: FakeState }).__fakeTurnstile);

const postsToRuns = async (page: Page) =>
  (await apiRequests(page)).filter((entry) => entry === "fetch /api/runs").length;

async function search(page: Page, query: string) {
  await page.getByPlaceholder(/Song title/).fill(query);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
}

/** The page's own warning for each failed run (Onboarding): expected where a run fails. */
const unexpected = (problems: string[]) =>
  problems.filter((problem) => !problem.includes("[Onboarding] The analysis failed"));

test("an analysis runs end to end with the widget's token", async ({ page }) => {
  const problems = collectProblems(page);
  const outside = await fakeTurnstile(page);
  await useMockApi(page, loadFixture("full-result"));
  await page.goto("/");
  await search(page, "Bright Lines");
  await expect(page.getByRole("button", { name: "Open the results" })).toBeVisible();

  expect(await widgets(page)).toEqual({
    interactive: false,
    renders: [{ sitekey: SITE_KEY, appearance: "interaction-only" }],
    removed: ["fake-widget-1"],
  });
  expect(await sentTurnstileTokens(page)).toEqual(["fake-turnstile-token-1"]);
  expect(await runTokens(page)).toEqual({ issued: ["mock-run-token-1"], refused: [] });
  // Cloudflare's script, served by the route above, and nothing else outside the page's host.
  expect(outside).toEqual([SCRIPT]);
  // Nothing of the check shows when Cloudflare asks no interaction.
  await expect(page.locator("#turnstile-check-caption")).toBeHidden();
  expect(problems).toEqual([]);
});

test("the check shows only while Cloudflare asks the visitor for an interaction", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await fakeTurnstile(page, { interactive: true });
  await useMockApi(page, loadFixture("full-result"));
  await page.goto("/");
  await search(page, "Bright Lines");

  const caption = page.getByText("Confirm that you are a person to start the analysis.");
  await expect(caption).toBeVisible();
  // The progress line says what is under way, instead of "Connecting...".
  await expect(page.getByText("Checking that you are a person...").first()).toBeVisible();
  expect(await postsToRuns(page)).toBe(0);
  await page.getByRole("button", { name: "I am a person" }).click();
  await expect(page.getByRole("button", { name: "Open the results" })).toBeVisible();
  await expect(caption).toBeHidden();
  await expect(page.getByRole("button", { name: "I am a person" })).toHaveCount(0);
  expect(await sentTurnstileTokens(page)).toEqual(["fake-turnstile-token-1"]);
  expect(problems).toEqual([]);
});

test("a refused run token is checked again once, on the next click", async ({ page }) => {
  const problems = collectProblems(page);
  await fakeTurnstile(page);
  const fixture = loadFixture("full-result");
  await useMockApi(page, {
    ...fixture,
    streams: {
      [ANALYZE]: {
        opens: [
          [
            {
              type: "error",
              code: "auth_expired",
              error: "This page needs to check the request again. Please try again.",
            },
            { type: "done" },
          ],
          fixture.streams[ANALYZE],
        ],
      },
    },
  });
  await page.goto("/");
  await search(page, "Bright Lines");
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeEnabled();
  // Nothing is checked or asked for again by itself.
  await page.waitForTimeout(500);
  expect((await widgets(page)).renders).toHaveLength(1);
  expect(await postsToRuns(page)).toBe(1);

  await retry.click();
  await expect(page.getByRole("button", { name: "Open the results" })).toBeVisible();
  expect((await widgets(page)).renders).toHaveLength(2);
  expect(await sentTurnstileTokens(page)).toEqual([
    "fake-turnstile-token-1",
    "fake-turnstile-token-2",
  ]);
  expect(await runTokens(page)).toEqual({
    issued: ["mock-run-token-1", "mock-run-token-2"],
    refused: [],
  });
  expect(unexpected(problems)).toEqual([]);
});

test("a widget token the API refuses is checked again once, within the same click", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await fakeTurnstile(page);
  const refusal = {
    status: 401,
    code: "auth_expired",
    error: "This page needs to check the request again. Please try again.",
  };
  await useMockApi(page, { ...loadFixture("full-result"), runTokenRefusals: [refusal] });
  await page.goto("/");
  await search(page, "Bright Lines");
  await expect(page.getByRole("button", { name: "Open the results" })).toBeVisible();
  expect((await widgets(page)).renders).toHaveLength(2);
  expect(await sentTurnstileTokens(page)).toEqual([
    "fake-turnstile-token-1",
    "fake-turnstile-token-2",
  ]);
  expect(await runTokens(page)).toEqual({ issued: ["mock-run-token-1"], refused: [] });

  expect(unexpected(problems)).toEqual([]);
});

test("a widget token refused twice ends the run, with no third check", async ({ page }) => {
  const problems = collectProblems(page);
  await fakeTurnstile(page);
  const refusal = {
    status: 401,
    code: "auth_expired",
    error: "This page needs to check the request again. Please try again.",
  };
  await useMockApi(page, { ...loadFixture("full-result"), runTokenRefusals: [refusal, refusal] });
  await page.goto("/");
  await search(page, "Bright Lines");
  await expect(page.getByRole("button", { name: "Try again", exact: true })).toBeEnabled();
  await page.waitForTimeout(500);
  expect((await widgets(page)).renders).toHaveLength(2);
  expect(await postsToRuns(page)).toBe(2);
  expect(await runTokens(page)).toEqual({ issued: [], refused: [] });
  expect(unexpected(problems)).toEqual([]);
});

test("a rate-limited refusal keeps the retry disabled, with the time left, until it ends", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await fakeTurnstile(page);
  await useMockApi(page, {
    ...loadFixture("full-result"),
    runTokenRefusals: [
      {
        status: 429,
        code: "rate_limited",
        error: "Too many requests. Please try again later.",
        retryAfter: 3,
      },
    ],
  });
  await page.goto("/");
  await search(page, "Bright Lines");
  await expect(page.getByText("Too many requests. Please try again later.")).toBeVisible();
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  const timeLeft = page.getByText(/^You can try again in [1-3] s\.$/);
  await expect(retry).toBeDisabled();
  await expect(timeLeft).toBeVisible();
  // The heading that takes the focus is described by the time left too.
  await expect(
    page.getByRole("heading", { name: "The analysis did not finish" }),
  ).toHaveAccessibleDescription(
    /Too many requests\. Please try again later\. You can try again in [1-3] s\./,
  );
  expect(await postsToRuns(page)).toBe(1);

  // Another search before then sends nothing either: the same refusal, the same wait.
  await search(page, "Something else");
  await expect(retry).toBeDisabled();
  await expect(timeLeft).toBeVisible();
  expect(await postsToRuns(page)).toBe(1);

  await expect(retry).toBeEnabled({ timeout: 5_000 });
  await expect(timeLeft).toHaveCount(0);
  await expect(page.locator("#error-retry-ready")).toHaveText("You can try again now.");
  expect(await postsToRuns(page)).toBe(1);
  await retry.click();
  await expect(page.getByRole("button", { name: "Open the results" })).toBeVisible();
  expect(await postsToRuns(page)).toBe(2);
  expect(unexpected(problems)).toEqual([]);
});

test("a rate limit refused inside the stream waits for its retryAfterMs", async ({ page }) => {
  const problems = collectProblems(page);
  await fakeTurnstile(page);
  const fixture = loadFixture("full-result");
  await useMockApi(page, {
    ...fixture,
    streams: {
      [ANALYZE]: {
        opens: [
          [
            {
              type: "error",
              code: "rate_limited",
              error: "Too many requests. Please try again later.",
              retryAfterMs: 2_000,
            },
            { type: "done" },
          ],
          fixture.streams[ANALYZE],
        ],
      },
    },
  });
  await page.goto("/");
  await search(page, "Bright Lines");
  const retry = page.getByRole("button", { name: "Try again", exact: true });
  await expect(retry).toBeDisabled();
  await expect(page.getByText(/^You can try again in [12] s\.$/)).toBeVisible();
  await expect(retry).toBeEnabled({ timeout: 5_000 });
  await retry.click();
  await expect(page.getByRole("button", { name: "Open the results" })).toBeVisible();
  expect(await postsToRuns(page)).toBe(2);
  expect(unexpected(problems)).toEqual([]);
});
