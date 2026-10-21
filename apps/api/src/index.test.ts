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
  SOURCE_CASSETTE: "",
  ...extra,
});

/**
 * Opens a POST whose body never completes, and resolves once the API has read the request head
 * (it answers "100 Continue"). Until then the connection counts as idle: server.close() closes
 * it at once (Node 26), and a shutdown signalled earlier would have nothing to drain.
 */
async function openRequest(port: number): Promise<Socket> {
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => {});
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(
    "POST /api/factoids/decrypt HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
      "Content-Type: application/json\r\nContent-Length: 100\r\nExpect: 100-continue\r\n\r\n",
  );
  const interim = await new Promise<string>((resolve) => {
    let received = "";
    const onData = (chunk: Buffer) => {
      received += chunk;
      if (!received.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve(received.split("\r\n")[0] ?? "");
    };
    socket.on("data", onData);
    socket.once("close", () => resolve(`connection closed after ${JSON.stringify(received)}`));
  });
  expect(interim).toMatch(/^HTTP\/1\.1 100 /);
  socket.write("{");
  return socket;
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

  beforeAll(async () => {
    const paths = scratch();
    dbPath = paths.dbPath;
    port = await freePort();
    api = start(ENTRY, paths.dir, apiEnv(port, dbPath));

    const deadline = Date.now() + 30_000;
    for (;;) {
      if (api.process.exitCode !== null) throw new Error(`exited at startup:\n${api.output()}`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`did not start:\n${api.output()}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
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

  it("binds 127.0.0.1 by default", () => {
    expect(api.output()).toContain(`listening on http://127.0.0.1:${port}`);
  });

  it("cancels runs left open by a previous process once it listens", () => {
    expect(withDatabase(dbPath, (db) => getRun(db, "left-open")?.status)).toBe("cancelled");
  });

  it("drains on SIGTERM, ignores the relayed duplicate, settles runs in flight and exits 0", async () => {
    withDatabase(dbPath, (db) =>
      startRun(db, { runId: "in-flight", threadId: "in-flight", query: "q" }),
    );

    // A request still in progress (its body never completes) keeps a connection open, so the
    // shutdown has to drain.
    const socket = await openRequest(port);
    const socketClosed = new Promise((resolve) => socket.once("close", resolve));

    // In development the signal arrives twice within milliseconds: the second one is sent as
    // soon as the first has been handled (two pending signals would be delivered as one).
    const signalledAt = Date.now();
    api.process.kill("SIGTERM");
    while (!api.output().includes("SIGTERM received")) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    api.process.kill("SIGTERM");
    expect(await api.exit).toBe(0);
    await socketClosed;
    // The open connection was given the drain (3 s) and closed well before the timeout (8 s).
    expect(Date.now() - signalledAt).toBeGreaterThanOrEqual(2900);
    expect(Date.now() - signalledAt).toBeLessThan(7000);

    expect(api.output()).toContain("ignored as a duplicate");
    expect(api.output()).toContain("[Database] Connection closed.");
    expect(api.output()).toContain("[Server] Stopped");
    expect(withDatabase(dbPath, (db) => getRun(db, "in-flight")?.status)).toBe("cancelled");
  }, 15_000);
});

describe("an API process stopped by SIGINT", () => {
  it("shuts down cleanly", async () => {
    const { api } = await startApi();
    api.process.kill("SIGINT");
    expect(await api.exit).toBe(0);
    expect(api.output()).toContain("SIGINT received");
    expect(api.output()).toContain("[Server] Stopped");
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
    expect(await launcher.exit).toBe(0);

    const result = JSON.parse(launcher.output().trim().split("\n").pop() ?? "{}");
    expect(result).toMatchObject({ code: 0, signal: null });
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

    expect(api.output()).toContain("Could not listen");
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

      expect(api.output()).toContain("[config]");
      expect(api.output()).toContain(key);
      expect(api.output()).not.toContain("[Database] Initialized");
      expect(api.output()).not.toMatch(/\n\s+at /); // a message, not a crash
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
    expect(output).toContain("[Process] Unhandled promise rejection");
    expect(output).toContain("rejection nobody handled");
    expect(output).toContain("still running after the rejection");
    expect(output).toContain("[Process] Uncaught exception; exiting");
    expect(output).toContain("exception nobody caught");
    expect(output).toContain("fatal hook ran");
    expect(output).not.toContain("still running after the exception");
  }, 30_000);
});
