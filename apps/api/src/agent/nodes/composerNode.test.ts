/**
 * Composer node: measured audio values come from the measurement, never from the model,
 * and a failed model call is reported in the result.
 *
 * The model client, the artwork enricher and the long-term store are stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const model = vi.hoisted(() => ({ generateStructuredOutput: vi.fn() }));
const store = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock("../geminiClient.js", () => ({
  GEMINI_MODEL_PRO: "test-model",
  generateStructuredOutput: model.generateStructuredOutput,
}));
vi.mock("../enricher.js", () => ({
  enrichGenealogyWithArtwork: async (genealogy: unknown) => genealogy,
}));
vi.mock("@langchain/langgraph", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@langchain/langgraph")>()),
  getStore: () => store,
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

  it("adds no model-generated facts when the main call fails and a fast model works", async () => {
    model.generateStructuredOutput.mockImplementation(async ({ tier }) =>
      tier === "pro"
        ? { data: null, model: "pro-model", groundingUsed: false, error: "503 overloaded" }
        : {
            data: {
              factoids: [{ title: "MODEL_FACT", content: "MODEL_FACT invented", type: "trivia" }],
            },
            model: "fast-model",
            groundingUsed: false,
          },
    );

    const out = await composerNode(stateWith(null), config);

    expect(out.trackData?.modelUnavailable).toBe(true);
    expect(JSON.stringify(out.trackData?.factoids)).not.toContain("MODEL_FACT");
    const tiers = model.generateStructuredOutput.mock.calls.map(([options]) => options.tier);
    expect(tiers.every((tier) => tier === "pro")).toBe(true);
  });

  describe("long-term store", () => {
    const succeed = () =>
      model.generateStructuredOutput.mockImplementation(async ({ schema }) => ({
        data: schema.parse(modelOutput),
        model: "test-model",
        groundingUsed: false,
      }));
    const unavailable = (reason: AudioFeatures["unavailableReason"]): AudioFeatures => ({
      ...measured,
      bpm: null,
      key: null,
      energy: null,
      unavailableReason: reason,
    });

    beforeEach(() => store.put.mockClear());

    it.each(["service_unavailable", "analysis_failed"] as const)(
      "does not store a result whose audio failed transiently (%s)",
      async (reason) => {
        succeed();
        await composerNode(stateWith(unavailable(reason)), config);
        expect(store.put).not.toHaveBeenCalled();
      },
    );

    it("does not store a result when audio analysis did not run", async () => {
      succeed();
      await composerNode(stateWith(null), config);
      expect(store.put).not.toHaveBeenCalled();
    });

    it.each(["no_preview", "preview_rejected", "not_detected"] as const)(
      "stores a result whose audio is missing for a stable reason (%s)",
      async (reason) => {
        succeed();
        await composerNode(stateWith(unavailable(reason)), config);
        expect(store.put).toHaveBeenCalledTimes(1);
      },
    );

    it("stores a result with measured audio", async () => {
      succeed();
      await composerNode(stateWith(measured), config);
      expect(store.put).toHaveBeenCalledTimes(1);
    });
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

  it("never sends song-meaning text from older state to the model", async () => {
    model.generateStructuredOutput.mockResolvedValue({ data: null, model: "m", error: "x" });
    const state = stateWith(measured);
    state.researchData = {
      ...state.researchData,
      songMeaning: ["Song meaning page: LINE_OF_SONG_TEXT"],
    };

    await composerNode(state, config);

    const prompt = model.generateStructuredOutput.mock.calls[0][0].prompt as string;
    expect(prompt).not.toContain("SONG_TEXT");
    expect(prompt).not.toContain("songMeaning");
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
