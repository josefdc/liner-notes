/**
 * The verifier's judge: one model call on the `judge` tier that says, for each model claim that
 * cites evidence, whether its cited excerpts support it (`JudgeOutput`). Support, not truth.
 *
 * At most JUDGE_BATCH_MAX claims are sent, the first ones in the order given (the verifier puts
 * the genealogy links' claims first); the rest get no verdict and are counted as unjudged. A
 * claim longer than the judge reads whole (JUDGE_STATEMENT_MAX) is not sent: a verdict on part
 * of it would cover what the judge never read. The prompt names each claim by its place in the
 * batch ("c1", "c2"), never by its generated id, so the same claims always give the same prompt
 * (and replay from the same cassette).
 *
 * A failure of the call (budget refused, per-run call cap, rate limit, timeout, network, an
 * incomplete, refused or invalid answer, or one that breaks `judgeOutputIssues`) leaves every
 * verdict null and is recorded as a failed call: the result is still served, with the claims
 * shown as model inference. An answer that leaves some sent claims without a verdict keeps the
 * verdicts it gave; the others stay unjudged, and the result says the check was not complete.
 *
 * The call gets `timeoutMs` when the run's deadline is known: its share of the run's time,
 * across both of the provider layer's attempts (0: no time, the judge is not asked). Past it
 * the call is stopped and counts as a judge timeout, so a slow judge never costs the run its
 * result. A cancel of the run itself stops it and is rethrown.
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
import { JUDGE_STATEMENT_MAX, judgeMessages, type PromptTrack } from "../prompts.js";
import type { AgentRuntime } from "../runtime.js";
import type { LlmCallRecord } from "../state.js";

export const JUDGE_CALL_SITE = "verifier";
/**
 * Output budget of the judge call, reasoning included. Twenty verdicts of one short sentence
 * take about 1000 tokens of JSON; the rest is room for the judge tier's medium-effort reasoning,
 * whose recommended minimum budget is this (llm/invoke.ts RECOMMENDED_MIN_OUTPUT_TOKENS).
 */
export const JUDGE_MAX_OUTPUT_TOKENS = 4000;
/** Longest verdict reason kept, in characters. */
export const VERDICT_REASON_MAX = 200;

export interface JudgedClaim {
  verdict: Verdict;
  reason: string;
}

export interface JudgeResult {
  /** The judge's verdict by claim id, for the claims it judged. */
  verdicts: Map<string, JudgedClaim>;
  /** The call's record; null when nothing was sent. */
  call: LlmCallRecord | null;
  /** The call's error when it failed, was refused or was not made for want of time; else null. */
  failure: unknown;
  /** Claims sent whose verdict the answer left out (0 when the call failed). */
  omitted: number;
  /** Claims not sent because they are longer than the judge reads whole. */
  tooLong: string[];
  judged: number;
  /** Claims that cite evidence and got no verdict: beyond the batch, too long, left out, failed. */
  unjudged: number;
}

/** A verdict reason as the result keeps it: one line, clipped, no private handle. */
function keptReason(reason: string): string {
  const line = maskHandles(reason.replace(/\s+/g, " ").trim());
  return line.length > VERDICT_REASON_MAX ? `${line.slice(0, VERDICT_REASON_MAX - 1)}…` : line;
}

/**
 * Judges `claims` (model claims that cite evidence, in the order to send them) against the
 * excerpts they cite. Never throws for a model failure or a judge timeout; rethrows a cancel of
 * the run (`signal`).
 */
export async function judgeClaims(
  claims: readonly Claim[],
  evidence: readonly Evidence[],
  track: PromptTrack,
  runtime: AgentRuntime,
  options: { runId: string; signal?: AbortSignal; timeoutMs?: number },
): Promise<JudgeResult> {
  const verdicts = new Map<string, JudgedClaim>();
  const tooLong = claims
    .filter((claim) => claim.text.trim().length > JUDGE_STATEMENT_MAX)
    .map((claim) => claim.id);
  const fits = claims.filter((claim) => !tooLong.includes(claim.id));
  const nothing = { verdicts, omitted: 0, tooLong, judged: 0, unjudged: claims.length };
  if (fits.length === 0) return { ...nothing, call: null, failure: null };
  if (options.timeoutMs !== undefined && options.timeoutMs <= 0) {
    const failure = new LlmError("timeout", `${JUDGE_CALL_SITE}: no time left in the run to judge`);
    return { ...nothing, call: null, failure };
  }
  const batch = fits.slice(0, JUDGE_BATCH_MAX);
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
    ...nothing,
    call,
    failure,
  });

  // The judge's own time: past it the call stops, whatever the provider layer's own timeout.
  const timer = new AbortController();
  const clock =
    options.timeoutMs === undefined
      ? undefined
      : setTimeout(() => timer.abort(new Error("judge time is up")), options.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timer.signal]) : timer.signal;
  let result: InvokeResult<JudgeOutput>;
  try {
    result = await runtime.llm.invoke(JUDGE_CALL_SITE, "judge", messages, JudgeOutput, {
      purpose: runtime.purpose,
      runId: options.runId,
      maxOutputTokens: JUDGE_MAX_OUTPUT_TOKENS,
      signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    if (timer.signal.aborted) {
      const timeout = new LlmError(
        "timeout",
        `${JUDGE_CALL_SITE}: no answer within its ${options.timeoutMs} ms of the run's time`,
      );
      return unjudgedAll(
        { ...failedCall(JUDGE_CALL_SITE, "judge", error), status: "timeout" },
        timeout,
      );
    }
    if (isAbortError(error)) throw error;
    return unjudgedAll(failedCall(JUDGE_CALL_SITE, "judge", error), error);
  } finally {
    clearTimeout(clock);
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
    omitted: batch.length - verdicts.size,
    tooLong,
    judged: verdicts.size,
    unjudged: claims.length - verdicts.size,
  };
}
