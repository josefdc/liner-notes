/**
 * Whether live model calls can still be made, read from the spend log by the budget guard
 * (budget.ts) without reserving anything. REPLAY_MODE=fallback asks this before it starts live
 * work (replay/mode.ts): once the budget is spent, recorded runs are served instead.
 *
 *   available  a live analysis of the design-target size still fits under every cap
 *   exhausted  it would pass a cap (the total, today's, or the floor kept for evaluations), or
 *              the spend log cannot be read, so the guard would refuse every model call anyway
 *   not_live   no paid provider is configured (no key or endpoint, cassettes, or invalid model
 *              settings): nothing can be spent, so the budget does not stop anything
 *
 * The answer is kept for BUDGET_STATE_TTL_MS: the spend log is read under its lock, and a page
 * of suggestions should not take that lock once per keystroke.
 */

import {
  type BudgetSettings,
  isLiveProvider,
  type LlmPurpose,
  type LlmSettings,
  readLlmSettings,
} from "../config/settings.js";
import { capViolation, SpendGuard } from "./budget.js";
import { isLlmError } from "./errors.js";
import { FALLBACK_PRICE } from "./prices.js";
import type { SpendTotals } from "./spendLog.js";

/**
 * The worst case of one live analysis at the fallback prices: 30k input and 6k output tokens,
 * reasoning included (the size MAX_LLM_CALLS_PER_RUN and the calls' max_output_tokens are set
 * for). Live analysis pauses once a run of this size would pass a cap, rather than start runs
 * whose model calls the guard then refuses.
 */
export const LIVE_RUN_RESERVE_USD =
  (30_000 * FALLBACK_PRICE.inputPer1M + 6_000 * FALLBACK_PRICE.outputPer1M) / 1_000_000;

/** How long a budget state is reused before the spend log is read again. */
export const BUDGET_STATE_TTL_MS = 5_000;

/** Longest wait for the spend log's lock; past it the budget counts as unreadable. */
const LOCK_WAIT_MS = 2_000;

export type BudgetState =
  | { state: "available"; totals: SpendTotals }
  | { state: "exhausted"; reason: string }
  | { state: "not_live" };

/** The state of the budget for a run of `reserveUsd` with these totals. Pure. */
export function budgetStateOf(
  totals: SpendTotals,
  purpose: LlmPurpose,
  caps: BudgetSettings,
  reserveUsd = LIVE_RUN_RESERVE_USD,
): BudgetState {
  const violation = capViolation(totals, purpose, reserveUsd, caps);
  return violation ? { state: "exhausted", reason: violation } : { state: "available", totals };
}

/** Reads the spend log once (read-only: nothing is reserved or written). */
export async function readBudgetState(
  settings: LlmSettings,
  purpose: LlmPurpose,
  now: () => Date = () => new Date(),
): Promise<BudgetState> {
  if (!isLiveProvider(settings)) return { state: "not_live" };
  const guard = new SpendGuard({
    logPath: settings.spendLog,
    caps: settings.budget,
    now,
    lockWaitMs: LOCK_WAIT_MS,
  });
  try {
    return budgetStateOf(await guard.preflight(), purpose, settings.budget);
  } catch (error) {
    const reason = isLlmError(error) ? error.message : String(error);
    return { state: "exhausted", reason: `the spend log cannot be used: ${reason}` };
  }
}

let cached: { key: string; at: number; state: Promise<BudgetState> } | null = null;

/**
 * The budget state for live analyses (purpose `purpose`) under the model settings in `env`,
 * reused for BUDGET_STATE_TTL_MS while those settings stay the same.
 */
export function liveBudgetState(
  env: NodeJS.ProcessEnv = process.env,
  purpose: LlmPurpose = "dev",
): Promise<BudgetState> {
  const { settings, errors } = readLlmSettings(env);
  // Invalid model settings refuse every call (not_configured): nothing can be spent.
  if (errors.length > 0) return Promise.resolve({ state: "not_live" });
  const key = JSON.stringify([
    isLiveProvider(settings),
    settings.spendLog,
    settings.budget,
    purpose,
  ]);
  const now = Date.now();
  if (cached && cached.key === key && now - cached.at < BUDGET_STATE_TTL_MS) return cached.state;
  const state = readBudgetState(settings, purpose).then((read) => {
    // Once per read of the log, not once per request.
    if (read.state === "exhausted") console.warn(`[Budget] Live analysis paused: ${read.reason}`);
    return read;
  });
  cached = { key, at: now, state };
  return state;
}

/** For tests: forgets the cached state, so the next request reads the spend log again. */
export function resetBudgetStateForTests(): void {
  cached = null;
}
