#!/usr/bin/env node
// Prints the counts that describe the golden set, so documentation can point
// here instead of repeating numbers that drift.
//
// Usage: node evals/scripts/summary.mjs [--golden <path>]

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const at = args.indexOf("--golden");
const path = at >= 0 ? args[at + 1] : resolve(HERE, "..", "golden.jsonl");

const rows = readFileSync(path, "utf8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

const host = (u) => new URL(u).hostname.replace(/^www\./, "");
const heldOut = (r) => r.labels.edges.some((e) => e.sourceQueriedByPipeline === false);
const count = (xs, key) =>
  xs.reduce((m, x) => {
    const k = key(x);
    m[k] = (m[k] ?? 0) + 1;
    return m;
  }, {});

const live = rows.filter((r) => r.liveSubset);
const edges = rows.flatMap((r) => r.labels.edges);
const samples = rows.filter((r) => r.stratum === "documented-samples");
const heldOutDomains = new Set(
  samples.flatMap((r) =>
    r.labels.edges.filter((e) => e.sourceQueriedByPipeline === false).map((e) => host(e.sourceUrl)),
  ),
);

console.log(`rows: ${rows.length}`);
console.log(
  "rows per stratum:",
  count(rows, (r) => r.stratum),
);
console.log(`live subset: ${live.length}`);
console.log(
  "live per stratum:",
  count(live, (r) => r.stratum),
);
console.log("live n per metric:", {
  "edge recall (live rows with gold edges)": live.filter((r) => r.labels.edges.length).length,
  "edge precision (all live rows)": live.length,
  "held-out recall (live rows with held-out edges)": live.filter(heldOut).length,
  "hallucinated-sample rate (live no-sample controls)": live.filter(
    (r) => r.stratum === "no-sample-controls",
  ).length,
  "identity accuracy (all live rows)": live.length,
});
console.log(
  `edges: ${edges.length} (queried sources: ${edges.filter((e) => e.sourceQueriedByPipeline).length}, held-out: ${edges.filter((e) => !e.sourceQueriedByPipeline).length})`,
);
console.log(`rows with edgesExhaustive: ${rows.filter((r) => r.labels.edgesExhaustive).length}`);
console.log(
  `otherDocumentedTargets entries: ${rows.reduce((n, r) => n + r.labels.otherDocumentedTargets.length, 0)}`,
);
console.log(`documented-samples rows with held-out edges: ${samples.filter(heldOut).length}`);
console.log(
  `held-out source domains (documented-samples): ${heldOutDomains.size} — ${[...heldOutDomains].sort().join(", ")}`,
);
