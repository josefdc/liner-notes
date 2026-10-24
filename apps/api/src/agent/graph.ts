/**
 * The analysis graph.
 *
 *   scout → [clarification?] → engineer ∥ historian → composer → END
 *                  ↑
 *            (interrupt if ambiguous)
 *
 * The scout (for a track it selects) and the clarification (for a picked one) end the run with
 * the result stored for that track, when there is one.
 *
 * The engineer and the historian run in parallel and meet at the composer through one
 * list-form edge, so the composer runs once, after both, however many steps either branch
 * takes. No node has a retry policy: every node handles its own failures (the scout and the
 * searches retry once or twice themselves, model calls are retried inside the provider layer),
 * so retries never stack and a model call is never repeated by a node retry.
 *
 * The scout, the first node of every run, sets the run id once (the thread id, or a new id
 * from the runtime without a thread): every model call of the run counts under it.
 *
 * `buildSonicAgentGraph` takes the runtime (model layer, clock, ids), the checkpointer and the
 * store, so tests and replays run the same graph on their own dependencies.
 */

import type { BaseCheckpointSaver, BaseStore, LangGraphRunnableConfig } from "@langchain/langgraph";
import { END, START, StateGraph } from "@langchain/langgraph";
import { PreviewFreeSqliteSaver } from "../store/checkpointer.js";
import { getDb } from "../store/database.js";
import { SqliteStore } from "../store/store.js";
import {
  clarificationNode,
  composerNode,
  createComposerNode,
  engineerNode,
  historianNode,
  scoutNode,
} from "./nodes/index.js";
import { type AgentRuntime, defaultAgentRuntime, runIdFor } from "./runtime.js";
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
  if (state.trackData) return END; // A stored result for the picked track
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
    .addNode("scout", async (state: SonicAgentStateType, config: LangGraphRunnableConfig) => ({
      ...(await scoutNode(state, config, runtime)),
      runId: runIdFor(state, config, runtime),
    }))
    .addNode("clarification", (state: SonicAgentStateType, config: LangGraphRunnableConfig) =>
      clarificationNode(state, config, runtime),
    )
    .addNode("engineer", (state: SonicAgentStateType, config: LangGraphRunnableConfig) =>
      engineerNode(state, config, runtime),
    )
    .addNode("historian", (state: SonicAgentStateType, config: LangGraphRunnableConfig) =>
      historianNode(state, config, runtime),
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

// Persistent checkpointer — survives server restarts for HITL resume. It never saves preview
// URLs (store/checkpointer.ts).
let globalCheckpointer: PreviewFreeSqliteSaver | null = null;
function getCheckpointer(): PreviewFreeSqliteSaver {
  if (!globalCheckpointer) {
    globalCheckpointer = new PreviewFreeSqliteSaver(getDb());
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
