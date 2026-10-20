/**
 * Starts the real entry point in a child process (dummy keys, a scratch database, no .env in its
 * working directory) and checks that a malformed request does not take the process down, that
 * it binds 127.0.0.1 by default, that runs left open are settled at startup and shutdown, and
 * that it shuts down cleanly on SIGTERM.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./store/migrations.js";
import { getRun, startRun } from "./store/runs.js";

const ENTRY = join(import.meta.dirname, "index.ts");
const TSX_CLI = createRequire(import.meta.url).resolve("tsx/cli");

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (typeof address !== "object" || !address) throw new Error("no port");
  return address.port;
}

describe("the API process", () => {
  let dir: string;
  let port: number;
  let child: ChildProcess;
  let output = "";
  let exit: Promise<number | null>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "api-entry-"));
    port = await freePort();

    // A run a previous process left "running".
    const db = new Database(join(dir, "api.db"));
    runMigrations(db);
    startRun(db, { runId: "left-open", threadId: "left-open", query: "q" });
    db.close();

    child = spawn(process.execPath, [TSX_CLI, ENTRY], {
      cwd: dir,
      env: {
        PATH: process.env.PATH,
        NODE_ENV: "development",
        PORT: String(port),
        SQLITE_DB_PATH: join(dir, "api.db"),
        SPOTIFY_CLIENT_ID: "x",
        SPOTIFY_CLIENT_SECRET: "x",
        // Set and empty, so no .env file can supply real keys.
        GEMINI_API_KEY: "",
        TAVILY_API_KEY: "",
        LASTFM_API_KEY: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      output += chunk;
    });
    exit = new Promise((resolve) => child.on("exit", (code) => resolve(code)));

    const deadline = Date.now() + 30_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`the API exited at startup:\n${output}`);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.ok) break;
      } catch {
        // not listening yet
      }
      if (Date.now() > deadline) throw new Error(`the API did not start:\n${output}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }, 40_000);

  afterAll(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await exit;
    }
    rmSync(dir, { recursive: true, force: true });
  });

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
    expect(child.exitCode).toBeNull();
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(health.status).toBe(200);
  }, 15_000);

  it("binds 127.0.0.1 by default", () => {
    expect(output).toContain(`listening on http://127.0.0.1:${port}`);
  });

  /** Runs a query on the API's database file from this process. */
  function withDatabase<T>(use: (db: Database.Database) => T): T {
    const db = new Database(join(dir, "api.db"));
    try {
      return use(db);
    } finally {
      db.close();
    }
  }

  it("cancels runs left open by a previous process before listening", () => {
    expect(withDatabase((db) => getRun(db, "left-open")?.status)).toBe("cancelled");
  });

  it("closes the server and the database on SIGTERM and exits 0", async () => {
    // A run in flight when the signal arrives.
    withDatabase((db) => startRun(db, { runId: "in-flight", threadId: "in-flight", query: "q" }));

    child.kill("SIGTERM");
    expect(await exit).toBe(0);
    expect(withDatabase((db) => getRun(db, "in-flight")?.status)).toBe("cancelled");
    expect(output).toContain("[Database] Connection closed.");
    expect(output).toContain("[Server] Stopped");
  }, 15_000);
});
