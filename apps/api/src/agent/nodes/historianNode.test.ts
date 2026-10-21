/**
 * Historian node: song-meaning page text (which can carry lyrics) from research cached
 * before that step was removed never reaches the graph state.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cache = vi.hoisted(() => ({ getResearch: vi.fn(), putResearch: vi.fn() }));
vi.mock("../../store/cache.js", () => ({ getCache: () => cache }));
const subgraph = vi.hoisted(() => ({ fails: null as null | (() => Error) }));
vi.mock("../researcherSubgraph.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../researcherSubgraph.js")>();
  return {
    ...actual,
    // A research run that got as far as one planned step, then stopped with `fails()`.
    getCachedResearcherSubgraph: (
      ...args: Parameters<typeof actual.getCachedResearcherSubgraph>
    ) =>
      subgraph.fails
        ? {
            stream: async () =>
              (async function* () {
                yield [
                  "values",
                  {
                    researchData: {
                      samples: ["Sample A"],
                      productionTrivia: [],
                      relatedArtists: [],
                    },
                    usage: [{ callSite: "research_planner", tier: "fast", status: "ok" }],
                    sourceErrors: [{ source: "lastfm", code: "unavailable" }],
                    statusMessages: ["Found samples information"],
                  },
                ];
                throw subgraph.fails?.();
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
});
