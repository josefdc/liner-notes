/**
 * Shutdown with a real HTTP server, a real SQLite file and an open event stream; the process
 * exit is a stub. Timings are scaled down (drain 300 ms, timeout 3 s).
 */

import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  createShutdown,
  requestGate,
  SHUTDOWN_TIMEOUT_MS,
  type ShutdownOptions,
  STREAM_DRAIN_MS,
} from "./lifecycle.js";
import { runMigrations } from "./store/migrations.js";
import { getRun, settleOpenRuns, startRun } from "./store/runs.js";

const DRAIN_MS = 300;
const TIMEOUT_MS = 3000;

let dir: string;
let dbPath: string;
let server: http.Server;
let port: number;

beforeEach(async () => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
  dbPath = join(dir, "api.db");
  const db = new Database(dbPath);
  runMigrations(db);
  db.close();

  // /stream starts a run and keeps the response open until the connection is closed.
  server = http.createServer((req, res) => {
    if (req.url === "/stream") {
      const db = new Database(dbPath);
      startRun(db, { runId: "streaming", threadId: "streaming", query: "q" });
      db.close();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write("data: {}\n\n");
      return;
    }
    res.end("ok");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterEach(() => {
  server.closeAllConnections();
  server.close();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

/** Opens /stream; resolves once the response has started, with a promise for its end. */
function openStream(): Promise<{ closed: Promise<number> }> {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/stream`, (res) => {
      const closed = new Promise<number>((done) => res.on("close", () => done(Date.now())));
      res.resume();
      resolve({ closed });
    });
    req.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
  });
}

function setup(overrides: Partial<ShutdownOptions> = {}) {
  const calls = { stopBackground: 0, closeStore: 0, closedAt: 0, dbClosed: false };
  let exited!: (value: { code: number; at: number }) => void;
  const exit = new Promise<{ code: number; at: number }>((resolve) => {
    exited = resolve;
  });
  const exitStub = vi.fn((code: number) => exited({ code, at: Date.now() }));
  const shutdown = createShutdown({
    server,
    stopBackground: () => {
      calls.stopBackground++;
    },
    closeStore: async () => {
      calls.closeStore++;
      calls.closedAt = Date.now();
      const db = new Database(dbPath);
      await settleOpenRuns(db, async () => false);
      db.close();
      calls.dbClosed = true;
    },
    exit: exitStub,
    drainMs: DRAIN_MS,
    timeoutMs: TIMEOUT_MS,
    ...overrides,
  });
  return { shutdown, exit, exitStub, calls };
}

const runStatus = () => {
  const db = new Database(dbPath);
  try {
    return getRun(db, "streaming")?.status;
  } finally {
    db.close();
  }
};

describe("createShutdown", () => {
  it("lets an open stream drain, then closes it, cancels its run, closes the store and exits 0", async () => {
    const { shutdown, exit, calls } = setup();
    const stream = await openStream();
    expect(runStatus()).toBe("running");

    const start = Date.now();
    shutdown("SIGTERM");
    expect(calls.stopBackground).toBe(1);

    // Still open during the drain.
    await new Promise((r) => setTimeout(r, DRAIN_MS / 2));
    expect(calls.closeStore).toBe(0);

    const closedAt = await stream.closed;
    expect(closedAt - start).toBeGreaterThanOrEqual(DRAIN_MS - 20);

    const { code, at } = await exit;
    expect(code).toBe(0);
    expect(at - start).toBeLessThan(TIMEOUT_MS);
    // The store closes only once the stream's connection has been closed.
    expect(calls.closedAt - start).toBeGreaterThanOrEqual(DRAIN_MS - 20);
    expect(calls).toMatchObject({ closeStore: 1, dbClosed: true });
    expect(runStatus()).toBe("cancelled");
  });

  it("exits at once when no connection is open", async () => {
    const { shutdown, exit } = setup();
    const start = Date.now();
    shutdown("SIGTERM");
    const { code, at } = await exit;
    expect(code).toBe(0);
    expect(at - start).toBeLessThan(DRAIN_MS);
  });

  it("ignores the same signal repeated within a second (the dev runner and tsx both relay it)", async () => {
    const { shutdown, exit, exitStub } = setup();
    await openStream();

    shutdown("SIGTERM");
    shutdown("SIGTERM");
    shutdown("SIGINT");

    expect((await exit).code).toBe(0);
    expect(exitStub).toHaveBeenCalledTimes(1);
  });

  it("exits 1 at once on a signal after the first second", async () => {
    let clock = 0;
    const { shutdown, exit, calls } = setup({ now: () => clock });
    await openStream();

    shutdown("SIGTERM");
    clock = 1500;
    const start = Date.now();
    shutdown("SIGTERM");

    const { code, at } = await exit;
    expect(code).toBe(1);
    expect(at - start).toBeLessThan(DRAIN_MS);
    expect(calls.closeStore).toBe(0);
  });

  it.each([
    ["back an hour, then 1.5 s pass", -60 * 60_000, 1_500, 1],
    ["forward 10 s", 10_000, 0, 0],
  ])(
    "tells a repeated signal on the monotonic clock when the wall clock steps %s",
    async (_label, step, passes, code) => {
      vi.useFakeTimers({ toFake: ["Date", "performance"] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      const { shutdown, exit, exitStub } = setup();
      await openStream();

      shutdown("SIGTERM");
      vi.setSystemTime(Date.now() + step);
      vi.advanceTimersByTime(passes);
      shutdown("SIGTERM");

      // After more than a second it exits 1 at once; within it, it is a duplicate.
      expect((await exit).code).toBe(code);
      expect(exitStub).toHaveBeenCalledTimes(1);
    },
  );

  it("closes the store and exits 1 when connections outlast the timeout", async () => {
    const { shutdown, exit, calls } = setup({ drainMs: 10_000, timeoutMs: 300 });
    await openStream();

    const start = Date.now();
    shutdown("SIGTERM");
    const { code, at } = await exit;

    expect(code).toBe(1);
    expect(at - start).toBeGreaterThanOrEqual(280);
    expect(calls).toMatchObject({ closeStore: 1, dbClosed: true });
    expect(runStatus()).toBe("cancelled");
  });
});

describe("the drain the API uses", () => {
  it("is 3 s, within the 8 s shutdown timeout and Docker's 10 s", () => {
    expect(STREAM_DRAIN_MS).toBe(3_000);
    expect(SHUTDOWN_TIMEOUT_MS).toBe(8_000);
  });

  it("closes the open connections exactly STREAM_DRAIN_MS after the signal", () => {
    // On a fake clock that only the test moves: the drain is the timer's, not the machine's.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const closeAllConnections = vi.fn();
    // A server with an open connection: close() never calls back until it ends.
    const openServer = { close: vi.fn(), closeAllConnections } as unknown as http.Server;
    const exit = vi.fn();
    const shutdown = createShutdown({
      server: openServer,
      stopBackground: () => {},
      closeStore: async () => {},
      exit,
      drainMs: STREAM_DRAIN_MS,
      timeoutMs: SHUTDOWN_TIMEOUT_MS,
    });

    shutdown("SIGTERM");
    vi.advanceTimersByTime(STREAM_DRAIN_MS - 1);
    expect(closeAllConnections).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(closeAllConnections).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("requestGate", () => {
  type Req = Parameters<Parameters<typeof requestGate>[0]>[0];
  type Res = Parameters<Parameters<typeof requestGate>[0]>[1];
  const req = (id: string) => ({ url: id }) as unknown as Req;
  const res = {} as Res;

  it("holds requests while the startup work runs, then passes them on in order", async () => {
    const seen: string[] = [];
    const gate = requestGate((r) => seen.push(r.url ?? ""));
    let finish!: () => void;
    const work = new Promise<void>((resolve) => {
      finish = resolve;
    });

    gate.handler(req("before"), res);
    const opened = gate.until(work);
    gate.handler(req("during-1"), res);
    gate.handler(req("during-2"), res);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual(["before"]);

    finish();
    await opened;
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(["before", "during-1", "during-2"]);

    gate.handler(req("after"), res);
    expect(seen).toEqual(["before", "during-1", "during-2", "after"]);
  });

  it("opens even when the startup work fails", async () => {
    const seen: string[] = [];
    const gate = requestGate((r) => seen.push(r.url ?? ""));
    const opened = gate.until(Promise.reject(new Error("settling failed")));
    gate.handler(req("during"), res);

    await opened;
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(["during"]);
  });
});
