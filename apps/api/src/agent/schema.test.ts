/**
 * Schema contract: the model schema cannot carry measured audio values, measured values are
 * copied from the measurement, and no lyric path remains in the research plan or state.
 */

import { describe, expect, it } from "vitest";
import {
  FactoidSchema,
  FlatTrackDataSchema,
  ResearchPlanSchema,
  transformFlatToTrackData,
} from "./schema.js";
import { SonicAgentState, generateId } from "./state.js";

const flat = FlatTrackDataSchema.parse({
  id: "x",
  title: "T",
  artist: "A",
  album: "Al",
  coverUrl: "https://i.scdn.co/image/x",
  bpm: 999,
  key: "Z Major",
  energy: 0.99,
  audioSource: "analyzed",
  genreProfile: [1, 2, 3, 4, 5].map((i) => ({ genre: `G${i}`, value: 50 })),
  segments: [
    { label: "Intro", start: 0, end: 50, color: "#374151" },
    { label: "Verse", start: 50, end: 90, color: "#1F2937" },
    { label: "Outro", start: 90, end: 100, color: "#374151" },
  ],
  samples: [],
  factoids: [1, 2, 3].map((i) => ({ id: `f${i}`, title: "T", content: "C", type: "trivia" })),
  genealogyNodes: [],
  genealogyLinks: [],
});

describe("model output schema", () => {
  it("has no measured audio fields", () => {
    for (const field of [
      "bpm",
      "key",
      "energy",
      "valence",
      "danceability",
      "acousticness",
      "audioSource",
      "audioConfidence",
    ]) {
      expect(FlatTrackDataSchema.shape).not.toHaveProperty(field);
      expect(flat).not.toHaveProperty(field);
    }
  });

  it("takes measured values from the measurement only", () => {
    const fromMeasurement = transformFlatToTrackData(flat, {
      bpm: 116,
      key: "D Minor",
      energy: 0.72,
      valence: null,
      danceability: null,
      acousticness: null,
      instrumentalness: null,
      confidence: "low",
    });
    expect(fromMeasurement).toMatchObject({
      bpm: 116,
      key: "D Minor",
      energy: 0.72,
      valence: null,
    });

    const unmeasured = transformFlatToTrackData(flat, {
      bpm: null,
      key: null,
      energy: null,
      valence: null,
      danceability: null,
      acousticness: null,
      instrumentalness: null,
      confidence: "low",
      unavailableReason: "service_unavailable",
    });
    expect(unmeasured).toMatchObject({
      bpm: null,
      key: null,
      audioSource: "unavailable",
      audioUnavailableReason: "service_unavailable",
    });
  });
});

describe("lyric paths", () => {
  it("are not research actions or factoid types", () => {
    expect(ResearchPlanSchema.shape.nextAction.options).not.toContain("search_lyrics");
    expect(ResearchPlanSchema.shape.nextAction.options).not.toContain("search_annotations");
    expect(FactoidSchema.shape.type.options).not.toContain("lyrics");
  });

  it("have no field in the graph state", () => {
    const keys = Object.keys(SonicAgentState.spec);
    const research = Object.keys(
      (
        SonicAgentState.spec.researchData as unknown as { initialValueFactory: () => object }
      ).initialValueFactory(),
    );
    for (const key of [...keys, ...research]) expect(key.toLowerCase()).not.toContain("lyric");
  });
});

describe("generateId", () => {
  it("returns distinct UUIDs", () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateId()));
    expect(ids.size).toBe(100);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
