#!/usr/bin/env node
// Writes the claims a person can label blind, as CSV: the claim, the excerpts it cites and empty
// columns for the label. It carries no judge verdict and nothing that gives the expected answer
// away (no construction label, mutation or positive source), and the rows are shuffled at a
// fixed seed, so a mutated claim does not sit next to the claim it came from. Case ids name the
// mutation, so the CSV carries `label_id` instead: the first 12 hex digits of the sha256 of the
// case id (labelId below), which maps each row back to its case.
//
//   node evals/agent/export-labels.mjs                    the claim cases of evals/perturb.jsonl
//   node evals/agent/export-labels.mjs --from recordings  the claims of fixtures/replays/*.json
//   ... --out labels.csv                                  write a file instead of stdout

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const SEED = 33;

/** The opaque id a CSV row carries for a case id. */
export const labelId = (id) => createHash("sha256").update(id).digest("hex").slice(0, 12);

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

export function toCsv(rows, seed = SEED) {
  const next = rng(seed);
  const order = [...rows];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const lines = [COLUMNS.join(",")];
  for (const r of order) {
    lines.push(
      [labelId(r.id), r.recording, r.claim, r.excerpts.join("\n"), r.urls.join("\n"), "", "", ""]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  try {
    const csv = toCsv(labelRows(arg("--from") ?? "perturb"));
    const out = arg("--out");
    if (out) {
      writeFileSync(out, csv);
      console.error(`wrote ${out}`);
    } else process.stdout.write(csv);
  } catch (error) {
    console.error(`export-labels: ${error.message}`);
    process.exit(1);
  }
}
