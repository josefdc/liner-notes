import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MIGRATIONS, runMigrations } from "../store/migrations.js";
import { buildReport, formatReport, main, percentile, type RunReport } from "./report.js";

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
const sec = (iso: string) => Date.parse(iso) / 1000;
const TYPED = "a typed query nobody should see";

interface SeedRun {
  id: string;
  status: string;
  start: string;
  seconds?: number;
  paused?: number | null;
  payload?: unknown;
  analysis?: unknown;
}

function insertRuns(db: Database.Database, runs: SeedRun[], { pauses = true } = {}): void {
  const insert = db.prepare(
    `INSERT INTO runs (run_id, thread_id, query, status, created_at, finished_at, payload,
       analysis${pauses ? ", paused_seconds" : ""})
     VALUES (?, ?, ?, ?, ?, ?, ?, ?${pauses ? ", ?" : ""})`,
  );
  for (const run of runs) {
    const created = sec(run.start);
    insert.run(
      `run-id-${run.id}`,
      `run-id-${run.id}`,
      TYPED,
      run.status,
      created,
      run.seconds === undefined ? null : created + run.seconds,
      run.payload === undefined ? null : JSON.stringify(run.payload),
      run.analysis === undefined ? null : JSON.stringify(run.analysis),
      ...(pauses ? [run.paused === undefined ? 0 : run.paused] : []),
    );
  }
}

function insertUsage(
  db: Database.Database,
  rows: Array<{
    at: string;
    purpose?: string;
    status?: string;
    input: number | null;
    output: number | null;
    usd: number;
    estimated?: boolean;
  }>,
): void {
  const insert = db.prepare(
    `INSERT INTO llm_usage (id, run_id, call_site, tier, deployment, purpose, mode, status,
       input_tokens, output_tokens, usd_est, price_multiplier, estimated, latency_ms, created_at)
     VALUES (?, 'run', 'composer', 'main', 'deployment', ?, 'live', ?, ?, ?, ?, 1, ?, 100, ?)`,
  );
  rows.forEach((row, i) => {
    insert.run(
      `u${i}`,
      row.purpose ?? "dev",
      row.status ?? "ok",
      row.input,
      row.output,
      row.usd,
      row.estimated ? 1 : 0,
      sec(row.at),
    );
  });
}

const fallbackResult = (fallback: boolean | undefined) => ({
  id: "track",
  run: fallback === undefined ? { id: "x" } : { id: "x", fallback },
});

/** Three days of runs (Oct 23 to 25) and one older run and usage row the window leaves out. */
function seed(db: Database.Database): void {
  insertRuns(db, [
    { id: "before", status: "completed", start: "2026-10-22T23:59:59Z", seconds: 5 },
    // Oct 23: three completed live runs (one waited 10 minutes at the picker), a replay, a failure.
    {
      id: "a",
      status: "completed",
      start: "2026-10-23T10:00:00Z",
      seconds: 40,
      analysis: fallbackResult(false),
    },
    {
      id: "b",
      status: "completed",
      start: "2026-10-23T11:00:00Z",
      seconds: 700,
      paused: 600,
      analysis: fallbackResult(true),
    },
    { id: "c", status: "completed", start: "2026-10-23T12:00:00Z", seconds: 20 },
    {
      id: "d",
      status: "completed",
      start: "2026-10-23T13:00:00Z",
      seconds: 1,
      payload: { replayOf: { slug: "s", recordedAt: "2026-10-01T00:00:00Z", digest: "x" } },
    },
    { id: "e", status: "failed", start: "2026-10-23T14:00:00Z", seconds: 3 },
    // Oct 24: a cached result, a live run whose wait is unknown, an open and a cancelled run.
    {
      id: "f",
      status: "completed",
      start: "2026-10-24T09:00:00Z",
      seconds: 1,
      payload: { resultFrom: "another_run" },
    },
    {
      id: "g",
      status: "completed",
      start: "2026-10-24T10:00:00Z",
      seconds: 90,
      paused: null,
      analysis: fallbackResult(undefined),
    },
    { id: "h", status: "interrupted", start: "2026-10-24T11:00:00Z" },
    { id: "i", status: "cancelled", start: "2026-10-24T23:59:59Z", seconds: 2 },
  ]);
  insertUsage(db, [
    { at: "2026-10-22T12:00:00Z", input: 1, output: 1, usd: 9 },
    { at: "2026-10-23T10:00:10Z", input: 100, output: 50, usd: 0.01 },
    { at: "2026-10-23T11:00:10Z", input: 200, output: 100, usd: 0.02 },
    {
      at: "2026-10-23T11:00:20Z",
      status: "error:timeout",
      input: null,
      output: null,
      usd: 0.005,
      estimated: true,
    },
    { at: "2026-10-25T08:00:00Z", purpose: "eval", input: 1000, output: 10, usd: 0.5 },
  ]);
}

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
    const [oct23, oct24, oct25] = report.perDay;
    expect(oct23).toMatchObject({
      runs: 5,
      live: 4,
      replay: 1,
      cached: 0,
      completed: 4,
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
    expect(report.total).toMatchObject({ day: "total", runs: 9, live: 7, replay: 1, cached: 1 });
  });

  it("gives p50/p95 of completed live runs without the wait at the picker, leaving out unknown waits", () => {
    // a 40 s, b 700 s less 600 s waiting, c 20 s; the replay and the cached result do not count.
    expect(report.perDay[0].durations).toEqual({ runs: 3, unknown: 0, p50: 40, p95: 100 });
    expect(report.perDay[1].durations).toEqual({ runs: 0, unknown: 1, p50: null, p95: null });
    expect(report.perDay[2].durations).toEqual({ runs: 0, unknown: 0, p50: null, p95: null });
    expect(report.total.durations).toEqual({ runs: 3, unknown: 1, p50: 40, p95: 100 });
  });

  it("gives the fallback rate of completed live runs with a stored result", () => {
    expect(report.perDay[0].fallback).toEqual({ runs: 2, fallback: 1, rate: 0.5 });
    expect(report.perDay[1].fallback).toEqual({ runs: 1, fallback: 0, rate: 0 });
    expect(report.perDay[2].fallback).toEqual({ runs: 0, fallback: 0, rate: null });
    expect(report.total.fallback).toEqual({ runs: 3, fallback: 1, rate: 1 / 3 });
  });

  it("sums model calls, tokens and estimated USD per day and by purpose from the usage rows", () => {
    expect(report.perDay[0].model).toMatchObject({
      calls: 3,
      errors: 1,
      inputTokens: 300,
      outputTokens: 150,
      estimatedCalls: 1,
    });
    expect(report.perDay[0].model?.usd).toBeCloseTo(0.035, 10);
    expect(report.perDay[1].model).toEqual({
      calls: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      usd: 0,
      estimatedCalls: 0,
    });
    expect(report.perDay[2].model).toMatchObject({ calls: 1, inputTokens: 1000, usd: 0.5 });
    expect(report.total.model).toMatchObject({ calls: 4, errors: 1, estimatedCalls: 1 });
    expect(report.total.model?.usd).toBeCloseTo(0.535, 10);
    expect(Object.keys(report.modelByPurpose ?? {})).toEqual(["dev", "eval"]);
    expect(report.modelByPurpose?.dev.calls).toBe(3);
    expect(report.modelByPurpose?.eval.usd).toBe(0.5);
  });

  it("writes a table and notes, and never what was typed or a run id", () => {
    const text = formatReport(report);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Runs 2026-10-23 to 2026-10-25 (UTC, 3 days), by the day each started");
    expect(lines[2].split(/\s+/)).toEqual(
      expect.arrayContaining(["day", "runs", "live", "replay", "fallback", "USD"]),
    );
    expect(lines[3].split(/\s+/)).toEqual([
      "2026-10-23",
      "5",
      "4",
      "1",
      "0",
      "4",
      "1",
      "0",
      "0",
      "40",
      "100",
      "1/2",
      "50%",
      "3",
      "300",
      "150",
      "$0.0350",
    ]);
    expect(lines[6].split(/\s+/).slice(0, 2)).toEqual(["total", "9"]);
    expect(text).toContain("less the time spent waiting at the track picker");
    expect(text).toContain("1 left out: stored before waits were kept");
    expect(text).toContain("Model by purpose: dev 3 calls $0.0350, eval 1 calls $0.5000.");
    expect(text).not.toContain(TYPED);
    expect(text).not.toContain("run-id-");
    expect(JSON.stringify(report)).not.toMatch(new RegExp(`${TYPED}|run-id-`));
  });
});

describe("buildReport on a database migrated before waits were kept", () => {
  it("knows no duration and still counts runs, fallbacks and spend", () => {
    const db = new Database(":memory:");
    try {
      runMigrations(db, MIGRATIONS.slice(0, 10));
      insertRuns(
        db,
        [
          {
            id: "a",
            status: "completed",
            start: "2026-10-25T10:00:00Z",
            seconds: 40,
            analysis: fallbackResult(true),
          },
        ],
        { pauses: false },
      );
      const report = buildReport(db, { days: 1, now: NOW });
      expect(report).toMatchObject({ pausesKept: false, schemaVersion: 10 });
      expect(report.total).toMatchObject({
        runs: 1,
        durations: { runs: 0, unknown: 1, p50: null, p95: null },
        fallback: { runs: 1, fallback: 1, rate: 1 },
        model: { calls: 0 },
      });
      expect(formatReport(report)).toContain("before waits were kept (start the API once");
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

  it("prints the report of the database SQLITE_DB_PATH names, read-only", () => {
    const { code, out } = run(["--days", "3"]);
    expect(code).toBe(0);
    expect(out).toContain("Runs 2026-10-23 to 2026-10-25");
    expect(out).toMatch(/^total\s+9\s/m);

    const db = new Database(dbPath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(10);
    db.close();
  });

  it("prints JSON with --json, over the last 7 days by default", () => {
    const { code, out } = run(["--json"]);
    expect(code).toBe(0);
    const report = JSON.parse(out) as RunReport;
    expect(report).toMatchObject({ from: "2026-10-19", to: "2026-10-25", days: 7 });
    expect(report.total.runs).toBe(10);
    expect(out).not.toContain(TYPED);
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
