/**
 * Clarification: a run cancelled after the user picked a track writes no disambiguation
 * memory and does not turn the cancelled track lookup into the candidate fallback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spotify = vi.hoisted(() => ({
  details: vi.fn(async (_input: unknown, _options?: { signal?: AbortSignal }) => "{}"),
}));
vi.mock("../../sources/spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sources/spotify.js")>()),
  getTrackDetails: { invoke: spotify.details },
}));

import {
  Command,
  END,
  InMemoryStore,
  type LangGraphRunnableConfig,
  MemorySaver,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { SonicAgentState, type SonicAgentStateType } from "../state.js";
import { clarificationNode } from "./clarificationNode.js";

const candidates = ["a", "b"].map((id) => ({
  id: `track-${id}`,
  title: `Title ${id}`,
  artist: "Artist",
  album: "Album",
  coverUrl: "",
  popularity: 40,
}));

/**
 * The clarification node alone in a graph, paused at its choice. `onStatus` runs when the node
 * reports the user's choice (before it writes the memory).
 */
async function pausedAtChoice(onStatus: () => void) {
  const store = new InMemoryStore();
  const node = { settled: "pending", update: null as unknown };
  const graph = new StateGraph(SonicAgentState)
    .addNode(
      "clarification",
      async (state: SonicAgentStateType, config: LangGraphRunnableConfig) => {
        try {
          node.update = await clarificationNode(state, { ...config, writer: onStatus });
          node.settled = "resolved";
          return node.update as Partial<SonicAgentStateType>;
        } catch (error) {
          node.settled = "rejected";
          throw error;
        }
      },
    )
    .addEdge(START, "clarification")
    .addEdge("clarification", END)
    .compile({ checkpointer: new MemorySaver(), store });
  const thread = { configurable: { thread_id: "t" } };
  await graph.invoke({ songQuery: "song", candidates }, thread);
  return { graph, store, node, thread };
}

beforeEach(() => {
  spotify.details.mockReset();
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("clarificationNode when the run is cancelled", () => {
  it("writes no disambiguation memory once the run was cancelled", async () => {
    const controller = new AbortController();
    const { graph, store, thread } = await pausedAtChoice(() => controller.abort());

    await expect(
      graph.invoke(new Command({ resume: "track-b" }), { ...thread, signal: controller.signal }),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await store.get(["disambiguation"], "song")).toBeNull();
    expect(spotify.details).not.toHaveBeenCalled();
  });

  it("rejects instead of falling back to the candidate when the track lookup is cancelled", async () => {
    const controller = new AbortController();
    const { graph, node, thread } = await pausedAtChoice(() => {});
    spotify.details.mockImplementation(async (_input, options) => {
      controller.abort();
      options?.signal?.throwIfAborted();
      return "{}";
    });

    await expect(
      graph.invoke(new Command({ resume: "track-b" }), { ...thread, signal: controller.signal }),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spotify.details).toHaveBeenCalledWith(
      { trackId: "track-b" },
      { signal: expect.any(AbortSignal) },
    );
    expect(node.settled).toBe("rejected");
  });
});
