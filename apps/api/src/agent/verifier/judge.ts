/**
 * The verifier's judge: one model call on the `judge` tier that says, for each model claim that
 * cites evidence, whether its cited excerpts support it (`JudgeOutput`). Support, not truth.
 *
 * At most JUDGE_BATCH_MAX claims are sent, the first ones in result order; the rest get no
 * verdict and are counted as unjudged. The prompt names each claim by its place in the batch
 * ("c1", "c2"), never by its generated id, so the same claims always give the same prompt (and
 * replay from the same cassette).
 *
 * A failure of the call (budget refused, per-run call cap, rate limit, timeout, network, an
 * incomplete, refused or invalid answer, or one that breaks `judgeOutputIssues`) leaves every
 * verdict null and is recorded as a failed call: the result is still served, with the claims
 * shown as model inference. A cancelled run stops it.
 */

import {
  type Claim,
  type Evidence,
  JUDGE_BATCH_MAX,
  JudgeOutput,
  judgeOutputIssues,
  type Verdict,
} from "@liner-notes/contract";
import { LlmError } from "../../llm/errors.js";
import type { InvokeResult } from "../../llm/invoke.js";
import { maskHandles } from "../../sources/search.js";
import { answeredCall, failedCall, refusedAnswer } from "../callRecords.js";
import { isAbortError } from "../errors.js";
import { judgeMessages, type PromptTrack } from "../prompts.js";
import type { AgentRuntime } from "../runtime.js";
import type { LlmCallRecord } from "../state.js";

export const JUDGE_CALL_SITE = "verifier";
/**
 * Output budget of the judge call, reasoning included (judge tier: medium effort, whose
 * recommended minimum is 4000): twenty one-sentence verdicts and the reasoning behind them.
 */
export const JUDGE_MAX_OUTPUT_TOKENS = 8000;
/** Longest verdict reason kept, in characters. */
export const VERDICT_REASON_MAX = 300;

export interface JudgedClaim {
  verdict: Verdict;
  reason: string;
}

export interface JudgeResult {
  /** The judge's verdict by claim id, for the claims it judged. */
  verdicts: Map<string, JudgedClaim>;
  /** The call's record; null when nothing was sent. */
  call: LlmCallRecord | null;
  /** The call's error when it failed or its answer was refused; null otherwise. */
  failure: unknown;
  judged: number;
  /** Claims that cite evidence and got no verdict: beyond the batch, left out or not judged. */
  unjudged: number;
}

/** A verdict reason as the result keeps it: one line, clipped, no private handle. */
function keptReason(reason: string): string {
  const line = maskHandles(reason.replace(/\s+/g, " ").trim());
  return line.length > VERDICT_REASON_MAX ? `${line.slice(0, VERDICT_REASON_MAX - 1)}…` : line;
}

/**
 * Judges `claims` (model claims that cite evidence, in result order) against the excerpts they
 * cite. Never throws for a model failure; rethrows a cancel.
 */
export async function judgeClaims(
  claims: readonly Claim[],
  evidence: readonly Evidence[],
  track: PromptTrack,
  runtime: AgentRuntime,
  options: { runId: string; signal?: AbortSignal },
): Promise<JudgeResult> {
  const verdicts = new Map<string, JudgedClaim>();
  if (claims.length === 0) {
    return { verdicts, call: null, failure: null, judged: 0, unjudged: 0 };
  }
  const batch = claims.slice(0, JUDGE_BATCH_MAX);
  const sentIds = batch.map((_, index) => `c${index + 1}`);
  const messages = judgeMessages({
    track,
    statements: batch.map((claim, index) => ({
      claimId: sentIds[index],
      text: claim.text,
      scope: claim.scope ?? "recording",
      evidenceIds: claim.evidenceIds,
    })),
    evidence,
  });
  const unjudgedAll = (call: LlmCallRecord, failure: unknown): JudgeResult => ({
    verdicts,
    call,
    failure,
    judged: 0,
    unjudged: claims.length,
  });

  let result: InvokeResult<JudgeOutput>;
  try {
    result = await runtime.llm.invoke(JUDGE_CALL_SITE, "judge", messages, JudgeOutput, {
      purpose: runtime.purpose,
      runId: options.runId,
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted || isAbortError(error)) throw error;
    return unjudgedAll(failedCall(JUDGE_CALL_SITE, "judge", error), error);
  }
  // An answer that breaks the rules the schema cannot carry is refused whole; it was billed.
  const issues = judgeOutputIssues(result.output, sentIds);
  if (issues.length > 0) {
    const refused = new LlmError(
      "invalid_output",
      `${JUDGE_CALL_SITE}: the answer breaks the JudgeOutput rules (${issues.slice(0, 3).join("; ")})`,
    );
    return unjudgedAll(refusedAnswer(JUDGE_CALL_SITE, result, "invalid_output"), refused);
  }
  for (const { claimId, verdict, reason } of result.output.verdicts) {
    const claim = batch[sentIds.indexOf(claimId)];
    verdicts.set(claim.id, { verdict, reason: keptReason(reason) });
  }
  return {
    verdicts,
    call: answeredCall(JUDGE_CALL_SITE, result),
    failure: null,
    judged: verdicts.size,
    unjudged: claims.length - verdicts.size,
  };
}
