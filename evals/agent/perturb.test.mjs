// The perturbation set: deterministic, positives never taken from a verdict, mutations the
// cited excerpts do not support, and the numeric cases through the app's own checkNumbers.
// Run with: node --test 'evals/**/*.test.mjs' (the numeric test needs packages/contract built).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { COLUMNS, labelRows, toCsv } from "./export-labels.mjs";
import { checkSupport } from "./lib/support.mjs";
import {
  buildPerturb,
  MUTATIONS,
  PERTURB_PATH,
  positiveSource,
  readRecordings,
  serialise,
} from "./make-perturb.mjs";
import { loadCheckNumbers, readPerturb, runNumeric } from "./perturb-check.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const node = (args) => spawnSync(process.execPath, args, { encoding: "utf8", cwd: ROOT });

test("the generator writes the same bytes twice, and they are the committed file", () => {
  const first = node(["evals/agent/make-perturb.mjs", "--stdout"]);
  const second = node(["evals/agent/make-perturb.mjs", "--stdout"]);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, second.stdout);
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
    // A changed title, artist or year, or an excerpt from another recording, is not backed by
    // what the case cites.
    if (["artist-or-title", "year", "irrelevant-excerpt"].includes(m.mutation)) {
      const excerpts = m.evidence.map((e) => e.excerpt);
      assert.equal(checkSupport(m.claim.text, excerpts).supported, false, m.id);
    }
  }
});

test("numeric cases: octave and relative-key equivalents and false values, through checkNumbers", async () => {
  const cases = readPerturb();
  const kinds = new Set(cases.filter((c) => c.kind === "numeric").map((c) => c.case));
  for (const k of ["equivalent-octave", "equivalent-relative-key", "false-tempo", "false-key"]) {
    assert.ok(kinds.has(k), k);
  }
  for (const c of cases.filter((x) => x.keySource === "synthetic"))
    assert.equal(c.claim.field, "key");
  const checkNumbers = await loadCheckNumbers();
  const { equivalents, falses } = runNumeric(cases, checkNumbers);
  assert.deepEqual(
    equivalents.filter((r) => r.rejected).map((r) => r.id),
    [],
    "an equivalent was rejected",
  );
  assert.deepEqual(
    falses.filter((r) => !r.rejected).map((r) => r.id),
    [],
    "a false value was not caught",
  );
  // The octave and relative-key equivalents are shown as conflicts, not hidden as agreement.
  for (const r of equivalents.filter((x) => x.case.startsWith("equivalent"))) {
    assert.equal(r.result, "conflict", r.id);
  }
});

test("perturb-check prints the rates, 0 equivalents rejected, and the pending judge", () => {
  const out = node(["evals/agent/perturb-check.mjs"]);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /equivalents rejected: 0\/\d+/);
  const [, caught, all] = out.stdout.match(/false values caught: (\d+)\/(\d+)/);
  assert.equal(caught, all);
  assert.match(out.stdout, /catch rate: 100\.0 %/);
  assert.match(out.stdout, /false-positive rate: 0\.0 %/);
  assert.match(out.stdout, /pending: no judge recording/);
});

test("export-labels writes no verdict and nothing that gives the answer away", () => {
  const rows = labelRows("perturb");
  const csv = toCsv(rows);
  const header = csv.split("\n")[0];
  assert.deepEqual(header.split(","), COLUMNS);
  assert.doesNotMatch(header, /verdict|mutation|positive/i);
  for (const word of ["verdict", "irrelevant-excerpt", "artist-or-title", "model-support-check"]) {
    assert.equal(csv.includes(word), false, word);
  }
  assert.equal(rows.length, readPerturb().filter((c) => c.kind === "claim").length);
  // The recordings' claims carry verdicts; the rows exported from them do not.
  const fromRecordings = labelRows("recordings");
  assert.ok(fromRecordings.length > 0);
  for (const r of fromRecordings) {
    assert.deepEqual(Object.keys(r).sort(), ["claim", "excerpts", "id", "recording", "urls"]);
  }
});

test("serialise ends every line with a newline and keeps the order", () => {
  const text = serialise([{ a: 1 }, { b: 2 }]);
  assert.equal(text, '{"a":1}\n{"b":2}\n');
});
