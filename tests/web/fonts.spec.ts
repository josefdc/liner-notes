import { type CDPSession, expect, type Page, type Request, test } from "@playwright/test";
import { analyzeAndOpenDashboard, loadFixture, useMockApi } from "./mock";

// Inter and IBM Plex Mono are served with the app (apps/web/public/fonts, styles/fonts.css), so
// the page renders in its own fonts without asking a third party for them. Each script is a
// separate file with its unicode-range: a Latin page fetches only the Latin files, and a name such
// as "Dvořák", "Кино" or "Βαγγέλης" brings in the faces it needs instead of falling back to a
// system font.
const fixture = loadFixture("measured-v2");
// Latin Extended, Cyrillic and extended Cyrillic (Қ, ұ): in both families.
const NAMES = "Dvořák Łona Beyoncé Кино Қайрат Нұртас";
// Greek: in Inter only (IBM Plex Mono has no Greek).
const GREEK = "Βαγγέλης Παπαθανασίου";
const PRELOADED = "/fonts/inter-latin-wght-normal.woff2";
// The files a Latin-only page uses: Inter's latin subset and IBM Plex Mono's Latin1 split.
const LATIN_FILE = /^\/fonts\/(inter-latin-wght-normal|IBMPlexMono-\w+-Latin1)\.woff2$/;

/** Records every request: the ones to another origin, and the font files by path. */
function recordRequests(page: Page, origin: string) {
  const offOrigin: string[] = [];
  const fonts: string[] = [];
  page.on("request", (request: Request) => {
    const url = new URL(request.url());
    // data: and blob: URLs never leave the page.
    if (url.protocol !== "data:" && url.protocol !== "blob:" && url.origin !== origin) {
      offOrigin.push(request.url());
    }
    if (url.origin === origin && url.pathname.startsWith("/fonts/")) fonts.push(url.pathname);
  });
  return { offOrigin, fonts };
}

/** The fonts Chromium used to draw an element's text (CDP CSS.getPlatformFontsForNode). */
async function platformFonts(cdp: CDPSession, selector: string) {
  const { root } = await cdp.send("DOM.getDocument", { depth: -1 });
  const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector });
  const { fonts } = await cdp.send("CSS.getPlatformFontsForNode", { nodeId });
  return fonts.map((font) => `${font.isCustomFont ? "" : "system "}${font.postScriptName}`);
}

async function openCdp(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("DOM.enable");
  await cdp.send("CSS.enable");
  return cdp;
}

test("a Latin page loads Inter and IBM Plex Mono from the app, and only their Latin files", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? "").origin;
  const requests = recordRequests(page, origin);
  const fontResponses: string[] = [];
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

  // Both families have faces that loaded. (document.fonts.check() would answer true even for a
  // family with no face at all.)
  const loaded = await page.evaluate(() =>
    [...document.fonts]
      .filter((face) => face.status === "loaded")
      .map((face) => face.family.replace(/^["']|["']$/g, "")),
  );
  expect(loaded).toContain("Inter");
  expect(loaded).toContain("IBM Plex Mono");

  // A measured value's provenance line is set in IBM Plex Mono, and drawn with it.
  const line = page
    .getByRole("list", { name: "Audio values" })
    .getByText(/^Measured · /)
    .first();
  expect(await line.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(
    /^"IBM Plex Mono"/,
  );
  await line.evaluate((element) => element.setAttribute("data-font-probe", ""));
  const cdp = await openCdp(page);
  expect(await platformFonts(cdp, "[data-font-probe]")).toEqual(["IBMPlexMono"]);
  // Headings and body text are set in Inter.
  const heading = page.getByRole("heading", { name: "Command Center" });
  expect(await heading.evaluate((element) => getComputedStyle(element).fontFamily)).toMatch(
    /^Inter\b/,
  );

  // The preload, with crossorigin so the stylesheet's request can use it: Inter is fetched once,
  // by the preload.
  const preload = page.locator('link[rel="preload"][as="font"]');
  await expect(preload).toHaveAttribute("href", PRELOADED);
  await expect(preload).toHaveAttribute("crossorigin", "");
  const entries = await page.evaluate(
    (path) =>
      performance
        .getEntriesByType("resource")
        .filter((entry) => new URL(entry.name).pathname === path)
        .map((entry) => (entry as PerformanceResourceTiming).initiatorType),
    PRELOADED,
  );
  expect(entries).toEqual(["link"]);

  // Each file once, all of them Latin, all served as woff2.
  expect(requests.fonts).toContain(PRELOADED);
  expect(requests.fonts).toContain("/fonts/IBMPlexMono-Regular-Latin1.woff2");
  expect(new Set(requests.fonts).size).toBe(requests.fonts.length);
  for (const path of requests.fonts) expect(path).toMatch(LATIN_FILE);
  for (const response of fontResponses) expect(response).toMatch(/ 200 font\/woff2$/);
  expect(requests.offOrigin).toEqual([]);
});

test("names outside Latin-1 are drawn in Inter and IBM Plex Mono throughout", async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? "").origin;
  const requests = recordRequests(page, origin);
  await useMockApi(page, fixture);
  await page.goto("/");
  await expect(page.getByPlaceholder(/Song title/)).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  for (const path of requests.fonts) expect(path).toMatch(LATIN_FILE);

  // The names in the body face, the mono face, and the mono face at semibold: IBM Plex Mono 600
  // is a face of its own (PostScript name IBMPlexMono-SmBld), not the medium one made bold.
  const sans = { family: "var(--font-sans)", face: /^Inter/ };
  const probes = [
    { id: "sans", text: `${NAMES} ${GREEK}`, weight: "400", ...sans },
    { id: "sans-600", text: `${NAMES} ${GREEK}`, weight: "600", ...sans },
    { id: "mono", text: NAMES, family: "var(--font-mono)", weight: "400", face: /^IBMPlexMono$/ },
    {
      id: "mono-600",
      text: NAMES,
      family: "var(--font-mono)",
      weight: "600",
      face: /^IBMPlexMono-SmBld$/,
    },
  ];
  await page.evaluate(
    (probes) => {
      for (const { id, text, family, weight } of probes) {
        const element = document.createElement("p");
        element.id = `probe-${id}`;
        element.textContent = text;
        element.style.fontFamily = family;
        element.style.fontWeight = weight;
        document.body.append(element);
      }
    },
    probes.map(({ id, text, family, weight }) => ({ id, text, family, weight })),
  );

  const cdp = await openCdp(page);
  for (const { id, face } of probes) {
    // font-display: swap draws a fallback until the faces arrive; then every glyph is theirs.
    await expect
      .poll(async () => {
        const fonts = await platformFonts(cdp, `#probe-${id}`);
        return fonts.length > 0 && fonts.every((font) => face.test(font)) ? "ours" : fonts;
      })
      .toBe("ours");
  }

  // The extra scripts were fetched for this text, each file once.
  for (const path of [
    "/fonts/inter-latin-ext-wght-normal.woff2",
    "/fonts/inter-cyrillic-wght-normal.woff2",
    "/fonts/inter-cyrillic-ext-wght-normal.woff2",
    "/fonts/inter-greek-wght-normal.woff2",
    "/fonts/IBMPlexMono-Regular-Latin2.woff2",
    "/fonts/IBMPlexMono-Regular-Cyrillic.woff2",
    "/fonts/IBMPlexMono-SemiBold-Latin2.woff2",
    "/fonts/IBMPlexMono-SemiBold-Cyrillic.woff2",
  ]) {
    expect(requests.fonts).toContain(path);
  }
  expect(new Set(requests.fonts).size).toBe(requests.fonts.length);
  expect(requests.offOrigin).toEqual([]);
});

test("the page names itself to search engines and link previews, and has an icon", async ({
  page,
}) => {
  await useMockApi(page, fixture);
  await page.goto("/");

  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    /samples, credits and history.*claims are measured, sourced or inferred/,
  );
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Liner Notes");
  await expect(page.locator('meta[property="og:type"]')).toHaveAttribute("content", "website");
  await expect(page.locator('meta[property="og:description"]')).toHaveAttribute(
    "content",
    /claims are measured, sourced or inferred/,
  );

  const icon = await page.locator('link[rel="icon"]').getAttribute("href");
  expect(icon).toBe("/favicon.svg");
  const response = await page.request.get(icon ?? "");
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toContain("image/svg+xml");
});
