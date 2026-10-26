import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";
import { mockConfig } from "../web/mock";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures/hitl.json"), "utf8"));
const candidates = fixture.streams["/api/analyze/stream"].find(
  (event: { type: string }) => event.type === "interrupt",
).candidates as Array<{ id: string; title: string; artist: string; releaseYear: string }>;

type MockWindow = { __mockApi: { log: string[] } };
const requests = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as MockWindow).__mockApi.log);

test.beforeEach(async ({ page }) => {
  await page.addInitScript((config) => {
    (window as unknown as { __mockApi: unknown }).__mockApi = config;
  }, mockConfig(fixture));
  await page.addInitScript({ path: join(here, "mock-api.js") });
});

test("an ambiguous search shows the track picker and keeps it after the stream ends", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Hurt");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();

  const picker = page.getByText("Is this the right track?");
  await expect(picker).toBeVisible();
  for (const candidate of candidates) {
    await expect(
      page.getByRole("button", {
        name: `${candidate.title} ${candidate.artist} • ${candidate.releaseYear}`,
      }),
    ).toBeVisible();
  }

  // The stream has ended ("done"); the picker must stay and no fallback request may follow.
  await page.waitForTimeout(1000);
  await expect(picker).toBeVisible();
  const log = await requests(page);
  expect(log).toContain("stream /api/analyze/stream?query=Hurt");
  expect(log.filter((entry) => entry.startsWith("fetch /api/analyze"))).toEqual([]);
  expect(log.filter((entry) => entry.includes("/resume"))).toEqual([]);
});

test("choosing a candidate resumes the analysis with that track", async ({ page }) => {
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Hurt");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();

  const second = candidates[1];
  await page
    .getByRole("button", { name: `${second.title} ${second.artist} • ${second.releaseYear}` })
    .click();

  await expect
    .poll(() => requests(page))
    .toContain(
      `stream /api/analyze/stream/resume?threadId=thread-hitl&selectedTrackId=${second.id}&pickedBy=click`,
    );
  // The resume stream ends with "done": no fallback request and no error screen.
  await page.waitForTimeout(500);
  expect((await requests(page)).filter((entry) => entry.startsWith("fetch /api/analyze"))).toEqual(
    [],
  );
  await expect(page.getByRole("heading", { name: "The analysis did not finish" })).toHaveCount(0);
});
