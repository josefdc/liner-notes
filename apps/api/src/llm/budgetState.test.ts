/**
 * The read-only budget state REPLAY_MODE=fallback decides on: the guard's cap rules applied to a
 * run of the design-target size, read from a scratch spend log that is never written to.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BudgetSettings } from "../config/settings.js";
import {
  BUDGET_STATE_TTL_MS,
  budgetStateOf,
  LIVE_RUN_RESERVE_USD,
  liveBudgetState,
  readBudgetState,
  resetBudgetStateForTests,
} from "./budgetState.js";
import type { SpendTotals } from "./spendLog.js";
import { testSettings } from "./testing/providerStub.js";

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

const line = (usd: number, ts = new Date().toISOString()) =>
  `${JSON.stringify({ ts, deployment: "gpt", in: 0, out: 0, usd_est: usd, unit: "dev" })}\n`;

let dir: string;
let log: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "budget-state-"));
  log = join(dir, "spend.jsonl");
  resetBudgetStateForTests();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  resetBudgetStateForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("budgetStateOf", () => {
  it("is exhausted once a run of the design-target size would pass any cap", () => {
    expect(LIVE_RUN_RESERVE_USD).toBeCloseTo(0.54, 10);
    expect(budgetStateOf(totals(), "dev", CAPS).state).toBe("available");
    // Total: 24.5 + 0.54 > 25.
    expect(budgetStateOf(totals({ totalUsd: 24.5 }), "eval", CAPS)).toMatchObject({
      state: "exhausted",
      reason: expect.stringMatching(/BUDGET_TOTAL_USD/),
    });
    // Today: 13 + 0.54 > 13.5.
    expect(budgetStateOf(totals({ totalUsd: 13, todayUsd: 13 }), "eval", CAPS)).toMatchObject({
      state: "exhausted",
      reason: expect.stringMatching(/BUDGET_DAILY_USD/),
    });
    // The evaluation floor: dev runs stop at 25 − 20 = 5, evaluations do not.
    expect(budgetStateOf(totals({ totalUsd: 4.6 }), "dev", CAPS)).toMatchObject({
      state: "exhausted",
      reason: expect.stringMatching(/BUDGET_EVAL_FLOOR_USD/),
    });
    expect(budgetStateOf(totals({ totalUsd: 4.6 }), "eval", CAPS).state).toBe("available");
    expect(budgetStateOf(totals({ totalUsd: 4.4 }), "dev", CAPS).state).toBe("available");
  });
});

describe("readBudgetState", () => {
  it("reads the spend log without writing to it", async () => {
    const text = line(1) + line(2);
    writeFileSync(log, text);
    const state = await readBudgetState(testSettings({ LLM_SPEND_LOG: log }), "dev");
    expect(state).toMatchObject({ state: "available", totals: { totalUsd: 3 } });
    expect(readFileSync(log, "utf8")).toBe(text);

    writeFileSync(log, line(30));
    expect(await readBudgetState(testSettings({ LLM_SPEND_LOG: log }), "dev")).toMatchObject({
      state: "exhausted",
    });
  });

  it("counts a spend log that cannot be used as exhausted, and nothing without a paid provider", async () => {
    const missing = await readBudgetState(testSettings({ LLM_SPEND_LOG: log }), "dev");
    expect(missing).toMatchObject({
      state: "exhausted",
      reason: expect.stringMatching(/spend log cannot be used/),
    });
    writeFileSync(log, "not json\n");
    expect((await readBudgetState(testSettings({ LLM_SPEND_LOG: log }), "dev")).state).toBe(
      "exhausted",
    );
    expect((await readBudgetState(testSettings(), "dev")).state).toBe("exhausted");

    writeFileSync(log, line(30));
    const cassettes = testSettings({ LLM_SPEND_LOG: log, LLM_CASSETTE: "replay" });
    expect(await readBudgetState(cassettes, "dev")).toEqual({ state: "not_live" });
    const keyless = testSettings({ LLM_SPEND_LOG: log, AZURE_OPENAI_API_KEY: "" });
    expect(await readBudgetState(keyless, "dev")).toEqual({ state: "not_live" });
  });
});

describe("liveBudgetState", () => {
  const env = () => ({
    AZURE_OPENAI_API_KEY: "dummy-key",
    AZURE_OPENAI_ENDPOINT: "https://example.openai.azure.com/",
    LLM_CASSETTE: "off",
    LLM_SPEND_LOG: log,
  });

  it("reuses a state for a few seconds, and reads again when the settings change", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    writeFileSync(log, line(1));
    expect((await liveBudgetState(env())).state).toBe("available");
    writeFileSync(log, line(30));
    expect((await liveBudgetState(env())).state).toBe("available");
    // Other caps are other settings: read again.
    expect((await liveBudgetState({ ...env(), BUDGET_TOTAL_USD: "40" })).state).toBe("exhausted");
    vi.setSystemTime(Date.now() + BUDGET_STATE_TTL_MS + 1);
    expect((await liveBudgetState(env())).state).toBe("exhausted");
  });

  it("stops nothing when the model settings are invalid (every call is refused anyway)", async () => {
    writeFileSync(log, line(30));
    expect(await liveBudgetState({ ...env(), LLM_SPEND_LOG: "relative/path" })).toEqual({
      state: "not_live",
    });
  });
});
