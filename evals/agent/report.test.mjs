// The report renderer and its checker, on the synthetic test data in testdata/: the good report
// passes, and each broken one fails with its own message.
// Run with: node --test 'evals/**/*.test.mjs'

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkReport, MADE_BY_PEOPLE } from "./check-report.mjs";
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

test("the good report passes check-report", async () => {
  assert.deepEqual(await checkReport(join(TESTDATA, "report-good.md")), []);
  const cli = node(["evals/agent/check-report.mjs", "evals/agent/testdata/report-good.md"]);
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /ok/);
});

// Each broken report, the message check-report must give, and whether the structural checks
// alone (without re-rendering from the run records) catch it.
const BROKEN = {
  "report-no-ci.md": [/no "95 % CI" column/, true],
  "report-no-ablation-d.md": [/ablation row d/, true],
  "report-no-clarification.md": [/the clarification rate/, true],
  "report-indented-no-n.md": [/an indented table line/, true],
  "report-html-table.md": [/an HTML table/, true],
  "report-ci-mismatch.md": [/4\/6 does not match n = 600/, true],
  "report-ci-not-numeric.md": [/is not the Wilson interval \[0\.7 %, 20\.2 %\] of 1\/24/, true],
  "report-ci-reversed.md": [/interval \[51\.3 s, 44\.4 s\] is reversed/, true],
  "report-fake-ablation.md": [/not the Wilson interval \[81\.6 %, 100\.0 %\] of 17\/17/, true],
  "report-fake-consistent.md": [
    /not what its run records give \(line \d+: expected "\| d \|/,
    false,
  ],
  "report-heldout-unexcluded.md": [
    /held-out row d: the runs' evidence excludes 6 of 15 targets \(n after exclusion 9\); the report says 0 \(15\)/,
    false,
  ],
  "report-human-labelled.md": [/labels described as made by people \("Human-labelled"\)/, true],
  "report-human-elsewhere.md": [
    /labels described as made by people \("labelled by the author"\)/,
    true,
  ],
  "report-stratum-rate.md": [
    /n = 5 < 10 must be shown as counts, not as a rate \("20\.0 % \(1\/5\)"\)/,
    true,
  ],
  "report-stratum-decimal.md": [/must be shown as counts, not as a rate \("rate 0\.20"\)/, true],
  "report-synthetic-no-banner.md": [/the synthetic-data banner/, false],
  "report-not-measured.md": [/"not measured" although n = 24/, true],
};

test("every broken report in the test data is listed here", () => {
  const broken = Object.keys(testdataFiles()).filter(
    (p) => p.startsWith("report-") && p.endsWith(".md") && p !== "report-good.md",
  );
  assert.deepEqual(broken.sort(), Object.keys(BROKEN).sort());
});

for (const [name, [message, structural]] of Object.entries(BROKEN)) {
  test(`check-report exits 1 on ${name}, naming what is wrong`, async () => {
    const cli = node(["evals/agent/check-report.mjs", `evals/agent/testdata/${name}`]);
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, message);
    const alone = await checkReport(join(TESTDATA, name), { truth: false });
    if (structural) assert.match(alone.join("\n"), message, "the structural checks catch it alone");
    else assert.deepEqual(alone, [], "only re-rendering from the run records catches it");
  });
}

test("check-report needs the results file, the run records and the same golden file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-report-"));
  try {
    const path = join(dir, "agent-latest.md");
    const md = readFileSync(join(TESTDATA, "report-good.md"), "utf8");
    writeFileSync(path, md);
    assert.match((await checkReport(path)).join("\n"), /results file report-good\.json not found/);
    copyFileSync(join(TESTDATA, "report-good.json"), join(dir, "report-good.json"));
    assert.deepEqual(await checkReport(path), []);
    writeFileSync(
      path,
      md.replace("`evals/agent/testdata/runs`", "`evals/agent/testdata/nowhere`"),
    );
    assert.match(
      (await checkReport(path)).join("\n"),
      /run records evals\/agent\/testdata\/nowhere not found/,
    );
    writeFileSync(path, md.replace(/sha256 `[0-9a-f]{64}`/, `sha256 \`${"0".repeat(64)}\``));
    assert.match((await checkReport(path)).join("\n"), /is not the one scored/);
    writeFileSync(path, md.replace("- **Run records**", "- **Runs**"));
    assert.match((await checkReport(path)).join("\n"), /header: the run records/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a report of synthetic run records cannot be published in evals/reports", async () => {
  const problems = await checkReport(join(TESTDATA, "report-good.md"), { reportsDir: TESTDATA });
  assert.match(problems.join("\n"), /synthetic run records cannot be published/);
});

test("the people-made-labels check is case-insensitive and catches the usual phrasings", () => {
  for (const text of [
    "human-labelled",
    "Hand-Labeled",
    "HUMAN LABELLED",
    "manually annotated",
    "two annotators",
    "labelled by a person",
    "labeled by people",
    "Labelled by the author",
  ]) {
    assert.match(text, MADE_BY_PEOPLE, text);
  }
  for (const text of [
    "Agreement with human labels",
    "no labels from people exist",
    "labelled sources",
  ]) {
    assert.doesNotMatch(text, MADE_BY_PEOPLE, text);
  }
});

test("the report states dataset, run records, n, CI, date, commit and the clarification rate", () => {
  const md = readFileSync(join(TESTDATA, "report-good.md"), "utf8");
  assert.match(md, /\*\*Dataset\*\*: `evals\/golden\.jsonl`, sha256 `[0-9a-f]{64}`/);
  assert.match(md, /\*\*Run records\*\*: `evals\/agent\/testdata\/runs`; 102 records/);
  assert.match(md, /\*\*Date\*\*: 2026-10-31/);
  assert.match(md, /\*\*Commit\*\*: `synthetic`/);
  assert.match(md, /\| clarification rate \| [\d.]+ % \(\d+\/24\) \| 24 \| \[/);
  assert.match(md, /Synthetic test data/);
  // Gold is described by its sources; nothing says a person made a label.
  assert.match(md, /\*\*Gold\*\* is described by its sources[^\n]*wikipedia\.org/);
  assert.doesNotMatch(md, MADE_BY_PEOPLE);
  // The held-out exclusion is explained by site, and a small n after it is called out.
  assert.match(md, /Targets excluded, by the cited site: \(b\) wikipedia\.org 6/);
  assert.match(md, /Few held-out targets remain after the exclusion/);
});

test("no rate and no interval below n = 10, in any table", () => {
  const md = readFileSync(join(TESTDATA, "report-good.md"), "utf8");
  assert.match(
    md,
    /\| no-sample-controls \| hallucinated-sample rate \| \d\/5 \| 5 \| counts only \(n < 10\) \|/,
  );
  // The ablation table's n = 5 rows too: counts, or the per-track values.
  assert.match(
    md,
    /\| d \| [^|]+ \| hallucinated-sample rate \| 1\/5 \| 5 \| counts only \(n < 10\) \|/,
  );
  assert.match(
    md,
    /\| d \| [^|]+ \| edges per no-sample track \(mean\) \| values 0\.00, 0\.00, 0\.00, 1\.00, 0\.00 \| 5 \| counts only/,
  );
  assert.match(
    md,
    /\| documented-samples \| identity accuracy \| [\d.]+ % \(\d+\/13\) \| 13 \| \[/,
  );
  for (const line of md.split("\n").filter((l) => l.startsWith("| "))) {
    const cells = line.split(" | ");
    const n = cells.find(
      (c, i) => i > 0 && /^\d+$/.test(c) && /counts only/.test(cells[i + 1] ?? ""),
    );
    if (n !== undefined) assert.doesNotMatch(line, /\d %/, line);
  }
});

test("eval:table renders the test runs; --out writes the dated report, its JSON and agent-latest.md", async () => {
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
    assert.deepEqual(await checkReport(join(dir, "agent-latest.md")), []);
    assert.ok(JSON.parse(readFileSync(join(dir, "agent-2026-10-31.json"), "utf8")).heldOut.d);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
