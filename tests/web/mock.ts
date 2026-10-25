import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnalyzeStreamEvent, FactoidStreamEvent } from "@liner-notes/contract";
import { expect, type Page } from "@playwright/test";
import {
  contractMisfits,
  type MockConfig,
  streamRuleBreaks,
  withEnvelope,
} from "../mock-sse/envelope";

const mockDir = join(dirname(fileURLToPath(import.meta.url)), "..", "mock-sse");

/** Loads a mock-SSE fixture from tests/mock-sse/fixtures. */
export function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(mockDir, "fixtures", `${name}.json`), "utf8"));
}

/**
 * The configuration the mocked API replays: every stream event with the run id and `seq` the
 * API adds (../mock-sse/envelope.ts), checked against the contract's event unions, and every
 * stream checked against the rules the API keeps (one outcome, `done` last, `seq` 0, 1, 2…).
 * A stream event or a stream the API could not send fails the test here, so the mock cannot
 * drift from the server; one sent on purpose goes in `{ "$unchecked": event }`.
 */
export function mockConfig(fixture: unknown): MockConfig {
  const breaks = streamRuleBreaks(fixture as MockConfig);
  if (breaks.length > 0) {
    throw new Error(`Mock streams the API cannot send:\n${breaks.join("\n")}`);
  }
  const config = withEnvelope(fixture as MockConfig);
  const misfits = contractMisfits(config, {
    analysis: AnalyzeStreamEvent,
    factoids: FactoidStreamEvent,
  });
  if (misfits.length > 0) {
    throw new Error(`Mock stream events the API cannot send:\n${misfits.join("\n")}`);
  }
  return config;
}

/** Installs the mocked API (tests/mock-sse/mock-api.js) configured with a fixture. */
export async function useMockApi(page: Page, fixture: unknown) {
  const config = mockConfig(fixture);
  // Keep the tests off the network: web fonts are not needed to check behaviour.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await page.addInitScript((value) => {
    (window as unknown as { __mockApi: unknown }).__mockApi = value;
  }, config);
  await page.addInitScript({ path: join(mockDir, "mock-api.js") });
}

type MockWindow = {
  __mockApi: { log: string[]; streamLog: string[]; release: (name: string) => void };
};

/** API requests the app has made so far ("fetch <path>" or "stream <path>?<query>"). */
export function apiRequests(page: Page) {
  return page.evaluate(() => (window as unknown as MockWindow).__mockApi.log);
}

/** What the mocked streams have done so far ("<path> open|<event>|closed|ended"). */
export function streamLog(page: Page) {
  return page.evaluate(() => (window as unknown as MockWindow).__mockApi.streamLog);
}

/** Lets streams paused at `{ "$wait": name }` continue. */
export function releaseStream(page: Page, name: string) {
  return page.evaluate((wait) => (window as unknown as MockWindow).__mockApi.release(wait), name);
}

/** The result event of the full-result fixture, for tests that build their own streams. */
export function fullResultData() {
  const events = loadFixture("full-result").streams["/api/analyze/stream"] as Array<{
    type: string;
    data?: unknown;
  }>;
  return events.find((event) => event.type === "complete")?.data;
}

/**
 * Collects console errors and warnings, and uncaught page errors. Failed resource loads are
 * left out: the font requests are aborted on purpose (see useMockApi).
 */
export function collectProblems(page: Page) {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.text().startsWith("Failed to load resource")) return;
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

/**
 * Waits until every finite animation and transition on the page has finished: a view that just
 * mounted plays its entrance animations (fades, slides, staggered cards) for up to about a
 * second, and a size, position or colour read before then depends on how fast the page got
 * there. Looping animations (spinners, glows) are left running.
 */
export async function animationsSettled(page: Page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY,
      ),
  );
}

/** Runs a search against the mocked stream and continues to the Dashboard. */
export async function analyzeAndOpenDashboard(
  page: Page,
  query: string,
  { reload = true }: { reload?: boolean } = {},
) {
  if (reload) await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill(query);
  await page.getByRole("button", { name: "ANALYZE_SONG" }).click();
  await page.getByRole("button", { name: "PROCEED TO COMMAND CENTER" }).click();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  // The connected tracks follow once the link reader has loaded.
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await animationsSettled(page);
}

/** Opens the Player from the Dashboard. */
export async function openPlayer(page: Page) {
  await page.getByRole("button", { name: "VIEW FULL ANALYSIS" }).click();
  await expect(page.getByRole("button", { name: /BACK TO BASE/ })).toBeVisible();
  await animationsSettled(page);
}
