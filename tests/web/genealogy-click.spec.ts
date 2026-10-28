import { expect, type Page, test } from "@playwright/test";
import { analyzeAndOpenDashboard, apiRequests, loadFixture, openPlayer, useMockApi } from "./mock";

// A click on a connected track (a genealogy node) on the Dashboard analyses that track: by its
// Spotify id when the node was matched to one, with the node's title and artist as the text;
// by its text alone when it was not. On the Player's map a click only selects the track: its
// panel's "Analyze this track" analyses it, the same way.
const ANALYZE = "/api/analyze/stream";

/** The full-result fixture, with its connected track changed by `node`. */
function resultWithNode(node: Record<string, unknown>) {
  const fixture = loadFixture("full-result");
  const complete = fixture.streams[ANALYZE].find(
    (event: { type: string }) => event.type === "complete",
  );
  const nodes = complete.data.genealogy.nodes as Array<Record<string, unknown>>;
  const index = nodes.findIndex((n) => n.id === "origin1");
  nodes[index] = { ...nodes[index], ...node };
  return fixture;
}

const analyses = async (page: Page) =>
  (await apiRequests(page)).filter((entry) => entry.startsWith(`stream ${ANALYZE}?`));

test("a node matched to a Spotify track is analysed by its id, with its title and artist", async ({
  page,
}) => {
  await useMockApi(
    page,
    resultWithNode({
      spotifyId: "28cnXtME493VX9NOw9cIUh",
      trackTitle: "Older Record",
      trackArtist: "Someone",
    }),
  );
  await analyzeAndOpenDashboard(page, "Bright Lines");

  await page.getByRole("button", { name: /Older Record/ }).click();

  await expect
    .poll(async () => (await analyses(page)).slice(1))
    .toEqual([`stream ${ANALYZE}?query=Older%20Record%20Someone&trackId=28cnXtME493VX9NOw9cIUh`]);
});

test("a node without a Spotify track is analysed by its text alone", async ({ page }) => {
  await useMockApi(page, loadFixture("full-result"));
  await analyzeAndOpenDashboard(page, "Bright Lines");

  await page.getByRole("button", { name: /Older Record/ }).click();

  await expect
    .poll(async () => (await analyses(page)).slice(1))
    .toEqual([`stream ${ANALYZE}?query=${encodeURIComponent("Older Record - Someone (1984)")}`]);
});

test("on the map a click selects a node; its panel's Analyze analyses it by its id", async ({
  page,
}) => {
  await useMockApi(
    page,
    resultWithNode({
      spotifyId: "28cnXtME493VX9NOw9cIUh",
      trackTitle: "Older Record",
      trackArtist: "Someone",
    }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);

  const node = page.locator('#panel-genealogy [aria-label^="Older Record"]').first();
  await node.scrollIntoViewIfNeeded();
  await node.click();
  await expect(node).toHaveAttribute("aria-pressed", "true");
  expect((await analyses(page)).slice(1)).toEqual([]);

  await page.getByTestId("node-detail").getByRole("button", { name: "Analyze this track" }).click();
  await expect
    .poll(async () => (await analyses(page)).slice(1))
    .toEqual([`stream ${ANALYZE}?query=Older%20Record%20Someone&trackId=28cnXtME493VX9NOw9cIUh`]);
});
