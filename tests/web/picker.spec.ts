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
  releaseDate?: string | null;
  explicit?: boolean | null;
  durationMs?: number;
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
    explicit: true,
    durationMs: 238_000,
  },
  {
    id: "c5",
    title: "Hurt",
    artist: "Thousand Foot Krutch",
    album: "Phenomenon",
    coverUrl: "",
    releaseYear: "2003",
    durationMs: 4_013_000,
  },
];

// The server's question, in its own words (apps/api/src/agent/trackMatch.ts choiceMessage).
const question = (count: number) =>
  count === 1
    ? "One possible track from Spotify; confirm it or search again"
    : `${count} possible tracks from Spotify; choose one`;
// The candidates as the API sends them in `interrupt` (scoutNode.ts), counted by its question.
const pickerStream = (candidates: Candidate[]) => [
  { type: "connected", threadId: "thread-hitl" },
  { type: "status", node: "scout", message: "Searching for the track", code: "SPOTIFY-SEARCH" },
  {
    type: "interrupt",
    reason: "disambiguation",
    threadId: "thread-hitl",
    candidates,
    message: question(candidates.length),
  },
  { type: "done" },
];
const held = [
  { type: "resuming", threadId: "thread-hitl" },
  { type: "status", node: "engineer", message: "Analyzing audio", code: "AUDIO-INIT" },
  { $wait: "never" },
];
// A resume the server holds before it says any step has started.
const heldBeforeAnyStep = [{ type: "resuming", threadId: "thread-hitl" }, { $wait: "never" }];

const resumes = (log: string[]) => log.filter((entry) => entry.startsWith(`stream ${RESUME}`));
const analyses = (log: string[]) => log.filter((entry) => entry.startsWith(`stream ${ANALYZE}?`));
const resumeWith = (id: string) =>
  `stream ${RESUME}?threadId=thread-hitl&selectedTrackId=${id}&pickedBy=click`;

const picker = (page: Page) => page.getByRole("listbox", { name: QUESTION });
const option = (page: Page, candidate: Candidate) =>
  picker(page).getByRole("option", { name: `${candidate.title} ${candidate.artist}` });
const progressStatus = (page: Page) => page.locator("[data-progress-status]");

/**
 * What keeps a row of the picker from being seen whole where it is now, without scrolling: a
 * listbox taller than its box, or a row outside the viewport or outside the visible area of any
 * box around it that clips or scrolls. Empty when every row is shown whole.
 */
function clippedRows(page: Page) {
  return picker(page).evaluate((list) => {
    const problems: string[] = [];
    if (list.scrollHeight > list.clientHeight) {
      problems.push(`the list scrolls: ${list.scrollHeight} > ${list.clientHeight}`);
    }
    for (const row of list.querySelectorAll('[role="option"]')) {
      const box = row.getBoundingClientRect();
      const areas = [
        { name: "the viewport", top: 0, bottom: innerHeight, left: 0, right: innerWidth },
      ];
      for (let around = row.parentElement; around; around = around.parentElement) {
        const { overflowX, overflowY } = getComputedStyle(around);
        if (overflowX === "visible" && overflowY === "visible") continue;
        const rect = around.getBoundingClientRect();
        const top = rect.top + around.clientTop;
        const left = rect.left + around.clientLeft;
        areas.push({
          name: `${around.tagName} ${around.className}`,
          top,
          bottom: top + around.clientHeight,
          left,
          right: left + around.clientWidth,
        });
      }
      for (const area of areas) {
        if (
          box.top < area.top - 0.5 ||
          box.bottom > area.bottom + 0.5 ||
          box.left < area.left - 0.5 ||
          box.right > area.right + 0.5
        ) {
          problems.push(`${row.textContent} is cut by ${area.name}`);
        }
      }
    }
    return problems;
  });
}

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
  { width: 844, height: 390 },
]) {
  test(`at ${viewport.width}x${viewport.height} every candidate is shown whole and reached with arrows, Home and End`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await useMockApi(page, {
      suggestions: [],
      streams: { [ANALYZE]: pickerStream(five), [RESUME]: held },
    });
    await openPicker(page);
    const rows = five.map((candidate) => option(page, candidate));

    // Once the picker has come into view, nothing scrolled by the test: no row is cut off by
    // a scrolling box or by the window, the fifth no more than the first.
    await expect.poll(() => clippedRows(page)).toEqual([]);
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
  // The resume is held before the server names a step, so the status line's words do not
  // depend on how soon the next event arrives.
  await useMockApi(page, {
    suggestions: [],
    streams: { [ANALYZE]: pickerStream(three), [RESUME]: heldBeforeAnyStep },
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

test("while the server holds the resume, the status never claims a step it has not named", async ({
  page,
}) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: pickerStream(three),
      [RESUME]: [
        { type: "resuming", threadId: "thread-hitl" },
        { $wait: "measure" },
        { type: "status", node: "engineer", message: "Analyzing audio", code: "AUDIO-INIT" },
        { $wait: "never" },
      ],
    },
  });
  await openPicker(page);
  await option(page, three[1]).click();
  await expect(progressStatus(page)).toHaveText("Reading the track you selected...");

  // Ten seconds of a held resume, by the clock: the line stays on the pick, sampled every 250 ms.
  // (Counting samples instead let a loaded machine stretch the ten seconds to twenty.)
  const seen = new Set<string>();
  for (const until = Date.now() + 10_000; Date.now() < until; ) {
    seen.add((await progressStatus(page).textContent()) ?? "");
    await page.waitForTimeout(250);
  }
  expect([...seen]).toEqual(["Reading the track you selected..."]);

  // The measurement is claimed once the server says it has started, not before.
  await releaseStream(page, "measure");
  await expect(progressStatus(page)).toHaveText(
    "Measuring tempo, key and energy from the preview clip...",
  );
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
  // A short window: the focused line is scrolled into view.
  await page.setViewportSize({ width: 844, height: 390 });
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
  await expect(progressStatus(page)).toBeInViewport({ ratio: 1 });
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

test("every track the server counts gets a row: a studio and a live take with one title and artist", async ({
  page,
}) => {
  const studio = {
    id: "m-album",
    title: "Midnight City",
    artist: "M83",
    album: "Hurry Up, We're Dreaming",
    coverUrl: "",
    releaseYear: "2011",
  };
  const live = { ...studio, id: "m-live", album: "Live at Coachella", releaseYear: "2012" };
  await useMockApi(page, {
    suggestions: [],
    streams: { [ANALYZE]: pickerStream([studio, live]), [RESUME]: held },
  });
  await openPicker(page, "Midnight City");

  // The server says how many tracks it offers; the picker shows that many.
  await expect(progressStatus(page)).toHaveText(question(2));
  const rows = picker(page).getByRole("option");
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText("M83 • 2011");
  await expect(rows.nth(1)).toContainText("M83 • 2012");
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expect.poll(async () => resumes(await apiRequests(page))).toEqual([resumeWith("m-live")]);
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
]) {
  test(`at ${viewport.width}x${viewport.height} a clean and an explicit version of one song are two rows that say which is which`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    // The server keeps the versions apart (one ISRC, two explicit values) and counts both.
    const clean = {
      id: "h-clean",
      title: "Hurt",
      artist: "Johnny Cash",
      album: "American IV: The Man Comes Around",
      coverUrl: "",
      releaseYear: "2002",
      isrc: "USUM70207211",
      releaseDate: "2002-11-05",
      explicit: false,
      durationMs: 218_000,
    };
    const explicit = { ...clean, id: "h-explicit", explicit: true, durationMs: 219_400 };
    await useMockApi(page, {
      suggestions: [],
      streams: {
        [ANALYZE]: pickerStream([clean, explicit]),
        [RESUME]: held,
      },
    });
    await openPicker(page);

    const rows = picker(page).getByRole("option");
    await expect(rows).toHaveCount(2);
    // Two rows with one title, artist and year, told apart by their names.
    await expect(rows.nth(0)).toHaveAccessibleName(/Hurt Johnny Cash • 2002 • 3:38$/);
    await expect(rows.nth(1)).toHaveAccessibleName(/Hurt Johnny Cash • 2002 • 3:39 Explicit$/);
    await expect(picker(page).getByText("E", { exact: true })).toBeInViewport({ ratio: 1 });
    await expect.poll(() => clippedRows(page)).toEqual([]);
    // The marker takes no more height than the line it sits in: both rows are one height.
    const [cleanBox, explicitBox] = [
      await rows.nth(0).boundingBox(),
      await rows.nth(1).boundingBox(),
    ];
    expect(explicitBox?.height ?? 0).toBeCloseTo(cleanBox?.height ?? 0, 1);
    // The server's question, which counts the two rows shown.
    await expect(progressStatus(page)).toHaveText(question(2));
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect
      .poll(async () => resumes(await apiRequests(page)))
      .toEqual([resumeWith("h-explicit")]);
  });
}

test("the question names the list alone, so it is read once", async ({ page }) => {
  await useMockApi(page, { suggestions: [], streams: { [ANALYZE]: pickerStream(three) } });
  await openPicker(page);
  await expect(page.getByRole("region", { name: QUESTION })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: QUESTION })).toBeVisible();
  await expect(picker(page)).toHaveAccessibleDescription(
    "Arrow keys to move, Enter to analyze, Esc to search again",
  );
});

test("a picked suggestion moves the focus to the progress status", async ({ page }) => {
  // A Spotify track id: the suggestion's own track is asked for.
  const suggestion = { ...three[1], id: "4iV5W9uYEdYUVa79Axb7Rh" };
  await useMockApi(page, {
    suggestions: [suggestion],
    streams: {
      [ANALYZE]: [
        { type: "connected", threadId: "thread-typed" },
        {
          type: "status",
          node: "scout",
          message: "Reading the track from Spotify",
          code: "NET-100",
        },
        { $wait: "never" },
      ],
    },
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Hurt");
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("log")).toContainText("Reading the track from Spotify");
  expect(analyses(await apiRequests(page))[0]).toContain(`trackId=${suggestion.id}`);
  await expect(progressStatus(page)).toBeFocused();
});

test("a recorded track picked while live analysis is paused moves the focus to the progress status", async ({
  page,
}) => {
  const fixture = loadFixture("budget-paused");
  const [refusal, replay] = fixture.streams[ANALYZE].opens;
  // Held after the replay's first steps, before its result.
  const heldReplay = [...replay.slice(0, 3), { $wait: "never" }];
  await useMockApi(page, {
    ...fixture,
    streams: { ...fixture.streams, [ANALYZE]: { opens: [refusal, heldReplay] } },
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Some Other Song");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.getByRole("button", { name: /Bright Lines/ }).click();
  await expect(page.getByRole("log")).toContainText("nothing below runs live");
  await expect(progressStatus(page)).toBeFocused();
});

test("after a refused pick, Try again shows no card for the refused track", async ({ page }) => {
  await useMockApi(page, {
    suggestions: [],
    streams: {
      [ANALYZE]: {
        opens: [
          pickerStream(three),
          [
            { type: "connected", threadId: "thread-hitl" },
            {
              type: "status",
              node: "scout",
              message: "Searching for the track",
              code: "SPOTIFY-SEARCH",
            },
            { $wait: "again" },
            ...pickerStream(three).slice(2),
          ],
        ],
      },
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
  await option(page, three[2]).click();
  await page.getByRole("button", { name: "Try again" }).click();

  // The card under the reticle names the track being analysed: none is chosen yet.
  const card = page.getByText(three[2].artist, { exact: true });
  await expect(page.getByRole("log")).toContainText("Searching for the track");
  await expect(card).toHaveCount(0);
  await releaseStream(page, "again");
  await expect(option(page, three[0])).toBeFocused();
  await expect(card).toHaveCount(0);
});

test("a picker that opens after a recorded track was chosen shows no card for that track", async ({
  page,
}) => {
  const fixture = loadFixture("budget-paused");
  const [refusal] = fixture.streams[ANALYZE].opens;
  const takes = [
    {
      ...three[0],
      id: "t-full",
      title: "Bright Lines",
      artist: "Test Artist",
      releaseYear: "2001",
    },
    {
      ...three[0],
      id: "t-live",
      title: "Bright Lines",
      artist: "Test Artist",
      releaseYear: "2004",
    },
  ];
  await useMockApi(page, {
    ...fixture,
    streams: { ...fixture.streams, [ANALYZE]: { opens: [refusal, pickerStream(takes)] } },
  });
  await page.goto("/");
  await page.getByRole("combobox", { name: "Song title and artist" }).fill("Some Other Song");
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.getByRole("button", { name: /Bright Lines/ }).click();
  // Both takes share a title and an artist: the first row, by place.
  await expect(picker(page).getByRole("option").first()).toBeFocused();
  // The rows name the takes; no card above them claims one is being analysed.
  await expect(page.getByText("Test Artist", { exact: true })).toHaveCount(0);
});

test("Space on a row neither scrolls the page nor picks", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await useMockApi(page, { suggestions: [], streams: { [ANALYZE]: pickerStream(five) } });
  await openPicker(page);
  await expect.poll(() => clippedRows(page)).toEqual([]);
  // Read once the box has stopped moving: the picker scrolls itself into view as it opens, and
  // on a slow machine that scroll (or the layout settling around it) can still be under way
  // when the rows are already whole.
  const settledScrollTop = () =>
    picker(page).evaluate(
      (list) =>
        new Promise<number>((resolve) => {
          const box = list.closest(".overflow-y-auto");
          if (!box) {
            resolve(-1);
            return;
          }
          let last = box.scrollTop;
          let still = 0;
          const tick = () => {
            if (box.scrollTop === last) still++;
            else {
              last = box.scrollTop;
              still = 0;
            }
            if (still >= 10) resolve(last);
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
  const before = await settledScrollTop();
  await page.keyboard.press("Space");
  await page.waitForTimeout(500);
  expect(await settledScrollTop()).toBe(before);
  await expect(option(page, five[0])).toBeFocused();
  expect(resumes(await apiRequests(page))).toEqual([]);
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
