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
// - Judge part: the claim cases go through the app's judge again, answered from its recording
//   (fixtures/cassettes/llm/perturb; no network, no spending), and the verdicts must be the ones
//   in the judge record of the newest run-record directory (evals/agent/runs/<date>/perturb/
//   judge.json). It prints the false-positive rate (positives rejected) and the catch rate
//   (mutations rejected), overall, per positive source and per mutation. With no judge record
//   it prints "pending: no judge recording", which is not a failure.
//
//   node evals/agent/perturb-check.mjs [--perturb <path>]
//
// Exits 1 when any numeric case gives another result than it expects, or when the replayed
// verdicts differ from the record, a replayed call would spend, or the record was made on
// another perturbation set. Needs the contract package built (npm run build -w
// packages/contract), as the API does.

import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
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
  console.log("judge (claim cases):");
  const judgeProblems = await judgePart(at > 0 ? resolve(process.argv[at + 1]) : PERTURB_PATH);
  const missing = CATEGORIES.filter((c) => s[c].n === 0);
  if (missing.length) {
    console.error(`perturb-check: no numeric case in ${missing.join(", ")}`);
    process.exit(1);
  }
  if (wrong.length) {
    console.error(`perturb-check: ${wrong.length} numeric case(s) not as expected`);
    process.exit(1);
  }
  if (judgeProblems.length) {
    for (const p of judgeProblems) console.error(`perturb-check: ${p}`);
    process.exit(1);
  }
}

const PERTURB_PATH = join(EVALS_DIR, "perturb.jsonl");

/**
 * The judge on the claim cases, replayed from its recording and compared with the committed
 * judge record; prints the rates and returns the problems found.
 */
async function judgePart(perturbPath) {
  const { newestRuns } = await import("./run.mjs");
  const { classifier, readPerturbRecords } = await import("./lib/extras.mjs");
  const runs = newestRuns();
  const { judge } = runs ? readPerturbRecords(runs) : { judge: null };
  if (!judge) {
    console.log("  pending: no judge recording");
    return [];
  }
  const where = relative(REPO_ROOT, runs);
  const sha = createHash("sha256").update(readFileSync(perturbPath)).digest("hex");
  if (judge.perturb.sha256 !== sha) {
    return [
      `the judge record in ${where} was made on another perturbation set (sha256 ${judge.perturb.sha256}, now ${sha}): record the judge again`,
    ];
  }
  if (!existsSync(JUDGE_RECORDINGS))
    return [`no judge recording in ${relative(REPO_ROOT, JUDGE_RECORDINGS)}`];
  const scratch = mkdtempSync(join(tmpdir(), "perturb-check-"));
  const spendLog = join(scratch, "spend.jsonl");
  writeFileSync(spendLog, "");
  try {
    const { judgeAll } = await import("./perturb-judge.mjs");
    const log = console.log;
    console.log = () => {};
    let cases;
    try {
      ({ cases } = await judgeAll({
        mode: "replay",
        cassetteDir: JUDGE_RECORDINGS,
        spendLog,
        perturbPath,
      }));
    } finally {
      console.log = log;
    }
    const problems = [];
    const recorded = new Map(judge.cases.map((c) => [c.id, c.verdict]));
    const differ = cases.filter((c) => recorded.get(c.id) !== c.verdict);
    if (differ.length || cases.length !== judge.cases.length) {
      problems.push(
        `${differ.length} replayed verdict(s) differ from ${where}/perturb/judge.json (${cases.length} cases replayed, ${judge.cases.length} recorded)`,
      );
    }
    const spent = readFileSync(spendLog, "utf8")
      .split("\n")
      .filter((l) => l.trim()).length;
    if (spent) problems.push(`${spent} spend line(s) from a replay`);
    const c = classifier({ ...judge, cases });
    console.log(
      `  the app's judge (${c.judge.deployments.join(", ")}), replayed from ${relative(REPO_ROOT, JUDGE_RECORDINGS)}: ${cases.length} cases, ${c.unjudged} not judged; verdicts as in ${where}/perturb/judge.json: ${differ.length ? "no" : "yes"}; spend lines ${spent}`,
    );
    const both = (label, b) => {
      console.log(`  ${label}`);
      console.log(
        `    false-positive rate (positives rejected): ${rateText(b.falsePositive.k, b.falsePositive.n)}`,
      );
      console.log(`    catch rate (mutations rejected): ${rateText(b.catch.k, b.catch.n)}`);
    };
    both("all claim cases", c.overall);
    for (const b of c.bySource) both(`${b.source} positives and their mutations`, b);
    for (const m of c.byMutation)
      console.log(`  mutation ${m.mutation} rejected: ${rateText(m.k, m.n)}`);
    console.log(
      `  model-positive pool: ${c.pool.modelClaimsCitingEvidence} model claims cite evidence, ${c.pool.passedSupportCheck} pass the support check`,
    );
    return problems;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`perturb-check: ${error.message}`);
    process.exit(1);
  });
}
