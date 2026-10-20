/**
 * Compatibility of two JSON Schemas of the same contract schema: does the current one still
 * accept every value the snapshot accepted, and still promise every field it promised?
 *
 * Breaking (the contract is additive-only, so these need a deliberate snapshot update):
 * a removed field, a type no longer accepted, a narrower enum or const, a tighter bound,
 * a new pattern or format, a field that became required, or a new required field in an
 * existing object.
 * Additive: new optional fields, new union variants, new enum values, wider types, looser
 * bounds, fields that became optional.
 */

export type Schema = { [keyword: string]: unknown };

interface Facet {
  types: Set<string>;
  enum: unknown[] | null;
  const: unknown;
  hasConst: boolean;
  required: boolean;
  bounds: Map<string, unknown>;
}

const BOUND_KEYWORDS = [
  "minimum",
  "exclusiveMinimum",
  "minLength",
  "minItems",
  "maximum",
  "exclusiveMaximum",
  "maxLength",
  "maxItems",
  "pattern",
  "format",
] as const;
const LOWER_BOUNDS = new Set(["minimum", "exclusiveMinimum", "minLength", "minItems"]);
const UPPER_BOUNDS = new Set(["maximum", "exclusiveMaximum", "maxLength", "maxItems"]);

const isSchema = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The property whose `const` tells the object branches of a union apart: one with a distinct
 * const in every object branch, or any const property of a union with a single branch.
 * Null when the union is not a tagged one (e.g. a nullable object).
 */
function discriminatorKey(branches: unknown[]): string | null {
  const objects = branches.filter(
    (branch): branch is Schema & { properties: Schema } =>
      isSchema(branch) && isSchema(branch.properties),
  );
  if (objects.length === 0 || (objects.length === 1 && branches.length > 1)) return null;
  for (const key of Object.keys(objects[0].properties)) {
    const values = objects.map((branch) => {
      const property = branch.properties[key];
      return isSchema(property) && "const" in property ? JSON.stringify(property.const) : null;
    });
    if (values.every((value) => value !== null) && new Set(values).size === values.length) {
      return key;
    }
  }
  return null;
}

/** Finds the schema a non-local `$ref` points at. */
export type Resolver = (ref: string) => Schema | undefined;

/**
 * Flattens a schema to one facet per field path: `$` is the root, `.name` a property, `[]` the
 * items of an array, `[0]` a tuple position, `{}` the values of a record and `<type=x>` the
 * union variant whose `type` is "x".
 */
export function flattenSchema(
  root: Schema,
  resolve: Resolver = () => undefined,
): Map<string, Facet> {
  const facets = new Map<string, Facet>();
  const defs = { ...(isSchema(root.$defs) ? root.$defs : {}) };

  const facetAt = (path: string, required: boolean): Facet => {
    let facet = facets.get(path);
    if (!facet) {
      facet = {
        types: new Set(),
        enum: null,
        const: undefined,
        hasConst: false,
        required,
        bounds: new Map(),
      };
      facets.set(path, facet);
    }
    return facet;
  };

  const walk = (node: unknown, path: string, required: boolean, seen: readonly string[]) => {
    if (!isSchema(node)) return;
    if (typeof node.$ref === "string") {
      // A local definition, or another schema of the contract (an `<id>.schema.json` ref).
      const ref = node.$ref;
      if (seen.includes(ref)) {
        facetAt(path, required).types.add(`ref:${ref}`);
        return;
      }
      const local = ref.startsWith("#/$defs/") ? defs[ref.slice("#/$defs/".length)] : undefined;
      const target = local ?? resolve(ref);
      if (target) walk(target, path, required, [...seen, ref]);
      else facetAt(path, required).types.add(`unresolved:${ref}`);
      return;
    }

    const facet = facetAt(path, required);
    const branches = Array.isArray(node.anyOf) ? node.anyOf : node.oneOf;
    if (Array.isArray(branches)) {
      const key = discriminatorKey(branches);
      for (const branch of branches) {
        if (!isSchema(branch)) continue;
        if (branch.type === "null") {
          facet.types.add("null");
          continue;
        }
        const tag = key && isSchema(branch.properties) ? branch.properties[key] : undefined;
        if (isSchema(tag)) {
          facet.types.add("object");
          walk(branch, `${path}<${key}=${String(tag.const)}>`, false, seen);
        } else {
          walk(branch, path, required, seen);
        }
      }
      return;
    }

    const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
    for (const type of types) facet.types.add(String(type));
    if (types.length === 0 && "const" in node) facet.types.add(typeof node.const);
    if (Array.isArray(node.enum)) facet.enum = [...(facet.enum ?? []), ...node.enum];
    if ("const" in node) {
      facet.const = node.const;
      facet.hasConst = true;
    }
    for (const keyword of BOUND_KEYWORDS) {
      if (keyword in node) facet.bounds.set(keyword, node[keyword]);
    }

    if (isSchema(node.properties)) {
      const requiredKeys = new Set(Array.isArray(node.required) ? node.required : []);
      for (const [key, value] of Object.entries(node.properties)) {
        walk(value, `${path}.${key}`, requiredKeys.has(key), seen);
      }
    }
    if (Array.isArray(node.prefixItems)) {
      node.prefixItems.forEach((item, index) => {
        walk(item, `${path}[${index}]`, true, seen);
      });
    }
    if (isSchema(node.items)) walk(node.items, `${path}[]`, true, seen);
    if (isSchema(node.additionalProperties)) {
      walk(node.additionalProperties, `${path}{}`, false, seen);
    }
  };

  walk(root, "$", true, []);
  return facets;
}

const parentOf = (path: string) => path.replace(/(\.[^.[<{]+|\[\d*\]|<[^>]*>|\{\})$/, "") || "$";

const accepts = (types: Set<string>, type: string) =>
  types.has(type) || (type === "integer" && types.has("number"));

export interface Compatibility {
  breaking: string[];
  additive: string[];
}

/** What changed from `snapshot` to `current`, split into breaking and additive changes. */
export function compareSchemas(
  snapshot: Schema,
  current: Schema,
  resolve: { snapshot?: Resolver; current?: Resolver } = {},
): Compatibility {
  const before = flattenSchema(snapshot, resolve.snapshot);
  const after = flattenSchema(current, resolve.current);
  const breaking: string[] = [];
  const additive: string[] = [];

  for (const [path, old] of before) {
    const now = after.get(path);
    if (!now) {
      breaking.push(`${path}: removed`);
      continue;
    }

    for (const type of old.types) {
      if (!accepts(now.types, type)) breaking.push(`${path}: no longer accepts ${type}`);
    }
    for (const type of now.types) {
      if (!accepts(old.types, type)) additive.push(`${path}: now also accepts ${type}`);
    }

    if (!old.required && now.required) breaking.push(`${path}: now required`);
    if (old.required && !now.required) additive.push(`${path}: now optional`);

    if (now.enum) {
      if (!old.enum) {
        breaking.push(`${path}: now restricted to ${JSON.stringify(now.enum)}`);
      } else {
        const dropped = old.enum.filter((value) => !now.enum?.some((v) => same(v, value)));
        const added = now.enum.filter((value) => !old.enum?.some((v) => same(v, value)));
        if (dropped.length) breaking.push(`${path}: enum drops ${JSON.stringify(dropped)}`);
        if (added.length) additive.push(`${path}: enum adds ${JSON.stringify(added)}`);
      }
    } else if (old.enum) {
      additive.push(`${path}: no longer an enum`);
    }

    if (now.hasConst && (!old.hasConst || !same(old.const, now.const))) {
      breaking.push(`${path}: const is now ${JSON.stringify(now.const)}`);
    } else if (old.hasConst && !now.hasConst) {
      additive.push(`${path}: no longer a const`);
    }

    for (const [keyword, value] of now.bounds) {
      const had = old.bounds.has(keyword);
      const previous = old.bounds.get(keyword);
      const tighter =
        !had ||
        (LOWER_BOUNDS.has(keyword) && Number(value) > Number(previous)) ||
        (UPPER_BOUNDS.has(keyword) && Number(value) < Number(previous)) ||
        ((keyword === "pattern" || keyword === "format") && !same(value, previous));
      if (tighter) breaking.push(`${path}: ${keyword} is now ${JSON.stringify(value)}`);
      else if (!same(value, previous)) additive.push(`${path}: ${keyword} loosened`);
    }
    for (const keyword of old.bounds.keys()) {
      if (!now.bounds.has(keyword)) additive.push(`${path}: ${keyword} removed`);
    }
  }

  for (const [path, facet] of after) {
    if (before.has(path)) continue;
    const inExistingObject = before.has(parentOf(path)) && !path.endsWith(">");
    if (facet.required && inExistingObject && !/(\[\d*\]|\{\})$/.test(path)) {
      breaking.push(`${path}: new required field`);
    } else {
      additive.push(`${path}: added`);
    }
  }

  return { breaking, additive };
}
