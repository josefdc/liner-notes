// The perturbation set: deterministic in any locale, positives never taken from a verdict,
// mutations the cited excerpts do not support, the numeric cases through the app's own
// checkNumbers with exact expected results, and the blind label export.
// Run with: node --test 'evals/**/*.test.mjs' (the numeric test needs packages/contract built).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { COLUMNS, labelId, labelRows, toCsv } from "./export-labels.mjs";
import { checkSupport } from "./lib/support.mjs";
import {
  buildPerturb,
  MUTATIONS,
  PERTURB_PATH,
  positiveSource,
  readRecordings,
  serialise,
} from "./make-perturb.mjs";
import {
  CATEGORIES,
  loadCheckNumbers,
  readPerturb,
  runNumeric,
  summarise,
} from "./perturb-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const node = (args) => spawnSync(process.execPath, args, { encoding: "utf8", cwd: ROOT });

test("the generator writes the same bytes in any locale, and they are the committed file", () => {
  const first = node(["evals/agent/make-perturb.mjs", "--stdout"]);
  assert.equal(first.status, 0, first.stderr);
  for (const locale of ["da_DK.UTF-8", "lt_LT.UTF-8", "tr_TR.UTF-8"]) {
    const again = spawnSync(process.execPath, ["evals/agent/make-perturb.mjs", "--stdout"], {
      encoding: "utf8",
      cwd: ROOT,
      env: { ...process.env, LANG: locale, LC_ALL: locale },
    });
    assert.equal(again.status, 0, again.stderr);
    assert.equal(again.stdout, first.stdout, locale);
  }
  assert.equal(
    readFileSync(PERTURB_PATH, "utf8"),
    first.stdout,
    "evals/perturb.jsonl is stale: run node evals/agent/make-perturb.mjs",
  );
});

test("no case carries a verdict", () => {
  for (const c of readPerturb()) assert.equal(JSON.stringify(c).includes('"verdict'), false, c.id);
});

const claim = (origin, text, excerpt, verdict) => ({
  recording: "synthetic",
  claimId: "x",
  origin,
  kind: "sourced",
  about: "sample",
  text,
  verdict,
  evidence: [{ id: "e", source: "musicbrainz", url: "https://musicbrainz.org/x", excerpt }],
});

test("positives come from code or the support check, never from the judge's verdict", () => {
  const excerpt = 'MusicBrainz: "A Song" by Some Artist samples "Old Break" by Old Band.';
  // The judge said supported, but the excerpt does not back the claim: not a positive.
  assert.equal(
    positiveSource(claim("model", 'It samples "Another Break" by Old Band.', excerpt, "supported")),
    null,
  );
  // The judge said unsupported, but the excerpt backs every item: a positive.
  assert.equal(
    positiveSource(claim("model", 'It samples "Old Break" by Old Band.', excerpt, "unsupported")),
    "model-support-check",
  );
  // A code-built sourced claim is a positive whatever the verdict says.
  assert.equal(positiveSource(claim("code", "Anything.", excerpt, "unsupported")), "code");
});

test("in the committed set every positive is code-built or passes the support check", () => {
  const recordings = readRecordings();
  const cases = buildPerturb(recordings);
  const positives = cases.filter((c) => c.kind === "claim" && c.label === "supported");
  assert.ok(positives.length >= 20);
  for (const p of positives) {
    if (p.positiveSource === "code") assert.equal(p.claim.origin, "code", p.id);
    else {
      assert.equal(p.positiveSource, "model-support-check", p.id);
      const excerpts = p.evidence.map((e) => e.excerpt);
      assert.equal(checkSupport(p.claim.text, excerpts).supported, true, p.id);
    }
  }
  // The recordings hold a model claim the judge marked supported that the support check does
  // not pass (it adds an unchecked sentence): it is not a positive.
  const judgedSupported = recordings.flatMap((r) =>
    r.analysis.claims
      .filter((c) => c.origin === "model" && c.verdict === "supported")
      .map((c) => `${r.slug}:${c.id.slice(0, 8)}`),
  );
  const positiveIds = new Set(positives.map((p) => p.id));
  assert.ok(judgedSupported.some((id) => !positiveIds.has(id)));
});

test("every mutation kind is present, and each mutation differs from its positive", () => {
  const cases = readPerturb().filter((c) => c.kind === "claim");
  const byId = new Map(cases.map((c) => [c.id, c]));
  for (const kind of MUTATIONS)
    assert.ok(
      cases.some((c) => c.mutation === kind),
      kind,
    );
  for (const m of cases.filter((c) => c.mutation)) {
    const parent = byId.get(m.parentId);
    assert.equal(m.label, "unsupported");
    assert.ok(parent && parent.label === "supported", m.id);
    if (m.mutation === "irrelevant-excerpt") {
      assert.equal(m.claim.text, parent.claim.text);
      assert.notDeepEqual(m.evidence, parent.evidence);
    } else assert.notEqual(m.claim.text, parent.claim.text, m.id);
    // Every mutation, roles and relations included, is unsupported by what the case cites.
    const excerpts = m.evidence.map((e) => e.excerpt);
    assert.equal(checkSupport(m.claim.text, excerpts).supported, false, m.id);
  }
  // Every positive passes the support check, code-built ones included.
  for (const p of cases.filter((c) => c.label === "supported")) {
    assert.equal(
      checkSupport(
        p.claim.text,
        p.evidence.map((e) => e.excerpt),
      ).supported,
      true,
      p.id,
    );
  }
});

test("numeric cases: every branch of the check, each with its exact expected result", async () => {
  const numeric = readPerturb().filter((c) => c.kind === "numeric");
  const names = new Set(numeric.map((c) => c.case));
  for (const name of [
    "tempo-measured",
    "tempo-within-band",
    "tempo-range-around",
    "tempo-octave-x2",
    "tempo-octave-x0.5",
    "tempo-octave-x0.25",
    "tempo-octave-x4",
    "tempo-x1.5",
    "tempo-x2/3",
    "tempo-plus-3-percent",
    "tempo-x1.25",
    "tempo-x0.8",
    "tempo-x1.25-unmarked",
    "tempo-librosa-below-floor",
    "tempo-librosa-at-floor",
    "tempo-essentia-above-floor",
    "tempo-essentia-below-floor",
    "tempo-unknown-method-below-floor",
    "tempo-no-confidence",
    "key-measured",
    "key-flat-spelling",
    "key-no-mode",
    "key-relative",
    "key-parallel",
    "key-fifth-up",
    "key-fourth-up-other-mode",
    "key-whole-tone",
    "key-relative-interval-same-mode",
    "key-tritone",
    "key-whole-tone-unmarked",
    "key-whole-tone-weak",
    "key-whole-tone-at-floor",
    "key-whole-tone-no-strength",
  ]) {
    assert.ok(names.has(name), name);
  }
  for (const c of numeric) {
    assert.ok(CATEGORIES.includes(c.category), c.id);
    assert.ok(["consistent", "conflict", "contradicted"].includes(c.expect), c.id);
    // Synthetic blocks say so; a synthetic key is never marked as a signal measurement.
    if (c.claim.field === "key" || c.case.startsWith("key-")) {
      assert.deepEqual(c.synthetic, ["key"], c.id);
      assert.equal(c.audio.key.basis, "synthetic", c.id);
    }
    if (c.synthetic.length === 0) assert.equal(c.audio.key, null, c.id);
    // A tempo block whose confidence or method was set is not a signal measurement either.
    if (c.synthetic.includes("tempo.method")) assert.equal(c.audio.tempo.basis, "synthetic", c.id);
  }
  // Restatements of the measured value are most of the equivalents, not a token few.
  const consistent = numeric.filter((c) => c.expect === "consistent").length;
  assert.ok(consistent >= 20, `${consistent} restatements`);
  const checkNumbers = await loadCheckNumbers();
  const rows = runNumeric(numeric, checkNumbers);
  assert.deepEqual(
    rows.filter((r) => !r.ok).map((r) => `${r.id} ${r.case}: ${r.result} != ${r.expect}`),
    [],
  );
  const s = summarise(rows);
  assert.equal(s.equivalent.rejected, 0);
  assert.equal(s["estimator-error"].rejected, 0);
  assert.equal(s["false-caught"].rejected, s["false-caught"].n);
  assert.equal(s["false-shown-both"].rejected, 0);
});

test("perturb-check prints both sets of blocks, nothing unexpected, and the replayed judge's rates", () => {
  const out = node(["evals/agent/perturb-check.mjs"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /as expected (\d+)\/\1\b/);
  assert.match(out.stdout, /measured tempo blocks: \d+ cases\n {4}equivalents rejected: 0\//);
  assert.match(out.stdout, /synthetic blocks \(keys, confidence floors\): \d+ cases/);
  assert.match(out.stdout, /estimator errors rejected: 0\//);
  assert.match(out.stdout, /shown next to the measurement by design/);
  assert.doesNotMatch(out.stdout, /UNEXPECTED/);
  assert.match(
    out.stdout,
    /every case as in evals\/agent\/runs\/\d{4}-\d{2}-\d{2}\/perturb\/judge\.json: yes; spend lines 0/,
  );
  assert.match(out.stdout, /false-positive rate \(positives rejected\): \d+\/\d+/);
  assert.match(out.stdout, /catch rate \(mutations rejected\): \d+\/\d+/);
  assert.match(out.stdout, /model-positive pool: \d+ model claims cite evidence, \d+ pass/);
});

test("perturb-check exits 1 when a case gives another result than it expects", () => {
  const dir = mkdtempSync(join(tmpdir(), "perturb-"));
  try {
    const cases = readPerturb();
    const i = cases.findIndex((c) => c.case === "tempo-x1.25");
    cases[i] = { ...cases[i], expect: "conflict" };
    writeFileSync(join(dir, "p.jsonl"), serialise(cases));
    const out = node(["evals/agent/perturb-check.mjs", "--perturb", join(dir, "p.jsonl")]);
    assert.equal(out.status, 1);
    assert.match(out.stdout, /UNEXPECTED .*tempo-x1\.25.*gave contradicted, expected conflict/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("export-labels writes no verdict and nothing that gives the answer away", () => {
  const rows = labelRows("perturb");
  const salt = "0123456789abcdef0123456789abcdef";
  const { csv, key } = toCsv(rows, salt);
  const header = csv.split("\n")[0];
  assert.deepEqual(header.split(","), COLUMNS);
  assert.doesNotMatch(header, /verdict|mutation|positive/i);
  for (const word of ["verdict", "irrelevant-excerpt", "artist-or-title", "model-support-check"]) {
    assert.equal(csv.includes(word), false, word);
  }
  assert.equal(rows.length, readPerturb().filter((c) => c.kind === "claim").length);
  // The key maps every label id back to its case; without the salt the ids are not the plain
  // hash of the case id, so they cannot be recomputed from the committed set.
  assert.equal(Object.keys(key.labels).length, rows.length);
  assert.equal(key.salt, salt);
  const first = rows[0].id;
  assert.equal(key.labels[labelId(salt, first)], first);
  assert.notEqual(labelId("another-salt-0000000000", first), labelId(salt, first));
  assert.equal(csv.includes(createHash("sha256").update(first).digest("hex").slice(0, 12)), false);
  // The same salt gives the same CSV; another salt, other ids and another order.
  assert.equal(toCsv(rows, salt).csv, csv);
  const other = toCsv(rows, "fedcba9876543210fedcba9876543210").csv;
  assert.notEqual(other.split("\n")[1].split(",")[0], csv.split("\n")[1].split(",")[0]);
  assert.throws(() => toCsv(rows, "short"), /salt/);
  // The recordings' claims carry verdicts; the rows exported from them do not.
  const fromRecordings = labelRows("recordings");
  assert.ok(fromRecordings.length > 0);
  for (const r of fromRecordings) {
    assert.deepEqual(Object.keys(r).sort(), ["claim", "excerpts", "id", "recording", "urls"]);
  }
});

test("export-labels needs a key path away from the CSV, and writes the key there", () => {
  const dir = mkdtempSync(join(tmpdir(), "labels-"));
  const keyDir = mkdtempSync(join(tmpdir(), "labels-key-"));
  try {
    const none = node(["evals/agent/export-labels.mjs", "--out", join(dir, "l.csv")]);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /--key <path> is needed/);
    const beside = node([
      "evals/agent/export-labels.mjs",
      "--out",
      join(dir, "l.csv"),
      "--key",
      join(dir, "key.json"),
    ]);
    assert.equal(beside.status, 1);
    assert.match(beside.stderr, /must not be in the CSV's directory/);
    const keyInRepo = join(ROOT, "evals", `.labels-key-test-${process.pid}.json`);
    try {
      const inRepo = node([
        "evals/agent/export-labels.mjs",
        "--out",
        join(dir, "l.csv"),
        "--key",
        keyInRepo,
      ]);
      assert.equal(inRepo.status, 1);
      assert.match(inRepo.stderr, /--key must be outside the repository/);
      assert.equal(existsSync(keyInRepo), false);
    } finally {
      rmSync(keyInRepo, { force: true });
    }
    const ok = node([
      "evals/agent/export-labels.mjs",
      "--out",
      join(dir, "l.csv"),
      "--key",
      join(keyDir, "key.json"),
    ]);
    assert.equal(ok.status, 0, ok.stderr);
    const key = JSON.parse(readFileSync(join(keyDir, "key.json"), "utf8"));
    assert.match(key.salt, /^[0-9a-f]{32}$/);
    const csv = readFileSync(join(dir, "l.csv"), "utf8");
    assert.equal(csv.trimEnd().split("\n").length > 1, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
  }
});

test("serialise ends every line with a newline and keeps the order", () => {
  const text = serialise([{ a: 1 }, { b: 2 }]);
  assert.equal(text, '{"a":1}\n{"b":2}\n');
});
