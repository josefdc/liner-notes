/**
 * Scout: a cancelled run sends no further Spotify search, cuts its retry wait short and
 * rejects (never reports the cancel as a Spotify error). A stored result is served only under
 * the key of the sources configured now. Spotify is a real LangChain tool over a
 * stub, so the tool's own handling of the signal is part of the test.
 */

import { tool } from "@langchain/core/tools";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const spotify = vi.hoisted(() => ({
  calls: 0,
  /** What the search does on each call. */
  answer: (async () => "[]") as (signal: AbortSignal | undefined) => Promise<string>,
}));
vi.mock("../../sources/spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sources/spotify.js")>()),
  searchMultipleTracks: tool(
    async (_input, config) => {
      spotify.calls++;
      return spotify.answer(config?.signal);
    },
    {
      name: "search_multiple_tracks",
      description: "stub",
      schema: z.object({ query: z.string(), limit: z.number() }),
    },
  ),
}));

import {
  END,
  InMemoryStore,
  type LangGraphRunnableConfig,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { configuredSources, resultCacheKey, TRACKS_NAMESPACE } from "../cacheKeys.js";
import { SonicAgentState, type SonicAgentStateType } from "../state.js";
import { scoutNode } from "./scoutNode.js";

const track = {
  id: "t1",
  title: "T",
  artist: "A",
  album: "",
  releaseDate: "",
  coverUrl: "",
  popularity: 90,
  duration: "",
  durationMs: 1,
  explicit: false,
  spotifyUrl: "",
  previewUrl: null,
  artistIds: [],
};

/** The scout alone in a graph; reports how the node itself settled. */
function scoutGraph(store = new InMemoryStore()) {
  const node = { settled: "pending" };
  const graph = new StateGraph(SonicAgentState)
    .addNode("scout", async (state: SonicAgentStateType, config: LangGraphRunnableConfig) => {
      try {
        const out = await scoutNode(state, config);
        node.settled = "resolved";
        return out;
      } catch (error) {
        node.settled = `rejected:${(error as Error).name}`;
        throw error;
      }
    })
    .addEdge(START, "scout")
    .addEdge("scout", END)
    .compile({ store });
  return { graph, node };
}

beforeEach(() => {
  spotify.calls = 0;
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("scoutNode when the run is cancelled", () => {
  it("cuts its retry wait short and sends no second search", async () => {
    // The first search is rate limited: the scout waits about 1 s before trying again.
    spotify.answer = async () =>
      spotify.calls === 1 ? "Error: Rate limited by Spotify (429)" : JSON.stringify([track]);
    const { graph, node } = scoutGraph();
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const started = Date.now();
    await expect(graph.invoke({ songQuery: "x" }, { signal: controller.signal })).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(node.settled).toMatch(/^rejected/);
    expect(Date.now() - started).toBeLessThan(800);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(spotify.calls).toBe(1);
  });

  it("rejects instead of reporting a cancelled search as a Spotify error", async () => {
    const controller = new AbortController();
    // The run is cancelled while the search runs; the search rejects with the cancel.
    spotify.answer = async (signal) => {
      controller.abort();
      signal?.throwIfAborted();
      return "[]";
    };
    const { graph, node } = scoutGraph();

    await expect(graph.invoke({ songQuery: "x" }, { signal: controller.signal })).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(node.settled).toMatch(/^rejected/);
  });
});

describe("scoutNode's stored results", () => {
  const stored = { trackData: { title: "Stored" }, timestamp: Date.now() };

  it("serves a result stored for the sources configured now", async () => {
    const store = new InMemoryStore();
    await store.put(TRACKS_NAMESPACE, resultCacheKey("song", configuredSources()), stored);
    const { graph } = scoutGraph(store);

    const out = await graph.invoke({ songQuery: "Song" });

    expect(out.trackData).toEqual({ title: "Stored" });
    expect(spotify.calls).toBe(0);
  });

  it("does not serve a result stored when another set of sources was configured", async () => {
    const store = new InMemoryStore();
    const now = configuredSources();
    await store.put(
      TRACKS_NAMESPACE,
      resultCacheKey("song", { ...now, lastfm: !now.lastfm }),
      stored,
    );
    await store.put(TRACKS_NAMESPACE, "song", stored);
    spotify.answer = async () => "[]";
    const { graph } = scoutGraph(store);

    const out = await graph.invoke({ songQuery: "Song" });

    expect(out.trackData ?? null).toBeNull();
    expect(spotify.calls).toBeGreaterThan(0);
  });
});
