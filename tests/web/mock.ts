import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { AnalyzeStreamEvent, FactoidStreamEvent, RunResponse } from "@liner-notes/contract";
import { expect, type Page } from "@playwright/test";
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

/**
 * The recorded demo run (fixtures/replays/one-more-time-daft-punk.json) as the API replays it
 * (apps/api/src/replay/player.ts): its events without their run id and `seq` and without the
 * recorded `done`, each with its time since the run started (its own `elapsedMs`, else its
 * `atMs`), the replay notice right after `connected`, and the result as a replay of run
 * `runId`, with the recording's date and commit. Returns the analysis stream's events, ending
 * with `complete` and `done`.
 */
export function replayedRecording(runId = "replay-run") {
  const record = JSON.parse(
    readFileSync(
      join(mockDir, "..", "..", "fixtures", "replays", "one-more-time-daft-punk.json"),
      "utf8",
    ),
  );
  const { queryMatch: _match, ...analysis } = record.analysis;
  const result = {
    ...analysis,
    run: {
      ...analysis.run,
      id: runId,
      mode: "replay",
      replayed: "run",
      recordedAt: record.recordedAt,
      commit: record.commit,
      analyzerVersion: record.analyzerVersion,
      usage: { llmCalls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, usd: 0 },
    },
  };
  const notice = {
    type: "status",
    message: `Replaying an analysis recorded on ${record.recordedAt} (commit ${record.commit}); nothing below runs live.`,
    code: "SYS-INIT",
    node: "replay",
  };
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

/** Runs a search against the mocked stream and continues to the Dashboard. */
export async function analyzeAndOpenDashboard(
  page: Page,
  query: string,
  { reload = true }: { reload?: boolean } = {},
) {
  if (reload) await page.goto("/");
  await page.getByPlaceholder(/Song title/).fill(query);
  await page.getByRole("button", { name: "Analyze", exact: true }).click();
  await page.getByRole("button", { name: "Open the results" }).click();
  await expect(page.getByRole("heading", { name: "Command Center" })).toBeVisible();
  // The connected tracks follow once the link reader has loaded.
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  await animationsSettled(page);
}

/** Opens the Player from the Dashboard. */
export async function openPlayer(page: Page) {
  await page.getByRole("button", { name: "VIEW FULL ANALYSIS" }).click();
  await expect(page.getByRole("button", { name: /BACK TO BASE/ })).toBeVisible();
  await animationsSettled(page);
}
