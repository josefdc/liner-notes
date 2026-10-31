// The `npm run eval` entry point: live runs are refused with no outbound connection, replay
// needs recorded runs. Run with: node --test 'evals/**/*.test.mjs'

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // A directory that does not exist, so a local evals/agent/runs/ does not change the result.
  const dir = mkdtempSync(join(tmpdir(), "agent-eval-runs-"));
  try {
    const out = evalCli([
      "--suite",
      "agent",
      "--mode",
      "replay",
      "--subset",
      "ci",
      "--runs",
      join(dir, "none"),
    ]);
    assert.equal(out.status, 1);
    assert.match(out.stderr, /no recorded runs/);
    assert.deepEqual(out.attempts, [0]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--mode replay names the subset rows that have no run record and exits 1", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-eval-runs-"));
  try {
    const d = JSON.parse(
      readFileSync(join(ROOT, "evals/agent/testdata/runs/ablation-d.json"), "utf8"),
    );
    const kept = d.filter((r) => ["GBDUW0000053", "USBB40000359"].includes(r.isrc));
    writeFileSync(join(dir, "d.json"), JSON.stringify(kept));
    const out = evalCli(["--suite", "agent", "--mode", "replay", "--subset", "ci", "--runs", dir]);
    assert.equal(out.status, 1);
    assert.match(
      out.stderr,
      /subset ci has rows with no run record: row d: GBAAA9700049 \(Bitter Sweet Symphony\)/,
    );
    for (const isrc of ["USWB19900178", "USDJ20200650", "JPP301900716"]) {
      assert.match(out.stderr, new RegExp(isrc));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
