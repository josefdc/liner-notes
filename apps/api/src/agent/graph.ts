/**
 * The analysis graph.
 *
 *   scout → [clarification?] → engineer ∥ historian → composer → END
 *                  ↑
 *            (interrupt if ambiguous)
 *
 * The engineer and the historian run in parallel and meet at the composer through one
 * list-form edge, so the composer runs once, after both, however many steps either branch
 * takes. Retry policies retry transient errors only (`TRANSIENT_RETRY`); the composer has none:
 * its model call is retried inside the provider layer, and any failure gives the fallback.
 *
 * `buildSonicAgentGraph` takes the runtime (model layer, clock, ids), the checkpointer and the
 * store, so tests and replays run the same graph on their own dependencies.
 */

import type { BaseCheckpointSaver, BaseStore, LangGraphRunnableConfig } from "@langchain/langgraph";
import { END, START, StateGraph } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { getDb } from "../store/database.js";
import { SqliteStore } from "../store/store.js";
import { TRANSIENT_RETRY } from "./errors.js";
import {
  clarificationNode,
  composerNode,
  createComposerNode,
  engineerNode,
  historianNode,
  scoutNode,
} from "./nodes/index.js";
import { type AgentRuntime, defaultAgentRuntime } from "./runtime.js";
import type { SearchCandidate, TrackData } from "./schema.js";
import { SonicAgentState, type SonicAgentStateType } from "./state.js";

// =============================================================================
// Routing
// =============================================================================

function routeAfterScout(state: SonicAgentStateType): string[] | string {
  if (state.trackData) return END; // Cache hit — skip pipeline
  if (state.error) return END;
  if (state.candidates && state.candidates.length > 0) return "clarification";
  // No ambiguity: run engineer and historian in parallel
  return ["engineer", "historian"];
}

function routeAfterClarification(state: SonicAgentStateType): string[] | string {
  if (state.error) return END;
  return ["engineer", "historian"];
}

// =============================================================================
// Build the Graph
// =============================================================================

export interface GraphDependencies {
  runtime?: AgentRuntime;
  checkpointer?: BaseCheckpointSaver;
  store?: BaseStore;
}

export function buildSonicAgentGraph({
  runtime = defaultAgentRuntime,
  checkpointer,
  store,
}: GraphDependencies = {}) {
  const workflow = new StateGraph(SonicAgentState)
    .addNode("scout", scoutNode, { retryPolicy: TRANSIENT_RETRY })
    .addNode("clarification", clarificationNode)
    .addNode("engineer", engineerNode, { retryPolicy: TRANSIENT_RETRY })
    .addNode(
      "historian",
      (state: SonicAgentStateType, config: LangGraphRunnableConfig) =>
        historianNode(state, config, runtime),
      { retryPolicy: TRANSIENT_RETRY },
    )
    .addNode(
      "composer",
      runtime === defaultAgentRuntime ? composerNode : createComposerNode(runtime),
    )
    .addEdge(START, "scout")
    .addConditionalEdges("scout", routeAfterScout, {
      clarification: "clarification",
      engineer: "engineer",
      historian: "historian",
      [END]: END,
    })
    .addConditionalEdges("clarification", routeAfterClarification, {
      engineer: "engineer",
      historian: "historian",
      [END]: END,
    })
    // One fan-in: the composer waits for both branches and runs once
    .addEdge(["engineer", "historian"], "composer")
    .addEdge("composer", END);

  // The clarification node pauses itself with interrupt(); no static interruptBefore, which
  // would stop the graph a second time at the same node.
  return workflow.compile({ checkpointer, store });
}

// Persistent checkpointer — survives server restarts for HITL resume
let globalCheckpointer: SqliteSaver | null = null;
function getCheckpointer(): SqliteSaver {
  if (!globalCheckpointer) {
    globalCheckpointer = new SqliteSaver(getDb());
  }
  return globalCheckpointer;
}

// Persistent store — track data and disambiguation preferences survive restarts
let globalStore: SqliteStore | null = null;
function getStore(): SqliteStore {
  if (!globalStore) {
    globalStore = new SqliteStore(getDb());
  }
  return globalStore;
}

// Cache the compiled graph for reuse
let cachedGraph: ReturnType<typeof buildSonicAgentGraph> | null = null;

/** The app's graph: the default runtime, the SQLite checkpointer and store; compiled once. */
export function createSonicAgentGraph() {
  if (!cachedGraph) {
    cachedGraph = buildSonicAgentGraph({ checkpointer: getCheckpointer(), store: getStore() });
    console.log("✅ [Graph] Compiled and cached LangGraph workflow");
  }
  return cachedGraph;
}

// =============================================================================
// Exports
// =============================================================================

export type { TrackData, SearchCandidate, SonicAgentStateType };
