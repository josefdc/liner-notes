/**
 * The analysis graph.
 *
 *   scout → [clarification?] → engineer ∥ historian → composer → verifier → END
 *                  ↑
 *            (interrupt if ambiguous)
 *
 * The scout (for a track it selects) and the clarification (for a picked one) end the run with
 * the result stored for that track, when there is one.
 *
 * The engineer and the historian run in parallel and meet at the composer through one
 * list-form edge, so the composer runs once, after both, however many steps either branch
 * takes. The composer hands its draft (or the fallback) to the verifier, which checks every
 * claim, then sends and stores the result: the composer sends none.
 *
 * No node has a retry policy: every node handles its own failures (the scout and the searches
 * retry once or twice themselves, model calls are retried inside the provider layer), so
 * retries never stack and a model call is never repeated by a node retry.
 *
 * The scout, the first node of every run, sets the run id once (the thread id, or a new id
 * from the runtime without a thread): every model call of the run counts under it.
 *
 * Each time a node runs, one log line gives its duration and how it ended (`timed`), under the
 * run's id.
 *
 * `buildSonicAgentGraph` takes the runtime (model layer, clock, ids), the checkpointer and the
 * store, so tests and replays run the same graph on their own dependencies.
 */

import type { BaseCheckpointSaver, BaseStore, LangGraphRunnableConfig } from "@langchain/langgraph";
import { END, isGraphInterrupt, START, StateGraph } from "@langchain/langgraph";
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
import { createVerifierNode, verifierNode } from "./verifier/index.js";
import { currentRunId, currentRunSignal, logger } from "../logger.js";
import { isAbortError } from "./errors.js";

const log = logger("Graph");

// =============================================================================
// Node timings
// =============================================================================

export type NodeName =
  | "scout"
  | "clarification"
  | "engineer"
  | "historian"
  | "composer"
  | "verifier";

/**
 * How a node ended:
 *
 *   ok           it returned, with no `error`
 *   error        it threw, or returned an `error`
 *   interrupted  it paused the run for the user's choice (the time waiting for the choice is not
 *                the node's: the node runs again on resume and logs a line of its own)
 *   cancelled    the run was cancelled (the client left, or its deadline passed), whether the
 *                node then threw or still returned
 *   aborted      stopped without a cancel of the run: LangGraph stops the other nodes of a step
 *                when one fails
 */
export type NodeOutcome = "ok" | "error" | "interrupted" | "cancelled" | "aborted";

type GraphNode<U> = (state: SonicAgentStateType, config: LangGraphRunnableConfig) => Promise<U>;

const elapsedMs = (started: bigint) => Number((process.hrtime.bigint() - started) / 1000n) / 1000;

const reportedError = (update: unknown) =>
  typeof update === "object" && update !== null && Boolean(Reflect.get(update, "error"));

/**
 * `cancelled` when the run's own signal (logger.ts `currentRunSignal`, set by the analyze
 * routes for each run) was aborted; `aborted` when only the node's signal was (LangGraph stops
 * the other nodes of a step when one fails), or the node threw an abort error without a known
 * cancel; else null. A graph run outside the routes has no run signal: a stop there is
 * `aborted`.
 */
function stopOf(config: LangGraphRunnableConfig, error?: unknown): NodeOutcome | null {
  if (currentRunSignal()?.aborted) return "cancelled";
  if (config.signal?.aborted || (error !== undefined && isAbortError(error))) return "aborted";
  return null;
}

/**
 * `node`, logging one line when it ends: `{component: "Graph", node, runId, durationMs,
 * outcome}` at info level. Nothing of the node's input or output is logged. The run id is the
 * one the run's lines carry (logger.ts), else the state's, else the thread's.
 */
function timed<U>(name: NodeName, node: GraphNode<U>): GraphNode<U> {
  return async (state, config) => {
    const started = process.hrtime.bigint();
    let outcome: NodeOutcome = "error";
    let update: U | undefined;
    try {
      update = await node(state, config);
      // A node that ignores its signal still returns after a cancel: the run is over by then.
      outcome = stopOf(config) ?? (reportedError(update) ? "error" : "ok");
      return update;
    } catch (error) {
      outcome = isGraphInterrupt(error) ? "interrupted" : (stopOf(config, error) ?? "error");
      throw error;
    } finally {
      const threadId: unknown = config.configurable?.thread_id;
      const updated: unknown =
        typeof update === "object" && update !== null ? Reflect.get(update, "runId") : undefined;
      const runId =
        currentRunId() ??
        (typeof updated === "string" ? updated : undefined) ??
        state.runId ??
        (typeof threadId === "string" && threadId !== "" ? threadId : undefined);
      const durationMs = elapsedMs(started);
      log.info(`Node ${name}: ${outcome} in ${durationMs} ms`, {
        node: name,
        ...(runId ? { runId } : {}),
        durationMs,
        outcome,
      });
    }
  };
}

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

/** The verifier checks whatever the composer wrote; a composer that wrote nothing ends the run. */
function routeAfterComposer(state: SonicAgentStateType): string {
  return state.draft ? "verifier" : END;
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
  const composer = runtime === defaultAgentRuntime ? composerNode : createComposerNode(runtime);
  const verifier = runtime === defaultAgentRuntime ? verifierNode : createVerifierNode(runtime);
  // Every node is timed (one log line per node run).
  const workflow = new StateGraph(SonicAgentState)
    .addNode(
      "scout",
      timed("scout", async (state, config) => ({
        ...(await scoutNode(state, config, runtime)),
        runId: runIdFor(state, config, runtime),
      })),
    )
    .addNode(
      "clarification",
      timed("clarification", (state, config) => clarificationNode(state, config, runtime)),
    )
    .addNode(
      "engineer",
      timed("engineer", (state, config) => engineerNode(state, config, runtime)),
    )
    .addNode(
      "historian",
      timed("historian", (state, config) => historianNode(state, config, runtime)),
    )
    .addNode("composer", timed("composer", composer))
    .addNode("verifier", timed("verifier", verifier))
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
    .addConditionalEdges("composer", routeAfterComposer, { verifier: "verifier", [END]: END })
    .addEdge("verifier", END);

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
    log.info("Compiled and cached LangGraph workflow");
  }
  return cachedGraph;
}

// =============================================================================
// Exports
// =============================================================================

export type { TrackData, SearchCandidate, SonicAgentStateType };
