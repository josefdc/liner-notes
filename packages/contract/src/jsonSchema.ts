/**
 * JSON Schema export and the strict structured-output check for model-facing schemas.
 *
 * The strict rules follow the provider documentation as read on 2026-10-20:
 * - Azure OpenAI, "How to use structured outputs" (updated 2026-08-24),
 *   https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/structured-outputs :
 *   supported types string, number, boolean, integer, object, array, enum and anyOf (a root
 *   that is not anyOf); every field required; `additionalProperties: false`; at most 100
 *   object properties and five levels of nesting; unsupported keywords minLength, maxLength,
 *   pattern, format, minimum, maximum, multipleOf, patternProperties, unevaluatedProperties,
 *   propertyNames, minProperties, maxProperties, unevaluatedItems, contains, minContains,
 *   maxContains, minItems, maxItems and uniqueItems.
 * - OpenAI, "Structured Outputs", supported schemas,
 *   https://developers.openai.com/api/docs/guides/structured-outputs : composition keywords
 *   (allOf, not, dependentRequired, dependentSchemas, if, then, else) are not supported; at
 *   most 1000 enum values in a schema; an enum of more than 250 string values may total at
 *   most 15,000 characters; property names, definition names, enum and const values may total
 *   at most 120,000 characters.
 * Where the two differ or are silent, the stricter reading wins: Azure's 100 properties and
 * five levels, a 15,000-character budget for names and values, no `const` (Azure does not
 * list it), no untyped schemas, no `$ref` recursion and no tuples.
 */

import { z } from "zod";

export type JsonSchema = { [keyword: string]: unknown };

/**
 * The JSON Schema (draft 2020-12) of a contract schema, describing parsed values. Throws when
 * the schema holds something JSON Schema cannot describe (a transform, a date, a function).
 */
export function toJsonSchema(schema: z.ZodType, io: "input" | "output" = "output"): JsonSchema {
  return z.toJSONSchema(schema, jsonSchemaOptions(io)) as JsonSchema;
}

/**
 * A default or `.catch()` fallback as JSON. A value with no JSON form (a bigint, a cycle) throws,
 * as zod's own export does for such a default.
 */
const asJson = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/**
 * Options shared by every JSON Schema export: draft 2020-12, nothing unrepresentable, and
 * tuples closed (`items: false` and an exact length), which zod leaves open.
 */
export function jsonSchemaOptions(io: "input" | "output") {
  return {
    target: "draft-2020-12" as const,
    unrepresentable: "throw" as const,
    io,
    override(ctx: { zodSchema: unknown; jsonSchema: JsonSchema }) {
      const def = (
        ctx.zodSchema as {
          _zod: {
            def: {
              type: string;
              rest?: unknown;
              items?: [];
              defaultValue?: unknown;
              catchValue?: (ctx: unknown) => unknown;
              innerType?: z.core.$ZodType;
            };
          };
        }
      )._zod.def;
      // zod leaves out the default of a defaulted pipe (a tolerant list); keep it visible.
      if (def.type === "default" && !("default" in ctx.jsonSchema)) {
        ctx.jsonSchema.default = asJson(def.defaultValue);
      }
      // In input schemas zod also drops the fallback of a `.catch()` around anything holding a
      // transform, since a default there would be an output value. Keep it visible when it is
      // also a valid input of the caught schema (null for an unreadable optional value).
      if (
        def.type === "catch" &&
        def.catchValue &&
        def.innerType &&
        !("default" in ctx.jsonSchema)
      ) {
        const fallback = def.catchValue(undefined);
        if (fallback !== undefined && z.safeParse(def.innerType, fallback).success) {
          ctx.jsonSchema.default = asJson(fallback);
        }
      }
      if (def.type === "tuple" && !def.rest && def.items) {
        ctx.jsonSchema.items = false;
        ctx.jsonSchema.minItems = def.items.length;
        ctx.jsonSchema.maxItems = def.items.length;
      }
    },
  };
}

/** Limits of strict structured output this project holds model-facing schemas to. */
export const AZURE_STRICT_LIMITS = {
  maxDepth: 5,
  maxProperties: 100,
  maxEnumValues: 1000,
  /** An enum with more than this many string values is held to `maxLargeEnumCharacters`. */
  largeEnumValues: 250,
  maxLargeEnumCharacters: 15_000,
  /** Property names, definition names, enum and const values, all together. */
  maxCharacters: 15_000,
} as const;

/**
 * Keywords strict mode does not accept. Bounds and formats are checked in code after parsing;
 * `default` would make a field optional; only `anyOf` is accepted for unions.
 */
export const AZURE_FORBIDDEN_KEYWORDS = [
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
  "prefixItems",
  "contains",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "patternProperties",
  "propertyNames",
  "unevaluatedProperties",
  "unevaluatedItems",
  "dependentRequired",
  "dependentSchemas",
  "default",
  "allOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "const",
] as const;

export interface StrictViolation {
  /** JSON Pointer to the offending schema node ("" is the root). */
  path: string;
  message: string;
}

const isSchema = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pointer = (path: string, ...parts: Array<string | number>) =>
  parts.reduce<string>(
    (out, part) => `${out}/${String(part).replace(/~/g, "~0").replace(/\//g, "~1")}`,
    path,
  );

/**
 * Every way `schema` breaks the strict structured-output rules: each object closed
 * (`additionalProperties: false`) with every property required (nullable, not optional), at
 * most 5 levels of nested objects and arrays (the root object is level 1), at most 100
 * properties in all, no AZURE_FORBIDDEN_KEYWORDS, a type on every value, the enum and
 * character budgets, a root that is an object, and no recursive `$ref`.
 */
export function azureStrictViolations(schema: JsonSchema): StrictViolation[] {
  const violations: StrictViolation[] = [];
  const defs = {
    ...(isSchema(schema.definitions) ? schema.definitions : {}),
    ...(isSchema(schema.$defs) ? schema.$defs : {}),
  };
  let properties = 0;
  let enumValues = 0;
  let characters = Object.keys(defs).reduce((sum, name) => sum + name.length, 0);

  if (schema.type !== "object") {
    violations.push({ path: "", message: "the root must be an object schema" });
  }

  const visit = (node: unknown, path: string, depth: number, refs: readonly string[]) => {
    if (!isSchema(node)) {
      violations.push({ path, message: "not a schema object (boolean schemas are not accepted)" });
      return;
    }

    // Keywords next to a $ref apply too, so they are checked before the ref is followed.
    for (const keyword of AZURE_FORBIDDEN_KEYWORDS) {
      if (keyword in node) violations.push({ path, message: `uses "${keyword}"` });
    }

    if (typeof node.$ref === "string") {
      const name = node.$ref.replace(/^#\/(\$defs|definitions)\//, "");
      if (refs.includes(name)) {
        violations.push({ path, message: `recursive reference "${node.$ref}"` });
        return;
      }
      const target = defs[name];
      if (!isSchema(target)) {
        violations.push({ path, message: `unresolved reference "${node.$ref}"` });
        return;
      }
      visit(target, path, depth, [...refs, name]);
      return;
    }

    const hasType = typeof node.type === "string" || Array.isArray(node.type);
    if (!hasType && !Array.isArray(node.anyOf) && !Array.isArray(node.enum)) {
      violations.push({ path, message: "untyped schema (every value needs a type)" });
    }
    if (Array.isArray(node.enum)) {
      enumValues += node.enum.length;
      const text = node.enum.reduce<number>((sum, value) => sum + String(value).length, 0);
      characters += text;
      if (
        node.enum.length > AZURE_STRICT_LIMITS.largeEnumValues &&
        text > AZURE_STRICT_LIMITS.maxLargeEnumCharacters
      ) {
        violations.push({
          path,
          message: `enum of ${node.enum.length} values totals ${text} characters (at most ${AZURE_STRICT_LIMITS.maxLargeEnumCharacters})`,
        });
      }
    }
    if ("const" in node) characters += String(node.const).length;

    const types = Array.isArray(node.type) ? node.type : [node.type];
    const isObject = types.includes("object") || "properties" in node;
    const isArray = types.includes("array") || "items" in node;
    const level = isObject || isArray ? depth + 1 : depth;
    if ((isObject || isArray) && level > AZURE_STRICT_LIMITS.maxDepth) {
      violations.push({
        path,
        message: `nested ${level} levels deep (at most ${AZURE_STRICT_LIMITS.maxDepth})`,
      });
    }

    if (isObject) {
      const props = isSchema(node.properties) ? node.properties : {};
      const keys = Object.keys(props);
      properties += keys.length;
      characters += keys.reduce((sum, key) => sum + key.length, 0);
      if (node.additionalProperties !== false) {
        violations.push({ path, message: "object without additionalProperties: false" });
      }
      if (keys.length === 0) {
        violations.push({ path, message: "object without properties" });
      }
      const required = new Set(Array.isArray(node.required) ? node.required : []);
      for (const key of keys) {
        if (!required.has(key)) {
          violations.push({
            path: pointer(path, "properties", key),
            message: `"${key}" is optional (make it required and nullable)`,
          });
        }
        visit(props[key], pointer(path, "properties", key), level, refs);
      }
    }

    if (isArray) {
      if (!isSchema(node.items)) {
        violations.push({ path, message: "array without a single items schema" });
      } else {
        visit(node.items, pointer(path, "items"), level, refs);
      }
    }

    if (Array.isArray(node.anyOf)) {
      node.anyOf.forEach((branch, index) => {
        visit(branch, pointer(path, "anyOf", index), depth, refs);
      });
    }
  };

  visit(schema, "", 0, []);

  if (enumValues > AZURE_STRICT_LIMITS.maxEnumValues) {
    violations.push({
      path: "",
      message: `${enumValues} enum values in all (at most ${AZURE_STRICT_LIMITS.maxEnumValues})`,
    });
  }
  if (characters > AZURE_STRICT_LIMITS.maxCharacters) {
    violations.push({
      path: "",
      message: `${characters} characters of names and values (at most ${AZURE_STRICT_LIMITS.maxCharacters})`,
    });
  }
  if (properties > AZURE_STRICT_LIMITS.maxProperties) {
    violations.push({
      path: "",
      message: `${properties} properties in all (at most ${AZURE_STRICT_LIMITS.maxProperties})`,
    });
  }
  return violations;
}

export class AzureStrictError extends Error {
  constructor(readonly violations: StrictViolation[]) {
    super(
      `Schema is not valid for strict structured output:\n${violations
        .map((violation) => `  ${violation.path || "(root)"}: ${violation.message}`)
        .join("\n")}`,
    );
    this.name = "AzureStrictError";
  }
}

/** Throws an AzureStrictError listing every violation; returns nothing when the schema passes. */
export function assertAzureStrict(schema: JsonSchema): void {
  const violations = azureStrictViolations(schema);
  if (violations.length > 0) throw new AzureStrictError(violations);
}
