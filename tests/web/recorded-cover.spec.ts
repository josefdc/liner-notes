import { expect, type Page, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
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

const credit = (page: Page) => page.getByRole("link", { name: "Cover: Cover Art Archive" });

test("a recorded run shows its Cover Art Archive cover, credited to the archive", async ({
  page,
}) => {
  const problems = collectProblems(page);
  const requests = await archive(page, 200);
  await useMockApi(page, recorded());
  await analyzeAndOpenDashboard(page, "Bright Lines");

  await expect(page.getByRole("region", { name: "Recorded run" })).toBeVisible();
  const hero = page.getByRole("img", { name: "Bright Lines", exact: true });
  await expect(hero).toBeVisible();
  // The cover and the blurred background behind it, both loaded.
  await expect
    .poll(() => archiveImages(page))
    .toEqual([
      { alt: "", loaded: true },
      { alt: "Bright Lines", loaded: true },
    ]);
  await expect(credit(page)).toBeVisible();
  await expect(credit(page)).toHaveAttribute("href", ARCHIVE_PAGE);
  await expect(page.getByText("Cover not available")).toHaveCount(0);

  await openPlayer(page);
  await expect(page.getByRole("img", { name: "Album Art" })).toBeVisible();
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
  await analyzeAndOpenDashboard(page, "Bright Lines");

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
