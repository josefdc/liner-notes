/**
 * Usage rows: one row per model call attempt in the `llm_usage` table (migration 4), a
 * per-database copy for reports. The spend log (spendLog.ts) is the authoritative record.
 *
 * Columns:
 *   id                the attempt's spend-log id (replayed calls get their own id)
 *   run_id            the analysis run the call belongs to
 *   call_site         the code that made the call (e.g. "composer")
 *   tier, deployment  the tier asked for and the deployment that answered
 *   purpose           dev | eval | showcase | eval:<sub-purpose>
 *   mode              live | record | replay (replay costs nothing: usd_est 0)
 *   status            ok, or error:<LlmError kind>
 *   input_tokens, output_tokens, reasoning_tokens
 *                     as reported by the provider (output includes reasoning); null when unknown
 *   usd_est           estimated cost at the price table, multiplier applied
 *   price_multiplier  1 for a sourced price, 1.5 for a deployment priced at the fallback prices
 *   estimated         1 when the provider reported no usage and the worst case was counted
 *   latency_ms        duration of the attempt
 *   created_at        unix seconds
 *   sent              1 when the request was sent to the provider: it left the process, and
 *                     did not fail in a way that shows no connection was made. 0 when it was not:
 *                     stopped before it was sent, no connection made (DNS failure, connection
 *                     refused), or a replayed call. Null for rows written before migration 12
 */

import type Database from "better-sqlite3";
import { getDb } from "../store/database.js";
import { logger } from "../logger.js";

const log = logger("llm");

export interface LlmUsageRow {
  id: string;
  runId: string;
  callSite: string;
  tier: string;
  deployment: string;
  purpose: string;
  mode: "live" | "record" | "replay";
  status: string;
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningTokens: number | null;
  usdEst: number;
  priceMultiplier: number;
  estimated: boolean;
  latencyMs: number;
  /** Whether the request was sent to the provider (see `sent` above). */
  sent: boolean;
}

/** A usage row as stored: `sent` is null for rows written before it was kept. */
export type StoredLlmUsageRow = Omit<LlmUsageRow, "sent"> & { sent: boolean | null };

export function recordLlmUsage(db: Database.Database, row: LlmUsageRow): void {
  db.prepare(
    `INSERT INTO llm_usage (id, run_id, call_site, tier, deployment, purpose, mode, status,
       input_tokens, output_tokens, reasoning_tokens, usd_est, price_multiplier, estimated,
       latency_ms, sent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.runId,
    row.callSite,
    row.tier,
    row.deployment,
    row.purpose,
    row.mode,
    row.status,
    row.inputTokens,
    row.outputTokens,
    row.reasoningTokens,
    row.usdEst,
    row.priceMultiplier,
    row.estimated ? 1 : 0,
    Math.round(row.latencyMs),
    row.sent ? 1 : 0,
  );
}

interface UsageDbRow {
  id: string;
  run_id: string;
  call_site: string;
  tier: string;
  deployment: string;
  purpose: string;
  mode: LlmUsageRow["mode"];
  status: string;
  input_tokens: number | null;
  output_tokens: number | null;
  reasoning_tokens: number | null;
  usd_est: number;
  price_multiplier: number;
  estimated: number;
  latency_ms: number;
  sent: number | null;
}

/** Usage rows, oldest first; only those of `runId` when given. */
export function listLlmUsage(db: Database.Database, runId?: string): StoredLlmUsageRow[] {
  const rows = (
    runId === undefined
      ? db.prepare("SELECT * FROM llm_usage ORDER BY created_at, rowid").all()
      : db.prepare("SELECT * FROM llm_usage WHERE run_id = ? ORDER BY created_at, rowid").all(runId)
  ) as UsageDbRow[];
  return rows.map((r) => ({
    id: r.id,
    runId: r.run_id,
    callSite: r.call_site,
    tier: r.tier,
    deployment: r.deployment,
    purpose: r.purpose,
    mode: r.mode,
    status: r.status,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    reasoningTokens: r.reasoning_tokens,
    usdEst: r.usd_est,
    priceMultiplier: r.price_multiplier,
    estimated: r.estimated === 1,
    latencyMs: r.latency_ms,
    sent: r.sent === null ? null : r.sent === 1,
  }));
}

/**
 * The default sink of `invoke`: writes to the app database when one is open, and does nothing
 * otherwise (a script or test without a database). A failed write is reported, never thrown:
 * the spend log already holds the call.
 */
export function recordToOpenDatabase(row: LlmUsageRow): void {
  let db: Database.Database;
  try {
    db = getDb();
  } catch {
    return;
  }
  try {
    recordLlmUsage(db, row);
  } catch (error) {
    log.warn(
      `could not record usage row ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
