/**
 * Whether live model calls can still be made, read from the spend log by the budget guard
 * (budget.ts) without reserving anything. REPLAY_MODE=fallback asks this before it starts live
 * work (replay/mode.ts): once the budget is spent, recorded runs are served instead.
 *
 *   available     a live analysis of the design-target size still fits under every cap
 *   exhausted     it would pass a cap: the total, today's, or the floor kept for evaluations
 *   unverifiable  the spend log cannot be used (unset, missing, unreadable, malformed, or its
 *                 lock is busy): nothing can be said about the budget, and the guard would
 *                 refuse every model call anyway
 *   not_live      no paid provider is configured (no key or endpoint, cassettes, or invalid
 *                 model settings): nothing can be spent, so the budget does not stop anything
 *
 * This is a check before a run starts, not a reservation: requests that start together all see
 * the same headroom, and a run can still need more than the design target. The guard stays the
 * hard stop, call by call; this check only keeps most runs that it would refuse from starting.
 *
 * An answer about the budget is kept for BUDGET_STATE_TTL_MS: the spend log is read under its
 * lock, and a page of suggestions should not take that lock once per keystroke. An unverifiable
 * answer is not kept, so a lock that was busy for a moment does not pause anything afterwards.
 * The TTLs are measured on the monotonic clock (`pacingClock`), so a step of the wall clock
 * neither keeps an answer longer nor drops it sooner.
 */

import {
  type BudgetSettings,
  isLiveProvider,
  type LlmPurpose,
  type LlmSettings,
  readLlmSettings,
} from "../config/settings.js";
import { pacingClock } from "../sources/pacing.js";
import { capViolation, SpendGuard } from "./budget.js";
import { isLlmError } from "./errors.js";
import { FALLBACK_PRICE } from "./prices.js";
import type { SpendTotals } from "./spendLog.js";
import { logger } from "../logger.js";

const log = logger("Budget");

/**
 * The design target of one live analysis at the fallback prices: 30k input and 6k output
 * tokens, reasoning included. Live analysis pauses once a run of this size would pass a cap.
 */
export const LIVE_RUN_RESERVE_USD =
  (30_000 * FALLBACK_PRICE.inputPer1M + 6_000 * FALLBACK_PRICE.outputPer1M) / 1_000_000;

/** How long a budget state is reused before the spend log is read again. */
export const BUDGET_STATE_TTL_MS = 5_000;

/** Longest wait for the spend log's lock; past it the budget cannot be checked. */
const LOCK_WAIT_MS = 2_000;

export type BudgetState =
  | { state: "available"; totals: SpendTotals }
  | { state: "exhausted"; reason: string }
  | { state: "unverifiable"; reason: string }
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
    return { state: "unverifiable", reason: `the spend log cannot be used: ${reason}` };
  }
}

interface CachedState {
  key: string;
  /** When the read started, on `pacingClock`. */
  at: number;
  state: Promise<BudgetState>;
  /** A spent budget of this read has been logged. */
  warned: boolean;
}

let cached: CachedState | null = null;
/** When an unusable log was last warned about, on `pacingClock`. */
let lastUnverifiableWarning = Number.NEGATIVE_INFINITY;

/** Logs what a read found: a spent budget once per read, an unusable log at most once per TTL. */
function warnAbout(entry: CachedState, read: BudgetState): void {
  if (read.state === "exhausted" && !entry.warned) {
    entry.warned = true;
    log.warn(`Live analysis paused: ${read.reason}`);
  }
  if (read.state === "unverifiable") {
    const at = pacingClock();
    if (at - lastUnverifiableWarning >= BUDGET_STATE_TTL_MS) {
      lastUnverifiableWarning = at;
      log.warn(`Live analysis off (the budget cannot be checked): ${read.reason}`);
    }
  }
}

/**
 * The budget state for live work of purpose `purpose` under the model settings in `env`. An
 * answer about the budget is reused for BUDGET_STATE_TTL_MS while those settings and the purpose
 * stay the same. A spent budget is logged once per read of the log (at most once per TTL, as it
 * is cached), an unusable log (read again on every request) at most once per TTL. `quiet`
 * callers (readiness probes) share the reads and log nothing: the warning is left to the next
 * request that acts on the state.
 */
export function liveBudgetState(
  env: NodeJS.ProcessEnv,
  purpose: LlmPurpose,
  options: { quiet?: boolean } = {},
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
  const now = pacingClock();
  let entry = cached;
  if (!entry || entry.key !== key || now - entry.at >= BUDGET_STATE_TTL_MS) {
    const created: CachedState = {
      key,
      at: now,
      state: readBudgetState(settings, purpose),
      warned: false,
    };
    // An unverifiable answer is not kept.
    void created.state.then((read) => {
      if (read.state === "unverifiable" && cached === created) cached = null;
    });
    cached = created;
    entry = created;
  }
  if (options.quiet) return entry.state;
  const used = entry;
  return used.state.then((read) => {
    warnAbout(used, read);
    return read;
  });
}

/** For tests: forgets the cached state, so the next request reads the spend log again. */
export function resetBudgetStateForTests(): void {
  cached = null;
  lastUnverifiableWarning = Number.NEGATIVE_INFINITY;
}
