// Stopping a server started as `npm start` (npm, then sh, then tsx, which runs the server in a
// child process of its own), so that its exit is the same however busy the machine is.
//
// Signalling the whole process group is not: tsx (4.21) relays a signal to its child and, unless
// the child acknowledges it within about 30 ms (twice), kills it with SIGKILL. A child whose
// event loop is busy at that moment dies without running its exit handlers, so it neither shuts
// down cleanly nor writes its deny-network report. Signalling the server process alone leaves
// tsx out of it: the server shuts down, and tsx, sh and npm exit after it with its code.

import { existsSync, readFileSync } from "node:fs";

/**
 * The lines of a deny-network report (tests/deny-network.mjs), or [] if there is none yet. A line
 * that does not parse (one being written while a process runs) is left out.
 */
export function readReport(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

/**
 * Whether a report line comes from the process whose script is `entry` (e.g.
 * "apps/api/src/index.ts"): the server process, not tsx, whose own script is its CLI.
 */
export const runs = (line, entry) => String(line.argv[0]).endsWith(entry);

/** Whether `pid` is a live process of process group `group` (where /proc tells; else true). */
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
 * Stops a server started with `spawn(..., { detached: true })` and waits until every process of
 * its group that holds its output has exited, so its output and its report are complete.
 *
 * - `group`: the spawned process's pid, which leads the process group;
 * - `pid`: the server process, if known (from its "start" report line). It alone gets SIGTERM;
 *   when it is not known (the server never started) the whole group does;
 * - `closed`: resolves when the spawned process has exited and its output streams have closed
 *   (its "close" event), with its exit code;
 * - after `timeoutMs` the whole group gets SIGKILL.
 *
 * Returns { code, signalled, killed }: the exit code, the pid or group that got SIGTERM, and
 * whether SIGKILL was needed.
 */
export async function stopServer({ group, pid, closed, timeoutMs }) {
  const target = pid !== undefined && inGroup(pid, group) ? pid : -group;
  signal(target, "SIGTERM");
  let killed = false;
  const timer = setTimeout(() => {
    killed = signal(-group, "SIGKILL");
  }, timeoutMs);
  const code = await closed;
  clearTimeout(timer);
  return { code, signalled: target, killed };
}
