/**
 * Reads a LangGraph thread's saved state straight from the checkpoint tables, without building
 * the graph.
 */

import { INTERRUPT } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import type Database from "better-sqlite3";

// One saver per connection: it sets up its tables once and keeps its prepared reads. The map
// holds the connection weakly, so a saver is collected with its connection once nothing else
// refers to that connection.
const savers = new WeakMap<Database.Database, SqliteSaver>();

function saverFor(db: Database.Database): SqliteSaver {
  let saver = savers.get(db);
  if (!saver) {
    saver = new SqliteSaver(db);
    savers.set(db, saver);
  }
  return saver;
}

/**
 * True when the thread's latest checkpoint has a pending interrupt, i.e. the thread is paused
 * waiting for input (the clarification choice). False for a thread with no saved state.
 */
export async function isWaitingAtInterrupt(
  db: Database.Database,
  threadId: string,
): Promise<boolean> {
  const tuple = await saverFor(db).getTuple({
    configurable: { thread_id: threadId, checkpoint_ns: "" },
  });
  return tuple?.pendingWrites?.some(([, channel]) => channel === INTERRUPT) ?? false;
}
