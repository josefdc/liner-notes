import { expect, test } from "@playwright/test";
import { collectProblems, loadFixture, useMockApi } from "./mock";

// useMockApi keeps every spec off the network: a request to a host other than 127.0.0.1 or
// localhost is never sent. A Cover Art Archive picture is an empty image, a host the spec routes
// itself is left to its route, and anything else is refused and listed by collectProblems.

// Should the guard ever be missing, the browser here still resolves no outside name, so these
// tests send nothing off the machine either way.
test.use({
  launchOptions: {
    args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost"],
  },
});

const OUTSIDE = "https://outside.example";
const COVER = "https://coverartarchive.org/release/0000/front-500";

test("a request to an outside host is refused and listed, and a cover is an empty picture", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, loadFixture("full-result"));
  await page.setContent(
    `<img id="cover" src="${COVER}" alt=""><img src="${OUTSIDE}/pic.png" alt="">`,
  );
  await page.evaluate((url) => fetch(url).catch(() => null), `${OUTSIDE}/data.json`);

  await expect
    .poll(() => [...problems].sort())
    .toEqual([
      "error: Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector",
      "error: Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector",
      `outside request: GET ${OUTSIDE}/data.json`,
      `outside request: GET ${OUTSIDE}/pic.png`,
    ]);
  await expect
    .poll(() => page.locator("#cover").evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(10);
});

test("a spec's own route for an outside host is used first", async ({ page }) => {
  const problems = collectProblems(page);
  await page.route(`${OUTSIDE}/**`, (route) => route.fulfill({ body: "routed" }));
  await useMockApi(page, loadFixture("full-result"));
  await page.setContent("<p>collector</p>");

  const body = await page.evaluate(
    (url) => fetch(url).then((response) => response.text()),
    `${OUTSIDE}/data.json`,
  );
  expect(body).toBe("routed");
  expect(problems).toEqual([]);
});

// The collector leaves nothing out: Chromium's line for a request cut off by a change of the
// host's network fails a test like any other console error, and so does a page error that names it.
test("a network-change line and a page error naming it are both problems", async ({ page }) => {
  const problems = collectProblems(page);
  await page.setContent("<p>collector</p>");
  await page.evaluate(() => {
    console.error("Failed to load resource: net::ERR_NETWORK_CHANGED");
    setTimeout(() => {
      throw new Error("net::ERR_NETWORK_CHANGED");
    });
  });

  await expect
    .poll(() => [...problems])
    .toEqual([
      "error: Failed to load resource: net::ERR_NETWORK_CHANGED",
      "pageerror: net::ERR_NETWORK_CHANGED",
    ]);
});
