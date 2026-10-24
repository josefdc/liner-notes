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
const resumeWith = (id: string) => `stream ${RESUME}?threadId=thread-hitl&selectedTrackId=${id}`;

async function openPicker(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill("Hurt");
  await page.getByRole("button", { name: "ANALYZE_SONG" }).click();
  const picker = page.locator('div[tabindex="0"]', { hasText: "Is this the right track?" });
  await expect(picker).toBeVisible();
  return picker;
}

test.describe("with three candidates", () => {
  test.beforeEach(async ({ page }) => {
    await useMockApi(page, hitl);
  });

  test("ArrowDown then Enter resumes with the highlighted candidate", async ({ page }) => {
    const picker = await openPicker(page);
    await picker.focus();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect
      .poll(async () => resumes(await apiRequests(page)))
      .toEqual([resumeWith(candidates[1].id)]);
    await expect(page.getByText("Is this the right track?")).toHaveCount(0);
  });

  test("Tab, ArrowDown, Enter resumes with the highlighted candidate, not the focused row", async ({
    page,
  }) => {
    const picker = await openPicker(page);
    await picker.focus();
    // Tab moves focus onto the first row; the arrow then moves the highlight to the second.
    await page.keyboard.press("Tab");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect
      .poll(async () => resumes(await apiRequests(page)))
      .toEqual([resumeWith(candidates[1].id)]);
  });

  test("ArrowUp wraps to the last candidate and Enter selects it", async ({ page }) => {
    const picker = await openPicker(page);
    await picker.focus();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("Enter");

    await expect
      .poll(async () => resumes(await apiRequests(page)))
      .toEqual([resumeWith(candidates[2].id)]);
  });

  test("the picker takes the keyboard focus when it opens", async ({ page }) => {
    const picker = await openPicker(page);
    await expect(picker).toBeFocused();
    // No click and no focus() call: the keys work right away.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");

    await expect
      .poll(async () => resumes(await apiRequests(page)))
      .toEqual([resumeWith(candidates[1].id)]);
  });

  test("Home and End move to the first and last row, marked as the current one", async ({
    page,
  }) => {
    const picker = await openPicker(page);
    await picker.focus();
    const row = (index: number) =>
      page.getByRole("button", { name: new RegExp(candidates[index].artist) });
    await expect(row(0)).toHaveAttribute("aria-current", "true");

    await page.keyboard.press("End");
    await expect(row(2)).toHaveAttribute("aria-current", "true");
    await expect(row(0)).not.toHaveAttribute("aria-current", "true");
    await page.keyboard.press("Home");
    await expect(row(0)).toHaveAttribute("aria-current", "true");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");

    await expect
      .poll(async () => resumes(await apiRequests(page)))
      .toEqual([resumeWith(candidates[2].id)]);
  });

  test("Tab onto a row stops the countdown; Enter then resumes with that row", async ({ page }) => {
    const picker = await openPicker(page);
    await picker.focus();
    // Container, then the three rows: focus and highlight end on the third row.
    for (let i = 0; i < 3; i++) await page.keyboard.press("Tab");
    await expect(
      page.getByRole("button", { name: new RegExp(candidates[2].artist) }),
    ).toBeFocused();

    // Well past the 5 s countdown: nothing may be chosen for the user.
    await page.waitForTimeout(6500);
    expect(resumes(await apiRequests(page))).toEqual([]);
    await expect(page.getByText("Is this the right track?")).toBeVisible();

    await page.keyboard.press("Enter");
    await expect
      .poll(async () => resumes(await apiRequests(page)))
      .toEqual([resumeWith(candidates[2].id)]);
  });

  test("hovering over the picker pauses the countdown", async ({ page }) => {
    const picker = await openPicker(page);
    await picker.hover();
    await expect(page.getByText("(paused)")).toBeVisible();
    // Well past the 5 s countdown: nothing is chosen while the pointer is on the picker.
    await page.waitForTimeout(6500);
    expect(resumes(await apiRequests(page))).toEqual([]);
    await expect(page.getByText("Is this the right track?")).toBeVisible();
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
      page.getByRole("button", {
        name: `${candidate.title} ${candidate.artist} • ${candidate.releaseYear}`,
      }),
    ).toBeVisible();
  }
  await page.waitForTimeout(1000);
  expect(resumes(await apiRequests(page))).toEqual([]);
  await expect(page.getByText("Is this the right track?")).toBeVisible();
});
