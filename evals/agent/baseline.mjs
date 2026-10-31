#!/usr/bin/env node
// Ablation (a), the model alone: the composer's own prompt and schema, on the research tier, for
// each golden row with nothing but its title and artist. No tools, no evidence pack, no source
// material, no audio, no judge. Its answer is never judged (the research tier's model is also the
// judge's), so none of its claims is shown as sourced: it is scored against gold by code only.
//
//   node evals/agent/baseline.mjs --mode live --out <dir> --cassettes <dir> --spend-log <file>
//     [--subset all|ci] [--tracks ISRC,…] [--force]
//   node evals/agent/baseline.mjs --mode replay --runs <dir> [--cassettes <dir>]
//
// Live: purpose eval:baseline, LLM_CASSETTE=record into <cassettes>; each row writes
// <out>/baseline/<isrc>.json with its run record (ablation "a"). Every BUDGET_* variable of this
// process applies (the app's caps, and any set lower). Replay: the same calls from the cassettes
// (default fixtures/cassettes/llm/baseline), no network and no spending; the records must equal
// the committed row-a records in <runs>.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readGolden, REPO_ROOT, subsetRows } from "./lib/golden.mjs";
import { importApp } from "./lib/app.mjs";
import { appModelLayer } from "./lib/inproc.mjs";
import { callsOf, edgesOf } from "./lib/record.mjs";

export const BASELINE_CASSETTES = join(REPO_ROOT, "fixtures", "cassettes", "llm", "baseline");
export const CALL_SITE = "eval-baseline";
/** The run id of a row's baseline call: stable, so its spend lines can be found again. */
export const baselineRunId = (row) => `eval-baseline-${row.isrc.toLowerCase()}`;

function parseArgs(argv) {
  const opts = { subset: "all", force: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === "--force") opts.force = true;
    else if (
      ["--mode", "--out", "--cassettes", "--spend-log", "--subset", "--tracks", "--runs"].includes(
        flag,
      )
    ) {
      opts[flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = value();
    } else throw new Error(`unknown argument ${flag}`);
  }
  if (!["live", "replay"].includes(opts.mode)) throw new Error("--mode live or replay");
  return opts;
}

/**
 * The run record of one baseline answer (ComposerOutput): its relation links as edges and its
 * claims, all the model's, none sourced and none judged.
 */
export function baselineRecord(row, output, { usage, calls, commit, recordedAt, outcome }) {
  const runId = baselineRunId(row);
  // The composer's nodes and links as a result's genealogy, so they read as the pipeline's do.
  const genealogy = output
    ? {
        nodes: output.genealogyNodes.map((n) => ({
          id: n.id,
          label: n.label,
          trackTitle: n.trackTitle,
          trackArtist: n.trackArtist,
        })),
        links: output.genealogyLinks.map((l) => ({
          source: l.source,
          target: l.target,
          type: l.type,
          kind: "inferred",
          origin: "model",
          evidenceIds: l.evidenceIds,
        })),
      }
    : null;
  return {
    version: 1,
    runId,
    isrc: row.isrc,
    title: row.title,
    artist: row.artist,
    ablation: "a",
    repeat: 0,
    commit,
    recordedAt,
    outcome,
    identity: null,
    clarification: null,
    preview: null,
    evidence: [],
    edges: edgesOf(genealogy ? { genealogy } : null),
    claims: (output?.claims ?? []).map((c, i) => ({
      id: `${runId}-claim-${i + 1}`,
      text: c.text,
      about: c.about,
      origin: "model",
      kind: "inferred",
      verdict: null,
      evidenceIds: c.evidenceIds,
    })),
    schemaValid: output !== null,
    fallback: false,
    usage,
    calls,
  };
}

function readSpendLines(path) {
  if (!path || !existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`baseline: ${error.message}`);
    process.exit(2);
  }
  const live = opts.mode === "live";
  if (live) {
    for (const need of ["out", "cassettes", "spendLog"]) {
      if (!opts[need])
        throw new Error(
          `--mode live needs --${need.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
        );
    }
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    if (status.trim()) throw new Error(`the checkout has uncommitted changes:\n${status}`);
  } else if (!opts.runs) throw new Error("--mode replay needs --runs <dir>");
  const cassetteDir = resolve(opts.cassettes ?? BASELINE_CASSETTES);
  const spendLog = live ? resolve(opts.spendLog) : join(cassetteDir, ".no-spend-log");
  const { llm, agentRuntime } = await appModelLayer({
    cassette: live ? "record" : "replay",
    cassetteDir,
    spendLog,
    purpose: "eval:baseline",
  });
  const [{ composerMessages }, { COMPOSER_MAX_OUTPUT_TOKENS }] = await Promise.all([
    importApp("apps/api/src/agent/prompts.ts"),
    importApp("apps/api/src/agent/nodes/composerNode.ts"),
  ]);
  const { ComposerOutput, composerOutputIssues } = await importApp(
    "packages/contract/dist/index.js",
  );
  const runtime = agentRuntime({ purpose: "eval:baseline" });
  const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();
  let rows = subsetRows(readGolden(), opts.subset);
  if (opts.tracks) {
    const wanted = new Set(opts.tracks.split(","));
    rows = rows.filter((r) => wanted.has(r.isrc));
  }
  const committed = new Map();
  if (!live) {
    for (const name of readdirSync(resolve(opts.runs)).filter((n) => n.endsWith(".json"))) {
      const data = JSON.parse(readFileSync(join(resolve(opts.runs), name), "utf8"));
      for (const r of Array.isArray(data) ? data : [data])
        if (r.ablation === "a") committed.set(r.isrc, r);
    }
  }
  const out = live ? join(resolve(opts.out), "baseline") : null;
  if (out) mkdirSync(out, { recursive: true });
  let failures = 0;
  for (const row of rows) {
    const file = out ? join(out, `${row.isrc}.json`) : null;
    if (file && existsSync(file) && !opts.force) {
      console.log(`${row.isrc} ${row.title}: recorded already, skipped`);
      continue;
    }
    const messages = composerMessages({
      track: { title: row.title, artist: row.artist, album: null, year: null },
      recording: null,
      audio: null,
      evidence: [],
      research: null,
      sourceErrors: [],
    });
    const recordedAt = new Date().toISOString();
    let output = null;
    let usage = null;
    let outcome = "complete";
    try {
      const result = await runtime.llm.invoke(CALL_SITE, "research", messages, ComposerOutput, {
        purpose: runtime.purpose,
        runId: baselineRunId(row),
        maxOutputTokens: COMPOSER_MAX_OUTPUT_TOKENS,
      });
      const issues = composerOutputIssues(result.output);
      if (issues.length) outcome = `invalid: ${issues.slice(0, 3).join("; ")}`;
      else output = result.output;
      usage = {
        llmCalls: 1,
        deployment: result.deployment,
        inputTokens: result.usage?.inputTokens ?? null,
        outputTokens: result.usage?.outputTokens ?? null,
        reasoningTokens: result.usage?.reasoningTokens ?? null,
        usd: result.usage?.usdEst ?? null,
      };
    } catch (error) {
      outcome = `failed: ${error.kind ?? "error"}: ${error.message}`;
    } finally {
      llm.endRun(baselineRunId(row));
    }
    const calls = live ? callsOf(readSpendLines(spendLog), baselineRunId(row)) : [];
    const record = baselineRecord(row, output, { usage, calls, commit, recordedAt, outcome });
    if (live) {
      writeFileSync(
        file,
        `${JSON.stringify({ suite: "baseline", purpose: "eval:baseline", records: { a: record } }, null, 2)}\n`,
      );
      const spent = calls.reduce((s, c) => s + c.usd, 0);
      console.log(
        `${row.isrc} ${row.title}: ${outcome}; ${record.edges.length} edges, ${record.claims.length} claims; USD ${spent.toFixed(4)} (spend log)`,
      );
    } else {
      const was = committed.get(row.isrc);
      const same =
        was &&
        JSON.stringify([was.outcome, was.edges, was.claims.map((c) => c.text)]) ===
          JSON.stringify([record.outcome, record.edges, record.claims.map((c) => c.text)]);
      if (!same) failures++;
      console.log(`${same ? "ok  " : "FAIL"} ${row.isrc} ${row.title}: ${record.outcome}`);
    }
  }
  if (failures) {
    console.error(`baseline: ${failures} row(s) did not replay as recorded`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`baseline: ${error.message}`);
    process.exit(1);
  });
}
