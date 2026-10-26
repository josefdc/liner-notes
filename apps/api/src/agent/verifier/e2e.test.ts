/**
 * The verifier in the whole graph (scout → engineer ∥ historian → composer → verifier), every
 * source stubbed and the model layer answered by a stub (no network, no spend): a composition
 * with a claim its source contradicts and a tempo of 246 BPM against a measured 123 comes out as
 * one result, sent once by the verifier, with the contradicted claim kept for the rejected panel
 * and the octave error shown as a conflict.
 */

import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import { analysisIssues, claimIsRejected, TrackAnalysis } from "@liner-notes/contract";
import { beforeEach, describe, expect, it, vi } from "vitest";

const tools = vi.hoisted(() => {
  const tool = (answer: () => string) => ({
    invoke: vi.fn(async (..._args: unknown[]) => answer()),
  });
  const track = {
    id: "3Fcfwhm8oRrBvBZ8KGhtea",
    title: "Ice Ice Baby",
    artist: "Vanilla Ice",
    artistIds: ["7GaxyUddsPok8BuhxN6OUW"],
    album: "To the Extreme",
    releaseDate: "1990-09-10",
    coverUrl: "https://i.scdn.co/image/x",
    duration: "4:31",
    durationMs: 271_000,
    explicit: false,
    spotifyUrl: "https://open.spotify.com/track/3Fcfwhm8oRrBvBZ8KGhtea",
    previewUrl: null,
  };
  const none = () => JSON.stringify({ found: false });
  const web = (content: string) =>
    JSON.stringify({
      found: true,
      results: [{ title: "Page", url: "https://example.test/ice", content }],
    });
  return {
    spotifySearch: tool(() => JSON.stringify([track])),
    analyzeAudioPreview: tool(() =>
      JSON.stringify({ source: "unavailable", reason: "no_preview" }),
    ),
    getLastfmTrackTags: tool(none),
    getLastfmArtistTags: tool(none),
    getLastfmSimilarTracks: tool(none),
    getLastfmSimilarArtists: tool(none),
    getLastfmArtistInfo: tool(none),
    searchSamples: tool(() =>
      web(
        "Ice Ice Baby (1990) is built on the bass line of Under Pressure by Queen and David Bowie.",
      ),
    ),
    searchProductionHistory: tool(none),
    searchMusicInfo: tool(none),
    getMusicBrainzRelations: tool(none),
    getMusicBrainzArtist: tool(none),
    getListenBrainzSimilarArtists: tool(none),
  };
});
vi.mock("../../sources/spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sources/spotify.js")>()),
  searchTracks: async (query: string, limit: number, signal?: AbortSignal) =>
    JSON.parse(await tools.spotifySearch.invoke({ query, limit }, { signal })),
}));
vi.mock("../../sources/audio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sources/audio.js")>()),
  resolvePreview: async () => ({
    previewUrl: null,
    match: null,
    detail: "No preview in this test",
  }),
  audioServiceHealth: async () => null,
  analyzeAudioPreview: tools.analyzeAudioPreview,
}));
vi.mock("../../sources/lastfm.js", () => ({
  lastfmConfigured: () => true,
  getLastfmTrackTags: tools.getLastfmTrackTags,
  getLastfmArtistTags: tools.getLastfmArtistTags,
  getLastfmSimilarTracks: tools.getLastfmSimilarTracks,
  getLastfmSimilarArtists: tools.getLastfmSimilarArtists,
  getLastfmArtistInfo: tools.getLastfmArtistInfo,
}));
vi.mock("../../sources/search.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sources/search.js")>()),
  tavilyConfigured: () => true,
  searchSamples: tools.searchSamples,
  searchProductionHistory: tools.searchProductionHistory,
  searchMusicInfo: tools.searchMusicInfo,
}));
vi.mock("../../sources/musicbrainz.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sources/musicbrainz.js")>()),
  getMusicBrainzRelations: tools.getMusicBrainzRelations,
  getMusicBrainzArtist: tools.getMusicBrainzArtist,
  lookupIsrc: vi.fn(async () => {
    throw new Error("MusicBrainz must not be called without an ISRC");
  }),
}));
vi.mock("../../sources/listenbrainz.js", () => ({
  getListenBrainzSimilarArtists: tools.getListenBrainzSimilarArtists,
}));
vi.mock("../../store/cache.js", () => ({
  getCache: () => ({
    getAudio: () => null,
    getNewestAudio: () => null,
    putAudio: () => {},
    getResearch: () => null,
    putResearch: () => {},
  }),
}));
vi.mock(
  "../enricher.js",
  () =>
    ({
      enrichGenealogyWithArtwork: async (genealogy) => ({
        nodes: (genealogy?.nodes ?? []).map(({ id }) => ({ id })),
        complete: true,
      }),
    }) satisfies Partial<typeof import("../enricher.js")>,
);

import { buildSonicAgentGraph } from "../graph.js";
import type { TrackData } from "../schema.js";
import { audioV2 } from "../testing/measuredAudio.js";
import { type StubCall, stubLlm, testRuntime } from "../testing/stubLlm.js";
import { sentStatements } from "./testing.js";

/** The ids of the evidence pack the composer's prompt shows. */
function shownIds(call: StubCall): string[] {
  const user = JSON.stringify(call.input);
  const pack = user.split("<<<SOURCE evidence pack>>>")[1]?.split("<<<END SOURCE>>>")[0] ?? "";
  return [...pack.matchAll(/\\"id\\":\\"([^\\]+)\\"/g)].map((match) => match[1]);
}

const CONTRADICTED = "Ice Ice Baby was first released in 1975.";
const OCTAVE = "The track runs at 246 BPM.";

/** The composition: a sourced sample, a claim its source contradicts, and a tempo octave off. */
function compose(call: StubCall) {
  const [cited] = shownIds(call);
  if (!cited) throw new Error("the composer was shown no evidence");
  return {
    claims: [
      {
        text: "The bass line comes from Under Pressure by Queen and David Bowie.",
        about: "sample",
        evidenceIds: [cited],
        field: null,
        scope: "recording",
      },
      {
        text: CONTRADICTED,
        about: "history",
        evidenceIds: [cited],
        field: null,
        scope: "recording",
      },
      { text: OCTAVE, about: "sound", evidenceIds: [], field: "tempo", scope: "recording" },
    ],
    factoids: [],
    genealogyNodes: [
      {
        id: "current",
        role: "current",
        label: "Ice Ice Baby",
        trackTitle: null,
        trackArtist: null,
        year: null,
      },
      {
        id: "up",
        role: "source",
        label: "Under Pressure - Queen & David Bowie (1981)",
        trackTitle: "Under Pressure",
        trackArtist: "Queen",
        year: "1981",
      },
    ],
    genealogyLinks: [
      // Written the wrong way round: the composer turns it from the earlier record.
      { source: "current", target: "up", type: "sample", evidenceIds: [cited], scope: "recording" },
    ],
  };
}

function model() {
  return stubLlm((call) => {
    if (call.callSite === "composer") return compose(call);
    if (call.callSite === "verifier") {
      return {
        verdicts: sentStatements(call).map(({ claimId, text }) => ({
          claimId,
          verdict: text === CONTRADICTED ? "contradicted" : "supported",
          reason:
            text === CONTRADICTED
              ? "The page says it came out in 1990."
              : "The page names the Under Pressure bass line.",
        })),
      };
    }
    return { nextAction: "done", query: null, reasoning: "planned done" };
  });
}

describe("the verifier in the analysis graph", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network denied");
    });
    for (const method of ["log", "warn", "error"] as const) {
      vi.spyOn(console, method).mockImplementation(() => {});
    }
    tools.analyzeAudioPreview.invoke.mockImplementation(async () =>
      JSON.stringify({
        source: "analyzed",
        audio: audioV2({ tempo: { ...audioV2().tempo!, bpm: 123, confidence: 0.71 } }),
      }),
    );
  });

  it("sends one result, after the verifier, with the contradicted claim kept and the octave error a conflict", async () => {
    const llm = model();
    const store = new InMemoryStore();
    const graph = buildSonicAgentGraph({
      runtime: testRuntime(llm),
      checkpointer: new MemorySaver(),
      store,
    });
    const events: Array<Record<string, unknown>> = [];
    const updates: Array<[string, Record<string, unknown>]> = [];
    const stream = await graph.stream(
      { songQuery: "Ice Ice Baby Vanilla Ice" },
      { configurable: { thread_id: "e2e-1" }, streamMode: ["updates", "custom"] },
    );
    for await (const [mode, data] of stream as AsyncIterable<[string, Record<string, unknown>]>) {
      if (mode === "custom") events.push(data);
      else {
        for (const [node, update] of Object.entries(data)) {
          updates.push([node, (update ?? {}) as Record<string, unknown>]);
        }
      }
    }

    // One `complete`, from the verifier; the composer wrote only its draft.
    const complete = events.filter((event) => event.type === "complete");
    expect(complete).toHaveLength(1);
    const composer = updates.filter(([node]) => node === "composer").map(([, update]) => update);
    expect(composer).toHaveLength(1);
    expect(composer[0]).not.toHaveProperty("trackData");
    expect(composer[0].draft).toBeTruthy();
    const verifier = updates.find(([node]) => node === "verifier")?.[1];
    expect(verifier?.trackData).toEqual(complete[0].data);
    expect(llm.calls.map((call) => call.callSite)).toEqual([
      "research_planner",
      "composer",
      "verifier",
    ]);

    const result = TrackAnalysis.parse(complete[0].data as TrackData);
    expect(result.bpm).toBe(123);
    const byText = (text: string) => result.claims?.find((claim) => claim.text === text);

    // The judge's contradiction: kept, rejected, never sourced.
    expect(byText(CONTRADICTED)).toMatchObject({
      verdict: "contradicted",
      verdictReason: "The page says it came out in 1990.",
      kind: "inferred",
    });
    expect(claimIsRejected(byText(CONTRADICTED)!)).toBe(true);

    // 246 against a measured 123: twice the tempo, an estimator error, so a conflict.
    expect(byText(OCTAVE)).toMatchObject({
      numericCheck: "conflict",
      numericComparison: { claimed: 246, measured: 123, method: "essentia.RhythmExtractor2013" },
      verdict: null,
      kind: "inferred",
    });

    // The sample and the link's own claim are supported by the page they cite.
    expect(
      byText("The bass line comes from Under Pressure by Queen and David Bowie."),
    ).toMatchObject({ verdict: "supported", kind: "sourced" });
    const [link] = result.genealogy.links;
    expect(link).toMatchObject({
      source: "up",
      target: "current",
      type: "sample",
      kind: "sourced",
      value: 3,
    });
    expect(result.claims?.find((claim) => claim.id === link.claimId)).toMatchObject({
      about: "sample",
      verdict: "supported",
      kind: "sourced",
    });

    // Three cited claims judged (the two claims and the link's); the octave claim cites nothing.
    expect(result.run?.verifier).toEqual({ judged: 3, unjudged: 0 });
    expect(result.run?.usage?.llmCalls).toBe(3);
    expect(analysisIssues(result)).toEqual([]);
    // Judged in full: stored for the track.
    expect(await store.search(["tracks", "v8"])).toHaveLength(1);
  });
});
