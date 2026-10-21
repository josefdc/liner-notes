/**
 * What the agent's nodes depend on besides their state: the model layer, a clock and an id
 * source. Tests and replays pass their own, so a run can be repeated exactly: the prompts hold
 * no time and no generated id, and every timestamp and id in a result comes from here.
 */

import { randomUUID } from "node:crypto";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import type { LlmPurpose } from "../config/settings.js";
import { type Llm, llm } from "../llm/invoke.js";

export interface AgentRuntime {
  llm: Llm;
  /** The clock for timestamps in events and results. */
  now: () => Date;
  /** Ids for factoids, entities and claims. */
  newId: () => string;
  /** The purpose tag of the run's model calls (budget accounting). */
  purpose: LlmPurpose;
}

export const defaultAgentRuntime: AgentRuntime = {
  llm,
  now: () => new Date(),
  newId: () => randomUUID(),
  purpose: "dev",
};

/** A runtime with the defaults for whatever `overrides` leaves out. */
export function agentRuntime(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return { ...defaultAgentRuntime, ...overrides };
}

/**
 * The run a node belongs to: the graph's thread id (the analysis route uses the thread id as
 * the run id), or `fallback` outside a thread.
 */
export function runIdOf(config: LangGraphRunnableConfig | undefined, fallback: () => string) {
  const threadId: unknown = config?.configurable?.thread_id;
  return typeof threadId === "string" && threadId !== "" ? threadId : fallback();
}

/**
 * The run id of a graph invocation: the one in the state (set once, by the first node), else
 * the thread id, else a new id from the runtime.
 */
export function runIdFor(
  state: { runId?: string | null },
  config: LangGraphRunnableConfig | undefined,
  runtime: AgentRuntime,
): string {
  return state.runId ?? runIdOf(config, runtime.newId);
}

/** An ISO timestamp from the runtime's clock. */
export const timestampOf = (runtime: AgentRuntime) => runtime.now().toISOString();
