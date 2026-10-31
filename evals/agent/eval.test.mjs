// The `npm run eval` entry point: live runs are refused with no outbound connection, replay
// needs recorded runs. Run with: node --test 'evals/**/*.test.mjs'

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DENY = join(ROOT, "tests", "deny-network.mjs");

function evalCli(args) {
  const dir = mkdtempSync(join(tmpdir(), "agent-eval-"));
  const report = join(dir, "network.jsonl");
  try {
    const out = spawnSync(process.execPath, ["--import", DENY, "evals/agent/eval.mjs", ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, DENY_NETWORK_REPORT: report },
    });
    const events = readFileSync(report, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    return { ...out, attempts: events.filter((e) => e.event === "exit").map((e) => e.attempts) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("--mode live is refused, non-zero, with no outbound attempt", () => {
  const out = evalCli(["--suite", "agent", "--mode", "live", "--subset", "ci"]);
  assert.notEqual(out.status, 0);
  assert.match(out.stderr, /live runs come in a later change/);
  assert.deepEqual(out.attempts, [0]);
});

test("--mode replay without recorded runs says so and exits 1", () => {
  const out = evalCli(["--suite", "agent", "--mode", "replay", "--subset", "ci"]);
  assert.equal(out.status, 1);
  assert.match(out.stderr, /no recorded runs/);
  assert.deepEqual(out.attempts, [0]);
});

test("--mode replay scores recorded runs on the subset, offline", () => {
  const out = evalCli([
    "--suite",
    "agent",
    "--mode",
    "replay",
    "--subset",
    "ci",
    "--runs",
    "evals/agent/testdata/runs",
  ]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /over 6 tracks \(subset: ci\)/);
  assert.deepEqual(out.attempts, [0]);
});

test("bad arguments exit 2", () => {
  for (const args of [
    [],
    ["--suite", "web", "--mode", "replay"],
    ["--suite", "agent", "--mode", "x"],
  ]) {
    const out = evalCli(args);
    assert.equal(out.status, 2, args.join(" "));
  }
});
