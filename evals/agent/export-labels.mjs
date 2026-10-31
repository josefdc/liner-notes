#!/usr/bin/env node
// Writes the claims a person can label blind, as CSV: the claim, the excerpts it cites and empty
// columns for the label. It carries no judge verdict and nothing that gives the expected answer
// away (no construction label, mutation or positive source). Case ids name the mutation, so each
// row carries an opaque `label_id` instead: HMAC-SHA256 of the case id under a salt, its first 16
// hex digits. The rows are shuffled with a seed drawn from the same salt. The salt is random
// unless given, so the ids and the order cannot be recomputed from the committed set without the
// key: a JSON file with the salt and every label id's case id, written to `--key`. Keep the key
// away from the people labelling: the CLI refuses a key in the CSV's directory or anywhere in the
// repository.
//
//   node evals/agent/export-labels.mjs --key ~/labels-key.json                the claim cases of evals/perturb.jsonl
//   node evals/agent/export-labels.mjs --from recordings --key <path>         the claims of the recordings the set is made from
//   ... --out labels.csv                                                      write a file instead of stdout
//   ... --salt <hex>                                                          a given salt, to write the same CSV again

import { createHmac, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REPO_ROOT } from "./lib/golden.mjs";
import { readRecordings } from "./make-perturb.mjs";
import { readPerturb } from "./perturb-check.mjs";
import { rng } from "./lib/stats.mjs";

export const COLUMNS = [
  "label_id",
  "recording",
  "claim",
  "excerpts",
  "evidence_urls",
  "label_supported",
  "labeller",
  "notes",
];

/** The opaque id a CSV row carries for a case id, under a salt. */
export const labelId = (salt, id) =>
  createHmac("sha256", salt).update(id).digest("hex").slice(0, 16);

/** The shuffle seed a salt gives (a 32-bit integer). */
const seedOf = (salt) => createHmac("sha256", salt).update("order").digest().readUInt32BE(0);

export const randomSalt = () => randomBytes(16).toString("hex");

const csvCell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Rows to label, without verdicts or expected answers. */
export function labelRows(from = "perturb") {
  if (from === "perturb") {
    return readPerturb()
      .filter((c) => c.kind === "claim")
      .map((c) => ({
        id: c.id,
        recording: c.recording,
        claim: c.claim.text,
        excerpts: c.evidence.map((e) => e.excerpt),
        urls: c.evidence.map((e) => e.url),
      }));
  }
  if (from === "recordings") {
    return readRecordings().flatMap((r) => {
      const byId = new Map(r.analysis.evidence.map((e) => [e.id, e]));
      return r.analysis.claims.map((c) => {
        const cited = c.evidenceIds.map((id) => byId.get(id)).filter(Boolean);
        return {
          id: `${r.slug}:${c.id}`,
          recording: r.slug,
          claim: c.text,
          excerpts: cited.map((e) => e.excerpt),
          urls: cited.map((e) => e.url),
        };
      });
    });
  }
  throw new Error(`--from: perturb or recordings, not "${from}"`);
}

/** The CSV and its key ({ salt, labels: { label_id: case id } }) for rows, under a salt. */
export function toCsv(rows, salt) {
  if (typeof salt !== "string" || salt.length < 16) {
    throw new Error("a salt of at least 16 characters is needed");
  }
  const next = rng(seedOf(salt));
  const order = [...rows];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const lines = [COLUMNS.join(",")];
  const labels = {};
  for (const r of order) {
    const id = labelId(salt, r.id);
    if (labels[id]) throw new Error(`label id ${id} given twice`);
    labels[id] = r.id;
    lines.push(
      [id, r.recording, r.claim, r.excerpts.join("\n"), r.urls.join("\n"), "", "", ""]
        .map(csvCell)
        .join(","),
    );
  }
  return { csv: `${lines.join("\n")}\n`, key: { salt, labels } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  try {
    const keyPath = arg("--key");
    const out = arg("--out");
    if (!keyPath) {
      throw new Error("--key <path> is needed: the key maps label ids back to cases");
    }
    if (!relative(REPO_ROOT, resolve(keyPath)).startsWith("..")) {
      throw new Error("--key must be outside the repository, where it cannot be committed");
    }
    if (out && dirname(resolve(out)) === dirname(resolve(keyPath))) {
      throw new Error(
        "--key must not be in the CSV's directory: the people labelling must not see it",
      );
    }
    const { csv, key } = toCsv(
      labelRows(arg("--from") ?? "perturb"),
      arg("--salt") ?? randomSalt(),
    );
    writeFileSync(keyPath, `${JSON.stringify(key, null, 2)}\n`);
    if (out) {
      writeFileSync(out, csv);
      console.error(`wrote ${out} (key: ${keyPath})`);
    } else process.stdout.write(csv);
  } catch (error) {
    console.error(`export-labels: ${error.message}`);
    process.exit(1);
  }
}
