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
    purpose?: string;
    mode?: "live" | "replay";
    status?: string;
    input: number | null;
    output: number | null;
    usd: number;
    estimated?: boolean;
  }>,
): void {
  rows.forEach((row, i) => {
    const id = `usage-${db.prepare("SELECT COUNT(*) FROM llm_usage").pluck().get()}-${i}`;
    recordLlmUsage(db, {
      id,
      runId: "run-id-a",
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

  it("sums model calls sent, tokens of the unestimated ones and estimated USD, apart from replayed calls", () => {
    const [oct23, oct24, oct25] = report.perDay.map(kept);
    expect(oct23.model).toMatchObject({
      calls: 4,
      errors: 1,
      inputTokens: 300,
      outputTokens: 150,
      estimatedCalls: 2,
      replayedCalls: 1,
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
    });
    expect(oct25.model).toMatchObject({ calls: 1, inputTokens: 1000, usdEstimate: 0.5 });
    expect(report.total.model).toMatchObject({
      calls: 5,
      errors: 1,
      inputTokens: 1300,
      outputTokens: 160,
      estimatedCalls: 2,
      replayedCalls: 1,
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
    expect(text).toContain("Model by purpose: dev 4 calls $0.0390, eval 1 calls $0.5000.");
    expect(text).not.toContain("Retention:");
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
      expect(report).toMatchObject({ retentionDays: 30, keptFrom: "2026-09-26" });
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
        "Retention: runs and usage rows are deleted after RUN_RETENTION_DAYS=30; records are " +
          "complete from 2026-09-26. 9 pruned days are not counted, in the total either. * " +
          "partly pruned.",
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

  it("marks the days past RUN_RETENTION_DAYS as pruned", () => {
    const { code, out } = run(["--days", "7"], { SQLITE_DB_PATH: dbPath, RUN_RETENTION_DAYS: "5" });
    expect(code).toBe(0);
    expect(out).toMatch(/^2026-10-19\s+pruned$/m);
    expect(out).toMatch(/^2026-10-20\*\s/m);
    expect(out).toContain("RUN_RETENTION_DAYS=5; records are complete from 2026-10-21.");
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
