/**
 * assertAzureStrict(): every model-facing schema passes, and each strict-mode rule rejects a
 * schema that breaks only that rule.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AudioFeatures } from "./audio.js";
import {
  AZURE_FORBIDDEN_KEYWORDS,
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

describe("toJsonSchema defaults", () => {
  const field = (schema: z.ZodType, io: "input" | "output") =>
    (toJsonSchema(z.object({ a: schema }), io).properties as Record<string, JsonSchema>).a;

  it("keeps a .catch() fallback zod drops from the input, when it is a valid input", () => {
    // zod drops these from input schemas because the caught schema holds a transform.
    const counted = z.preprocess((value) => value, z.number());
    expect(field(counted.nullable().catch(null), "input")).toMatchObject({ default: null });
    expect(field(counted.catch(5), "input")).toMatchObject({ default: 5 });
  });

  it("does not advertise a fallback that the caught schema would refuse as input", () => {
    const length = z
      .string()
      .transform((text) => text.length)
      .pipe(z.number());
    expect(field(length.catch(5), "input")).not.toHaveProperty("default");
    expect(field(length.catch(5), "output")).toMatchObject({ default: 5 });
  });

  it("records a fallback with no JSON form as a stable marker", () => {
    const big = z.preprocess((value) => value, z.unknown()).catch(10n);
    expect(field(big, "input")).toMatchObject({
      default: { unserializable: "bigint", text: "10" },
    });
  });
});

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

  /** A valid strict schema whose one property `x` is replaced by `node`. */
  const withNode = (node: unknown): JsonSchema => ({
    type: "object",
    properties: { x: node, y: { type: "string" } },
    required: ["x", "y"],
    additionalProperties: false,
  });

  const KEYWORD_VALUES: Record<(typeof AZURE_FORBIDDEN_KEYWORDS)[number], unknown> = {
    minLength: 1,
    maxLength: 2,
    pattern: "^a",
    format: "date-time",
    minimum: 0,
    maximum: 1,
    exclusiveMinimum: 0,
    exclusiveMaximum: 1,
    multipleOf: 2,
    minItems: 1,
    maxItems: 2,
    uniqueItems: true,
    prefixItems: [{ type: "string" }],
    contains: { type: "string" },
    minContains: 1,
    maxContains: 2,
    minProperties: 1,
    maxProperties: 2,
    patternProperties: { "^a": { type: "string" } },
    propertyNames: { type: "string" },
    unevaluatedProperties: false,
    unevaluatedItems: false,
    dependentRequired: { a: ["b"] },
    dependentSchemas: { a: { type: "object" } },
    default: "a",
    allOf: [{ type: "string" }],
    oneOf: [{ type: "string" }],
    not: { type: "number" },
    if: { type: "string" },
    // biome-ignore lint/suspicious/noThenProperty: a JSON Schema keyword, not a thenable
    then: { type: "string" },
    else: { type: "string" },
    const: "a",
  };

  it.each(AZURE_FORBIDDEN_KEYWORDS)("rejects the %s keyword", (keyword) => {
    const violations = azureStrictViolations(
      withNode({ type: "string", [keyword]: KEYWORD_VALUES[keyword] }),
    );
    expect(violations).toContainEqual({ path: "/properties/x", message: `uses "${keyword}"` });
  });

  it.each([
    ["z.unknown()", toJsonSchema(z.strictObject({ x: z.unknown().nullable(), y: z.string() }))],
    ["z.any()", toJsonSchema(z.strictObject({ x: z.any(), y: z.string() }))],
    ["an empty schema", withNode({})],
  ])("rejects an untyped schema: %s", (_name, schema) => {
    expect(() => assertAzureStrict(schema)).toThrow("untyped schema");
  });

  it("rejects a literal (const), conservatively", () => {
    expect(() => assertAzureStrict(strict({ x: z.literal("a") }))).toThrow('uses "const"');
  });

  it("rejects a boolean schema, an unresolved reference and an array without items", () => {
    expect(azureStrictViolations(withNode(true))).toContainEqual({
      path: "/properties/x",
      message: "not a schema object (boolean schemas are not accepted)",
    });
    expect(azureStrictViolations(withNode({ $ref: "#/$defs/Missing" }))).toContainEqual({
      path: "/properties/x",
      message: 'unresolved reference "#/$defs/Missing"',
    });
    expect(azureStrictViolations(withNode({ type: "array" }))).toContainEqual({
      path: "/properties/x",
      message: "array without a single items schema",
    });
  });

  it("checks the keywords written next to a $ref", () => {
    const schema = {
      ...withNode({ $ref: "#/$defs/Name", minLength: 3 }),
      $defs: { Name: { type: "string" } },
    };
    expect(azureStrictViolations(schema)).toEqual([
      { path: "/properties/x", message: 'uses "minLength"' },
    ]);
  });

  it("escapes / and ~ in property names in the pointer it reports", () => {
    const schema = {
      type: "object",
      properties: { "a/b~c": { type: "string", minLength: 1 } },
      required: ["a/b~c"],
      additionalProperties: false,
    };
    expect(azureStrictViolations(schema)).toEqual([
      { path: "/properties/a~1b~0c", message: 'uses "minLength"' },
    ]);
  });

  const values = (n: number, width = 1) =>
    Array.from({ length: n }, (_, i) => `${i}`.padStart(width, "v")) as [string, ...string[]];

  it("enforces the enum budgets: 1000 values in all, 15,000 characters past 250 values", () => {
    const budget = (shape: z.ZodRawShape) => azureStrictViolations(strict(shape));
    expect(budget({ a: z.enum(values(500)), b: z.enum(values(500, 4)) })).toEqual([]);
    expect(budget({ a: z.enum(values(500)), b: z.enum(values(501, 4)) })).toContainEqual({
      path: "",
      message: "1001 enum values in all (at most 1000)",
    });
    // 251 values of 60 characters: 15,060 characters in one large enum.
    expect(budget({ a: z.enum(values(251, 60)) })).toContainEqual({
      path: "/properties/a",
      message: "enum of 251 values totals 15060 characters (at most 15000)",
    });
    // 250 values of 60 characters: not a large enum, but over the character budget.
    expect(budget({ a: z.enum(values(250, 60)) })).toEqual([
      { path: "", message: "15001 characters of names and values (at most 15000)" },
    ]);
  });

  it("enforces the character budget on property names", () => {
    const long = (n: number) =>
      z.strictObject(
        Object.fromEntries(
          Array.from({ length: n }, (_, i) => [`${i}`.padStart(200, "p"), z.string()]),
        ),
      );
    expect(azureStrictViolations(toJsonSchema(long(75)))).toEqual([]);
    expect(azureStrictViolations(toJsonSchema(long(76)))).toEqual([
      { path: "", message: "15200 characters of names and values (at most 15000)" },
    ]);
  });
});
