import { expect, type Page, test } from "@playwright/test";
import { apiRequests, collectProblems, loadFixture, releaseStream, useMockApi } from "./mock";

// The track picker shown when a search matches several songs: a listbox the keyboard moves
// through, which never picks a track for the user and can be left for the search box.
const ANALYZE = "/api/analyze/stream";
const RESUME = "/api/analyze/stream/resume";
const QUESTION = "Is this the right track?";

type Candidate = {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverUrl: string;
  releaseYear: string;
  isrc?: string | null;
};

const hitl = loadFixture("hitl");
const three = hitl.streams[ANALYZE].find((event: { type: string }) => event.type === "interrupt")
  .candidates as Candidate[];
const five: Candidate[] = [
  ...three,
  {
    id: "c4",
    title: "Hurt",
    artist: "Leona Lewis",
    album: "Hurt: The EP",
    coverUrl: "",
    releaseYear: "2011",
  },
  {
    id: "c5",
    title: "Hurt",
    artist: "Thousand Foot Krutch",
    album: "Phenomenon",
    coverUrl: "",
    releaseYear: "2003",
  },
];

const pickerStream = (candidates: Candidate[]) => [
  { type: "connected", threadId: "thread-hitl" },
  { type: "status", node: "scout", message: "Searching for the track", code: "SPOTIFY-SEARCH" },
  {
    type: "interrupt",
    reason: "disambiguation",
    threadId: "thread-hitl",
    candidates,
    message: "Please select the correct song",
  },
  { type: "done" },
];
const held = [
  { type: "resuming", threadId: "thread-hitl" },
  { type: "status", node: "engineer", message: "Analyzing audio", code: "AUDIO-INIT" },
  { $wait: "never" },
];

const resumes = (log: string[]) => log.filter((entry) => entry.startsWith(`stream ${RESUME}`));
const analyses = (log: string[]) => log.filter((entry) => entry.startsWith(`stream ${ANALYZE}?`));
const resumeWith = (id: string) =>
  `stream ${RESUME}?threadId=thread-hitl&selectedTrackId=${id}&pickedBy=click`;

const picker = (page: Page) => page.getByRole("listbox", { name: QUESTION });
const option = (page: Page, candidate: Candidate) =>
  picker(page).getByRole("option", { name: `${candidate.title} ${candidate.artist}` });
const progressStatus = (page: Page) => page.locator("[data-progress-status]");

async function openPicker(page: Page, query = "Hurt") {
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill(query);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await expect(picker(page)).toBeVisible();
}

test("nothing is picked for the user, however long the picker stays open", async ({ page }) => {
  await useMockApi(page, { suggestions: [], streams: { [ANALYZE]: pickerStream(three) } });
  await openPicker(page);
  // The pointer is kept off the picker: nothing it does may stand for a choice.
  await page.mouse.move(0, 0);
  await page.waitForTimeout(10_500);

  expect(resumes(await apiRequests(page))).toEqual([]);
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).getByRole("option")).toHaveCount(3);
  // No timer, and no words about one.
  await expect(page.getByText(/pick the top match|paused|countdown/i)).toHaveCount(0);
  await expect(page.getByText("Nothing is analyzed until you choose a track.")).toBeVisible();
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`at ${viewport.width} px every candidate is shown whole and reached with arrows, Home and End`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await useMockApi(page, {
      suggestions: [],
      streams: { [ANALYZE]: pickerStream(five), [RESUME]: held },
    });
    await openPicker(page);
    const rows = five.map((candidate) => option(page, candidate));

    // No row is cut off by a scrolling box: the fifth one is as visible as the first.
    for (const row of rows) {
      await row.scrollIntoViewIfNeeded();
      await expect(row).toBeInViewport({ ratio: 1 });
    }
    await expect(rows[0]).toBeFocused();
    await expect(rows[0]).toHaveAttribute("aria-selected", "true");

    for (let index = 1; index < five.length; index++) {
      await page.keyboard.press("ArrowDown");
      await expect(rows[index]).toBeFocused();
      await expect(rows[index]).toHaveAttribute("aria-selected", "true");
      await expect(rows[index]).toBeInViewport({ ratio: 1 });
    }
    // Past the last row the arrow goes back to the first, and up from the first to the last.
    await page.keyboard.press("ArrowDown");
    await expect(rows[0]).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(rows[4]).toBeFocused();
    await page.keyboard.press("Home");
    await expect(rows[0]).toBeFocused();
    await expect(rows[4]).toHaveAttribute("aria-selected", "false");
    await page.keyboard.press("End");
    await expect(rows[4]).toBeFocused();
    // One Tab stop for the list: Tab leaves it for "Search again".
    await page.keyboard.press("Tab");
    await expect(page.getByRole("button", { name: "Search again" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(rows[4]).toBeFocused();

    await page.keyboard.press("Enter");
    await expect.poll(async () => resumes(await apiRequests(page))).toEqual([resumeWith("c5")]);
  });
}

test("the picker takes the focus when it appears, and the progress status takes it after a pick", async ({
  page,
}) => {
  const problems = collectProblems(page);
  await useMockApi(page, {
    suggestions: [],
    streams: { [ANALYZE]: pickerStream(three), [RESUME]: held },
  });
  await openPicker(page);
  await expect(option(page, three[0])).toBeFocused();

  // A click picks as well as Enter does.
  await option(page, three[1]).click();
  await expect.poll(async () => resumes(await apiRequests(page))).toEqual([resumeWith("c2")]);
  await expect(picker(page)).toHaveCount(0);
  await expect(progressStatus(page)).toBeFocused();
  await expect(progressStatus(page)).toHaveText("Reading the track you selected...");
  expect(problems).toEqual([]);
});

test("after Try again the progress status takes the focus, not the page", async ({ page }) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: {
        opens: [
          [
            { type: "connected", threadId: "t-first" },
            { type: "error", code: "upstream_unavailable", error: "Spotify did not answer." },
            { type: "done" },
          ],
          [
            { type: "connected", threadId: "t-second" },
            {
              type: "status",
              node: "scout",
              message: "Searching for the track",
              code: "SPOTIFY-SEARCH",
            },
            { $wait: "never" },
          ],
        ],
      },
    },
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Hurt");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.getByRole("button", { name: "Try again" }).click();

  await expect(page.getByRole("log")).toContainText("Searching for the track");
  await expect(progressStatus(page)).toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.tagName)).not.toBe("BODY");
});

test("a typed search moves the focus to the progress status, then the picker takes it", async ({
  page,
}) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: "thread-hitl" },
        {
          type: "status",
          node: "scout",
          message: "Searching for the track",
          code: "SPOTIFY-SEARCH",
        },
        { $wait: "picker" },
        ...pickerStream(three).slice(2),
      ],
    },
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Hurt");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("log")).toContainText("Searching for the track");
  await expect(progressStatus(page)).toBeFocused();
  await releaseStream(page, "picker");
  await expect(option(page, three[0])).toBeFocused();
});

test("Escape leaves the picker for the search box and starts no run", async ({ page }) => {
  await useMockApi(page, { suggestions: [], streams: { [ANALYZE]: pickerStream(three) } });
  await openPicker(page);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Escape");

  const input = page.getByRole("combobox", { name: "Song title and artist" });
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Hurt");
  await expect(picker(page)).toHaveCount(0);
  await page.waitForTimeout(500);
  const log = await apiRequests(page);
  expect(resumes(log)).toEqual([]);
  expect(analyses(log)).toHaveLength(1);
});

test("the same recording listed twice is offered once; takes without an ISRC all stay", async ({
  page,
}) => {
  const single = {
    id: "m-single",
    title: "Midnight City",
    artist: "M83",
    album: "Midnight City",
    coverUrl: "",
    releaseYear: "2012",
    isrc: "GB55H1100002",
  };
  const album = {
    ...single,
    id: "m-album",
    album: "Hurry Up, We're Dreaming",
    releaseYear: "2011",
  };
  // Same title and artist, no ISRC: it may be another take, so it is never merged away.
  const live = {
    ...single,
    id: "m-live",
    album: "Live at Coachella",
    releaseYear: "2012",
    isrc: null,
  };
  await useMockApi(page, {
    suggestions: [],
    streams: { [ANALYZE]: pickerStream([single, live, album]), [RESUME]: held },
  });
  await openPicker(page, "Midnight City");

  const rows = picker(page).getByRole("option");
  await expect(rows).toHaveCount(2);
  // The first release of the recording stays, in the place the first of its rows had.
  await expect(rows.nth(0)).toContainText("M83 • 2011");
  await expect(rows.nth(1)).toContainText("M83 • 2012");
  await page.keyboard.press("Enter");
  await expect.poll(async () => resumes(await apiRequests(page))).toEqual([resumeWith("m-album")]);
});

test("a choice the server no longer holds: the picker waits, then says so when the pick is refused", async ({
  page,
}) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: pickerStream(three),
      [RESUME]: [
        {
          type: "error",
          code: "choice_expired",
          error: "This choice has expired or was not found. Please search again.",
        },
        { type: "done" },
      ],
    },
  });
  await openPicker(page);
  await page.mouse.move(0, 0);
  // Left open for a while: nothing is sent, and nothing claims the choice has closed.
  await page.waitForTimeout(6_000);
  expect(resumes(await apiRequests(page))).toEqual([]);
  await expect(page.getByText(/no longer open/)).toHaveCount(0);

  await option(page, three[2]).click();
  const heading = page.getByRole("heading", { name: "The analysis did not finish" });
  await expect(heading).toBeFocused();
  await expect(heading).toHaveAccessibleDescription(
    "That choice is no longer open. Try again to get a fresh list of tracks.",
  );
  await expect(picker(page)).toHaveCount(0);
  expect(resumes(await apiRequests(page))).toEqual([resumeWith("c3")]);
});
