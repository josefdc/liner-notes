/**
 * assertAzureStrict(): every model-facing schema passes, and each strict-mode rule rejects a
 * schema that breaks only that rule.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { AudioFeatures } from "./audio.js";
import {
  AZURE_STRICT_LIMITS,
  AzureStrictError,
  assertAzureStrict,
  azureStrictViolations,
  type JsonSchema,
  toJsonSchema,
} from "./jsonSchema.js";
import { LLM_SCHEMAS } from "./llm.js";
import { TrackAnalysis } from "./track.js";

const strict = (shape: z.ZodRawShape) => toJsonSchema(z.strictObject(shape));

/** `levels` nested objects, the innermost holding one string (the root object is level 1). */
function nested(levels: number): z.ZodObject {
  let schema: z.ZodObject = z.strictObject({ leaf: z.string() });
  for (let i = 1; i < levels; i++) schema = z.strictObject({ child: schema });
  return schema;
}

const objectWithProperties = (count: number) =>
  z.strictObject(
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`p${i}`, z.string()])),
  );

describe("model-facing schemas", () => {
  it.each(Object.entries(LLM_SCHEMAS))("%s passes", (_name, schema) => {
    expect(() => assertAzureStrict(toJsonSchema(schema))).not.toThrow();
  });

  it("include the composer, factoid and judge schemas", () => {
    expect(Object.keys(LLM_SCHEMAS).sort()).toEqual([
      "ComposerOutput",
      "FactoidsOutput",
      "JudgeOutput",
    ]);
  });
});

describe("assertAzureStrict", () => {
  it("accepts nullable fields, enums, arrays and nested objects within the limits", () => {
    const schema = strict({
      text: z.string().nullable(),
      kind: z.enum(["a", "b"]).nullable(),
      list: z.array(z.strictObject({ id: z.string(), ids: z.array(z.string()) })),
      child: z.strictObject({ flag: z.boolean() }).nullable(),
    });
    expect(azureStrictViolations(schema)).toEqual([]);
  });

  it("accepts exactly the depth and property limits", () => {
    expect(azureStrictViolations(toJsonSchema(nested(AZURE_STRICT_LIMITS.maxDepth)))).toEqual([]);
    expect(azureStrictViolations(toJsonSchema(objectWithProperties(100)))).toEqual([]);
  });

  const failures: Array<[string, JsonSchema, RegExp]> = [
    ["an optional field", strict({ a: z.string(), b: z.string().optional() }), /"b" is optional/],
    [
      "an open object (additionalProperties not false)",
      toJsonSchema(z.looseObject({ a: z.string() })),
      /additionalProperties: false/,
    ],
    [
      "an object without additionalProperties",
      { type: "object", properties: { a: { type: "string" } }, required: ["a"] },
      /additionalProperties: false/,
    ],
    ["a string length bound", strict({ a: z.string().min(40).max(240) }), /"minLength"/],
    ["a numeric range", strict({ a: z.number().min(0).max(100) }), /"minimum"/],
    ["an array bound", strict({ a: z.array(z.string()).min(3).max(8) }), /"minItems"/],
    ["a pattern", strict({ a: z.string().regex(/^x/) }), /"pattern"/],
    ["a format", strict({ a: z.email() }), /"format"/],
    ["an integer (zod adds safe-integer bounds)", strict({ a: z.int() }), /"minimum"/],
    ["a default", strict({ a: z.string().default("x") }), /"default"/],
    ["a tuple", strict({ a: z.tuple([z.string(), z.number()]) }), /"prefixItems"/],
    ["a record", strict({ a: z.record(z.string(), z.string()) }), /object without properties/],
    [
      "six levels of nesting",
      toJsonSchema(nested(AZURE_STRICT_LIMITS.maxDepth + 1)),
      /nested 6 levels deep/,
    ],
    [
      "six levels counting arrays",
      strict({ a: z.array(z.array(z.array(z.array(z.array(z.string()))))) }),
      /nested 6 levels deep/,
    ],
    ["101 properties", toJsonSchema(objectWithProperties(101)), /101 properties in all/],
    ["a root that is not an object", toJsonSchema(z.array(z.string())), /root must be an object/],
    [
      "a recursive reference",
      {
        type: "object",
        properties: { node: { $ref: "#/$defs/Node" } },
        required: ["node"],
        additionalProperties: false,
        $defs: {
          Node: {
            type: "object",
            properties: { next: { anyOf: [{ $ref: "#/$defs/Node" }, { type: "null" }] } },
            required: ["next"],
            additionalProperties: false,
          },
        },
      },
      /recursive reference/,
    ],
  ];

  it.each(failures)("rejects %s", (_name, schema, message) => {
    expect(() => assertAzureStrict(schema)).toThrow(AzureStrictError);
    expect(() => assertAzureStrict(schema)).toThrow(message);
  });

  it("reports every violation with its JSON pointer", () => {
    // The shape of the API's current composer schema: optional fields and bounds.
    const legacy = strict({
      title: z.string(),
      releaseYear: z.string().optional(),
      factoids: z
        .array(z.strictObject({ id: z.string() }))
        .min(3)
        .max(8),
      genreProfile: z.array(z.strictObject({ value: z.number().min(0).max(100) })),
    });
    const paths = azureStrictViolations(legacy).map((v) => `${v.path} ${v.message}`);
    expect(paths).toEqual([
      '/properties/releaseYear "releaseYear" is optional (make it required and nullable)',
      '/properties/factoids uses "minItems"',
      '/properties/factoids uses "maxItems"',
      '/properties/genreProfile/items/properties/value uses "minimum"',
      '/properties/genreProfile/items/properties/value uses "maximum"',
    ]);
  });

  it("rejects the payload schemas, which are not meant for a model", () => {
    expect(() => assertAzureStrict(toJsonSchema(TrackAnalysis))).toThrow(AzureStrictError);
    expect(() => assertAzureStrict(toJsonSchema(AudioFeatures))).toThrow(AzureStrictError);
  });
});
