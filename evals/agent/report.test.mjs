// The report renderer and its checker, on the synthetic test data in testdata/.
// Run with: node --test 'evals/**/*.test.mjs'

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkReport } from "./check-report.mjs";
import { testdataFiles } from "./testdata/make-testdata.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const TESTDATA = join(HERE, "testdata");
const node = (args) =>
  spawnSync(process.execPath, args, { encoding: "utf8", cwd: join(HERE, "..", "..") });

test("the committed test data is what make-testdata.mjs writes", () => {
  for (const [path, text] of Object.entries(testdataFiles())) {
    assert.equal(
      readFileSync(join(TESTDATA, path), "utf8"),
      text,
      `evals/agent/testdata/${path} is stale: run node evals/agent/testdata/make-testdata.mjs`,
    );
  }
});

test("the good report passes check-report", () => {
  assert.deepEqual(checkReport(join(TESTDATA, "report-good.md")), []);
  const cli = node(["evals/agent/check-report.mjs", "evals/agent/testdata/report-good.md"]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /ok/);
});

const BROKEN = {
  "report-no-ci.md": /no "95 % CI" column/,
  "report-no-ablation-d.md": /ablation row d/,
  "report-no-clarification.md": /clarification rate/,
  "report-heldout-unexcluded.md": /counted against the per-run domain exclusion/,
};

for (const [name, message] of Object.entries(BROKEN)) {
  test(`check-report exits 1 on ${name}, naming what is missing`, () => {
    const cli = node(["evals/agent/check-report.mjs", `evals/agent/testdata/${name}`]);
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, message);
  });
}

test("check-report needs the results file to check the held-out exclusion", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-report-"));
  try {
    const path = join(dir, "agent-latest.md");
    copyFileSync(join(TESTDATA, "report-good.md"), path);
    assert.match(checkReport(path).join("\n"), /results file report-good\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the report states dataset, n, CI, date, commit, the golden sha256 and the clarification rate", () => {
  const md = readFileSync(join(TESTDATA, "report-good.md"), "utf8");
  assert.match(md, /\*\*Dataset\*\*: `evals\/golden\.jsonl`, sha256 `[0-9a-f]{64}`/);
  assert.match(md, /\*\*Date\*\*: 2026-10-31/);
  assert.match(md, /\*\*Commit\*\*: `synthetic`/);
  assert.match(md, /\| clarification rate \| [\d.]+ % \(\d+\/24\) \| 24 \| \[/);
  assert.match(md, /Synthetic test data/);
  // Gold is described by its sources, never as human-labelled.
  assert.match(md, /\*\*Gold\*\* is described by its sources[^\n]*wikipedia\.org/);
  assert.doesNotMatch(md.replace("none is human-labelled", ""), /human-labelled/);
});

test("strata with n < 10 are shown as counts, not rates", () => {
  const md = readFileSync(join(TESTDATA, "report-good.md"), "utf8");
  const strata = md.split("## Per stratum")[1].split("\n## ")[0];
  assert.match(
    strata,
    /\| no-sample-controls \| hallucinated-sample rate \| \d\/5 \| 5 \| counts only \(n < 10\) \|/,
  );
  assert.match(
    strata,
    /\| documented-samples \| identity accuracy \| [\d.]+ % \(\d+\/13\) \| 13 \| \[/,
  );
  // A rate on a small stratum is refused.
  const dir = mkdtempSync(join(tmpdir(), "agent-report-"));
  try {
    const path = join(dir, "report.md");
    const broken = md.replace(
      /\| ambiguous-titles \| identity accuracy \| 1\/2 \| 2 \| counts only \(n < 10\) \|/,
      "| ambiguous-titles | identity accuracy | 50.0 % (1/2) | 2 | [9.5 %, 90.5 %] |",
    );
    assert.notEqual(broken, md);
    copyFileSync(join(TESTDATA, "report-good.json"), join(dir, "report-good.json"));
    writeFileSync(path, broken);
    assert.match(checkReport(path).join("\n"), /must be shown as counts/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("eval:table renders the test runs; --out writes the dated report, its JSON and agent-latest.md", () => {
  const printed = node([
    "evals/agent/report.mjs",
    "--runs",
    "evals/agent/testdata/runs",
    "--date",
    "2026-10-31",
    "--commit",
    "synthetic",
  ]);
  assert.equal(printed.status, 0, printed.stderr);
  assert.match(printed.stdout, /^# Agent evals, 2026-10-31/);
  const dir = mkdtempSync(join(tmpdir(), "agent-report-"));
  try {
    const out = node([
      "evals/agent/report.mjs",
      "--runs",
      "evals/agent/testdata/runs",
      "--out",
      dir,
      "--date",
      "2026-10-31",
    ]);
    assert.equal(out.status, 0, out.stderr);
    const dated = readFileSync(join(dir, "agent-2026-10-31.md"), "utf8");
    assert.equal(readFileSync(join(dir, "agent-latest.md"), "utf8"), dated);
    assert.deepEqual(checkReport(join(dir, "agent-latest.md")), []);
    assert.ok(JSON.parse(readFileSync(join(dir, "agent-2026-10-31.json"), "utf8")).heldOut.d);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
