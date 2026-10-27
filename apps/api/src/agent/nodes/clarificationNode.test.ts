/**
 * Clarification: a pick is not remembered for the query's text; a run cancelled after the user
 * picked a track does not turn the cancelled track lookup into the candidate fallback. The
 * candidate fallback keeps the separate artists and their Spotify ids. A result stored for the
 * picked track (and only for it) is served.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spotify = vi.hoisted(() => ({
  details: vi.fn(async (_trackId: string, _signal?: AbortSignal): Promise<unknown> => ({})),
}));
vi.mock("../../sources/spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sources/spotify.js")>()),
  fetchTrack: spotify.details,
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
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SourceError } from "../../sources/http.js";
import { configuredSources, resultCacheKey, TRACKS_NAMESPACE } from "../cacheKeys.js";
import { SonicAgentState, type SonicAgentStateType } from "../state.js";
import { clarificationNode } from "./clarificationNode.js";

/** Spotify failing to answer the details request. */
const UNAVAILABLE = new SourceError("spotify", "http", "HTTP 503", { status: 503 });

const candidates = ["a", "b"].map((id) => ({
  id: `track-${id}`,
  title: `Title ${id}`,
  artist: "Ramsey Lewis, Earth, Wind & Fire",
  artistNames: ["Ramsey Lewis", "Earth, Wind & Fire"],
  artistIds: ["1".repeat(22), "2".repeat(22)],
  album: "Album",
  coverUrl: "",
}));

/**
 * The clarification node alone in a graph, paused at its choice. `onStatus` runs when the node
 * reports the user's choice (before it writes the memory).
 */
async function pausedAtChoice(
  onStatus: (event?: unknown) => void,
  store = new InMemoryStore(),
  offered: SonicAgentStateType["candidates"] = candidates,
) {
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
  await graph.invoke({ songQuery: "song", candidates: offered }, thread);
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
  it("looks nothing up and remembers nothing once the run was cancelled", async () => {
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
    spotify.details.mockImplementation(async (_trackId, signal) => {
      controller.abort();
      signal?.throwIfAborted();
      return {};
    });

    await expect(
      graph.invoke(new Command({ resume: "track-b" }), { ...thread, signal: controller.signal }),
    ).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(spotify.details).toHaveBeenCalledWith("track-b", expect.any(AbortSignal));
    expect(node.settled).toBe("rejected");
  });
});

describe("clarificationNode's candidate fallback", () => {
  it("keeps the candidate's separate artists and Spotify ids", async () => {
    const { graph, node, thread } = await pausedAtChoice(() => {});
    spotify.details.mockRejectedValue(UNAVAILABLE);

    await graph.invoke(new Command({ resume: "track-b" }), thread);

    const update = node.update as Partial<SonicAgentStateType>;
    expect(update.spotifyData).toMatchObject({
      artist: "Ramsey Lewis, Earth, Wind & Fire",
      artistNames: ["Ramsey Lewis", "Earth, Wind & Fire"],
      artistIds: ["1".repeat(22), "2".repeat(22)],
    });
  });
});

describe("clarificationNode's chosen track", () => {
  it("records the ISRC of the chosen track and how it matches the query", async () => {
    const { graph, node, thread } = await pausedAtChoice(() => {});
    spotify.details.mockResolvedValue({
      id: "track-b",
      title: "Song",
      artist: "Ramsey Lewis, Earth, Wind & Fire",
      artistNames: ["Ramsey Lewis", "Earth, Wind & Fire"],
      artistIds: [],
      album: "Album",
      releaseDate: "1974",
      coverUrl: "",
      isrc: "USSM17400001",
      duration: "3:00",
      durationMs: 180_000,
      explicit: false,
      spotifyUrl: "https://open.spotify.com/track/track-b",
      previewUrl: null,
    });

    await graph.invoke(new Command({ resume: "track-b" }), thread);

    const update = node.update as Partial<SonicAgentStateType>;
    expect(update.isrc).toBe("USSM17400001");
    expect(update.queryMatch).toBe("exact");
  });

  it("records how a picked track that only partly matches the query matches it", async () => {
    const { graph, node, thread } = await pausedAtChoice(() => {});
    spotify.details.mockResolvedValue({
      id: "track-b",
      title: "Another Song",
      artist: "Ramsey Lewis",
      artistNames: ["Ramsey Lewis"],
      artistIds: [],
      album: "Album",
      releaseDate: "1974",
      coverUrl: "",
      isrc: null,
      duration: "3:00",
      durationMs: 180_000,
      explicit: false,
      spotifyUrl: "https://open.spotify.com/track/track-b",
      previewUrl: null,
    });

    await graph.invoke(new Command({ resume: "track-b" }), thread);

    const update = node.update as Partial<SonicAgentStateType>;
    expect(update.queryMatch).toBe("partial");
    expect(update.selectedBy).toBe("user");
  });

  it("remembers no pick for the query's text", async () => {
    const { graph, store, thread } = await pausedAtChoice(() => {});
    spotify.details.mockRejectedValue(UNAVAILABLE);

    await graph.invoke(new Command({ resume: "track-b" }), thread);

    expect(await store.search(["disambiguation"])).toEqual([]);
  });

  it("invents no ISRC or popularity when it falls back to the candidate", async () => {
    const { graph, node, thread } = await pausedAtChoice(() => {});
    spotify.details.mockRejectedValue(UNAVAILABLE);

    await graph.invoke(new Command({ resume: "track-b" }), thread);

    const update = node.update as Partial<SonicAgentStateType>;
    expect(update.spotifyData).not.toHaveProperty("popularity");
    expect(update.spotifyData?.isrc ?? null).toBeNull();
    expect(update.isrc ?? null).toBeNull();
  });
  it("keeps the ISRC and release date Spotify's search gave the candidate it falls back to", async () => {
    const dated = candidates.map((candidate) =>
      candidate.id === "track-b"
        ? { ...candidate, isrc: "USSM17400001", releaseDate: "1974-11", releaseYear: "1974" }
        : candidate,
    );
    const { graph, node, thread } = await pausedAtChoice(() => {}, new InMemoryStore(), dated);
    spotify.details.mockRejectedValue(UNAVAILABLE);

    await graph.invoke(new Command({ resume: "track-b" }), thread);

    const update = node.update as Partial<SonicAgentStateType>;
    expect(update.spotifyData).toMatchObject({ isrc: "USSM17400001", releaseDate: "1974-11" });
    expect(update.isrc).toBe("USSM17400001");
  });
});

describe("clarificationNode when the track details cannot be read", () => {
  it.each([
    [
      new SourceError("spotify", "rate_limited", "HTTP 429", { retryAfterMs: 5000 }),
      "rate_limited",
    ],
    [new SourceError("spotify", "timeout", "deadline reached"), "timeout"],
    [new SourceError("spotify", "parse", "track response has no id"), "invalid_response"],
    [new SourceError("spotify", "http", "HTTP 503", { status: 503 }), "unavailable"],
  ])("records Spotify's typed error (%s), so the result is not stored", async (error, code) => {
    const { graph, node, thread } = await pausedAtChoice(() => {});
    spotify.details.mockRejectedValue(error);

    await graph.invoke(new Command({ resume: "track-b" }), thread);

    const update = node.update as Partial<SonicAgentStateType>;
    expect(update.spotifyData).toMatchObject({ id: "track-b", durationMs: 0, isrc: null });
    expect(update.sourceErrors).toEqual([expect.objectContaining({ source: "spotify", code })]);
  });

  it("records no source error when the details were read", async () => {
    const { graph, node, thread } = await pausedAtChoice(() => {});
    spotify.details.mockResolvedValue({
      id: "track-b",
      title: "Song",
      artist: "A",
      artistIds: [],
      durationMs: 1,
    });

    await graph.invoke(new Command({ resume: "track-b" }), thread);

    expect((node.update as Partial<SonicAgentStateType>).sourceErrors).toBeUndefined();
  });
});

describe("clarificationNode's stored results", () => {
  const { run: _run, ...analysis } = JSON.parse(
    readFileSync(
      join(
        import.meta.dirname,
        "../../../../../packages/contract/fixtures/api-payloads/composed-measured.json",
      ),
      "utf8",
    ),
  );
  const storedFor = (id: string) => ({
    trackData: { ...analysis, id, title: "Title b", artist: "Ramsey Lewis" },
    timestamp: Date.now(),
  });
  const keyOf = (id: string) => resultCacheKey(id, configuredSources());

  it("serves the result stored for the picked track, with how the query matches it", async () => {
    const store = new InMemoryStore();
    await store.put(TRACKS_NAMESPACE, keyOf("track-b"), storedFor("track-b"));
    const events: unknown[] = [];
    const { graph, node, thread } = await pausedAtChoice((event) => events.push(event), store);
    spotify.details.mockRejectedValue(UNAVAILABLE);

    await graph.invoke(new Command({ resume: "track-b" }), thread);

    const update = node.update as Partial<SonicAgentStateType>;
    expect(update.trackData).toMatchObject({ id: "track-b", queryMatch: "none" });
    expect(update.selectedBy).toBe("user");
    expect(events).toContainEqual({ type: "complete", data: update.trackData });
  });

  it("reports again the sources its stored result could not read", async () => {
    const lasting = {
      source: "secondhandsongs",
      code: "invalid_response",
      message: "unexpected answer: work 4196 has no versions list",
    };
    const store = new InMemoryStore();
    await store.put(TRACKS_NAMESPACE, keyOf("track-b"), {
      ...storedFor("track-b"),
      sourceErrors: [lasting],
    });
    const events: Array<{ type?: string; message?: string; code?: string }> = [];
    const { graph, node, thread } = await pausedAtChoice(
      (event) => events.push(event as never),
      store,
    );
    spotify.details.mockRejectedValue(UNAVAILABLE);

    await graph.invoke(new Command({ resume: "track-b" }), thread);

    const update = node.update as Partial<SonicAgentStateType>;
    expect(update.trackData).toMatchObject({ id: "track-b" });
    expect(update.sourceErrors).toEqual(expect.arrayContaining([lasting]));
    const line = "Stored analysis: SecondHandSongs answered in a form the reader does not know";
    expect(update.statusMessages).toContain(line);
    const warned = events.findIndex((e) => e.code === "SYS-WARN" && e.message === line);
    expect(warned).toBeGreaterThan(-1);
    expect(warned).toBeLessThan(events.findIndex((e) => e.type === "complete"));
  });

  it("does not serve a result stored for another candidate", async () => {
    const store = new InMemoryStore();
    await store.put(TRACKS_NAMESPACE, keyOf("track-a"), storedFor("track-a"));
    const { graph, node, thread } = await pausedAtChoice(() => {}, store);
    spotify.details.mockRejectedValue(UNAVAILABLE);

    await graph.invoke(new Command({ resume: "track-b" }), thread);

    const update = node.update as Partial<SonicAgentStateType>;
    expect(update.trackData ?? null).toBeNull();
    expect(update.selectedTrackId).toBe("track-b");
  });
});

describe("clarificationNode's record of how the track was picked", () => {
  it.each([
    [{ trackId: "track-b", pickedBy: "click" }, "click"],
    [{ trackId: "track-b", pickedBy: "countdown" }, "countdown"],
    [{ trackId: "track-b", pickedBy: "magic" }, null],
    ["track-b", null],
  ])("records %j as picked by %s", async (resume, pickedBy) => {
    const { graph, node, thread } = await pausedAtChoice(() => {});
    spotify.details.mockRejectedValue(UNAVAILABLE);

    await graph.invoke(new Command({ resume }), thread);

    const update = node.update as Partial<SonicAgentStateType>;
    expect(update.selectedTrackId).toBe("track-b");
    expect(update.pickedBy).toBe(pickedBy);
  });

  it.each([
    ["click", "no search match", undefined],
    ["countdown", "its search match", "none"],
  ])("serves a stored result picked by %s with %s", async (pickedBy, _outcome, shown) => {
    const store = new InMemoryStore();
    const { run: _run, ...analysis } = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "../../../../../packages/contract/fixtures/api-payloads/composed-measured.json",
        ),
        "utf8",
      ),
    );
    await store.put(TRACKS_NAMESPACE, resultCacheKey("track-b", configuredSources()), {
      trackData: { ...analysis, id: "track-b", title: "Title b", artist: "Ramsey Lewis" },
      timestamp: Date.now(),
    });
    const { graph, node, thread } = await pausedAtChoice(() => {}, store);
    spotify.details.mockRejectedValue(UNAVAILABLE);

    await graph.invoke(new Command({ resume: { trackId: "track-b", pickedBy } }), thread);

    const update = node.update as Partial<SonicAgentStateType>;
    expect(update.trackData).toMatchObject({ id: "track-b" });
    expect(update.trackData?.queryMatch).toBe(shown);
  });
});
