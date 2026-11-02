import { expect, type Page, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  dashboardHeading,
  loadFixture,
  openPlayer,
  replayedRecording,
  useMockApi,
} from "./mock";
import { offline } from "./offline";

// With the focus on no control, Escape does what it does with nothing focused: in the Player it
// goes back to the summary; with a track selected on the map (in the Player, or on the map's own
// page) it closes the track's details first. "No control" is reached three ways, as a reader
// reaches it: a click on words that are not a control (the focus goes to the page's body), the
// skip link (the focus is on the main landmark), and the skip link followed by a click on words
// inside main (the focus stays on main). The other specs reach "nothing focused" by script
// (blur()); these get there with real clicks and keys.

test.use({ reducedMotion: "reduce" });

test.beforeEach(async ({ page }) => {
  await offline(page);
  await page.setViewportSize({ width: 1440, height: 900 });
});

/** The recorded demo run's track (One More Time), stored as a replayed run. */
const OMT = "0DiWol3AO6WpXZgp0goxAV";

/** The focused element, by tag and id; "body" when no element has the focus. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return "body";
    return `${active.tagName.toLowerCase()}#${active.id}`;
  });

type Scene = {
  name: string;
  /** Opens the scene. */
  open: (page: Page) => Promise<void>;
  /** Words on screen that are not a control. */
  words: (page: Page) => ReturnType<Page["locator"]>;
  /** What shows that Escape did its work. */
  after: (page: Page) => Promise<void>;
};

/** Selects a related track's card with the keyboard: its details open. */
async function selectTrack(page: Page, card: ReturnType<Page["locator"]>) {
  await card.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("node-detail")).toBeVisible();
}

/** The recorded demo run, stored: what a track link to it loads. */
function storedDemo() {
  const omt = replayedRecording().events.find((event) => event.type === "complete")?.data as {
    id: string;
  };
  return {
    suggestions: [],
    eventGapMs: 0,
    streams: {},
    runs: {
      [OMT]: {
        success: true,
        run: {
          id: `thread-${omt.id}`,
          status: "completed",
          mode: "replay",
          spotifyId: omt.id,
          createdAt: "2026-10-27T19:30:00.000Z",
          finishedAt: "2026-10-27T19:31:00.000Z",
        },
        analysis: omt,
      },
    },
  };
}

const mapHeading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: /^Song relations of/ });

const SCENES: Scene[] = [
  {
    name: "in the Player, Escape goes back to the summary",
    open: async (page) => {
      await useMockApi(page, loadFixture("full-result"));
      await analyzeAndOpenDashboard(page, "Bright Lines");
      await openPlayer(page);
    },
    words: (page) => page.getByText("Sample times: model inference").first(),
    after: async (page) => {
      await expect(dashboardHeading(page)).toBeVisible();
      await expect(page.getByRole("button", { name: /Back to summary/ })).toHaveCount(0);
    },
  },
  {
    name: "with a track selected on the map in the Player, Escape closes its details first",
    open: async (page) => {
      await useMockApi(page, loadFixture("genealogy-rich"));
      await analyzeAndOpenDashboard(page, "Bright Lines");
      await openPlayer(page);
      await selectTrack(
        page,
        page.locator(
          '#panel-genealogy svg[aria-label="Connections graph"] g.nodes > g[data-node-id="s2"]',
        ),
      );
    },
    words: (page) => page.getByText("Structure", { exact: true }).first(),
    after: async (page) => {
      await expect(page.getByTestId("node-detail")).toHaveCount(0);
      // Only the details closed: the Player is still shown.
      await expect(page.getByRole("button", { name: /Back to summary/ })).toBeVisible();
    },
  },
  {
    name: "with a track selected on the map's own page, Escape closes its details",
    open: async (page) => {
      await useMockApi(page, storedDemo());
      await page.goto(`/t/${OMT}/map`);
      await expect(mapHeading(page)).toBeVisible();
      await selectTrack(page, page.locator("[data-map-view] g.nodes > g[aria-pressed]").first());
    },
    // The note on the replayed run, under the heading (the heading itself takes the focus).
    words: (page) => page.getByText(/^Recorded run · /),
    after: async (page) => {
      await expect(page.getByTestId("node-detail")).toHaveCount(0);
      await expect(mapHeading(page)).toBeVisible();
    },
  },
];

/** Follows the skip link from the keyboard: the focus goes to the main landmark. */
async function followSkipLink(page: Page) {
  await page.getByRole("link", { name: "Skip to content" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
}

for (const scene of SCENES) {
  test(`after a click on words, ${scene.name}`, async ({ page }) => {
    await scene.open(page);
    await scene.words(page).click();
    expect.soft(await focused(page), "the focus after the click").toBe("body");
    await page.keyboard.press("Escape");
    await scene.after(page);
  });

  test(`after the skip link, ${scene.name}`, async ({ page }) => {
    await scene.open(page);
    await followSkipLink(page);
    await page.keyboard.press("Escape");
    await scene.after(page);
  });

  test(`after the skip link and a click on words, ${scene.name}`, async ({ page }) => {
    await scene.open(page);
    await followSkipLink(page);
    // A click on words inside main keeps the focus on main: while the skip link is followed it
    // is the click's focusable ancestor.
    await scene.words(page).click();
    expect.soft(await focused(page), "the focus after the click").toBe("main#main-content");
    await page.keyboard.press("Escape");
    await scene.after(page);
  });
}
