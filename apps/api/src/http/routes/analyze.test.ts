/**
 * Route tests for /api/analyze*: the real Express routes and the real compiled graph, with the
 * nodes that call outside services replaced by stubs. The clarification node is the real one
 * (its Spotify lookup is stubbed), so pausing and resuming go through LangGraph's interrupt().
 *
 * The stub scout picks its path from the query:
 *   "cached …"     cache hit: reports `complete` through the writer and in its update
 *   "ambiguous …"  two candidates, so the run pauses for a choice
 *   anything else  one match; the composer then reports `complete` both ways, and a query
 *                  containing "fallback" takes the composer's model-unavailable path
 */

import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SonicAgentStateType } from "../../agent/state.js";
import { closeDatabase, getDb, initializeDatabase } from "../../store/database.js";
import { DEFAULT_RETENTION, pruneDatabase } from "../../store/retention.js";
import { getRun } from "../../store/runs.js";
import { createTestApp } from "../testApp.js";
import analyzeRouter from "./analyze.js";

type NodeName = "scout" | "engineer" | "historian" | "composer";

const stub = vi.hoisted(() => ({
  calls: { scout: 0, engineer: 0, historian: 0, composer: 0 } as Record<string, number>,
  /** Awaited by the engineer node; lets a test hold a run mid-pipeline. */
  engineerStep: null as null | ((signal: AbortSignal | undefined) => Promise<void>),
}));

vi.mock("../../sources/spotify.js", () => ({
  getTrackDetails: {
    invoke: async ({ trackId }: { trackId: string }) =>
      JSON.stringify({
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
      }),
  },
}));

vi.mock("../../agent/nodes/index.js", async () => {
  const { clarificationNode } = await vi.importActual<
    typeof import("../../agent/nodes/clarificationNode.js")
  >("../../agent/nodes/clarificationNode.js");

  type State = SonicAgentStateType;
  type Config = LangGraphRunnableConfig;
  const track = (title: string) => ({ title, artist: "Artist", source: "stub" });
  const spotify = (id: string) => ({ id, title: `Title ${id}`, artist: "Artist" });
  const status = (config: Config, node: string, message: string) =>
    config.writer?.({ type: "status", node, message, timestamp: new Date().toISOString() });

  return {
    clarificationNode,
    scoutNode: async (state: State, config: Config) => {
      stub.calls.scout++;
      status(config, "scout", "searching");
      if (state.songQuery.startsWith("cached")) {
        const trackData = track("cached");
        config.writer?.({ type: "complete", data: trackData });
        return { trackData };
      }
      if (state.songQuery.startsWith("ambiguous")) {
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
      return { spotifyData: spotify("track-only") };
    },
    engineerNode: async (_state: State, config: Config) => {
      stub.calls.engineer++;
      status(config, "engineer", "measuring");
      await stub.engineerStep?.(config.signal);
      return {};
    },
    historianNode: async () => {
      stub.calls.historian++;
      return {};
    },
    composerNode: async (state: State, config: Config) => {
      stub.calls.composer++;
      const trackData = track(state.songQuery.includes("fallback") ? "fallback" : "composed");
      config.writer?.({ type: "complete", data: trackData });
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
    .split("\n\n")
    .flatMap((block) => block.split("\n").filter((line) => line.startsWith("data: ")))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Event);
}

const app = createTestApp(analyzeRouter);

/** GETs an event stream and returns its status, headers and parsed messages once it ends. */
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
  return { status: res.status, headers: res.headers, events: parseEvents(res.body as string) };
}

const ofType = (events: Event[], type: string) => events.filter((event) => event.type === type);
const streamPath = (query: string) => `/api/analyze/stream?query=${encodeURIComponent(query)}`;
const resumePath = (threadId: string, trackId: string) =>
  `/api/analyze/stream/resume?threadId=${encodeURIComponent(threadId)}&selectedTrackId=${trackId}`;

/** Starts an ambiguous analysis and returns the thread it paused. */
async function pausedThread(): Promise<string> {
  const { events } = await sse(streamPath("ambiguous hurt"));
  const [interrupt] = ofType(events, "interrupt");
  expect(interrupt?.threadId).toEqual(expect.any(String));
  return interrupt.threadId as string;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// =============================================================================
// Tests
// =============================================================================

describe("analyze routes", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "analyze-routes-"));
    initializeDatabase(join(dir, "test.db"));
  });
  afterAll(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    for (const node of Object.keys(stub.calls)) stub.calls[node as NodeName] = 0;
    stub.engineerStep = null;
  });
  afterEach(() => {
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
      expect(getRun(getDb(), threadId)?.status).toBe("interrupted");
    });

    it("POST interrupt: POST /api/analyze returns 200 with the threadId and the candidates", async () => {
      const res = await request(app).post("/api/analyze").send({ query: "ambiguous hurt" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ status: "interrupted", threadId: expect.any(String) });
      expect(res.body.interrupt.candidates.map((c: { id: string }) => c.id)).toEqual([
        "track-a",
        "track-b",
      ]);

      const resumed = await request(app)
        .post("/api/analyze/resume")
        .send({ threadId: res.body.threadId, selectedTrackId: "track-b" });
      expect(resumed.status).toBe(200);
      expect(resumed.body).toMatchObject({ status: "complete", data: { title: "composed" } });
      expect(getRun(getDb(), res.body.threadId)?.status).toBe("completed");
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
      expect(getRun(getDb(), threadId)?.status).toBe("completed");
    });

    it("sends one complete after a resume", async () => {
      const threadId = await pausedThread();

      const { events } = await sse(resumePath(threadId, "track-a"));

      expect(ofType(events, "complete")).toHaveLength(1);
      expect(stub.calls).toMatchObject({ engineer: 1, historian: 1, composer: 1 });
    });
  });

  describe("concurrent resume", () => {
    it("refuses a second resume of the same thread on the stream, and every node runs once", async () => {
      const threadId = await pausedThread();
      const gate = deferred();
      const started = deferred();
      stub.engineerStep = async () => {
        started.resolve();
        await gate.promise;
      };

      const first = sse(resumePath(threadId, "track-a"));
      await started.promise;
      const second = sse(resumePath(threadId, "track-b"));
      // Without the guard the second resume waits on the gate too, so release it either way.
      await Promise.race([second, new Promise((r) => setTimeout(r, 500))]);
      gate.resolve();
      const [firstRes, secondRes] = await Promise.all([first, second]);

      expect(secondRes.status).toBe(200);
      expect(secondRes.events).toContainEqual(
        expect.objectContaining({
          type: "error",
          code: "resume_in_progress",
          error: expect.any(String),
        }),
      );
      expect(ofType(secondRes.events, "complete")).toHaveLength(0);
      expect(secondRes.events.at(-1)?.type).toBe("done");
      expect(ofType(firstRes.events, "complete")).toHaveLength(1);
      expect(stub.calls).toMatchObject({ engineer: 1, historian: 1, composer: 1 });
    });

    it("concurrent resume over POST gets 409", async () => {
      const threadId = await pausedThread();
      const gate = deferred();
      const started = deferred();
      stub.engineerStep = async () => {
        started.resolve();
        await gate.promise;
      };

      const first = request(app)
        .post("/api/analyze/resume")
        .send({ threadId, selectedTrackId: "track-a" })
        .then((res) => res);
      await started.promise;
      const second = request(app)
        .post("/api/analyze/resume")
        .send({ threadId, selectedTrackId: "track-b" })
        .then((res) => res);
      await Promise.race([second, new Promise((r) => setTimeout(r, 500))]);
      gate.resolve();
      const [firstRes, secondRes] = await Promise.all([first, second]);

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
      expect(res.events.map((event) => event.type)).toEqual(["error", "done"]);
      expect(res.events[0]).toMatchObject({ code: "choice_expired", error: expect.any(String) });

      const post = await request(app)
        .post("/api/analyze/resume")
        .send({ threadId: "nope", selectedTrackId: "x" });
      expect(post.status).toBe(404);
      expect(post.body.code).toBe("choice_expired");
      expect(stub.calls.engineer).toBe(0);
    });

    it("a finished thread is not waiting: the stream reports not_waiting; POST returns 404", async () => {
      const threadId = await pausedThread();
      await sse(resumePath(threadId, "track-a"));

      const again = await sse(resumePath(threadId, "track-b"));
      expect(again.events.map((event) => event.type)).toEqual(["error", "done"]);
      expect(again.events[0].code).toBe("not_waiting");

      const post = await request(app)
        .post("/api/analyze/resume")
        .send({ threadId, selectedTrackId: "track-b" });
      expect(post.status).toBe(404);
      expect(post.body.code).toBe("not_waiting");
      expect(stub.calls.composer).toBe(1);
    });

    it("a track that was not offered is refused and the choice stays open", async () => {
      const threadId = await pausedThread();

      const res = await sse(resumePath(threadId, "track-zzz"));
      expect(res.events[0]).toMatchObject({ type: "error", code: "invalid_selection" });
      const post = await request(app)
        .post("/api/analyze/resume")
        .send({ threadId, selectedTrackId: "track-zzz" });
      expect(post.status).toBe(400);

      const ok = await sse(resumePath(threadId, "track-a"));
      expect(ofType(ok.events, "complete")).toHaveLength(1);
    });

    it("expired choice: a paused thread pruned by retention reports choice_expired", async () => {
      const threadId = await pausedThread();
      // Past the run retention an open run counts as abandoned, so its thread is pruned.
      pruneDatabase(getDb(), DEFAULT_RETENTION, Date.now() + 31 * DAY);

      const res = await sse(resumePath(threadId, "track-a"));
      expect(res.events.map((event) => event.type)).toEqual(["error", "done"]);
      expect(res.events[0]).toMatchObject({ code: "choice_expired" });

      const post = await request(app)
        .post("/api/analyze/resume")
        .send({ threadId, selectedTrackId: "track-a" });
      expect(post.status).toBe(404);
      expect(post.body.code).toBe("choice_expired");
      expect(stub.calls.engineer).toBe(0);
    });
  });

  describe("retention", () => {
    it("keeps a paused thread past the checkpoint retention, and it can be resumed", async () => {
      const threadId = await pausedThread();

      pruneDatabase(getDb(), DEFAULT_RETENTION, Date.now() + 25 * HOUR);

      expect(getRun(getDb(), threadId)?.status).toBe("interrupted");
      const { events } = await sse(resumePath(threadId, "track-b"));
      expect(ofType(events, "error")).toHaveLength(0);
      expect(ofType(events, "complete")).toHaveLength(1);
      expect(getRun(getDb(), threadId)?.status).toBe("completed");
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
          setTimeout(resolve, 5_000).unref();
        });

      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>((r) => server.once("listening", () => r()));
      const { port } = server.address() as AddressInfo;
      let body = "";
      const client = http.get(`http://127.0.0.1:${port}${streamPath("plain hurt")}`, (res) => {
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("error", () => {});
      });
      client.on("error", () => {});

      try {
        await started.promise;
        const threadId = await vi.waitFor(() => {
          const id = ofType(parseEvents(body), "connected")[0]?.threadId;
          expect(id).toEqual(expect.any(String));
          return id as string;
        });

        client.destroy();
        await vi.waitFor(
          () => {
            expect(warn).toHaveBeenCalledWith(expect.stringContaining("run aborted"));
            expect(getRun(getDb(), threadId)?.status).toBe("cancelled");
          },
          { timeout: 1_000, interval: 20 },
        );
        // The engineer returned when it saw the abort; the pipeline must not go on.
        await new Promise((r) => setTimeout(r, 200));
        expect(stub.calls.composer).toBe(0);
      } finally {
        client.destroy();
        server.closeAllConnections();
        await new Promise((r) => server.close(r));
      }
    });
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
  });

  describe("input validation", () => {
    it("rejects a missing or overlong query and malformed resume ids", async () => {
      expect((await request(app).post("/api/analyze").send({})).status).toBe(400);
      expect(
        (
          await request(app)
            .post("/api/analyze")
            .send({ query: "x".repeat(201) })
        ).status,
      ).toBe(400);
      expect((await request(app).get(streamPath("x".repeat(201)))).status).toBe(400);
      expect((await request(app).get("/api/analyze/stream?query=a&query=b")).status).toBe(400);
      expect(
        (
          await request(app)
            .post("/api/analyze/resume")
            .send({ threadId: "a/../b", selectedTrackId: "x" })
        ).status,
      ).toBe(400);
      expect((await request(app).get("/api/analyze/stream/resume?threadId=abc")).status).toBe(400);
      expect(stub.calls.scout).toBe(0);
    });
  });
});
