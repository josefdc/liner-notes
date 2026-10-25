// Stopping a server run through tsx, as the replay end-to-end check does. Run with `npm test`.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readReport, runs, stopServer } from "./stop-server.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const PRELOAD = join(ROOT, "tests", "deny-network.mjs");
const ENTRY = "fixtures/stop-server/busy-server.mjs";
const STEP_TIMEOUT_MS = 20_000;

const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

/** Starts the busy server through tsx, in a process group of its own, with the preload. */
async function startServer() {
  const scratch = mkdtempSync(join(tmpdir(), "stop-server-"));
  const report = join(scratch, "deny-network.jsonl");
  const child = spawn(TSX, [join(import.meta.dirname, ENTRY)], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      NODE_OPTIONS: `--import ${PRELOAD}`,
      DENY_NETWORK_REPORT: report,
    },
  });
  cleanups.push(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    rmSync(scratch, { recursive: true, force: true });
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const closed = new Promise((resolveClose) => child.on("close", (code) => resolveClose(code)));
  const until = Date.now() + STEP_TIMEOUT_MS;
  while (!output.includes("ready")) {
    if (Date.now() > until) throw new Error(`the server did not start: ${output}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  const started = readReport(report).find((line) => runs(line, ENTRY) && line.event === "start");
  return { group: child.pid, pid: started?.pid, closed, report, output: () => output };
}

describe("stopServer", () => {
  it(
    "stops a server that handles its signal late: it exits 0 and writes its exit report",
    async () => {
      const server = await startServer();
      expect(server.pid).toBeTypeOf("number");
      expect(server.pid).not.toBe(server.group); // tsx runs the server in a child process

      const stopped = await stopServer({ ...server, timeoutMs: STEP_TIMEOUT_MS });

      expect(stopped).toEqual({ code: 0, signalled: server.pid, killed: false });
      const exits = readReport(server.report).filter(
        (line) => line.pid === server.pid && line.event === "exit",
      );
      expect(exits).toEqual([expect.objectContaining({ attempts: 0, hosts: [] })]);
      expect(server.output()).toContain(`[deny-network] outbound attempts: 0 (pid ${server.pid})`);
    },
    3 * STEP_TIMEOUT_MS,
  );

  it(
    "signals the whole group when the server's pid is not known, and waits for all of it",
    async () => {
      const server = await startServer();

      const stopped = await stopServer({
        group: server.group,
        closed: server.closed,
        timeoutMs: STEP_TIMEOUT_MS,
      });

      expect(stopped.signalled).toBe(-server.group);
      expect(stopped.killed).toBe(false);
      expect(() => process.kill(-server.group, 0)).toThrow(); // no process of the group is left
    },
    3 * STEP_TIMEOUT_MS,
  );

  // Only where /proc tells a process's group: elsewhere the pid given is trusted.
  it.skipIf(!existsSync("/proc/self/stat"))(
    "signals the whole group when the pid given is not in it",
    async () => {
      const server = await startServer();

      const stopped = await stopServer({
        group: server.group,
        pid: process.pid, // this test runner: never signalled
        closed: server.closed,
        timeoutMs: STEP_TIMEOUT_MS,
      });

      expect(stopped.signalled).toBe(-server.group);
      expect(() => process.kill(-server.group, 0)).toThrow();
    },
    3 * STEP_TIMEOUT_MS,
  );
});
