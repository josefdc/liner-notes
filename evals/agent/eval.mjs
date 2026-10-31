#!/usr/bin/env node
// The eval entry point (`npm run eval -- …`).
//
//   npm run eval -- --suite agent --mode replay --subset ci|all [--runs <dir>]
//       replays the subset's analyses through the API from the committed cassettes
//       (fixtures/cassettes/{llm,sources}/golden/<isrc>), checks each gives the committed run
//       records (rows b, c and d) with no outbound connection and no spend line, then scores
//       the committed records on the subset and prints the report. Exits 1 when a replay
//       differs, and says how to record the subset again. Default records: the newest
//       directory under evals/agent/runs. With --score-only, it only scores the records (any
//       directory of them, such as the synthetic test data), with no replay.
//   npm run eval -- --suite agent --mode live --subset ci|all --out <dir> --cassettes <dir>
//       --db <file> --spend-log <file> [run.mjs options]
//       records the subset again through the API (model and source calls, purpose
//       eval:golden) by running `node evals/agent/run.mjs --mode live --suite golden`.
//
// The audio suite has its own harness (evals/audio, run with uv).

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT } from "./lib/golden.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));

export function parseArgs(argv) {
  const opts = { subset: "ci", rest: [], scoreOnly: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--score-only") {
      opts.scoreOnly = true;
      continue;
    }
    if (!["--suite", "--mode", "--subset", "--runs"].includes(flag)) {
      // A live run passes the rest on to run.mjs, which checks it.
      opts.rest.push(flag);
      continue;
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
  if (opts.mode !== "live" && opts.rest.length) throw new Error(`unknown argument ${opts.rest[0]}`);
  if (opts.scoreOnly && opts.mode !== "replay")
    throw new Error("--score-only is for --mode replay");
  if (opts.mode === "live" && opts.runs)
    throw new Error("--runs is for --mode replay; a live run takes --out");
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
  if (opts.mode === "live") {
    const args = [join(HERE, "run.mjs"), "--mode", "live", "--suite", "golden"];
    args.push("--subset", opts.subset, ...opts.rest);
    const { status } = spawnSync(process.execPath, args, { stdio: "inherit", cwd: REPO_ROOT });
    process.exit(status ?? 1);
  }
  const { newestRuns, replay } = await import("./run.mjs");
  const runs = opts.runs ? resolve(opts.runs) : newestRuns();
  if (!runs || !existsSync(runs)) {
    console.error(
      `eval: no recorded runs in ${runs ? relative(REPO_ROOT, runs) : "evals/agent/runs"}`,
    );
    process.exit(1);
  }
  if (!opts.scoreOnly) {
    const { ok, lines } = await replay({ subset: opts.subset, runs });
    console.log(lines.join("\n"));
    if (!ok) process.exit(1);
  }
  const { buildReport } = await import("./report.mjs");
  const { md } = await buildReport({ runs, subset: opts.subset });
  process.stdout.write(`\n${md}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`eval: ${error.message}`);
    process.exit(1);
  });
}
