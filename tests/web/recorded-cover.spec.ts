import { expect, type Page, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  animationsSettled,
  collectProblems,
  loadFixture,
  openPlayer,
  useMockApi,
} from "./mock";

// A recorded run keeps one image: the Cover Art Archive's cover of the release its MusicBrainz
// evidence names (apps/api/src/replay/recorder.ts). The replayed result shows it, credited to
// the archive; when the archive has no cover for the release (404) or the recording kept none,
// the page says the cover is not available instead of showing a stand-in image.

const RELEASE = "ae103b0a-b932-4009-acb6-388db1cf890b";
const ARCHIVE = `https://coverartarchive.org/release/${RELEASE}/front-500`;
const ARCHIVE_PAGE = `https://coverartarchive.org/release/${RELEASE}`;
const COVER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="500" height="500"><rect width="100%" height="100%" fill="#336699"/></svg>';

/** The recorded result, with `coverUrl` as given. */
function recorded(coverUrl = ARCHIVE) {
  const fixture = loadFixture("recorded-cover");
  const complete = fixture.streams["/api/analyze/stream"].find(
    (event: { type: string }) => event.type === "complete",
  );
  complete.data.coverUrl = coverUrl;
  return fixture;
}

/** Answers the archive's image requests with `status`; counts them. */
async function archive(page: Page, status: 200 | 404) {
  const requests: string[] = [];
  await page.route("https://coverartarchive.org/**", (route) => {
    requests.push(route.request().url());
    return status === 200
      ? route.fulfill({ contentType: "image/svg+xml", body: COVER_SVG })
      : route.fulfill({ status: 404, contentType: "text/plain", body: "Not Found" });
  });
  return requests;
}

/** The images drawn from the archive that loaded, by their alt text. */
const archiveImages = (page: Page) =>
  page.locator("#root img").evaluateAll(
    (images, prefix) =>
      images
        .filter((image) => (image as HTMLImageElement).src.startsWith(prefix))
        .map((image) => ({
          alt: image.getAttribute("alt"),
          loaded:
            (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0,
        })),
    "https://coverartarchive.org/",
  );

const credit = (page: Page) => page.getByRole("link", { name: /^Cover: / });

/** Images on the page that failed to load and are still drawn (a broken-image glyph). */
const brokenImages = (page: Page) =>
  page.locator("#root img").evaluateAll((images) =>
    images
      .filter((image) => {
        const img = image as HTMLImageElement;
        return img.complete && img.naturalWidth === 0;
      })
      .map((image) => (image as HTMLImageElement).src),
  );

test("a recorded run shows its Cover Art Archive cover, credited to the archive", async ({
  page,
}) => {
  const problems = collectProblems(page);
  const requests = await archive(page, 200);
  await useMockApi(page, recorded());
  await analyzeAndOpenDashboard(page, "Bright Lines");

  await expect(page.getByRole("region", { name: "Recorded run" })).toBeVisible();
  const hero = page.getByRole("img", { name: "Cover of Test Album", exact: true });
  await expect(hero).toBeVisible();
  // The cover and the blurred background behind it, both loaded.
  await expect
    .poll(() => archiveImages(page))
    .toEqual([
      { alt: "", loaded: true },
      { alt: "Cover of Test Album", loaded: true },
    ]);
  await expect(credit(page)).toBeVisible();
  await expect(credit(page)).toHaveText("Cover: Cover Art Archive (opens in a new tab)");
  await expect(credit(page)).toHaveAttribute("href", ARCHIVE_PAGE);
  await expect(page.getByText("Cover not available")).toHaveCount(0);

  await openPlayer(page);
  await expect(page.getByRole("img", { name: "Cover of Test Album" })).toBeVisible();
  await expect(credit(page)).toHaveAttribute("href", ARCHIVE_PAGE);
  await expect(page.getByText("Cover not available")).toHaveCount(0);
  expect(new Set(requests)).toEqual(new Set([ARCHIVE]));
  expect(problems).toEqual([]);
});

test("a recorded cover the archive does not hold (404) is not available, with no background", async ({
  page,
}) => {
  const requests = await archive(page, 404);
  await useMockApi(page, recorded());
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Bright Lines");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  // The analysis screen's cover of the track: nothing drawn for it, never a broken image. The
  // screen moves on to the Dashboard by itself a few seconds after the result: checked before.
  const proceed = page.getByRole("button", { name: "Open the results" });
  await expect(proceed).toBeVisible();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  const quick = { timeout: 1500 };
  await expect.poll(() => archiveImages(page), quick).toEqual([]);
  await expect.poll(() => brokenImages(page), quick).toEqual([]);
  await expect(proceed).toBeVisible({ timeout: 1 });
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible({
    timeout: 10_000,
  });
  await animationsSettled(page);

  await expect(page.getByText("Cover not available")).toBeVisible();
  await expect.poll(() => archiveImages(page)).toEqual([]);
  await expect(page.locator("#root img")).toHaveCount(0);
  await expect(credit(page)).toHaveCount(0);
  expect(requests.length).toBeGreaterThan(0);

  await openPlayer(page);
  await expect(page.getByText("Cover not available")).toBeVisible();
  await expect(page.locator("#root img")).toHaveCount(0);
  await expect(credit(page)).toHaveCount(0);
});

test("a recording without a cover says so and asks the archive for nothing", async ({ page }) => {
  const requests = await archive(page, 200);
  await useMockApi(page, recorded(""));
  await analyzeAndOpenDashboard(page, "Bright Lines");

  await expect(page.getByText("Cover not available")).toBeVisible();
  await expect(page.locator("#root img")).toHaveCount(0);
  await expect(credit(page)).toHaveCount(0);

  await openPlayer(page);
  await expect(page.getByText("Cover not available")).toBeVisible();
  await expect(page.locator("#root img")).toHaveCount(0);
  expect(requests).toEqual([]);
});

test("suggestions and the track picker show a placeholder, never a broken image, for a 404 cover", async ({
  page,
}) => {
  const requests = await archive(page, 404);
  const fixture = loadFixture("hitl");
  const interrupt = fixture.streams["/api/analyze/stream"].find(
    (event: { type: string }) => event.type === "interrupt",
  );
  for (const candidate of interrupt.candidates) candidate.coverUrl = ARCHIVE;
  fixture.suggestions = interrupt.candidates;
  await useMockApi(page, fixture);
  await page.goto("/");

  // The search suggestions, as a replaying server sends them: with the recorded cover.
  await page.getByPlaceholder(/Song title/).fill("Hurt");
  await expect(page.getByRole("option")).toHaveCount(interrupt.candidates.length);
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await expect.poll(() => archiveImages(page)).toEqual([]);
  expect(await brokenImages(page)).toEqual([]);
  await expect(page.locator("[role=option] [data-cover-placeholder]")).toHaveCount(
    interrupt.candidates.length,
  );

  // The track picker of an ambiguous search.
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(page.getByText("Is this the right track?")).toBeVisible();
  await expect.poll(() => archiveImages(page)).toEqual([]);
  expect(await brokenImages(page)).toEqual([]);
  await expect(page.locator("[data-cover-placeholder]")).toHaveCount(interrupt.candidates.length);
});

/** The recorded result whose release, named in the credit, is titled `title`. */
function releasedAs(title: string) {
  const fixture = recorded();
  const complete = fixture.streams["/api/analyze/stream"].find(
    (event: { type: string }) => event.type === "complete",
  );
  complete.data.evidence[0].title = `${title} — MusicBrainz release`;
  return fixture;
}

/**
 * The cover's figure and what sits beside it: their widths, the credit's height, and any
 * element of the row that reaches past the row's box (the hero clips what overflows).
 */
const coverLayout = (page: Page) =>
  page.locator("figure[data-cover]").evaluate((figure) => {
    const row = figure.parentElement as HTMLElement;
    const box = row.getBoundingClientRect();
    const outside = [...row.querySelectorAll("*")]
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(
        ({ rect }) =>
          rect.width > 0 && (rect.left < box.left - 0.5 || rect.right > box.right + 0.5),
      )
      .map(
        ({ element }) => `${element.tagName.toLowerCase()} ${element.textContent?.slice(0, 30)}`,
      );
    const frame = figure.firstElementChild as HTMLElement;
    const caption = figure.querySelector("figcaption");
    const info = figure.nextElementSibling as HTMLElement | null;
    return {
      figure: Math.round(figure.getBoundingClientRect().width),
      frame: Math.round(frame.getBoundingClientRect().width),
      info: info ? Math.round(info.getBoundingClientRect().width) : null,
      caption: caption ? Math.round(caption.getBoundingClientRect().height) : 0,
      overflow: row.scrollWidth > row.clientWidth + 1,
      outside,
    };
  });

const ZIGGY = "The Rise and Fall of Ziggy Stardust and the Spiders from Mars";
// 166 characters, ending in a 37-character word that has to break.
const LONG = `${"A Very Long Release Title That Keeps Going ".repeat(3)}Supercalifragilisticexpialidocious!!?`;

test("a long release title wraps under the cover and never squeezes or overflows the hero", async ({
  page,
}) => {
  expect(LONG).toHaveLength(166);
  await archive(page, 200);
  await page.setViewportSize({ width: 1024, height: 900 });
  // The credit of a release titled as the album shown: the width the track info has.
  await useMockApi(page, releasedAs("Test Album"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  const plain = await coverLayout(page);
  expect(plain).toMatchObject({ figure: 160, frame: 160, overflow: false, outside: [] });

  for (const title of [ZIGGY, LONG]) {
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await archive(page, 200);
    await useMockApi(page, releasedAs(title));
    await analyzeAndOpenDashboard(page, "Bright Lines");
    await expect(credit(page)).toContainText(title.slice(0, 20));
    const dashboard = await coverLayout(page);
    expect(dashboard, title).toMatchObject({
      figure: 160,
      frame: 160,
      info: plain.info,
      overflow: false,
      outside: [],
    });
    // At most three lines of chrome text (16 px each).
    expect(dashboard.caption, title).toBeLessThanOrEqual(48);
    // The whole credit stays in the link's title.
    await expect(credit(page)).toHaveAttribute("title", `Cover: ${title} · Cover Art Archive`);

    await openPlayer(page);
    const player = await coverLayout(page);
    // lg (1024 px): a 320 px cover, the credit within it.
    expect(player, title).toMatchObject({ figure: 320, frame: 320, overflow: false, outside: [] });
    expect(player.caption, title).toBeLessThanOrEqual(48);
  }
});
