/**
 * The analyze stream with the real composer and the real verifier: the routes and the compiled
 * graph are the app's, the scout, engineer and historian are stubs that hand over a track, a
 * measurement and one evidence item, the artwork lookup is stubbed, and the model layer answers
 * from a stub (no network, no spend). The stream carries one `complete`, sent by the verifier,
 * with its verdicts; a judge slower than its share of the run's time costs the verdicts, never
 * the result.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrackAnalysis } from "@liner-notes/contract";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SonicAgentStateType } from "../../agent/state.js";

vi.mock("../../agent/nodes/index.js", async () => {
  const composer = await vi.importActual<typeof import("../../agent/nodes/composerNode.js")>(
    "../../agent/nodes/composerNode.js",
  );
  const { measurementOf, audioV2 } = await vi.importActual<
    typeof import("../../agent/testing/measuredAudio.js")
  >("../../agent/testing/measuredAudio.js");
  return {
    clarificationNode: async () => ({}),
    scoutNode: async () => ({
      selectedBy: "match",
      spotifyData: {
        id: "track-v",
        title: "Ice Ice Baby",
        artist: "Vanilla Ice",
        artistIds: [],
        album: "To the Extreme",
        releaseDate: "1990-09-10",
        coverUrl: "",
        duration: "4:31",
        durationMs: 271_000,
        explicit: false,
        spotifyUrl: "https://open.spotify.com/track/track-v",
        previewUrl: null,
      },
    }),
    engineerNode: async () => ({ audioFeatures: measurementOf(audioV2()) }),
    historianNode: async (_state: SonicAgentStateType) => ({
      evidence: [
        {
          id: "ev-track",
          source: "musicbrainz",
          sourceTier: "primary-record",
          url: "https://musicbrainz.org/recording/x",
          title: "Ice Ice Baby",
          retrievedAt: "2026-01-01T00:00:00.000Z",
          excerpt: "MusicBrainz: Ice Ice Baby samples Under Pressure by Queen & David Bowie",
          recordRef: "track/recording/x/samples/recording/y",
        },
      ],
    }),
    composerNode: composer.composerNode,
    createComposerNode: composer.createComposerNode,
  };
});
vi.mock(
  "../../agent/enricher.js",
  () =>
    ({
      enrichGenealogyWithArtwork: async (genealogy) => ({
        nodes: (genealogy?.nodes ?? []).map(({ id }) => ({ id })),
        complete: true,
      }),
    }) satisfies Partial<typeof import("../../agent/enricher.js")>,
);

import { setJudgeTimingForTests } from "../../agent/verifier/index.js";
import { LlmError } from "../../llm/errors.js";
import { llm } from "../../llm/invoke.js";
import { closeDatabase, initializeDatabase } from "../../store/database.js";
import { createTestApp } from "../testApp.js";
import analyzeRouter, { setRunDeadlineForTests } from "./analyze.js";

const app = createTestApp(analyzeRouter);

type Event = { type: string; [key: string]: unknown };

const COMPOSED = {
  claims: [
    {
      text: "The bass line comes from Under Pressure.",
      about: "sample",
      evidenceIds: ["ev-track"],
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
  ],
  genealogyLinks: [],
};

/** The model layer: the composer writes COMPOSED; the judge answers with `judge`. */
function answering(judge: (signal: AbortSignal | undefined) => Promise<unknown>) {
  return vi
    .spyOn(llm, "invoke")
    .mockImplementation(async (callSite, tier, _input, schema, options) => {
      const answer = callSite === "verifier" ? await judge(options.signal) : COMPOSED;
      return {
        output: schema.parse(answer),
        callId: `call-${callSite}`,
        mode: "live",
        tier,
        deployment: `stub-${tier}`,
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          reasoningTokens: 0,
          usdEst: 0,
          multiplier: 1,
          latencyMs: 1,
          attempts: 1,
        },
      } as never;
    });
}

async function stream(query: string) {
  const res = await request(app)
    .get(`/api/analyze/stream?query=${encodeURIComponent(query)}`)
    .buffer(true)
    .parse((response, callback) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => callback(null, body));
    });
  return (res.body as string)
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Event);
}

describe("the analyze stream with the verifier", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "analyze-verifier-"));
    initializeDatabase(join(dir, "test.db"));
  });
  afterAll(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends one result, from the verifier, with the judge's verdicts", async () => {
    answering(async () => ({
      verdicts: [{ claimId: "c1", verdict: "supported", reason: "The record names it." }],
    }));

    const events = await stream("ice ice baby judged");

    const complete = events.filter((event) => event.type === "complete");
    expect(complete).toHaveLength(1);
    expect(events.at(-1)?.type).toBe("done");
    expect(events.some((event) => event.type === "error")).toBe(false);
    const result = TrackAnalysis.parse(complete[0].data);
    expect(result.claims?.[0]).toMatchObject({ verdict: "supported", kind: "sourced" });
    expect(result.run?.verifier).toEqual({ judged: 1, unjudged: 0 });
    expect(events.some((event) => event.type === "status" && event.node === "verifier")).toBe(true);
  });

  it("sends the result unjudged, not a timeout, when the judge outlasts its share of the run", async () => {
    const restoreDeadline = setRunDeadlineForTests(1500);
    const restoreTiming = setJudgeTimingForTests({ marginMs: 1000, minMs: 50 });
    try {
      // A judge that never answers: only its signal stops it.
      answering(
        (signal) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () =>
              reject(new LlmError("aborted", "verifier: aborted by the caller")),
            );
          }),
      );

      const events = await stream("ice ice baby slow judge");

      expect(events.some((event) => event.type === "error")).toBe(false);
      const complete = events.filter((event) => event.type === "complete");
      expect(complete).toHaveLength(1);
      const result = TrackAnalysis.parse(complete[0].data);
      expect(result.claims?.[0]).toMatchObject({ verdict: null, kind: "inferred" });
      expect(result.run?.verifier).toEqual({ judged: 0, unjudged: 1, failed: true });
    } finally {
      restoreTiming();
      restoreDeadline();
    }
  });
});
