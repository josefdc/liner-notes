import { expect, test } from "@playwright/test";
import { analyzeAndOpenDashboard, loadFixture, openPlayer, useMockApi } from "./mock";

// The screens link to the app's source code. The test build sets no VITE_SOURCE_URL, so the
// link is the default, the public repository (apps/web/src/sourceUrl.test.ts covers the setting).
const REPOSITORY = "https://github.com/josefdc/liner-notes";
const STORED_ID = "4cOdK2wGLETKBW3PvgPWqT";

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`at ${viewport.width} px the search, a link and the result link to the source code`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await useMockApi(page, loadFixture("full-result"));
    await page.goto("/");
    const source = page.getByRole("contentinfo").getByRole("link", { name: /^Source/ });
    await expect(source).toBeInViewport({ ratio: 1 });
    await expect(source).toHaveAttribute("href", REPOSITORY);
    // In a new tab, which it says: following it never unloads a run under way.
    await expect(source).toHaveAttribute("target", "_blank");
    await expect(source).toHaveAttribute("rel", "noopener noreferrer");
    await expect(source).toHaveAccessibleName("Source (opens in a new tab)");

    await analyzeAndOpenDashboard(page, "Bright Lines", { reload: false });
    await expect(source).toBeInViewport({ ratio: 1 });
    await expect(source).toHaveAttribute("href", REPOSITORY);

    await page.goto(`/t/${STORED_ID}`);
    await expect(page.getByRole("heading", { name: "Not analyzed yet" })).toBeVisible();
    await expect(source).toBeInViewport({ ratio: 1 });
  });
}

test("the Player keeps the bottom of a phone's screen for its tab bar, and links to the source from md up", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, loadFixture("full-result"));
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  const source = page.getByRole("contentinfo").getByRole("link", { name: /^Source/ });
  await expect(source).toBeInViewport({ ratio: 1 });
  await expect(source).toHaveAttribute("href", REPOSITORY);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(source).toBeHidden();
  const tabs = await page.getByRole("tablist", { name: "Player sections" }).boundingBox();
  expect((tabs?.y ?? 0) + (tabs?.height ?? 0)).toBeCloseTo(844, 0);
});
