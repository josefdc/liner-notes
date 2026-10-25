import { expect, test } from "@playwright/test";
import { analyzeAndOpenDashboard, loadFixture, useMockApi } from "./mock";

// Inter and IBM Plex Mono are served with the app (apps/web/public/fonts, styles/fonts.css), so
// the page renders in its own fonts without asking a third party for them. The Dashboard sets
// body text in Inter and measured values in IBM Plex Mono, so both families are in use there.
const fixture = loadFixture("full-result");

// FontFace.family may come back quoted ("IBM Plex Mono").
const unquote = (family: string) => family.replace(/^["']|["']$/g, "");

test("Inter and IBM Plex Mono load from the app and nothing is asked of Google Fonts", async ({
  page,
}) => {
  const thirdParty: string[] = [];
  const fontResponses: string[] = [];
  page.on("request", (request) => {
    if (/googleapis|gstatic/.test(new URL(request.url()).hostname)) thirdParty.push(request.url());
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname.startsWith("/fonts/")) {
      fontResponses.push(
        `${url.pathname} ${response.status()} ${response.headers()["content-type"]}`,
      );
    }
  });

  await useMockApi(page, fixture);
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await page.evaluate(() => document.fonts.ready);

  const fonts = await page.evaluate(() => ({
    inter: document.fonts.check("16px Inter"),
    mono: document.fonts.check('16px "IBM Plex Mono"'),
    loaded: [...document.fonts]
      .filter((face) => face.status === "loaded")
      .map((face) => ({ family: face.family, weight: face.weight })),
  }));
  expect(fonts.inter).toBe(true);
  expect(fonts.mono).toBe(true);
  // check() also answers true for a family it has no face for, so the faces themselves must
  // have loaded: the variable Inter and at least the regular IBM Plex Mono.
  const loaded = fonts.loaded.map(({ family, weight }) => `${unquote(family)} ${weight}`);
  expect(loaded).toContain("Inter 100 900");
  expect(loaded).toContain("IBM Plex Mono 400");

  for (const line of fontResponses) expect(line).toMatch(/^\/fonts\/[\w-]+\.woff2 200 font\/woff2/);
  expect(
    fontResponses.some((line) => line.startsWith("/fonts/inter-latin-wght-normal.woff2")),
  ).toBe(true);
  expect(thirdParty).toEqual([]);
});

test("the page names itself to search engines and link previews, and has an icon", async ({
  page,
}) => {
  await useMockApi(page, fixture);
  await page.goto("/");

  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    /samples, credits and history.*measured, sourced or inferred/,
  );
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Liner Notes");
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "website");
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
    "content",
    /measured, sourced or inferred/,
  );

  const icon = await page.locator('link[rel="icon"]').getAttribute("href");
  expect(icon).toBe("/favicon.svg");
  const response = await page.request.get(icon ?? "");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/svg+xml");
});
