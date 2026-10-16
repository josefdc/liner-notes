import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Page } from "@playwright/test";

const mockDir = join(dirname(fileURLToPath(import.meta.url)), "..", "mock-sse");

/** Loads a mock-SSE fixture from tests/mock-sse/fixtures. */
export function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(mockDir, "fixtures", `${name}.json`), "utf8"));
}

/** Installs the mocked API (tests/mock-sse/mock-api.js) configured with a fixture. */
export async function useMockApi(page: Page, fixture: unknown) {
  // Keep the tests off the network: web fonts are not needed to check behaviour.
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
  await page.addInitScript((config) => {
    (window as unknown as { __mockApi: unknown }).__mockApi = config;
  }, fixture);
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
}

/** Opens the Player from the Dashboard. */
export async function openPlayer(page: Page) {
  await page.getByRole("button", { name: "VIEW FULL ANALYSIS" }).click();
  await expect(page.getByRole("button", { name: /BACK TO BASE/ })).toBeVisible();
}
