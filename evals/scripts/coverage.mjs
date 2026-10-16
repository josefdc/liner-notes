#!/usr/bin/env node
// Deezer preview coverage for the golden set.
//
// For every row of evals/golden.jsonl, resolve the ISRC with the keyless
// endpoint https://api.deezer.com/track/isrc:<ISRC> and record whether the
// track was found, whether its title/artist match the golden row, whether it
// has a 30-second preview, its duration and Deezer's own `bpm` field.
//
// Preview URLs are signed and expire, so they are never stored or printed;
// only the fact that one is present is recorded.
//
// Usage:
//   node evals/scripts/coverage.mjs [--golden <path>] [--dry-run] [--report <path>]
//
//   --dry-run        do the lookups and print the table, write nothing
//   --report <path>  also write a markdown report to <path>
//
// The last line of output is always `coverage: N/M (P%)`, where N is the
// number of rows with a non-empty preview. Exit code is 0 whatever the
// coverage; 1 only if the golden file cannot be read or every request fails.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_GOLDEN = resolve(HERE, '..', 'golden.jsonl');
const ENDPOINT = 'https://api.deezer.com/track/isrc:';
const SPACING_MS = 300; // stay well under Deezer's public rate limit
const TIMEOUT_MS = 10_000;
const RETRIES = 1;

function parseArgs(argv) {
  const opts = { golden: DEFAULT_GOLDEN, dryRun: false, report: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--report' || a === '--golden') {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a path`);
      opts[a.slice(2)] = v;
    } else if (a === '-h' || a === '--help') {
      opts.help = true;
    } else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

function loadGolden(path) {
  const text = readFileSync(path, 'utf8');
  const rows = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let row;
    try {
      row = JSON.parse(line);
    } catch (err) {
      throw new Error(`${path}:${i + 1}: invalid JSON (${err.message})`);
    }
    if (typeof row.isrc !== 'string' || !row.isrc) throw new Error(`${path}:${i + 1}: missing isrc`);
    rows.push(row);
  });
  if (rows.length === 0) throw new Error(`${path}: no rows`);
  return rows;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Returns { ok: true, body } or { ok: false, error } — never throws.
async function lookup(isrc) {
  let lastError = 'unknown error';
  for (let attempt = 0; attempt <= RETRIES; attempt++) {
    if (attempt > 0) await sleep(1000);
    try {
      const res = await fetch(ENDPOINT + encodeURIComponent(isrc), { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      const body = await res.json();
      // Deezer reports "not found" as HTTP 200 with an error object. That is
      // an answer, not a failed request, so it is not retried.
      if (body?.error) {
        if (body.error.code === 800) return { ok: true, body: null };
        lastError = `Deezer error ${body.error.code ?? ''} ${body.error.type ?? ''}`.trim();
        if (body.error.code === 4) await sleep(5000); // quota: back off before the retry
        continue;
      }
      return { ok: true, body };
    } catch (err) {
      lastError = err?.name === 'TimeoutError' ? 'timeout' : String(err?.message ?? err);
    }
  }
  return { ok: false, error: lastError };
}

// Loose comparison: case, accents, punctuation and bracketed suffixes such as
// "(Remastered 2016)" or "(feat. X)" are ignored; one containing the other
// counts as a match.
function norm(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s*[([].*?[)\]]/g, '')
    .replace(/\b(feat|ft|featuring)\b.*$/, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/^the /, '')
    .trim();
}

function matches(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}

function artistMatches(row, body) {
  const names = [body.artist?.name, ...(body.contributors ?? []).map((c) => c.name)].filter(Boolean);
  return names.some((n) => matches(row.artist, n));
}

function pct(n, m) {
  return m === 0 ? '0.0' : ((100 * n) / m).toFixed(1);
}

function summarise(results) {
  const byStratum = new Map();
  for (const r of results) {
    const s = byStratum.get(r.stratum) ?? { n: 0, found: 0, preview: 0, bpm: 0 };
    s.n++;
    if (r.found) s.found++;
    if (r.preview) s.preview++;
    if (r.deezerBpm > 0) s.bpm++;
    byStratum.set(r.stratum, s);
  }
  return byStratum;
}

function yn(v) {
  return v === null ? '–' : v ? 'yes' : 'no';
}

function table(results) {
  const head = ['#', 'stratum', 'isrc', 'found', 'deezer id', 'title', 'artist', 'preview', 'duration', 'deezer bpm', 'note'];
  const rows = results.map((r, i) => [
    String(i + 1),
    r.stratum,
    r.isrc,
    yn(r.found),
    r.deezerId ?? '–',
    r.found ? (r.titleMatch ? 'match' : 'differs') : '–',
    r.found ? (r.artistMatch ? 'match' : 'differs') : '–',
    yn(r.found ? r.preview : null),
    r.duration ? `${r.duration}s` : '–',
    r.found ? (r.deezerBpm > 0 ? String(r.deezerBpm) : 'missing') : '–',
    r.note ?? '',
  ]);
  return { head, rows };
}

function printTable({ head, rows }) {
  const widths = head.map((h, c) => Math.max(h.length, ...rows.map((r) => String(r[c]).length)));
  const line = (cells) => cells.map((v, c) => String(v).padEnd(widths[c])).join('  ').trimEnd();
  console.log(line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
}

function markdown({ results, byStratum, date, total, previews, goldenPath }) {
  const esc = (v) => String(v).replace(/\|/g, '\\|');
  const { head, rows } = table(results);
  const out = [];
  out.push(`# Deezer preview coverage — ${date}`);
  out.push('');
  out.push(`- Date (UTC): ${date}`);
  out.push(`- Rows: ${total} (from \`${goldenPath}\`)`);
  out.push(`- Coverage: **${previews}/${total} (${pct(previews, total)}%)** rows have a non-empty 30-second preview`);
  out.push(
    '- How measured: `node evals/scripts/coverage.mjs --report <path>` called the keyless endpoint ' +
      '`https://api.deezer.com/track/isrc:<ISRC>` once per row, sequentially and at least ' +
      `${SPACING_MS} ms apart (10 s timeout, one retry). A row counts as covered when the response has a non-empty ` +
      '`preview` field. Preview URLs are signed and expire, so they are not recorded. Availability depends on the ' +
      'country of the requesting IP; this run is one observation, not a guarantee.',
  );
  out.push(
    '- "title"/"artist" compare Deezer\'s metadata with the golden row after removing case, accents, punctuation and ' +
      'bracketed suffixes. "deezer bpm" is Deezer\'s own field (0 is shown as missing); it is not a label.',
  );
  out.push('');
  out.push('## By stratum');
  out.push('');
  out.push('| stratum | rows | found | with preview | coverage | deezer bpm present |');
  out.push('|---|---:|---:|---:|---:|---:|');
  for (const [s, v] of byStratum) {
    out.push(`| ${s} | ${v.n} | ${v.found} | ${v.preview} | ${pct(v.preview, v.n)}% | ${v.bpm} |`);
  }
  out.push('');
  out.push('## Per track');
  out.push('');
  out.push(`| ${head.join(' | ')} |`);
  out.push(`|${head.map(() => '---').join('|')}|`);
  for (const r of rows) out.push(`| ${r.map(esc).join(' | ')} |`);
  out.push('');
  out.push(`coverage: ${previews}/${total} (${pct(previews, total)}%)`);
  out.push('');
  return out.join('\n');
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }
  if (opts.help) {
    console.log('usage: node evals/scripts/coverage.mjs [--golden <path>] [--dry-run] [--report <path>]');
    return 0;
  }

  let golden;
  try {
    golden = loadGolden(opts.golden);
  } catch (err) {
    console.error(`error: ${err.message}`);
    return 1;
  }

  const results = [];
  let failures = 0;
  for (let i = 0; i < golden.length; i++) {
    const row = golden[i];
    if (i > 0) await sleep(SPACING_MS);
    const res = await lookup(row.isrc);
    const r = {
      stratum: row.stratum ?? '(none)',
      isrc: row.isrc,
      found: null,
      deezerId: null,
      titleMatch: null,
      artistMatch: null,
      preview: null,
      duration: null,
      deezerBpm: null,
      note: null,
    };
    if (!res.ok) {
      failures++;
      r.note = `request failed: ${res.error}`;
    } else if (!res.body) {
      r.found = false;
      r.note = 'not found';
    } else {
      const b = res.body;
      r.found = true;
      r.deezerId = b.id ?? null;
      r.titleMatch = matches(row.title, b.title) || matches(row.title, b.title_short);
      r.artistMatch = artistMatches(row, b);
      r.preview = typeof b.preview === 'string' && b.preview.length > 0;
      r.duration = Number.isFinite(b.duration) ? b.duration : null;
      r.deezerBpm = Number.isFinite(b.bpm) ? b.bpm : 0;
      const notes = [];
      if (row.deezerId != null && b.id != null && Number(row.deezerId) !== Number(b.id)) notes.push(`resolves to ${b.id}, golden has ${row.deezerId}`);
      if (b.readable === false) notes.push('not readable');
      r.note = notes.join('; ') || null;
    }
    results.push(r);
  }

  if (failures === golden.length) {
    console.error(`error: all ${failures} requests failed (last: ${results.at(-1)?.note})`);
    return 1;
  }

  const total = results.length;
  const previews = results.filter((r) => r.preview).length;
  const byStratum = summarise(results);
  const date = new Date().toISOString().slice(0, 10);

  printTable(table(results));
  console.log('');
  for (const [s, v] of byStratum) console.log(`${s}: ${v.preview}/${v.n} with preview (${pct(v.preview, v.n)}%)`);
  if (failures) console.log(`${failures} request(s) failed; those rows count as not covered`);

  if (opts.report && !opts.dryRun) {
    try {
      const path = resolve(opts.report);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, markdown({ results, byStratum, date, total, previews, goldenPath: 'evals/golden.jsonl' }));
      console.log(`report written to ${opts.report}`);
    } catch (err) {
      console.error(`error: could not write report: ${err.message}`);
      return 1;
    }
  }

  console.log(`coverage: ${previews}/${total} (${pct(previews, total)}%)`);
  return 0;
}

process.exitCode = await main();
