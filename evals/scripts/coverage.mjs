#!/usr/bin/env node
// Deezer preview coverage for the golden set.
//
// For every row of evals/golden.jsonl this makes two keyless requests:
//   1. https://api.deezer.com/track/isrc:<ISRC>  (what an ISRC-based resolver sees)
//   2. https://api.deezer.com/track/<deezerId>   (the entry the audio eval uses)
// and records whether the ISRC was found, whether Deezer's title/artist match
// the golden row, whether each entry has a 30-second preview, the duration and
// Deezer's own `bpm` field.
//
// Preview URLs are signed and expire, so they are never stored or printed;
// only the fact that one is present is recorded.
//
// Usage:
//   node evals/scripts/coverage.mjs [--golden <path>] [--dry-run] [--report <path>]
//
//   --golden <path>  golden file (default: evals/golden.jsonl next to this script)
//   --dry-run        do the lookups and print the table, write nothing
//   --report <path>  also write a markdown report to <path>
//
// After a completed run the output ends with two lines:
//   deezerId preview: N/M (P%)   rows whose deezerId entry has a preview
//   coverage: N/M (P%)           rows whose ISRC-endpoint entry has a preview
// A run that cannot start or is aborted ends with an `error:` line on stderr.
//
// Exit code: 0 when every lookup got an answer, whatever the coverage.
// 1 when the golden file is unreadable or invalid (bad JSON, missing or
// duplicate ISRC, unknown stratum), on bad arguments, or when any lookup
// failed (network error, timeout, non-JSON response, quota) after its retry.
// Failed lookups are listed and never counted as "no preview".

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GOLDEN = resolve(HERE, "..", "golden.jsonl");
const API = "https://api.deezer.com";
const STRATA = [
  "documented-samples",
  "no-sample-controls",
  "ambiguous-titles",
  "non-english",
  "obscure",
];
const SPACING_MS = 300; // between any two requests; Deezer's public limit is 50 requests per 5 s
const TIMEOUT_MS = 10_000;
const RETRIES = 1;
const QUOTA_BACKOFF_MS = 5_000;
const MAX_CONSECUTIVE_QUOTA = 3;
const ISRC_RE = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

// ---------------------------------------------------------------- arguments and input

function parseArgs(argv) {
  const opts = { golden: DEFAULT_GOLDEN, dryRun: false, report: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--report" || a === "--golden") {
      const v = argv[++i];
      if (!v || v.startsWith("--")) throw new Error(`${a} needs a path`);
      opts[a.slice(2)] = v;
    } else if (a === "-h" || a === "--help") opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function loadGolden(path) {
  const text = readFileSync(path, "utf8");
  const rows = [];
  const problems = [];
  const seen = new Map();
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    const where = `${path}:${i + 1}`;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      problems.push(`${where}: invalid JSON (${err.message})`);
      return;
    }
    if (typeof row.isrc !== "string" || !ISRC_RE.test(row.isrc))
      problems.push(`${where}: missing or malformed isrc ${JSON.stringify(row.isrc)}`);
    else if (seen.has(row.isrc))
      problems.push(`${where}: duplicate isrc ${row.isrc} (first on line ${seen.get(row.isrc)})`);
    else seen.set(row.isrc, i + 1);
    if (!STRATA.includes(row.stratum))
      problems.push(`${where}: unknown stratum ${JSON.stringify(row.stratum)}`);
    rows.push(row);
  });
  if (rows.length === 0) problems.push(`${path}: no rows`);
  if (problems.length) throw new Error(problems.join("\n"));
  return { rows, sha256: createHash("sha256").update(text).digest("hex") };
}

// ---------------------------------------------------------------- HTTP

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class QuotaAbort extends Error {}

function makeClient() {
  let last = 0;
  let consecutiveQuota = 0;
  async function once(url) {
    const wait = last + SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    last = Date.now();
    let res;
    try {
      res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept: "application/json" },
      });
    } catch (err) {
      return {
        kind: "fail",
        error: err?.name === "TimeoutError" ? "timeout" : `network: ${err?.message ?? err}`,
      };
    }
    if (!res.ok) return { kind: "fail", error: `HTTP ${res.status}` };
    let body;
    try {
      body = JSON.parse(await res.text());
    } catch {
      return { kind: "fail", error: "response is not JSON" };
    }
    if (body && typeof body === "object" && body.error) {
      // Deezer reports errors as HTTP 200 with an error object.
      if (body.error.code === 800) return { kind: "not-found" }; // "no data": an answer, not a failure
      if (body.error.code === 4) return { kind: "quota", error: "quota exceeded" };
      return {
        kind: "fail",
        error: `Deezer error ${body.error.code ?? "?"} ${body.error.type ?? ""}`.trim(),
      };
    }
    if (!body || typeof body !== "object" || body.id == null)
      return { kind: "fail", error: "unexpected response shape" };
    return { kind: "ok", body };
  }
  // Returns { kind: 'ok', body } | { kind: 'not-found' } | { kind: 'fail', error }.
  // A quota answer is retried once after a back-off and then reported as a
  // failure; MAX_CONSECUTIVE_QUOTA quota answers in a row abort the run.
  return async function get(url) {
    let r;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      r = await once(url);
      if (r.kind === "quota") {
        consecutiveQuota++;
        if (consecutiveQuota >= MAX_CONSECUTIVE_QUOTA)
          throw new QuotaAbort(`${consecutiveQuota} consecutive quota errors from Deezer`);
        if (attempt < RETRIES) await sleep(QUOTA_BACKOFF_MS);
        continue;
      }
      consecutiveQuota = 0;
      if (r.kind !== "fail") return r;
      if (attempt < RETRIES) await sleep(1000);
    }
    return { kind: "fail", error: r.error };
  };
}

// ---------------------------------------------------------------- title / artist matching

// Words that make a title a different take of the song.
const QUALIFIER_RE = /\b(instrumental|live|remix(?:ed)?|karaoke|acoustic|demo|edit|version)\b/gi;
const NON_LATIN_RE = /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u;

function norm(s) {
  return String(s ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // Latin diacritics only; kana and hangul are left intact
    .normalize("NFC")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function qualifiers(s) {
  return new Set(
    (String(s ?? "").match(QUALIFIER_RE) ?? []).map((w) => w.toLowerCase().replace(/ed$/, "")),
  );
}

// Bracketed parts that never change which recording a title names.
function stripNeutral(s) {
  return String(s ?? "")
    .replace(/\s*[([]\s*(?:feat\.?|ft\.?|featuring|with)\s[^)\]]*[)\]]/gi, "")
    .replace(/\s*[([][^)\]]*\bremaster(?:ed)?\b[^)\]]*[)\]]/gi, "")
    .replace(/\s+-\s+(?:\d{4}\s+)?remaster(?:ed)?(?:\s+\d{4})?\s*$/i, "");
}

// The forms a title may legitimately be written in: the whole title, and when
// it carries a bracketed non-Latin title (e.g. "Gangnam Style (강남스타일)"),
// the Latin part and the bracketed part on their own.
function titleForms(s) {
  const base = stripNeutral(s);
  const forms = new Set([norm(base)]);
  const m = base.match(/^(.*?)\s*[([]([^)\]]+)[)\]]\s*$/);
  if (m && NON_LATIN_RE.test(m[2])) {
    forms.add(norm(m[1]));
    forms.add(norm(m[2]));
  }
  forms.delete("");
  return forms;
}

export function titleMatches(golden, deezer) {
  const g = qualifiers(golden);
  if ([...qualifiers(deezer)].some((q) => !g.has(q))) return false;
  const forms = titleForms(golden);
  for (const f of titleForms(deezer)) if (forms.has(f)) return true;
  return false;
}

function normArtist(s) {
  const x = String(s ?? "")
    .replace(/\s*[([](?:feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]/gi, "")
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s.*$/i, "");
  return norm(x).replace(/^the /, "");
}

export function artistMatches(golden, deezerNames) {
  const g = normArtist(golden);
  return g !== "" && deezerNames.some((n) => normArtist(n) === g);
}

// ---------------------------------------------------------------- output

function pct(n, m) {
  return m === 0 ? "0.0" : ((100 * n) / m).toFixed(1);
}

const yn = (v) => (v === null || v === undefined ? "–" : v ? "yes" : "no");

function table(results) {
  const head = [
    "#",
    "stratum",
    "isrc",
    "isrc found",
    "isrc→deezer id",
    "title",
    "artist",
    "preview (isrc)",
    "duration",
    "deezer bpm",
    "deezerId",
    "preview (deezerId)",
    "note",
  ];
  const rows = results.map((r, i) => [
    String(i + 1),
    r.stratum,
    r.isrc,
    r.isrcFailed ? "FAILED" : yn(r.found),
    r.isrcDeezerId ?? "–",
    r.found ? (r.titleMatch ? "match" : "differs") : "–",
    r.found ? (r.artistMatch ? "match" : "differs") : "–",
    r.isrcFailed ? "FAILED" : yn(r.preview),
    r.duration ? `${r.duration}s` : "–",
    r.found ? (r.deezerBpm > 0 ? String(r.deezerBpm) : "missing") : "–",
    r.rowDeezerId ?? "–",
    r.idFailed ? "FAILED" : yn(r.idPreview),
    r.notes.join("; "),
  ]);
  return { head, rows };
}

function printTable({ head, rows }) {
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => String(r[c]).length)));
  const line = (cells) =>
    cells
      .map((v, c) => String(v).padEnd(widths[c]))
      .join("  ")
      .trimEnd();
  console.log(line(head));
  console.log(widths.map((w) => "-".repeat(w)).join("  "));
  for (const r of rows) console.log(line(r));
}

function byStratum(results) {
  const m = new Map(STRATA.map((s) => [s, { n: 0, found: 0, preview: 0, idPreview: 0, bpm: 0 }]));
  for (const r of results) {
    const s = m.get(r.stratum);
    s.n++;
    if (r.found) s.found++;
    if (r.preview) s.preview++;
    if (r.idPreview) s.idPreview++;
    if (r.deezerBpm > 0) s.bpm++;
  }
  return m;
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: HERE,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

function markdown(ctx) {
  const {
    results,
    strata,
    date,
    goldenPath,
    sha256,
    commit,
    total,
    previews,
    idPreviews,
    failures,
  } = ctx;
  const esc = (v) => String(v).replace(/\|/g, "\\|");
  const { head, rows } = table(results);
  const o = [];
  o.push(`# Deezer preview coverage, ${date}`);
  o.push("");
  o.push(`- Date (UTC): ${date}`);
  o.push(`- Golden file: \`${goldenPath}\`, ${total} rows, sha256 \`${sha256}\``);
  o.push(
    `- Commit: ${commit ? `\`${commit}\` (the golden file may carry uncommitted changes; the sha256 identifies it)` : "unavailable (not run inside a git checkout)"}`,
  );
  o.push(`- Preview via the ISRC endpoint: **${previews}/${total} (${pct(previews, total)}%)**`);
  o.push(
    `- Preview via the row's \`deezerId\`: **${idPreviews}/${total} (${pct(idPreviews, total)}%)**`,
  );
  o.push(`- Failed lookups: ${failures.length}`);
  o.push(
    "- How measured: `node evals/scripts/coverage.mjs --report <path>` made two keyless requests per row, " +
      "`https://api.deezer.com/track/isrc:<ISRC>` and `https://api.deezer.com/track/<deezerId>`, sequentially and at least " +
      `${SPACING_MS} ms apart (10 s timeout, one retry). A row is covered when the response has a non-empty \`preview\` field. ` +
      "Preview URLs are signed and expire, so they are not recorded.",
  );
  o.push(
    "- Preview availability depends on the country of the requesting IP address and changes over time; this report is one " +
      "observation from one place.",
  );
  o.push(
    "- Title and artist are compared after normalisation (NFKC, case, Latin accents, punctuation, whitespace, featured-artist " +
      "credits) and must be equal. A Deezer title carrying instrumental/live/remix/karaoke/acoustic/demo/edit/version that the " +
      'golden title lacks counts as different. "deezer bpm" is Deezer\'s own field (0 shown as missing); it is not a label.',
  );
  o.push("");
  o.push("## By stratum");
  o.push("");
  o.push(
    "| stratum | rows | ISRC found | preview (ISRC endpoint) | preview (deezerId) | deezer bpm present |",
  );
  o.push("|---|---:|---:|---:|---:|---:|");
  for (const [s, v] of strata) {
    o.push(
      `| ${s} | ${v.n} | ${v.found} | ${v.preview} (${pct(v.preview, v.n)}%) | ${v.idPreview} (${pct(v.idPreview, v.n)}%) | ${v.bpm} |`,
    );
  }
  o.push("");
  if (failures.length) {
    o.push("## Failed lookups");
    o.push("");
    for (const f of failures) o.push(`- ${f}`);
    o.push("");
  }
  o.push("## Per track");
  o.push("");
  o.push(`| ${head.join(" | ")} |`);
  o.push(`|${head.map(() => "---").join("|")}|`);
  for (const r of rows) o.push(`| ${r.map(esc).join(" | ")} |`);
  o.push("");
  o.push(`deezerId preview: ${idPreviews}/${total} (${pct(idPreviews, total)}%)`);
  o.push("");
  o.push(`coverage: ${previews}/${total} (${pct(previews, total)}%)`);
  o.push("");
  return o.join("\n");
}

// ---------------------------------------------------------------- main

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }
  if (opts.help) {
    console.log(
      "usage: node evals/scripts/coverage.mjs [--golden <path>] [--dry-run] [--report <path>]",
    );
    return 0;
  }

  let golden;
  try {
    golden = loadGolden(opts.golden);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }

  const get = makeClient();
  const results = [];
  const failures = [];
  try {
    for (const row of golden.rows) {
      const r = {
        stratum: row.stratum,
        isrc: row.isrc,
        found: null,
        isrcFailed: false,
        isrcDeezerId: null,
        titleMatch: null,
        artistMatch: null,
        preview: null,
        duration: null,
        deezerBpm: null,
        rowDeezerId: row.deezerId ?? null,
        idPreview: null,
        idFailed: false,
        notes: [],
      };

      const a = await get(`${API}/track/isrc:${encodeURIComponent(row.isrc)}`);
      if (a.kind === "fail") {
        r.isrcFailed = true;
        failures.push(`${row.isrc} ISRC endpoint: ${a.error}`);
      } else if (a.kind === "not-found") {
        r.found = false;
        r.preview = false;
      } else {
        const b = a.body;
        r.found = true;
        r.isrcDeezerId = b.id;
        r.titleMatch = titleMatches(row.title, b.title);
        r.artistMatch = artistMatches(
          row.artist,
          [b.artist?.name, ...(b.contributors ?? []).map((c) => c.name)].filter(Boolean),
        );
        r.preview = typeof b.preview === "string" && b.preview.length > 0;
        r.duration = Number.isFinite(b.duration) ? b.duration : null;
        r.deezerBpm = Number.isFinite(b.bpm) ? b.bpm : 0;
        if (b.readable === false) r.notes.push("ISRC entry not readable");
        if (r.rowDeezerId != null && Number(r.rowDeezerId) !== Number(b.id))
          r.notes.push(`ISRC endpoint returns ${b.id}`);
      }

      if (r.rowDeezerId == null) {
        r.notes.push("no deezerId in golden row");
        r.idPreview = false;
      } else {
        const c = await get(`${API}/track/${encodeURIComponent(r.rowDeezerId)}`);
        if (c.kind === "fail") {
          r.idFailed = true;
          failures.push(`${row.isrc} /track/${r.rowDeezerId}: ${c.error}`);
        } else if (c.kind === "not-found") {
          r.idPreview = false;
          r.notes.push("deezerId not found");
        } else {
          r.idPreview = typeof c.body.preview === "string" && c.body.preview.length > 0;
          if (c.body.isrc && c.body.isrc !== row.isrc)
            r.notes.push(`deezerId entry has ISRC ${c.body.isrc}`);
        }
      }
      results.push(r);
    }
  } catch (err) {
    if (err instanceof QuotaAbort) {
      console.error(
        `error: aborted after ${results.length}/${golden.rows.length} rows: ${err.message}`,
      );
      return 1;
    }
    throw err;
  }

  const total = results.length;
  const previews = results.filter((r) => r.preview).length;
  const idPreviews = results.filter((r) => r.idPreview).length;
  const strata = byStratum(results);
  const date = new Date().toISOString().slice(0, 10);

  printTable(table(results));
  console.log("");
  for (const [s, v] of strata) {
    console.log(`${s}: ${v.preview}/${v.n} via ISRC endpoint, ${v.idPreview}/${v.n} via deezerId`);
  }
  if (failures.length) {
    console.log("");
    console.log(`${failures.length} lookup(s) failed (not counted as "no preview"):`);
    for (const f of failures) console.log(`  ${f}`);
  }

  if (opts.report && !opts.dryRun) {
    try {
      const path = resolve(opts.report);
      mkdirSync(dirname(path), { recursive: true });
      const goldenPath = relative(process.cwd(), resolve(opts.golden)) || opts.golden;
      writeFileSync(
        path,
        markdown({
          results,
          strata,
          date,
          goldenPath,
          sha256: golden.sha256,
          commit: gitCommit(),
          total,
          previews,
          idPreviews,
          failures,
        }),
      );
      console.log(`report written to ${opts.report}`);
    } catch (err) {
      console.error(`error: could not write report: ${err.message}`);
      return 1;
    }
  }

  console.log(`deezerId preview: ${idPreviews}/${total} (${pct(idPreviews, total)}%)`);
  console.log(`coverage: ${previews}/${total} (${pct(previews, total)}%)`);
  return failures.length ? 1 : 0;
}

// Run only when executed directly, so the matchers can be imported for tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
