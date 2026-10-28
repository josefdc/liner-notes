/**
 * Code-built claims and links in the whole graph, for "Ice Ice Baby" with its primary sources
 * answered from the captured fixtures and the model layer answered by a stub (no network, no
 * spend): the sample MusicBrainz records becomes a code link that the contract's readers show as
 * sourced through its own claim; the model's link for the same sample folds into it.
 */

import { InMemoryStore, MemorySaver } from "@langchain/langgraph";
import {
  analysisIssues,
  claimIsRejected,
  linkDisplayKind,
  resultContext,
  TrackAnalysis,
} from "@liner-notes/contract";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const tools = vi.hoisted(() => {
  const tool = (answer: () => string) => ({
    invoke: vi.fn(async (..._args: unknown[]) => answer()),
  });
  const none = () => JSON.stringify({ found: false });
  const track = {
    id: "3Fcfwhm8oRrBvBZ8KGhtea",
    title: "Ice Ice Baby",
    artist: "Vanilla Ice",
    artistIds: ["7GaxyUddsPok8BuhxN6OUW"],
    album: "To the Extreme",
    releaseDate: "1990-09-10",
    coverUrl: "https://i.scdn.co/image/x",
    duration: "4:31",
    durationMs: 271_733,
    explicit: false,
    isrc: "USCA29001716",
    spotifyUrl: "https://open.spotify.com/track/3Fcfwhm8oRrBvBZ8KGhtea",
    previewUrl: null,
  };
  return {
    spotifySearch: tool(() => JSON.stringify([track])),
    analyzeAudioPreview: tool(() =>
      JSON.stringify({ source: "unavailable", reason: "no_preview" }),
    ),
    lastfm: tool(none),
    search: tool(none),
  };
});
vi.mock("../sources/spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/spotify.js")>()),
  searchTracks: async (query: string, limit: number, signal?: AbortSignal) =>
    JSON.parse(await tools.spotifySearch.invoke({ query, limit }, { signal })),
}));
vi.mock("../sources/audio.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/audio.js")>()),
  resolvePreview: async () => ({
    previewUrl: null,
    match: null,
    detail: "No preview in this test",
  }),
  audioServiceHealth: async () => null,
  analyzeAudioPreview: tools.analyzeAudioPreview,
}));
vi.mock("../sources/lastfm.js", () => ({
  lastfmConfigured: () => true,
  getLastfmTrackTags: tools.lastfm,
  getLastfmArtistTags: tools.lastfm,
  getLastfmSimilarTracks: tools.lastfm,
  getLastfmSimilarArtists: tools.lastfm,
  getLastfmArtistInfo: tools.lastfm,
}));
vi.mock("../sources/search.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/search.js")>()),
  tavilyConfigured: () => true,
  searchSamples: tools.search,
  searchProductionHistory: tools.search,
  searchMusicInfo: tools.search,
}));
vi.mock("../store/cache.js", () => ({
  getCache: () => ({
    getAudio: () => null,
    getNewestAudio: () => null,
    putAudio: () => {},
    getResearch: () => null,
    putResearch: () => {},
  }),
}));
vi.mock(
  "./enricher.js",
  () =>
    ({
      enrichGenealogyWithArtwork: async (genealogy) => ({
        nodes: (genealogy?.nodes ?? []).map(({ id }) => ({ id })),
        complete: true,
      }),
    }) satisfies Partial<typeof import("./enricher.js")>,
);

import { LlmError } from "../llm/errors.js";
import { MusicBrainzRateLimiter } from "../sources/musicbrainz.js";
import { stubFetch } from "../sources/testing/fetchStub.js";
import { runRoute } from "../sources/testing/iceIceBaby.js";
import { TRACKS_NAMESPACE } from "./cacheKeys.js";
import { buildSonicAgentGraph } from "./graph.js";
import type { TrackData } from "./schema.js";
import { type StubCall, stubLlm, testRuntime } from "./testing/stubLlm.js";
import { sentStatements } from "./verifier/testing.js";

const ICE = "875c24bc-fe9e-4ac6-80d3-beaacb70ee43";
const UNDER_PRESSURE = "32c7e292-14f1-4080-bddf-ef852e0a4c59";
const SAMPLES_ID = `musicbrainz:track/recording/${ICE}/samples/recording/${UNDER_PRESSURE}`;
const MODEL_CLAIM = "Ice Ice Baby is built on the bass line of Under Pressure.";
/** A claim on the same record that says more than it: the year of the record sampled. */
const MORE_CLAIM = "Ice Ice Baby takes its bass line from the 1981 single Under Pressure.";

/**
 * The composition: a claim and the sample, as a link of the model's own, on its own node for
 * Under Pressure. `role` "derived" states it the other way round: Under Pressure samples the track.
 */
function compose(role: "source" | "derived" = "source") {
  return {
    claims: [
      {
        text: MODEL_CLAIM,
        about: "sample",
        evidenceIds: [SAMPLES_ID],
        field: null,
        scope: "recording",
      },
      {
        text: MORE_CLAIM,
        about: "sample",
        evidenceIds: [SAMPLES_ID],
        field: null,
        scope: "recording",
      },
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
        role,
        label: "Under Pressure - Queen & David Bowie (1981)",
        trackTitle: "Under Pressure",
        trackArtist: "Queen & David Bowie",
        year: "1981",
      },
    ],
    genealogyLinks: [
      {
        source: "up",
        target: "current",
        type: "sample",
        evidenceIds: [SAMPLES_ID],
        scope: "recording",
      },
    ],
  };
}

const judged: Array<{ claimId: string; text: string }> = [];

function model(composer: () => unknown = compose) {
  return stubLlm((call: StubCall) => {
    if (call.callSite === "composer") return composer();
    if (call.callSite === "verifier") {
      const sent = sentStatements(call);
      judged.push(...sent);
      // A statement that Under Pressure samples the track is contradicted by its record.
      return {
        verdicts: sent.map(({ claimId, text }) =>
          text.startsWith('"Under Pressure')
            ? { claimId, verdict: "contradicted", reason: "The record says the reverse." }
            : { claimId, verdict: "supported", reason: "The record names the sample." },
        ),
      };
    }
    return { nextAction: "done", query: null, reasoning: "enough for this track" };
  });
}

let restoreInterval: () => void;
beforeAll(() => {
  restoreInterval = MusicBrainzRateLimiter.getInstance().setIntervalForTests(0);
});
afterAll(() => restoreInterval());

beforeEach(() => {
  for (const name of ["DISCOGS_TOKEN", "GENIUS_ACCESS_TOKEN", "SHS_API_KEY", "SOURCE_CASSETTE"]) {
    delete process.env[name];
  }
  judged.length = 0;
  stubFetch(runRoute);
  for (const method of ["log", "warn", "error"] as const) {
    vi.spyOn(console, method).mockImplementation(() => {});
  }
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** One run of the whole graph; its one result, the model's calls and the stored results. */
async function analyse(llm: ReturnType<typeof stubLlm>, threadId: string) {
  const store = new InMemoryStore();
  const graph = buildSonicAgentGraph({
    runtime: testRuntime(llm, "2026-10-20T12:00:00.000Z"),
    checkpointer: new MemorySaver(),
    store,
  });
  const complete: TrackData[] = [];
  const stream = await graph.stream(
    { songQuery: "Ice Ice Baby Vanilla Ice" },
    { configurable: { thread_id: threadId }, streamMode: ["custom"] },
  );
  for await (const [, event] of stream as AsyncIterable<
    [string, { type: string; data?: unknown }]
  >) {
    if (event.type === "complete") complete.push(event.data as TrackData);
  }
  expect(complete).toHaveLength(1);
  return {
    result: TrackAnalysis.parse(complete[0]),
    stored: (await store.search(TRACKS_NAMESPACE)).length,
  };
}

describe("code-built claims and links in the analysis graph", () => {
  it("shows the recorded sample as a sourced code link, with the model's duplicate folded in", async () => {
    const llm = model();
    const { result, stored } = await analyse(llm, "code-claims-1");

    // The code link: from the sampled record to the track, sourced through its own claim.
    const samples = result.genealogy.links.filter((link) => link.type === "sample");
    const link = samples.find((l) => l.source === `mb-${UNDER_PRESSURE}`);
    expect(link).toMatchObject({
      target: "current",
      kind: "sourced",
      origin: "code",
      evidenceIds: [SAMPLES_ID],
    });
    expect(linkDisplayKind(link!, resultContext(result))).toBe("sourced");
    expect(result.claims?.find((claim) => claim.id === link?.claimId)).toMatchObject({
      origin: "code",
      kind: "sourced",
      verdict: null,
      about: "sample",
      scope: "recording",
      evidenceIds: [SAMPLES_ID],
    });

    // The model's sample folded into it: no node of its own, no link, no claim, not judged.
    expect(result.genealogy.nodes.some((node) => node.id === "up")).toBe(false);
    expect(result.genealogy.links.filter((l) => l.origin === "model")).toEqual([]);
    expect(samples.filter((l) => l.source === `mb-${UNDER_PRESSURE}`)).toHaveLength(1);
    expect(judged.map((statement) => statement.text)).toEqual([MODEL_CLAIM, MORE_CLAIM]);
    // A claim judged wholly supported by the code claim's record alone, naming nothing the record
    // does not, restates the code claim: it is left out, and counted (restatements.ts). The one
    // that names a year the record does not state stays, with its verdict.
    expect(result.claims?.filter((claim) => claim.origin === "model")).toEqual([
      expect.objectContaining({ text: MORE_CLAIM, verdict: "supported", kind: "sourced" }),
    ]);
    expect(result.run?.verifier).toEqual({ judged: 2, unjudged: 0, restated: 1 });

    // Every code link reads sourced, by the contract's rule.
    const code = result.genealogy.links.filter((l) => l.origin === "code");
    expect(code.length).toBeGreaterThan(1);
    for (const each of code) expect(linkDisplayKind(each, resultContext(result))).toBe("sourced");
    expect(analysisIssues(result)).toEqual([]);
    expect(stored).toBe(1);
  });

  it("judges a model link stated the other way round, and rejects it", async () => {
    const llm = model(() => compose("derived"));
    const { result } = await analyse(llm, "code-claims-reversed");

    const reversed = result.genealogy.links.find((l) => l.origin === "model");
    expect(reversed).toMatchObject({
      source: "current",
      target: `mb-${UNDER_PRESSURE}`,
      type: "sample",
      kind: "inferred",
    });
    const claim = result.claims?.find((c) => c.id === reversed?.claimId);
    expect(claim).toMatchObject({ origin: "model", verdict: "contradicted" });
    expect(claimIsRejected(claim!)).toBe(true);
    expect(judged.map((statement) => statement.text)).toContain(claim?.text);
    // The code link stays sourced beside it.
    const code = result.genealogy.links.find((l) => l.source === `mb-${UNDER_PRESSURE}`);
    expect(linkDisplayKind(code!, resultContext(result))).toBe("sourced");
    expect(analysisIssues(result)).toEqual([]);
  });

  it("keeps the code-built claims and links in the fallback, with no model text", async () => {
    const llm = model(() => {
      throw new LlmError("timeout", "composer: timeout");
    });
    const { result, stored } = await analyse(llm, "code-claims-fallback");

    expect(result).toMatchObject({ modelUnavailable: true, run: { fallback: true } });
    expect(llm.calls.map((call) => call.callSite)).toEqual(["research_planner", "composer"]);
    const link = result.genealogy.links.find((l) => l.source === `mb-${UNDER_PRESSURE}`);
    expect(link).toMatchObject({ type: "sample", kind: "sourced", origin: "code" });
    expect(linkDisplayKind(link!, resultContext(result))).toBe("sourced");
    expect(result.claims?.length).toBeGreaterThan(0);
    expect(result.claims?.every((claim) => claim.origin === "code")).toBe(true);
    expect(analysisIssues(result)).toEqual([]);
    expect(stored).toBe(0);
  });
});
