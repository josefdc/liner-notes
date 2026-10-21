/**
 * Historian node: song-meaning page text (which can carry lyrics) from research cached
 * before that step was removed never reaches the graph state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ getResearch: vi.fn(), putResearch: vi.fn() }));
vi.mock("../../store/cache.js", () => ({ getCache: () => cache }));
const subgraph = vi.hoisted(() => ({
  /** When set, the research ends with this state (and throws `fails()` after it, if set). */
  final: null as null | Record<string, unknown>,
  fails: null as null | (() => Error),
  /** Runs while the research streams (e.g. to cancel the run then). */
  during: null as null | (() => void),
}));
const STOPPED_STATE = {
  researchData: { samples: ["Sample A"], productionTrivia: [], relatedArtists: [] },
  usage: [{ callSite: "research_planner", tier: "fast", status: "ok" }],
  sourceErrors: [{ source: "lastfm", code: "unavailable" }],
  statusMessages: ["Found samples information"],
};
vi.mock("../researcherSubgraph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../researcherSubgraph.js")>();
  return {
    ...actual,
    getCachedResearcherSubgraph: (
      ...args: Parameters<typeof actual.getCachedResearcherSubgraph>
    ) =>
      subgraph.final || subgraph.fails
        ? {
            stream: async () =>
              (async function* () {
                yield ["values", subgraph.final ?? STOPPED_STATE];
                subgraph.during?.();
                if (subgraph.fails) throw subgraph.fails();
              })(),
          }
        : actual.getCachedResearcherSubgraph(...args),
  };
});
vi.mock("../../sources/lastfm.js", () => {
  const none = { invoke: async () => JSON.stringify({ found: false }) };
  return { getLastfmTrackTags: none, getLastfmArtistTags: none, getLastfmSimilarTracks: none };
});

import { SourceError } from "../../sources/http.js";
import { historianNode } from "./historianNode.js";
import type { SonicAgentStateType } from "../state.js";

describe("historianNode", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops song-meaning text from cached research", async () => {
    cache.getResearch.mockReturnValue({
      samples: ["Sample A"],
      productionTrivia: ["Trivia"],
      songMeaning: [
        "[Genius Lyrics]\nLINE_ONE_OF_SONG_TEXT",
        "Song meaning page: LINE_TWO_OF_SONG_TEXT",
      ],
      relatedArtists: [],
    });

    const out = await historianNode(
      { spotifyData: { id: "x", title: "T", artist: "A" } } as unknown as SonicAgentStateType,
      { writer: () => {} } as never,
    );

    expect(out.researchData).toEqual({
      samples: ["Sample A"],
      productionTrivia: ["Trivia"],
      relatedArtists: [],
    });
    expect(JSON.stringify(out)).not.toContain("SONG_TEXT");
  });

  describe("when the research stops early", () => {
    beforeEach(() => {
      cache.getResearch.mockReturnValue(null);
      cache.putResearch.mockClear();
      vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      subgraph.fails = null;
      subgraph.final = null;
    });

    const state = {
      spotifyData: { id: "x", title: "T", artist: "A" },
    } as unknown as SonicAgentStateType;

    it("keeps what it found, its model calls and its source errors, and says so", async () => {
      subgraph.fails = () => new SourceError("tavily", "timeout", "timed out");

      const out = await historianNode(state, { writer: () => {} } as never);

      expect(out.researchData?.samples).toEqual(["Sample A"]);
      expect(out.usage).toEqual([expect.objectContaining({ callSite: "research_planner" })]);
      expect(out.sourceErrors).toEqual([
        { source: "lastfm", code: "unavailable" },
        expect.objectContaining({ source: "tavily", code: "timeout" }),
      ]);
      expect(out.statusMessages?.at(-1)).toMatch(/stopped early/);
      expect(cache.putResearch).not.toHaveBeenCalled();
    });

    it("rethrows a bug", async () => {
      subgraph.fails = () => new TypeError("x is not a function");

      await expect(historianNode(state, { writer: () => {} } as never)).rejects.toThrow(
        "x is not a function",
      );
    });
  });

  describe("research cache", () => {
    const state = {
      spotifyData: { id: "x", title: "T", artist: "A" },
    } as unknown as SonicAgentStateType;
    const research = { samples: ["Sample A"], productionTrivia: [], relatedArtists: [] };
    const ok = { callSite: "research_planner", tier: "fast", status: "ok" };

    beforeEach(() => {
      cache.getResearch.mockReset();
      cache.getResearch.mockReturnValue(null);
      cache.putResearch.mockClear();
    });
    afterEach(() => {
      subgraph.final = null;
      subgraph.during = null;
    });

    it("stores complete research under a versioned key, and reads that key", async () => {
      subgraph.final = { researchData: research, usage: [ok, ok], sourceErrors: [] };

      await historianNode(state, { writer: () => {} } as never);

      expect(cache.getResearch).toHaveBeenCalledWith("v2:x");
      expect(cache.putResearch).toHaveBeenCalledWith("v2:x", expect.anything());
    });

    it("does not store research when a planner call failed", async () => {
      subgraph.final = {
        researchData: research,
        usage: [{ ...ok, status: "rate_limited" }],
        sourceErrors: [],
      };

      await historianNode(state, { writer: () => {} } as never);

      expect(cache.putResearch).not.toHaveBeenCalled();
    });

    it("does not store research when a source could not be read", async () => {
      subgraph.final = {
        researchData: research,
        usage: [ok],
        sourceErrors: [{ source: "tavily", code: "unavailable" }],
      };

      await historianNode(state, { writer: () => {} } as never);

      expect(cache.putResearch).not.toHaveBeenCalled();
    });

    it("writes nothing when the run is cancelled", async () => {
      const controller = new AbortController();
      subgraph.final = { researchData: research, usage: [ok], sourceErrors: [] };
      // The client leaves once the research has finished, before it is cached.
      subgraph.during = () => controller.abort();

      await expect(
        historianNode(state, { writer: () => {}, signal: controller.signal } as never),
      ).rejects.toThrow();
      expect(cache.putResearch).not.toHaveBeenCalled();
    });
  });
});
