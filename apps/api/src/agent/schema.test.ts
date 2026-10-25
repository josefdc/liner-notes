/**
 * Schema contract: the result carries measured values copied from the measurement only, no
 * model-facing schema lives here (they are in @liner-notes/contract), and no lyric path
 * remains in the research plan or state.
 */

import { ResearchAction } from "@liner-notes/contract";
import { describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { measuredAudioFields } from "./finalize.js";
import { FactoidSchema } from "./schema.js";
import { SonicAgentState, generateId } from "./state.js";
import { audioV2, measurementOf } from "./testing/measuredAudio.js";

describe("result schema", () => {
  it("defines no model-facing schema", () => {
    for (const name of [
      "FlatTrackDataSchema",
      "FlatFactoidSchema",
      "ResearchPlanSchema",
      "HITLConfigSchema",
      "transformFlatToTrackData",
    ]) {
      expect(schema).not.toHaveProperty(name);
    }
  });

  it("takes measured values from the measurement only", () => {
    expect(measuredAudioFields(measurementOf(audioV2()))).toMatchObject({
      bpm: 116,
      key: "D Minor",
      energy: 0.64,
      valence: 0.21,
      audio: audioV2(),
    });

    expect(
      measuredAudioFields({ audio: null, unavailableReason: "service_unavailable" }),
    ).toMatchObject({
      bpm: null,
      key: null,
      audioSource: "unavailable",
      audioUnavailableReason: "service_unavailable",
    });
  });
});

describe("lyric paths", () => {
  it("are not research actions or factoid types", () => {
    expect(ResearchAction.options).not.toContain("search_lyrics");
    expect(ResearchAction.options).not.toContain("search_annotations");
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
