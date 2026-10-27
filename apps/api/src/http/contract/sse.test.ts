/**
 * Contract tests for the event streams: every message the analysis and factoid streams write is
 * one `data:` line holding an event of the contract's union (`AnalyzeStreamEvent`,
 * `FactoidStreamEvent`), with the run's id and the event's position in the stream (`seq`, from
 * 0, one per event; heartbeats carry none), and each stream ends with exactly one `done`.
 *
 * The app is the real one (createApp) with a scripted stub in place of the compiled graph, so
 * each path of a run can be driven on demand: cache hit, pause for a choice and resume,
 * fallback result, each failure and refusal, client disconnect, run deadline and heartbeat.
 * The stub also emits what the route must never pass on as it is: an invalid result (the
 * client gets a typed `error` in its place and the run is recorded as failed), and a malformed
 * progress event or a writer event a node may not send (dropped, and the run goes on). An
 * invalid event written by the route fails these tests.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AnalyzeStreamEvent,
  FactoidStreamEvent,
  type TrackAnalysisInput,
} from "@liner-notes/contract";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { DEFAULT_RATE_LIMIT, DEFAULT_SEARCH_RATE_LIMIT } from "../../config/settings.js";
import type { Llm } from "../../llm/invoke.js";
import { closeDatabase, getDb, initializeDatabase } from "../../store/database.js";
import { getRun } from "../../store/runs.js";
import { createApp } from "../app.js";
import analyzeRouter, { RUN_DEADLINE_MS, setRunDeadlineForTests } from "../routes/analyze.js";
import { createFactoidsRouter } from "../routes/factoids.js";
import { droppedEventCount } from "../sse.js";
import { type CapturedLogs, captureLogsForTests } from "../../logger.js";

// =============================================================================
// Stub graph
// =============================================================================

type Chunk = [mode: "custom" | "updates", data: unknown];

const graph = vi.hoisted(() => ({
  /** Threads the stub has seen: paused at a choice (with its candidates) or past it. */
  threads: new Map<string, { query: string; choice: Array<{ id: string }> | null }>(),
  /** Per query prefix (or "resume"), the chunks a run yields; may wait on the run's signal. */
  scripts: {} as Record<
    string,
    (signal: AbortSignal, threadId: string, resume?: string) => AsyncGenerator<Chunk>
  >,
}));

vi.mock("../../agent/graph.js", () => ({
  createSonicAgentGraph: () => ({
    async *stream(
      input: { songQuery?: string; resume?: { trackId: string } },
      config: { configurable: { thread_id: string }; signal: AbortSignal },
    ) {
      const threadId = config.configurable.thread_id;
      if (input.resume !== undefined) {
        // The route resumes with the picked track and how it was picked.
        yield* graph.scripts.resume(config.signal, threadId, input.resume.trackId);
        return;
      }
      const query = input.songQuery ?? "";
      graph.threads.set(threadId, { query, choice: null });
      const prefix = Object.keys(graph.scripts).find((key) => query.startsWith(key)) ?? "plain";
      yield* graph.scripts[prefix](config.signal, threadId);
    },
    async getState(config: { configurable: { thread_id: string } }) {
      const thread = graph.threads.get(config.configurable.thread_id);
      return {
        config: { configurable: thread ? { checkpoint_id: "cp-1" } : {} },
        tasks: thread?.choice
          ? [{ name: "clarification", interrupts: [{ value: { candidates: thread.choice } }] }]
          : [],
        values: { songQuery: thread?.query },
      };
    },
  }),
}));

const payload = (name: string): TrackAnalysisInput =>
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "../../../../../packages/contract/fixtures/api-payloads", name),
      "utf8",
    ),
  );
const COMPOSED = payload("composed-measured.json");
const FALLBACK = payload("fallback-no-audio.json");
const CANDIDATES = ["track-a", "track-b"].map((id) => ({
  id,
  title: `Title ${id}`,
  artist: "Artist",
  album: "Album",
  coverUrl: "",
}));

const status = (node: string, message: unknown, extra: Record<string, unknown> = {}): Chunk => [
  "custom",
  { type: "status", node, message, timestamp: new Date().toISOString(), ...extra },
];
/** How the composer (and the scout on a cache hit) report a result: writer and state update. */
const result = (node: string, data: unknown): Chunk[] => [
  ["custom", { type: "complete", data }],
  ["updates", { [node]: { trackData: data } }],
];
const untilAborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

/** Holds the `hold` scripts until the test releases them. */
let hold: { entered: () => void; gate: Promise<void> } | null = null;
function holdNextRun() {
  let entered!: () => void;
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  hold = { entered, gate };
  return { reached, release };
}

graph.scripts = {
  async *cached() {
    yield status("scout", "Serving the analysis stored for this track", { code: "NET-200" });
    yield* result("scout", COMPOSED);
  },
  async *plain() {
    yield status("scout", "Found the track on Spotify", { code: "SPOTIFY-FOUND" });
    yield status("engineer", "Measuring tempo and key from the preview clip", {
      code: "AUDIO-INIT",
    });
    yield* result("composer", COMPOSED);
  },
  async *fallback() {
    yield status("scout", "Found the track on Spotify", { code: "SPOTIFY-FOUND" });
    yield status("composer", "The model request failed; showing source data only", {
      code: "SYS-WARN",
    });
    yield* result("composer", FALLBACK);
  },
  async *ambiguous(_signal, threadId) {
    yield status("scout", "Searching", { code: "SPOTIFY-SEARCH" });
    // The scout's own `candidates` event: the route sends the candidates once, in `interrupt`.
    yield ["custom", { type: "candidates", candidates: CANDIDATES, message: "pick one" }];
    const thread = graph.threads.get(threadId);
    if (thread) thread.choice = CANDIDATES;
    yield ["updates", { __interrupt__: [{ value: { candidates: CANDIDATES } }] }];
  },
  async *resume(signal, threadId, selected) {
    const thread = graph.threads.get(threadId);
    if (thread) thread.choice = null;
    yield status("clarification", `Selected: ${selected}`, { code: "SPOTIFY-FOUND" });
    if (selected === "track-b") {
      // The choice is applied; the run then stalls until it is aborted.
      await untilAborted(signal);
      return;
    }
    yield* result("composer", COMPOSED);
  },
  async *nomatch() {
    yield ["updates", { scout: { error: "No tracks found", scoutFailure: { kind: "no_match" } } }];
  },
  async *outage() {
    yield [
      "updates",
      {
        scout: {
          error: "Spotify search failed: spotify: HTTP 503 — secret-upstream-detail",
          scoutFailure: { kind: "upstream_unavailable" },
        },
      },
    ];
  },
  async *odd() {
    yield ["updates", { scout: { error: "secret-odd-detail" } }];
  },
  async *throws() {
    yield status("scout", "Searching", { code: "SPOTIFY-SEARCH" });
    throw new Error("secret-graph-failure");
  },
  async *stall(signal) {
    yield status("engineer", "Measuring tempo and key from the preview clip", {
      code: "AUDIO-INIT",
    });
    await untilAborted(signal);
  },
  async *slow() {
    yield status("engineer", "Measuring tempo and key from the preview clip", {
      code: "AUDIO-INIT",
    });
    const waited = new Promise((resolve) => setTimeout(resolve, 40_000));
    hold?.entered();
    await waited;
    yield* result("composer", COMPOSED);
  },
  /** Ignores the abort: keeps reporting progress and finally a result after the client left. */
  async *deaf() {
    yield status("engineer", "Measuring tempo and key from the preview clip", {
      code: "AUDIO-INIT",
    });
    hold?.entered();
    await hold?.gate;
    yield status("engineer", "Measured from the preview", { code: "AUDIO-COMPLETE" });
    yield* result("composer", COMPOSED);
  },
  // Payloads the route must not write as they are.
  async *badstatus() {
    yield status("engineer", 42);
    yield* result("composer", COMPOSED);
  },
  async *badresult() {
    yield status("scout", "Found the track on Spotify", { code: "SPOTIFY-FOUND" });
    yield* result("composer", { title: "No id, no artist" });
  },
  async *mystery() {
    yield ["custom", { type: "mystery", detail: "a writer event the contract does not know" }];
    yield* result("composer", COMPOSED);
  },
  /** A node writes one of the stream's own events (`writer <type>`), then the run completes. */
  async *writer(_signal, threadId) {
    const type = graph.threads.get(threadId)?.query.split(" ")[1];
    yield ["custom", { type, threadId, code: "failed", error: "from a node", candidates: [] }];
    yield status("composer", "Composing", { code: "LLM-RESPONSE" });
    yield* result("composer", COMPOSED);
  },
};

// =============================================================================
// Stub model layer (factoid stream)
// =============================================================================

const model = {
  invoke: vi.fn(),
  endRun: vi.fn(),
  callsForRun: () => 0,
};
const factoidAnswer = (title: string) => ({
  output: {
    factoids: [
      {
        title,
        text: `Content of ${title}.`,
        type: "production",
        entities: [{ text: "Roland Juno-106", type: "synth" }],
        evidenceIds: [],
        scope: "recording",
      },
    ],
  },
  deployment: "stub-main",
});

// =============================================================================
// Reading a stream
// =============================================================================

type Schema = typeof AnalyzeStreamEvent | typeof FactoidStreamEvent;
type Message = { type: string; runId?: unknown; seq?: unknown; [field: string]: unknown };

/**
 * Every message of a stream body, checked against the contract: each block is one `data:` line
 * with a JSON event that `schema` accepts. Returns the events as written.
 */
function contractEvents(body: string, schema: Schema): Message[] {
  const blocks = body.split("\n\n");
  expect(blocks.pop(), "the body ends with a blank line").toBe("");
  return blocks.map((block) => {
    expect(block, "one data line per message").toMatch(/^data: [^\n]+$/);
    const event = JSON.parse(block.slice("data: ".length)) as Message;
    const parsed = (schema as z.ZodType).safeParse(event);
    expect(parsed.error?.issues ?? [], `${event.type} event fits the union`).toEqual([]);
    return event;
  });
}

/**
 * The stream-wide rules: one run id, `seq` 0, 1, 2… on every event but heartbeats (which carry
 * none), and exactly one `done`, last. `ended: false` is a stream cut off by the client.
 */
function expectWellFormed(events: Message[], { ended = true } = {}) {
  const runIds = new Set(events.map((event) => event.runId));
  expect(runIds.size).toBe(1);
  const numbered = events.filter((event) => event.type !== "heartbeat");
  expect(numbered.map((event) => event.seq)).toEqual(numbered.map((_, index) => index));
  for (const heartbeat of events.filter((event) => event.type === "heartbeat")) {
    expect(heartbeat).not.toHaveProperty("seq");
  }
  const done = events.filter((event) => event.type === "done");
  if (ended) {
    expect(done).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
  } else {
    expect(done).toHaveLength(0);
  }
}

/** An analysis stream: well formed, with exactly one outcome (complete, interrupt or error). */
function expectAnalysis(body: string, options?: { ended?: boolean }) {
  const events = contractEvents(body, AnalyzeStreamEvent);
  expectWellFormed(events, options);
  const outcomes = events.filter((event) =>
    ["complete", "interrupt", "error"].includes(event.type),
  );
  if (options?.ended !== false) expect(outcomes).toHaveLength(1);
  else expect(outcomes.length).toBeLessThanOrEqual(1);
  return events;
}

const types = (events: Message[]) =>
  events.filter((event) => event.type !== "heartbeat").map((event) => event.type);

// =============================================================================
// App and requests
// =============================================================================

const settings = (max = 10_000) => ({
  corsOrigins: [],
  trustProxy: 0,
  rateLimit: { ...DEFAULT_RATE_LIMIT, max },
  globalRateLimit: { ...DEFAULT_RATE_LIMIT, max },
  searchRateLimit: DEFAULT_SEARCH_RATE_LIMIT,
});
const factoidsRouter = createFactoidsRouter({ llm: model as unknown as Llm });
const app = createApp({ http: settings(), routers: [analyzeRouter, factoidsRouter] });

async function sse(path: string, target = app) {
  const res = await request(target)
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
  expect(res.status).toBe(200);
  expect(res.headers["content-type"]).toContain("text/event-stream");
  return res.body as string;
}

const streamPath = (query: string) => `/api/analyze/stream?query=${encodeURIComponent(query)}`;
const resumePath = (threadId: string, trackId: string) =>
  `/api/analyze/stream/resume?threadId=${encodeURIComponent(threadId)}&selectedTrackId=${trackId}`;
const factoidPath = (query: Record<string, string>) =>
  `/api/factoids/decrypt/stream?${new URLSearchParams(query)}`;
const runStatus = (threadId: string) => getRun(getDb(), threadId)?.status;

let server: http.Server;
let port: number;

/**
 * Opens a stream on the real server and records, per response, every write the server makes
 * and whether the response was already closed then.
 */
function open(path: string) {
  let body = "";
  const req = http.request({ host: "127.0.0.1", port, path }, (res) => {
    res.setEncoding("utf8");
    res.on("data", (chunk: string) => {
      body += chunk;
    });
    res.on("error", () => {});
  });
  req.on("error", () => {});
  req.end();
  return { req, body: () => body };
}

/** Writes made by server responses, and whether each came after the response closed. */
function recordWrites() {
  const closed = new WeakSet<http.ServerResponse>();
  const watched = new WeakSet<http.ServerResponse>();
  const writes: Array<{ chunk: string; afterClose: boolean }> = [];
  const original = http.ServerResponse.prototype.write;
  vi.spyOn(http.ServerResponse.prototype, "write").mockImplementation(function (
    this: http.ServerResponse,
    ...args: Parameters<typeof original>
  ) {
    if (!watched.has(this)) {
      watched.add(this);
      this.on("close", () => closed.add(this));
    }
    writes.push({ chunk: String(args[0]), afterClose: closed.has(this) });
    return original.apply(this, args);
  } as typeof original);
  return writes;
}

/** Starts an ambiguous analysis and returns the paused thread. */
async function pausedThread(): Promise<string> {
  const events = expectAnalysis(await sse(streamPath("ambiguous hurt")));
  const interrupt = events.find((event) => event.type === "interrupt");
  return interrupt?.threadId as string;
}

// =============================================================================
// Tests
// =============================================================================

describe("event streams follow the contract", () => {
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "sse-contract-"));
    initializeDatabase(join(dir, "test.db"));
    server = app.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    hold = null;
    model.invoke.mockReset();
    model.endRun.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    logs = captureLogsForTests();
  });
  let logs: CapturedLogs;
  /** The messages logged at `level`. */
  const logged = (level: string) =>
    logs
      .entries()
      .filter((entry) => entry.level === level)
      .map((entry) => String(entry.msg));
  let restoreDeadline: (() => void) | null = null;
  afterEach(() => {
    logs.restore();
    restoreDeadline?.();
    restoreDeadline = null;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("GET /api/analyze/stream", () => {
    it.each([
      ["a cache hit", "cached hurt", COMPOSED],
      ["a composed result", "plain hurt", COMPOSED],
      ["a fallback result", "fallback hurt", FALLBACK],
    ])("%s: connected, progress, one complete, done", async (_path, query, data) => {
      const events = expectAnalysis(await sse(streamPath(query)));

      expect(types(events)[0]).toBe("connected");
      expect(types(events).slice(-2)).toEqual(["complete", "done"]);
      expect(types(events)).toContain("status");
      const [connected] = events;
      expect(connected.runId).toBe(connected.threadId);
      expect(events.find((event) => event.type === "complete")?.data).toEqual(data);
      expect(runStatus(connected.threadId as string)).toBe("completed");
    });

    it("pauses with one interrupt that carries the candidates, and no candidates event", async () => {
      const events = expectAnalysis(await sse(streamPath("ambiguous hurt")));

      expect(types(events)).toEqual(["connected", "status", "interrupt", "done"]);
      const interrupt = events.find((event) => event.type === "interrupt");
      expect(interrupt).toMatchObject({ reason: "disambiguation", candidates: CANDIDATES });
      expect(interrupt?.runId).toBe(interrupt?.threadId);
      expect(runStatus(interrupt?.threadId as string)).toBe("interrupted");
    });

    it.each([
      ["no_match", "nomatch hurt"],
      ["upstream_unavailable", "outage hurt"],
      ["failed", "odd hurt"],
      ["failed", "throws hurt"],
    ])("reports %s as an error with that code, then done (%s)", async (code, query) => {
      const body = await sse(streamPath(query));
      const events = expectAnalysis(body);

      expect(types(events).slice(-2)).toEqual(["error", "done"]);
      expect(events.find((event) => event.type === "error")).toMatchObject({
        code,
        error: expect.any(String),
      });
      expect(body).not.toContain("secret");
    });

    it("reports a run past its deadline as timeout, then done", async () => {
      restoreDeadline = setRunDeadlineForTests(100);

      const events = expectAnalysis(await sse(streamPath("stall hurt")));

      expect(types(events)).toEqual(["connected", "status", "error", "done"]);
      expect(events.find((event) => event.type === "error")?.code).toBe("timeout");
    });

    it("reports invalid input as an error with a run id of its own, then done", async () => {
      for (const path of ["/api/analyze/stream", streamPath("x".repeat(201))]) {
        const events = expectAnalysis(await sse(path));
        expect(types(events)).toEqual(["error", "done"]);
        expect(events[0].code).toBe("invalid_input");
      }
    });

    it("sends heartbeats without seq while a step takes 40 s", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const run = holdNextRun();

      const pending = sse(streamPath("slow hurt"));
      await run.reached;
      await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS / 4);
      const events = expectAnalysis(await pending);

      expect(events.filter((event) => event.type === "heartbeat").length).toBeGreaterThanOrEqual(2);
      expect(types(events).slice(-2)).toEqual(["complete", "done"]);
    });

    it("writes nothing once the client has gone, although the run goes on to a result", async () => {
      const writes = recordWrites();
      const run = holdNextRun();

      const client = open(streamPath("deaf hurt"));
      await run.reached;
      await vi.waitFor(() => expect(client.body()).toContain('"type":"status"'));
      const threadId = (JSON.parse(client.body().split("\n\n")[0].slice(6)) as Message)
        .threadId as string;
      client.req.destroy();
      await vi.waitFor(() =>
        expect(logged("warn")).toContainEqual(expect.stringContaining("Client disconnected")),
      );
      run.release();
      await vi.waitFor(() => expect(runStatus(threadId)).toBe("completed"));

      expect(writes.filter((write) => write.afterClose)).toEqual([]);
      const events = expectAnalysis(client.body(), { ended: false });
      expect(types(events)).toEqual(["connected", "status"]);
    });

    it("drops a malformed progress event, counts it and goes on to the result", async () => {
      const dropped = droppedEventCount();

      const body = await sse(streamPath("badstatus hurt"));
      const events = expectAnalysis(body);

      expect(types(events)).toEqual(["connected", "complete", "done"]);
      expect(events.find((event) => event.type === "complete")?.data).toEqual(COMPOSED);
      expect(droppedEventCount()).toBe(dropped + 1);
      expect(logs.entries()).toContainEqual(
        expect.objectContaining({
          level: "error",
          msg: expect.stringContaining("status event dropped"),
          detail: expect.anything(),
        }),
      );
      expect(runStatus(events[0].threadId as string)).toBe("completed");
    });

    it("never writes a result that fails the contract: an error instead, and the run failed", async () => {
      const events = expectAnalysis(await sse(streamPath("badresult hurt")));

      expect(types(events)).toEqual(["connected", "status", "error", "done"]);
      expect(events[2].code).toBe("failed");
      await vi.waitFor(() => expect(runStatus(events[0].threadId as string)).toBe("failed"));
    });

    it("drops a writer event the contract does not know and goes on to the result", async () => {
      const events = expectAnalysis(await sse(streamPath("mystery hurt")));

      expect(types(events)).toEqual(["connected", "complete", "done"]);
    });

    it.each(["done", "error", "heartbeat", "connected", "resuming", "interrupt"])(
      "drops a node's %s event: it neither ends the stream nor takes a seq",
      async (type) => {
        const dropped = droppedEventCount();

        const events = expectAnalysis(await sse(streamPath(`writer ${type}`)));

        expect(types(events)).toEqual(["connected", "status", "complete", "done"]);
        expect(events.filter((event) => event.type === "heartbeat")).toEqual([]);
        expect(droppedEventCount()).toBe(dropped + 1);
        expect(runStatus(events[0].threadId as string)).toBe("completed");
      },
    );

    it("ends with done and no error when the route fails after the result was sent", async () => {
      // The run's bookkeeping throws once the result is out: the stream still ends cleanly, and
      // nothing follows the outcome but done.
      logs.restore();
      logs = captureLogsForTests({
        onLine: (entry) => {
          if (String(entry.msg).includes("recorded completed")) {
            throw new Error("secret-bookkeeping");
          }
        },
      });

      const body = await sse(streamPath("plain hurt"));
      const events = expectAnalysis(body);

      expect(types(events).slice(-2)).toEqual(["complete", "done"]);
      expect(body).not.toContain("secret");
      expect(logs.entries()).toContainEqual(
        expect.objectContaining({
          level: "error",
          msg: "Stream route failed",
          err: expect.objectContaining({ message: "secret-bookkeeping" }),
        }),
      );
    });

    it("a refusal by the rate limit is a typed error, then done", async () => {
      const limited = createApp({ http: settings(1), routers: [analyzeRouter, factoidsRouter] });
      await sse(streamPath("plain one"), limited);

      for (const path of [
        streamPath("plain two"),
        resumePath("thread-1", "track-a"),
        factoidPath({ trackTitle: "Hurt" }),
      ]) {
        const schema = path.includes("factoids") ? FactoidStreamEvent : AnalyzeStreamEvent;
        const events = contractEvents(await sse(path, limited), schema);
        expectWellFormed(events);
        expect(types(events)).toEqual(["error", "done"]);
        expect(events[0].code).toBe("rate_limited");
        // A refused resume carries the run id of the thread it names.
        if (path.includes("/resume")) expect(events[0].runId).toBe("thread-1");
      }
    });
  });

  describe("GET /api/analyze/stream/resume", () => {
    it("resumes the paused run under its run id: resuming, progress, one complete, done", async () => {
      const threadId = await pausedThread();

      const events = expectAnalysis(await sse(resumePath(threadId, "track-a")));

      expect(types(events)).toEqual(["resuming", "status", "complete", "done"]);
      expect(events[0].runId).toBe(threadId);
      expect(runStatus(threadId)).toBe("completed");
    });

    it.each([
      ["invalid_input", () => "/api/analyze/stream/resume?threadId=a%2Fb&selectedTrackId=x"],
      ["choice_expired", () => resumePath("unknown-thread", "track-a")],
      ["invalid_selection", async () => resumePath(await pausedThread(), "track-zzz")],
      [
        "not_waiting",
        async () => {
          const threadId = await pausedThread();
          expectAnalysis(await sse(resumePath(threadId, "track-a")));
          return resumePath(threadId, "track-b");
        },
      ],
    ])("refuses with %s as a typed error, then done", async (code, path) => {
      const target = await path();
      const events = expectAnalysis(await sse(target));

      expect(types(events)).toEqual(["error", "done"]);
      expect(events[0].code).toBe(code);
      const threadId = new URL(target, "http://x").searchParams.get("threadId") ?? "";
      if (code !== "invalid_input") expect(events[0].runId).toBe(threadId);
    });

    it("refuses a second resume of a running thread with resume_in_progress", async () => {
      const threadId = await pausedThread();
      const first = open(resumePath(threadId, "track-b"));
      await vi.waitFor(() => expect(first.body()).toContain('"type":"status"'));

      const events = expectAnalysis(await sse(resumePath(threadId, "track-a")));
      first.req.destroy();

      expect(types(events)).toEqual(["error", "done"]);
      expect(events[0]).toMatchObject({ code: "resume_in_progress", runId: threadId });
      await vi.waitFor(() => expect(runStatus(threadId)).toBe("cancelled"));
    });

    it("a run cancelled after the choice is refused later with run_interrupted", async () => {
      const writes = recordWrites();
      const threadId = await pausedThread();
      const client = open(resumePath(threadId, "track-b"));
      await vi.waitFor(() => expect(client.body()).toContain('"type":"status"'));
      client.req.destroy();
      await vi.waitFor(() => expect(runStatus(threadId)).toBe("cancelled"));

      expect(writes.filter((write) => write.afterClose)).toEqual([]);
      expect(types(expectAnalysis(client.body(), { ended: false }))).toEqual([
        "resuming",
        "status",
      ]);
      const events = expectAnalysis(await sse(resumePath(threadId, "track-a")));
      expect(types(events)).toEqual(["error", "done"]);
      expect(events[0].code).toBe("run_interrupted");
    });
  });

  describe("GET /api/factoids/decrypt/stream", () => {
    const expectFactoids = (body: string, options?: { ended?: boolean }) => {
      const events = contractEvents(body, FactoidStreamEvent);
      expectWellFormed(events, options);
      return events;
    };

    it("connected, one event per factoid or failure, done", async () => {
      model.invoke
        .mockResolvedValueOnce(factoidAnswer("First"))
        .mockRejectedValueOnce(new Error("secret-model-failure"))
        .mockResolvedValueOnce({ output: { factoids: [] }, deployment: "stub-main" });

      const body = await sse(factoidPath({ trackTitle: "Hurt", trackArtist: "NIN" }));
      const events = expectFactoids(body);

      expect(types(events)).toEqual(["connected", "factoid", "error", "done"]);
      expect(events[2]).toMatchObject({ code: "failed", index: 1 });
      expect(body).not.toContain("secret");
    });

    it("invalid input is a typed error, then done", async () => {
      const events = expectFactoids(await sse(factoidPath({ trackTitle: "" })));

      expect(types(events)).toEqual(["error", "done"]);
      expect(events[0].code).toBe("invalid_input");
      expect(model.invoke).not.toHaveBeenCalled();
    });

    it("a factoid that fails the contract is not sent: an error for its index instead", async () => {
      model.invoke
        .mockResolvedValueOnce(factoidAnswer("First"))
        .mockResolvedValueOnce({
          output: { factoids: [{ title: "Bad", text: "x", type: "lyrics", entities: [] }] },
          deployment: "stub-main",
        })
        .mockResolvedValueOnce(factoidAnswer("Third"));

      const events = expectFactoids(await sse(factoidPath({ trackTitle: "Hurt" })));

      expect(types(events)).toEqual(["connected", "factoid", "error", "factoid", "done"]);
      expect(events[2]).toMatchObject({ code: "failed", index: 1 });
    });

    it("sends heartbeats without seq while the calls take 100 s", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      let entered!: () => void;
      const calling = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let call = 0;
      model.invoke.mockImplementation(() => {
        entered();
        const answer = factoidAnswer(`Slow ${++call}`);
        return new Promise((resolve) => setTimeout(() => resolve(answer), 100_000));
      });

      const pending = sse(factoidPath({ trackTitle: "Hurt" }));
      await calling;
      // Three calls at once, each taking 100 s.
      for (let step = 0; step < 13; step++) await vi.advanceTimersByTimeAsync(10_000);
      const events = expectFactoids(await pending);

      expect(events.filter((event) => event.type === "heartbeat").length).toBeGreaterThanOrEqual(6);
      expect(types(events)).toEqual(["connected", "factoid", "factoid", "factoid", "done"]);
    });

    it("writes nothing once the client has gone", async () => {
      const writes = recordWrites();
      let entered!: () => void;
      const calling = new Promise<void>((resolve) => {
        entered = resolve;
      });
      model.invoke.mockImplementation(() => {
        entered();
        return new Promise(() => {});
      });

      const client = open(factoidPath({ trackTitle: "Hurt" }));
      await calling;
      await vi.waitFor(() => expect(client.body()).toContain('"type":"connected"'));
      client.req.destroy();
      await vi.waitFor(() => expect(model.endRun).toHaveBeenCalled());

      expect(writes.filter((write) => write.afterClose)).toEqual([]);
      expect(types(expectFactoids(client.body(), { ended: false }))).toEqual(["connected"]);
    });
  });
});
