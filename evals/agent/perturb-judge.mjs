#!/usr/bin/env node
// The verifier's judge on the claim cases of evals/perturb.jsonl, through the app's own
// judgeClaims (apps/api/src/agent/verifier/judge.ts) and its model layer.
//
//   node evals/agent/perturb-judge.mjs --mode live --cassettes <dir> --spend-log <file> --out <file>
//   node evals/agent/perturb-judge.mjs --mode replay [--cassettes <dir>] [--check <file>]
//
// Live: purpose eval:perturb, LLM_CASSETTE=record into <cassettes> (committed as
// fixtures/cassettes/llm/perturb); writes the verdicts to <out>. Replay (the default directory is
// fixtures/cassettes/llm/perturb): the same calls answered from the cassettes, no network and no
// spending; with --check, the verdicts must equal that file's. perturb-check.mjs prints the
// catch and false-positive rates from a replay.
//
// Batches: one judge call per recording and group, with the positives in group 0, each
// positive's first mutation in group 1 and its second in group 2, so a statement is never judged
// beside its own mutation. Each batch is at most the judge's batch size. The judge sees what the
// app's judge sees: the track (title, artist, album, year from the recording), the statements
// (their ids replaced by the judge's own c1, c2…) and the cited excerpts, with each item's id,
// source and scope as the recording holds it. Labels, mutation kinds and case ids never reach it.
//
// A case is "shown as sourced" by the app's own rule, `verdictSources` in verifier/index.ts,
// called here: `supported`, or `partial` for a statement that asserts no relation (a relation is
// stated whole). The verdicts are the judge's; the labels come from how the case was built,
// never from a verdict.

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { importApp } from "./lib/app.mjs";
import { EVALS_DIR, REPO_ROOT } from "./lib/golden.mjs";
import { appModelLayer } from "./lib/inproc.mjs";
import { callsOf } from "./lib/record.mjs";
import { claimsOf, positiveSource, readRecordings } from "./make-perturb.mjs";
import { readPerturb } from "./perturb-check.mjs";

export const PERTURB_CASSETTES = join(REPO_ROOT, "fixtures", "cassettes", "llm", "perturb");
export const PERTURB_PATH = join(EVALS_DIR, "perturb.jsonl");
export const CALL_SITE = "eval-perturb";
const GROUPS = 3;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const v = argv[++i];
    if (!["--mode", "--cassettes", "--spend-log", "--out", "--check", "--perturb"].includes(flag)) {
      throw new Error(`unknown argument ${flag}`);
    }
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    opts[flag.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = v;
  }
  if (!["live", "replay"].includes(opts.mode)) throw new Error("--mode live or replay");
  return opts;
}

/**
 * The claim cases in judge batches: [{ recording, group, cases }], in a fixed order. A
 * positive's mutations go in the groups after its own, by their order in the set.
 */
export function batches(cases, max) {
  const claimCases = cases.filter((c) => c.kind === "claim");
  const order = new Map();
  for (const c of claimCases) {
    if (c.parentId === null) order.set(c.id, 0);
    else order.set(c.id, 1 + claimCases.filter((x) => x.parentId === c.parentId).indexOf(c));
  }
  const out = [];
  const recordings = [...new Set(claimCases.map((c) => c.recording))];
  for (const recording of recordings) {
    for (let group = 0; group < GROUPS; group++) {
      const mine = claimCases.filter((c) => c.recording === recording && order.get(c.id) === group);
      for (let i = 0; i < mine.length; i += max) {
        out.push({ recording, group, cases: mine.slice(i, i + max) });
      }
    }
  }
  return out;
}

/** Every evidence item of the recordings, by id, as the recordings hold it. */
function evidenceIndex(recordings) {
  const byId = new Map();
  for (const r of recordings)
    for (const e of r.analysis.evidence) if (!byId.has(e.id)) byId.set(e.id, e);
  return byId;
}

/**
 * One batch as the judge's inputs: the claims (each citing its own items) and the evidence. An
 * id that two cases of the batch cite with different excerpts gets a suffix for the second
 * one, so each statement is read against its own excerpt.
 */
export function judgeInputs(batch, recordings, index) {
  const byClaim = new Map();
  for (const r of recordings)
    for (const c of r.analysis.claims) byClaim.set(`${r.slug}:${c.id.slice(0, 8)}`, c);
  const evidence = new Map();
  const claims = batch.cases.map((c) => {
    const parentKey = c.parentId ?? c.id;
    const original = byClaim.get(parentKey);
    const ids = c.evidence.map((e) => {
      const known = index.get(e.id);
      let id = e.id;
      for (let n = 2; evidence.has(id) && evidence.get(id).excerpt !== e.excerpt; n++)
        id = `${e.id}~${n}`;
      evidence.set(id, {
        id,
        source: e.source,
        sourceTier: known?.sourceTier ?? "web",
        url: e.url ?? null,
        title: known?.title ?? "",
        retrievedAt: known?.retrievedAt ?? "2026-10-29T00:00:00.000Z",
        excerpt: e.excerpt,
        recordRef: known?.recordRef ?? null,
        ...(known?.about ? { about: known.about } : {}),
      });
      return id;
    });
    return {
      id: c.id,
      text: c.claim.text,
      about: c.claim.about,
      kind: "sourced",
      origin: c.claim.origin,
      evidenceIds: ids,
      verdict: null,
      verdictReason: null,
      numericCheck: "n/a",
      scope: original?.scope ?? "recording",
    };
  });
  return { claims, evidence: [...evidence.values()] };
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** The model-positive pool: model claims of the recordings that cite evidence, and how many pass. */
export function modelPool(recordings) {
  const claims = recordings.flatMap(claimsOf).filter((c) => c.origin === "model");
  const passed = claims.filter((c) => positiveSource(c) === "model-support-check");
  return {
    modelClaimsCitingEvidence: claims.length,
    passedSupportCheck: passed.length,
    refused: claims
      .filter((c) => positiveSource(c) !== "model-support-check")
      .map((c) => ({ recording: c.recording, claimId: c.claimId, text: c.text })),
  };
}

export async function judgeAll({ mode, cassetteDir, spendLog, perturbPath = PERTURB_PATH }) {
  const { agentRuntime } = await appModelLayer({
    cassette: mode === "live" ? "record" : "replay",
    cassetteDir,
    spendLog,
    purpose: "eval:perturb",
  });
  const [{ judgeClaims }, verifier, { JUDGE_BATCH_MAX }] = await Promise.all([
    importApp("apps/api/src/agent/verifier/judge.ts"),
    importApp("apps/api/src/agent/verifier/index.ts"),
    importApp("packages/contract/dist/index.js"),
  ]);
  const max = JUDGE_BATCH_MAX;
  const runtime = agentRuntime({ purpose: "eval:perturb" });
  const cases = readPerturb(perturbPath);
  const recordings = readRecordings();
  const index = evidenceIndex(recordings);
  const bySlug = new Map(recordings.map((r) => [r.slug, r]));
  const out = [];
  const runIds = [];
  const plan = batches(cases, max);
  for (const [i, batch] of plan.entries()) {
    const runId = `eval-perturb-${batch.recording}-g${batch.group}-${i + 1}`;
    runIds.push(runId);
    const a = bySlug.get(batch.recording).analysis;
    const track = {
      title: a.title,
      artist: a.artist,
      album: a.album || null,
      year: a.releaseYear ?? null,
    };
    const { claims, evidence } = judgeInputs(batch, recordings, index);
    const result = await judgeClaims(claims, evidence, track, runtime, {
      runId,
      callSite: CALL_SITE,
    });
    runtime.llm.endRun(runId);
    const evidenceById = new Map(evidence.map((e) => [e.id, e]));
    for (const claim of claims) {
      const c = batch.cases.find((x) => x.id === claim.id);
      const judged = result.verdicts.get(claim.id) ?? null;
      const relation =
        verifier.RELATION_ABOUT.has(claim.about) ||
        claim.evidenceIds.some((id) => verifier.isRelationRecord(evidenceById.get(id)));
      const verdict = judged?.verdict ?? null;
      const parent = c.parentId ? cases.find((x) => x.id === c.parentId) : c;
      out.push({
        id: c.id,
        recording: c.recording,
        label: c.label,
        positiveSource: parent.positiveSource,
        mutation: c.mutation,
        about: claim.about,
        relation,
        runId,
        verdict,
        reason: judged?.reason ?? null,
        shownAsSourced: verifier.verdictSources(verdict, relation),
      });
    }
    const failure = result.failure
      ? ` (failure: ${result.failure.kind ?? "error"}: ${result.failure.message})`
      : "";
    console.log(
      `batch ${i + 1}/${plan.length} ${batch.recording} group ${batch.group}: ${claims.length} statements, ${result.judged} judged${failure}`,
    );
  }
  return { cases: out, runIds };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`perturb-judge: ${error.message}`);
    process.exit(2);
  }
  const live = opts.mode === "live";
  const perturbPath = resolve(opts.perturb ?? PERTURB_PATH);
  if (live) {
    for (const need of ["cassettes", "spendLog", "out"]) {
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
  }
  const cassetteDir = resolve(opts.cassettes ?? PERTURB_CASSETTES);
  const spendLog = live ? resolve(opts.spendLog) : join(cassetteDir, ".no-spend-log");
  const { cases, runIds } = await judgeAll({ mode: opts.mode, cassetteDir, spendLog, perturbPath });
  if (live) {
    const lines = readFileSync(spendLog, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    const calls = runIds.flatMap((id) => callsOf(lines, id));
    const commit = execFileSync("git", ["rev-parse", "--short=12", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    const doc = {
      version: 1,
      recordedAt: new Date().toISOString(),
      commit,
      perturb: { path: relative(REPO_ROOT, perturbPath), sha256: sha256(perturbPath) },
      judge: { tier: "judge", deployments: [...new Set(calls.map((c) => c.deployment))].sort() },
      pool: modelPool(readRecordings()),
      runIds,
      calls,
      cases,
    };
    writeFileSync(resolve(opts.out), `${JSON.stringify(doc, null, 2)}\n`);
    const spent = calls.reduce((s, c) => s + c.usd, 0);
    console.log(
      `wrote ${opts.out}: ${cases.length} cases, ${calls.length} calls, USD ${spent.toFixed(4)} (spend log)`,
    );
    return;
  }
  if (opts.check) {
    const committed = JSON.parse(readFileSync(resolve(opts.check), "utf8"));
    const want = committed.cases.map((c) => `${c.id}=${c.verdict}`).join("\n");
    const got = cases.map((c) => `${c.id}=${c.verdict}`).join("\n");
    if (want !== got) {
      console.error("perturb-judge: the replayed verdicts differ from the committed ones");
      process.exit(1);
    }
    console.log(`replayed ${cases.length} verdicts: as committed`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`perturb-judge: ${error.message}`);
    process.exit(1);
  });
}
