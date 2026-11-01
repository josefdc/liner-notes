import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  analyzeAndOpenDashboard,
  animationsSettled,
  apiRequests,
  dashboardHeading,
  fullResultData,
  loadFixture,
  openPlayer,
  openResults,
  replayedRecording,
  useMockApi,
} from "./mock";
import { offline } from "./offline";

// An automated accessibility check of every view at a phone's, a tablet's and a desktop's width:
// axe-core's WCAG 2.0 and 2.1 A and AA rules and its best practices find no serious or critical
// violation, and any lesser one is listed below with the reason it stays. axe rates some of what
// matters most to keyboard and screen-reader users as moderate, so those are checked by hand
// too: one main landmark per view, a skip link that is the first Tab stop and moves the focus
// into it, no picture-role Tab stops on the timeline, and connected-track cards that are real
// buttons, reached and pressed from the keyboard. A screen-reader pass is a manual check.

const ANALYZE = "/api/analyze/stream";
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];
const WIDTHS = [
  [1440, 900],
  [820, 1180],
  [390, 844],
] as const;

/**
 * Violations of impact moderate or minor that stay, by rule id, with the reason. A rule listed
 * here that no longer fires on any view should be removed; one not listed fails the test.
 */
const KNOWN: Record<string, string> = {};

/**
 * Serious findings that stay, each only on the elements `where` matches, with the reason. Any
 * other element the rule fires on fails the test, as does any other serious finding.
 */
const ACCEPTED: Array<{ id: string; where: string; reason: string }> = [
  {
    id: "label-content-name-mismatch",
    where:
      "[data-map-view] g.nodes > g[role='button'], #panel-genealogy g.nodes > g[role='button']",
    reason:
      "A map card is named by its whole track (title, artist and year, then its link), as its " +
      "detail box and panel name it; the card draws a title cut to fit and its words on separate " +
      "SVG lines, which axe reads run together. A name built from the drawn words would cut the " +
      "title for screen readers. A design decision for the map, left to its own change.",
  },
];

/** The recorded demo run's track (One More Time), stored as a replayed run. */
const OMT = "0DiWol3AO6WpXZgp0goxAV";
/** A stored result whose map has the analysed track only. */
const BARE = "2bCdEfGhIjKlMnOpQrStUv";
/** A well-formed track id without a stored run. */
const MISSING = "7ouMYWpwJ422jRcDASZB7P";

const fullResult = loadFixture("full-result");
const hitl = loadFixture("hitl");
const candidates = hitl.streams[ANALYZE].find(
  (event: { type: string }) => event.type === "interrupt",
).candidates;

const storedRun = (analysis: Record<string, unknown>, mode: "live" | "replay") => ({
  success: true,
  run: {
    id: `thread-${analysis.id}`,
    status: "completed",
    mode,
    spotifyId: analysis.id,
    createdAt: "2026-10-27T19:30:00.000Z",
    finishedAt: "2026-10-27T19:31:00.000Z",
  },
  analysis,
});

/** Stored runs: the recorded demo (a replay) and a result whose map is the analysed track. */
function storedApi() {
  const full = fullResultData() as { genealogy: { nodes: Array<{ group?: number }> } };
  const omt = replayedRecording().events.find((event) => event.type === "complete")?.data as Record<
    string,
    unknown
  >;
  return {
    suggestions: [],
    eventGapMs: 0,
    streams: {},
    runs: {
      [OMT]: storedRun(omt, "replay"),
      [BARE]: storedRun(
        {
          ...(full as Record<string, unknown>),
          id: BARE,
          genealogy: { nodes: full.genealogy.nodes.filter((node) => node.group === 1), links: [] },
        },
        "live",
      ),
    },
  };
}

async function search(page: Page, query: string) {
  await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill(query);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
}

const mapHeading = (page: Page) =>
  page.getByRole("heading", { level: 1, name: /^Song relations of/ });

type View = {
  name: string;
  /** Opens the view at the first width. */
  open: (page: Page) => Promise<void>;
  /** What shows that the view is still the one checked, at each width. */
  shown: (page: Page) => ReturnType<Page["locator"]>;
};

const VIEWS: View[] = [
  {
    name: "the search",
    open: async (page) => {
      await useMockApi(page, { suggestions: [], streams: {} });
      await page.goto("/");
    },
    shown: (page) => page.getByRole("combobox", { name: "Song title and artist" }),
  },
  {
    name: "the search with its suggestions open",
    open: async (page) => {
      await useMockApi(page, { suggestions: candidates, streams: {} });
      await page.goto("/");
      await page.getByRole("combobox", { name: "Song title and artist" }).fill("Hurt");
    },
    shown: (page) => page.getByRole("listbox"),
  },
  {
    name: "the track picker",
    open: async (page) => {
      await useMockApi(page, hitl);
      await search(page, "Hurt");
    },
    shown: (page) => page.getByRole("listbox", { name: "Is this the right track?" }),
  },
  {
    name: "the progress screen",
    open: async (page) => {
      const events = fullResult.streams[ANALYZE];
      await useMockApi(page, {
        ...fullResult,
        streams: { [ANALYZE]: [...events.slice(0, 3), { $wait: "never" }] },
      });
      await search(page, "Bright Lines");
    },
    shown: (page) => page.locator("[data-progress-status]"),
  },
  {
    name: "a run that failed",
    open: async (page) => {
      await useMockApi(page, {
        suggestions: [],
        streams: {
          [ANALYZE]: [
            {
              type: "error",
              code: "rate_limited",
              error: "Too many requests. Please try again later.",
            },
            { type: "done" },
          ],
        },
      });
      await search(page, "Bright Lines");
    },
    shown: (page) => page.getByRole("heading", { name: "The analysis did not finish" }),
  },
  {
    name: "live analysis paused",
    open: async (page) => {
      await useMockApi(page, loadFixture("budget-paused"));
      await search(page, "Some Other Song");
    },
    shown: (page) => page.getByRole("region", { name: "Live analysis paused" }),
  },
  {
    name: "a track link with no stored result",
    open: async (page) => {
      await useMockApi(page, storedApi());
      await page.goto(`/t/${MISSING}?q=Midnight%20City%20M83`);
    },
    shown: (page) => page.getByRole("heading", { name: "No stored analysis for this track yet" }),
  },
  {
    name: "the Dashboard",
    open: async (page) => {
      await useMockApi(page, fullResult);
      await analyzeAndOpenDashboard(page, "Bright Lines");
    },
    shown: (page) => dashboardHeading(page),
  },
  {
    name: "the Dashboard with missing values",
    open: async (page) => {
      await useMockApi(page, loadFixture("missing-states"));
      await analyzeAndOpenDashboard(page, "Quiet Signal");
    },
    shown: (page) => dashboardHeading(page),
  },
  {
    name: "the Player",
    open: async (page) => {
      await useMockApi(page, fullResult);
      await analyzeAndOpenDashboard(page, "Bright Lines");
      await openPlayer(page);
    },
    shown: (page) => page.getByRole("button", { name: /Back to summary/ }),
  },
  {
    name: "the Player with missing values",
    open: async (page) => {
      await useMockApi(page, loadFixture("missing-states"));
      await analyzeAndOpenDashboard(page, "Quiet Signal");
      await openPlayer(page);
    },
    shown: (page) => page.getByRole("button", { name: /Back to summary/ }),
  },
  {
    name: "the map",
    open: async (page) => {
      await useMockApi(page, storedApi());
      await page.goto(`/t/${OMT}/map`);
    },
    shown: (page) => mapHeading(page),
  },
  {
    name: "the map with a track selected",
    open: async (page) => {
      await useMockApi(page, storedApi());
      await page.goto(`/t/${OMT}/map`);
      await expect(mapHeading(page)).toBeVisible();
      const card = page.locator(
        '[data-map-view] g.nodes > g[data-node-id]:not([data-node-id="current"])',
      );
      await card.first().focus();
      await page.keyboard.press("Enter");
    },
    shown: (page) => page.getByTestId("node-detail"),
  },
  {
    name: "the map of a result with no relations",
    open: async (page) => {
      await useMockApi(page, storedApi());
      await page.goto(`/t/${BARE}/map`);
    },
    shown: (page) => mapHeading(page),
  },
  {
    name: "the map of a track with no stored result",
    open: async (page) => {
      await useMockApi(page, storedApi());
      await page.goto(`/t/${MISSING}/map`);
    },
    shown: (page) => page.getByRole("heading", { name: "No stored analysis for this track yet" }),
  },
  {
    name: "a screen whose code could not be loaded",
    open: async (page) => {
      await useMockApi(page, fullResult);
      await page.route(/\/assets\/Dashboard-[\w-]+\.js$/, (route) =>
        route.abort("internetdisconnected"),
      );
      await search(page, "Bright Lines");
      await openResults(
        page,
        page.getByRole("alert").filter({ hasText: "This screen could not be loaded" }),
      );
    },
    shown: (page) => page.getByRole("alert").filter({ hasText: "This screen could not be loaded" }),
  },
  {
    name: "a replayed showcase result",
    open: async (page) => {
      await useMockApi(page, storedApi());
      await page.goto(`/t/${OMT}`);
    },
    shown: (page) => dashboardHeading(page),
  },
];

type Found = {
  id: string;
  impact: string;
  nodes: number;
  targets: string[];
  /** axe's own words for the first node that fails, and that node's markup. */
  first: string;
  /** Whether every node it fires on is one ACCEPTED lists for it. */
  accepted: boolean;
};

/** axe's violations on the page as it is, each with its impact and where it fires. */
async function violations(page: Page): Promise<Found[]> {
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const found: Found[] = [];
  for (const violation of results.violations) {
    const targets = violation.nodes.map((node) => node.target.join(" "));
    const where = ACCEPTED.find((entry) => entry.id === violation.id)?.where;
    const accepted =
      where !== undefined &&
      (await page.evaluate(
        ({ targets, where }) =>
          targets.every((target) => document.querySelector(target)?.matches(where) === true),
        { targets, where },
      ));
    found.push({
      id: violation.id,
      impact: violation.impact ?? "unknown",
      nodes: violation.nodes.length,
      targets: targets.slice(0, 5),
      first: `${violation.nodes[0]?.failureSummary ?? ""} | ${violation.nodes[0]?.html.slice(0, 300) ?? ""}`,
      accepted,
    });
  }
  return found;
}

/**
 * Counts of failing elements by impact, as "critical 0 · serious 0 · moderate 0 · minor 0", and
 * the accepted ones (ACCEPTED) apart.
 */
function counts(found: Found[]) {
  const sum = (items: Found[]) => items.reduce((total, item) => total + item.nodes, 0);
  const by = (impact: string) =>
    sum(found.filter((item) => item.impact === impact && !item.accepted));
  return [
    ...["critical", "serious", "moderate", "minor"].map((impact) => `${impact} ${by(impact)}`),
    `accepted ${sum(found.filter((item) => item.accepted))}`,
  ].join(" · ");
}

/** The first element of the document that Tab reaches, as the browser orders it. */
const firstTabStop = (page: Page) =>
  page.evaluate(() => {
    const tabbable = [
      ...document.querySelectorAll<HTMLElement>(
        'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]',
      ),
    ].filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.matches(":disabled") &&
        !element.closest("[inert]") &&
        (element.getClientRects().length > 0 || element.matches('a[href="#main-content"]')),
    );
    // No positive tabindex in the app: document order is Tab order.
    const first = tabbable[0];
    return first ? `${first.tagName.toLowerCase()} ${first.getAttribute("href") ?? ""}` : null;
  });

test.beforeEach(async ({ page }) => {
  await offline(page);
});

for (const view of VIEWS) {
  test(`${view.name}: no serious or critical violation at 390, 820 and 1440 px, one main landmark`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width: WIDTHS[0][0], height: WIDTHS[0][1] });
    await view.open(page);
    const failures: string[] = [];
    for (const [width, height] of WIDTHS) {
      await page.setViewportSize({ width, height });
      await expect(view.shown(page)).toBeVisible();
      await animationsSettled(page);
      const found = await violations(page);
      console.log(`[axe] ${view.name} at ${width} px: ${counts(found)}`);
      for (const item of found) {
        const line = `${width} px: ${item.id} (${item.impact}, ${item.nodes}${item.accepted ? ", accepted" : ""}) at ${item.targets.join(", ")}`;
        console.log(`[axe]   ${view.name}, ${line}`);
        const allowed =
          item.accepted ||
          ((item.impact === "moderate" || item.impact === "minor") && item.id in KNOWN);
        if (!allowed) {
          failures.push(line);
          console.log(`[axe]     ${view.name}: ${item.first.replace(/\s+/g, " ")}`);
        }
      }
      // axe rates a missing or doubled main landmark as moderate: checked here.
      await expect.soft(page.getByRole("main"), `one main landmark at ${width} px`).toHaveCount(1);
      // No marker of the timeline is a Tab stop with a picture's role.
      await expect
        .soft(
          page.locator('[aria-label="Song structure"] [role="img"][tabindex]'),
          `no picture-role Tab stop on the timeline at ${width} px`,
        )
        .toHaveCount(0);
    }
    expect(failures, `${view.name}: violations`).toEqual([]);

    // The skip link is the first Tab stop, and following it puts the focus in the main landmark.
    expect(await firstTabStop(page)).toBe("a #main-content");
    await page.getByRole("link", { name: "Skip to content" }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("main")).toBeFocused();
  });
}

test("the skip link is the first Tab stop of the landing, and Enter moves the focus into main", async ({
  page,
}) => {
  await useMockApi(page, { suggestions: [], streams: {} });
  await page.goto("/");
  const search = page.getByRole("combobox", { name: "Song title and artist" });
  const skip = page.getByRole("link", { name: "Skip to content" });
  await search.focus();
  // Back from the search box: the skip link, and before it nothing of the page.
  await page.keyboard.press("Shift+Tab");
  await expect(skip).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  // From the start of the page the first Tab reaches it, shown.
  await page.keyboard.press("Tab");
  await expect(skip).toBeFocused();
  await expect(skip).toBeInViewport();
  await page.keyboard.press("Enter");
  const main = page.getByRole("main");
  await expect(main).toBeFocused();
  await expect(main).toHaveAttribute("id", "main-content");
  // No outline on main: it is a target, not a control (none drawn, or a transparent one).
  const outline = await main.evaluate((element) => {
    const style = getComputedStyle(element);
    return { style: style.outlineStyle, colour: style.outlineColor };
  });
  expect(
    outline.style === "none" || outline.colour === "rgba(0, 0, 0, 0)",
    JSON.stringify(outline),
  ).toBe(true);
  // The next Tab goes on from inside main, not back to the top of the page.
  await page.keyboard.press("Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest("main"))).toBe(true);
});

test("the timeline's markers and sections are buttons Tab reaches, never a picture-role stop", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await useMockApi(page, fullResult);
  await analyzeAndOpenDashboard(page, "Bright Lines");
  await openPlayer(page);
  const timeline = page.getByRole("group", { name: "Song structure" });
  await expect(timeline).toBeVisible();
  const markers = timeline.getByRole("button", {
    name: /\((time inferred by the model|measured at \d+:\d\d in the preview)\)$/,
  });
  const sections = timeline.locator("li[data-segment-tint] > button");
  expect(await markers.count()).toBeGreaterThan(0);
  expect(await sections.count()).toBeGreaterThan(0);
  // Nothing in the timeline but its buttons takes the focus.
  await expect(timeline.locator("[tabindex]:not(button)")).toHaveCount(0);

  // Tab from the timeline's first button runs through every marker and section of it.
  const expected = await timeline.getByRole("button").count();
  await timeline.getByRole("button").first().focus();
  const reached: Array<{ tag: string; role: string | null; name: string }> = [];
  for (let i = 0; i < expected; i += 1) {
    reached.push(
      await page.evaluate(() => {
        const active = document.activeElement as HTMLElement;
        return {
          tag: active.tagName.toLowerCase(),
          role: active.getAttribute("role"),
          name: active.getAttribute("aria-label") ?? "",
        };
      }),
    );
    await page.keyboard.press("Tab");
  }
  expect(reached.every((stop) => stop.tag === "button" && stop.role === null)).toBe(true);
  // A focused marker shows its description beside it.
  const marker = markers.first();
  await marker.focus();
  const tip = marker.locator("xpath=..").locator("[data-marker-tip]");
  await expect(tip).toHaveText((await marker.getAttribute("aria-label")) ?? "");
  await expect(tip).toHaveCSS("opacity", "1");
});

for (const key of ["Enter", "Space"] as const) {
  test(`a connected track's card is a button Tab reaches, and ${key} analyses its track`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await useMockApi(page, {
      suggestions: [],
      streams: {
        [ANALYZE]: {
          opens: [
            fullResult.streams[ANALYZE],
            [
              { type: "connected", threadId: "t-card" },
              {
                type: "status",
                node: "scout",
                message: "Reading the track from Spotify",
                code: "NET-100",
              },
              { $wait: "never" },
            ],
          ],
        },
      },
    });
    await analyzeAndOpenDashboard(page, "Bright Lines");
    const card = page.locator("button").filter({ hasText: "Relation:" }).first();
    await expect(card).toBeVisible();
    // Tab from the Dashboard's heading reaches the card.
    await dashboardHeading(page).focus();
    let reached = false;
    for (let i = 0; i < 80 && !reached; i += 1) {
      await page.keyboard.press("Tab");
      reached = await card.evaluate((element) => element === document.activeElement);
    }
    expect(reached, "Tab reaches the first connected track's card").toBe(true);
    await page.keyboard.press(key);
    await expect(page.getByRole("log")).toContainText("Reading the track from Spotify");
    expect((await apiRequests(page)).filter((entry) => entry.startsWith("stream "))).toHaveLength(
      2,
    );
  });
}
