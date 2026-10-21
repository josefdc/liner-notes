/**
 * The budget guard: cap rules, refusal when the spend log cannot be used, and two processes
 * with different databases sharing one spend log.
 * Run: npm test -w apps/api -- llm/budget
 */

import {
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import type { BudgetSettings } from "../config/settings.js";
import {
  capViolation,
  type ReservationRequest,
  resolveSpendLogPath,
  SpendGuard,
} from "./budget.js";
import { acquireLock, withLock } from "./fileLock.js";
import { isLlmError } from "./errors.js";
import { createLlm } from "./invoke.js";
import {
  type AppendHandle,
  appendLine,
  parseSpendLog,
  readSpendLog,
  SpendLogError,
  type SpendTotals,
  summarise,
} from "./spendLog.js";
import { answer, testSettings } from "./testing/providerStub.js";
import { runWorker } from "./testing/runWorker.js";

const CAPS: BudgetSettings = {
  totalUsd: 25,
  dailyUsd: 13.5,
  evalFloorUsd: 20,
  evalSubCapsUsd: {
    "eval:golden": 13,
    "eval:baseline": 2.5,
    "eval:perturb": 1,
    "eval:variance": 3.5,
  },
};

const totals = (over: Partial<SpendTotals> = {}): SpendTotals => ({
  totalUsd: 0,
  todayUsd: 0,
  byUnitUsd: {},
  openReservations: 0,
  lines: 0,
  ...over,
});

const Schema = z.object({ ok: z.boolean() });
const OPTIONS = { purpose: "dev" as const, runId: "run-1", maxOutputTokens: 1000, schemaName: "T" };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-budget-"));
  // Any use of the global fetch is a real network request: fail it.
  vi.stubGlobal("fetch", () => {
    throw new Error("network denied");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("capViolation", () => {
  it("refuses any purpose past the total cap, reservation included", () => {
    expect(capViolation(totals({ totalUsd: 24.9 }), "eval:golden", 0.05, CAPS)).toBeNull();
    expect(capViolation(totals({ totalUsd: 24.9 }), "eval:golden", 0.2, CAPS)).toContain(
      "BUDGET_TOTAL_USD",
    );
  });

  it("refuses past the daily cap", () => {
    const today = totals({ totalUsd: 13.4, todayUsd: 13.4, byUnitUsd: { "eval:golden": 0 } });
    expect(capViolation(today, "eval", 0.2, CAPS)).toContain("BUDGET_DAILY_USD");
    expect(capViolation(totals({ totalUsd: 13.4 }), "eval", 0.2, CAPS)).toBeNull();
  });

  it("stops dev and showcase calls once total passes total − eval floor; evals go on", () => {
    const spent = totals({ totalUsd: 4.95 });
    expect(capViolation(spent, "dev", 0.04, CAPS)).toBeNull();
    expect(capViolation(spent, "dev", 0.06, CAPS)).toContain("BUDGET_EVAL_FLOOR_USD");
    expect(capViolation(spent, "showcase", 0.06, CAPS)).toContain("BUDGET_EVAL_FLOOR_USD");
    expect(capViolation(spent, "eval", 0.06, CAPS)).toBeNull();
    expect(capViolation(spent, "eval:golden", 0.06, CAPS)).toBeNull();
  });

  it("holds each eval sub-purpose to its own cap", () => {
    const spent = totals({ totalUsd: 6, byUnitUsd: { "eval:perturb": 0.95, "eval:golden": 5 } });
    expect(capViolation(spent, "eval:perturb", 0.04, CAPS)).toBeNull();
    expect(capViolation(spent, "eval:perturb", 0.06, CAPS)).toContain("BUDGET_EVAL_PERTURB_USD");
    // Another sub-purpose's spending does not count against this one's cap.
    expect(capViolation(spent, "eval:baseline", 2.4, CAPS)).toBeNull();
    expect(capViolation(spent, "eval:baseline", 2.6, CAPS)).toContain("BUDGET_EVAL_BASELINE_USD");
    expect(capViolation(spent, "eval:variance", 3.6, CAPS)).toContain("BUDGET_EVAL_VARIANCE_USD");
    expect(capViolation(spent, "eval:golden", 8.1, CAPS)).toContain("BUDGET_EVAL_GOLDEN_USD");
  });
});

describe("refusals before any request", () => {
  async function refusal(env: Record<string, string>, prepare?: () => void) {
    prepare?.();
    const net = answer({ ok: true });
    const llm = createLlm({ settings: testSettings(env), fetch: net.fetch, recordUsage: () => {} });
    const error = await llm.invoke("test", "fast", "hi", Schema, OPTIONS).catch((e) => e);
    expect(net.calls).toHaveLength(0);
    return error;
  }

  it("refuses a live call when LLM_SPEND_LOG is not set", async () => {
    const error = await refusal({});
    expect(isLlmError(error, "spend_log_unavailable")).toBe(true);
    expect(error.message).toContain("LLM_SPEND_LOG is not set");
  });

  it("refuses when the spend log's directory does not exist", async () => {
    const error = await refusal({ LLM_SPEND_LOG: join(dir, "missing", "spend.jsonl") });
    expect(isLlmError(error, "spend_log_unavailable")).toBe(true);
  });

  it("refuses when the spend log cannot be read", async () => {
    const log = join(dir, "spend.jsonl");
    const error = await refusal({ LLM_SPEND_LOG: log }, () => {
      writeFileSync(log, "");
      chmodSync(log, 0o200);
    });
    expect(isLlmError(error, "spend_log_unavailable")).toBe(true);
    expect(error.message).toContain("cannot be read");
  });

  it("refuses when the spend log cannot be written", async () => {
    const log = join(dir, "spend.jsonl");
    const error = await refusal({ LLM_SPEND_LOG: log }, () => {
      writeFileSync(log, "");
      chmodSync(log, 0o400);
    });
    expect(isLlmError(error, "spend_log_unavailable")).toBe(true);
    expect(error.message).toContain("cannot be written");
  });

  it("refuses when a line of the spend log is malformed", async () => {
    const log = join(dir, "spend.jsonl");
    const error = await refusal({ LLM_SPEND_LOG: log }, () => {
      writeFileSync(log, '{"ts":"2026-10-21T00:00:00Z","usd_est":0.1}\n{"ts":"2026-10-2\n');
    });
    expect(isLlmError(error, "spend_log_unavailable")).toBe(true);
    expect(error.message).toContain("line 2");
  });

  it("refuses when the spend already recorded leaves no room", async () => {
    const log = join(dir, "spend.jsonl");
    const error = await refusal(
      { LLM_SPEND_LOG: log, BUDGET_TOTAL_USD: "1", BUDGET_EVAL_FLOOR_USD: "0" },
      () => {
        writeFileSync(
          log,
          '{"ts":"2026-10-21T00:00:00Z","deployment":"gpt-6-sol","in":0,"out":0,"usd_est":1,"unit":"dev"}\n',
        );
      },
    );
    expect(isLlmError(error, "budget_exceeded")).toBe(true);
  });
});

describe("SpendGuard", () => {
  it("writes a reserve line and a settle line, base fields first", async () => {
    const log = join(dir, "spend.jsonl");
    writeFileSync(log, "");
    const guard = new SpendGuard({ logPath: log, caps: CAPS });
    const reservation = await guard.reserve({
      purpose: "eval:golden",
      tier: "main",
      deployment: "gpt-6-luna",
      callSite: "composer",
      runId: "run-9",
      inputTokensEstimate: 500,
      maxOutputTokens: 2000,
      usdEst: 0.5,
      multiplier: 1,
    });
    await guard.settle(reservation, {
      inputTokens: 300,
      outputTokens: 900,
      reasoningTokens: 400,
      usdEst: 0.2,
      latencyMs: 1234,
      status: "ok",
      estimated: false,
    });
    const [reserve, settle] = parseSpendLog(readFileSync(log, "utf8"));
    for (const line of [reserve, settle]) {
      expect(Object.keys(line).slice(0, 6)).toEqual([
        "ts",
        "deployment",
        "in",
        "out",
        "usd_est",
        "unit",
      ]);
    }
    expect(reserve).toMatchObject({
      kind: "reserve",
      deployment: "gpt-6-luna",
      in: 500,
      out: 2000,
      usd_est: 0.5,
      unit: "eval:golden",
      tier: "main",
      callSite: "composer",
      runId: "run-9",
      multiplier: 1,
    });
    expect(settle).toMatchObject({
      kind: "settle",
      id: reserve.id,
      in: 300,
      out: 900,
      reasoning: 400,
      usd_est: 0.2,
      latency_ms: 1234,
      status: "ok",
      estimated: false,
    });
  });

  it("starts a new line after a hand-edited log that lacks a final newline", async () => {
    const log = join(dir, "spend.jsonl");
    writeFileSync(log, '{"ts":"2026-10-21T00:00:00Z","usd_est":0.25,"unit":"dev"}');
    const guard = new SpendGuard({ logPath: log, caps: CAPS });
    await guard.reserve({
      purpose: "dev",
      tier: "fast",
      deployment: "gpt-5.6-terra",
      callSite: "t",
      runId: "r",
      inputTokensEstimate: 1,
      maxOutputTokens: 16,
      usdEst: 0.01,
      multiplier: 1,
    });
    expect(parseSpendLog(readFileSync(log, "utf8"))).toHaveLength(2);
    expect((await guard.preflight()).totalUsd).toBeCloseTo(0.26, 6);
  });
});

describe("two processes, two databases, one spend log", () => {
  // research tier = gpt-6-sol at USD 2.20 / 11.00 per 1M: each call settles at
  // (1,000 × 2.2 + 50,000 × 11) / 1e6 = USD 0.5522 and reserves about USD 0.66 first
  // (60,000 output tokens at most).
  const callEnv = (log: string, db: string, calls: number) => ({
    LLM_SPEND_LOG: log,
    SQLITE_DB_PATH: db,
    BUDGET_TOTAL_USD: "2",
    BUDGET_EVAL_FLOOR_USD: "0",
    BUDGET_DAILY_USD: "100",
    WORKER_CALLS: String(calls),
    WORKER_MAX_OUTPUT: "60000",
    STUB_INPUT: "1000",
    STUB_OUTPUT: "50000",
  });

  const usageRows = (dbPath: string) => {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.prepare("SELECT status, usd_est FROM llm_usage").all();
    db.close();
    return rows;
  };

  it("refuses the second process once the shared total passes the cap", async () => {
    const log = join(dir, "spend.jsonl");
    writeFileSync(log, "");
    const first = await runWorker(callEnv(log, join(dir, "a.db"), 2));
    expect(first.code, first.stderr).toBe(0);
    expect(first.results.map((r) => r.ok)).toEqual([true, true]);

    const second = await runWorker(callEnv(log, join(dir, "b.db"), 3));
    expect(second.code, second.stderr).toBe(0);
    expect(second.results.map((r) => r.ok)).toEqual([true, false, false]);
    expect(second.results[1].kind).toBe("budget_exceeded");
    expect(second.results[1].message).toContain("BUDGET_TOTAL_USD");

    // Each database holds only its own process's calls; the log holds all of them.
    expect(usageRows(join(dir, "a.db"))).toHaveLength(2);
    expect(usageRows(join(dir, "b.db"))).toEqual([{ status: "ok", usd_est: 0.5522 }]);
    const lines = parseSpendLog(readFileSync(log, "utf8"));
    const settled = lines.filter((l) => l.kind === "settle");
    expect(settled).toHaveLength(3);
    expect(settled.reduce((sum, l) => sum + l.usd_est, 0)).toBeCloseTo(3 * 0.5522, 6);
    expect(new Set(lines.map((l) => l.pid)).size).toBe(2);
  }, 60_000);

  it("lets the same process make all its calls against a spend log of its own", async () => {
    writeFileSync(join(dir, "own.jsonl"), "");
    const alone = await runWorker(callEnv(join(dir, "own.jsonl"), join(dir, "c.db"), 3));
    expect(alone.code, alone.stderr).toBe(0);
    expect(alone.results.map((r) => r.ok)).toEqual([true, true, true]);
  }, 60_000);
});

const request = (usdEst: number): ReservationRequest => ({
  purpose: "dev",
  tier: "fast",
  deployment: "gpt-6-luna",
  callSite: "test",
  runId: "r",
  inputTokensEstimate: 10,
  maxOutputTokens: 16,
  usdEst,
  multiplier: 1,
});
const SMALL_CAPS: BudgetSettings = { ...CAPS, totalUsd: 1, dailyUsd: 1, evalFloorUsd: 0 };
const settled = (usdEst: number) => ({
  inputTokens: 1,
  outputTokens: 1,
  reasoningTokens: null,
  usdEst,
  latencyMs: 1,
  status: "ok",
  estimated: false,
});

describe("one log reached through a symlink", () => {
  it("shares the log's lock: a guard on the alias waits while the real path is locked", async () => {
    const real = join(dir, "spend.jsonl");
    writeFileSync(real, "");
    symlinkSync(real, join(dir, "alias.jsonl"));
    expect(await resolveSpendLogPath(join(dir, "alias.jsonl"))).toBe(
      await resolveSpendLogPath(real),
    );
    const viaAlias = new SpendGuard({
      logPath: join(dir, "alias.jsonl"),
      caps: SMALL_CAPS,
      lockWaitMs: 300,
    });
    let outcome = "";
    await withLock(await resolveSpendLogPath(real), async () => {
      outcome = await viaAlias.reserve(request(0.6)).then(
        () => "admitted",
        (e) => e.kind,
      );
    });
    expect(outcome).toBe("spend_log_unavailable");
    // Once free, the alias and the real path see the same totals.
    await viaAlias.reserve(request(0.6));
    const direct = new SpendGuard({ logPath: real, caps: SMALL_CAPS });
    const refused = await direct.reserve(request(0.6)).catch((e) => e);
    expect(isLlmError(refused, "budget_exceeded")).toBe(true);
  });

  it("admits at most one of two processes, one writing through the alias", async () => {
    const real = join(dir, "spend.jsonl");
    writeFileSync(real, "");
    symlinkSync(real, join(dir, "alias.jsonl"));
    const startAt = String(Date.now() + 2500);
    const runs = await Promise.all(
      [real, join(dir, "alias.jsonl")].map((path, i) =>
        runWorker({
          LLM_SPEND_LOG: path,
          BUDGET_TOTAL_USD: "0.02",
          BUDGET_EVAL_FLOOR_USD: "0",
          WORKER_MAX_OUTPUT: "1000",
          WORKER_START_AT: startAt,
          STUB_DELAY_MS: "300",
          SQLITE_DB_PATH: join(dir, `p${i}.db`),
        }),
      ),
    );
    const results = runs.flatMap((r) => r.results);
    expect(results, runs.map((r) => r.stderr).join("\n")).toHaveLength(2);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(existsSync(join(dir, "alias.jsonl.lock"))).toBe(false);
  }, 60_000);
});

describe("a spend log that does not exist", () => {
  it("is refused, not counted as USD 0, unless creation is asked for", async () => {
    writeFileSync(
      join(dir, "spend.jsonl"),
      `${JSON.stringify({ ts: new Date().toISOString(), deployment: "d", in: 1, out: 1, usd_est: 0.99, unit: "dev" })}\n`,
    );
    const typo = new SpendGuard({ logPath: join(dir, "spend.jsonl.bak"), caps: SMALL_CAPS });
    const error = await typo.reserve(request(0.9)).catch((e) => e);
    expect(isLlmError(error, "spend_log_unavailable")).toBe(true);
    expect(error.message).toContain("does not exist");
    expect(existsSync(join(dir, "spend.jsonl.bak"))).toBe(false);
    const preflight = await typo.preflight().catch((e) => e);
    expect(isLlmError(preflight, "spend_log_unavailable")).toBe(true);
    expect(existsSync(join(dir, "spend.jsonl.bak"))).toBe(false);

    const created = new SpendGuard({ logPath: join(dir, "new.jsonl"), caps: SMALL_CAPS });
    expect(await created.init()).toBe(true);
    expect(await created.init()).toBe(false);
    await created.reserve(request(0.1));
    expect(parseSpendLog(readFileSync(join(dir, "new.jsonl"), "utf8"))).toHaveLength(1);
  });
});

describe("the daily cap across midnight (UTC)", () => {
  it("counts a call on the day it was reserved, even when it settles the next day", async () => {
    let now = new Date("2026-10-21T23:59:59.000Z");
    writeFileSync(join(dir, "spend.jsonl"), "");
    const guard = new SpendGuard({
      logPath: join(dir, "spend.jsonl"),
      caps: { ...SMALL_CAPS, totalUsd: 100, dailyUsd: 1 },
      now: () => now,
    });
    const first = await guard.reserve(request(0.9));
    now = new Date("2026-10-22T00:00:30.000Z");
    await guard.reserve(request(0.95));
    await guard.settle(first, settled(0.9));
    const lines = parseSpendLog(readFileSync(join(dir, "spend.jsonl"), "utf8"));
    expect(lines.find((l) => l.kind === "settle")?.reserve_ts).toBe("2026-10-21T23:59:59.000Z");
    expect(summarise(lines, now).todayUsd).toBeCloseTo(0.95, 9);
    expect(summarise(lines, new Date("2026-10-21T12:00:00Z")).todayUsd).toBeCloseTo(0.9, 9);
  });
});

describe("a malformed or torn last line", () => {
  const valid = `${JSON.stringify({ ts: new Date().toISOString(), deployment: "x", in: 0, out: 0, usd_est: 0.4, unit: "dev" })}\n`;
  const HAND_CAPS: BudgetSettings = { ...CAPS, totalUsd: 3.5, dailyUsd: 100, evalFloorUsd: 0 };

  it.each([
    [
      "missing closing brace",
      '{"ts":"2026-10-21T00:00:00Z","deployment":"azure-portal","in":0,"out":0,"usd_est":3,"unit":"dev"',
    ],
    [
      "amount as a string",
      '{"ts":"2026-10-21T00:00:00Z","deployment":"azure-portal","in":0,"out":0,"usd_est":"3","unit":"dev"}',
    ],
    [
      "NaN from a script",
      '{"ts":"2026-10-21T00:00:00Z","deployment":"azure-portal","in":0,"out":0,"usd_est":NaN,"unit":"dev"}',
    ],
  ])("refuses (%s) with or without a newline, and never cuts it", async (_name, hand) => {
    const log = join(dir, "spend.jsonl");
    for (const text of [valid + hand, `${valid + hand}\n`]) {
      writeFileSync(log, text);
      const guard = new SpendGuard({ logPath: log, caps: HAND_CAPS });
      const error = await guard.reserve(request(0.5)).catch((e) => e);
      expect(isLlmError(error, "spend_log_unavailable")).toBe(true);
      expect(error.message).toContain("line 2");
      expect(error.message).toContain("--repair-tail");
      expect(readFileSync(log, "utf8")).toBe(text);
      expect(existsSync(`${log}.torn`)).toBe(false);
    }
  });

  it("moves only a last line that is not a record, by hand (repairTail), reporting its bytes", async () => {
    const log = join(dir, "spend.jsonl");
    const torn = '{"ts":"2026-10-21T00:00:00Z","deployment":"x","in":1,"ou';
    writeFileSync(log, valid + torn);
    const guard = new SpendGuard({ logPath: log, caps: CAPS });
    expect(await guard.repairTail()).toEqual({ moved: true, bytes: Buffer.byteLength(torn) });
    expect(readFileSync(log, "utf8")).toBe(valid);
    expect(readFileSync(`${log}.torn`, "utf8")).toContain(torn);
    await guard.reserve(request(0.1));
    // A valid last line, or an empty log, is left alone.
    expect(await guard.repairTail()).toEqual({ moved: false, bytes: 0 });
  });

  it("leaves a malformed line before a valid last line for a human", async () => {
    const log = join(dir, "spend.jsonl");
    const text = `{"ts":"2026-10-2\n${valid}`;
    writeFileSync(log, text);
    const guard = new SpendGuard({ logPath: log, caps: CAPS });
    expect(await guard.repairTail()).toEqual({ moved: false, bytes: 0 });
    expect(readFileSync(log, "utf8")).toBe(text);
    const error = await guard.reserve(request(0.01)).catch((e) => e);
    expect(error.message).toContain("line 1");
    expect(error.message).toContain("by hand");
  });

  it("keeps a valid last line without a newline (written by hand) and starts a new line", async () => {
    const log = join(dir, "spend.jsonl");
    writeFileSync(log, '{"ts":"2026-10-21T00:00:00Z","usd_est":0.25,"unit":"dev"}');
    expect((await readSpendLog(log)).unterminated).toBe(true);
    await new SpendGuard({ logPath: log, caps: CAPS }).reserve(request(0.01));
    expect(parseSpendLog(readFileSync(log, "utf8"))).toHaveLength(2);
  });
});

describe("a write cut short", () => {
  /** A file handle whose first write lands only half of the line, as on a full disk. */
  const halfWrite =
    (onTruncate: "works" | "fails" = "works") =>
    async (path: string): Promise<AppendHandle> => {
      const real = await open(path, constants.O_WRONLY | constants.O_APPEND);
      return {
        stat: () => real.stat(),
        write: (buffer, offset, length) => real.write(buffer, offset, Math.floor(length / 2)),
        sync: () => real.sync(),
        truncate: (length) =>
          onTruncate === "works" ? real.truncate(length) : Promise.reject(new Error("EIO")),
        close: () => real.close(),
      };
    };

  it("is undone: the log is as before and later calls go on", async () => {
    const log = join(dir, "spend.jsonl");
    writeFileSync(log, valid());
    const before = readFileSync(log, "utf8");
    const error = await appendLine(log, line(0.1), false, halfWrite()).catch((e) => e);
    expect(error).toBeInstanceOf(SpendLogError);
    expect(error.message).toContain("partial line was removed");
    expect(readFileSync(log, "utf8")).toBe(before);
    await new SpendGuard({ logPath: log, caps: CAPS }).reserve(request(0.1));
    expect(parseSpendLog(readFileSync(log, "utf8"))).toHaveLength(2);
  });

  it("says so when it cannot be undone", async () => {
    const log = join(dir, "spend.jsonl");
    writeFileSync(log, valid());
    const error = await appendLine(log, line(0.1), false, halfWrite("fails")).catch((e) => e);
    expect(error.message).toContain("may end with a partial line");
    expect(error.written).toBe(true);
  });

  function valid(): string {
    return `${JSON.stringify({ ts: new Date().toISOString(), deployment: "x", in: 0, out: 0, usd_est: 0.4, unit: "dev" })}\n`;
  }
  function line(usd: number) {
    return {
      ts: new Date().toISOString(),
      deployment: "x",
      in: 0,
      out: 0,
      usd_est: usd,
      unit: "dev",
    };
  }
});

describe("a settle that cannot get the lock at once", () => {
  it("is tried again", async () => {
    const log = join(dir, "spend.jsonl");
    writeFileSync(log, "");
    const guard = new SpendGuard({
      logPath: log,
      caps: CAPS,
      lockWaitMs: 50,
      settleRetryMs: 150,
    });
    const reservation = await guard.reserve(request(0.1));
    const release = await acquireLock(await resolveSpendLogPath(log));
    setTimeout(() => void release(), 100);
    await guard.settle(reservation, settled(0.02));
    expect(summarise(parseSpendLog(readFileSync(log, "utf8"))).openReservations).toBe(0);
  });
});
