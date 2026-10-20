/**
 * Route tests for /api/analyze*: the real Express routes and the real compiled graph, with the
 * nodes that call outside services replaced by stubs. The clarification node is the real one
 * (its Spotify lookup is stubbed), so pausing and resuming go through LangGraph's interrupt().
 *
 * The stub scout picks its path from the query:
 *   "cached …"     cache hit: reports `complete` through the writer and in its update
 *   "ambiguous …"  two candidates, so the run pauses for a choice
 *   "nomatch …"    Spotify found nothing
 *   "outage …"     Spotify could not be reached
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
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSonicAgentGraph } from "../../agent/graph.js";
import type { SonicAgentStateType } from "../../agent/state.js";
import { closeDatabase, getDb, initializeDatabase } from "../../store/database.js";
import { DEFAULT_RETENTION, pruneDatabase } from "../../store/retention.js";
import { getRun } from "../../store/runs.js";
import { createTestApp } from "../testApp.js";
import analyzeRouter, { RUN_DEADLINE_MS, setRunDeadlineForTests } from "./analyze.js";

type Hook = null | ((signal: AbortSignal | undefined) => Promise<void>);

const stub = vi.hoisted(() => ({
  calls: {
    scout: 0,
    engineer: 0,
    engineerDone: 0,
    historian: 0,
    composer: 0,
    details: 0,
  } as Record<string, number>,
  engineerStep: null as Hook,
  composerAfterComplete: null as Hook,
  detailsStep: null as null | (() => Promise<void>),
  detailsFail: false,
}));

vi.mock("../../sources/spotify.js", () => ({
  getTrackDetails: {
    invoke: async ({ trackId }: { trackId: string }) => {
      stub.calls.details++;
      await stub.detailsStep?.();
      if (stub.detailsFail) throw new Error("Spotify unavailable");
      return JSON.stringify({
        id: trackId,
        title: `Title ${trackId}`,
        artist: "Artist",
        artistIds: [],
        album: "Album",
        releaseDate: "1994",
        coverUrl: "",
        popularity: 50,
        duration: "3:38",
        durationMs: 218000,
        explicit: false,
        spotifyUrl: `https://open.spotify.com/track/${trackId}`,
        previewUrl: null,
      });
    },
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
      status(config, "scout", "searching");
      const query = state.songQuery;
      if (query.startsWith("cached")) {
        const trackData = { title: "cached", artist: "Artist" };
        config.writer?.({ type: "complete", data: trackData });
        return { trackData };
      }
      if (query.startsWith("nomatch")) return { error: "No tracks found" };
      if (query.startsWith("outage")) {
        return { error: "Error searching for tracks: 503 secret-upstream-detail" };
      }
      if (query.startsWith("odd")) return { error: "secret-odd-detail" };
      if (query.startsWith("ambiguous")) {
        const candidates = ["track-a", "track-b"].map((id) => ({
          id,
          title: `Title ${id}`,
          artist: "Artist",
          album: "Album",
          coverUrl: "",
          popularity: 40,
        }));
        config.writer?.({ type: "candidates", candidates, message: "pick one" });
        return { candidates };
      }
      return { spotifyData: { id: "track-only", title: "Title track-only", artist: "Artist" } };
    },
    engineerNode: async (_state: State, config: Config) => {
      stub.calls.engineer++;
      status(config, "engineer", "measuring");
      await stub.engineerStep?.(config.signal);
      stub.calls.engineerDone++;
      return {};
    },
    historianNode: async () => {
      stub.calls.historian++;
      return {};
    },
    composerNode: async (state: State, config: Config) => {
      stub.calls.composer++;
      const trackData = {
        title: state.songQuery.includes("fallback") ? "fallback" : "composed",
        artist: "Artist",
        spotify: state.spotifyData,
      };
      config.writer?.({ type: "complete", data: trackData });
      // Stands for the store write the real composer awaits after reporting the result.
      await stub.composerAfterComplete?.(config.signal);
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
const streamPath = (query: string) => `/api/analyze/stream?query=${encodeURIComponent(query)}`;
const resumePath = (threadId: string, trackId: string) =>
  `/api/analyze/stream/resume?threadId=${encodeURIComponent(threadId)}&selectedTrackId=${trackId}`;
const postResume = (threadId: string, selectedTrackId: string) =>
  request(app).post("/api/analyze/resume").send({ threadId, selectedTrackId });

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
    stub.engineerStep = null;
    stub.composerAfterComplete = null;
    stub.detailsStep = null;
    stub.detailsFail = false;
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
      expect(ofType(res.events, "complete")).toHaveLength(0);
      expect(runStatus(threadId)).toBe("interrupted");
    });

    it("POST interrupt: POST /api/analyze returns 200 with the threadId and the candidates", async () => {
      const res = await request(app).post("/api/analyze").send({ query: "ambiguous hurt" });

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

    it("uses the candidate's own data, with no invented duration, when the track lookup fails", async () => {
      stub.detailsFail = true;
      const threadId = await pausedThread();

      const { events } = await sse(resumePath(threadId, "track-a"));

      const [complete] = ofType(events, "complete");
      expect((complete.data as { spotify: unknown }).spotify).toMatchObject({
        id: "track-a",
        title: "Title track-a",
        duration: "",
        durationMs: 0,
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
      const warn = vi.spyOn(console, "warn");

      const client = open(streamPath("plain hurt"));
      await entered.promise;
      await vi.waitFor(() =>
        expect(ofType(parseEvents(client.body()), "complete")).toHaveLength(1),
      );
      const threadId = ofType(parseEvents(client.body()), "connected")[0].threadId as string;
      client.req.destroy();
      await vi.waitFor(() =>
        expect(warn).toHaveBeenCalledWith(expect.stringContaining("run aborted")),
      );
      gate.resolve();

      await vi.waitFor(() => expect(runStatus(threadId)).toBe("completed"));
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
      const res = await request(app).post("/api/analyze").send({ query });

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
      const warn = vi.spyOn(console, "warn");
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
          expect(warn).toHaveBeenCalledWith(expect.stringContaining("run aborted"));
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
          open("/api/analyze/resume", "POST", { threadId, selectedTrackId: "track-a" }),
      ],
    ])(
      "disconnect during the resume check (%s): no run, choice kept, claim released",
      async (_route, start) => {
        const threadId = await pausedThread();
        const warn = vi.spyOn(console, "warn");
        const check = holdNextCheckpointRead();

        const client = start(threadId);
        await check.reading;
        client.req.destroy();
        await vi.waitFor(() =>
          expect(warn).toHaveBeenCalledWith(expect.stringContaining("Client disconnected")),
        );
        check.release();
        await vi.waitFor(() =>
          expect(warn).toHaveBeenCalledWith(expect.stringContaining("Client left before")),
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
      await vi.advanceTimersByTimeAsync(40_000);
      const { events } = await pending;

      expect(ofType(events, "heartbeat").length).toBeGreaterThanOrEqual(2);
      expect(ofType(events, "complete")).toHaveLength(1);
    });

    it("sends the stream headers before the resume check finishes", async () => {
      const threadId = await pausedThread();
      const check = holdNextCheckpointRead();

      const client = open(resumePath(threadId, "track-a"));
      await check.reading;
      const response = await Promise.race([client.response, settle().then(() => null)]);
      expect(response?.headers["content-type"]).toBe("text/event-stream");
      expect(response?.headers["x-accel-buffering"]).toBe("no");

      check.release();
      await vi.waitFor(() => expect(parseEvents(client.body()).at(-1)?.type).toBe("done"));
    });
  });

  describe("run deadline", () => {
    it("aborts a run that passes the deadline and reports a timeout", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
      const started = deferred();
      stub.engineerStep = (signal) =>
        new Promise<void>((resolve) => {
          started.resolve();
          signal?.addEventListener("abort", () => resolve());
        });

      const pending = sse(streamPath("plain hurt"));
      await started.promise;
      await vi.advanceTimersByTimeAsync(RUN_DEADLINE_MS);
      const { events } = await pending;

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
      const post = (query: unknown) => request(app).post("/api/analyze").send({ query });
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
      expect((await request(app).post("/api/analyze").send({ query })).status).toBe(400);
      // A URL cannot carry a lone surrogate (it decodes to U+FFFD), so only POST sees one.
      if (!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(query)) {
        const stream = await sse(streamPath(query));
        expect(stream.events[0]).toMatchObject({ type: "error", code: "invalid_input" });
      }
      expect(stub.calls.scout).toBe(0);
    });

    it("accepts tabs and newlines inside a query, collapsed to one space", async () => {
      const res = await request(app).post("/api/analyze").send({ query: "Hurt\tJohnny\n\n Cash" });
      expect(res.status).toBe(200);
      expect(getRun(getDb(), res.body.threadId)?.query).toBe("Hurt Johnny Cash");

      const stream = await sse(streamPath("Hurt\tJohnny Cash"));
      expect(ofType(stream.events, "error")).toHaveLength(0);
      expect(ofType(stream.events, "complete")).toHaveLength(1);
    });

    it("counts characters, not UTF-16 units, and trims before counting", async () => {
      const emoji = await request(app)
        .post("/api/analyze")
        .send({ query: "😀".repeat(200) });
      expect(emoji.status).toBe(200);

      const padded = ` ${"a".repeat(200)} `;
      const res = await request(app).post("/api/analyze").send({ query: padded });
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
        const res = await sse(path);
        expect(res.status).toBe(200);
        expect(types(res.events)).toEqual(["error", "done"]);
        expect(res.events[0]).toMatchObject({ code: "invalid_input", error: expect.any(String) });
      }
      expect(stub.calls.scout).toBe(0);
    });
  });
});
