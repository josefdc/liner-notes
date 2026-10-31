#!/usr/bin/env node
// Runs evals/perturb.jsonl through the verifier's parts, at no spend.
//
// - Numeric part: every numeric case goes through the app's own checkNumbers
//   (apps/api/src/agent/verifier/numeric.ts, loaded with tsx; it is pure and makes no call). A
//   case is "rejected" when the check says `contradicted`. Equivalents (the measured value, its
//   octaves, the relative key) must never be rejected; false values must all be.
// - Judge part: the judge's answers on the claim cases come from a judge recording. Until one is
//   committed, it prints "pending: no judge recording", which is not a failure.
//
//   node evals/agent/perturb-check.mjs [--perturb <path>]
//
// Exits 1 when an equivalent is rejected or a false value is not caught. Needs the contract
// package built (npm run build -w packages/contract), as the API does.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EVALS_DIR, REPO_ROOT } from "./lib/golden.mjs";
import { wilson } from "./lib/stats.mjs";

export const NUMERIC_MODULE = join(REPO_ROOT, "apps/api/src/agent/verifier/numeric.ts");
export const JUDGE_RECORDINGS = join(REPO_ROOT, "fixtures/cassettes/llm/perturb");
const CONTRACT_DIST = join(REPO_ROOT, "packages/contract/dist/index.js");

export function readPerturb(path = join(EVALS_DIR, "perturb.jsonl")) {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

/** The app's checkNumbers, loaded from its TypeScript source. */
export async function loadCheckNumbers() {
  if (!existsSync(CONTRACT_DIST)) {
    throw new Error("packages/contract is not built: run `npm run build -w packages/contract`");
  }
  const { tsImport } = await import("tsx/esm/api");
  const mod = await tsImport(pathToFileURL(NUMERIC_MODULE).href, import.meta.url);
  return mod.checkNumbers;
}

/** The numeric cases' results: { equivalents, falses, rows }. */
export function runNumeric(cases, checkNumbers) {
  const rows = cases
    .filter((c) => c.kind === "numeric")
    .map((c) => {
      const out = checkNumbers(c.claim, c.audio, c.context);
      return { ...c, result: out.numericCheck, rejected: out.numericCheck === "contradicted" };
    });
  const equivalents = rows.filter((r) => r.expect === "not-rejected");
  const falses = rows.filter((r) => r.expect === "rejected");
  return { rows, equivalents, falses };
}

const pct = (x) => `${(100 * x).toFixed(1)} %`;
const interval = (k, n) => {
  const ci = wilson(k, n);
  return ci ? `[${pct(ci[0])}, ${pct(ci[1])}]` : "none (n = 0)";
};

function judgeRecordings() {
  if (!existsSync(JUDGE_RECORDINGS)) return [];
  return readdirSync(JUDGE_RECORDINGS).filter((n) => n.endsWith(".json"));
}

async function main() {
  const at = process.argv.indexOf("--perturb");
  const cases = readPerturb(at > 0 ? process.argv[at + 1] : undefined);
  const checkNumbers = await loadCheckNumbers();
  const { equivalents, falses } = runNumeric(cases, checkNumbers);
  const rejected = equivalents.filter((r) => r.rejected);
  const caught = falses.filter((r) => r.rejected);
  const claimCases = cases.filter((c) => c.kind === "claim");

  console.log(
    `perturbation set: ${cases.length} cases (${claimCases.length} claim, ${equivalents.length + falses.length} numeric)`,
  );
  console.log("numeric check (checkNumbers, apps/api/src/agent/verifier/numeric.ts):");
  console.log(`  equivalents rejected: ${rejected.length}/${equivalents.length}`);
  console.log(`  false values caught: ${caught.length}/${falses.length}`);
  if (falses.length) {
    console.log(
      `  catch rate: ${pct(caught.length / falses.length)} (n = ${falses.length}, 95 % CI ${interval(caught.length, falses.length)})`,
    );
  }
  if (equivalents.length) {
    console.log(
      `  false-positive rate: ${pct(rejected.length / equivalents.length)} (n = ${equivalents.length}, 95 % CI ${interval(rejected.length, equivalents.length)})`,
    );
  }
  for (const r of rejected)
    console.log(`  REJECTED equivalent ${r.id}: ${r.claim.text} (${r.case})`);
  for (const r of falses.filter((x) => !x.rejected)) {
    console.log(`  MISSED false value ${r.id}: ${r.claim.text} (${r.result})`);
  }
  const recordings = judgeRecordings();
  console.log("judge (claim cases):");
  if (recordings.length === 0) console.log("  pending: no judge recording");
  else {
    console.log(
      `  pending: ${recordings.length} judge recording(s) found, but reading them comes with the golden run`,
    );
  }
  if (equivalents.length === 0 || falses.length === 0) {
    console.error("perturb-check: the set has no numeric equivalents or no false values");
    process.exit(1);
  }
  if (rejected.length || caught.length !== falses.length) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`perturb-check: ${error.message}`);
    process.exit(1);
  });
}
