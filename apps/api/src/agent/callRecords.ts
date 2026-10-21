/**
 * Records of a run's model calls (the `usage` state channel) and the run's usage summary.
 */

import type { RunUsage } from "@liner-notes/contract";
import type { LlmTier } from "../config/settings.js";
import { isLlmError } from "../llm/errors.js";
import type { InvokeResult } from "../llm/invoke.js";
import type { LlmCallRecord } from "./state.js";

/** The record of a call that answered. */
export function answeredCall(callSite: string, result: InvokeResult<unknown>): LlmCallRecord {
  return {
    callSite,
    tier: result.tier,
    status: "ok",
    deployment: result.deployment,
    attempts: result.usage.attempts,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    reasoningTokens: result.usage.reasoningTokens,
    usdEst: result.usage.usdEst,
  };
}

/** The record of a call that failed: its error kind, and the tokens it reported, if any. */
export function failedCall(callSite: string, tier: LlmTier, error: unknown): LlmCallRecord {
  const usage = isLlmError(error) ? error.usage : undefined;
  return {
    callSite,
    tier,
    status: isLlmError(error) ? error.kind : "unexpected",
    deployment: null,
    attempts: null,
    inputTokens: usage?.inputTokens ?? null,
    outputTokens: usage?.outputTokens ?? null,
    reasoningTokens: usage?.reasoningTokens ?? null,
    usdEst: 0,
  };
}

/**
 * The run's model use: `llmCalls` is what the provider layer counted for the run (every
 * attempt it sent, retries included); tokens and cost add up the calls that reported them.
 */
export function runUsage(records: readonly LlmCallRecord[], llmCalls: number): RunUsage {
  const sum = (pick: (r: LlmCallRecord) => number | null) =>
    records.reduce((total, r) => total + (pick(r) ?? 0), 0);
  return {
    llmCalls,
    inputTokens: sum((r) => r.inputTokens),
    outputTokens: sum((r) => r.outputTokens),
    reasoningTokens: sum((r) => r.reasoningTokens),
    usd: sum((r) => r.usdEst),
  };
}
