// Tests for the matching and input rules in coverage.mjs. No network access.
// Run with: node --test evals/scripts/

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { artistMatches, readJsonBody, titleMatches } from "./coverage.mjs";

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "coverage.mjs");

test("titles must be equal, never a substring", () => {
  assert.equal(titleMatches("Crazy", "Crazy in Love"), false);
  assert.equal(titleMatches("Hurt", "Hurts"), false);
  assert.equal(titleMatches("Creep", "Creepy"), false);
  assert.equal(titleMatches("Hurt", "Hurt So Bad"), false);
  assert.equal(titleMatches("Bohemian Rhapsody", "bohemian rhapsody"), true);
  assert.equal(titleMatches("De música ligera", "De Música Ligera"), true);
  assert.equal(titleMatches("MALAMENTE (Cap.1: Augurio)", "MALAMENTE Cap.1: Augurio"), true);
});

test("a qualifier the golden title lacks makes the titles differ", () => {
  assert.equal(titleMatches("Stronger", "Stronger (instrumental)"), false);
  assert.equal(titleMatches("Ice Ice Baby", "Ice Ice Baby (Radio Edit)"), false);
  assert.equal(titleMatches("Hurt", "Hurt (Live)"), false);
  assert.equal(titleMatches("Creep", "Creep (Acoustic)"), false);
  assert.equal(titleMatches("Hello", "Hello (Karaoke Version)"), false);
  assert.equal(titleMatches("Africa", "Africa (Demo)"), false);
  assert.equal(titleMatches("Levels", "Levels (Original Version)"), false);
  assert.equal(titleMatches("Ice Ice Baby (Radio Edit)", "Ice Ice Baby (Radio Edit)"), true);
});

test("remaster notes are neutral, whatever their wording", () => {
  assert.equal(titleMatches("Take On Me", "Take On Me (2014 Remastered Version)"), true);
  assert.equal(titleMatches("Take On Me", "Take On Me (Remastered 2023)"), true);
  assert.equal(titleMatches("Take On Me", "Take On Me - Remastered 2009"), true);
  assert.equal(titleMatches("Take On Me", "Take On Me - 2015 Remaster"), true);
  assert.equal(
    titleMatches("Take On Me", "Take On Me (2014 Remastered Version)"),
    titleMatches("Take On Me", "Take On Me (Remastered 2023)"),
  );
  assert.equal(titleMatches("Take On Me", "Take On Me (Live) [Remastered 2023]"), false);
});

test("featured-artist notes in titles are neutral", () => {
  assert.equal(titleMatches("Gangsta's Paradise", "Gangsta's Paradise (feat. L.V.)"), true);
});

test("a bracketed non-Latin title matches either part", () => {
  assert.equal(titleMatches("Gangnam Style (강남스타일)", "강남스타일"), true);
  assert.equal(titleMatches("강남스타일", "Gangnam Style (강남스타일)"), true);
  assert.equal(titleMatches("Gangnam Style", "Gangnam Style (강남스타일)"), true);
  assert.equal(titleMatches("夜に駆ける", "夜に駆ける"), true);
  assert.equal(titleMatches("夜に駆ける", "夜に駆ける - From THE FIRST TAKE"), false);
});

test("artists must be equal after removing featured credits", () => {
  assert.equal(artistMatches("PSY", ["Psychic TV"]), false);
  assert.equal(artistMatches("PSY", ["Psy"]), true);
  assert.equal(artistMatches("Eminem feat. Dido", ["Eminem"]), true);
  assert.equal(artistMatches("Puff Daddy & Faith Evans feat. 112", ["Diddy"]), false);
  assert.equal(artistMatches("ROSALÍA", ["Rosalia"]), true);
  assert.equal(artistMatches("The Andrew Oldham Orchestra", ["Andrew Oldham Orchestra"]), true);
  assert.equal(artistMatches("Queen", ["Queens of the Stone Age"]), false);
  assert.equal(artistMatches("Simon & Garfunkel", ["Simon and Garfunkel"]), true);
});

test("a timeout while reading the body is a failed lookup, not bad JSON", async () => {
  const timeout = Object.assign(new Error("The operation was aborted due to timeout"), {
    name: "TimeoutError",
  });
  const r = await readJsonBody({ text: () => Promise.reject(timeout) });
  assert.equal(r.kind, "fail");
  assert.match(r.error, /timeout/);
  assert.doesNotMatch(r.error, /not JSON/);

  const html = await readJsonBody({ text: () => Promise.resolve("<html>busy</html>") });
  assert.deepEqual(html, { kind: "fail", error: "response is not JSON" });

  const ok = await readJsonBody({ text: () => Promise.resolve('{"id":1}') });
  assert.deepEqual(ok, { kind: "ok", body: { id: 1 } });
});

function runWith(lines) {
  const dir = mkdtempSync(join(tmpdir(), "golden-"));
  try {
    const path = join(dir, "golden.jsonl");
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
    return spawnSync(process.execPath, [SCRIPT, "--golden", path, "--dry-run"], {
      encoding: "utf8",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("duplicate ISRCs and unknown strata are rejected before any lookup", () => {
  const row = { isrc: "GBDUW0000053", stratum: "documented-samples", title: "x", artist: "y" };
  const dup = runWith([row, row]);
  assert.equal(dup.status, 1);
  assert.match(dup.stderr, /duplicate isrc GBDUW0000053/);

  const bad = runWith([{ ...row, stratum: "misc" }]);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /unknown stratum "misc"/);
});
