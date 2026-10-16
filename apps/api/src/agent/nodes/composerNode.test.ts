/**
 * Composer node: measured audio values come from the measurement, never from the model,
 * and a failed model call is reported in the result.
 *
 * The model client, the artwork enricher and the long-term store are stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const model = vi.hoisted(() => ({ generateStructuredOutput: vi.fn() }));
vi.mock("../geminiClient.js", () => ({
  GEMINI_MODEL_PRO: "test-model",
  generateStructuredOutput: model.generateStructuredOutput,
}));
vi.mock("../enricher.js", () => ({
  enrichGenealogyWithArtwork: async (genealogy: unknown) => genealogy,
}));
vi.mock("@langchain/langgraph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langchain/langgraph")>()),
  getStore: () => undefined,
}));

import { composerNode } from "./composerNode.js";
import type { AudioFeatures, SonicAgentStateType } from "../state.js";

// What a model might return, including measured fields it must not be able to set.
const modelOutput = {
  id: "wrong-id",
  title: "Ice Ice Baby",
  artist: "Vanilla Ice",
  album: "To the Extreme",
  coverUrl: "https://i.scdn.co/image/x",
  bpm: 999,
  key: "Z Major",
  energy: 0.99,
  valence: 0.99,
  danceability: 0.99,
  acousticness: 0.99,
  audioSource: "analyzed",
  audioConfidence: "high",
  genreProfile: [1, 2, 3, 4, 5].map((i) => ({ genre: `G${i}`, value: 50 })),
  segments: [
    { label: "Intro", start: 0, end: 50, color: "#374151" },
    { label: "Verse", start: 50, end: 90, color: "#1F2937" },
    { label: "Outro", start: 90, end: 100, color: "#374151" },
  ],
  samples: [],
  factoids: [1, 2, 3].map((i) => ({ id: `f${i}`, title: "T", content: "C", type: "trivia" })),
  genealogyNodes: [{ id: "current", group: 1, label: "Ice Ice Baby", size: 40 }],
  genealogyLinks: [],
};

const measured: AudioFeatures = {
  bpm: 116,
  key: "D Minor",
  energy: 0.72,
  valence: null,
  danceability: null,
  acousticness: null,
  instrumentalness: null,
  confidence: "low",
  keyMoments: [],
};

function stateWith(audioFeatures: AudioFeatures | null): SonicAgentStateType {
  return {
    songQuery: "ice ice baby",
    spotifyData: {
      id: "x",
      title: "Ice Ice Baby",
      artist: "Vanilla Ice",
      artistIds: [],
      album: "To the Extreme",
      releaseDate: "1990-09-10",
      coverUrl: "https://i.scdn.co/image/x",
      popularity: 70,
      duration: "4:30",
      durationMs: 270000,
      explicit: false,
      spotifyUrl: "https://open.spotify.com/track/x",
      previewUrl: null,
    },
    audioFeatures,
    researchData: { samples: [], productionTrivia: [], songMeaning: [], relatedArtists: [] },
  } as unknown as SonicAgentStateType;
}

const config = { writer: () => {} } as never;

describe("composerNode", () => {
  beforeEach(() => {
    model.generateStructuredOutput.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses the measured tempo and key, not the model's", async () => {
    model.generateStructuredOutput.mockImplementation(async ({ schema }) => ({
      data: schema.parse(modelOutput),
      model: "test-model",
      groundingUsed: false,
    }));

    const out = await composerNode(stateWith(measured), config);

    expect(out.trackData).toMatchObject({
      id: "x",
      bpm: 116,
      key: "D Minor",
      energy: 0.72,
      valence: null,
      danceability: null,
      acousticness: null,
      audioSource: "analyzed",
      audioConfidence: "low",
      segmentsSource: "inferred",
    });
    expect(out.trackData?.modelUnavailable).toBeUndefined();
  });

  it("returns null audio values with a reason when nothing was measured", async () => {
    model.generateStructuredOutput.mockImplementation(async ({ schema }) => ({
      data: schema.parse(modelOutput),
      model: "test-model",
      groundingUsed: false,
    }));

    const out = await composerNode(stateWith(null), config);

    expect(out.trackData).toMatchObject({
      bpm: null,
      key: null,
      energy: null,
      audioSource: "unavailable",
      audioUnavailableReason: "not_run",
    });
  });

  it("says so, with the reason, when the model call fails", async () => {
    model.generateStructuredOutput.mockResolvedValue({
      data: null,
      model: "test-model",
      groundingUsed: false,
      error: JSON.stringify({
        error: { code: 400, message: "API key not valid.", status: "INVALID_ARGUMENT" },
      }),
    });

    const out = await composerNode(stateWith(null), config);

    expect(out.trackData).toMatchObject({
      modelUnavailable: true,
      modelUnavailableReason: "API key not valid. (INVALID_ARGUMENT)",
      bpm: null,
      key: null,
      segmentsSource: "template",
    });
    const status = out.statusMessages?.join(" ") ?? "";
    expect(status).toContain("API key not valid.");
    expect(status).not.toMatch(/complete/i);
  });
});
