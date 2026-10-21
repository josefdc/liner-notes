/**
 * The budget guard: reserves a call's worst-case cost in the spend log before the call, and
 * settles the actual cost after it.
 *
 * Under the spend log's lock, `reserve` reads and sums the log (spendLog.ts), checks the caps
 * with this call's worst case added, and appends a reservation line; then the lock is released
 * and the call runs. `settle` appends the actual cost under the lock. Concurrent calls in any
 * number of processes therefore see each other's reservations and cannot overshoot a cap; a
 * process that dies mid-call leaves its reservation counted at the worst case.
 *
 * Caps (config/settings.ts BudgetSettings), each checked with the reservation included:
 *   - total:       BUDGET_TOTAL_USD, every purpose
 *   - daily:       BUDGET_DAILY_USD, calls reserved today (UTC; the day ends at 19:00 in Bogotá)
 *   - eval floor:  dev and showcase calls stop once total > BUDGET_TOTAL_USD − BUDGET_EVAL_FLOOR_USD.
 *                  The floor is not set aside: evaluation spending also counts towards the total,
 *                  so it brings the point where dev calls stop closer.
 *   - eval sub-cap: eval:golden, eval:baseline, eval:perturb, eval:variance, each its own cap.
 *                  Plain `eval` may spend the floor too, but has no sub-cap: only the total and
 *                  daily caps limit it. Prefer a sub-purpose.
 *
 * A call is refused (LlmError spend_log_unavailable) when the log is unset, missing (unless
 * `init`), cannot be read or written, or holds a malformed line. The log is named by its real
 * path, so a symlink to it shares its lock.
 */

import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
  type BudgetSettings,
  EVAL_SUB_CAPS,
  type EvalSubPurpose,
  type LlmPurpose,
  type LlmTier,
} from "../config/settings.js";
import { LlmError } from "./errors.js";
import { LockTimeoutError, withLock } from "./fileLock.js";
import {
  appendLine,
  checkAccess,
  createSpendLog,
  needsNewLine,
  readSpendLog,
  type SpendLine,
  SpendLogError,
  type SpendTotals,
  summarise,
} from "./spendLog.js";

export const isEvalPurpose = (purpose: LlmPurpose) =>
  purpose === "eval" || purpose.startsWith("eval:");

const isEvalSubPurpose = (purpose: LlmPurpose): purpose is EvalSubPurpose =>
  Object.hasOwn(EVAL_SUB_CAPS, purpose);

const usd = (value: number) => `USD ${value.toFixed(4)}`;

/**
 * Why a call costing `reserveUsd` would break a cap, or null when it fits. Pure, so the rules
 * can be tested without a log.
 */
export function capViolation(
  totals: SpendTotals,
  purpose: LlmPurpose,
  reserveUsd: number,
  caps: BudgetSettings,
): string | null {
  const total = totals.totalUsd + reserveUsd;
  if (total > caps.totalUsd) {
    return `total spending would reach ${usd(total)}, above BUDGET_TOTAL_USD (${usd(caps.totalUsd)})`;
  }
  const today = totals.todayUsd + reserveUsd;
  if (today > caps.dailyUsd) {
    return `spending today would reach ${usd(today)}, above BUDGET_DAILY_USD (${usd(caps.dailyUsd)})`;
  }
  if (!isEvalPurpose(purpose)) {
    const limit = caps.totalUsd - caps.evalFloorUsd;
    if (total > limit) {
      return (
        `total spending would reach ${usd(total)}; ${purpose} calls stop at ${usd(limit)} ` +
        "(BUDGET_TOTAL_USD − BUDGET_EVAL_FLOOR_USD, the rest is kept for evaluations)"
      );
    }
  }
  if (isEvalSubPurpose(purpose)) {
    const spent = (totals.byUnitUsd[purpose] ?? 0) + reserveUsd;
    const cap = caps.evalSubCapsUsd[purpose];
    if (spent > cap) {
      return `${purpose} spending would reach ${usd(spent)}, above ${EVAL_SUB_CAPS[purpose].variable} (${usd(cap)})`;
    }
  }
  return null;
}

export interface ReservationRequest {
  purpose: LlmPurpose;
  tier: LlmTier;
  deployment: string;
  callSite: string;
  runId: string;
  inputTokensEstimate: number;
  maxOutputTokens: number;
  usdEst: number;
  multiplier: number;
}

export interface Reservation {
  id: string;
  /** When the reservation was written: the call counts on this day. */
  ts: string;
  request: ReservationRequest;
}

export interface Settlement {
  inputTokens: number;
  /** Including reasoning tokens. */
  outputTokens: number;
  reasoningTokens: number | null;
  usdEst: number;
  latencyMs: number;
  status: string;
  /** True when the outcome is unknown and the worst case is kept. */
  estimated: boolean;
}

export interface SpendGuardOptions {
  /** The spend log path; null refuses every call. */
  logPath: string | null;
  caps: BudgetSettings;
  /** Create the log, empty, when it does not exist (LLM_SPEND_LOG_INIT=1). */
  init?: boolean;
  now?: () => Date;
  lockWaitMs?: number;
  /** Wait before the one retry of a failed settle (default 200 ms). */
  settleRetryMs?: number;
}

function unavailable(error: unknown): LlmError {
  if (error instanceof LlmError) return error;
  const detail =
    error instanceof SpendLogError
      ? error.message
      : error instanceof LockTimeoutError
        ? `LLM_SPEND_LOG is locked by another process for too long (${error.lockPath})`
        : `LLM_SPEND_LOG cannot be used (${(error as NodeJS.ErrnoException)?.code ?? "error"})`;
  return new LlmError("spend_log_unavailable", `${detail}; the call was refused`);
}

/**
 * The log's real path: the file's when it exists, else its directory's plus the name. The lock
 * is named after it, so a symlink to the log and the log itself share one lock.
 */
export async function resolveSpendLogPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    return join(await realpath(dirname(path)), basename(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SpendLogError(
        "LLM_SPEND_LOG cannot be used: its directory does not exist (ENOENT)",
      );
    }
    throw error;
  }
}

export class SpendGuard {
  private readonly now: () => Date;

  constructor(private readonly options: SpendGuardOptions) {
    this.now = options.now ?? (() => new Date());
  }

  private configuredPath(): string {
    if (this.options.logPath === null) {
      throw new LlmError(
        "spend_log_unavailable",
        "LLM_SPEND_LOG is not set; live model calls are refused until it names the spend log",
      );
    }
    return this.options.logPath;
  }

  private async locked<T>(fn: (path: string) => Promise<T>): Promise<T> {
    try {
      const path = await resolveSpendLogPath(this.configuredPath());
      return await withLock(
        path,
        async () => {
          if (this.options.init) await createSpendLog(path);
          return fn(path);
        },
        { waitMs: this.options.lockWaitMs },
      );
    } catch (error) {
      throw unavailable(error);
    }
  }

  /** Creates the log, empty, if it does not exist; true when it was created. */
  async init(): Promise<boolean> {
    try {
      return await createSpendLog(await resolveSpendLogPath(this.configuredPath()));
    } catch (error) {
      throw unavailable(error);
    }
  }

  /** Checks the log exists and can be read, summed and written, without writing to it. */
  preflight(): Promise<SpendTotals> {
    return this.locked(async (path) => {
      await checkAccess(path);
      const { lines } = await readSpendLog(path);
      return summarise(lines, this.now());
    });
  }

  /** Reserves the call's worst case, or throws LlmError budget_exceeded / spend_log_unavailable. */
  reserve(request: ReservationRequest): Promise<Reservation> {
    return this.locked(async (path) => {
      const { lines, unterminated } = await readSpendLog(path);
      const totals = summarise(lines, this.now());
      const violation = capViolation(totals, request.purpose, request.usdEst, this.options.caps);
      if (violation) {
        throw new LlmError(
          "budget_exceeded",
          `${request.callSite}: ${violation}; the call was refused`,
        );
      }
      const reservation: Reservation = { id: randomUUID(), ts: this.now().toISOString(), request };
      try {
        await appendLine(path, this.line("reserve", reservation), unterminated);
      } catch (error) {
        // The call is refused. If part of the line reached the file, release it explicitly so
        // a reservation for a call that never ran does not stay counted.
        if (error instanceof SpendLogError && error.written) {
          await appendLine(
            path,
            this.line("settle", reservation, {
              inputTokens: 0,
              outputTokens: 0,
              reasoningTokens: null,
              usdEst: 0,
              latencyMs: 0,
              status: "error:reserve_not_written",
              estimated: false,
            }),
            true,
          ).catch(() => {});
        }
        throw error;
      }
      return reservation;
    });
  }

  /**
   * Records the actual cost; tried twice. When both fail the reservation stays counted at the
   * worst case, which over-counts but never under-counts.
   */
  async settle(reservation: Reservation, settlement: Settlement): Promise<void> {
    const once = () =>
      this.locked(async (path) => {
        await appendLine(
          path,
          this.line("settle", reservation, settlement),
          await needsNewLine(path),
        );
      });
    try {
      await once();
    } catch {
      await new Promise((resolve) => setTimeout(resolve, this.options.settleRetryMs ?? 200));
      await once();
    }
  }

  private line(
    kind: "reserve" | "settle",
    reservation: Reservation,
    settlement?: Settlement,
  ): SpendLine {
    const { request } = reservation;
    const base: SpendLine = {
      ts: kind === "reserve" ? reservation.ts : this.now().toISOString(),
      deployment: request.deployment,
      in: settlement ? settlement.inputTokens : request.inputTokensEstimate,
      out: settlement ? settlement.outputTokens : request.maxOutputTokens,
      usd_est: settlement ? settlement.usdEst : request.usdEst,
      unit: request.purpose,
      v: 1,
      kind,
      id: reservation.id,
    };
    if (settlement) base.reserve_ts = reservation.ts;
    base.tier = request.tier;
    base.callSite = request.callSite;
    base.runId = request.runId;
    base.multiplier = request.multiplier;
    if (settlement) {
      base.reasoning = settlement.reasoningTokens;
      base.latency_ms = settlement.latencyMs;
      base.status = settlement.status;
      base.estimated = settlement.estimated;
    }
    base.pid = process.pid;
    return base;
  }
}
