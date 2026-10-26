/**
 * Historian node: the research cache (its key, what blocks it, what a hit reports), and what it
 * keeps when the research stops early.
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
  researchData: { samples: ["Sample A"], productionTrivia: [] },
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
  return {
    getLastfmTrackTags: none,
    getLastfmArtistTags: none,
    getLastfmSimilarTracks: none,
    lastfmConfigured: () => true,
  };
});
vi.mock("../../sources/search.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sources/search.js")>()),
  tavilyConfigured: () => true,
}));

import { SourceError } from "../../sources/http.js";
import { MusicBrainzRateLimiter } from "../../sources/musicbrainz.js";
import { stubFetch } from "../../sources/testing/fetchStub.js";
import { ICE_TRACK, primaryRoute } from "../../sources/testing/iceIceBaby.js";
import { CACHED_EVIDENCE_FORMAT } from "../research/runEvidence.js";
import { historianNode } from "./historianNode.js";
import type { SonicAgentStateType } from "../state.js";

describe("historianNode", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports the sources stored as not configured on a cache hit", async () => {
    cache.getResearch.mockReturnValue({
      samples: ["Sample A"],
      productionTrivia: [],
      notConfigured: [{ source: "lastfm", code: "not_configured" }],
      // The evidence of a track without an ISRC: no primary source was asked.
      evidence: {
        format: CACHED_EVIDENCE_FORMAT,
        researchedAt: new Date().toISOString(),
        readAt: new Date().toISOString(),
        isrc: null,
        items: [],
        omitted: 0,
        samples: [],
        relations: [],
        recording: null,
        trackIsOriginal: false,
        errors: [],
        lasting: [],
        incomplete: [],
      },
    });

    const out = await historianNode(
      { spotifyData: { id: "x", title: "T", artist: "A" } } as unknown as SonicAgentStateType,
      { writer: () => {} } as never,
    );

    expect(out.researchData).toEqual({ samples: ["Sample A"], productionTrivia: [] });
    expect(out.sourceErrors).toEqual([{ source: "lastfm", code: "not_configured" }]);
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

    it("keeps the primary sources' records of a track with an ISRC, and caches nothing", async () => {
      const restore = MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
      try {
        stubFetch(primaryRoute);
        subgraph.fails = () => new SourceError("tavily", "timeout", "timed out");
        const out = await historianNode(
          {
            spotifyData: {
              id: "3Fcfwhm8oRrBvBZ8KGhtea",
              title: "Ice Ice Baby",
              artist: "Vanilla Ice",
              durationMs: 271_733,
              isrc: ICE_TRACK.isrc,
            },
            isrc: ICE_TRACK.isrc,
          } as unknown as SonicAgentStateType,
          { writer: () => {} } as never,
        );
        const sources = new Set(out.evidence?.map((e) => e.source));
        expect(sources).toEqual(new Set(["musicbrainz", "secondhandsongs"]));
        expect(out.isrcRecording?.mbid).toBe("875c24bc-fe9e-4ac6-80d3-beaacb70ee43");
        // The recording's MusicBrainz sample relations reach the result built without the model.
        expect(out.researchData?.samples).toEqual(
          expect.arrayContaining([expect.stringMatching(/^\[MusicBrainz Samples\] /)]),
        );
        expect(out.statusMessages?.at(-1)).toMatch(/stopped early/);
        expect(cache.putResearch).not.toHaveBeenCalled();
      } finally {
        restore();
        vi.unstubAllGlobals();
      }
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

      expect(cache.getResearch).toHaveBeenCalledWith("v4:x:lastfm=1:tavily=1:discogs=0:genius=0");
      expect(cache.putResearch).toHaveBeenCalledWith(
        "v4:x:lastfm=1:tavily=1:discogs=0:genius=0",
        expect.anything(),
        48 * 60 * 60 * 1000,
      );
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
