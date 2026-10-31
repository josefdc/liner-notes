#!/usr/bin/env node
// Gathers the per-track files a live run writes (run.mjs, baseline.mjs) into one directory of
// run records, in golden-file order: a.json (the model-only baseline), b.json, c.json, d.json
// (the golden run) and d-repeat.json (the variance re-run, row d only). No call of any kind.
//
//   node evals/agent/assemble.mjs --golden <dir> [--variance <dir>] [--baseline <dir>] --to <dir>
//
// Each input directory holds <ISRC>.json files as run.mjs and baseline.mjs write them. Every row
// of the live subset must have a golden record and, when --baseline is given, a baseline one; a
// row the variance re-run did not cover is simply not repeated.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readGolden, subsetRows } from "./lib/golden.mjs";

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const v = argv[++i];
    if (!["--golden", "--variance", "--baseline", "--to"].includes(flag)) {
      throw new Error(`unknown argument ${flag}`);
    }
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    opts[flag.slice(2)] = resolve(v);
  }
  if (!opts.golden || !opts.to) throw new Error("--golden <dir> and --to <dir> are required");
  return opts;
}

const read = (dir, isrc) => {
  const path = join(dir, `${isrc}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).records : null;
};
const write = (dir, name, records) =>
  writeFileSync(join(dir, name), `${JSON.stringify(records, null, 2)}\n`);

/** The record lists of each output file, from the per-track files. */
export function assemble(rows, { golden, variance, baseline }) {
  const out = { a: [], b: [], c: [], d: [], "d-repeat": [] };
  const missing = [];
  for (const row of rows) {
    const g = read(golden, row.isrc);
    if (!g) missing.push(`${row.isrc} (golden)`);
    else for (const id of ["b", "c", "d"]) out[id].push(g[id]);
    if (baseline) {
      const a = read(baseline, row.isrc);
      if (!a) missing.push(`${row.isrc} (baseline)`);
      else out.a.push(a.a);
    }
    const v = variance ? read(variance, row.isrc) : null;
    if (v) out["d-repeat"].push(v.d);
  }
  if (missing.length) throw new Error(`no record for ${missing.join(", ")}`);
  return out;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rows = subsetRows(readGolden(), "all");
  const out = assemble(rows, opts);
  mkdirSync(opts.to, { recursive: true });
  for (const [name, records] of Object.entries(out)) {
    if (records.length) write(opts.to, `${name}.json`, records);
  }
  console.log(
    Object.entries(out)
      .map(([name, records]) => `${name}.json ${records.length}`)
      .join(", "),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`assemble: ${error.message}`);
    process.exit(1);
  }
}
