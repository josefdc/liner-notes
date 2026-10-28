/**
 * Scout: a cancelled run sends no further Spotify search, cuts its retry wait short and
 * rejects (never reports the cancel as a Spotify error). A rate limit's Retry-After is waited out
 * when it is short, and a longer one ends the search at once. Why no track was found is a type.
 * A request by track id reads that track instead of searching. A stored result is looked up only
 * after the search, by the track it selects, and served only under the key of the sources
 * configured now. The Spotify client is a stub that answers with tracks or throws its typed
 * errors.
 */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const spotify = vi.hoisted(() => ({
  calls: 0,
  /** When each search call started (ms). */
  startedAt: [] as number[],
  /** What the search does on each call: tracks as JSON, or a throw. */
  answer: (async () => "[]") as (signal: AbortSignal | undefined) => Promise<string>,
  /** The track ids read by id. */
  fetched: [] as string[],
  /** What reading a track by id does. */
  track: (async () => {
    throw new Error("no track stub");
  }) as (trackId: string, signal: AbortSignal | undefined) => Promise<unknown>,
}));
vi.mock("../../sources/spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sources/spotify.js")>()),
  searchTracks: async (_query: string, _limit: number, signal?: AbortSignal) => {
    spotify.calls++;
    spotify.startedAt.push(Date.now());
    return JSON.parse(await spotify.answer(signal));
  },
  fetchTrack: async (trackId: string, signal?: AbortSignal) => {
    spotify.fetched.push(trackId);
    return spotify.track(trackId, signal);
  },
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
import { SourceError } from "../../sources/http.js";
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
  spotify.startedAt = [];
  spotify.fetched = [];
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  // Also when a test on the fake clock timed out before its helper could restore the timers.
  vi.useRealTimers();
});

/**
 * Runs the graph run that `start` begins on a fake clock (setTimeout, clearTimeout and the
 * whole Date), moving it 100 ms a step until the run settles. Its waits take no real time and
 * their lengths are exact, however busy the machine is: timers fire at their own time on the
 * clock. Returns what the run resolved to and how long it took on the clock, from start to
 * settle.
 */
async function onFakeClock<T>(start: () => Promise<T>): Promise<{ out: T; elapsed: number }> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  let finished = false;
  onTestFinished(() => {
    finished = true;
  });
  try {
    const started = Date.now();
    let settledAt: number | undefined;
    const run = start().finally(() => {
      settledAt = Date.now();
    });
    run.catch(() => {});
    // Stops once its test has ended (a timeout included): the clock may be the next test's.
    for (let step = 0; step < 2000 && settledAt === undefined && !finished; step++) {
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(
      settledAt,
      "the run settles within 200 s on the fake clock (a wait not on setTimeout never would)",
    ).toBeDefined();
    return { out: await run, elapsed: (settledAt as number) - started };
  } finally {
    // After its test has ended the timers are the next test's to keep or restore.
    if (!finished) vi.useRealTimers();
  }
}

/**
 * Runs `run` (inside onFakeClock's `start`) with setTimeout watched, and adds the delay of each
 * timer set meanwhile to `delays`. The fake setTimeout is back in place before onFakeClock
 * restores the real timers.
 */
async function recordingTimers<T>(run: () => Promise<T>, delays: number[]): Promise<T> {
  const fakeSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((handler: () => void, ms?: number) => {
    delays.push(ms ?? 0);
    return fakeSetTimeout(handler, ms);
  }) as typeof setTimeout;
  try {
    return await run();
  } finally {
    globalThis.setTimeout = fakeSetTimeout;
  }
}

describe("scoutNode when the run is cancelled", () => {
  it("cuts its retry wait short and sends no second search", async () => {
    // The first search is rate limited: the scout waits about 1 s before trying again.
    spotify.answer = async () => {
      if (spotify.calls === 1) throw new SourceError("spotify", "rate_limited", "HTTP 429");
      return JSON.stringify([track]);
    };
    const { graph, node } = scoutGraph();
    const controller = new AbortController();

    const { out } = await onFakeClock(async () => {
      setTimeout(() => controller.abort(), 50);
      const run = graph.invoke({ songQuery: "x" }, { signal: controller.signal });
      const rejected = await run.then(
        () => false,
        () => true,
      );
      // How the node itself settled 100 ms after the cancel, well inside its 1 s backoff.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const settled = node.settled;
      // Past the end of the backoff (1 s and up to a tenth more), had the wait not been cut.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return { rejected, settled };
    });

    expect(out.rejected).toBe(true);
    expect(out.settled).toMatch(/^rejected/);
    expect(spotify.calls).toBe(1);
  });

  it("cuts a Retry-After wait short and sends no second search", async () => {
    // The first search is rate limited and asks for 5 s: the scout waits that out.
    spotify.answer = async () => {
      if (spotify.calls === 1) {
        throw new SourceError("spotify", "rate_limited", "HTTP 429", { retryAfterMs: 5000 });
      }
      return JSON.stringify([track]);
    };
    const { graph, node } = scoutGraph();
    const controller = new AbortController();

    const { out } = await onFakeClock(async () => {
      setTimeout(() => controller.abort(), 50);
      const rejected = await graph.invoke({ songQuery: "x" }, { signal: controller.signal }).then(
        () => false,
        () => true,
      );
      // How the node itself settled 100 ms after the cancel, well inside the 5 s asked for.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const settled = node.settled;
      // Past the end of the 5 s, had the wait not been cut.
      await new Promise((resolve) => setTimeout(resolve, 6000));
      return { rejected, settled };
    });

    expect(out.rejected).toBe(true);
    expect(out.settled).toMatch(/^rejected/);
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

  it("does not serve a result stored before results carried their audio measurement", async () => {
    const store = new InMemoryStore();
    // A v5 result: measured copies without the block they come from.
    const { audio: _audio, ...withoutBlock } = stored.trackData;
    await store.put(["tracks", "v5"], keyOf(track.id), { ...stored, trackData: withoutBlock });
    const { graph } = scoutGraph(store);

    const out = await graph.invoke({ songQuery: "Song A" });

    expect(TRACKS_NAMESPACE).toEqual(["tracks", "v9"]);
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

  it("composes again instead of serving a stored result with a page the web tier now leaves out", async () => {
    const webItem = (url: string, excerpt: string) => ({
      id: `tavily:${url}`,
      source: "tavily",
      sourceTier: "web",
      url,
      title: "A page",
      retrievedAt: "2026-10-20T12:00:00.000Z",
      excerpt,
      recordRef: null,
    });
    for (const item of [
      webItem("https://www.instagram.com/p/abc123/", "A caption about the song."),
      webItem("https://example.org/post", "some_one's profile picture some_one 2w Love it"),
    ]) {
      const store = new InMemoryStore();
      await store.put(TRACKS_NAMESPACE, keyOf(track.id), {
        ...stored,
        trackData: { ...stored.trackData, evidence: [item] },
      });
      const { graph } = scoutGraph(store);

      const out = await graph.invoke({ songQuery: "Song A" });

      expect(out.trackData ?? null, item.url).toBeNull();
      expect(out.spotifyData).toMatchObject({ id: "t1" });
    }
    // A page the web tier keeps is served.
    const store = new InMemoryStore();
    const kept = webItem("https://www.youtube.com/watch?v=abc", "The official video.");
    await store.put(TRACKS_NAMESPACE, keyOf(track.id), {
      ...stored,
      trackData: { ...stored.trackData, evidence: [kept] },
    });
    const out = await scoutGraph(store).graph.invoke({ songQuery: "Song A" });
    expect(out.trackData).toMatchObject({ id: track.id, evidence: [kept] });
  });

  it("composes again instead of serving a stored result whose source errors hold markup", async () => {
    for (const message of [
      'secondhandsongs: HTTP 403 — <!DOCTYPE html><html lang="en-US">',
      "secondhandsongs: HTTP 403 — &lt;!DOCTYPE html&gt;",
    ]) {
      const store = new InMemoryStore();
      await store.put(TRACKS_NAMESPACE, keyOf(track.id), {
        ...stored,
        sourceErrors: [{ source: "secondhandsongs", code: "invalid_response", message }],
      });
      const { graph } = scoutGraph(store);

      const out = await graph.invoke({ songQuery: "Song A" });

      expect(out.trackData ?? null, message).toBeNull();
    }
    // A plain message is served with the result.
    const store = new InMemoryStore();
    const plain = {
      source: "secondhandsongs",
      code: "invalid_response",
      message: "secondhandsongs: unexpected answer: a work",
    };
    await store.put(TRACKS_NAMESPACE, keyOf(track.id), { ...stored, sourceErrors: [plain] });
    const out = await scoutGraph(store).graph.invoke({ songQuery: "Song A" });
    expect(out.trackData).toMatchObject({ id: track.id });
    expect(out.sourceErrors).toEqual([plain]);
  });

  it("says a served result is provisional when its notes were not checked", async () => {
    const store = new InMemoryStore();
    await store.put(TRACKS_NAMESPACE, keyOf(track.id), {
      ...stored,
      ttlMs: 60 * 60 * 1000,
      verifier: { judged: 0, unjudged: 3, failed: true },
    });

    const out = await scoutGraph(store).graph.invoke({ songQuery: "Song A" });

    expect(out.trackData).toMatchObject({ id: track.id });
    expect(out.statusMessages).toContain(
      "Stored analysis: the notes were not checked against their sources; they are shown as model inference",
    );
    // A checked result says nothing of the kind.
    const checked = new InMemoryStore();
    await checked.put(TRACKS_NAMESPACE, keyOf(track.id), stored);
    const plain = await scoutGraph(checked).graph.invoke({ songQuery: "Song A" });
    expect(plain.statusMessages.join(" ")).not.toMatch(/not checked/);
  });

  it("serves this run's search match, never one stored with the result", async () => {
    const store = new InMemoryStore();
    await store.put(TRACKS_NAMESPACE, keyOf(track.id), {
      ...stored,
      trackData: { ...stored.trackData, queryMatch: "none" },
    });
    const { graph } = scoutGraph(store);

    const out = await graph.invoke({ songQuery: "Song A" });

    expect(out.trackData).toMatchObject({ id: track.id, queryMatch: "exact" });
  });

  it("serves the contract's reading of a stored result", async () => {
    const store = new InMemoryStore();
    await store.put(TRACKS_NAMESPACE, keyOf(track.id), {
      ...stored,
      trackData: { ...stored.trackData, preview: { weird: 1 }, songQuery: "someone's text" },
    });
    const { graph } = scoutGraph(store);

    const out = await graph.invoke({ songQuery: "Song A" });

    expect(out.trackData).toMatchObject({ id: track.id, preview: null });
    expect(out.trackData).not.toHaveProperty("songQuery");
  });

  it("does not serve a result dated ahead of the clock", async () => {
    const store = new InMemoryStore();
    const yearAhead = Date.now() + 365 * 24 * 60 * 60 * 1000;
    await store.put(TRACKS_NAMESPACE, keyOf(track.id), { ...stored, timestamp: yearAhead });
    const { graph } = scoutGraph(store);

    const out = await graph.invoke({ songQuery: "Song A" });

    expect(out.trackData ?? null).toBeNull();
  });

  it("does not serve an expired result", async () => {
    const store = new InMemoryStore();
    const dayAgo = Date.now() - 24 * 60 * 60 * 1000 - 1;
    await store.put(TRACKS_NAMESPACE, keyOf(track.id), { ...stored, timestamp: dayAgo });
    const { graph } = scoutGraph(store);

    const out = await graph.invoke({ songQuery: "Song A" });

    expect(out.trackData ?? null).toBeNull();
  });

  it("does not serve a result stored by the code before genealogy ids were strict", async () => {
    const store = new InMemoryStore();
    await store.put(["tracks", "v4"], keyOf(track.id), stored);
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

  it("does not serve a result stored before a primary source's credential was set", async () => {
    const before = configuredSources();
    for (const [variable, flag] of [
      ["DISCOGS_TOKEN", "discogs"],
      ["GENIUS_ACCESS_TOKEN", "genius"],
    ] as const) {
      const saved = process.env[variable];
      delete process.env[variable];
      try {
        const store = new InMemoryStore();
        const without = configuredSources();
        expect(without[flag]).toBe(false);
        await store.put(TRACKS_NAMESPACE, resultCacheKey(track.id, without), stored);
        process.env[variable] = "a-test-credential";
        expect(configuredSources()[flag]).toBe(true);
        expect(resultCacheKey(track.id, configuredSources())).not.toBe(
          resultCacheKey(track.id, without),
        );
        const { graph } = scoutGraph(store);

        const out = await graph.invoke({ songQuery: "Song A" });

        expect(out.trackData ?? null, variable).toBeNull();
      } finally {
        if (saved === undefined) delete process.env[variable];
        else process.env[variable] = saved;
      }
    }
    expect(configuredSources()).toEqual(before);
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

  it("counts the candidates it offers, not the results Spotify returned", async () => {
    const ten = "abcdefghij".split("").map((id) => ({ ...track, id, artist: id.toUpperCase() }));
    spotify.answer = async () => JSON.stringify(ten);
    const { graph } = scoutGraph();

    const messages: string[] = [];
    let state: { candidates?: unknown[]; statusMessages?: string[] } = {};
    const stream = await graph.stream({ songQuery: "Song" }, { streamMode: ["custom", "values"] });
    for await (const [mode, data] of stream as AsyncIterable<[string, Record<string, unknown>]>) {
      if (mode === "custom") messages.push(String(data.message));
      else state = data;
    }

    // Spotify returned ten; five are offered, and the lines say five, from Spotify.
    expect(state.candidates).toHaveLength(5);
    expect(messages).toEqual(["Searching Spotify", "5 possible tracks from Spotify; choose one"]);
    expect(state.statusMessages).toEqual(["5 possible tracks from Spotify; choose one"]);
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

describe("scoutNode's Spotify failures", () => {
  it("waits out a short Retry-After, then searches again", async () => {
    spotify.answer = async () => {
      if (spotify.calls === 1) {
        throw new SourceError("spotify", "rate_limited", "HTTP 429", { retryAfterMs: 250 });
      }
      return JSON.stringify([track]);
    };
    const { graph } = scoutGraph();

    const { out } = await onFakeClock(() => graph.invoke({ songQuery: "Song A" }));

    expect(spotify.calls).toBe(2);
    // The 250 ms asked for, no less and not the 1 s backoff used when the source says nothing.
    expect(spotify.startedAt[1] - spotify.startedAt[0]).toBe(250);
    expect(out.spotifyData).toMatchObject({ id: "t1" });
  });

  it("does not wait out a Retry-After longer than its limit, and says it was rate limited", async () => {
    spotify.answer = async () => {
      throw new SourceError("spotify", "rate_limited", "HTTP 429", { retryAfterMs: 60_000 });
    };
    const { graph } = scoutGraph();

    const delays: number[] = [];
    const { out, elapsed } = await onFakeClock(() =>
      recordingTimers(() => graph.invoke({ songQuery: "Song A" }), delays),
    );

    // Gives up at once, not after any wait (the 60 s asked for, or the 1 s backoff): it sets no
    // timer for a wait (the store's batching polls with zero-delay ones). The run waits for no
    // timer, so no time passes on the clock; the bound on it is the shortest wrong wait.
    expect(delays.filter((ms) => ms >= 100)).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
    expect(spotify.calls).toBe(1);
    expect(out.scoutFailure).toEqual({ kind: "rate_limited", retryAfterMs: 60_000 });
  });

  it("tries a Spotify outage 3 times, saying each wait, then says Spotify could not answer", async () => {
    spotify.answer = async () => {
      throw new SourceError("spotify", "http", "HTTP 503", { status: 503 });
    };
    // The backoff's random part is half its most: a tenth of the wait, times 0.5.
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const statuses: string[] = [];
    const saidAt: number[] = [];
    const { graph } = scoutGraph();

    const { out } = await onFakeClock(() =>
      graph.invoke({ songQuery: "Song A" }, {
        streamMode: "values",
        // The writer the scout reports progress through.
        writer: (event: { type?: string; message?: string }) => {
          if (event.type !== "status" || !event.message) return;
          statuses.push(event.message);
          if (event.message.startsWith("Spotify did not answer")) saidAt.push(Date.now());
        },
      } as never),
    );

    expect(spotify.calls).toBe(3);
    // The 1 s, then 2 s backoff, each with a twentieth more (the random part above).
    const waits = [1, 2].map((i) => spotify.startedAt[i] - spotify.startedAt[i - 1]);
    expect(waits).toEqual([1050, 2100]);
    expect(out.scoutFailure).toEqual({ kind: "upstream_unavailable" });
    expect(statuses.filter((m) => m.startsWith("Spotify did not answer"))).toEqual([
      "Spotify did not answer; trying again in 1 s",
      "Spotify did not answer; trying again in 2 s",
    ]);
    // Each wait is said when the attempt before it fails, before the wait, not after it.
    expect(saidAt).toEqual([spotify.startedAt[0], spotify.startedAt[1]]);
  });

  it("waits out a Retry-After of exactly its 10 s limit", async () => {
    spotify.answer = async () => {
      if (spotify.calls === 1) {
        throw new SourceError("spotify", "rate_limited", "HTTP 429", { retryAfterMs: 10_000 });
      }
      return JSON.stringify([track]);
    };
    const { graph } = scoutGraph();

    const { out } = await onFakeClock(() => graph.invoke({ songQuery: "Song A" }));

    expect(spotify.calls).toBe(2);
    expect(spotify.startedAt[1] - spotify.startedAt[0]).toBe(10_000);
    expect(out.spotifyData).toMatchObject({ id: "t1" });
  });

  it("does not wait out a Retry-After just over its 10 s limit", async () => {
    spotify.answer = async () => {
      throw new SourceError("spotify", "rate_limited", "HTTP 429", { retryAfterMs: 10_001 });
    };
    const { graph } = scoutGraph();

    const delays: number[] = [];
    const { out, elapsed } = await onFakeClock(() =>
      recordingTimers(() => graph.invoke({ songQuery: "Song A" }), delays),
    );

    // At once, not after the 10 s asked for or the 1 s backoff (as above).
    expect(delays.filter((ms) => ms >= 100)).toEqual([]);
    expect(elapsed).toBeLessThan(1000);
    expect(spotify.calls).toBe(1);
    expect(out.scoutFailure).toEqual({ kind: "rate_limited", retryAfterMs: 10_001 });
  });

  it("says each rate-limit wait in a status line", async () => {
    spotify.answer = async () => {
      if (spotify.calls === 1) {
        throw new SourceError("spotify", "rate_limited", "HTTP 429", { retryAfterMs: 50 });
      }
      return JSON.stringify([track]);
    };
    const statuses: string[] = [];
    const saidAt: number[] = [];
    const { graph } = scoutGraph();

    await onFakeClock(() =>
      graph.invoke({ songQuery: "Song A" }, {
        writer: (event: { type?: string; message?: string }) => {
          if (event.type !== "status" || !event.message) return;
          statuses.push(event.message);
          if (event.message.startsWith("Spotify is limiting")) saidAt.push(Date.now());
        },
      } as never),
    );

    expect(statuses).toContain("Spotify is limiting requests; trying again in 1 s");
    // Said when the search is rate limited, before the 50 ms wait, not after it.
    expect(saidAt).toEqual([spotify.startedAt[0]]);
  });

  it("waits out a short Retry-After on each try, then says it was rate limited", async () => {
    spotify.answer = async () => {
      throw new SourceError("spotify", "rate_limited", "HTTP 429", { retryAfterMs: 250 });
    };
    const { graph } = scoutGraph();

    const { out } = await onFakeClock(() => graph.invoke({ songQuery: "Song A" }));

    // 3 tries in all, the Retry-After waited out before each retry.
    expect(spotify.calls).toBe(3);
    const waits = [1, 2].map((i) => spotify.startedAt[i] - spotify.startedAt[i - 1]);
    expect(waits).toEqual([250, 250]);
    expect(out.scoutFailure).toEqual({ kind: "rate_limited", retryAfterMs: 250 });
  });

  it("says nothing matched when Spotify finds nothing", async () => {
    spotify.answer = async () => "[]";
    const { graph } = scoutGraph();

    const out = await graph.invoke({ songQuery: "zzqx" });

    expect(out.scoutFailure).toEqual({ kind: "no_match" });
    expect(out.trackData ?? null).toBeNull();
  });

  it("says Spotify could not answer, without retrying an error that will not pass", async () => {
    spotify.answer = async () => {
      throw new SourceError("spotify", "http", "HTTP 401", { status: 401 });
    };
    const { graph } = scoutGraph();

    const out = await graph.invoke({ songQuery: "Song A" });

    expect(spotify.calls).toBe(1);
    expect(out.scoutFailure).toEqual({ kind: "upstream_unavailable" });
  });
});

describe("scoutNode when it cannot use what Spotify sent", () => {
  it("says the results could not be processed, not that Spotify failed", async () => {
    spotify.answer = async () => "[null]";
    const { graph } = scoutGraph();

    const out = await graph.invoke({ songQuery: "Song A" });

    expect(out.error).toMatch(/^Scout error: /);
    expect(out.statusMessages).toEqual(["The search results could not be processed"]);
  });
});

describe("scoutNode for a request by track id", () => {
  const ID = "6GyFP1nfCDB8lbD2bG0Hq9";
  const requested = { ...track, id: ID, title: "Midnight City", artist: "M83" };

  it("reads that track instead of searching; a suggestion's own text matches it exactly", async () => {
    spotify.track = async () => requested;
    const { graph } = scoutGraph();

    const out = await graph.invoke({ songQuery: "Midnight City M83", requestedTrackId: ID });

    expect(spotify.calls).toBe(0);
    expect(spotify.fetched).toEqual([ID]);
    expect(out).toMatchObject({
      spotifyData: { id: ID },
      selectedTrackId: ID,
      selectedBy: "user",
      pickedBy: null,
      queryMatch: "exact",
    });
    expect(out.candidates ?? null).toBeNull();
  });

  it("says how the request's text matches the track when they disagree", async () => {
    // A genealogy node whose id names another recording than its label.
    spotify.track = async () => requested;
    const { graph } = scoutGraph();

    const out = await graph.invoke({ songQuery: "Hurt Nine Inch Nails", requestedTrackId: ID });

    expect(out.spotifyData).toMatchObject({ id: ID });
    expect(out.queryMatch).toBe("none");
  });

  it.each([
    ["click", "click"],
    ["countdown", "countdown"],
  ] as const)(
    "keeps how a picker row asked for by id was picked (%s)",
    async (pickedBy, expected) => {
      spotify.track = async () => requested;
      const { graph } = scoutGraph();

      const out = await graph.invoke({ songQuery: "midnight", requestedTrackId: ID, pickedBy });

      expect(out.pickedBy).toBe(expected);
    },
  );

  it("tries the read again after a rate limit", async () => {
    let reads = 0;
    spotify.track = async () => {
      reads += 1;
      if (reads === 1) {
        throw new SourceError("spotify", "rate_limited", "HTTP 429", { retryAfterMs: 0 });
      }
      return requested;
    };
    const { graph } = scoutGraph();

    const out = await graph.invoke({ songQuery: "Midnight City M83", requestedTrackId: ID });

    expect(spotify.fetched).toEqual([ID, ID]);
    expect(out.spotifyData).toMatchObject({ id: ID });
  });

  it("serves the result stored for that track, with this request's search match", async () => {
    spotify.track = async () => requested;
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
    await store.put(TRACKS_NAMESPACE, resultCacheKey(ID, configuredSources()), {
      trackData: { ...analysis, id: ID, queryMatch: "none" },
      timestamp: Date.now(),
    });
    const { graph } = scoutGraph(store);

    const out = await graph.invoke({ songQuery: "Midnight City M83", requestedTrackId: ID });
    expect(out.trackData).toMatchObject({ id: ID, queryMatch: "exact" });

    // A deliberate click shows no match.
    const clicked = await scoutGraph(store).graph.invoke({
      songQuery: "midnight",
      requestedTrackId: ID,
      pickedBy: "click",
    });
    expect(clicked.trackData).toMatchObject({ id: ID });
    expect(clicked.trackData).not.toHaveProperty("queryMatch");
  });

  it.each([
    [
      "Spotify has no such track",
      new SourceError("spotify", "http", "HTTP 404", { status: 404 }),
      "no_match",
      "Spotify has no track with this id",
    ],
    [
      "Spotify does not know the id",
      new SourceError("spotify", "http", "HTTP 400", { status: 400 }),
      "no_match",
      "Spotify has no track with this id",
    ],
    [
      "the id is not a Spotify track id",
      new SourceError("spotify", "invalid_input", "not a Spotify track id"),
      "no_match",
      "This is not a Spotify track id",
    ],
    [
      "Spotify fails",
      new SourceError("spotify", "http", "HTTP 401", { status: 401 }),
      "upstream_unavailable",
      "Spotify could not be read",
    ],
  ])("says why no track was read when %s", async (_label, error, kind, said) => {
    spotify.track = async () => {
      throw error;
    };
    const { graph } = scoutGraph();

    const out = await graph.invoke({ songQuery: "midnight city", requestedTrackId: ID });

    expect(out.statusMessages).toEqual([said]);
    expect(out.scoutFailure).toEqual({ kind });
    expect(spotify.calls).toBe(0);
  });
});

describe("onFakeClock after its test times out", () => {
  // The first test times out on purpose (it.fails passes on that). The second runs straight
  // after on its own fake clock: the helper left behind must neither move that clock nor
  // switch the second test back to real timers.
  /** Set when the second test is done: the first test's run stops setting timers then. */
  let probeDone = false;

  it.fails("is cut off by a 30 ms test timeout while its run still goes on", async () => {
    await onFakeClock(() => {
      // Keeps the clock busy each step, as the graph's store does, so the steps take time.
      const poll = () => {
        if (!probeDone) setTimeout(poll, 0);
      };
      poll();
      return new Promise(() => {});
    });
  }, 30);

  it("leaves the next test's fake clock alone", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const at = Date.now();
    // 50 ms of real time (performance is not faked) for the helper left behind to act.
    const until = performance.now() + 50;
    while (performance.now() < until) await new Promise((resolve) => setImmediate(resolve));
    const moved = Date.now() - at;
    const stillFake = vi.isFakeTimers();
    probeDone = true;

    expect(moved).toBe(0);
    expect(stillFake).toBe(true);
  });
});
