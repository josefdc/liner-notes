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

import { StateGraph, END, START, Command } from "@langchain/langgraph";
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

  return workflow.compile({
    checkpointer: getCheckpointer(),
    store: getStore(),
    interruptBefore: ["clarification"],
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
// Main Entry Point (non-streaming)
// =============================================================================

export async function analyzeSong(songQuery: string): Promise<TrackData | null> {
  console.log("\n🚀 [Sonic Agent v2] Starting analysis for:", songQuery);
  console.log("=".repeat(60));

  const graph = createSonicAgentGraph();

  const result = await graph.invoke(
    { songQuery },
    { configurable: { thread_id: `analysis-${Date.now()}` } },
  );

  if (result.error) {
    console.error("❌ [Sonic Agent] Error:", result.error);
    return null;
  }

  console.log("=".repeat(60));
  console.log("✅ [Sonic Agent v2] Analysis complete!");

  return result.trackData;
}

// =============================================================================
// Streaming Entry Point
// =============================================================================

export async function* streamAnalysis(
  songQuery: string,
  threadId?: string,
): AsyncGenerator<{ type: string; data: unknown }> {
  console.log("\n🚀 [Sonic Agent v2] Starting streaming analysis for:", songQuery);

  const graph = createSonicAgentGraph();
  const configThreadId = threadId || `analysis-${Date.now()}`;

  const stream = await graph.stream(
    { songQuery },
    {
      configurable: { thread_id: configThreadId },
      streamMode: ["updates", "custom"],
    },
  );

  for await (const event of stream) {
    const [mode, chunk] = event as unknown as [string, unknown];
    if (mode === "custom") {
      yield { type: "event", data: chunk };
    } else if (mode === "updates") {
      // Emit node updates
      for (const [nodeName, nodeData] of Object.entries(chunk as Record<string, unknown>)) {
        yield { type: "update", data: { node: nodeName, state: nodeData } };
      }
    }
  }
}

// =============================================================================
// Resume after Human-in-the-loop
// =============================================================================

export async function resumeWithSelection(
  threadId: string,
  selectedTrackId: string,
): Promise<TrackData | null> {
  console.log("\n🔄 [Sonic Agent v2] Resuming with selection:", selectedTrackId);

  const graph = createSonicAgentGraph();

  // Use Command({ resume: ... }) to continue from interrupt with the selected value
  const result = await graph.invoke(new Command({ resume: selectedTrackId }), {
    configurable: { thread_id: threadId },
  });

  if (result.error) {
    console.error("❌ [Sonic Agent] Error:", result.error);
    return null;
  }

  return result.trackData;
}

// =============================================================================
// Exports
// =============================================================================

export type { TrackData, SearchCandidate, SonicAgentStateType };
