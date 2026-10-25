/**
 * Starts the real entry point in a child process (dummy keys, a scratch database, and every
 * setting the tests rely on pinned, because the entry point also reads apps/api/.env): malformed requests do not take it down, it binds 127.0.0.1 by default, it
 * settles runs left open only once it listens, it refuses invalid configuration, and it shuts
 * down cleanly on SIGTERM. Also checks the process-level error handlers with a small fixture.
 *
 * Each child is a single node process (tsx is loaded with --import, no wrapper process), and
 * every child still running at the end is killed, so no server outlives the tests.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./store/migrations.js";
import { getRun, startRun } from "./store/runs.js";

const ENTRY = join(import.meta.dirname, "index.ts");
const PROCESS_ERRORS_FIXTURE = join(import.meta.dirname, "../test/fixtures/process-errors.ts");
const ODD_EXCEPTION_FIXTURE = join(import.meta.dirname, "../test/fixtures/odd-exception.ts");
const CLOSED_LOG_READER_FIXTURE = join(
  import.meta.dirname,
  "../test/fixtures/closed-log-reader.mjs",
);
const TSX_LOADER = pathToFileURL(
  join(dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist/loader.mjs"),
).href;

interface Child {
  process: ChildProcess;
  output: () => string;
  exit: Promise<number | null>;
}

const children = new Set<Child>();

/** Starts `entry` in one node process with only the given environment. */
function start(
  entry: string,
  cwd: string,
  env: Record<string, string>,
  args: string[] = [],
): Child {
  const child = spawn(process.execPath, ["--import", TSX_LOADER, entry, ...args], {
    cwd,
    env: { PATH: process.env.PATH ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  const handle: Child = {
    process: child,
    output: () => output,
    exit: new Promise((resolve) => child.on("exit", (code) => resolve(code))),
  };
  children.add(handle);
  void handle.exit.then(() => children.delete(handle));
  return handle;
}

afterAll(async () => {
  for (const child of children) {
    child.process.kill("SIGKILL");
    await child.exit;
  }
});

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (typeof address !== "object" || !address) throw new Error("no port");
  return address.port;
}

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A scratch directory with a migrated database holding one run left "running". */
function scratch(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "api-entry-"));
  dirs.push(dir);
  const dbPath = join(dir, "api.db");
  const db = new Database(dbPath);
  runMigrations(db);
  startRun(db, { runId: "left-open", threadId: "left-open", query: "q" });
  db.close();
  return { dir, dbPath };
}

function withDatabase<T>(dbPath: string, use: (db: Database.Database) => T): T {
  const db = new Database(dbPath);
  try {
    return use(db);
  } finally {
    db.close();
  }
}

const apiEnv = (port: number, dbPath: string, extra: Record<string, string> = {}) => ({
  NODE_ENV: "development",
  PORT: String(port),
  SQLITE_DB_PATH: dbPath,
  SPOTIFY_CLIENT_ID: "x",
  SPOTIFY_CLIENT_SECRET: "x",
  // Set and empty, so no .env file can supply real keys.
  GEMINI_API_KEY: "",
  TAVILY_API_KEY: "",
  LASTFM_API_KEY: "",
  DISCOGS_TOKEN: "",
  SHS_API_KEY: "",
  GENIUS_ACCESS_TOKEN: "",
  // Set and empty (the defaults), so a local .env cannot change what the tests check.
  HOST: "",
  TRUST_PROXY: "",
  RATE_LIMIT_WINDOW_MS: "",
  RATE_LIMIT_MAX: "",
  RATE_LIMIT_GLOBAL_MAX: "",
  SEARCH_RATE_LIMIT_WINDOW_MS: "",
  SEARCH_RATE_LIMIT_MAX: "",
  REPLAY_MODE: "",
  CHECKPOINT_RETENTION_HOURS: "",
  STORE_RETENTION_DAYS: "",
  RUN_RETENTION_DAYS: "",
  RUN_EVENT_RETENTION_DAYS: "",
  SOURCE_CASSETTE: "",
  // No model call can be live or billed: no key, cassettes replayed, no spend log.
  AZURE_OPENAI_API_KEY: "",
  LLM_CASSETTE: "replay",
  LLM_SPEND_LOG: "",
  // Debug level, so the bound address is in the log; no log file; a per-process IP key.
  LOG_LEVEL: "debug",
  LOG_FILE: "",
  LOG_IP_SALT: "",
  ...extra,
});

/** The JSON lines of a child's output; other lines (a fixture's own prints) are skipped. */
function logEntries(output: string): Array<Record<string, unknown>> {
  return output.split("\n").flatMap((line) => {
    try {
      const entry: unknown = JSON.parse(line);
      return entry && typeof entry === "object" ? [entry as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

/** True when the output holds a log line of `component` whose message contains `message`. */
function logged(output: string, component: string, message: string): boolean {
  return logEntries(output).some(
    (entry) => entry.component === component && String(entry.msg).includes(message),
  );
}

/**
 * Resolves once `child`'s output passes `test`. A line the child wrote around an answer (the
 * request line is written once the answer is sent) can reach this process after the answer
 * does. Fails, with the output, as soon as the child has exited and closed its output without
 * it, or when nothing passes within `ms`.
 */
function untilOutput(child: Child, test: (output: string) => boolean, ms = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const streams = [child.process.stdout, child.process.stderr];
    const stop = () => {
      clearTimeout(timer);
      for (const stream of streams) stream?.off("data", check);
      child.process.off("close", closed);
    };
    // Registered after start()'s own listener, so the output already holds the chunk.
    function check() {
      if (!test(child.output())) return;
      stop();
      resolve();
    }
    function closed() {
      if (test(child.output())) return check();
      stop();
      reject(
        new Error(
          `exited (${child.process.exitCode ?? child.process.signalCode}) first:\n${child.output()}`,
        ),
      );
    }
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`not in the output within ${ms} ms:\n${child.output()}`));
    }, ms);
    for (const stream of streams) stream?.on("data", check);
    child.process.once("close", closed);
    check();
    if (child.process.exitCode !== null && child.process.stdout?.readableEnded) closed();
  });
}

const CONTINUE = "HTTP/1.1 100 Continue\r\n\r\n";

/**
 * Opens a POST whose body never completes, and resolves once the API has read the request head
 * (it answers "100 Continue"). Until then the connection counts as idle: server.close() closes
 * it at once (Node 26), and a shutdown signalled earlier would have nothing to drain.
 * `received` is everything the API has sent on the connection; anything after the 100 (an early
 * answer, such as a 429) means the request was not held.
 */
async function openRequest(port: number): Promise<{ socket: Socket; received: () => string }> {
  const socket = connect(port, "127.0.0.1");
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", (error) => reject(new Error(`could not connect: ${error.message}`)));
    socket.once("close", () => reject(new Error("the connection closed before it was open")));
  });
  socket.on("error", () => {});
  let received = "";
  socket.on("data", (chunk: Buffer) => {
    received += chunk;
  });
  socket.write(
    "POST /api/factoids/decrypt HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
      "Content-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n",
  );
  const interim = await new Promise<string>((resolve) => {
    const timer = setTimeout(() => resolve("no interim answer within 5 s"), 5_000);
    const onData = () => {
      if (!received.includes("\r\n\r\n")) return;
      clearTimeout(timer);
      socket.off("data", onData);
      resolve(received);
    };
    socket.on("data", onData);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve(`the connection closed after ${JSON.stringify(received)}`);
    });
  });
  expect(interim).toBe(CONTINUE);
  socket.write("{");
  expect(received).toBe(CONTINUE);
  return { socket, received: () => received };
}

/** Starts the API on a free port with a scratch database and waits until it answers. */
async function startApi(): Promise<{ api: Child; port: number; dbPath: string }> {
  const { dir, dbPath } = scratch();
  const port = await freePort();
  const api = start(ENTRY, dir, apiEnv(port, dbPath));
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (api.process.exitCode !== null) throw new Error(`exited at startup:\n${api.output()}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return { api, port, dbPath };
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`did not start:\n${api.output()}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

describe("the API process", () => {
  let dbPath: string;
  let port: number;
  let api: Child;

  // Shared by these tests, in any order: none of them stops it.
  beforeAll(async () => {
    ({ api, port, dbPath } = await startApi());
  }, 40_000);

  // The issue's body, and one that passes the required-field check that used to come first and
  // so reached `existingFactoidIds.join` outside any try (which ended the process).
  it("answers malformed factoids bodies with 400 and keeps serving", async () => {
    for (const body of [
      { existingFactoidIds: "not-an-array" },
      { trackId: "x", trackTitle: "y", existingFactoidIds: "not-an-array" },
    ]) {
      const res = await fetch(`http://127.0.0.1:${port}/api/factoids/decrypt`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      expect(res.status).toBe(400);
    }

    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(api.process.exitCode).toBeNull();
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
  }, 15_000);

  it("binds 127.0.0.1 by default", async () => {
    await untilOutput(api, (output) => logged(output, "Server", "Listening on"));
    expect(logged(api.output(), "Server", `Listening on http://127.0.0.1:${port}`)).toBe(true);
  });

  it("writes its log as JSON lines, one object per line", async () => {
    // The health probes it answered while starting are logged once each answer was sent.
    await untilOutput(api, (output) =>
      logEntries(output).some((entry) => entry.path === "/api/health"),
    );
    const lines = api
      .output()
      .split("\n")
      .filter((line) => line.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(() => JSON.parse(line), line).not.toThrow();
    // The health probes it answered are logged at debug level, without the client's address.
    const probes = logEntries(api.output()).filter((entry) => entry.path === "/api/health");
    expect(probes.length).toBeGreaterThan(0);
    for (const probe of probes) {
      expect(probe).toMatchObject({ level: "debug", method: "GET", status: 200 });
      expect(probe.ipHash).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(api.output()).not.toMatch(/"(?:ip|remoteAddress)"/);
  });

  it("cancels runs left open by a previous process once it listens", () => {
    expect(withDatabase(dbPath, (db) => getRun(db, "left-open")?.status)).toBe("cancelled");
  });
});

describe("an API process stopped by SIGTERM", () => {
  // A process of its own: the shared one above must keep serving whatever test runs after.
  it("drains on SIGTERM, ignores the relayed duplicate, settles runs in flight and exits 0", async () => {
    const { api, port, dbPath } = await startApi();
    withDatabase(dbPath, (db) =>
      startRun(db, { runId: "in-flight", threadId: "in-flight", query: "q" }),
    );

    // A request still in progress (its body never completes) keeps a connection open, so the
    // shutdown has to drain.
    const { socket, received } = await openRequest(port);
    const socketClosed = new Promise((resolve) => socket.once("close", resolve));

    // In development the signal arrives twice within milliseconds: the second one is sent as
    // soon as the first has been handled (two pending signals would be delivered as one).
    const signalledAt = Date.now();
    api.process.kill("SIGTERM");
    await untilOutput(api, (output) => output.includes("SIGTERM received"));
    api.process.kill("SIGTERM");
    // Exit 0 means the drain, not the 8 s shutdown timeout, closed the open connection.
    expect(await api.exit).toBe(0);
    await socketClosed;
    expect(logged(api.output(), "Server", "still open after the shutdown timeout")).toBe(false);
    // The process drains for 3 s and gives up after 8 s; lifecycle.test.ts checks on a fake
    // clock that the drain closes the connections exactly then.
    const entries = logEntries(api.output());
    const signalled = entries.find((entry) => String(entry.msg).startsWith("SIGTERM received"));
    const stopped = entries.find(
      (entry) => entry.component === "Server" && entry.msg === "Stopped",
    );
    expect(signalled).toMatchObject({ drainMs: 3_000, timeoutMs: 8_000 });
    // The whole shutdown, by the process's own clock: the drain, then at most half of what is
    // left before the shutdown timeout for settling the runs and closing the store.
    const { drainMs, timeoutMs } = signalled as { drainMs: number; timeoutMs: number };
    const tookMs = Date.parse(String(stopped?.time)) - Date.parse(String(signalled?.time));
    expect(tookMs, "SIGTERM to Stopped, in the process's log").toBeLessThan(
      drainMs + (timeoutMs - drainMs) / 2,
    );
    // The open connection was given the drain.
    expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(2900);
    expect(received()).toBe(CONTINUE); // held until the drain closed it, never answered

    expect(logged(api.output(), "Server", "ignored as a duplicate")).toBe(true);
    expect(logged(api.output(), "Database", "Connection closed.")).toBe(true);
    expect(logged(api.output(), "Server", "Stopped")).toBe(true);
    expect(withDatabase(dbPath, (db) => getRun(db, "in-flight")?.status)).toBe("cancelled");
  }, 20_000);
});

describe("an API process stopped by SIGINT", () => {
  it("shuts down cleanly", async () => {
    const { api } = await startApi();
    api.process.kill("SIGINT");
    expect(await api.exit).toBe(0);
    expect(logged(api.output(), "Server", "SIGINT received")).toBe(true);
    expect(logged(api.output(), "Server", "Stopped")).toBe(true);
  }, 40_000);
});

describe("an API process whose log reader has gone", () => {
  it("still drains, settles its runs and exits 0 on SIGTERM", async () => {
    // A launcher process reads the API's log, then stops reading (as the dev launcher does when
    // it exits first), so the API's next log line fails with EPIPE.
    const { dir, dbPath } = scratch();
    withDatabase(dbPath, (db) =>
      startRun(db, { runId: "in-flight", threadId: "in-flight", query: "q" }),
    );
    // The launcher passes its environment (the same pinned settings) on to the API.
    const port = await freePort();
    const launcher = start(CLOSED_LOG_READER_FIXTURE, dir, apiEnv(port, dbPath), [
      TSX_LOADER,
      ENTRY,
      String(port),
      dbPath,
    ]);
    const exitCode = await launcher.exit;

    // An { error } line (the API did not start, or answered the open request) fails here, shown.
    const result = JSON.parse(launcher.output().trim().split("\n").pop() ?? "{}");
    expect(result).toMatchObject({ code: 0, signal: null, afterContinue: "" });
    expect(exitCode).toBe(0);
    expect(result.ms).toBeGreaterThanOrEqual(2900); // the open request was given the drain
    expect(withDatabase(dbPath, (db) => getRun(db, "in-flight")?.status)).toBe("cancelled");
  }, 60_000);
});

describe("an API process that cannot listen", () => {
  let blocker: Server | undefined;

  afterEach(async () => {
    await new Promise((resolve) => (blocker ? blocker.close(resolve) : resolve(undefined)));
    blocker = undefined;
  });

  it("exits 1 and leaves the runs alone when the port is taken", async () => {
    const { dir, dbPath } = scratch();
    const port = await freePort();
    blocker = createServer();
    await new Promise<void>((resolve) => blocker?.listen(port, "127.0.0.1", resolve));

    const api = start(ENTRY, dir, apiEnv(port, dbPath));
    expect(await api.exit).toBe(1);

    expect(logged(api.output(), "Server", "Could not listen")).toBe(true);
    expect(withDatabase(dbPath, (db) => getRun(db, "left-open")?.status)).toBe("running");
  }, 30_000);
});

describe("an API process with invalid configuration", () => {
  it.each([
    ["a port that is not a number", { PORT: "abc" }, "PORT"],
    ["an unknown replay mode", { REPLAY_MODE: "on" }, "REPLAY_MODE"],
    ["a wildcard CORS origin", { CORS_ORIGINS: "*" }, "CORS_ORIGINS"],
    ["no Spotify keys", { SPOTIFY_CLIENT_ID: "", SPOTIFY_CLIENT_SECRET: "" }, "SPOTIFY_CLIENT_ID"],
  ])(
    "exits 1 before opening the database: %s",
    async (_label, extra, key) => {
      const { dir, dbPath } = scratch();

      const api = start(ENTRY, dir, apiEnv(await freePort(), dbPath, extra));
      expect(await api.exit).toBe(1);

      expect(logged(api.output(), "config", key)).toBe(true);
      expect(logged(api.output(), "Database", "Initialized")).toBe(false);
      // A message, not a crash.
      expect(api.output()).not.toMatch(/\n\s+at /);
      expect(api.output()).not.toContain('"stack"');
    },
    30_000,
  );
});

describe("process-level error handlers", () => {
  it("log an unhandled rejection and keep running; exit 1 after an uncaught exception", async () => {
    const dir = mkdtempSync(join(tmpdir(), "api-errors-"));
    dirs.push(dir);

    const child = start(PROCESS_ERRORS_FIXTURE, dir, {});
    expect(await child.exit).toBe(1);

    const output = child.output();
    const entries = logEntries(output);
    expect(entries).toContainEqual(
      expect.objectContaining({
        component: "Process",
        msg: "Unhandled promise rejection",
        err: expect.objectContaining({ message: "rejection nobody handled" }),
      }),
    );
    expect(output).toContain("still running after the rejection");
    expect(entries).toContainEqual(
      expect.objectContaining({
        component: "Process",
        msg: "Uncaught exception; exiting",
        err: expect.objectContaining({ message: "exception nobody caught" }),
      }),
    );
    expect(output).toContain("fatal hook ran");
    expect(output).not.toContain("still running after the exception");
  }, 30_000);

  it("log an exception the log cannot read whole, still run the fatal hook and exit 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "api-errors-"));
    dirs.push(dir);

    const child = start(ODD_EXCEPTION_FIXTURE, dir, {});
    expect(await child.exit).toBe(1);

    const output = child.output();
    expect(logEntries(output)).toContainEqual(
      expect.objectContaining({
        component: "Process",
        msg: "Uncaught exception; exiting",
        err: expect.objectContaining({
          type: "Error",
          stack: expect.stringContaining("odd-exception.ts"),
        }),
      }),
    );
    expect(output).toContain("fatal hook ran");
    expect(output).not.toContain("getter exploded");
  }, 30_000);
});
