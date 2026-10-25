// Stopping a server started as `npm start` in a process group of its own (npm, then sh, then the
// server), so that its exit is the same however busy the machine is.
//
// The server process alone gets SIGTERM when its pid is known and in the group; the whole group
// gets it only when not (the server never started, say). When the server runs under the tsx CLI
// (`tsx src/index.ts`), tsx (4.21) relays a signal it gets to its child and, unless the child
// acknowledges it within about 30 ms (twice), kills the child with SIGKILL: a child whose event
// loop is busy at that moment dies without running its exit handlers, so it neither shuts down
// cleanly nor writes its deny-network report. Signalled alone, the server shuts down, and any
// process above it (tsx, sh, npm) exits after it with its code.

import { existsSync, readFileSync } from "node:fs";

const isReportLine = (value) =>
  value !== null &&
  typeof value === "object" &&
  Number.isInteger(value.pid) &&
  Array.isArray(value.argv) &&
  typeof value.event === "string";

/**
 * Reads a deny-network report (tests/deny-network.mjs) from byte `from` on: `lines` are its report
 * lines, `unreadable` every other non-empty line (one being written while a process runs, or one
 * cut short) and `end` the byte it read up to, from which a later read takes only the lines added
 * since. An absent file reads as no lines.
 */
export function readReportFile(file, from = 0) {
  let bytes;
  try {
    bytes = readFileSync(file);
  } catch {
    return { lines: [], unreadable: [], end: from };
  }
  const lines = [];
  const unreadable = [];
  for (const line of bytes.subarray(from).toString("utf8").split("\n")) {
    if (line.trim() === "") continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      // not JSON
    }
    if (isReportLine(value)) lines.push(value);
    else unreadable.push(line);
  }
  return { lines, unreadable, end: bytes.length };
}

/** The report lines of a deny-network report, leaving out any it cannot read. */
export const readReport = (file) => readReportFile(file).lines;

/**
 * Whether a report line comes from the process whose script is `entry` (e.g.
 * "apps/api/src/index.ts"): the server process, not a tsx CLI, whose own script is the CLI.
 */
export const runs = (line, entry) => String(line.argv[0]).endsWith(entry);

/**
 * Whether `pid` is a live process of process group `group`, where /proc tells. Elsewhere (macOS)
 * this is not checked and the pid is trusted: were the server to die during the checks and its
 * pid be reused by another process of the same user, that process would get the SIGTERM.
 */
function inGroup(pid, group) {
  let stat;
  try {
    stat = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch {
    return !existsSync("/proc/self/stat"); // gone, or no /proc to tell
  }
  // "pid (comm) state ppid pgrp ...", where comm may itself hold spaces and parentheses.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  return Number(fields[2]) === group;
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
    return true;
  } catch {
    return false; // already gone
  }
}

/**
 * Stops a server started with `spawn(..., { detached: true })` and waits until its output has
 * closed, that is until every process holding it has exited, so its output and its report are
 * complete.
 *
 * - `group`: the spawned process's pid, which leads the process group;
 * - `pid`: the server process, if known (from its "start" report line). It alone gets SIGTERM;
 *   when it is not known (the server never started) or not in the group, the whole group does;
 * - `closed`: resolves when the spawned process has exited and its output streams have closed
 *   (its "close" event), with its exit code;
 * - after `timeoutMs` the whole group gets SIGKILL;
 * - after `giveUpMs` (default: `timeoutMs` and 10 s) it stops waiting: a process outside the
 *   group, which the SIGKILL does not reach, still holds the output.
 *
 * Returns { code, signalled, killed, held }: the exit code (null when it gave up), the pid or
 * group that got SIGTERM, whether SIGKILL was sent, and whether it gave up waiting.
 */
export async function stopServer({ group, pid, closed, timeoutMs, giveUpMs = timeoutMs + 10_000 }) {
  const target = pid !== undefined && inGroup(pid, group) ? pid : -group;
  signal(target, "SIGTERM");
  let killed = false;
  const kill = setTimeout(() => {
    killed = signal(-group, "SIGKILL");
  }, timeoutMs);
  const held = Symbol("held");
  let giveUp;
  const code = await Promise.race([
    closed,
    new Promise((resolveHeld) => {
      giveUp = setTimeout(() => resolveHeld(held), giveUpMs);
    }),
  ]);
  clearTimeout(kill);
  clearTimeout(giveUp);
  if (code === held) return { code: null, signalled: target, killed, held: true };
  return { code, signalled: target, killed, held: false };
}
