// What the pages of a golden run show, by kind: how many of their claims and song-relation links
// are sourced or inferred, and how many of their tracks have a measured tempo, key and loudness
// or have none (missing, with the reason). Read from the committed normalised results of the
// run (evals/agent/runs/<date>/results/<isrc>.json: row d, the result each page shows, first
// run), so it needs no network and no model.
//
//   node evals/agent/kinds.mjs              writes evals/reports/agent-kinds.md and
//                                           docs/images/agent-kinds.svg
//   node evals/agent/kinds.mjs --check      exits 1 when either file is not what it would write
//   node evals/agent/kinds.mjs --json       prints the counts
//
// The audio values are read from the result's v2 audio block (`audio`): a value is measured when
// the block has it, and missing otherwise, with the block's reason for withholding it
// (`audio.withheld`), or the result's reason for having no block (`audioUnavailableReason`).
// The flat `audioSource` field is not used: it reads "unavailable" whenever no key is measured,
// even beside a measured tempo. The style and mood scores (classifier outputs, which the app
// shows as inferred) are not counted.
//
// The claims are those the result keeps (one per fact, after the verifier), each with its kind;
// the links are the song-relations map's (`genealogy.links`). Neither is ever measured, and an
// audio value is never sourced or inferred: the app takes measured values from the audio
// service only.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

import { REPO_ROOT } from "./lib/golden.mjs";
import { MIN_N_FOR_RATE, wilson } from "./lib/stats.mjs";

export const DEFAULT_RUNS = join(REPO_ROOT, "evals/agent/runs/2026-10-31");
export const REPORT_PATH = join(REPO_ROOT, "evals/reports/agent-kinds.md");
export const CHART_PATH = join(REPO_ROOT, "docs/images/agent-kinds.svg");
/** The tag that pins the commit the run was recorded at (it is not in main's history). */
export const RUN_TAG = "golden-run-2026-10-31";

export const KINDS = ["measured", "sourced", "inferred", "missing"];
const AUDIO_FIELDS = [
  ["tempo", "Tempo"],
  ["key", "Key"],
  ["loudness", "Loudness"],
];

/** The normalised results of a run, in file-name order, with the files' combined sha256. */
export function readResults(runs = DEFAULT_RUNS) {
  const dir = join(runs, "results");
  const hash = createHash("sha256");
  const results = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => {
      const text = readFileSync(join(dir, name), "utf8");
      hash.update(text);
      return { name, result: JSON.parse(text) };
    });
  return { dir, results, sha256: hash.digest("hex") };
}

const empty = () => Object.fromEntries(KINDS.map((kind) => [kind, 0]));

/**
 * The counts by kind: one row each for the claims, the links, and each audio value (one per
 * track). `reasons` counts each missing value's reason; `origins` splits the sourced claims by
 * who wrote them (code-built from a record, or a model claim the judge found supported).
 */
export function countKinds(results) {
  const claims = { label: "Claims", unit: "claims", counts: empty(), origins: {} };
  const links = { label: "Song-relation links", unit: "links", counts: empty() };
  const audio = AUDIO_FIELDS.map(([field, label]) => ({
    field,
    label,
    unit: "tracks",
    counts: empty(),
    reasons: {},
  }));
  for (const { result } of results) {
    for (const claim of result.claims ?? []) {
      if (!(claim.kind in claims.counts)) throw new Error(`a claim of kind ${claim.kind}`);
      claims.counts[claim.kind]++;
      if (claim.kind === "sourced") {
        claims.origins[claim.origin] = (claims.origins[claim.origin] ?? 0) + 1;
      }
    }
    for (const link of result.genealogy?.links ?? []) {
      if (!(link.kind in links.counts)) throw new Error(`a link of kind ${link.kind}`);
      links.counts[link.kind]++;
    }
    for (const row of audio) {
      const block = result.audio;
      if (block?.[row.field] != null) {
        row.counts.measured++;
        continue;
      }
      row.counts.missing++;
      const reason = block
        ? (block.withheld?.[row.field]?.code ?? "not given")
        : (result.audioUnavailableReason ?? "not given");
      row.reasons[reason] = (row.reasons[reason] ?? 0) + 1;
    }
  }
  return [claims, links, ...audio].map((row) => ({
    ...row,
    n: KINDS.reduce((sum, kind) => sum + row.counts[kind], 0),
  }));
}

const pct = (x) => `${(100 * x).toFixed(1)} %`;

/** "k/n = x % [lo, hi]", or "k/n" below MIN_N_FOR_RATE, or "0" for a kind a row cannot have. */
export function share(k, n) {
  if (n < MIN_N_FOR_RATE) return `${k}/${n}`;
  const [lo, hi] = wilson(k, n);
  return `${k}/${n} = ${pct(k / n)} [${(100 * lo).toFixed(1)}, ${(100 * hi).toFixed(1)}]`;
}

const reasonList = (reasons) =>
  Object.entries(reasons)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([code, count]) => `\`${code}\` ${count}`)
    .join(", ");

/** The Markdown report. */
export function renderReport(rows, { runs, sha256, count, date, commit }) {
  const runsPath = relative(REPO_ROOT, runs);
  const cell = (row, kind) => {
    const never =
      (row.unit === "tracks" && (kind === "sourced" || kind === "inferred")) ||
      (row.unit !== "tracks" && (kind === "measured" || kind === "missing"));
    return never ? "never" : share(row.counts[kind], row.n);
  };
  const lines = [
    `# What the pages show, by kind (golden run ${date})`,
    "",
    `- **Dataset**: the live subset of \`evals/golden.jsonl\` (24 of its 45 rows), as the golden run analysed it.`,
    `- **Run records**: \`${runsPath}/results\`, ${count} normalised results (row d, the result each page shows, first run); sha256 of the files in name order \`${sha256}\`.`,
    `- **Date**: ${date}`,
    `- **Commit**: \`${commit}\`, the commit the run was recorded at, kept by the tag \`${RUN_TAG}\` (it is not in main's history; \`evals/reports/agent-2026-10-31.md\` says why).`,
    "- **Written by**: `node evals/agent/kinds.mjs`, with no network and no model call; `evals/agent/kinds.test.mjs` pins these counts to the committed records.",
    `- **Intervals**: 95 % Wilson score intervals; a row with n < ${MIN_N_FOR_RATE} would be shown as counts only. Claims and links of one track are not independent, so their intervals are narrower than they should be.`,
    "",
    "## How to read it",
    "",
    "- **Measured**: a value the audio service measured from the track's 30 s Deezer preview. Only tempo, key and loudness are counted; the style and mood scores (classifier outputs, which the app shows as inferred) are not.",
    "- **Sourced**: a claim or link backed by what it cites: built by code from a primary record, or written by the model and support-checked against the cited excerpt by the verifier's judge (`supported`; or `partial` for a claim that asserts no relation).",
    "- **Inferred**: a claim or link the verifier did not source. It is shown, labelled as model inference.",
    "- **Missing**: a value the page shows as missing, with its reason: withheld by the audio service's checks, or not measured because there was no preview.",
    "- **never**: a kind the row cannot have. A claim or link is never measured; an audio value is never sourced or inferred.",
    "",
    "## Counts",
    "",
    "| what | n | measured | sourced | inferred | missing |",
    "| --- | --- | --- | --- | --- | --- |",
    ...rows.map(
      (row) =>
        `| ${row.label} | ${row.n} ${row.unit} | ${KINDS.map((kind) => cell(row, kind)).join(" | ")} |`,
    ),
    "",
  ];
  const claims = rows.find((row) => row.unit === "claims");
  lines.push(
    `Sourced claims by origin: ${Object.entries(claims.origins)
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(
        ([origin, count]) =>
          `${origin === "code" ? "built by code from a record" : origin === "model" ? "written by the model and supported by its excerpt" : origin} ${count}`,
      )
      .join(", ")}.`,
    "",
    "Why each missing audio value is missing (the audio block's `withheld` code, or the result's reason for having no block):",
    "",
  );
  for (const row of rows.filter((r) => r.unit === "tracks")) {
    lines.push(`- ${row.label}: ${row.counts.missing ? reasonList(row.reasons) : "none missing"}.`);
  }
  const key = rows.find((row) => row.field === "key");
  lines.push(
    "",
    `No key is served on this set: the key is measured on ${key.counts.measured} of ${key.n} tracks. On GiantSteps+ Key the service withholds the key of 202 of 250 clips (\`evals/reports/audio-2026-10-29.md\`), so a missing key is the usual outcome, not a fault of this run.`,
    "",
    "The chart `docs/images/agent-kinds.svg` draws the table above.",
    "",
  );
  return lines.join("\n");
}

const xmlText = (text) =>
  String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The chart: one bar per row, split by kind, each bar the row's n. Drawn on the app's own dark
 * surface with its provenance colours (apps/web/src/styles/tokens.css: measured cyan, sourced
 * amber, inferred violet, missing grey), so it reads the same on a light or dark page; missing
 * is also hatched, and every segment wide enough carries its count.
 */
export function renderChart(rows, { date }) {
  const colours = {
    measured: "#00f0ff",
    sourced: "#ffb000",
    inferred: "#c4a4fc",
    missing: "#8c8c8c",
  };
  const width = 800;
  const left = 196;
  const barWidth = 400;
  const top = 92;
  const rowHeight = 46;
  const barHeight = 24;
  const height = top + rows.length * rowHeight + 34;
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc" font-family="Inter, -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif">`,
    `<title id="title">What the pages show, by kind: golden run ${xmlText(date)}</title>`,
    `<desc id="desc">${xmlText(
      rows
        .map(
          (row) =>
            `${row.label} (${row.n} ${row.unit}): ${KINDS.filter((k) => row.counts[k] > 0)
              .map((k) => `${row.counts[k]} ${k}`)
              .join(", ")}`,
        )
        .join("; "),
    )}.</desc>`,
    "<defs>",
    `<pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${colours.missing}"/><line x1="0" y1="0" x2="0" y2="6" stroke="#121212" stroke-width="2"/></pattern>`,
    "</defs>",
    `<rect width="${width}" height="${height}" rx="8" fill="#121212"/>`,
    `<text x="20" y="32" fill="#f2f2f2" font-size="16" font-weight="600">What the pages show, by kind</text>`,
    `<text x="20" y="52" fill="#b3b3b3" font-size="12">Golden run ${xmlText(date)}, the 24 live-subset tracks of evals/golden.jsonl, as each page shows them (row d)</text>`,
  ];
  // The legend, in kind order.
  let x = 20;
  for (const kind of KINDS) {
    const fill = kind === "missing" ? "url(#hatch)" : colours[kind];
    parts.push(
      `<rect x="${x}" y="66" width="12" height="12" rx="2" fill="${fill}"/>`,
      `<text x="${x + 18}" y="76" fill="#d9d9d9" font-size="12">${kind}</text>`,
    );
    x += 18 + kind.length * 7 + 22;
  }
  rows.forEach((row, index) => {
    const y = top + index * rowHeight;
    parts.push(
      `<text x="20" y="${y + 16}" fill="#f2f2f2" font-size="13">${xmlText(row.label)}</text>`,
      `<text x="20" y="${y + 32}" fill="#b3b3b3" font-size="11">n = ${row.n} ${row.unit}</text>`,
    );
    let at = left;
    const segments = KINDS.filter((kind) => row.counts[kind] > 0);
    segments.forEach((kind, i) => {
      const count = row.counts[kind];
      const gap = i < segments.length - 1 ? 2 : 0;
      const w = (barWidth * count) / row.n;
      const fill = kind === "missing" ? "url(#hatch)" : colours[kind];
      parts.push(
        `<rect x="${at.toFixed(2)}" y="${y + 4}" width="${Math.max(0, w - gap).toFixed(2)}" height="${barHeight}" rx="3" fill="${fill}"><title>${xmlText(`${row.label}: ${count} of ${row.n} ${kind}`)}</title></rect>`,
      );
      const label = String(count);
      if (w >= label.length * 8 + 10) {
        const dark = kind !== "missing";
        parts.push(
          `<text x="${(at + w / 2 - gap / 2).toFixed(2)}" y="${y + 21}" text-anchor="middle" fill="${dark ? "#050505" : "#ffffff"}" font-size="12" font-weight="600"${dark ? "" : ' stroke="#121212" stroke-width="3" paint-order="stroke"'}>${label}</text>`,
        );
      }
      at += w;
    });
    // The row's split in words, right of the bar, so no count depends on colour alone.
    const words = segments.map((kind) => `${row.counts[kind]} ${kind}`).join(" · ");
    parts.push(
      `<text x="${left + barWidth + 12}" y="${y + 21}" fill="#d9d9d9" font-size="11">${xmlText(words)}</text>`,
    );
  });
  parts.push(
    `<text x="20" y="${height - 14}" fill="#b3b3b3" font-size="11">Source: evals/agent/runs/2026-10-31/results (24 files); table and reasons in evals/reports/agent-kinds.md</text>`,
    "</svg>",
    "",
  );
  return parts.join("\n");
}

/** The report and chart for a run, as they would be written. */
export function build(runs = DEFAULT_RUNS) {
  const { results, sha256 } = readResults(runs);
  const rows = countKinds(results);
  const meta = JSON.parse(
    readFileSync(join(REPO_ROOT, "evals/reports/agent-2026-10-31.json"), "utf8"),
  );
  const options = { runs, sha256, count: results.length, date: meta.date, commit: meta.commit };
  return { rows, report: renderReport(rows, options), chart: renderChart(rows, options) };
}

function main() {
  const { values } = parseArgs({
    options: { check: { type: "boolean" }, json: { type: "boolean" } },
  });
  const { rows, report, chart } = build();
  if (values.json) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  if (values.check) {
    const stale = [
      [REPORT_PATH, report],
      [CHART_PATH, chart],
    ].filter(([path, text]) => {
      try {
        return readFileSync(path, "utf8") !== text;
      } catch {
        return true;
      }
    });
    for (const [path] of stale) {
      console.log(`${relative(REPO_ROOT, path)} is not what evals/agent/kinds.mjs writes`);
    }
    return stale.length ? 1 : 0;
  }
  writeFileSync(REPORT_PATH, report);
  writeFileSync(CHART_PATH, chart);
  console.log(`wrote ${relative(REPO_ROOT, REPORT_PATH)} and ${relative(REPO_ROOT, CHART_PATH)}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main();
