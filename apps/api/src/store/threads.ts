/**
 * Reads a LangGraph thread's saved state straight from the checkpoint tables, without building
 * the graph.
 */

import { INTERRUPT } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type Database from "better-sqlite3";

/**
 * True when the thread's latest checkpoint has a pending interrupt, i.e. the thread is paused
 * waiting for input (the clarification choice). False for a thread with no saved state.
 */
export async function isWaitingAtInterrupt(
  db: Database.Database,
  threadId: string,
): Promise<boolean> {
  const tuple = await new SqliteSaver(db).getTuple({
    configurable: { thread_id: threadId, checkpoint_ns: "" },
  });
  return tuple?.pendingWrites?.some(([, channel]) => channel === INTERRUPT) ?? false;
}
