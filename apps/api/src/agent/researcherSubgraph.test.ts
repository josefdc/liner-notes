/**
 * The research loop: a fixed first step, then at most MAX_PLANNED_STEPS steps from the planner
 * (fast tier, ResearchPlanOutput, the run's id and abort signal); every planned step runs; a
 * planner failure ends the research and is recorded by kind; a search failure is a typed
 * source error. The search tools are stubs.
 */

import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

const tools = vi.hoisted(() => {
  // A web search finds one result named after the tool; every other source finds nothing.
  const answer = (name: string) =>
    JSON.stringify(
      name.startsWith("search")
        ? {
            found: true,
            results: [{ title: `[${name}]`, url: "https://example.test/", content: "found" }],
          }
        : { found: false },
    );
  const make = (name: string) => ({
    name,
    invoke: vi.fn(async (_input: unknown, _options?: { signal?: AbortSignal }) => answer(name)),
  });
  return {
    searchSamples: make("searchSamples"),
    searchProductionHistory: make("searchProductionHistory"),
    searchMusicInfo: make("searchMusicInfo"),
    getMusicBrainzRelations: make("getMusicBrainzRelations"),
    getMusicBrainzArtist: make("getMusicBrainzArtist"),
    getLastfmTrackTags: make("getLastfmTrackTags"),
    getLastfmArtistTags: make("getLastfmArtistTags"),
    getLastfmSimilarTracks: make("getLastfmSimilarTracks"),
    getLastfmSimilarArtists: make("getLastfmSimilarArtists"),
    getLastfmArtistInfo: make("getLastfmArtistInfo"),
    getListenBrainzSimilarArtists: make("getListenBrainzSimilarArtists"),
  };
});
vi.mock("../sources/search.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/search.js")>()),
  searchSamples: tools.searchSamples,
  searchProductionHistory: tools.searchProductionHistory,
  searchMusicInfo: tools.searchMusicInfo,
}));
vi.mock("../sources/musicbrainz.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/musicbrainz.js")>()),
  getMusicBrainzRelations: tools.getMusicBrainzRelations,
  getMusicBrainzArtist: tools.getMusicBrainzArtist,
}));
vi.mock("../sources/lastfm.js", () => ({
  lastfmConfigured: () => true,
  getLastfmTrackTags: tools.getLastfmTrackTags,
  getLastfmArtistTags: tools.getLastfmArtistTags,
  getLastfmSimilarTracks: tools.getLastfmSimilarTracks,
  getLastfmSimilarArtists: tools.getLastfmSimilarArtists,
  getLastfmArtistInfo: tools.getLastfmArtistInfo,
}));
vi.mock("../sources/listenbrainz.js", () => ({
  getListenBrainzSimilarArtists: tools.getListenBrainzSimilarArtists,
}));

import { LlmError } from "../llm/errors.js";
import { TransientError } from "./errors.js";
import {
  MAX_PLANNED_STEPS,
  StepReader,
  actionLabel,
  createResearcherSubgraph,
} from "./researcherSubgraph.js";
import type { SpotifyData } from "./state.js";
import { messagesOf, stubLlm, testRuntime } from "./testing/stubLlm.js";

const spotifyData = { id: "x", title: "Ice Ice Baby", artist: "Vanilla Ice" } as SpotifyData;
const plan = (nextAction: string, query: string | null = null) => ({
  nextAction,
  query,
  reasoning: `next: ${nextAction}`,
});

function planner(...plans: Array<ReturnType<typeof plan> | Error>) {
  return stubLlm(() => {
    const next = plans.shift() ?? plan("done");
    if (next instanceof Error) throw next;
    return next;
  });
}

describe("researcher subgraph", () => {
  beforeEach(() => {
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
    for (const tool of Object.values(tools)) tool.invoke.mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("runs the fixed step and every planned step, with at most MAX_PLANNED_STEPS planner calls", async () => {
    const llm = planner(
      plan("search_production", "Ice Ice Baby studio"),
      plan("search_general", "Under Pressure sample"),
      plan("search_lastfm_tags"),
    );
    const final = await createResearcherSubgraph(testRuntime(llm)).invoke({
      spotifyData,
      runId: "run-7",
    });

    expect(llm.calls).toHaveLength(MAX_PLANNED_STEPS);
    expect(tools.searchSamples.invoke).toHaveBeenCalledTimes(1);
    expect(tools.searchProductionHistory.invoke).toHaveBeenCalledTimes(1);
    // The second plan used to be computed and then dropped by the loop's own limit.
    expect(tools.searchMusicInfo.invoke).toHaveBeenCalledWith(
      { query: "Under Pressure sample" },
      expect.anything(),
    );
    expect(tools.getLastfmTrackTags.invoke).not.toHaveBeenCalled();
    expect(final.usage.map((u) => [u.callSite, u.tier, u.status])).toEqual([
      ["research_planner", "fast", "ok"],
      ["research_planner", "fast", "ok"],
    ]);
  });

  it("plans on the fast tier with the run's id, its signal and the planner schema", async () => {
    const llm = planner(plan("done"));
    const controller = new AbortController();
    await createResearcherSubgraph(testRuntime(llm)).invoke(
      { spotifyData, runId: "run-7" },
      { signal: controller.signal },
    );

    const [call] = llm.calls;
    expect(call).toMatchObject({ callSite: "research_planner", tier: "fast" });
    expect(call.options).toMatchObject({ runId: "run-7", purpose: "dev" });
    expect(call.options.signal).toBeInstanceOf(AbortSignal);
    const { system, user } = messagesOf(call);
    expect(system).toContain("You plan the research");
    expect(system).not.toContain("search_artist_top_tracks");
    expect(user).toContain(
      "<<<SOURCE samples>>>\n[searchSamples]\nhttps://example.test/\nfound\n<<<END SOURCE>>>",
    );
  });

  it("passes the run's abort signal to every search, and a cancelled run stops", async () => {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    tools.getMusicBrainzRelations.invoke.mockImplementationOnce(async (_input, options) => {
      seen = options?.signal;
      controller.abort(); // the client leaves while this search runs
      return JSON.stringify({ found: false });
    });
    const llm = planner(plan("search_musicbrainz"), plan("search_lastfm_artist_info"));

    await expect(
      createResearcherSubgraph(testRuntime(llm)).invoke(
        { spotifyData, runId: "run-7" },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(tools.searchSamples.invoke.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    expect(seen?.aborted).toBe(true);
    expect(llm.calls).toHaveLength(1);
    expect(tools.getLastfmArtistInfo.invoke).not.toHaveBeenCalled();
  });

  it("ends the research when the planner fails, recording the error's kind", async () => {
    const llm = planner(new LlmError("budget_exceeded", "research_planner: cap"));
    const final = await createResearcherSubgraph(testRuntime(llm)).invoke({ spotifyData });

    expect(final.researchComplete).toBe(true);
    expect(final.usage).toEqual([
      expect.objectContaining({ callSite: "research_planner", status: "budget_exceeded" }),
    ]);
    expect(final.researchData.samples).toEqual(["[searchSamples]\nhttps://example.test/\nfound"]);
    // In words, never the error's kind.
    expect(final.statusMessages).toContain(
      "Research ended early: the model budget is used up, so the model was not asked",
    );
    expect(final.statusMessages.join("\n")).not.toMatch(/budget_exceeded|unavailable/);
  });

  it("tells the client, as a warning, that the research ended early when the planner fails", async () => {
    const llm = planner(new LlmError("rate_limited", "research_planner: 429"));
    const events: Array<Record<string, unknown>> = [];
    const stream = await createResearcherSubgraph(testRuntime(llm)).stream(
      { spotifyData },
      { streamMode: "custom" },
    );
    for await (const event of stream) events.push(event as Record<string, unknown>);

    expect(events.filter((event) => event.node === "research_manager").at(-1)).toMatchObject({
      type: "status",
      code: "SYS-WARN",
      message: "Research ended early: the model is unavailable: it is limiting requests",
    });
    expect(events.map((event) => event.message)).not.toContain("Research steps finished");
  });

  it("says an unusable planner answer was not used, not that the planner was unavailable", async () => {
    const llm = planner(new LlmError("invalid_output", "research_planner: bad answer"));
    const final = await createResearcherSubgraph(testRuntime(llm)).invoke({ spotifyData });
    expect(final.statusMessages).toContain(
      "Research ended early: the model's answer could not be used",
    );
    expect(final.statusMessages.join("\n")).not.toMatch(/invalid_output|unavailable/);
  });

  it("keeps the planner's reasoning out of its status lines", async () => {
    const final = await createResearcherSubgraph(
      testRuntime(planner(plan("search_lastfm_artist_info"))),
    ).invoke({ spotifyData });
    expect(final.statusMessages).toContain("Research steps finished");
    // The stub planner reasons "next: <action>": model text, never a status line.
    expect(final.statusMessages.join("\n")).not.toMatch(/^next: /m);
  });

  it("throws, without a retry, when the planner fails for another reason (a bug)", async () => {
    const llm = planner(new TypeError("cannot read x"));
    await expect(
      createResearcherSubgraph(testRuntime(llm)).invoke({ spotifyData }),
    ).rejects.toThrow("cannot read x");
    expect(llm.calls).toHaveLength(1);
  });

  it("records a failed search as the source's error and goes on", async () => {
    tools.getMusicBrainzRelations.invoke.mockRejectedValueOnce(new TypeError("bad payload"));
    const final = await createResearcherSubgraph(
      testRuntime(planner(plan("search_musicbrainz"), plan("search_lastfm_artist_info"))),
    ).invoke({ spotifyData });

    // A TypeError is a bug of the reader: an internal error, never the source's answer.
    expect(final.sourceErrors).toEqual([
      expect.objectContaining({
        source: "musicbrainz",
        code: "unavailable",
        message: "internal error: bad payload",
      }),
    ]);
    expect(final.statusMessages).toContain(
      "Search failed: MusicBrainz relationships of the recording; MusicBrainz: our reader failed on its answer",
    );
    expect(tools.getLastfmArtistInfo.invoke).toHaveBeenCalledTimes(1);
  });

  it("retries a transiently failing search once, records it and goes on", async () => {
    tools.searchProductionHistory.invoke.mockImplementation(async () => {
      throw new TransientError("search 503", 503);
    });
    const final = await createResearcherSubgraph(
      testRuntime(planner(plan("search_production"), plan("search_lastfm_artist_info"))),
    ).invoke({ spotifyData });

    expect(tools.searchProductionHistory.invoke).toHaveBeenCalledTimes(2);
    expect(final.sourceErrors).toEqual([expect.objectContaining({ source: "tavily" })]);
    expect(tools.getLastfmArtistInfo.invoke).toHaveBeenCalledTimes(1);
    expect(final.statusMessages).toContain(
      "Search failed: production history on the web; Web search (Tavily) could not be read: it gave no usable answer",
    );
    tools.searchProductionHistory.invoke.mockReset();
    tools.searchProductionHistory.invoke.mockImplementation(async () =>
      JSON.stringify({ found: false }),
    );
  });

  it("starts no search once the run is cancelled", async () => {
    const controller = new AbortController();
    let reads = 0;
    // The clock is read for each status event; the second one announces the first search, a
    // web search, which is announced only when the web search has a key.
    vi.stubEnv("TAVILY_API_KEY", "test-key");
    onTestFinished(() => {
      vi.unstubAllEnvs();
    });
    const runtime = {
      ...testRuntime(planner(plan("search_musicbrainz"))),
      now: () => {
        if (++reads === 2) controller.abort();
        return new Date("2026-01-01T00:00:00.000Z");
      },
    };

    await expect(
      createResearcherSubgraph(runtime).invoke({ spotifyData }, { signal: controller.signal }),
    ).rejects.toThrow();
    expect(tools.searchSamples.invoke).not.toHaveBeenCalled();
  });

  it("names a step with every underscore replaced", () => {
    expect(actionLabel("search_lastfm_similar_tracks")).toBe("Last.fm similar tracks");
  });

  it("reads only its own not-asked reasons as 'not asked', never an inherited name", () => {
    const reader = new StepReader();
    for (const reason of ["constructor", "toString", "__proto__"]) {
      reader.read("lastfm", JSON.stringify({ found: false, reason }), "artistInfo");
    }
    reader.read("lastfm", JSON.stringify({ found: false, reason: "shared_page" }), "artistInfo");

    expect(reader.none).toEqual([
      "Last.fm artist info",
      "Last.fm artist info",
      "Last.fm artist info",
    ]);
    expect(reader.notAsked).toEqual([
      "Last.fm artist info (dropped: Last.fm keeps one page for several artists of this name)",
    ]);
  });
});
