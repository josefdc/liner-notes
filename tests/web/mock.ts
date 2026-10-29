import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AnalyzeStreamEvent,
  FactoidStreamEvent,
  ReplayRecord,
  RunResponse,
} from "@liner-notes/contract";
import { expect, type Locator, type Page } from "@playwright/test";
import { replayedAnalysis, replayNotice } from "../../apps/api/src/replay/player";
import {
  contractMisfits,
  type MockConfig,
  streamRuleBreaks,
  withEnvelope,
} from "../mock-sse/envelope";

const mockDir = join(dirname(fileURLToPath(import.meta.url)), "..", "mock-sse");

/** Loads a mock-SSE fixture from tests/mock-sse/fixtures. */
export function loadFixture(name: string) {
  return JSON.parse(readFileSync(join(mockDir, "fixtures", `${name}.json`), "utf8"));
}

/**
 * The configuration the mocked API replays: every stream event with the run id and `seq` the
 * API adds (../mock-sse/envelope.ts), checked against the contract's event unions, and every
 * stream checked against the rules the API keeps (one outcome, `done` last, `seq` 0, 1, 2…).
 * A stream event or a stream the API could not send fails the test here, so the mock cannot
 * drift from the server; one sent on purpose goes in `{ "$unchecked": event }`.
 */
export function mockConfig(fixture: unknown): MockConfig {
  const breaks = streamRuleBreaks(fixture as MockConfig);
  if (breaks.length > 0) {
    throw new Error(`Mock streams the API cannot send:\n${breaks.join("\n")}`);
  }
  const config = withEnvelope(fixture as MockConfig);
  const misfits = contractMisfits(config, {
    analysis: AnalyzeStreamEvent,
    factoids: FactoidStreamEvent,
  });
  if (misfits.length > 0) {
    throw new Error(`Mock stream events the API cannot send:\n${misfits.join("\n")}`);
  }
  const runMisfits = storedRunMisfits(config);
  if (runMisfits.length > 0) {
    throw new Error(`Mock stored runs the API cannot send:\n${runMisfits.join("\n")}`);
  }
  return config;
}

/**
 * The stored runs of a configuration (`runs`, served by GET /api/runs/by-track/<id>) that the
 * contract's RunResponse does not accept, or that answer for another track, as
 * "<id>: <problems>".
 */
function storedRunMisfits(config: MockConfig): string[] {
  const runs = (config.runs ?? {}) as Record<string, unknown>;
  return Object.entries(runs).flatMap(([id, body]) => {
    const parsed = RunResponse.safeParse(body);
    if (!parsed.success) {
      const problems = parsed.error.issues
        .map((issue) => `${issue.path.map(String).join(".") || "(body)"} ${issue.message}`)
        .join("; ");
      return [`${id}: ${problems}`];
    }
    const { run, analysis } = parsed.data;
    if (run.spotifyId !== id || (analysis && analysis.id !== id)) {
      return [`${id}: the run is another track's`];
    }
    return [];
  });
}

/** Installs the mocked API (tests/mock-sse/mock-api.js) configured with a fixture. */
export async function useMockApi(page: Page, fixture: unknown) {
  const config = mockConfig(fixture);
  await page.addInitScript((value) => {
    (window as unknown as { __mockApi: unknown }).__mockApi = value;
  }, config);
  await page.addInitScript({ path: join(mockDir, "mock-api.js") });
}

type MockWindow = {
  __mockApi: {
    log: string[];
    streamLog: string[];
    aborted: string[];
    runTokens: string[];
    refused: string[];
    turnstileTokens: Array<string | null>;
    release: (name: string) => void;
  };
};

/** API requests the app has made so far ("fetch <path>" or "stream <path>?<query>"). */
export function apiRequests(page: Page) {
  return page.evaluate(() => (window as unknown as MockWindow).__mockApi.log);
}

/**
 * The run tokens the mocked API issued so far (POST /api/runs), and the streams it refused for
 * want of one of them ("<path>?<query>", the token left out).
 */
export function runTokens(page: Page) {
  return page.evaluate(() => {
    const { runTokens: issued, refused } = (window as unknown as MockWindow).__mockApi;
    return { issued, refused };
  });
}

/** The Turnstile tokens POST /api/runs was sent so far, in order (null: none could be read). */
export function sentTurnstileTokens(page: Page) {
  return page.evaluate(() => (window as unknown as MockWindow).__mockApi.turnstileTokens);
}

/**
 * Answers POST /api/runs with a run token, as the API does, for a test that routes the API's
 * other requests by hand instead of installing the mocked API.
 */
export async function routeRunTokens(page: Page) {
  let issued = 0;
  await page.route("**/api/runs", (route) =>
    route.fulfill({
      json: {
        success: true,
        runToken: `routed-run-token-${++issued}`,
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      },
    }),
  );
}

/** Suggestion requests the app aborted so far ("<path>?query=<query>"). */
export function abortedRequests(page: Page) {
  return page.evaluate(() => (window as unknown as MockWindow).__mockApi.aborted);
}

/** What the mocked streams have done so far ("<path> open|<event>|closed|ended"). */
export function streamLog(page: Page) {
  return page.evaluate(() => (window as unknown as MockWindow).__mockApi.streamLog);
}

/** Lets streams paused at `{ "$wait": name }` continue. */
export function releaseStream(page: Page, name: string) {
  return page.evaluate((wait) => (window as unknown as MockWindow).__mockApi.release(wait), name);
}

/** The result event of the full-result fixture, for tests that build their own streams. */
export function fullResultData() {
  const events = loadFixture("full-result").streams["/api/analyze/stream"] as Array<{
    type: string;
    data?: unknown;
  }>;
  return events.find((event) => event.type === "complete")?.data;
}

/** The committed showcase recordings (fixtures/replays at the repository root). */
const replayDir = join(mockDir, "..", "..", "fixtures", "replays");

/** The first showcase, which the README, the demo and most specs open. */
export const DEMO_SLUG = "one-more-time-daft-punk";

/** A committed showcase recording, `fixtures/replays/<slug>.json`, checked by the contract. */
export function recordingOf(slug: string = DEMO_SLUG) {
  return ReplayRecord.parse(JSON.parse(readFileSync(join(replayDir, `${slug}.json`), "utf8")));
}

/** The day a source was read, as the app gives it ("28 Oct 2026", in UTC); null when unreadable. */
export function retrievedDay(retrievedAt: string): string | null {
  const date = new Date(retrievedAt);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * Every committed showcase recording, in order, as a spec opens it: its slug, the query that
 * finds it, its track, its song-relations map's size (tracks and links as recorded) and its tracks, a track on
 * it with a sourced link to this one and the day that link's record was read, and a track with a
 * model link to this one and the verifier's verdict on it (null when the run made none).
 */
export function showcaseRecordings() {
  return readdirSync(replayDir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const record = recordingOf(file.slice(0, -".json".length));
      const { id, title, artist, genealogy, evidence, claims } = record.analysis;
      const current = genealogy.nodes.find((node) => node.group === 1)?.id;
      const touches = (link: { source: string; target: string }) =>
        link.source === current || link.target === current;
      const other = (link: { source: string; target: string }) =>
        link.source === current ? link.target : link.source;
      // The first track joined to this one by a link built from a record (a MusicBrainz relation).
      const sourced = genealogy.links.find(
        (link) => link.origin === "code" && link.kind === "sourced" && touches(link),
      );
      const read = sourced?.evidenceIds
        ?.map((evidenceId) => evidence?.find((item) => item.id === evidenceId)?.retrievedAt)
        .find((retrievedAt) => retrievedAt !== undefined);
      // The first track joined to this one by a link the model proposed, with the claim behind it.
      const proposed = genealogy.links.find(
        (link) => link.origin === "model" && link.claimId && touches(link),
      );
      const claim = proposed ? claims?.find((item) => item.id === proposed.claimId) : undefined;
      return {
        slug: record.slug,
        query: record.request.query,
        trackId: id,
        title,
        artist,
        nodes: genealogy.nodes.length,
        nodeIds: genealogy.nodes.map((node) => node.id),
        links: genealogy.links.length,
        sourcedNode: sourced
          ? sourced.source === current
            ? sourced.target
            : sourced.source
          : null,
        sourcedRetrieved: read ? retrievedDay(read) : null,
        modelLink:
          proposed && claim
            ? {
                node: other(proposed),
                verdict: claim.verdict ?? null,
                verdictReason: claim.verdictReason ?? null,
              }
            : null,
      };
    });
}

/**
 * A recorded showcase run (by default the demo, fixtures/replays/one-more-time-daft-punk.json)
 * as the API replays it (apps/api/src/replay/player.ts): its events without their run id and
 * `seq` and without the recorded `done`, each with its time since the run started (its own
 * `elapsedMs`, else its `atMs`), the replay notice right after `connected`, and the result the
 * API's own `replayedAnalysis` serves: a replay of run `runId`, with the recording's date and
 * commit, each fact stated once. Returns the analysis stream's events, ending with `complete`
 * and `done`.
 */
export function replayedRecording(slug: string = DEMO_SLUG, runId = "replay-run") {
  const record = recordingOf(slug);
  const result = replayedAnalysis(record, runId);
  // The API's own notice, without its send time.
  const { timestamp: _sent, ...notice } = replayNotice(record) as Record<string, unknown>;
  const events: Array<Record<string, unknown>> = [];
  for (const { atMs, event } of record.events as Array<{
    atMs: number;
    event: Record<string, unknown>;
  }>) {
    const { runId: _run, seq: _seq, ...rest } = event;
    const body: Record<string, unknown> = { ...rest, elapsedMs: rest.elapsedMs ?? atMs };
    if (body.type === "done") continue;
    if (body.type === "connected") {
      events.push({ ...body, threadId: runId }, notice);
    } else if (body.type === "complete") {
      events.push({ ...body, data: result });
    } else {
      events.push(body);
    }
  }
  events.push({ type: "done" });
  return { events, recordedAt: record.recordedAt as string };
}

/** Collects console errors and warnings, and uncaught page errors. */
export function collectProblems(page: Page) {
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      problems.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  return problems;
}

/**
 * Waits until every finite animation and transition on the page has finished: a view that just
 * mounted plays its entrance animations (fades, slides, staggered cards) for up to about a
 * second, and a size, position or colour read before then depends on how fast the page got
 * there. Looping animations (spinners, glows) are left running.
 */
export async function animationsSettled(page: Page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== "running" ||
          animation.effect?.getComputedTiming().iterations === Number.POSITIVE_INFINITY,
      ),
  );
}

/**
 * The Dashboard's heading: its h1, the analysed track's title, in the hero beside "View full
 * analysis" (the Player's h1 is the same title, without that button).
 */
export function dashboardHeading(page: Page) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("button", { name: "View full analysis" }) })
    .getByRole("heading", { level: 1 });
}

/**
 * Opens the results of a run that has completed, with "Open the results": `opened` is what shows
 * once they are open (the Dashboard's heading, or the screen that says its code could not be
 * loaded). The progress screen also opens them by itself 3.5 s after the run completes: on a
 * busy machine, a click still being retried then (the button not yet where a click lands) finds
 * the button gone, and would wait for it until the test times out. So the click is tried a
 * little at a time, until the results are shown, by the click or by themselves: it returns once
 * `opened` is visible, however long the first paint of the results takes. A test of the button
 * itself clicks it directly, with the page's clock held so that nothing else opens them.
 * It returns at once if `opened` is already visible: a test that leaves one Dashboard for a new
 * run first waits until that Dashboard is gone.
 */
export async function openResults(page: Page, opened: Locator = dashboardHeading(page)) {
  const button = page.getByRole("button", { name: "Open the results" });
  await expect(async () => {
    if (await opened.isVisible()) return;
    if (await button.isVisible()) await button.click({ timeout: 2_000 });
    await expect(opened).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

/**
 * Holds the page's time from before a run completes, so that its progress screen stays: the
 * screen would otherwise open the results by itself 3.5 s after the result. The page's clock
 * must have been installed (`page.clock.install()`) before the page loaded;
 * `page.clock.resume()` lets its time run again.
 */
export async function holdClock(page: Page) {
  // A moment just ahead of the page's time, which runs on meanwhile. If that moment has passed
  // when the pause lands (a busy machine), the page is paused all the same and the call refuses
  // to go back: the second try, from the held time, lands.
  await expect(async () => {
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 50));
  }).toPass({ timeout: 5_000 });
}

/**
 * With the page's time held (`holdClock`), runs it on 50 ms at a time (the mocked stream's
 * pace) until the run has ended, then checks that "Open the results" shows: it does 0.4 s after
 * the result, well short of the 3.5 s after which the results open by themselves, so the progress
 * screen is still there to be read. A run that ends otherwise fails at once, naming the screen
 * shown instead ("The analysis did not finish", or results opened without the button).
 * At most `maxMs` of the page's time is run (by default 2.5 s: a few dozen events at the mocked
 * pace, then the 0.4 s), so a run that stalls on a timer fails here as it would on a real clock;
 * a test whose stream is longer passes its own budget.
 */
export async function runUntilResultsButton(
  page: Page,
  { maxMs = 2_500 }: { maxMs?: number } = {},
) {
  const button = page.getByRole("button", { name: "Open the results" });
  const failed = page.getByRole("heading", { name: "The analysis did not finish" });
  const results = dashboardHeading(page);
  let ran = 0;
  while (!(await button.or(failed).or(results).first().isVisible())) {
    expect(
      ran,
      `"Open the results", an error or the results show within ${maxMs} ms of the page's time (${ran} ms run)`,
    ).toBeLessThan(maxMs);
    await page.clock.runFor(50);
    ran += 50;
  }
  expect(
    await failed.isVisible(),
    `the run ended in an error after ${ran} ms of the page's time: "The analysis did not finish"`,
  ).toBe(false);
  expect(
    await results.isVisible(),
    `the results opened without "Open the results", after ${ran} ms of the page's time`,
  ).toBe(false);
  await expect(button).toBeVisible({ timeout: 1_000 });
}

/**
 * Waits until a run has reached its result: "Open the results" on the completion screen, or the
 * Dashboard that screen opens by itself 3.5 s later. For a test whose subject came before the
 * result and runs on the page's own time (a wait or a countdown), so that time is not held.
 */
export async function resultReached(page: Page, { timeout }: { timeout?: number } = {}) {
  await expect(
    page.getByRole("button", { name: "Open the results" }).or(dashboardHeading(page)).first(),
  ).toBeVisible({ timeout });
}

/** Runs a search against the mocked stream and continues to the Dashboard. */
export async function analyzeAndOpenDashboard(
  page: Page,
  query: string,
  { reload = true }: { reload?: boolean } = {},
) {
  if (reload) await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill(query);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await openResults(page);
  await expect(dashboardHeading(page)).toBeVisible();
  // The connected tracks follow once the link reader has loaded.
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await animationsSettled(page);
}

/** Opens the Player from the Dashboard. */
export async function openPlayer(page: Page) {
  await page.getByRole("button", { name: "View full analysis" }).click();
  await expect(page.getByRole("button", { name: /Back to summary/ })).toBeVisible();
  await animationsSettled(page);
}
