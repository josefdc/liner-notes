import { expect, type Page, test } from "@playwright/test";
import { apiRequests, loadFixture, useMockApi } from "./mock";

// The track picker shown when a search matches several songs: keyboard selection and the
// picker for small candidate lists.
const ANALYZE = "/api/analyze/stream";
const RESUME = "/api/analyze/stream/resume";

const hitl = loadFixture("hitl");
const candidates = hitl.streams[ANALYZE].find(
  (event: { type: string }) => event.type === "interrupt",
).candidates as Array<{ id: string; title: string; artist: string; releaseYear: string }>;

const resumes = (log: string[]) => log.filter((entry) => entry.startsWith(`stream ${RESUME}`));
const resumeWith = (id: string, pickedBy = "click") =>
  `stream ${RESUME}?threadId=thread-hitl&selectedTrackId=${id}&pickedBy=${pickedBy}`;

async function openPicker(page: Page) {
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Hurt");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  const picker = page.getByRole("listbox", { name: "Is this the right track?" });
  await expect(picker).toBeVisible();
  return picker;
}

const row = (page: Page, index: number) =>
  page.getByRole("option", { name: new RegExp(candidates[index].artist) });

test.describe("with three candidates", () => {
  test.beforeEach(async ({ page }) => {
    await useMockApi(page, hitl);
  });

  test("ArrowDown then Enter resumes with the highlighted candidate", async ({ page }) => {
    await openPicker(page);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect
      .poll(async () => resumes(await apiRequests(page)))
      .toEqual([resumeWith(candidates[1].id)]);
    await expect(page.getByText("Is this the right track?")).toHaveCount(0);
  });

  test("the list is one Tab stop: Shift+Tab from Search again returns to the highlighted row", async ({
    page,
  }) => {
    await openPicker(page);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Search again" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(row(page, 1)).toBeFocused();
    await page.keyboard.press("Enter");

    await expect
      .poll(async () => resumes(await apiRequests(page)))
      .toEqual([resumeWith(candidates[1].id)]);
  });

  test("ArrowUp wraps to the last candidate and Enter selects it", async ({ page }) => {
    await openPicker(page);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");

    await expect
      .poll(async () => resumes(await apiRequests(page)))
      .toEqual([resumeWith(candidates[2].id)]);
  });

  test("the picker takes the keyboard focus when it opens", async ({ page }) => {
    await openPicker(page);
    await expect(row(page, 0)).toBeFocused();
    // No click and no focus() call: the keys work right away.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect
      .poll(async () => resumes(await apiRequests(page)))
      .toEqual([resumeWith(candidates[1].id)]);
  });

  test("Home and End move to the first and last row, marked as the selected one", async ({
    page,
  }) => {
    await openPicker(page);
    await expect(row(page, 0)).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("End");
    await expect(row(page, 2)).toHaveAttribute("aria-selected", "true");
    await expect(row(page, 2)).toBeFocused();
    await expect(row(page, 0)).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("Home");
    await expect(row(page, 0)).toHaveAttribute("aria-selected", "true");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");

    await expect
      .poll(async () => resumes(await apiRequests(page)))
      .toEqual([resumeWith(candidates[2].id)]);
  });
});

test("two candidates show the picker instead of choosing one silently", async ({ page }) => {
  const two = candidates.slice(0, 2);
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: "thread-hitl" },
        {
          type: "interrupt",
          reason: "disambiguation",
          threadId: "thread-hitl",
          candidates: two,
          message: "Multiple songs found. Please select the correct one.",
        },
        { type: "done" },
      ],
      [RESUME]: hitl.streams[RESUME],
    },
  });
  await openPicker(page);
  for (const candidate of two) {
    await expect(
      page.getByRole("option", {
        name: `${candidate.title} ${candidate.artist} • ${candidate.releaseYear}`,
      }),
    ).toBeVisible();
  }
  await page.waitForTimeout(1000);
  expect(resumes(await apiRequests(page))).toEqual([]);
  await expect(page.getByText("Is this the right track?")).toBeVisible();
});
