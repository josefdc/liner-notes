// The report renderer and its checker, on the synthetic test data in testdata/: the good report
// passes, and each broken one fails with its own message.
// Run with: node --test 'evals/**/*.test.mjs'

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkCells,
  checkPublishedStatements,
  checkReport,
  MADE_BY_PEOPLE,
  parseReport,
} from "./check-report.mjs";
import { escapeMd, statCells } from "./report.mjs";
import { testdataFiles } from "./testdata/make-testdata.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
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
    /held-out row d: the runs' evidence excludes 1 of 1 targets \(n after exclusion 0\); the report says 0 \(1\)/,
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

test("a published report: no synthetic or testdata records, well-formed commits", async () => {
  const problems = (
    await checkReport(join(TESTDATA, "report-good.md"), { reportsDir: TESTDATA })
  ).join("\n");
  assert.match(problems, /synthetic run records cannot be published/);
  assert.match(problems, /run records under a testdata directory cannot be published/);
  assert.match(problems, /commit synthetic is not a commit id \(7 to 40 hex digits\)/);
});

test("a published report scores evals/golden.jsonl, checked by content, at any commit", async () => {
  const head = spawnSync("git", ["rev-parse", "--short=12", "HEAD"], {
    encoding: "utf8",
    cwd: ROOT,
  }).stdout.trim();
  const dir = mkdtempSync(join(tmpdir(), "agent-published-"));
  try {
    // Real-looking records: the test runs without the synthetic flag, at the current commit,
    // with a spend line and the source errors as the live harness records them.
    const runs = join(dir, "runs");
    mkdirSync(runs);
    const call = { tier: "main", deployment: "test", usd: 0, inputTokens: 0, outputTokens: 0 };
    for (const name of [
      "ablation-a.json",
      "ablation-b.json",
      "ablation-c.json",
      "ablation-d.json",
    ]) {
      const records = JSON.parse(readFileSync(join(TESTDATA, "runs", name), "utf8")).map(
        ({ synthetic, ...r }) => ({ ...r, commit: head, calls: [call], sourceErrors: [] }),
      );
      writeFileSync(join(runs, name), JSON.stringify(records));
    }
    // A forged copy of the golden set, with the unmatched row d proposals added as gold.
    const forged = join(dir, "golden-forged.jsonl");
    writeFileSync(
      forged,
      readFileSync(join(ROOT, "evals/golden.jsonl"), "utf8").replace(/\n$/, "\n\n"),
    );
    const reports = join(dir, "reports");
    for (const [golden, message] of [
      [forged, /must score evals\/golden\.jsonl, not /],
      [join(ROOT, "evals/golden.jsonl"), null],
    ]) {
      const out = node([
        "evals/agent/report.mjs",
        "--runs",
        runs,
        "--golden",
        golden,
        "--subset",
        "all",
        "--out",
        reports,
        "--date",
        "2026-10-31",
        "--commit",
        head,
      ]);
      assert.equal(out.status, 0, out.stderr);
      const problems = (
        await checkReport(join(reports, "agent-latest.md"), { reportsDir: reports })
      ).join("\n");
      if (message) assert.match(problems, message);
      else assert.equal(problems, "");
    }
    // The header's sha256 changed to the forged file's: not the golden file in the tree.
    const path = join(reports, "agent-latest.md");
    const md = readFileSync(path, "utf8");
    const forgedSha = createHash("sha256").update(readFileSync(forged)).digest("hex");
    writeFileSync(
      path,
      md.replace(/sha256 `[0-9a-f]{64}`; 45 rows/, `sha256 \`${forgedSha}\`; 45 rows`),
    );
    const problems = (await checkReport(path, { reportsDir: reports })).join("\n");
    assert.match(
      problems,
      /dataset evals\/golden\.jsonl is not the one scored \(the report states sha256 [0-9a-f]{64}, the file's is now [0-9a-f]{64}\): a changed golden file needs the report rendered again/,
    );
    // A commit that is in no history (a squashed branch's) is provenance, not a problem; one
    // that is not an id is.
    const elsewhere = "5fd193fa7a64";
    for (const name of [
      "ablation-a.json",
      "ablation-b.json",
      "ablation-c.json",
      "ablation-d.json",
    ]) {
      const file = join(runs, name);
      const records = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify(records.map((r) => ({ ...r, commit: elsewhere }))));
    }
    const squashed = join(dir, "squashed");
    const again = node([
      "evals/agent/report.mjs",
      "--runs",
      runs,
      "--subset",
      "all",
      "--out",
      squashed,
      "--date",
      "2026-10-31",
      "--commit",
      "0123456789ab",
    ]);
    assert.equal(again.status, 0, again.stderr);
    const squashedPath = join(squashed, "agent-latest.md");
    assert.deepEqual(await checkReport(squashedPath, { reportsDir: squashed }), []);
    writeFileSync(
      squashedPath,
      readFileSync(squashedPath, "utf8").replace("`0123456789ab`", "`not-a-commit`"),
    );
    assert.match(
      (await checkReport(squashedPath, { reportsDir: squashed })).join("\n"),
      /commit not-a-commit is not a commit id/,
    );
    // Rendered "as recorded", a published report could leave out tracks whose runs crashed.
    const loose = join(dir, "loose");
    const asRecorded = node([
      "evals/agent/report.mjs",
      "--runs",
      runs,
      "--out",
      loose,
      "--commit",
      head,
    ]);
    assert.equal(asRecorded.status, 0, asRecorded.stderr);
    assert.match(
      (await checkReport(join(loose, "agent-latest.md"), { reportsDir: loose })).join("\n"),
      /must be rendered with --subset ci or all, not "as recorded"/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("report.mjs refuses to publish testdata records in evals/reports", () => {
  // A directory of its own under evals/reports, removed afterwards, so a regression cannot
  // overwrite a committed report.
  const out = join(ROOT, "evals", "reports", `.refusal-test-${process.pid}`);
  try {
    const r = node([
      "evals/agent/report.mjs",
      "--runs",
      "evals/agent/testdata/runs",
      "--subset",
      "all",
      "--out",
      out,
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /testdata directory cannot be published in evals\/reports/);
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a published report needs --subset, and names the rows whose runs are missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-crashed-"));
  // Under evals/reports, in a directory of its own, removed afterwards.
  const out = join(ROOT, "evals", "reports", `.subset-test-${process.pid}`);
  try {
    // Three tracks crashed: no record in any ablation.
    const dropped = ["GBAAA9700049", "USWB19900178", "JPP301900716"];
    for (const name of readdirSync(join(TESTDATA, "runs"))) {
      const records = JSON.parse(readFileSync(join(TESTDATA, "runs", name), "utf8"));
      writeFileSync(
        join(dir, name),
        JSON.stringify(records.filter((r) => !dropped.includes(r.isrc))),
      );
    }
    const loose = node(["evals/agent/report.mjs", "--runs", dir, "--out", out]);
    assert.equal(loose.status, 1);
    assert.match(loose.stderr, /needs --subset ci or all/);
    const all = node(["evals/agent/report.mjs", "--runs", dir, "--subset", "all", "--out", out]);
    assert.equal(all.status, 1);
    assert.match(all.stderr, /subset all has rows with no run record: row a: .*; row d: /);
    for (const isrc of dropped) assert.match(all.stderr, new RegExp(isrc));
    assert.equal(existsSync(out), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  }
});

test("a report whose run records changed since says so", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-report-"));
  try {
    const runs = join(dir, "runs");
    mkdirSync(runs);
    for (const name of readdirSync(join(TESTDATA, "runs"))) {
      copyFileSync(join(TESTDATA, "runs", name), join(runs, name));
    }
    const out = node([
      "evals/agent/report.mjs",
      "--runs",
      runs,
      "--out",
      dir,
      "--date",
      "2026-10-31",
      "--commit",
      "synthetic",
    ]);
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(await checkReport(join(dir, "agent-latest.md")), []);
    // The provenance note is part of the records: added, it changes their sha256 until the
    // report is rendered again, and then it is in the header.
    writeFileSync(join(runs, "provenance.txt"), "Recorded at a branch's head.\n");
    assert.match(
      (await checkReport(join(dir, "agent-latest.md"))).join("\n"),
      /changed since the report/,
    );
    const noted = node([
      "evals/agent/report.mjs",
      "--runs",
      runs,
      "--out",
      dir,
      "--date",
      "2026-10-31",
      "--commit",
      "synthetic",
    ]);
    assert.equal(noted.status, 0, noted.stderr);
    assert.match(
      readFileSync(join(dir, "agent-latest.md"), "utf8"),
      /^- \*\*Provenance\*\*: Recorded at a branch's head\.$/m,
    );
    assert.deepEqual(await checkReport(join(dir, "agent-latest.md")), []);
    const pilot = join(runs, "variance.json");
    writeFileSync(pilot, readFileSync(pilot, "utf8").replace(/\n$/, " \n"));
    assert.match(
      (await checkReport(join(dir, "agent-latest.md"))).join("\n"),
      /changed since the report \(the report states sha256 [0-9a-f]{64}, the records' is now [0-9a-f]{64}\)/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a statistic whose resamples are all equal says so, and the checker accepts only that", () => {
  const s = { n: 12, value: 1, ci: [1, 1], values: Array(12).fill(1) };
  const [value, n, ci] = statCells(s, (x) => x.toFixed(2));
  assert.equal(ci, "[1.00, 1.00] (all resamples equal)");
  assert.deepEqual(checkCells("x", value, String(n), ci), []);
  // Ties at a cap can give a zero-width interval although some resamples differ: no mark.
  const tied = {
    n: 24,
    value: 120,
    ci: [120, 120],
    values: [...Array(8).fill(120), ...Array(16).fill(50)],
  };
  const [tv, tn, tci] = statCells(tied, (x) => x.toFixed(1));
  assert.equal(tci, "[120.0, 120.0]");
  assert.deepEqual(checkCells("x", tv, String(tn), tci), []);
  assert.match(checkCells("x", "1.00", "12", "[0.90, 1.00] (all resamples equal)").join(), /width/);
});

test("titles from run records are escaped in the report", () => {
  assert.equal(escapeMd("A *b* [c](d) # e | f"), "A \\*b\\* \\[c\\](d) \\# e \\| f");
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
  assert.match(
    md,
    /\*\*Run records\*\*: `evals\/agent\/testdata\/runs`, sha256 `[0-9a-f]{64}`; 103 records/,
  );
  assert.match(md, /\*\*Date\*\*: 2026-10-31/);
  assert.match(md, /\*\*Commit\*\*: `synthetic`/);
  assert.match(md, /\| clarification rate \| [\d.]+ % \(\d+\/24\) \| 24 \| \[/);
  assert.match(md, /Synthetic test data/);
  // Gold is described by its sources; nothing says a person made a label.
  assert.match(md, /\*\*Gold\*\* is described by its sources[^\n]*wikipedia\.org/);
  assert.doesNotMatch(md, MADE_BY_PEOPLE);
  // The held-out exclusion is explained by site, and a small n after it is called out.
  assert.match(md, /Targets excluded, by the cited site: \(d\) wikipedia\.org 1\./);
  assert.match(
    md,
    /Few held-out targets \(\(a\) 1 of 1;.*?\(d\) 0 of 1\): only gold targets that no queried source/,
  );
  // Inside precision's counts and outside them, said apart.
  assert.match(
    md,
    /False positives with the right target and the wrong relation, included in precision: \(a\) 0/,
  );
  assert.match(md, /Left out of precision: \(a\) 0 duplicate/);
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

test("the published report passes, and names its models, source errors and classifier", async () => {
  const path = join(ROOT, "evals", "reports", "agent-latest.md");
  assert.deepEqual(await checkReport(path), []);
  const md = readFileSync(path, "utf8");
  const statements = (text) => {
    const problems = [];
    checkPublishedStatements(text, parseReport(text), problems);
    return problems;
  };
  assert.deepEqual(statements(md), []);
  const cut = (pattern) => md.replace(pattern, "");
  assert.deepEqual(statements(cut(/^- \*\*Second judge\*\*: .*\n/m)), [
    "header: the second judge, or that there is none",
  ]);
  assert.deepEqual(statements(cut(/^\| runs with at least one source error.*\n/m)), [
    "the source-error rate",
  ]);
  assert.deepEqual(statements(cut(/^\| mutations of code positives rejected.*\n/m)), [
    "the verifier's catch rate for code positives",
  ]);
  assert.deepEqual(statements(cut(/^Model-positive pool: .*\n/m)), [
    "the model-positive pool size",
  ]);
  assert.deepEqual(statements(cut(/^### Audit of the model positives\n/m)), [
    "the audit of the model positives, or that it is pending",
  ]);
});

test('"n/a (by construction)" is accepted only on a count of none or all of n', () => {
  assert.deepEqual(checkCells("x", "0/70", "70", "n/a (by construction)"), []);
  assert.deepEqual(checkCells("x", "70/70", "70", "n/a (by construction)"), []);
  assert.equal(checkCells("x", "3/70", "70", "n/a (by construction)").length, 1);
  assert.equal(checkCells("x", "0.0 % (0/70)", "70", "n/a (by construction)").length, 1);
  assert.equal(checkCells("x", "0/69", "70", "n/a (by construction)").length, 1);
});
