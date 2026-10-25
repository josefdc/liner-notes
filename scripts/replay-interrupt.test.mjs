// Interrupting the replay end-to-end check (scripts/replay-e2e.mjs) while its API serves the
// checks: it must stop the API, remove its scratch directory and exit 130. Linux only (it finds
// the API's process group through /proc).
//
// Run by `npm run test:replay`, which sets REPLAY_INTERRUPT_TEST; `npm test` skips it, since
// starting the API rebuilds packages/contract/dist (its prestart), which other test files import
// while `npm test` runs.

import { spawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
// Building the contract and starting the API takes a few seconds, more on a loaded machine.
const READY_TIMEOUT_MS = 100_000;
// The stop gives up after 30 s at most (GIVE_UP_MS); a healthy one takes well under a second.
const EXIT_TIMEOUT_MS = 40_000;

const cleanups = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const kill = (pid, name = "SIGKILL") => {
  try {
    process.kill(pid, name);
  } catch {
    // already gone
  }
};

const groupAlive = (group) => {
  try {
    process.kill(-group, 0);
    return true;
  } catch {
    return false;
  }
};

/** The pid of the process group leader that `parent` started (the API's `npm start`), if any. */
function groupLedBy(parent) {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    let stat;
    try {
      stat = readFileSync(`/proc/${entry}/stat`, "utf8");
    } catch {
      continue; // gone meanwhile
    }
    // "pid (comm) state ppid pgrp ...", where comm may itself hold spaces and parentheses.
    const [, ppid, pgrp] = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (Number(ppid) === parent && Number(pgrp) === Number(entry)) return Number(entry);
  }
  return undefined;
}

it.skipIf(!process.env.REPLAY_INTERRUPT_TEST || !existsSync("/proc/self/stat"))(
  "SIGINT during the checks stops the API, removes the scratch directory and exits 130",
  async () => {
    const replay = spawn(process.execPath, [join(ROOT, "scripts", "replay-e2e.mjs")], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? tmpdir(),
        ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    replay.stdout.on("data", (chunk) => {
      output += chunk;
    });
    replay.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exited = new Promise((resolveExit) => replay.on("exit", (code) => resolveExit(code)));
    let group;
    let scratch;
    cleanups.push(() => {
      kill(replay.pid);
      if (group !== undefined && groupAlive(group)) kill(-group);
      if (scratch !== undefined) rmSync(scratch, { recursive: true, force: true });
    });

    // "A1 stream" is printed once the first replay has streamed: the API is up and the checks run.
    await expect
      .poll(() => output.includes("A1 stream:"), { timeout: READY_TIMEOUT_MS, interval: 20 })
      .toBe(true);
    group = groupLedBy(replay.pid);
    expect(group).toBeTypeOf("number");
    expect(groupAlive(group)).toBe(true);
    // The scratch directory, from the API's environment: its deny-network report is in it.
    scratch = readFileSync(`/proc/${group}/environ`, "utf8")
      .split("\0")
      .find((entry) => entry.startsWith("DENY_NETWORK_REPORT="))
      ?.slice("DENY_NETWORK_REPORT=".length)
      .replace(/\/deny-network\.jsonl$/, "");
    expect(scratch).toMatch(/replay-e2e-/);
    expect(existsSync(scratch)).toBe(true);

    replay.kill("SIGINT");
    const code = await Promise.race([
      exited,
      new Promise((resolveLate) => setTimeout(() => resolveLate("still running"), EXIT_TIMEOUT_MS)),
    ]);

    expect(code, output).toBe(130);
    expect(output).toContain(`SIGINT: stopping the API and removing ${scratch}`);
    expect(existsSync(scratch)).toBe(false);
    expect(groupAlive(group)).toBe(false); // no process of the API is left
    expect(output).not.toMatch(/^FAIL/m); // the checks cut short by the stop do not fail
  },
  READY_TIMEOUT_MS + 2 * EXIT_TIMEOUT_MS,
);
