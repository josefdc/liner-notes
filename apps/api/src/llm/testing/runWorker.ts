/**
 * Test helper: runs callWorker.ts in a child process with a clean environment (only PATH and
 * HOME are inherited, so a developer's shell settings cannot change what a test checks).
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { onTestFinished } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const WORKER = join(here, "callWorker.ts");
const REPO_ROOT = join(here, "..", "..", "..", "..", "..");

export interface WorkerResult {
  ok: boolean;
  usd?: number;
  kind?: string;
  message?: string;
}

export interface WorkerRun {
  code: number | null;
  signal: NodeJS.Signals | null;
  results: WorkerResult[];
  stderr: string;
}

export function runWorker(
  env: Record<string, string>,
  options: { killOnInFlight?: boolean } = {},
): Promise<WorkerRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", WORKER], {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    });
    // However the test ends (its timeout included), the worker does not outlive it.
    onTestFinished(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (options.killOnInFlight && stdout.includes("in-flight\n")) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      const results = stdout
        .split("\n")
        .filter((line) => line.startsWith("RESULT "))
        .map((line) => JSON.parse(line.slice("RESULT ".length)) as WorkerResult);
      resolve({ code, signal, results, stderr });
    });
  });
}
