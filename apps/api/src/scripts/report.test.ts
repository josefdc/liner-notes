import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordLlmUsage } from "../llm/usage.js";
import { MIGRATIONS, runMigrations } from "../store/migrations.js";
import { DEFAULT_RETENTION, pruneDatabase } from "../store/retention.js";
import { startRun, storeReplayOf, storeRunResult, updateRun } from "../store/runs.js";
import {
  buildReport,
  formatReport,
  isPrunedDay,
  main,
  openForReading,
  type PrunedDay,
  percentile,
  type ReportRow,
  type RunReport,
  reportSettings,
} from "./report.js";

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const DAY_S = 24 * 60 * 60;
const DAY_MS = DAY_S * 1000;
const TYPED = "a typed query nobody should see";
const TRACK = "4uLU6hMCjMI75M1A2tKUQC";

/** A result of run `runId` that fits the contract, with any run information. */
const result = (runId: string, run: Record<string, unknown> = {}) => ({
  id: TRACK,
  title: "T",
  artist: "A",
  album: "B",
  coverUrl: "",
  bpm: null,
  genealogy: { nodes: [], links: [] },
  run: {
    id: `run-id-${runId}`,
    mode: "live",
    recordedAt: null,
    commit: null,
    analyzerVersion: null,
    ...run,
  },
});

interface SeedRun {
  id: string;
  start: string;
  /** How the run ends, `seconds` after its start; "interrupted" leaves it waiting. */
  status: "completed" | "failed" | "cancelled" | "interrupted";
  seconds?: number;
  /** A wait at the track picker, from `at` seconds after the start, for `for` seconds. */
  wait?: { at: number; for: number };
  how?: "live" | "replay" | "cached" | "replayed_answers";
  /** The stored result's run information (a completed live run); "none" stores no result. */
  stored?: Record<string, unknown> | "none";
  pausesKnown?: boolean;
}

/** Records each run the way the API does, on the fake clock: start, waits, outcome, result. */
function recordRuns(db: Database.Database, runs: SeedRun[]): void {
  for (const run of runs) {
    const id = `run-id-${run.id}`;
    const start = Date.parse(run.start);
    vi.setSystemTime(start);
    startRun(db, { runId: id, threadId: id, query: TYPED, pausesKnown: run.pausesKnown });
    const replay = { slug: "slug", recordedAt: "2026-10-01T00:00:00Z", digest: "d" };
    if (run.how === "replay") storeReplayOf(db, id, replay);
    if (run.wait) {
      vi.setSystemTime(start + run.wait.at * 1000);
      updateRun(db, id, { status: "interrupted" });
      if (run.status === "interrupted") continue;
      vi.setSystemTime(start + (run.wait.at + run.wait.for) * 1000);
      updateRun(db, id, { status: "running" });
    }
    if (run.status === "interrupted") {
      updateRun(db, id, { status: "interrupted" });
      continue;
    }
    vi.setSystemTime(start + (run.seconds ?? 0) * 1000);
    updateRun(db, id, { status: run.status });
    if (run.status !== "completed") continue;
    if (run.how === "replay") storeReplayOf(db, id, replay, TRACK);
    else if (run.how === "cached") storeRunResult(db, id, result("an-earlier-run"));
    else if (run.how === "replayed_answers") {
      storeRunResult(
        db,
        id,
        result(run.id, {
          mode: "replay",
          replayed: "model_answers",
          recordedAt: "2026-10-01T00:00:00.000Z",
          commit: "abc1234",
          fallback: false,
        }),
      );
    } else if (run.stored !== "none") storeRunResult(db, id, result(run.id, run.stored));
  }
}

/** Usage rows as invoke.ts writes them (recordLlmUsage), dated `at`. */
function recordUsage(
  db: Database.Database,
  rows: Array<{
    at: string;
    runId?: string;
    purpose?: string;
    mode?: "live" | "replay";
    status?: string;
    input: number | null;
    output: number | null;
    usd: number;
    estimated?: boolean;
    /** Default: sent unless replayed, as invoke.ts records it. */
    sent?: boolean;
  }>,
): void {
  rows.forEach((row, i) => {
    const id = `usage-${db.prepare("SELECT COUNT(*) FROM llm_usage").pluck().get()}-${i}`;
    recordLlmUsage(db, {
      id,
      runId: row.runId ?? "run-id-a",
      callSite: "composer",
      tier: "main",
      deployment: "deployment",
      purpose: row.purpose ?? "dev",
      mode: row.mode ?? "live",
      status: row.status ?? "ok",
      inputTokens: row.input,
      outputTokens: row.output,
      reasoningTokens: null,
      usdEst: row.usd,
      priceMultiplier: 1,
      estimated: row.estimated ?? false,
      latencyMs: 100,
      sent: row.sent ?? row.mode !== "replay",
    });
    db.prepare("UPDATE llm_usage SET created_at = ? WHERE id = ?").run(
      Date.parse(row.at) / 1000,
      id,
    );
  });
}

/** Three days of runs (Oct 23 to 25) and one older run and usage row the window leaves out. */
function seed(db: Database.Database): void {
  recordRuns(db, [
    { id: "before", status: "completed", start: "2026-10-22T23:59:59Z", seconds: 5 },
    // Oct 23: three completed live runs (b waited 10 minutes at the picker; c's result could not
    // be stored), a replay, a failure, and a run whose model answers were replayed.
    {
      id: "a",
      status: "completed",
      start: "2026-10-23T10:00:00Z",
      seconds: 40,
      stored: { fallback: false },
    },
    {
      id: "b",
      status: "completed",
      start: "2026-10-23T11:00:00Z",
      wait: { at: 4, for: 600 },
      seconds: 700,
      stored: { fallback: true },
    },
    { id: "c", status: "completed", start: "2026-10-23T12:00:00Z", seconds: 20, stored: "none" },
    { id: "d", how: "replay", status: "completed", start: "2026-10-23T13:00:00Z", seconds: 1 },
    { id: "e", status: "failed", start: "2026-10-23T14:00:00Z", seconds: 3 },
    {
      id: "k",
      how: "replayed_answers",
      status: "completed",
      start: "2026-10-23T15:00:00Z",
      seconds: 2,
    },
    // Oct 24: a cached result, a live run whose wait is unknown and whose result does not say
    // whether it is a fallback, an open and a cancelled run.
    { id: "f", how: "cached", status: "completed", start: "2026-10-24T09:00:00Z", seconds: 1 },
    {
      id: "g",
      status: "completed",
      start: "2026-10-24T10:00:00Z",
      seconds: 90,
      pausesKnown: false,
    },
    { id: "h", status: "interrupted", start: "2026-10-24T11:00:00Z", wait: { at: 3, for: 0 } },
    { id: "i", status: "cancelled", start: "2026-10-24T23:59:59Z", seconds: 2 },
  ]);
  recordUsage(db, [
    { at: "2026-10-22T12:00:00Z", input: 1, output: 1, usd: 9 },
    { at: "2026-10-23T10:00:10Z", input: 100, output: 50, usd: 0.01 },
    { at: "2026-10-23T11:00:10Z", input: 200, output: 100, usd: 0.02 },
    // No usage reported: counted at the worst case, tokens unknown.
    {
      at: "2026-10-23T11:00:20Z",
      status: "error:timeout",
      input: null,
      output: null,
      usd: 0.005,
      estimated: true,
    },
    // Part of the usage reported: estimated, its partial tokens left out.
    { at: "2026-10-23T12:00:10Z", input: 70, output: null, usd: 0.004, estimated: true },
    // Stopped before its request left (or no connection made): an attempt, not a call sent.
    {
      at: "2026-10-23T12:00:20Z",
      status: "error:aborted",
      input: null,
      output: null,
      usd: 0,
      sent: false,
    },
    // Answered from stored answers: never sent, the recorded tokens are not this run's.
    { at: "2026-10-23T15:00:01Z", mode: "replay", input: 5000, output: 3000, usd: 0 },
    { at: "2026-10-25T08:00:00Z", purpose: "eval", input: 1000, output: 10, usd: 0.5 },
  ]);
}

const kept = (row: ReportRow | PrunedDay): ReportRow => {
  if (isPrunedDay(row)) throw new Error(`${row.day} is pruned`);
  return row;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("percentile", () => {
  it("takes the nearest rank", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([20, 40, 100], 50)).toBe(40);
    expect(percentile([20, 40, 100], 95)).toBe(100);
    const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
  });
});

describe("buildReport", () => {
  let db: Database.Database;
  let report: RunReport;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    seed(db);
    report = buildReport(db, { days: 3, now: NOW });
  });
  afterEach(() => db.close());

  it("counts runs per day by how they were served and how they ended", () => {
    expect(report).toMatchObject({ from: "2026-10-23", to: "2026-10-25", days: 3 });
    expect(report.perDay.map((row) => row.day)).toEqual(["2026-10-23", "2026-10-24", "2026-10-25"]);
    const [oct23, oct24, oct25] = report.perDay.map(kept);
    expect(oct23).toMatchObject({
      retention: "kept",
      runs: 6,
      live: 4,
      replay: 2,
      replayedAnswers: 1,
      cached: 0,
      completed: 5,
      failed: 1,
      cancelled: 0,
      open: 0,
    });
    expect(oct24).toMatchObject({
      runs: 4,
      live: 3,
      replay: 0,
      cached: 1,
      completed: 2,
      failed: 0,
      cancelled: 1,
      open: 1,
    });
    expect(oct25).toMatchObject({ runs: 0, completed: 0 });
    expect(report.total).toMatchObject({
      day: "total",
      runs: 10,
      live: 7,
      replay: 2,
      replayedAnswers: 1,
      cached: 1,
    });
  });

  it("gives p50/p95 of completed live runs without the wait at the picker, leaving out unknown waits", () => {
    // a 40 s, b 700 s less 600 s waiting, c 20 s; replays (k's model answers included) and the
    // cached result do not count.
    const [oct23, oct24, oct25] = report.perDay.map(kept);
    expect(oct23.durations).toEqual({ runs: 3, unknown: 0, p50: 40, p95: 100 });
    expect(oct24.durations).toEqual({ runs: 0, unknown: 1, p50: null, p95: null });
    expect(oct25.durations).toEqual({ runs: 0, unknown: 0, p50: null, p95: null });
    expect(report.total.durations).toEqual({ runs: 3, unknown: 1, p50: 40, p95: 100 });
  });

  it("gives the fallback rate of completed live runs whose result says, counting the others apart", () => {
    const [oct23, oct24, oct25] = report.perDay.map(kept);
    expect(oct23.fallback).toEqual({ runs: 2, fallback: 1, unknown: 0, rate: 0.5 });
    expect(oct24.fallback).toEqual({ runs: 0, fallback: 0, unknown: 1, rate: null });
    expect(oct25.fallback).toEqual({ runs: 0, fallback: 0, unknown: 0, rate: null });
    expect(report.total.fallback).toEqual({ runs: 2, fallback: 1, unknown: 1, rate: 0.5 });
  });

  it("sums model calls sent, tokens of the unestimated ones and estimated USD, apart from replayed and unsent attempts", () => {
    const [oct23, oct24, oct25] = report.perDay.map(kept);
    expect(oct23.model).toMatchObject({
      calls: 4,
      errors: 1,
      inputTokens: 300,
      outputTokens: 150,
      estimatedCalls: 2,
      replayedCalls: 1,
      unsentCalls: 1,
      sentUnknownCalls: 0,
    });
    expect(oct23.model?.usdEstimate).toBeCloseTo(0.039, 10);
    expect(oct24.model).toEqual({
      calls: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      usdEstimate: 0,
      estimatedCalls: 0,
      replayedCalls: 0,
      unsentCalls: 0,
      sentUnknownCalls: 0,
    });
    expect(oct25.model).toMatchObject({ calls: 1, inputTokens: 1000, usdEstimate: 0.5 });
    expect(report.total.model).toMatchObject({
      calls: 5,
      errors: 1,
      inputTokens: 1300,
      outputTokens: 160,
      estimatedCalls: 2,
      replayedCalls: 1,
      unsentCalls: 1,
      sentUnknownCalls: 0,
    });
    expect(report.total.model?.usdEstimate).toBeCloseTo(0.539, 10);
    expect(Object.keys(report.modelByPurpose ?? {})).toEqual(["dev", "eval"]);
    expect(report.modelByPurpose?.dev).toMatchObject({ calls: 4, replayedCalls: 1 });
    expect(report.modelByPurpose?.eval.usdEstimate).toBe(0.5);
  });

  it("writes a table and notes, and never what was typed or a run id", () => {
    const text = formatReport(report);
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      "Runs 2026-10-23 to 2026-10-25 (UTC, 3 days): runs by the day each started, model use by " +
        "the day of the call",
    );
    expect(lines[2]).toMatch(/^day\s+runs\s+live\s+replay\s.*\sfallback\s.*\sUSD \(est\.\)$/);
    expect(lines[3].split(/\s+/)).toEqual([
      "2026-10-23",
      "6",
      "4",
      "2",
      "0",
      "5",
      "1",
      "0",
      "0",
      "40",
      "100",
      "1/2",
      "50%",
      "4",
      "300",
      "150",
      "$0.0390",
    ]);
    expect(lines[6].split(/\s+/).slice(0, 2)).toEqual(["total", "10"]);
    expect(text).toContain("less the time spent waiting at the track picker");
    expect(text).toContain("1 left out: their wait is unknown");
    expect(text).toContain("model answers were replayed from stored answers (1)");
    expect(text).toContain("of the 2 whose stored result says either way; 1 say neither.");
    expect(text).toContain("5 call attempts sent to the provider (1 failed)");
    expect(text).toContain("2 are marked estimated");
    expect(text).toContain("the token columns leave them out, USD (est.) counts their estimate");
    expect(text).toContain("1 calls answered from stored answers are not counted");
    expect(text).toContain(
      "1 attempts not sent (stopped before the request left, or no connection made) are not " +
        "counted as calls; they cost nothing.",
    );
    expect(text).not.toContain("before schema v12");
    expect(text).toContain("Model by purpose: dev 4 calls $0.0390, eval 1 calls $0.5000.");
    // Never pruned: marked from the setting, and it says so.
    expect(report).toMatchObject({ cutoffSource: "setting", retentionDays: 30 });
    expect(text).toContain(
      "Retention: the database records no cutoff applied by retention (it has not been pruned " +
        "since schema v12), so days are marked from the current RUN_RETENTION_DAYS=30: none in " +
        "this window is past it. Days deleted under a shorter setting would show as kept.",
    );
    expect(text).not.toContain(TYPED);
    expect(text).not.toContain("run-id-");
    expect(JSON.stringify(report)).not.toMatch(new RegExp(`${TYPED}|run-id-`));
  });
});

describe("buildReport past the run retention", () => {
  it("shows the days retention deleted as pruned, not as days without runs or spend", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db);
      recordRuns(db, [
        { id: "old", status: "completed", start: "2026-09-20T10:00:00Z", seconds: 30 },
        { id: "new", status: "completed", start: "2026-10-24T10:00:00Z", seconds: 30 },
      ]);
      recordUsage(db, [
        { at: "2026-09-20T10:00:10Z", input: 10, output: 10, usd: 0.5 },
        { at: "2026-10-24T10:00:10Z", input: 10, output: 10, usd: 0.25 },
      ]);
      expect(pruneDatabase(db, DEFAULT_RETENTION, NOW)).toMatchObject({ runs: 1, llmUsage: 1 });

      const report = buildReport(db, { days: 40, now: NOW, retentionDays: 30 });

      // The cutoff is 2026-09-25 12:00: earlier days are pruned, that day partly.
      expect(report).toMatchObject({
        retentionDays: 30,
        cutoffSource: "recorded",
        cutoff: "2026-09-25T12:00:00.000Z",
        keptFrom: "2026-09-26",
      });
      const byDay = new Map(report.perDay.map((row) => [row.day, row]));
      expect(byDay.get("2026-09-16")).toEqual({ day: "2026-09-16", retention: "pruned" });
      expect(byDay.get("2026-09-20")).toEqual({ day: "2026-09-20", retention: "pruned" });
      expect(byDay.get("2026-09-24")).toEqual({ day: "2026-09-24", retention: "pruned" });
      expect(byDay.get("2026-09-25")).toMatchObject({ retention: "partly_pruned", runs: 0 });
      expect(byDay.get("2026-09-26")).toMatchObject({ retention: "kept", runs: 0 });
      expect(report.perDay.filter(isPrunedDay)).toHaveLength(9);
      expect(report.total).toMatchObject({ retention: "partly_pruned", runs: 1 });
      expect(report.total.model?.usdEstimate).toBe(0.25);

      const text = formatReport(report);
      expect(text).toMatch(/^2026-09-20\s+pruned$/m);
      expect(text).toMatch(/^2026-09-25\*\s+0\s/m);
      expect(text).not.toMatch(/^2026-09-20\s+0/m);
      expect(text).toContain(
        "Retention: runs and usage rows up to 2026-09-25 12:00 UTC have been deleted (the latest " +
          "cutoff retention applied); records are complete from 2026-09-26. 9 pruned days are " +
          "not counted, in the total either. * partly pruned.",
      );
    } finally {
      db.close();
    }
  });

  it("marks the days a shorter retention deleted as pruned after the setting is raised", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db);
      recordRuns(db, [
        { id: "20d", status: "completed", start: "2026-10-05T10:00:00Z", seconds: 30 },
        { id: "10d", status: "completed", start: "2026-10-15T10:00:00Z", seconds: 30 },
        { id: "1d", status: "completed", start: "2026-10-24T10:00:00Z", seconds: 30 },
      ]);
      recordUsage(db, [
        { at: "2026-10-05T10:00:10Z", runId: "run-id-20d", input: 10, output: 10, usd: 0.25 },
        { at: "2026-10-15T10:00:10Z", runId: "run-id-10d", input: 10, output: 10, usd: 0.25 },
        { at: "2026-10-24T10:00:10Z", runId: "run-id-1d", input: 10, output: 10, usd: 0.25 },
      ]);
      const sevenDays = { ...DEFAULT_RETENTION, runRetentionMs: 7 * DAY_MS };
      expect(pruneDatabase(db, sevenDays, NOW - DAY_MS)).toMatchObject({ runs: 2, llmUsage: 2 });
      // RUN_RETENTION_DAYS raised to 30: the next prune deletes nothing, and keeps the mark.
      expect(pruneDatabase(db, DEFAULT_RETENTION, NOW)).toMatchObject({ runs: 0 });

      const report = buildReport(db, { days: 21, now: NOW, retentionDays: 30 });

      // Pruned at 2026-10-24 12:00 less 7 days.
      expect(report).toMatchObject({
        retentionDays: 30,
        cutoffSource: "recorded",
        cutoff: "2026-10-17T12:00:00.000Z",
        keptFrom: "2026-10-18",
      });
      const byDay = new Map(report.perDay.map((row) => [row.day, row]));
      expect(byDay.get("2026-10-05")).toEqual({ day: "2026-10-05", retention: "pruned" });
      expect(byDay.get("2026-10-15")).toEqual({ day: "2026-10-15", retention: "pruned" });
      expect(byDay.get("2026-10-17")).toMatchObject({ retention: "partly_pruned", runs: 0 });
      expect(byDay.get("2026-10-18")).toMatchObject({ retention: "kept", runs: 0 });
      expect(report.perDay.filter(isPrunedDay)).toHaveLength(12);
      expect(report.total).toMatchObject({ retention: "partly_pruned", runs: 1 });

      const text = formatReport(report);
      expect(text).toMatch(/^2026-10-05\s+pruned$/m);
      expect(text).toMatch(/^2026-10-15\s+pruned$/m);
      expect(text).not.toMatch(/^2026-10-15\s+0\s/m);
      expect(text).toContain("12 pruned days are not counted");
    } finally {
      db.close();
    }
  });

  it("leaves out of the total the records still kept on a pruned day", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db);
      // Started on 2026-10-15 and waited at the picker until yesterday: retention keeps a run
      // until it finished longer ago than the retention, and its usage rows with it.
      recordRuns(db, [
        {
          id: "long",
          status: "completed",
          start: "2026-10-15T10:00:00Z",
          wait: { at: 5, for: 9 * DAY_S },
          seconds: 9 * DAY_S + 30,
        },
        { id: "new", status: "completed", start: "2026-10-25T10:00:00Z", seconds: 30 },
      ]);
      recordUsage(db, [
        { at: "2026-10-15T10:00:01Z", runId: "run-id-long", input: 10, output: 10, usd: 0.5 },
        { at: "2026-10-25T10:00:10Z", runId: "run-id-new", input: 10, output: 10, usd: 0.25 },
      ]);
      const sevenDays = { ...DEFAULT_RETENTION, runRetentionMs: 7 * DAY_MS };
      expect(pruneDatabase(db, sevenDays, NOW)).toMatchObject({ runs: 0, llmUsage: 0 });

      const report = buildReport(db, { days: 14, now: NOW });

      expect(report.perDay.find((row) => row.day === "2026-10-15")).toEqual({
        day: "2026-10-15",
        retention: "pruned",
      });
      expect(report.total).toMatchObject({ runs: 1, completed: 1 });
      expect(report.total.model).toMatchObject({ calls: 1, inputTokens: 10 });
      expect(report.total.model?.usdEstimate).toBe(0.25);
      expect(report.modelByPurpose?.dev).toMatchObject({ calls: 1, usdEstimate: 0.25 });
    } finally {
      db.close();
    }
  });
});

describe("buildReport on usage rows recorded before sends were kept", () => {
  it("counts their tokens and cost but not as calls sent, and says so", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db, MIGRATIONS.slice(0, 11));
      db.prepare(
        `INSERT INTO llm_usage (id, run_id, call_site, tier, deployment, purpose, mode, status,
           input_tokens, output_tokens, usd_est, price_multiplier, estimated, latency_ms,
           created_at)
         VALUES ('old', 'run-id-a', 'composer', 'main', 'd', 'dev', 'live', 'ok', 100, 20, 0.1,
           1, 0, 5, ?)`,
      ).run(Date.parse("2026-10-24T10:00:00Z") / 1000);
      const before = buildReport(db, { days: 2, now: NOW });
      expect(before.schemaVersion).toBe(11);
      expect(before.total.model).toMatchObject({
        calls: 0,
        sentUnknownCalls: 1,
        unsentCalls: 0,
        inputTokens: 100,
        usdEstimate: 0.1,
      });

      runMigrations(db);
      recordUsage(db, [{ at: "2026-10-25T10:00:00Z", input: 10, output: 10, usd: 0.25 }]);
      const report = buildReport(db, { days: 2, now: NOW });
      expect(report.total.model).toMatchObject({
        calls: 1,
        sentUnknownCalls: 1,
        inputTokens: 110,
      });
      expect(report.total.model?.usdEstimate).toBeCloseTo(0.35, 10);
      expect(formatReport(report)).toContain(
        "1 attempts recorded before schema v12 do not say whether they were sent: not counted " +
          "as calls, their tokens and USD are.",
      );
    } finally {
      db.close();
    }
  });
});

describe("buildReport on a database migrated before waits were kept", () => {
  it("knows no duration and still counts runs, fallbacks and spend", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db, MIGRATIONS.slice(0, 10));
      db.prepare(
        `INSERT INTO runs (run_id, thread_id, query, status, created_at, finished_at, analysis)
         VALUES ('run-id-a', 't', ?, 'completed', ?, ?, ?)`,
      ).run(
        TYPED,
        Date.parse("2026-10-25T10:00:00Z") / 1000,
        Date.parse("2026-10-25T10:00:40Z") / 1000,
        JSON.stringify(result("a", { fallback: true })),
      );
      const report = buildReport(db, { days: 1, now: NOW });
      expect(report).toMatchObject({ pausesKept: false, schemaVersion: 10 });
      expect(report.total).toMatchObject({
        runs: 1,
        durations: { runs: 0, unknown: 1, p50: null, p95: null },
        fallback: { runs: 1, fallback: 1, unknown: 0, rate: 1 },
        model: { calls: 0 },
      });
      expect(formatReport(report)).toContain("before waits were kept (start the API once");
    } finally {
      db.close();
    }
  });
});

describe("reportSettings", () => {
  const file = { SQLITE_DB_PATH: "/from/file.db", RUN_RETENTION_DAYS: "9", OTHER: "x" };

  it("takes a value set in the environment, even blank, as the API does; else the file's", () => {
    expect(reportSettings({}, file)).toEqual({
      SQLITE_DB_PATH: "/from/file.db",
      RUN_RETENTION_DAYS: "9",
    });
    expect(reportSettings({ SQLITE_DB_PATH: "/from/env.db" }, file).SQLITE_DB_PATH).toBe(
      "/from/env.db",
    );
    // dotenv leaves a variable the environment sets blank, and the API then uses the default.
    expect(reportSettings({ SQLITE_DB_PATH: "", RUN_RETENTION_DAYS: "" }, file)).toEqual({
      SQLITE_DB_PATH: "",
      RUN_RETENTION_DAYS: "",
    });
  });
});

describe("openForReading", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "report-open-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const digest = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const insertRun = (db: Database.Database) =>
    db
      .prepare(
        "INSERT INTO runs (run_id, thread_id, query, status) VALUES ('r', 't', 'q', 'completed')",
      )
      .run();

  it("writes nothing next to a WAL database the API closed: no -wal, no -shm", () => {
    const path = join(dir, "api.db");
    const api = new Database(path);
    api.pragma("journal_mode = WAL");
    runMigrations(api);
    insertRun(api);
    api.close();
    const before = digest(path);
    expect(readdirSync(dir)).toEqual(["api.db"]);

    const db = openForReading(path);
    expect(db.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(1);
    db.close();

    expect(readdirSync(dir)).toEqual(["api.db"]);
    expect(digest(path)).toBe(before);
  });

  it("reads a running API's database read-only, its uncheckpointed writes included", () => {
    const path = join(dir, "api.db");
    const api = new Database(path);
    try {
      api.pragma("journal_mode = WAL");
      api.pragma("wal_autocheckpoint = 0");
      runMigrations(api);
      insertRun(api);
      const before = digest(path);

      const db = openForReading(path);
      expect(db.readonly).toBe(true);
      expect(db.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(1);
      db.close();
      expect(digest(path)).toBe(before);
    } finally {
      api.close();
    }
  });

  /** A closed database at `path` with one run, in rollback-journal mode unless `wal`. */
  const closedDatabase = (path: string, wal = false) => {
    const api = new Database(path);
    if (wal) api.pragma("journal_mode = WAL");
    runMigrations(api);
    insertRun(api);
    api.close();
  };

  it("reads a database that is the same after the read into memory", () => {
    const path = join(dir, "api.db");
    closedDatabase(path);
    const db = openForReading(path, { readFile: (file) => readFileSync(file) });
    expect(db.readonly).toBe(false);
    expect(db.memory).toBe(true);
    db.close();
  });

  it("drops the copy and opens read-only when the file changed while it was read", () => {
    const path = join(dir, "api.db");
    closedDatabase(path);
    const db = openForReading(path, {
      readFile: (file) => {
        const image = readFileSync(file);
        // The API started and wrote while the file was read (rollback journal: no -wal).
        const api = new Database(path);
        api
          .prepare(
            "INSERT INTO runs (run_id, thread_id, query, status) VALUES ('r2', 't', 'q', 'running')",
          )
          .run();
        api.close();
        expect(readdirSync(dir)).toEqual(["api.db"]);
        return image;
      },
    });
    try {
      expect(db.readonly).toBe(true);
      expect(db.memory).toBe(false);
      expect(db.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(2);
    } finally {
      db.close();
    }
  });

  it("drops the copy and opens read-only when a -wal appeared while the file was read", () => {
    const path = join(dir, "api.db");
    closedDatabase(path, true);
    let api: Database.Database | null = null;
    try {
      const db = openForReading(path, {
        readFile: (file) => {
          const image = readFileSync(file);
          api = new Database(path);
          api.pragma("wal_autocheckpoint = 0");
          api
            .prepare(
              "INSERT INTO runs (run_id, thread_id, query, status) VALUES ('r2', 't', 'q', 'running')",
            )
            .run();
          return image;
        },
      });
      expect(db.readonly).toBe(true);
      expect(db.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(2);
      db.close();
    } finally {
      (api as Database.Database | null)?.close();
    }
  });

  it("opens a file above the in-memory limit read-only, without reading it", () => {
    const path = join(dir, "api.db");
    closedDatabase(path);
    const readFile = vi.fn((file: string) => readFileSync(file));
    const db = openForReading(path, { maxInMemoryBytes: 1024, readFile });
    try {
      expect(readFile).not.toHaveBeenCalled();
      expect(db.readonly).toBe(true);
      expect(db.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe("main", () => {
  let dir: string;
  let dbPath: string;
  const run = (argv: string[], env: NodeJS.ProcessEnv = { SQLITE_DB_PATH: dbPath }) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(argv, {
      env,
      settingsFile: {},
      now: NOW,
      out: (text) => out.push(text),
      err: (text) => err.push(text),
    });
    return { code, out: out.join("\n"), err: err.join("\n") };
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "report-"));
    dbPath = join(dir, "api.db");
    const db = new Database(dbPath);
    runMigrations(db);
    seed(db);
    db.close();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("prints the report of the database SQLITE_DB_PATH names, leaving it as it was", () => {
    const before = readFileSync(dbPath);
    const { code, out } = run(["--days", "3"]);
    expect(code).toBe(0);
    expect(out).toContain("Runs 2026-10-23 to 2026-10-25");
    expect(out).toMatch(/^total\s+10\s/m);
    expect(readFileSync(dbPath).equals(before)).toBe(true);
    expect(readdirSync(dir)).toEqual(["api.db"]);
  });

  it("creates no -wal or -shm next to a WAL database the API closed", () => {
    const db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.close();
    const before = readFileSync(dbPath);
    expect(readdirSync(dir)).toEqual(["api.db"]);

    expect(run(["--days", "3"]).code).toBe(0);

    expect(readdirSync(dir)).toEqual(["api.db"]);
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });

  it("prints JSON with --json, over the last 7 days by default", () => {
    const { code, out } = run(["--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as RunReport;
    expect(report).toMatchObject({ from: "2026-10-19", to: "2026-10-25", days: 7 });
    expect(report.total.runs).toBe(11);
    expect(out).not.toContain(TYPED);
  });

  it("marks the days past RUN_RETENTION_DAYS as pruned when the database records no cutoff", () => {
    const { code, out } = run(["--days", "7"], { SQLITE_DB_PATH: dbPath, RUN_RETENTION_DAYS: "5" });
    expect(code).toBe(0);
    expect(out).toMatch(/^2026-10-19\s+pruned$/m);
    expect(out).toMatch(/^2026-10-20\*\s/m);
    expect(out).toContain(
      "records no cutoff applied by retention (it has not been pruned since schema v12), so " +
        "days are marked from the current RUN_RETENTION_DAYS=5: records are complete from " +
        "2026-10-21.",
    );
  });

  it("marks the days pruned at 7 days as pruned after RUN_RETENTION_DAYS is raised to 30", () => {
    const db = new Database(dbPath);
    const sevenDays = { ...DEFAULT_RETENTION, runRetentionMs: 7 * DAY_MS };
    // Pruned at 2026-10-20 12:00: the run started 2026-10-12 is deleted.
    recordRuns(db, [{ id: "old", status: "completed", start: "2026-10-12T10:00:00Z", seconds: 5 }]);
    expect(pruneDatabase(db, sevenDays, NOW - 5 * DAY_MS).runs).toBe(1);
    db.close();

    const { code, out } = run(["--days", "21", "--json"], {
      SQLITE_DB_PATH: dbPath,
      RUN_RETENTION_DAYS: "30",
    });
    expect(code).toBe(0);
    const report = JSON.parse(out) as RunReport;
    expect(report).toMatchObject({
      retentionDays: 30,
      cutoffSource: "recorded",
      cutoff: "2026-10-13T12:00:00.000Z",
      keptFrom: "2026-10-14",
    });
    expect(report.perDay.find((row) => row.day === "2026-10-12")).toEqual({
      day: "2026-10-12",
      retention: "pruned",
    });
    expect(run(["--days", "21"], { SQLITE_DB_PATH: dbPath, RUN_RETENTION_DAYS: "30" }).out).toMatch(
      /^2026-10-12\s+pruned$/m,
    );
  });

  it("writes a warning about RUN_RETENTION_DAYS to stderr, keeping --json output JSON", () => {
    const { code, out, err } = run(["--json"], {
      SQLITE_DB_PATH: dbPath,
      RUN_RETENTION_DAYS: "abc",
    });
    expect(code).toBe(0);
    expect((JSON.parse(out) as RunReport).retentionDays).toBe(30);
    expect(err).toBe('report: Ignoring RUN_RETENTION_DAYS="abc": expected a positive number.');
  });

  it("prints its usage with --help", () => {
    const { code, out } = run(["--help"]);
    expect(code).toBe(0);
    expect(out).toContain("node dist/report.js [--days N] [--json]");
  });

  it("refuses a bad option and a missing database", () => {
    expect(run(["--days", "0"])).toMatchObject({ code: 2, err: expect.stringContaining("--days") });
    expect(run(["--days", "1.5"]).code).toBe(2);
    expect(run(["--weeks", "2"]).code).toBe(2);
    expect(run([], { SQLITE_DB_PATH: join(dir, "none.db") })).toMatchObject({
      code: 1,
      err: expect.stringContaining("no database"),
    });
  });
});
