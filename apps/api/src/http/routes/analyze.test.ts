/**
 * Route tests for /api/analyze*: the real Express routes and the real compiled graph, with the
 * nodes that call outside services replaced by stubs. The clarification node is the real one
 * (its Spotify lookup is stubbed), so pausing and resuming go through LangGraph's interrupt().
 *
 * The stub scout picks its path from the query:
 *   "cached …"     cache hit: reports `complete` through the writer and in its update
 *   "ambiguous …"  two candidates, so the run pauses for a choice ("ambiguous-one …": one)
 *   "nomatch …"    Spotify found nothing
 *   "outage …"     Spotify could not be reached
 *   "ratelimited …" Spotify kept rate limiting; "ratelimited-unsaid …" without saying how long
 *   "odd …"        an error the route does not recognise
 *   anything else  one match; the composer then reports `complete` both ways, and a query
 *                  containing "fallback" takes the composer's model-unavailable path
 * Hooks on `stub` hold a node (or the Spotify lookup) so a test can act mid-run.
 */

import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { HEARTBEAT_INTERVAL_MS } from "@liner-notes/contract";
import request from "supertest";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";
import { createSonicAgentGraph } from "../../agent/graph.js";
import { llm } from "../../llm/invoke.js";
import { captureLogsForTests } from "../../logger.js";
import type { SonicAgentStateType } from "../../agent/state.js";
import { closeDatabase, getDb, initializeDatabase } from "../../store/database.js";
import { DEFAULT_RETENTION, pruneDatabase } from "../../store/retention.js";
import { getRun, listRunEvents, runDurationSql } from "../../store/runs.js";
import { createTestApp, withRunToken } from "../testApp.js";
import analyzeRouter, { RUN_DEADLINE_MS, setRunDeadlineForTests } from "./analyze.js";

/** The messages of the warnings logged from now until the test ends. */
function captureWarnings(): () => string[] {
  const logs = captureLogsForTests();
  onTestFinished(() => logs.restore());
  return () =>
    logs
      .entries()
      .filter((entry) => entry.level === "warn")
      .map((entry) => String(entry.msg));
}

/** A hook gets the run's signal and its id (the graph's thread). */
type Hook = null | ((signal: AbortSignal | undefined, runId: string) => Promise<void>);

const stub = vi.hoisted(() => ({
  calls: {
    scout: 0,
    engineer: 0,
    engineerDone: 0,
    historian: 0,
    composer: 0,
    details: 0,
  } as Record<string, number>,
  scoutStep: null as Hook,
  engineerStep: null as Hook,
  composerAfterComplete: null as Hook,
  detailsStep: null as null | (() => Promise<void>),
  detailsFail: false,
  /** The requested track id each run's scout saw, and how the composer's track was picked. */
  seen: {
    requestedTrackId: [] as unknown[],
    pickedBy: [] as unknown[],
    requestPickedBy: [] as unknown[],
  },
  /**
   * A result the stream can send (a TrackAnalysis: the stream checks every event against the
   * contract), with the title the test looks for and any extra fields.
   */
  track: (title: string, extra: Record<string, unknown> = {}) => ({
    id: "track-only",
    title,
    artist: "Artist",
    album: "Album",
    coverUrl: "",
    bpm: null,
    genealogy: { nodes: [], links: [] },
    ...extra,
  }),
}));

vi.mock("../../sources/spotify.js", () => ({
  fetchTrack: async (trackId: string) => {
    stub.calls.details++;
    await stub.detailsStep?.();
    if (stub.detailsFail) throw new Error("Spotify unavailable");
    return {
      id: trackId,
      title: `Title ${trackId}`,
      artist: "Artist",
      artistIds: [],
      album: "Album",
      releaseDate: "1994",
      coverUrl: "",
      duration: "3:38",
      durationMs: 218000,
      explicit: false,
      spotifyUrl: `https://open.spotify.com/track/${trackId}`,
      previewUrl: null,
    };
  },
}));

vi.mock("../../agent/nodes/index.js", async () => {
  const { clarificationNode } = await vi.importActual<
    typeof import("../../agent/nodes/clarificationNode.js")
  >("../../agent/nodes/clarificationNode.js");

  type State = SonicAgentStateType;
  type Config = LangGraphRunnableConfig;
  const status = (config: Config, node: string, message: string) =>
    config.writer?.({ type: "status", node, message, timestamp: new Date().toISOString() });

  return {
    clarificationNode,
    scoutNode: async (state: State, config: Config) => {
      stub.calls.scout++;
      stub.seen.requestedTrackId.push(state.requestedTrackId);
      stub.seen.requestPickedBy.push(state.pickedBy);
      status(config, "scout", "searching");
      await stub.scoutStep?.(config.signal, String(config.configurable?.thread_id));
      const query = state.songQuery;
      if (query.startsWith("cached")) {
        const trackData = stub.track("cached");
        config.writer?.({ type: "complete", data: trackData });
        return { trackData };
      }
      if (query.startsWith("nomatch")) {
        return { error: "No tracks found", scoutFailure: { kind: "no_match" as const } };
      }
      if (query.startsWith("outage")) {
        return {
          error: "Spotify search failed: spotify: HTTP 503 — secret-upstream-detail",
          scoutFailure: { kind: "upstream_unavailable" as const },
        };
      }
      if (query.startsWith("ratelimited")) {
        return {
          error: "Spotify search failed: spotify: HTTP 429",
          scoutFailure: {
            kind: "rate_limited" as const,
            retryAfterMs: query.startsWith("ratelimited-unsaid") ? null : 30_000,
          },
        };
      }
      if (query.startsWith("odd")) return { error: "secret-odd-detail" };
      if (query.startsWith("ambiguous")) {
        const ids = query.startsWith("ambiguous-one") ? ["track-a"] : ["track-a", "track-b"];
        const candidates = ids.map((id) => ({
          id,
          title: `Title ${id}`,
          artist: "Artist",
          album: "Album",
          coverUrl: "",
        }));
        config.writer?.({ type: "candidates", candidates, message: "pick one" });
        return { candidates };
      }
      return { spotifyData: { id: "track-only", title: "Title track-only", artist: "Artist" } };
    },
    engineerNode: async (_state: State, config: Config) => {
      stub.calls.engineer++;
      status(config, "engineer", "measuring");
      await stub.engineerStep?.(config.signal, String(config.configurable?.thread_id));
      stub.calls.engineerDone++;
      return {};
    },
    historianNode: async () => {
      stub.calls.historian++;
      return {};
    },
    composerNode: async (state: State, config: Config) => {
      stub.calls.composer++;
      stub.seen.pickedBy.push(state.pickedBy);
      const trackData = stub.track(state.songQuery.includes("fallback") ? "fallback" : "composed", {
        spotify: state.spotifyData,
      });
      config.writer?.({ type: "complete", data: trackData });
      // Stands for the store write the real composer awaits after reporting the result.
      await stub.composerAfterComplete?.(config.signal, String(config.configurable?.thread_id));
      return { trackData, statusMessages: ["done"] };
    },
  };
});

// =============================================================================
// Helpers
// =============================================================================

type Event = { type: string; [key: string]: unknown };

function parseEvents(body: string): Event[] {
  return body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Event);
}

const app = createTestApp(analyzeRouter);

/** GETs an event stream and returns its status, headers, raw body and messages once it ends. */
async function sse(path: string) {
  const res = await request(app)
    .get(path)
    .buffer(true)
    .parse((response, callback) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => callback(null, body));
    });
  const body = res.body as string;
  return { status: res.status, headers: res.headers, body, events: parseEvents(body) };
}

const ofType = (events: Event[], type: string) => events.filter((event) => event.type === type);
const types = (events: Event[]) => events.map((event) => event.type);
// Each analysis with a run token of its own; a resume with the token its run started with.
const streamPath = (query: string) =>
  withRunToken(`/api/analyze/stream?query=${encodeURIComponent(query)}`);
const resumePath = (threadId: string, trackId: string) =>
  withRunToken(
    `/api/analyze/stream/resume?threadId=${encodeURIComponent(threadId)}&selectedTrackId=${trackId}`,
    threadId,
  );
const postResume = (threadId: string, selectedTrackId: string) =>
  request(app)
    .post(withRunToken("/api/analyze/resume", threadId))
    .send({ threadId, selectedTrackId });

/** Starts an ambiguous analysis and returns the thread it paused. */
async function pausedThread(): Promise<string> {
  const { events } = await sse(streamPath("ambiguous hurt"));
  const [interrupt] = ofType(events, "interrupt");
  expect(interrupt?.threadId).toEqual(expect.any(String));
  return interrupt.threadId as string;
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const runStatus = (threadId: string) => getRun(getDb(), threadId)?.status;

/** Lets pending callbacks run (several event-loop turns). */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

/** The real setTimeout, for waiting while a test's timers are fake. */
const realSetTimeout = globalThis.setTimeout;

/**
 * `promise` once it settles, on fake timers: meanwhile the timers that are due run, and the clock
 * stays where it is. The graph's store polls its queue with setTimeout(0) until the run ends, so
 * a run on fake timers ends only while those polls run. Moving the clock on to let them run, as
 * advanceTimersByTimeAsync does, runs one poll for each millisecond moved: 180,000 for the 3 min
 * deadline, about half a second at normal load (a few microseconds each) and past the test's
 * limit on a very busy machine. Stops polling once the real timers are back (the test has ended).
 */
async function settledOnFakeClock<T>(promise: Promise<T>): Promise<T> {
  let settled = false;
  const watched = promise.finally(() => {
    settled = true;
  });
  while (!settled && vi.isFakeTimers()) {
    vi.advanceTimersByTime(0);
    await new Promise((resolve) => realSetTimeout(resolve, 1));
  }
  return watched;
}

/** A real HTTP server for tests that need to drop the connection. */
let server: http.Server;
let port: number;

/** Opens a request on the real server; the caller can read what arrived and destroy it. */
function open(path: string, method = "GET", payload?: unknown) {
  let body = "";
  const response = deferred<http.IncomingMessage>();
  const req = http.request(
    {
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: payload ? { "content-type": "application/json" } : {},
    },
    (res) => {
      response.resolve(res);
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        body += chunk;
      });
      res.on("error", () => {});
    },
  );
  req.on("error", () => {});
  if (payload) req.write(JSON.stringify(payload));
  req.end();
  return { req, response: response.promise, body: () => body };
}

/** Holds the next checkpoint read (the resume check) until `release` is called. */
function holdNextCheckpointRead() {
  const saver = (
    createSonicAgentGraph() as unknown as {
      checkpointer: { getTuple: (...args: unknown[]) => Promise<unknown> };
    }
  ).checkpointer;
  const original = saver.getTuple.bind(saver);
  const reading = deferred();
  const gate = deferred();
  vi.spyOn(saver, "getTuple").mockImplementationOnce(async (...args: unknown[]) => {
    reading.resolve();
    await gate.promise;
    return original(...args);
  });
  return { reading: reading.promise, release: gate.resolve };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// =============================================================================
// Tests
// =============================================================================

describe("analyze routes", () => {
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "analyze-routes-"));
    initializeDatabase(join(dir, "test.db"));
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((r) => server.once("listening", () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    for (const key of Object.keys(stub.calls)) stub.calls[key] = 0;
    stub.scoutStep = null;
    stub.engineerStep = null;
    stub.composerAfterComplete = null;
    stub.detailsStep = null;
    stub.detailsFail = false;
    stub.seen = { requestedTrackId: [], pickedBy: [], requestPickedBy: [] };
  });
  let restoreDeadline: (() => void) | null = null;
  afterEach(() => {
    restoreDeadline?.();
    restoreDeadline = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("pausing for a choice", () => {
    it("streams the candidates once, in the interrupt, and records the run as interrupted", async () => {
      const res = await sse(streamPath("ambiguous hurt"));

      expect(res.status).toBe(200);
      expect(res.headers["x-accel-buffering"]).toBe("no");
      expect(ofType(res.events, "candidates")).toHaveLength(0);
      const interrupts = ofType(res.events, "interrupt");
      expect(interrupts).toHaveLength(1);
      const threadId = interrupts[0].threadId as string;
      expect(threadId).toMatch(/^[0-9a-f-]{36}$/);
      expect(interrupts[0].candidates).toHaveLength(2);
      expect(interrupts[0].message).toBe("2 possible tracks from Spotify; choose one");
      expect(ofType(res.events, "complete")).toHaveLength(0);
      expect(runStatus(threadId)).toBe("interrupted");
    });

    it("asks about one candidate as one, in the stream and in the POST answer", async () => {
      const one = "One possible track from Spotify; confirm it or search again";
      const streamed = ofType((await sse(streamPath("ambiguous-one hurt"))).events, "interrupt");
      expect(streamed.map((event) => event.message)).toEqual([one]);
      const posted = await request(app)
        .post(withRunToken("/api/analyze"))
        .send({ query: "ambiguous-one hurt" });
      expect(posted.body.interrupt).toMatchObject({ message: one });
      expect(posted.body.interrupt.candidates).toHaveLength(1);
    });

    it("POST interrupt: POST /api/analyze returns 200 with the threadId and the candidates", async () => {
      const res = await request(app)
        .post(withRunToken("/api/analyze"))
        .send({ query: "ambiguous hurt" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "interrupted", threadId: expect.any(String) });
      expect(res.body.interrupt.candidates.map((c: { id: string }) => c.id)).toEqual([
        "track-a",
        "track-b",
      ]);

      const resumed = await postResume(res.body.threadId, "track-b");
      expect(resumed.status).toBe(200);
      expect(resumed.body).toMatchObject({ status: "complete", data: { title: "composed" } });
      expect(runStatus(res.body.threadId)).toBe("completed");
    });

    it("POST resume releases the thread: a second resume after it finished is not_waiting, not 409", async () => {
      const threadId = await pausedThread();
      expect((await postResume(threadId, "track-a")).status).toBe(200);

      const again = await postResume(threadId, "track-b");
      expect(again.status).toBe(404);
      expect(again.body.code).toBe("not_waiting");
    });

    it("reopens the run while a resume is in progress", async () => {
      const threadId = await pausedThread();
      const entered = deferred();
      const gate = deferred();
      stub.engineerStep = async () => {
        entered.resolve();
        await gate.promise;
      };

      const resumed = sse(resumePath(threadId, "track-a"));
      await entered.promise;
      expect(getRun(getDb(), threadId)).toMatchObject({ status: "running", finishedAt: null });
      gate.resolve();
      await resumed;
      expect(runStatus(threadId)).toBe("completed");
    });

    it.each([
      ["stream", (threadId: string) => sse(resumePath(threadId, "track-a"))],
      ["POST", (threadId: string) => postResume(threadId, "track-a")],
    ])(
      "leaves the time waiting at the picker out of the run's duration (%s resume)",
      async (_, resume) => {
        const threadId = await pausedThread();
        // The visitor takes ten minutes to choose.
        const realNow = Date.now.bind(Date);
        vi.spyOn(Date, "now").mockImplementation(() => realNow() + 10 * 60 * 1000);

        await resume(threadId);

        expect(runStatus(threadId)).toBe("completed");
        const run = getDb()
          .prepare(
            `SELECT finished_at - created_at AS wall, paused_seconds AS paused,
             ${runDurationSql()} AS duration FROM runs WHERE run_id = ?`,
          )
          .get(threadId) as { wall: number; paused: number; duration: number };
        expect(run.wall).toBeGreaterThanOrEqual(600);
        expect(run.paused).toBeGreaterThanOrEqual(599);
        expect(run.duration).toBeLessThan(10);
      },
    );

    it("knows no duration nor commit for a run first recorded at its resume", async () => {
      const threadId = await pausedThread();
      // A thread paused before runs were recorded: it has no run record.
      getDb().prepare("DELETE FROM runs WHERE run_id = ?").run(threadId);

      await sse(resumePath(threadId, "track-a"));

      expect(runStatus(threadId)).toBe("completed");
      expect(
        getDb()
          .prepare(
            `SELECT paused_seconds AS paused, ${runDurationSql()} AS duration,
               code_commit AS commit_ FROM runs WHERE run_id = ?`,
          )
          .get(threadId),
      ).toEqual({ paused: null, duration: null, commit_: null });
    });

    it("uses the candidate's own data, with no invented duration or explicit flag, when the track lookup fails", async () => {
      stub.detailsFail = true;
      const threadId = await pausedThread();

      const { events } = await sse(resumePath(threadId, "track-a"));

      const [complete] = ofType(events, "complete");
      expect((complete.data as { spotify: unknown }).spotify).toMatchObject({
        id: "track-a",
        title: "Title track-a",
        duration: "",
        durationMs: 0,
        explicit: null,
        previewUrl: null,
      });
    });
  });

  describe("one complete per run", () => {
    it.each([
      ["cache hit", "cached hurt", "cached"],
      ["normal", "plain hurt", "composed"],
      ["fallback", "fallback hurt", "fallback"],
    ])("sends one complete on the %s path", async (_path, query, title) => {
      const { events } = await sse(streamPath(query));

      const completes = ofType(events, "complete");
      expect(completes).toHaveLength(1);
      expect(completes[0].data).toMatchObject({ title });
      expect(events.at(-1)?.type).toBe("done");
      const threadId = ofType(events, "connected")[0].threadId as string;
      expect(runStatus(threadId)).toBe("completed");
    });

    it("ends the model run when a run finishes, not while it waits for a choice", async () => {
      const endRun = vi.spyOn(llm, "endRun").mockImplementation(() => {});

      const { events } = await sse(streamPath("plain hurt"));
      const threadId = ofType(events, "connected")[0].threadId as string;
      expect(endRun).toHaveBeenCalledWith(threadId);

      endRun.mockClear();
      const paused = await pausedThread();
      expect(endRun).not.toHaveBeenCalledWith(paused);
      await sse(resumePath(paused, "track-a"));
      expect(endRun).toHaveBeenCalledWith(paused);
    });

    it("sends one complete after a resume", async () => {
      const threadId = await pausedThread();

      const { events } = await sse(resumePath(threadId, "track-a"));

      expect(ofType(events, "complete")).toHaveLength(1);
      expect(stub.calls).toMatchObject({ engineer: 1, historian: 1, composer: 1 });
    });

    it("records completed when the client leaves after complete was sent", async () => {
      const entered = deferred();
      const gate = deferred();
      stub.composerAfterComplete = async () => {
        entered.resolve();
        await gate.promise;
      };
      const warned = captureWarnings();

      const client = open(streamPath("plain hurt"));
      await entered.promise;
      await vi.waitFor(() =>
        expect(ofType(parseEvents(client.body()), "complete")).toHaveLength(1),
      );
      const threadId = ofType(parseEvents(client.body()), "connected")[0].threadId as string;
      client.req.destroy();
      await vi.waitFor(() =>
        expect(warned()).toContainEqual(expect.stringContaining("run aborted")),
      );
      gate.resolve();

      await vi.waitFor(() => expect(runStatus(threadId)).toBe("completed"));
    });
  });

  describe("a request for a track by id", () => {
    const ID = "6GyFP1nfCDB8lbD2bG0Hq9";

    it("hands the stream's track id to the scout", async () => {
      const { events } = await sse(`${streamPath("midnight city m83")}&trackId=${ID}`);

      expect(types(events)).toContain("complete");
      expect(stub.seen.requestedTrackId).toEqual([ID]);
    });

    it("hands POST's track id to the scout, and none for a search by text", async () => {
      const res = await request(app)
        .post(withRunToken("/api/analyze"))
        .send({ query: "midnight city m83", trackId: ID });
      expect(res.status).toBe(200);
      await request(app).post(withRunToken("/api/analyze")).send({ query: "midnight city m83" });

      expect(stub.seen.requestedTrackId).toEqual([ID, null]);
    });

    it("hands how a picker row asked for by id was picked to the scout, only with an id", async () => {
      await sse(`${streamPath("midnight city m83")}&trackId=${ID}&pickedBy=countdown`);
      await request(app)
        .post(withRunToken("/api/analyze"))
        .send({ query: "midnight city m83", trackId: ID, pickedBy: "click" });
      await request(app)
        .post(withRunToken("/api/analyze"))
        .send({ query: "midnight", pickedBy: "click" });

      expect(stub.seen.requestPickedBy).toEqual(["countdown", "click", null]);
    });

    it.each(["short", "6GyFP1nfCDB8lbD2bG0Hq9x", "6GyFP1nfCDB8lbD2bG0H/9"])(
      "refuses %j as a track id, without starting a run",
      async (trackId) => {
        const { events } = await sse(
          `${streamPath("midnight city")}&trackId=${encodeURIComponent(trackId)}`,
        );
        const res = await request(app)
          .post(withRunToken("/api/analyze"))
          .send({ query: "midnight", trackId });

        expect(events[0]).toMatchObject({ type: "error", code: "invalid_input" });
        expect(res.status).toBe(400);
        expect(stub.calls.scout).toBe(0);
      },
    );
  });

  describe("how a pick was made", () => {
    it.each([
      ["click", "click"],
      ["countdown", "countdown"],
      [undefined, null],
      ["magic", null],
    ])("a stream resume with pickedBy=%s reaches the run as %s", async (pickedBy, seen) => {
      const threadId = await pausedThread();
      const path = resumePath(threadId, "track-a") + (pickedBy ? `&pickedBy=${pickedBy}` : "");

      const { events } = await sse(path);

      expect(types(events)).toContain("complete");
      expect(stub.seen.pickedBy).toEqual([seen]);
    });

    it("a POST resume passes pickedBy too", async () => {
      const threadId = await pausedThread();

      const res = await request(app)
        .post(withRunToken("/api/analyze/resume", threadId))
        .send({ threadId, selectedTrackId: "track-a", pickedBy: "click" });

      expect(res.status).toBe(200);
      expect(stub.seen.pickedBy).toEqual(["click"]);
    });
  });

  describe("a Spotify rate limit", () => {
    it("is answered with a message naming it, the wait and a Retry-After header", async () => {
      const res = await request(app)
        .post(withRunToken("/api/analyze"))
        .send({ query: "ratelimited hurt" });

      expect(res.status).toBe(502);
      expect(res.headers["retry-after"]).toBe("30");
      expect(res.body).toMatchObject({
        success: false,
        code: "upstream_unavailable",
        retryAfterMs: 30_000,
        error: "Spotify is limiting requests right now. Please try again in about 30 s.",
      });
    });

    it("says so on the stream too, and without a wait when Spotify did not say one", async () => {
      const { events } = await sse(streamPath("ratelimited hurt"));
      const unsaid = await request(app)
        .post(withRunToken("/api/analyze"))
        .send({ query: "ratelimited-unsaid hurt" });

      expect(ofType(events, "error")[0]).toMatchObject({
        code: "upstream_unavailable",
        error: "Spotify is limiting requests right now. Please try again in about 30 s.",
      });
      expect(unsaid.headers["retry-after"]).toBeUndefined();
      expect(unsaid.body.error).toBe(
        "Spotify is limiting requests right now. Please try again in a moment.",
      );
    });
  });

  describe("failures", () => {
    it.each([
      ["no_match", "nomatch hurt", "No song matched that search.", "No tracks found"],
      ["upstream_unavailable", "outage hurt", "not responding", "secret-upstream-detail"],
      ["failed", "odd hurt", "could not be completed", "secret-odd-detail"],
    ])(
      "the stream reports %s with a generic message and no raw error text",
      async (code, query, text, raw) => {
        const { status, body, events } = await sse(streamPath(query));

        expect(status).toBe(200);
        const errors = ofType(events, "error");
        expect(errors).toHaveLength(1);
        expect(errors[0]).toMatchObject({ code, error: expect.stringContaining(text) });
        expect(body).not.toContain(raw);
        expect(events.at(-1)?.type).toBe("done");
        expect(runStatus(ofType(events, "connected")[0].threadId as string)).toBe("failed");
      },
    );

    it("no_match does not ask the user to try again", async () => {
      const { events } = await sse(streamPath("nomatch hurt"));
      expect(String(ofType(events, "error")[0].error)).not.toMatch(/try again/i);
    });

    it.each([
      ["no_match", 422, "nomatch hurt"],
      ["upstream_unavailable", 502, "outage hurt"],
      ["failed", 500, "odd hurt"],
    ])("POST /api/analyze answers %s with status %i", async (code, httpStatus, query) => {
      const res = await request(app).post(withRunToken("/api/analyze")).send({ query });

      expect(res.status).toBe(httpStatus);
      expect(res.body).toMatchObject({ success: false, code });
      expect(JSON.stringify(res.body)).not.toContain("secret");
    });
  });

  describe("concurrent resume", () => {
    /** Holds the engineer; reports whether it was entered a second time. */
    function holdEngineer() {
      const first = deferred();
      const second = deferred<"ran twice">();
      const gate = deferred();
      stub.engineerStep = async () => {
        if (stub.calls.engineer === 1) first.resolve();
        else second.resolve("ran twice");
        await gate.promise;
      };
      return { first: first.promise, ranTwice: second.promise, release: gate.resolve };
    }

    it("refuses a second resume of the same thread on the stream, and every node runs once", async () => {
      const threadId = await pausedThread();
      const engineer = holdEngineer();

      const first = sse(resumePath(threadId, "track-a"));
      await engineer.first;
      const second = sse(resumePath(threadId, "track-b"));
      const winner = await Promise.race([second, engineer.ranTwice]);
      engineer.release();
      const [firstRes, secondRes] = await Promise.all([first, second]);

      expect(winner).not.toBe("ran twice");
      expect(secondRes.status).toBe(200);
      expect(types(secondRes.events)).toEqual(["error", "done"]);
      expect(secondRes.events[0]).toMatchObject({
        code: "resume_in_progress",
        error: expect.any(String),
      });
      expect(ofType(firstRes.events, "complete")).toHaveLength(1);
      expect(stub.calls).toMatchObject({ engineer: 1, historian: 1, composer: 1 });
    });

    it("concurrent resume over POST gets 409", async () => {
      const threadId = await pausedThread();
      const engineer = holdEngineer();

      const first = postResume(threadId, "track-a").then((res) => res);
      await engineer.first;
      const second = postResume(threadId, "track-b").then((res) => res);
      const winner = await Promise.race([second, engineer.ranTwice]);
      engineer.release();
      const [firstRes, secondRes] = await Promise.all([first, second]);

      expect(winner).not.toBe("ran twice");
      expect(secondRes.status).toBe(409);
      expect(secondRes.body.code).toBe("resume_in_progress");
      expect(firstRes.status).toBe(200);
      expect(stub.calls).toMatchObject({ engineer: 1, composer: 1 });
    });
  });

  describe("resume of a thread that cannot be resumed", () => {
    it("unknown thread: the stream reports choice_expired; POST returns 404", async () => {
      const res = await sse(resumePath("nope", "x"));

      expect(res.status).toBe(200);
      expect(types(res.events)).toEqual(["error", "done"]);
      expect(res.events[0]).toMatchObject({ code: "choice_expired", error: expect.any(String) });

      const post = await postResume("nope", "x");
      expect(post.status).toBe(404);
      expect(post.body.code).toBe("choice_expired");
      expect(stub.calls.engineer).toBe(0);
    });

    it("a finished thread is not waiting: the stream reports not_waiting; POST returns 404", async () => {
      const threadId = await pausedThread();
      await sse(resumePath(threadId, "track-a"));

      const again = await sse(resumePath(threadId, "track-b"));
      expect(types(again.events)).toEqual(["error", "done"]);
      expect(again.events[0].code).toBe("not_waiting");

      const post = await postResume(threadId, "track-b");
      expect(post.status).toBe(404);
      expect(post.body.code).toBe("not_waiting");
      expect(stub.calls.composer).toBe(1);
    });

    it("a track that was not offered is refused and the choice stays open", async () => {
      const threadId = await pausedThread();

      const res = await sse(resumePath(threadId, "track-zzz"));
      expect(res.events[0]).toMatchObject({ type: "error", code: "invalid_selection" });
      const post = await postResume(threadId, "track-zzz");
      expect(post.status).toBe(400);
      expect(post.body.code).toBe("invalid_selection");

      const ok = await sse(resumePath(threadId, "track-a"));
      expect(ofType(ok.events, "complete")).toHaveLength(1);
    });

    it("expired choice: a paused thread pruned by retention reports choice_expired", async () => {
      const threadId = await pausedThread();
      // Past the run retention an open run counts as abandoned, so its thread is pruned.
      pruneDatabase(getDb(), DEFAULT_RETENTION, Date.now() + 31 * DAY);

      const res = await sse(resumePath(threadId, "track-a"));
      expect(types(res.events)).toEqual(["error", "done"]);
      expect(res.events[0]).toMatchObject({ code: "choice_expired" });

      const post = await postResume(threadId, "track-a");
      expect(post.status).toBe(404);
      expect(post.body.code).toBe("choice_expired");
      expect(stub.calls.engineer).toBe(0);
    });

    it("a run cancelled after the choice reports run_interrupted on later resumes", async () => {
      const threadId = await pausedThread();
      const entered = deferred();
      stub.engineerStep = (signal) =>
        new Promise<void>((resolve) => {
          entered.resolve();
          signal?.addEventListener("abort", () => resolve());
        });

      const client = open(resumePath(threadId, "track-a"));
      await entered.promise;
      client.req.destroy();
      await vi.waitFor(() => expect(runStatus(threadId)).toBe("cancelled"));

      const res = await sse(resumePath(threadId, "track-b"));
      expect(types(res.events)).toEqual(["error", "done"]);
      expect(res.events[0]).toMatchObject({
        code: "run_interrupted",
        error: "The analysis was interrupted. Please search again.",
      });
      const post = await postResume(threadId, "track-b");
      expect(post.status).toBe(404);
      expect(post.body.code).toBe("run_interrupted");
    });
  });

  describe("retention", () => {
    it("keeps a paused thread past the checkpoint retention, and it can be resumed", async () => {
      const threadId = await pausedThread();

      pruneDatabase(getDb(), DEFAULT_RETENTION, Date.now() + 25 * HOUR);

      expect(runStatus(threadId)).toBe("interrupted");
      const { events } = await sse(resumePath(threadId, "track-b"));
      expect(ofType(events, "error")).toHaveLength(0);
      expect(ofType(events, "complete")).toHaveLength(1);
      expect(runStatus(threadId)).toBe("completed");
    });

    it("a resume aborted before the choice is applied keeps the choice open past 25 h", async () => {
      const threadId = await pausedThread();
      const looking = deferred();
      const gate = deferred();
      stub.detailsStep = async () => {
        looking.resolve();
        await gate.promise;
      };

      const client = open(resumePath(threadId, "track-a"));
      await looking.promise;
      expect(runStatus(threadId)).toBe("running");
      client.req.destroy();
      await vi.waitFor(() => expect(runStatus(threadId)).toBe("interrupted"));
      stub.detailsStep = null;
      gate.resolve();
      await settle();

      pruneDatabase(getDb(), DEFAULT_RETENTION, Date.now() + 25 * HOUR);

      const { events } = await sse(resumePath(threadId, "track-b"));
      const [complete] = ofType(events, "complete");
      expect(complete?.data).toMatchObject({ spotify: { id: "track-b" } });
    });
  });

  describe("disconnect", () => {
    it("aborts the run within 1 s when the client disconnects, and logs it", async () => {
      const warned = captureWarnings();
      const started = deferred();
      stub.engineerStep = (signal) =>
        new Promise<void>((resolve) => {
          started.resolve();
          signal?.addEventListener("abort", () => resolve());
        });

      const client = open(streamPath("plain hurt"));
      await started.promise;
      const threadId = await vi.waitFor(() => {
        const id = ofType(parseEvents(client.body()), "connected")[0]?.threadId;
        expect(id).toEqual(expect.any(String));
        return id as string;
      });

      client.req.destroy();
      await vi.waitFor(
        () => {
          expect(warned()).toContainEqual(expect.stringContaining("run aborted"));
          expect(runStatus(threadId)).toBe("cancelled");
        },
        { timeout: 1_000, interval: 20 },
      );
      await settle();
      expect(stub.calls.composer).toBe(0);
    });

    it("disconnect with a node that ignores the signal: cancelled, and no later step runs", async () => {
      const started = deferred();
      const gate = deferred();
      stub.engineerStep = async () => {
        started.resolve();
        await gate.promise;
      };

      const client = open(streamPath("plain hurt"));
      await started.promise;
      const threadId = await vi.waitFor(() => {
        const id = ofType(parseEvents(client.body()), "connected")[0]?.threadId;
        expect(id).toEqual(expect.any(String));
        return id as string;
      });

      client.req.destroy();
      await vi.waitFor(() => expect(runStatus(threadId)).toBe("cancelled"), {
        timeout: 1_000,
        interval: 20,
      });
      gate.resolve();
      await vi.waitFor(() => expect(stub.calls.engineerDone).toBe(1));
      await settle();
      expect(stub.calls.composer).toBe(0);
      expect(runStatus(threadId)).toBe("cancelled");
    });

    it.each([
      ["stream", (threadId: string) => open(resumePath(threadId, "track-a"))],
      [
        "POST",
        (threadId: string) =>
          open(withRunToken("/api/analyze/resume", threadId), "POST", {
            threadId,
            selectedTrackId: "track-a",
          }),
      ],
    ])(
      "disconnect during the resume check (%s): no run, choice kept, claim released",
      async (_route, start) => {
        const threadId = await pausedThread();
        const warned = captureWarnings();
        const check = holdNextCheckpointRead();

        const client = start(threadId);
        await check.reading;
        client.req.destroy();
        await vi.waitFor(() =>
          expect(warned()).toContainEqual(expect.stringContaining("Client disconnected")),
        );
        check.release();
        await vi.waitFor(() =>
          expect(warned()).toContainEqual(expect.stringContaining("Client left before")),
        );

        expect(stub.calls).toMatchObject({ details: 0, engineer: 0, composer: 0 });
        expect(runStatus(threadId)).toBe("interrupted");
        const { events } = await sse(resumePath(threadId, "track-b"));
        expect(ofType(events, "complete")).toHaveLength(1);
      },
    );
  });

  describe("heartbeat", () => {
    it("sends a heartbeat message every 15 s while a step takes 40 s", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const started = deferred();
      stub.engineerStep = async () => {
        started.resolve();
        await new Promise((r) => setTimeout(r, 40_000));
      };

      const pending = sse(streamPath("plain hurt"));
      await started.promise;
      // The clock jumps 40 s at once: the timers due meanwhile (the heartbeats, the step's own)
      // run in order, and the rest of the run then ends on the stopped clock.
      vi.advanceTimersByTime(40_000);
      const { events } = await settledOnFakeClock(pending);

      expect(ofType(events, "heartbeat").length).toBeGreaterThanOrEqual(2);
      expect(ofType(events, "complete")).toHaveLength(1);
    });

    /**
     * How long a busy machine is given to carry the headers across the loopback. Well inside the
     * heartbeat's interval: a heartbeat would send headers held back until the resume check too,
     * and a wait as long as it would let it.
     */
    const LOOPBACK_WAIT_MS = HEARTBEAT_INTERVAL_MS / 2;
    it("sends the stream headers before the resume check finishes", {
      timeout: 3 * LOOPBACK_WAIT_MS,
    }, async () => {
      const threadId = await pausedThread();
      const check = holdNextCheckpointRead();
      try {
        const client = open(resumePath(threadId, "track-a"));
        await check.reading;
        // The check is held until released below, so headers sent only after it never arrive.
        // Those sent before it still cross the loopback, which on a busy machine can take more
        // than a few turns of the event loop: they are waited for, up to a bound no busy machine
        // reaches.
        let noHeaders: ReturnType<typeof setTimeout> | undefined;
        const response = await Promise.race([
          client.response,
          new Promise<null>((resolve) => {
            noHeaders = setTimeout(() => resolve(null), LOOPBACK_WAIT_MS);
          }),
        ]);
        clearTimeout(noHeaders);
        expect(response?.headers["content-type"]).toBe("text/event-stream");
        expect(response?.headers["x-accel-buffering"]).toBe("no");
        // Sent on their own: no event (a heartbeat, say) carried them.
        await settle();
        expect(parseEvents(client.body())).toEqual([]);

        check.release();
        await vi.waitFor(() => expect(parseEvents(client.body()).at(-1)?.type).toBe("done"), {
          timeout: LOOPBACK_WAIT_MS,
        });
      } finally {
        check.release();
      }
    });
  });

  describe("run deadline", () => {
    it("aborts a run that passes the deadline and reports a timeout", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const started = deferred();
      let aborted = false;
      stub.engineerStep = (signal) =>
        new Promise<void>((resolve) => {
          started.resolve();
          signal?.addEventListener("abort", () => {
            aborted = true;
            resolve();
          });
        });

      const pending = sse(streamPath("plain hurt"));
      await started.promise;
      // The clock jumps to the deadline at once, set when the run started: no earlier, and
      // then exactly at it. The rest of the run ends on the stopped clock.
      vi.advanceTimersByTime(RUN_DEADLINE_MS - 1);
      expect(aborted).toBe(false);
      vi.advanceTimersByTime(1);
      expect(aborted).toBe(true);
      const { events } = await settledOnFakeClock(pending);

      expect(ofType(events, "error")).toEqual([
        expect.objectContaining({ code: "timeout", error: expect.any(String) }),
      ]);
      expect(events.at(-1)?.type).toBe("done");
      expect(ofType(events, "complete")).toHaveLength(0);
      expect(runStatus(ofType(events, "connected")[0].threadId as string)).toBe("failed");
      expect(stub.calls.composer).toBe(0);
    });
  });

  describe("run deadline with a short deadline", () => {
    // Real timers: the clarification step uses the LangGraph store, whose batching polls with
    // setTimeout(0), so fake timers would stall it.
    const SHORT_DEADLINE_MS = 200;

    it("a resume that fails at the deadline before the choice is applied keeps the choice open", async () => {
      const threadId = await pausedThread();
      const gate = deferred();
      // The track lookup hangs and ignores the abort signal.
      stub.detailsStep = () => gate.promise;
      restoreDeadline = setRunDeadlineForTests(SHORT_DEADLINE_MS);

      const { events } = await sse(resumePath(threadId, "track-a"));

      expect(ofType(events, "error")).toEqual([expect.objectContaining({ code: "timeout" })]);
      expect(runStatus(threadId)).toBe("interrupted");
      stub.detailsStep = null;
      gate.resolve();
      await settle();
      restoreDeadline();
      restoreDeadline = null;

      pruneDatabase(getDb(), DEFAULT_RETENTION, Date.now() + 25 * HOUR);

      const again = await sse(resumePath(threadId, "track-b"));
      const [complete] = ofType(again.events, "complete");
      expect(complete?.data).toMatchObject({ spotify: { id: "track-b" } });
    });

    it("a run that fails at the deadline after the choice gives run_interrupted later", async () => {
      const threadId = await pausedThread();
      const gate = deferred();
      // The engineer hangs and ignores the abort signal.
      stub.engineerStep = () => gate.promise;
      restoreDeadline = setRunDeadlineForTests(SHORT_DEADLINE_MS);

      const { events } = await sse(resumePath(threadId, "track-a"));
      gate.resolve();

      expect(ofType(events, "error")).toEqual([expect.objectContaining({ code: "timeout" })]);
      expect(runStatus(threadId)).toBe("failed");
      const again = await sse(resumePath(threadId, "track-b"));
      expect(types(again.events)).toEqual(["error", "done"]);
      expect(again.events[0]).toMatchObject({ code: "run_interrupted" });
      const post = await postResume(threadId, "track-b");
      expect(post.status).toBe(404);
      expect(post.body.code).toBe("run_interrupted");
    });
  });

  describe("input validation", () => {
    it("POST rejects a missing, blank or overlong query and malformed resume ids with 400", async () => {
      const post = (query: unknown) =>
        request(app).post(withRunToken("/api/analyze")).send({ query });
      for (const query of [undefined, "", "   ", "x".repeat(201), ["a"], 5]) {
        const res = await post(query);
        expect(res.status).toBe(400);
        expect(res.body.code).toBe("invalid_input");
      }
      expect((await postResume("a/../b", "x")).status).toBe(400);
      expect((await postResume("abc", "")).status).toBe(400);
      expect(stub.calls.scout).toBe(0);
    });

    it.each([
      ["a NUL character", "hurt\u0000"],
      ["a control character", "hu\u0007rt"],
      ["a lone surrogate", "hurt \uD800"],
      ["only zero-width characters", "​‌﻿"],
      ["201 characters", "😀".repeat(201)],
    ])("rejects a query with %s", async (_what, query) => {
      expect((await request(app).post(withRunToken("/api/analyze")).send({ query })).status).toBe(
        400,
      );
      // A URL cannot carry a lone surrogate (it decodes to U+FFFD), so only POST sees one.
      if (!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(query)) {
        const stream = await sse(streamPath(query));
        expect(stream.events[0]).toMatchObject({ type: "error", code: "invalid_input" });
      }
      expect(stub.calls.scout).toBe(0);
    });

    it("accepts tabs and newlines inside a query, collapsed to one space", async () => {
      const res = await request(app)
        .post(withRunToken("/api/analyze"))
        .send({ query: "Hurt\tJohnny\n\n Cash" });
      expect(res.status).toBe(200);
      expect(getRun(getDb(), res.body.threadId)?.query).toBe("Hurt Johnny Cash");

      const stream = await sse(streamPath("Hurt\tJohnny Cash"));
      expect(ofType(stream.events, "error")).toHaveLength(0);
      expect(ofType(stream.events, "complete")).toHaveLength(1);
    });

    it("counts characters, not UTF-16 units, and trims before counting", async () => {
      const emoji = await request(app)
        .post(withRunToken("/api/analyze"))
        .send({ query: "😀".repeat(200) });
      expect(emoji.status).toBe(200);

      const padded = ` ${"a".repeat(200)} `;
      const res = await request(app).post(withRunToken("/api/analyze")).send({ query: padded });
      expect(res.status).toBe(200);
      expect(getRun(getDb(), res.body.threadId)?.query).toBe("a".repeat(200));
    });

    it("the stream routes report invalid input in the stream, with status 200", async () => {
      for (const path of [
        "/api/analyze/stream",
        streamPath("x".repeat(201)),
        "/api/analyze/stream?query=a&query=b",
        "/api/analyze/stream/resume?threadId=abc",
        "/api/analyze/stream/resume?threadId=a%2Fb&selectedTrackId=x",
      ]) {
        const res = await sse(path.includes("runToken=") ? path : withRunToken(path));
        expect(res.status).toBe(200);
        expect(types(res.events)).toEqual(["error", "done"]);
        expect(res.events[0]).toMatchObject({ code: "invalid_input", error: expect.any(String) });
      }
      expect(stub.calls.scout).toBe(0);
    });
  });

  describe("time since the run started", () => {
    /** The times since the run started of a stream's events, in the order they were sent. */
    const elapsed = (events: Event[]) => events.map((event) => event.elapsedMs);
    const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    /** How long a busy machine is given to send an event: far more than any takes. */
    const SENT_WITHIN_MS = 5_000;
    it("stamps every event of a live run with the time since it started, rising", {
      timeout: 3 * SENT_WITHIN_MS,
    }, async () => {
      // The step's 40 ms start once the scout's line has been sent (each event is stored as it
      // is sent). Events are stamped as they are sent, and a busy machine can send that line
      // late, into a wait that started when it was written: its stamp would then be late too.
      // A line not sent in time is recorded here and fails the test below, with its reason.
      let notSent: unknown;
      stub.scoutStep = async (_signal, runId) => {
        try {
          await vi.waitFor(
            () =>
              expect(
                listRunEvents(getDb(), runId).map(({ event }) => (event as Event).type),
              ).toContain("status"),
            { timeout: SENT_WITHIN_MS, interval: 1 },
          );
        } catch (error) {
          notSent = error;
        }
        await wait(40);
      };
      const { events } = await sse(streamPath("timed run"));

      expect(notSent).toBeUndefined();

      expect(types(events)).toEqual(["connected", "status", "status", "complete", "done"]);
      const times = elapsed(events);
      expect(times.every((ms) => Number.isInteger(ms) && (ms as number) >= 0)).toBe(true);
      expect(times).toEqual([...(times as number[])].sort((a, b) => a - b));
      // The engineer's line comes after the scout's step: its time is later by that step.
      const [searching, measuring] = ofType(events, "status").map((e) => e.elapsedMs as number);
      expect(measuring - searching).toBeGreaterThanOrEqual(35);
      expect(times[0]).toBeLessThan(searching + 1);
    });

    it("goes on from the paused stream's time on a resume, leaving out the wait for the choice", async () => {
      // The paused stream takes a while itself, so its time counted twice, or not at all, shows.
      stub.scoutStep = () => wait(150);
      const paused = await sse(streamPath("ambiguous timed"));
      stub.scoutStep = null;
      const pausedAt = paused.events.at(-1)?.elapsedMs as number;
      expect(paused.events.at(-1)?.type).toBe("done");
      expect(Number.isInteger(pausedAt)).toBe(true);
      expect(pausedAt).toBeGreaterThanOrEqual(145);
      const threadId = ofType(paused.events, "interrupt")[0].threadId as string;
      // Stored with each event, as it was sent: the resume goes on from there.
      const stored = listRunEvents(getDb(), threadId).map((item) => item.event as Event);
      expect(elapsed(stored)).toEqual(elapsed(paused.events));

      // The visitor takes a while to choose.
      await wait(500);
      const resumed = await sse(resumePath(threadId, "track-a"));

      expect(types(resumed.events)[0]).toBe("resuming");
      const times = elapsed(resumed.events) as number[];
      expect(times.every((ms) => Number.isInteger(ms))).toBe(true);
      expect(times).toEqual([...times].sort((a, b) => a - b));
      // Right where the paused stream ended: the resume's own checks take a few ms, never the
      // wait for the choice (500 ms) nor the paused stream's time again (150 ms or more).
      expect(times[0]).toBeGreaterThanOrEqual(pausedAt);
      expect(times[0]).toBeLessThan(pausedAt + 100);
    });

    it("sends no time on a resume when the run's earlier stream left none to go on from", async () => {
      // Paused by POST /api/analyze, which stores no stream.
      const posted = await request(app)
        .post(withRunToken("/api/analyze"))
        .send({ query: "ambiguous untimed" });
      expect(posted.body.status).toBe("interrupted");

      const resumed = await sse(resumePath(posted.body.threadId, "track-a"));

      expect(ofType(resumed.events, "complete")).toHaveLength(1);
      expect(resumed.events.filter((event) => "elapsedMs" in event)).toEqual([]);
    });

    it("sends no time on a stream refused before any run started", async () => {
      const { events } = await sse(withRunToken("/api/analyze/stream?query="));
      expect(types(events)).toEqual(["error", "done"]);
      expect(events.filter((event) => "elapsedMs" in event)).toEqual([]);
    });
  });

  describe("HEAD on the stream routes", () => {
    it("answers with the stream headers and starts or resumes no run", async () => {
      const threadId = await pausedThread();
      const scoutCalls = stub.calls.scout;
      const runCount = () => getDb().prepare("SELECT COUNT(*) FROM runs").pluck().get();
      const runsBefore = runCount();

      for (const path of [streamPath("plain head"), resumePath(threadId, "track-a")]) {
        const res = await request(app).head(path).timeout(2000);
        expect(res.status, path).toBe(200);
        expect(res.headers["content-type"]).toContain("text/event-stream");
      }
      await settle();

      expect(stub.calls.scout).toBe(scoutCalls);
      expect(stub.calls.engineer).toBe(0);
      expect(runCount()).toBe(runsBefore);
      expect(runStatus(threadId)).toBe("interrupted");
    });
  });
});
