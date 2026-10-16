import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "fixtures/hitl.json"), "utf8"));

test("an ambiguous search shows the track picker with every candidate", async ({ page }) => {
  await page.addInitScript((config) => {
    (window as unknown as { __mockApi: unknown }).__mockApi = config;
  }, fixture);
  await page.addInitScript({ path: join(here, "mock-api.js") });

  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Hurt");
  await page.getByRole("button", { name: "ANALYZE_SONG" }).click();

  await expect(page.getByText("Is this the right track?")).toBeVisible();
  for (const candidate of fixture.streams["/api/analyze/stream"][2].candidates) {
    await expect(
      page.getByRole("button", {
        name: `${candidate.title} ${candidate.artist} • ${candidate.releaseYear}`,
      }),
    ).toBeVisible();
  }

  const log = await page.evaluate(
    () => (window as unknown as { __mockApi: { log: string[] } }).__mockApi.log,
  );
  expect(log).toContain("stream /api/analyze/stream?query=Hurt");
});
