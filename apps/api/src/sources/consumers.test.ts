/**
 * What the tools' consumers keep. The researcher subgraph and the historian run with the real
 * source tools over a stubbed network and a stubbed research planner. When a source is not
 * configured, fails, answers with an HTML page or finds nothing, no error, "unavailable" or
 * "nothing found" text may end up in the research data: every list stays empty.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { html, json, stubFetch } from "./testing/fetchStub.js";

const planner = vi.hoisted(() => ({ plans: [] as Array<string> }));

vi.mock("../store/cache.js", () => ({
  getCache: () => ({ getResearch: () => null, putResearch: () => {} }),
}));

import { historianNode } from "../agent/nodes/historianNode.js";
import { createResearcherSubgraph } from "../agent/researcherSubgraph.js";
import { stubLlm, testRuntime } from "../agent/testing/stubLlm.js";
import type { ResearchData, SonicAgentStateType, SpotifyData } from "../agent/state.js";
import { MusicBrainzRateLimiter } from "./musicbrainz.js";
import { SpotifyAuthManager } from "./spotify.js";

const SPOTIFY_DATA = {
  id: "3Fcfwhm8oRrBvBZ8KGhtea",
  title: "Ice Ice Baby",
  artist: "Vanilla Ice",
  artistIds: ["7GaxyUddsPok8BuhxN6OUW"],
} as SpotifyData;

const ACTIONS = [
  "search_samples",
  "search_production",
  "search_general",
  "search_musicbrainz",
  "search_artist_collaborators",
  "search_lastfm_tags",
  "search_lastfm_similar_tracks",
  "search_lastfm_similar_artists",
  "search_lastfm_artist_info",
  "search_listenbrainz_similar",
];

type Scenario = "not configured" | "failing" | "unreachable" | "HTML pages" | "nothing found";
const SCENARIOS: Scenario[] = [
  "not configured",
  "failing",
  "unreachable",
  "HTML pages",
  "nothing found",
];

/** Answers every source the way the scenario says. */
function network(scenario: Scenario) {
  const configured = scenario !== "not configured";
  process.env.TAVILY_API_KEY = configured ? "tvly-test-key" : "";
  process.env.LASTFM_API_KEY = configured ? "test-lastfm-key" : "";
  return stubFetch((call) => {
    const url = call.url;
    switch (scenario) {
      case "not configured":
      case "failing":
        return url.startsWith("https://musicbrainz.org/")
          ? json({ error: "busy" }, { status: 503, headers: { "Retry-After": "0" } })
          : json({ error: "internal error" }, { status: 500 });
      case "unreachable":
        return Promise.reject(new TypeError("fetch failed"));
      case "HTML pages":
        return html("<!doctype html><title>Checking your browser</title>");
      case "nothing found":
        if (url === "https://api.tavily.com/search") return json({ results: [] });
        if (url.startsWith("https://musicbrainz.org/ws/2/recording?")) {
          return json({ count: 0, recordings: [] });
        }
        if (url.startsWith("https://musicbrainz.org/ws/2/artist?")) {
          return json({ count: 0, artists: [] });
        }
        if (url.startsWith("https://labs.api.listenbrainz.org/")) return json([]);
        if (url.startsWith("https://ws.audioscrobbler.com/")) {
          const method = new URL(url).searchParams.get("method");
          if (method === "artist.getInfo") {
            return json({ error: 6, message: "The artist you supplied could not be found" });
          }
          return json({
            toptags: { tag: [] },
            similartracks: { track: [] },
            similarartists: { artist: [] },
          });
        }
        return undefined;
    }
  });
}

const LISTS: Array<keyof ResearchData> = [
  "samples",
  "productionTrivia",
  "relatedArtists",
  "collaborators",
  "lastfmTags",
  "lastfmSimilarTracks",
  "lastfmSimilarArtists",
  "listenbrainzSimilarArtists",
];

function expectNothingKept(research: Partial<ResearchData> | undefined) {
  for (const list of LISTS) {
    expect(research?.[list] ?? [], list).toEqual([]);
  }
  expect(research?.lastfmArtistBio).toBeUndefined();
  expect(JSON.stringify(research ?? {})).not.toMatch(
    /error|unavailable|not configured|not found|no .* found|nothing found|no web results/i,
  );
}

// The research planner: answers the next queued step; "throw" fails as a bug would.
const runtime = testRuntime(
  stubLlm(() => {
    const next = planner.plans.shift() ?? "done";
    if (next === "throw") throw new Error("planner unavailable");
    return { nextAction: next, query: "Ice Ice Baby Vanilla Ice", reasoning: next };
  }),
);

describe("tool output that consumers must drop", () => {
  beforeAll(() => {
    MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
  });
  beforeEach(() => {
    SpotifyAuthManager.getInstance().clearToken();
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
  });
  afterEach(() => {
    planner.plans = [];
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe.each(SCENARIOS)("sources %s", (scenario) => {
    it.each(ACTIONS)("the researcher keeps nothing from %s", async (action) => {
      network(scenario);
      planner.plans = [action, "done"];

      const final = await createResearcherSubgraph(runtime).invoke({ spotifyData: SPOTIFY_DATA });

      expectNothingKept(final.researchData);
    });

    it("the historian keeps nothing", async () => {
      network(scenario);
      planner.plans = ["search_musicbrainz", "done"];

      const out = await historianNode(
        { spotifyData: SPOTIFY_DATA } as unknown as SonicAgentStateType,
        { writer: () => {} } as never,
        runtime,
      );

      expectNothingKept(out.researchData);
    });

    it("a planner bug fails the research instead of being hidden", async () => {
      network(scenario);
      planner.plans = ["throw"];

      await expect(
        historianNode(
          { spotifyData: SPOTIFY_DATA } as unknown as SonicAgentStateType,
          { writer: () => {} } as never,
          runtime,
        ),
      ).rejects.toThrow("planner unavailable");
    });
  });
});
