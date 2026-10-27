/**
 * Every analyze route runs its run in the run's context: every line logged while it runs, by the
 * route, the graph's nodes (here stubs that log without naming the run) or the replay player,
 * carries the run's id. One test per route that starts or continues a run: POST /api/analyze,
 * GET /api/analyze/stream, both resumes (POST and stream) and both replays (stream and POST).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SonicAgentStateType } from "../agent/state.js";
import {
  DEFAULT_RATE_LIMIT,
  DEFAULT_SEARCH_RATE_LIMIT,
  type HttpSettings,
} from "../config/settings.js";
import { type CapturedLogs, captureLogsForTests, logger } from "../logger.js";
import { setReplayPacingForTests } from "../replay/player.js";
import { closeDatabase, initializeDatabase } from "../store/database.js";
import { createApp } from "./app.js";
import { testAuth, withRunToken } from "./testApp.js";

vi.mock("../agent/nodes/index.js", async () => {
  const { interrupt } =
    await vi.importActual<typeof import("@langchain/langgraph")>("@langchain/langgraph");
  type State = SonicAgentStateType;
  type Config = LangGraphRunnableConfig;
  // Each stub logs the thread it runs on, but never the run id: the context adds that.
  const ran = (node: string, config: Config) =>
    logger("Stub").info(`${node} ran`, { threadId: config.configurable?.thread_id });
  const pause = () => new Promise((resolve) => setTimeout(resolve, 2));
  const track = { id: "track-a", title: "Title", artist: "Artist", album: "Album", coverUrl: "" };

  return {
    scoutNode: async (state: State, config: Config) => {
      await pause();
      ran("scout", config);
      if (state.songQuery.startsWith("ambiguous")) {
        return { candidates: [track, { ...track, id: "track-b" }] };
      }
      return { spotifyData: { id: "track-a", title: "Title", artist: "Artist" } };
    },
    clarificationNode: async (state: State, config: Config) => {
      const choice = interrupt({ candidates: state.candidates }) as { trackId: string };
      ran("clarification", config);
      return { spotifyData: { id: choice.trackId, title: "Title", artist: "Artist" } };
    },
    engineerNode: async (_state: State, config: Config) => {
      await pause();
      ran("engineer", config);
      return {};
    },
    historianNode: async (_state: State, config: Config) => {
      await new Promise((resolve) => setImmediate(resolve));
      ran("historian", config);
      return {};
    },
    composerNode: async (state: State, config: Config) => {
      ran("composer", config);
      const trackData = {
        ...track,
        bpm: null,
        genealogy: { nodes: [], links: [] },
        spotify: state.spotifyData,
      };
      config.writer?.({ type: "complete", data: trackData });
      return { trackData, statusMessages: ["done"] };
    },
  };
});

// The replay player, as it is, with one line logged (without the run id) as it plays.
vi.mock("../replay/player.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../replay/player.js")>();
  return {
    ...actual,
    playRecord: async (...args: Parameters<typeof actual.playRecord>) => {
      await new Promise((resolve) => setTimeout(resolve, 2));
      logger("Player").info("playing");
      return actual.playRecord(...args);
    },
    replayedAnalysis: (...args: Parameters<typeof actual.replayedAnalysis>) => {
      logger("Player").info("serving");
      return actual.replayedAnalysis(...args);
    },
  };
});

const settings: HttpSettings = {
  corsOrigins: [],
  trustProxy: 0,
  rateLimit: DEFAULT_RATE_LIMIT,
  globalRateLimit: { windowMs: DEFAULT_RATE_LIMIT.windowMs, max: 10_000 },
  searchRateLimit: DEFAULT_SEARCH_RATE_LIMIT,
};
const app = createApp({ ...testAuth, http: settings });

let dir: string;
let logs: CapturedLogs;
let restorePacing: () => void;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "run-context-"));
  initializeDatabase(join(dir, "test.db"));
  restorePacing = setReplayPacingForTests({ speed: 1000, maxGapMs: 1 });
});
afterAll(() => {
  restorePacing();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  logs = captureLogsForTests();
});
afterEach(() => {
  logs.restore();
  vi.unstubAllEnvs();
});

/** A stream's messages, once it ends. */
async function stream(path: string): Promise<Array<{ type: string; threadId?: string }>> {
  const res = await request(app)
    .get(withRunToken(path, new URLSearchParams(path.split("?")[1]).get("threadId") ?? undefined))
    .buffer(true)
    .parse((response, callback) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => callback(null, body));
    });
  return String(res.body)
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)));
}

/**
 * Every line logged since the last clear carries `runId`, and the lines of `logged` (stub nodes
 * or the player) are among them: logged without naming the run, they got it from the context.
 */
function expectRunLines(runId: string, logged: string[]): void {
  const entries = logs.entries();
  expect(entries.length).toBeGreaterThan(logged.length);
  for (const entry of entries) expect(entry.runId, JSON.stringify(entry)).toBe(runId);
  const stubLines = entries.filter((e) => e.component === "Stub" || e.component === "Player");
  expect(stubLines.map((e) => e.msg)).toEqual(expect.arrayContaining(logged));
  for (const entry of stubLines) if (entry.threadId) expect(entry.threadId).toBe(runId);
}

const NODES = ["scout ran", "engineer ran", "historian ran", "composer ran"];
const RESUMED = ["clarification ran", "engineer ran", "historian ran", "composer ran"];

describe("the run id on every line of a run", () => {
  it("POST /api/analyze", async () => {
    const res = await request(app).post(withRunToken("/api/analyze")).send({ query: "plain song" });
    expect(res.body.status).toBe("complete");
    expectRunLines(res.body.threadId, NODES);
  });

  it("GET /api/analyze/stream", async () => {
    const events = await stream("/api/analyze/stream?query=plain+song");
    expectRunLines(events[0].threadId as string, NODES);
  });

  it("POST /api/analyze/resume", async () => {
    const paused = await request(app)
      .post(withRunToken("/api/analyze"))
      .send({ query: "ambiguous song" });
    expect(paused.body.status).toBe("interrupted");
    logs.clear();
    const res = await request(app)
      .post(withRunToken("/api/analyze/resume", paused.body.threadId))
      .send({ threadId: paused.body.threadId, selectedTrackId: "track-a" });
    expect(res.body.status).toBe("complete");
    expectRunLines(paused.body.threadId, RESUMED);
  });

  it("GET /api/analyze/stream/resume", async () => {
    const paused = await stream("/api/analyze/stream?query=ambiguous+song");
    const threadId = paused.find((event) => event.type === "interrupt")?.threadId as string;
    expect(threadId).toEqual(expect.any(String));
    logs.clear();
    const events = await stream(
      `/api/analyze/stream/resume?threadId=${threadId}&selectedTrackId=track-a`,
    );
    expect(events.map((event) => event.type)).toContain("complete");
    expectRunLines(threadId, RESUMED);
  });

  it("GET /api/analyze/stream, replayed", async () => {
    vi.stubEnv("REPLAY_MODE", "only");
    // The recordings are read once per process; their lines belong to no run.
    await request(app)
      .post(withRunToken("/api/analyze"))
      .send({ query: "One More Time Daft Punk" });
    logs.clear();
    const events = await stream("/api/analyze/stream?query=One+More+Time+Daft+Punk");
    expect(events.map((event) => event.type)).toContain("complete");
    expectRunLines(events[0].threadId as string, ["playing"]);
  });

  it("POST /api/analyze, replayed", async () => {
    vi.stubEnv("REPLAY_MODE", "only");
    await stream("/api/analyze/stream?query=One+More+Time+Daft+Punk");
    logs.clear();
    const res = await request(app)
      .post(withRunToken("/api/analyze"))
      .send({ query: "One More Time Daft Punk" });
    expect(res.body.data?.run?.mode).toBe("replay");
    expectRunLines(res.body.threadId, ["serving"]);
  });
});
