import { expect, test } from "@playwright/test";
import { collectProblems } from "./mock";

// The shared collector (mock.ts collectProblems) leaves out Chromium's line for a request cut off
// by a change of the host's network, and that line alone: every other console error, including
// any other `Failed to load resource` line, still fails a test that expects none.

const NETWORK_CHANGED = "Failed to load resource: net::ERR_NETWORK_CHANGED";

test("a host network change is left out of the problems, and every other error is kept", async ({
  page,
}) => {
  await page.setContent("<p>collector</p>");
  const problems = collectProblems(page);
  const seen: string[] = [];
  page.on("console", (message) => seen.push(`${message.type()}: ${message.text()}`));

  await page.evaluate((networkChanged) => {
    console.error(networkChanged);
    console.error("Failed to load resource: net::ERR_FAILED");
    console.error("Failed to load resource: net::ERR_INTERNET_DISCONNECTED");
    console.error(`${networkChanged} `);
    console.error(`Uncaught: ${networkChanged}`);
    console.warn(networkChanged);
    console.error("x");
  }, NETWORK_CHANGED);

  // The browser reports the line as Chromium does a request cut off by a network change.
  await expect.poll(() => seen.at(-1)).toBe("error: x");
  expect(seen[0]).toBe(`error: ${NETWORK_CHANGED}`);
  expect(problems).toEqual([
    "error: Failed to load resource: net::ERR_FAILED",
    "error: Failed to load resource: net::ERR_INTERNET_DISCONNECTED",
    `error: ${NETWORK_CHANGED} `,
    `error: Uncaught: ${NETWORK_CHANGED}`,
    `warning: ${NETWORK_CHANGED}`,
    "error: x",
  ]);
  expect(problems.networkChanged).toBe(1);
});

test("a request the browser could not load is still a problem", async ({ page }) => {
  // A request refused here, as Chromium refuses one it cannot send: the browser's own line, of the
  // same form as a network change's, is kept.
  await page.route("http://refused.invalid/**", (route) => route.abort("internetdisconnected"));
  await page.setContent("<p>collector</p>");
  const problems = collectProblems(page);

  await page.setContent('<img src="http://refused.invalid/cover.png" alt="">');

  await expect
    .poll(() => [...problems])
    .toEqual(["error: Failed to load resource: net::ERR_INTERNET_DISCONNECTED"]);
  expect(problems.networkChanged).toBe(0);
});
