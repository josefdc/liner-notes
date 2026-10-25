// Stopping a server run through tsx, as the replay end-to-end check does. Run with `npm test`.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readReport, readReportFile, runs, stopServer } from "./stop-server.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const PRELOAD = join(ROOT, "tests", "deny-network.mjs");
const BUSY = "fixtures/stop-server/busy-server.mjs";
const HOLDS_OUTPUT = "fixtures/stop-server/holds-output.mjs";
const STEP_TIMEOUT_MS = 20_000;

const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const kill = (pid) => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already gone
  }
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Starts a fixture server through tsx, in a process group of its own, with the preload. */
async function startServer(entry = BUSY) {
  const scratch = mkdtempSync(join(tmpdir(), "stop-server-"));
  const report = join(scratch, "deny-network.jsonl");
  const child = spawn(TSX, [join(import.meta.dirname, entry)], {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "",
      NODE_OPTIONS: `--import ${PRELOAD}`,
      DENY_NETWORK_REPORT: report,
    },
  });
  let output = "";
  cleanups.push(() => {
    kill(-child.pid);
    const holder = output.match(/holder (\d+)/);
    if (holder) kill(Number(holder[1]));
    child.stdout.destroy();
    child.stderr.destroy();
    rmSync(scratch, { recursive: true, force: true });
  });
  child.stdout.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const closed = new Promise((resolveClose) => child.on("close", (code) => resolveClose(code)));
  await new Promise((resolveReady, reject) => {
    child.once("error", reject);
    const until = Date.now() + STEP_TIMEOUT_MS;
    const poll = setInterval(() => {
      if (output.includes("ready")) {
        clearInterval(poll);
        resolveReady();
      } else if (Date.now() > until) {
        clearInterval(poll);
        reject(new Error(`the server did not start: ${output}`));
      }
    }, 20);
  });
  const started = readReport(report).find((line) => runs(line, entry) && line.event === "start");
  return { group: child.pid, pid: started?.pid, closed, report, output: () => output };
}

/** A process in a process group of its own, outside any server's. */
function startOutsider() {
  const outsider = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60_000)"], {
    detached: true,
    stdio: "ignore",
  });
  cleanups.push(() => kill(outsider.pid));
  return outsider.pid;
}

describe("stopServer", () => {
  it(
    "stops a server that handles its signal late: it exits 0 and writes its exit report",
    async () => {
      const server = await startServer();
      expect(server.pid).toBeTypeOf("number");
      expect(server.pid).not.toBe(server.group); // tsx runs the server in a child process

      const stopped = await stopServer({ ...server, timeoutMs: STEP_TIMEOUT_MS });

      expect(stopped).toEqual({ code: 0, signalled: server.pid, killed: false, held: false });
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
    "signals the whole group, and not the pid given, when that pid is not in the group",
    async () => {
      const server = await startServer();
      const outsider = startOutsider();

      const stopped = await stopServer({
        group: server.group,
        pid: outsider,
        closed: server.closed,
        timeoutMs: STEP_TIMEOUT_MS,
      });

      expect(stopped.signalled).toBe(-server.group);
      expect(() => process.kill(-server.group, 0)).toThrow();
      expect(alive(outsider)).toBe(true);
    },
    3 * STEP_TIMEOUT_MS,
  );

  it(
    "gives up when a process outside the group still holds the output after the SIGKILL",
    async () => {
      const server = await startServer(HOLDS_OUTPUT);
      const holder = Number(server.output().match(/holder (\d+)/)?.[1]);
      expect(alive(holder)).toBe(true);

      const stopped = await stopServer({ ...server, timeoutMs: 500, giveUpMs: 1_500 });

      // The group itself is gone by then (the SIGKILL finds no process); the holder is not in it.
      expect(stopped).toEqual({ code: null, signalled: server.pid, killed: false, held: true });
      expect(alive(holder)).toBe(true); // out of reach: the cleanup kills it by pid
    },
    3 * STEP_TIMEOUT_MS,
  );
});

describe("readReportFile", () => {
  it("returns the report lines and every other non-empty line apart", () => {
    const scratch = mkdtempSync(join(tmpdir(), "stop-server-"));
    cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
    const file = join(scratch, "report.jsonl");
    const line = (pid, event, attempts) =>
      JSON.stringify({ pid, argv: ["/x/apps/api/src/index.ts"], event, attempts, hosts: [] });
    const torn = JSON.stringify({ pid: 12, argv: ["/x/helper.js"], event: "blocked", attempts: 1 });
    writeFileSync(
      file,
      [
        line(11, "start", 0),
        torn.slice(0, 40),
        "",
        '{"note":"not a report line"}',
        line(11, "exit", 0),
      ]
        .join("\n")
        .concat("\n"),
    );

    const { lines, unreadable } = readReportFile(file);

    expect(lines.map((l) => `${l.pid} ${l.event}`)).toEqual(["11 start", "11 exit"]);
    expect(unreadable).toEqual([torn.slice(0, 40), '{"note":"not a report line"}']);
    expect(readReport(file)).toEqual(lines);
    expect(readReportFile(join(scratch, "absent.jsonl"))).toEqual({ lines: [], unreadable: [] });
  });
});
