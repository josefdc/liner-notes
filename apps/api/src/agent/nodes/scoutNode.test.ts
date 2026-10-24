/**
 * Scout: a cancelled run sends no further Spotify search, cuts its retry wait short and
 * rejects (never reports the cancel as a Spotify error). A stored result is looked up only after
 * the search, by the track it selects, and served only under the key of the sources configured
 * now. Spotify is a real LangChain tool over a stub, so the tool's own handling of the signal is
 * part of the test.
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configuredSources, resultCacheKey, TRACKS_NAMESPACE } from "../cacheKeys.js";
import { SonicAgentState, type SonicAgentStateType } from "../state.js";
import { scoutNode } from "./scoutNode.js";

const track = {
  id: "t1",
  title: "Song",
  artist: "A",
  album: "",
  releaseDate: "",
  coverUrl: "",
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
  // A stored result as the composer writes it: a TrackAnalysis without this run's information,
  // about the track the search finds (t1).
  const { run: _run, ...analysis } = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../../../../packages/contract/fixtures/api-payloads/composed-measured.json",
      ),
      "utf8",
    ),
  );
  const stored = {
    trackData: { ...analysis, id: track.id, title: "Stored" },
    timestamp: Date.now(),
  };
  const keyOf = (id: string) => resultCacheKey(id, configuredSources());

  beforeEach(() => {
    spotify.answer = async () => JSON.stringify([track]);
  });

  it("searches first and serves the result stored for the track it selects", async () => {
    const store = new InMemoryStore();
    await store.put(TRACKS_NAMESPACE, keyOf(track.id), stored);
    const { graph } = scoutGraph(store);

    // The query names the artist, so the one match is selected without asking.
    const out = await graph.invoke({ songQuery: "Song A" });

    expect(spotify.calls).toBe(1);
    expect(out.trackData).toEqual({ ...stored.trackData, queryMatch: "exact" });
    expect(out.selectedTrackId).toBe(track.id);
  });

  it("does not serve a result stored under the search text for a track it no longer finds", async () => {
    const store = new InMemoryStore();
    // What the text found before (another track), stored under the text and under that track.
    const before = { ...stored, trackData: { ...stored.trackData, id: "t0" } };
    await store.put(TRACKS_NAMESPACE, keyOf("song a"), before);
    await store.put(TRACKS_NAMESPACE, keyOf("t0"), before);
    await store.put(["tracks", "v3"], "song a|lastfm=0:tavily=0", before);
    await store.put(["tracks", "v3"], "song a|lastfm=1:tavily=1", before);
    const { graph } = scoutGraph(store);

    const out = await graph.invoke({ songQuery: "Song A" });

    expect(out.trackData ?? null).toBeNull();
    expect(out.spotifyData).toMatchObject({ id: "t1" });
  });

  it("does not serve a result stored under the track's key that is about another track", async () => {
    const store = new InMemoryStore();
    await store.put(TRACKS_NAMESPACE, keyOf(track.id), {
      ...stored,
      trackData: { ...stored.trackData, id: "t0" },
    });
    const { graph } = scoutGraph(store);

    const out = await graph.invoke({ songQuery: "Song A" });

    expect(out.trackData ?? null).toBeNull();
    expect(out.spotifyData).toMatchObject({ id: "t1" });
  });

  it("does not look a result up when the user has to choose", async () => {
    const store = new InMemoryStore();
    await store.put(TRACKS_NAMESPACE, keyOf(track.id), stored);
    const { graph } = scoutGraph(store);

    // A title alone always asks which recording is meant.
    const out = await graph.invoke({ songQuery: "Song" });

    expect(out.trackData ?? null).toBeNull();
    expect(out.candidates?.map((candidate: { id: string }) => candidate.id)).toEqual(["t1"]);
  });

  it("composes again instead of serving a stored result the contract does not accept", async () => {
    const store = new InMemoryStore();
    await store.put(TRACKS_NAMESPACE, keyOf(track.id), {
      ...stored,
      trackData: { id: track.id, title: "Stored, but no artist or genealogy" },
    });
    const { graph } = scoutGraph(store);

    const out = await graph.invoke({ songQuery: "Song A" });

    expect(out.trackData).toBeFalsy();
    expect(out.spotifyData).toMatchObject({ id: "t1" });
    expect(spotify.calls).toBe(1);
  });

  it("does not serve an expired result", async () => {
    const store = new InMemoryStore();
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000 - 1;
    await store.put(TRACKS_NAMESPACE, keyOf(track.id), { ...stored, timestamp: dayAgo });
    const { graph } = scoutGraph(store);

    const out = await graph.invoke({ songQuery: "Song A" });

    expect(out.trackData ?? null).toBeNull();
  });

  it("does not serve a result stored when another set of sources was configured", async () => {
    const store = new InMemoryStore();
    const now = configuredSources();
    await store.put(
      TRACKS_NAMESPACE,
      resultCacheKey(track.id, { ...now, lastfm: !now.lastfm }),
      stored,
    );
    await store.put(TRACKS_NAMESPACE, track.id, stored);
    const { graph } = scoutGraph(store);

    const out = await graph.invoke({ songQuery: "Song A" });

    expect(out.trackData ?? null).toBeNull();
    expect(spotify.calls).toBe(1);
  });
});

describe("scoutNode's track picker", () => {
  // Three songs with the query's title by different artists: the user has to choose.
  const ambiguous = [
    { ...track, id: "a", artist: "A" },
    // A candidate the contract does not accept (the cover URL is a string, empty when unknown).
    { ...track, id: "b", artist: "B", coverUrl: null },
    { ...track, id: "c", artist: "C" },
  ];

  it("leaves out a candidate the contract does not accept and offers the others", async () => {
    spotify.answer = async () => JSON.stringify(ambiguous);
    const { graph } = scoutGraph();

    const out = await graph.invoke({ songQuery: "Song" });

    expect(out.candidates?.map((candidate: { id: string }) => candidate.id)).toEqual(["a", "c"]);
    expect(out.error ?? null).toBeNull();
  });

  it("does not reuse a pick stored for the same text by an earlier version", async () => {
    spotify.answer = async () => JSON.stringify(ambiguous);
    const store = new InMemoryStore();
    // What the clarification node used to save after a pick from the offered rows.
    await store.put(["disambiguation"], "song", { selectedTrackId: "c", candidateIds: "a,c" });
    const { graph } = scoutGraph(store);

    const out = await graph.invoke({ songQuery: "Song" });

    expect(out.selectedTrackId ?? null).toBeNull();
    expect(out.candidates?.map((candidate: { id: string }) => candidate.id)).toEqual(["a", "c"]);
  });

  it("fails the search when no candidate fits the contract", async () => {
    spotify.answer = async () =>
      JSON.stringify(ambiguous.map((candidate) => ({ ...candidate, coverUrl: null })));
    const { graph } = scoutGraph();

    const out = await graph.invoke({ songQuery: "Song" });

    expect(out.candidates ?? null).toBeNull();
    expect(out.error).toBe("No candidate fits the contract");
  });
});
