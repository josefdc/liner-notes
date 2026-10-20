/**
 * JSON Schema export and the strict structured-output check for model-facing schemas.
 */

import { z } from "zod/v4";

export type JsonSchema = { [keyword: string]: unknown };

/**
 * The JSON Schema (draft 2020-12) of a contract schema, describing parsed values. Throws when
 * the schema holds something JSON Schema cannot describe (a transform, a date, a function).
 */
export function toJsonSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    io: "output",
  }) as JsonSchema;
}

/** Limits of strict structured output this project holds model-facing schemas to. */
export const AZURE_STRICT_LIMITS = { maxDepth: 5, maxProperties: 100 } as const;

/**
 * Keywords strict mode does not accept. Bounds and formats are checked in code after parsing;
 * `default` would make a field optional; only `anyOf` is accepted for unions.
 */
const FORBIDDEN_KEYWORDS = [
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
 * properties in all, no FORBIDDEN_KEYWORDS, a root that is an object, and no recursive `$ref`.
 */
export function azureStrictViolations(schema: JsonSchema): StrictViolation[] {
  const violations: StrictViolation[] = [];
  const defs = {
    ...(isSchema(schema.definitions) ? schema.definitions : {}),
    ...(isSchema(schema.$defs) ? schema.$defs : {}),
  };
  let properties = 0;

  if (schema.type !== "object") {
    violations.push({ path: "", message: "the root must be an object schema" });
  }

  const visit = (node: unknown, path: string, depth: number, refs: readonly string[]) => {
    if (!isSchema(node)) {
      violations.push({ path, message: "not a schema object (boolean schemas are not accepted)" });
      return;
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

    for (const keyword of FORBIDDEN_KEYWORDS) {
      if (keyword in node) violations.push({ path, message: `uses "${keyword}"` });
    }

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
