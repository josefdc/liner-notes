#!/usr/bin/env node
// Runs evals/perturb.jsonl through the verifier's parts, at no spend.
//
// - Numeric part: every numeric case goes through the app's own checkNumbers
//   (apps/api/src/agent/verifier/numeric.ts, loaded with tsx; it is pure and makes no call), and
//   must give exactly the result it expects (consistent, conflict or contradicted). A case is
//   "rejected" when the result is `contradicted`. It prints, by category and separately for the
//   measured tempo blocks and the synthetic ones (the key blocks, the confidence-floor cases):
//   equivalents and estimator errors rejected (must be 0), false values caught, and false values
//   shown next to the measurement instead (by the check's design: unmarked, or below the floor).
// - Judge part: the judge's answers on the claim cases come from a judge recording. Until one is
//   committed, it prints "pending: no judge recording", which is not a failure.
//
//   node evals/agent/perturb-check.mjs [--perturb <path>]
//
// Exits 1 when any numeric case gives another result than it expects. Needs the contract
// package built (npm run build -w packages/contract), as the API does.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { EVALS_DIR, REPO_ROOT } from "./lib/golden.mjs";
import { MIN_N_FOR_RATE, wilson } from "./lib/stats.mjs";

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

export const CATEGORIES = ["equivalent", "estimator-error", "false-caught", "false-shown-both"];

/** Every numeric case through checkNumbers, with its result and whether it is as expected. */
export function runNumeric(cases, checkNumbers) {
  return cases
    .filter((c) => c.kind === "numeric")
    .map((c) => {
      const out = checkNumbers(c.claim, c.audio, c.context);
      return {
        ...c,
        result: out.numericCheck,
        rejected: out.numericCheck === "contradicted",
        ok: out.numericCheck === c.expect,
      };
    });
}

/** Counts by category: n, rejected, as expected. */
export function summarise(rows) {
  return Object.fromEntries(
    CATEGORIES.map((category) => {
      const xs = rows.filter((r) => r.category === category);
      return [
        category,
        {
          n: xs.length,
          rejected: xs.filter((r) => r.rejected).length,
          ok: xs.filter((r) => r.ok).length,
        },
      ];
    }),
  );
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

const rateText = (k, n) =>
  n >= MIN_N_FOR_RATE
    ? `${k}/${n} = ${pct(k / n)} (95 % CI ${interval(k, n)})`
    : `${k}/${n} (counts only, n < ${MIN_N_FOR_RATE})`;

function printSummary(label, rows) {
  const s = summarise(rows);
  const falses = s["false-caught"].n + s["false-shown-both"].n;
  const caught = s["false-caught"].rejected + s["false-shown-both"].rejected;
  console.log(`  ${label}: ${rows.length} cases`);
  console.log(`    equivalents rejected: ${rateText(s.equivalent.rejected, s.equivalent.n)}`);
  console.log(
    `    estimator errors rejected: ${rateText(s["estimator-error"].rejected, s["estimator-error"].n)}`,
  );
  console.log(`    false values rejected: ${rateText(caught, falses)}`);
  console.log(
    `      of which shown next to the measurement by design (unmarked, or below the floor): ${s["false-shown-both"].n}`,
  );
}

async function main() {
  const at = process.argv.indexOf("--perturb");
  const cases = readPerturb(at > 0 ? process.argv[at + 1] : undefined);
  const checkNumbers = await loadCheckNumbers();
  const rows = runNumeric(cases, checkNumbers);
  const claimCases = cases.filter((c) => c.kind === "claim");
  console.log(
    `perturbation set: ${cases.length} cases (${claimCases.length} claim, ${rows.length} numeric)`,
  );
  console.log("numeric check (checkNumbers, apps/api/src/agent/verifier/numeric.ts):");
  const s = summarise(rows);
  console.log(
    `  by category: ${CATEGORIES.map((c) => `${c} ${s[c].n}`).join(", ")}; as expected ${rows.filter((r) => r.ok).length}/${rows.length}`,
  );
  printSummary(
    "measured tempo blocks",
    rows.filter((r) => r.synthetic.length === 0),
  );
  printSummary(
    "synthetic blocks (keys, confidence floors)",
    rows.filter((r) => r.synthetic.length > 0),
  );
  const wrong = rows.filter((r) => !r.ok);
  for (const r of wrong) {
    console.log(
      `  UNEXPECTED ${r.id} (${r.category}, ${r.case}): ${r.claim.text} gave ${r.result}, expected ${r.expect}`,
    );
  }
  const recordings = judgeRecordings();
  console.log("judge (claim cases):");
  if (recordings.length === 0) console.log("  pending: no judge recording");
  else {
    console.log(
      `  pending: ${recordings.length} judge recording(s) found, but reading them comes with the golden run`,
    );
  }
  const missing = CATEGORIES.filter((c) => s[c].n === 0);
  if (missing.length) {
    console.error(`perturb-check: no numeric case in ${missing.join(", ")}`);
    process.exit(1);
  }
  if (wrong.length) {
    console.error(`perturb-check: ${wrong.length} numeric case(s) not as expected`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`perturb-check: ${error.message}`);
    process.exit(1);
  });
}
