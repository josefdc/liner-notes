#!/usr/bin/env node
// The agent eval's live and replay drivers. Each golden row is analysed through the API's HTTP
// stream (lib/api.mjs), one API process per row, so each row's cassettes are its own.
//
// Live (model and source calls; the spend log and its caps apply):
//
//   node evals/agent/run.mjs --mode live --suite golden|variance --subset all|ci [--tracks ISRC,…]
//     --out <dir> --cassettes <dir> --db <file> --spend-log <file>
//     [--audio-url http://127.0.0.1:3142] [--port 3141] [--force]
//
//   The API runs with REPLAY_MODE=off (a capped request is never answered from a recording),
//   LLM_CASSETTE=record and SOURCE_CASSETTE=record into <cassettes>/{llm,sources}/<suite>/<isrc>
//   (the audio step is recorded in the sources directory, sources/audio.json), LLM_RUN_PURPOSE
//   eval:golden or eval:variance, NODE_ENV=development and the database <db>, which should be new:
//   a result stored for the track would be served instead of a fresh analysis (the variance
//   re-run needs a database of its own for that reason). The audio service must answer /health
//   with an analyzer version before the first row, and with the same one before every row: one
//   analyzer for the whole set. The checkout must be clean (the server stamps each run with its
//   commit). Every BUDGET_* variable of this process is passed on, so a run can be capped below
//   the app's defaults. A row whose record exists in <out> is skipped unless --force.
//   Each row writes <out>/<suite>/<isrc>.json: its run records (rows d, c and b), the audio
//   service's version and the row's spend lines; <isrc>.events.json keeps the raw events.
//
// Rebuild (no call of any kind): node evals/agent/run.mjs --mode rebuild --suite <suite> --out <dir>
//   derives the records again from the raw events kept in <out>/<suite>.
//
// Replay (no network, no spending):
//
//   node evals/agent/run.mjs --mode replay --subset ci [--runs <dir>] [--cassettes <dir>]
//
//   Re-runs the pipeline for each row from its cassettes (default fixtures/cassettes, suite
//   golden), with every outbound connection refused and counted (tests/deny-network.mjs in each
//   API process), dummy keys and an empty spend log, and compares the records it gets with the
//   committed ones (default: the newest directory under evals/agent/runs). It fails on any
//   difference, any cassette miss, any outbound attempt and any spend-log line.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readReport } from "../../scripts/stop-server.mjs";
import { analyse, pinnedEnv, startApi } from "./lib/api.mjs";
import { requireContract } from "./lib/app.mjs";
import { CI_SUBSET, EVALS_DIR, readGolden, REPO_ROOT, subsetRows } from "./lib/golden.mjs";
import { callsOf, differences, recordsOf } from "./lib/record.mjs";

export const CASSETTES = join(REPO_ROOT, "fixtures", "cassettes");
export const RUNS_ROOT = join(EVALS_DIR, "agent", "runs");
const PRELOAD = join(REPO_ROOT, "tests", "deny-network.mjs");
const PURPOSE = { golden: "eval:golden", variance: "eval:variance" };
const REPEAT = { golden: 0, variance: 1 };

/** The credential each optional source reads, for a replay that must configure what the run had. */
export const SOURCE_CREDENTIALS = {
  tavily: "TAVILY_API_KEY",
  lastfm: "LASTFM_API_KEY",
  discogs: "DISCOGS_TOKEN",
  shs: "SHS_API_KEY",
  genius: "GENIUS_ACCESS_TOKEN",
};

export const RE_RECORD =
  "re-record: `npm run eval -- --suite agent --mode live --subset ci --out <dir> --cassettes <dir> " +
  "--db <file> --spend-log <file>`, purpose eval:golden, then gather the records with " +
  'evals/agent/assemble.mjs and copy the cassettes (evals/agent/README.md, "Recording the golden ' +
  'run"); a change to a prompt, a schema, a tier or an output cap makes the recorded answers misses';

function parseArgs(argv) {
  const opts = { subset: "all", suite: "golden", force: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--force") opts.force = true;
    else if (
      [
        "--mode",
        "--suite",
        "--subset",
        "--tracks",
        "--out",
        "--cassettes",
        "--db",
        "--spend-log",
        "--audio-url",
        "--port",
        "--runs",
      ].includes(flag)
    ) {
      opts[flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value();
    } else throw new Error(`unknown argument ${flag}`);
  }
  if (!["live", "replay", "rebuild"].includes(opts.mode)) {
    throw new Error("--mode live, replay or rebuild");
  }
  if (!PURPOSE[opts.suite]) throw new Error("--suite golden or variance");
  if (!["all", "ci"].includes(opts.subset)) throw new Error("--subset all or ci");
  return opts;
}

const git = (...args) =>
  execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

/** The rows to run: the subset, or the --tracks named (each must be in it). */
function rowsFor(golden, opts) {
  const rows = subsetRows(golden, opts.subset);
  if (!opts.tracks) return rows;
  const wanted = opts.tracks.split(",").map((s) => s.trim());
  const unknown = wanted.filter((isrc) => !rows.some((r) => r.isrc === isrc));
  if (unknown.length)
    throw new Error(`--tracks not in subset ${opts.subset}: ${unknown.join(", ")}`);
  return rows.filter((r) => wanted.includes(r.isrc));
}

export const queryOf = (row) => `${row.title} ${row.artist}`;

/** True when every event and the result fit the contract. */
async function contractChecker() {
  const { AnalyzeStreamEvent, TrackAnalysis } = await import("@liner-notes/contract");
  return (events, analysis) =>
    events.every((e) => AnalyzeStreamEvent.safeParse(e).success) &&
    TrackAnalysis.safeParse(analysis).success;
}

async function audioHealth(url) {
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    const body = await res.json();
    return { status: res.status, version: body.analyzer_version ?? null, models: body.models };
  } catch (error) {
    return { status: null, version: null, error: String(error.message ?? error) };
  }
}

function readSpendLines(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const usd = (x) => `USD ${x.toFixed(4)}`;

async function live(opts) {
  for (const need of ["out", "cassettes", "db", "spendLog"]) {
    if (!opts[need])
      throw new Error(
        `--mode live needs --${need.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
      );
  }
  requireContract();
  const status = git("status", "--porcelain", "--untracked-files=normal");
  if (status)
    throw new Error(
      `the checkout has uncommitted changes; runs must come from a clean commit:\n${status}`,
    );
  const commit = git("rev-parse", "--short=12", "HEAD");
  const audioUrl = opts.audioUrl ?? "http://127.0.0.1:3142";
  const health = await audioHealth(audioUrl);
  if (health.status !== 200 || !health.version) {
    throw new Error(
      `the audio service at ${audioUrl} does not answer /health with a version (${JSON.stringify(health)})`,
    );
  }
  console.log(`audio service: ${health.version} (models ${health.models})`);
  const golden = readGolden();
  const rows = rowsFor(golden, opts);
  const out = join(resolve(opts.out), opts.suite);
  mkdirSync(out, { recursive: true });
  const check = await contractChecker();
  const purpose = PURPOSE[opts.suite];
  const budget = Object.fromEntries(
    Object.entries(process.env).filter(([k]) => k.startsWith("BUDGET_")),
  );
  let fired = 0;
  let done = 0;
  for (const row of rows) {
    const file = join(out, `${row.isrc}.json`);
    if (existsSync(file) && !opts.force) {
      console.log(`${row.isrc} ${row.title}: recorded already, skipped`);
      continue;
    }
    const now = await audioHealth(audioUrl);
    if (now.status !== 200 || now.version !== health.version) {
      throw new Error(
        `the audio service changed or stopped answering (${JSON.stringify(now)}); one analyzer for the whole set`,
      );
    }
    const dir = (kind) => join(resolve(opts.cassettes), kind, opts.suite, row.isrc.toLowerCase());
    for (const kind of ["llm", "sources"]) mkdirSync(dir(kind), { recursive: true });
    const env = {
      ...pinnedEnv(),
      ...budget,
      PORT: String(opts.port ?? 3141),
      SQLITE_DB_PATH: resolve(opts.db),
      LLM_CASSETTE: "record",
      LLM_CASSETTE_DIR: dir("llm"),
      SOURCE_CASSETTE: "record",
      SOURCE_CASSETTE_DIR: dir("sources"),
      LLM_RUN_PURPOSE: purpose,
      LLM_SPEND_LOG: resolve(opts.spendLog),
      AUDIO_ANALYSIS_URL: audioUrl,
      LOG_FILE: join(out, `${row.isrc}.api.jsonl`),
    };
    const startedAt = new Date().toISOString();
    const query = queryOf(row);
    let result;
    const api = await startApi(env, join(out, `${row.isrc}.api.out`));
    try {
      result = await analyse(api.port, query);
    } catch (error) {
      result = { runId: null, events: [], resumed: null, error: String(error.message ?? error) };
    } finally {
      const stopped = await api.stop();
      if (stopped.code !== 0) console.log(`  the API exited with ${stopped.code}`);
    }
    const lines = readSpendLines(resolve(opts.spendLog));
    const calls = result.runId ? callsOf(lines, result.runId) : [];
    const records = recordsOf({
      row,
      query,
      result,
      repeat: REPEAT[opts.suite],
      commit,
      recordedAt: startedAt,
      calls,
      contractCheck: check,
    });
    writeFileSync(join(out, `${row.isrc}.events.json`), `${JSON.stringify(result, null, 2)}\n`);
    writeFileSync(
      file,
      `${JSON.stringify({ suite: opts.suite, purpose, audio: health, records }, null, 2)}\n`,
    );
    const d = records.d;
    if (d.clarification.fired) fired++;
    done++;
    const spent = calls.reduce((s, c) => s + c.usd, 0);
    console.log(
      `${row.isrc} ${row.title}: ${d.outcome}; clarification ${d.clarification.fired ? "fired" : "not fired"}; ` +
        `${d.edges.length} edges shown, ${records.c.edges.length} proposed; ${d.claims.length} claims; ` +
        `audio ${d.audio?.measured ? `measured, ${d.audio.tempoBpm} BPM` : "not measured"}; ` +
        `source errors ${d.sourceErrors.map((s) => `${s.source}:${s.code}`).join(" ") || "none"}; ` +
        `${calls.length} calls, ${usd(spent)} (spend log)`,
    );
  }
  console.log(`done: ${done} row(s) run, clarification fired in ${fired}`);
}

/**
 * Rebuilds each row's records in <out>/<suite> from the raw events the live run kept, with the
 * spend lines, commit and time it recorded: no call of any kind. For a change to how records are
 * derived from a stream (lib/record.mjs) after the run.
 */
async function rebuild(opts) {
  if (!opts.out) throw new Error("--mode rebuild needs --out");
  const out = join(resolve(opts.out), opts.suite);
  const check = await contractChecker();
  const byIsrc = new Map(readGolden().rows.map((r) => [r.isrc, r]));
  for (const name of readdirSync(out).filter((n) => /^[A-Z0-9]{12}\.json$/.test(n))) {
    const file = join(out, name);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    const result = JSON.parse(readFileSync(file.replace(/\.json$/, ".events.json"), "utf8"));
    const was = saved.records.d;
    const records = recordsOf({
      row: byIsrc.get(was.isrc),
      query: was.query,
      result,
      repeat: was.repeat,
      commit: was.commit,
      recordedAt: was.recordedAt,
      calls: was.calls,
      contractCheck: check,
    });
    writeFileSync(file, `${JSON.stringify({ ...saved, records }, null, 2)}\n`);
    console.log(`${was.isrc}: rebuilt (${records.d.outcome})`);
  }
}

/** The newest directory of run records under evals/agent/runs. */
export function newestRuns(root = RUNS_ROOT) {
  const dirs = existsSync(root)
    ? readdirSync(root, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort()
    : [];
  return dirs.length ? join(root, dirs.at(-1)) : null;
}

/** The committed records of `dir`, by ISRC and ablation (first runs only). */
function committedRecords(dir) {
  const byIsrc = new Map();
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const data = JSON.parse(readFileSync(join(dir, name), "utf8"));
    for (const r of Array.isArray(data) ? data : [data]) {
      if ((r.repeat ?? 0) !== 0 || !["b", "c", "d"].includes(r.ablation)) continue;
      const entry = byIsrc.get(r.isrc) ?? {};
      entry[r.ablation] = r;
      byIsrc.set(r.isrc, entry);
    }
  }
  return byIsrc;
}

/** Replays the subset; returns { ok, lines } (the lines say what was checked, and what failed). */
export async function replay(opts) {
  requireContract();
  const runsDir = opts.runs ? resolve(opts.runs) : newestRuns();
  if (!runsDir || !existsSync(runsDir))
    return { ok: false, lines: ["no recorded runs to replay against"] };
  const committed = committedRecords(runsDir);
  const golden = readGolden();
  const rows = rowsFor(golden, opts);
  const scratch = mkdtempSync(join(tmpdir(), "agent-replay-"));
  const report = join(scratch, "deny-network.jsonl");
  const spendLog = join(scratch, "spend.jsonl");
  writeFileSync(spendLog, "");
  const check = await contractChecker();
  const lines = [`replaying ${rows.length} row(s) against ${relative(REPO_ROOT, runsDir)}`];
  const failures = [];
  try {
    for (const row of rows) {
      const recorded = committed.get(row.isrc);
      if (!recorded?.d) {
        failures.push(`${row.isrc}: no committed record`);
        continue;
      }
      const dir = (kind) =>
        join(resolve(opts.cassettes ?? CASSETTES), kind, "golden", row.isrc.toLowerCase());
      if (!existsSync(dir("llm")) || !existsSync(dir("sources"))) {
        failures.push(
          `${row.isrc}: no cassettes in ${relative(REPO_ROOT, dir("llm"))} or ${relative(REPO_ROOT, dir("sources"))}`,
        );
        continue;
      }
      const notConfigured = new Set(
        recorded.d.sourceErrors.filter((s) => s.code === "not_configured").map((s) => s.source),
      );
      const credentials = Object.fromEntries(
        Object.entries(SOURCE_CREDENTIALS).map(([source, name]) => [
          name,
          notConfigured.has(source) ? "" : `dummy-${source}-credential`,
        ]),
      );
      const env = {
        ...pinnedEnv(),
        ...credentials,
        NODE_OPTIONS: `--import ${PRELOAD}`,
        DENY_NETWORK_REPORT: report,
        PORT: "0",
        SQLITE_DB_PATH: join(scratch, "api.db"),
        LLM_CASSETTE: "replay",
        LLM_CASSETTE_DIR: dir("llm"),
        SOURCE_CASSETTE: "replay",
        SOURCE_CASSETTE_DIR: dir("sources"),
        LLM_RUN_PURPOSE: "eval:golden",
        LLM_SPEND_LOG: spendLog,
        SPOTIFY_CLIENT_ID: "dummy-spotify-client-id",
        SPOTIFY_CLIENT_SECRET: "dummy-spotify-client-secret",
        AZURE_OPENAI_API_KEY: "dummy-azure-key",
        AZURE_OPENAI_ENDPOINT: "https://dummy-resource.openai.azure.com/",
        AZURE_OPENAI_BASE_URL: "",
        AZURE_OPENAI_API_VERSION: "",
        GEMINI_API_KEY: "",
        SOURCE_USER_AGENT: "",
        MUSICBRAINZ_USER_AGENT: "",
        AUDIO_ANALYSIS_URL: "http://dummy-audio.invalid:3002",
        AUDIO_SERVICE_TOKEN: "",
        LOG_FILE: join(scratch, `${row.isrc}.api.jsonl`),
      };
      const query = queryOf(row);
      let result;
      const api = await startApi(env, join(scratch, `${row.isrc}.api.out`));
      try {
        result = await analyse(api.port, query);
      } catch (error) {
        result = { runId: null, events: [], resumed: null, error: String(error.message ?? error) };
      } finally {
        await api.stop();
      }
      const records = recordsOf({
        row,
        query,
        result,
        repeat: 0,
        commit: null,
        recordedAt: null,
        calls: [],
        contractCheck: check,
      });
      const misses = result.events
        .filter((e) => e.type === "status" || e.type === "error")
        .filter((e) => /cassette/i.test(`${e.message ?? ""} ${e.error ?? ""} ${e.code ?? ""}`));
      const diffs = ["d", "c", "b"].flatMap((id) =>
        recorded[id] ? differences(recorded[id], records[id]).map((f) => `row ${id} ${f}`) : [],
      );
      const label = `${row.isrc} ${row.title}`;
      if (diffs.length === 0)
        lines.push(`ok   ${label}: ${records.d.outcome}, rows b c d as recorded`);
      else {
        failures.push(`${label}: ${diffs.join(", ")}`);
        lines.push(`FAIL ${label}: ${records.d.outcome}; differs in ${diffs.join(", ")}`);
        if (misses.length) lines.push(`     ${misses.length} event(s) mention a cassette`);
        writeFileSync(
          join(scratch, `${row.isrc}.replayed.json`),
          `${JSON.stringify(records, null, 2)}\n`,
        );
        opts.keepScratch = true;
      }
    }
    // Every guarded process that started must have exited with 0 attempts, and none was blocked.
    const reportLines = readReport(report);
    const started = reportLines.filter((l) => l.event === "start").map((l) => l.pid);
    const exits = new Map(
      reportLines.filter((l) => l.event === "exit").map((l) => [l.pid, l.attempts]),
    );
    const blocked = reportLines.filter((l) => l.event === "blocked");
    const attempts = [...exits.values()].reduce((s, n) => s + n, 0) + blocked.length;
    const missing = started.filter((pid) => !exits.has(pid));
    lines.push(
      `outbound attempts: ${attempts} over ${started.length} guarded process(es)${missing.length ? `; ${missing.length} without an exit report` : ""}`,
    );
    if (started.length === 0)
      failures.push("no guarded process reported (tests/deny-network.mjs not loaded)");
    if (attempts > 0)
      failures.push(
        `${attempts} outbound attempt(s): ${[...new Set(blocked.flatMap((l) => l.hosts ?? []))].join(", ")}`,
      );
    if (missing.length) failures.push(`${missing.length} guarded process(es) wrote no exit report`);
    const own = globalThis.__denyNetwork?.attempts?.() ?? 0;
    if (own > 0) failures.push(`this process tried ${own} outbound connection(s)`);
    const spendLines = readFileSync(spendLog, "utf8")
      .split("\n")
      .filter((l) => l.trim()).length;
    lines.push(`spend-log lines: ${spendLines}`);
    if (spendLines > 0)
      failures.push(`${spendLines} spend-log line(s): a replay must make no live call`);
  } finally {
    if (!opts.keepScratch) rmSync(scratch, { recursive: true, force: true });
    else lines.push(`scratch kept: ${scratch}`);
  }
  if (failures.length) lines.push(...failures.map((f) => `failure: ${f}`), RE_RECORD);
  return { ok: failures.length === 0, lines, runsDir };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`run: ${error.message}`);
    process.exit(2);
  }
  if (opts.mode === "live") {
    await live(opts);
    return;
  }
  if (opts.mode === "rebuild") {
    await rebuild(opts);
    return;
  }
  const { ok, lines } = await replay(opts);
  console.log(lines.join("\n"));
  if (!ok) process.exit(1);
}

export { CI_SUBSET };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`run: ${error.message}`);
    process.exit(1);
  });
}
