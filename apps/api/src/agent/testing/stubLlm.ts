/**
 * Test helpers for the agent: a model layer that answers from a function (no provider, no
 * cassette), and a runtime with a fixed clock and counting ids.
 */

import type { z } from "zod";
import type { LlmTier } from "../../config/settings.js";
import type { InvokeOptions, InvokeResult, Llm, LlmInput } from "../../llm/invoke.js";
import { type AgentRuntime, agentRuntime } from "../runtime.js";

export interface StubCall {
  callSite: string;
  tier: LlmTier;
  input: LlmInput;
  schema: z.ZodType;
  options: InvokeOptions;
}

export type StubLlm = Llm & { calls: StubCall[] };

/**
 * A model layer whose answer is `answer(call)`, parsed with the call's schema (an answer the
 * schema refuses throws, as the real layer's invalid_output does). A thrown error is the call's
 * failure. Each call counts against its run.
 */
export function stubLlm(answer: (call: StubCall) => unknown): StubLlm {
  const calls: StubCall[] = [];
  const perRun = new Map<string, number>();
  return {
    calls,
    async invoke<S extends z.ZodType>(
      callSite: string,
      tier: LlmTier,
      input: LlmInput,
      schema: S,
      options: InvokeOptions,
    ): Promise<InvokeResult<z.output<S>>> {
      const call = { callSite, tier, input, schema, options };
      calls.push(call);
      perRun.set(options.runId, (perRun.get(options.runId) ?? 0) + 1);
      const output = schema.parse(await answer(call));
      return {
        output,
        callId: `call-${calls.length}`,
        mode: "live",
        tier,
        deployment: `stub-${tier}`,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 0,
          usdEst: 0,
          multiplier: 1,
          latencyMs: 1,
          attempts: 1,
        },
      };
    },
    callsForRun: (runId) => perRun.get(runId) ?? 0,
    endRun: (runId) => {
      perRun.delete(runId);
    },
  };
}

/** A runtime on `llm` whose clock stands still at `at` and whose ids count up from id-1. */
export function testRuntime(llm: Llm, at = "2026-01-01T00:00:00.000Z"): AgentRuntime {
  let next = 0;
  return agentRuntime({
    llm,
    now: () => new Date(at),
    newId: () => `id-${++next}`,
  });
}

/** The text of a call's messages, by role. */
export function messagesOf(call: StubCall): { system: string; user: string } {
  const list = call.input as ReadonlyArray<{ role: string; content: string }>;
  const text = (role: string) =>
    list
      .filter((m) => m.role === role)
      .map((m) => m.content)
      .join("\n");
  return { system: text("system"), user: text("user") };
}
