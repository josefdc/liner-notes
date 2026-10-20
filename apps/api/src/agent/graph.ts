/**
 * LangGraph Workflow v2 for The Sonic Agent
 *
 * Architecture: "The Adaptive Sonic Graph"
 *
 * Features:
 * - Map-Reduce: Parallel execution of listener & researcher
 * - Human-in-the-loop: Interrupt for ambiguous searches
 * - Streaming: Real-time status updates via writer
 * - Structured Output: Guaranteed TrackData schema
 *
 * Workflow:
 *   scout → [clarification?] → parallel(engineer, historian) → composer → END
 *                  ↑
 *            (interrupt if ambiguous)
 */

import { StateGraph, END, START } from "@langchain/langgraph";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { getDb } from "../store/database.js";
import { SqliteStore } from "../store/store.js";
import dotenv from "dotenv";

import type { TrackData, SearchCandidate } from "./schema.js";
import { SonicAgentState, type SonicAgentStateType } from "./state.js";
import {
  scoutNode,
  clarificationNode,
  engineerNode,
  historianNode,
  composerNode,
} from "./nodes/index.js";

dotenv.config();

// =============================================================================
// Conditional Edge: Check if clarification needed
// =============================================================================

function routeAfterScout(state: SonicAgentStateType): string[] | string {
  if (state.trackData) return END; // Cache hit — skip pipeline
  if (state.error) {
    return END;
  }
  if (state.candidates && state.candidates.length > 0) {
    return "clarification";
  }
  // No ambiguity: run engineer and historian in parallel
  return ["engineer", "historian"];
}

function routeAfterClarification(state: SonicAgentStateType): string[] | string {
  if (state.error) {
    return END;
  }
  return ["engineer", "historian"];
}

// =============================================================================
// Build the Graph
// =============================================================================

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
let cachedGraph: ReturnType<typeof compileGraph> | null = null;

function compileGraph() {
  const workflow = new StateGraph(SonicAgentState)
    // Add nodes
    .addNode("scout", scoutNode, {
      retryPolicy: { maxAttempts: 2 },
    })
    .addNode("clarification", clarificationNode)
    .addNode("engineer", engineerNode, {
      retryPolicy: { maxAttempts: 2 },
    })
    .addNode("historian", historianNode, {
      retryPolicy: { maxAttempts: 2 },
    })
    .addNode("composer", composerNode, {
      retryPolicy: { maxAttempts: 2 },
    })

    // Start with scout
    .addEdge(START, "scout")

    // Conditional routing after scout
    .addConditionalEdges("scout", routeAfterScout, {
      clarification: "clarification",
      engineer: "engineer",
      historian: "historian",
      [END]: END,
    })

    // After clarification, run parallel nodes
    .addConditionalEdges("clarification", routeAfterClarification, {
      engineer: "engineer",
      historian: "historian",
      [END]: END,
    })

    // Both parallel nodes converge at composer
    .addEdge("engineer", "composer")
    .addEdge("historian", "composer")

    // Composer ends the workflow
    .addEdge("composer", END);

  // The clarification node pauses itself with interrupt(); no static interruptBefore, which
  // would stop the graph a second time at the same node.
  return workflow.compile({
    checkpointer: getCheckpointer(),
    store: getStore(),
  });
}

export function createSonicAgentGraph() {
  if (!cachedGraph) {
    cachedGraph = compileGraph();
    console.log("✅ [Graph] Compiled and cached LangGraph workflow");
  }
  return cachedGraph;
}

// =============================================================================
// Exports
// =============================================================================

export type { TrackData, SearchCandidate, SonicAgentStateType };
