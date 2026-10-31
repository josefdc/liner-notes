#!/usr/bin/env node
// The eval entry point (`npm run eval -- …`).
//
//   npm run eval -- --suite agent --mode replay --subset ci|all [--runs <dir>]
//       scores recorded run records (default evals/agent/runs) on the subset and prints the
//       report; no network, no model
//   npm run eval -- --suite agent --mode live …
//       refused: live runs come in a later change
//
// The audio suite has its own harness (evals/audio, run with uv).

import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { EVALS_DIR, REPO_ROOT } from "./lib/golden.mjs";

export const DEFAULT_RUNS = join(EVALS_DIR, "agent", "runs");

export function parseArgs(argv) {
  const opts = { subset: "ci" };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!["--suite", "--mode", "--subset", "--runs"].includes(flag)) {
      throw new Error(`unknown argument ${flag}`);
    }
    if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
    opts[flag.slice(2)] = value;
    i++;
  }
  if (opts.suite !== "agent") {
    throw new Error(
      opts.suite === "audio"
        ? "the audio suite runs from evals/audio (see evals/audio/README.md)"
        : "--suite agent is required",
    );
  }
  if (!["replay", "live"].includes(opts.mode)) throw new Error("--mode replay or live");
  if (!["ci", "all"].includes(opts.subset)) throw new Error("--subset ci or all");
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`eval: ${error.message}`);
    process.exit(2);
  }
  // Refused before anything else is loaded: a live run makes model and source calls.
  if (opts.mode === "live") {
    console.error("eval: live runs come in a later change; nothing was run");
    process.exit(2);
  }
  const runs = resolve(opts.runs ?? DEFAULT_RUNS);
  if (!existsSync(runs)) {
    console.error(
      `eval: no recorded runs in ${relative(REPO_ROOT, runs) || runs}; the golden run that replays from them comes in a later change`,
    );
    process.exit(1);
  }
  const { buildReport } = await import("./report.mjs");
  const { md } = await buildReport({ runs, subset: opts.subset });
  process.stdout.write(md);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`eval: ${error.message}`);
    process.exit(1);
  });
}
