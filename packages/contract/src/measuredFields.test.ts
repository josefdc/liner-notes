/**
 * Measured fields are structurally absent from every schema a model fills. A model
 * cannot write a tempo, key, loudness, mood or style score, because no field holds one.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AudioFeatures } from "./audio.js";
import { type JsonSchema, toJsonSchema } from "./jsonSchema.js";
import { ComposerOutput, LLM_SCHEMAS, MEASURED_FIELDS } from "./llm.js";

/** Every property name in a JSON Schema, at any depth. */
function propertyNames(schema: unknown, names = new Set<string>()): Set<string> {
  if (Array.isArray(schema)) {
    for (const item of schema) propertyNames(item, names);
  } else if (typeof schema === "object" && schema !== null) {
    const node = schema as JsonSchema;
    if (typeof node.properties === "object" && node.properties !== null) {
      for (const key of Object.keys(node.properties)) names.add(key);
    }
    for (const value of Object.values(node)) propertyNames(value, names);
  }
  return names;
}

const measuredIn = (schema: z.ZodType) =>
  [...propertyNames(toJsonSchema(schema))].filter((name) => MEASURED_FIELDS.includes(name));

const validOutput = {
  claims: [],
  factoids: [],
  genealogyNodes: [],
  genealogyLinks: [],
};

describe("ComposerOutput", () => {
  it("has no bpm or key field", () => {
    expect("bpm" in ComposerOutput.shape).toBe(false);
    expect("key" in ComposerOutput.shape).toBe(false);
  });

  it.each(MEASURED_FIELDS)("has no %s field", (field) => {
    expect(field in ComposerOutput.shape).toBe(false);
  });

  it("rejects an output that carries a measured value", () => {
    expect(ComposerOutput.safeParse(validOutput).success).toBe(true);
    for (const field of ["bpm", "key", "energy", "tempo", "valence"]) {
      expect(ComposerOutput.safeParse({ ...validOutput, [field]: 120 }).success).toBe(false);
    }
  });
});

describe("model-facing schemas", () => {
  it.each(Object.entries(LLM_SCHEMAS))("%s has no measured field at any depth", (_name, schema) => {
    expect(measuredIn(schema)).toEqual([]);
  });

  it("the depth check finds a measured field nested inside an array", () => {
    const leaky = z.strictObject({
      claims: z.array(z.strictObject({ text: z.string(), bpm: z.number().nullable() })),
    });
    expect(measuredIn(leaky)).toEqual(["bpm"]);
  });

  it("the depth check follows union branches (a list of schemas)", () => {
    const leaky = z.strictObject({
      note: z.strictObject({ text: z.string(), tonic: z.string() }).nullable(),
    });
    expect(JSON.stringify(toJsonSchema(leaky))).toContain('"anyOf":[');
    expect(measuredIn(leaky)).toEqual(["tonic"]);
  });
});

describe("MEASURED_FIELDS", () => {
  it("covers every top-level AudioFeatures field, so a new one is protected too", () => {
    for (const field of Object.keys(AudioFeatures.shape)) expect(MEASURED_FIELDS).toContain(field);
  });

  it.each([
    "confidence",
    "tonic",
    "mode",
    "strength",
    "rmsMean",
    "styles",
    "tags",
    "moods",
    "arousal",
    "instrumentalness",
    "audioSource",
    "audioConfidence",
    "audioUnavailableReason",
    "genreProfile",
  ])("covers the nested or provenance name %s", (field) => {
    expect(MEASURED_FIELDS).toContain(field);
  });

  it("covers the measured copies in TrackAnalysis", () => {
    for (const field of [
      "bpm",
      "key",
      "energy",
      "valence",
      "danceability",
      "acousticness",
      "keyMoments",
    ]) {
      expect(MEASURED_FIELDS).toContain(field);
    }
  });
});
