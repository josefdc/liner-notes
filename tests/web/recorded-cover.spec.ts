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
const ARCHIVE = `https://coverartarchive.org/release/${RELEASE}/front-250`;
const ARCHIVE_PAGE = `https://coverartarchive.org/release/${RELEASE}`;
const COVER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="250" height="250"><rect width="100%" height="100%" fill="#336699"/></svg>';

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
  await page.getByRole("button", { name: "ANALYZE_SONG" }).click();
  // The analysis screen's cover of the track: nothing drawn for it, never a broken image. The
  // screen moves on to the Dashboard by itself a few seconds after the result: checked before.
  const proceed = page.getByRole("button", { name: "PROCEED TO COMMAND CENTER" });
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
  await page.getByRole("button", { name: "ANALYZE_SONG" }).click();
  await expect(page.getByText("Is this the right track?")).toBeVisible();
  await expect.poll(() => archiveImages(page)).toEqual([]);
  expect(await brokenImages(page)).toEqual([]);
  await expect(page.locator("[data-cover-placeholder]")).toHaveCount(interrupt.candidates.length);
});
