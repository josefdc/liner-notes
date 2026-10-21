/**
 * Compatibility of two JSON Schemas of the same contract schema. The contract is additive-only,
 * and the check runs on both sides of a parse:
 *
 * - `input` (what a reader accepts): every payload the old schema accepted must still be
 *   accepted. Breaking: a removed field, a type or enum value no longer accepted, a tighter
 *   bound, a new pattern, format or multipleOf, a field that became required or lost its
 *   default, a default (or `.catch()` fallback) whose value changed, a default other than null
 *   added to an existing field (a missing value would read as that value instead of as
 *   missing), a new required field, an object that now rejects unknown keys, record keys that
 *   are narrower, a tuple that grows or closes.
 * - `output` (what a parse guarantees): every field a reader could rely on is still there and
 *   still required. Breaking: a removed field, a required field made optional, a type or enum
 *   value removed, a default whose value changed.
 *
 * Additive in both: new optional fields (or new fields with a default), new union variants,
 * new enum values, wider types, looser bounds, a null default added to an existing field.
 */

export type Schema = { [keyword: string]: unknown };
export type Mode = "input" | "output";

/** Finds the schema a non-local `$ref` points at. */
export type Resolver = (ref: string) => Schema | undefined;

interface Facet {
  types: Set<string>;
  /** Values the field is restricted to (enum or const); null when any value of its types. */
  values: unknown[] | null;
  /** True once a visit allowed any value of its types (so the union is open). */
  open: boolean;
  required: boolean;
  /** Bounds, pattern, format and multipleOf; across union branches the loosest one is kept. */
  bounds: Map<string, unknown>;
  visits: number;
  hasDefault: boolean;
  /** The default values seen at this path, as sorted JSON (a JSON Schema default is JSON). */
  defaults: string[];
  /** For objects: true when unknown keys are rejected (`additionalProperties: false`). */
  closed: boolean | null;
  /** For arrays: true when no items beyond the tuple positions are allowed (`items: false`). */
  itemsClosed: boolean;
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
  "multipleOf",
  "pattern",
  "format",
] as const;
const LOWER_BOUNDS = new Set(["minimum", "exclusiveMinimum", "minLength", "minItems"]);
const UPPER_BOUNDS = new Set(["maximum", "exclusiveMaximum", "maxLength", "maxItems"]);

const isSchema = (value: unknown): value is Schema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A default as JSON text; a value with no JSON form (a bigint, a cycle) as a stable marker. */
function defaultText(value: unknown): string {
  try {
    const text = JSON.stringify(value);
    if (text !== undefined) return text;
  } catch {
    // No JSON form; the marker below.
  }
  return `<${typeof value} ${String(value)}>`;
}

/** The looser of two values of the same bound, or undefined when they cannot be compared. */
function looser(keyword: string, a: unknown, b: unknown): unknown {
  if (same(a, b)) return a;
  if (LOWER_BOUNDS.has(keyword)) return Math.min(Number(a), Number(b));
  if (UPPER_BOUNDS.has(keyword)) return Math.max(Number(a), Number(b));
  return undefined;
}

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

/**
 * Flattens a schema to one facet per field path: `$` is the root, `.name` a property, `[]` the
 * items of an array, `[0]` a tuple position, `{}` the values of a record, `{key}` its keys and
 * `<type=x>` the union variant whose `type` is "x". `allOf` branches and untagged union
 * branches describe the same path.
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
        values: null,
        open: false,
        required,
        bounds: new Map(),
        visits: 0,
        hasDefault: false,
        defaults: [],
        closed: null,
        itemsClosed: false,
      };
      facets.set(path, facet);
    }
    if (required) facet.required = true;
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
    if ("default" in node && node.default !== undefined) {
      facet.hasDefault = true;
      const value = defaultText(node.default);
      if (!facet.defaults.includes(value)) facet.defaults = [...facet.defaults, value].sort();
    }

    if (Array.isArray(node.allOf)) {
      for (const branch of node.allOf) walk(branch, path, required, seen);
    }

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
    if (Array.isArray(node.allOf) && node.type === undefined) return;

    const types = Array.isArray(node.type) ? node.type : node.type ? [node.type] : [];
    for (const type of types) facet.types.add(String(type));
    if (types.length === 0 && "const" in node) facet.types.add(typeof node.const);

    const values = Array.isArray(node.enum) ? node.enum : "const" in node ? [node.const] : null;
    if (values) facet.values = [...(facet.values ?? []), ...values];
    else facet.open = true;

    const visit = facet.visits++;
    for (const keyword of BOUND_KEYWORDS) {
      if (visit === 0) {
        if (keyword in node) facet.bounds.set(keyword, node[keyword]);
      } else if (facet.bounds.has(keyword)) {
        const merged =
          keyword in node ? looser(keyword, facet.bounds.get(keyword), node[keyword]) : undefined;
        if (merged === undefined) facet.bounds.delete(keyword);
        else facet.bounds.set(keyword, merged);
      }
    }

    const isObject = types.includes("object") || isSchema(node.properties);
    if (isObject) {
      const closed = node.additionalProperties === false;
      facet.closed = facet.closed === null ? closed : facet.closed && closed;
    }
    if (isSchema(node.properties)) {
      const requiredKeys = new Set(Array.isArray(node.required) ? node.required : []);
      for (const [key, value] of Object.entries(node.properties)) {
        walk(value, `${path}.${key}`, requiredKeys.has(key), seen);
      }
    }
    if (isSchema(node.propertyNames)) walk(node.propertyNames, `${path}{key}`, true, seen);
    if (isSchema(node.additionalProperties)) {
      walk(node.additionalProperties, `${path}{}`, false, seen);
    }
    if (Array.isArray(node.prefixItems)) {
      node.prefixItems.forEach((item, index) => {
        walk(item, `${path}[${index}]`, true, seen);
      });
    }
    if (node.items === false) facet.itemsClosed = true;
    if (isSchema(node.items)) walk(node.items, `${path}[]`, true, seen);
  };

  walk(root, "$", true, []);
  return facets;
}

const parentOf = (path: string) =>
  path.replace(/(\.[^.[<{]+|\[\d*\]|<[^>]*>|\{key\}|\{\})$/, "") || "$";

const accepts = (types: Set<string>, type: string) =>
  types.has(type) || (type === "integer" && types.has("number"));

const restriction = (facet: Facet) => (facet.open ? null : facet.values);

export interface Compatibility {
  breaking: string[];
  additive: string[];
}

/** What changed from `snapshot` to `current` on one side of a parse (see the module comment). */
export function compareSchemas(
  snapshot: Schema,
  current: Schema,
  options: { mode?: Mode; snapshot?: Resolver; current?: Resolver } = {},
): Compatibility {
  const mode = options.mode ?? "input";
  const before = flattenSchema(snapshot, options.snapshot);
  const after = flattenSchema(current, options.current);
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

    if (old.required !== now.required) {
      const tighter = mode === "input" ? now.required : !now.required;
      const change = now.required ? "now required" : "now optional";
      (tighter ? breaking : additive).push(`${path}: ${change}`);
    }

    if (mode === "input" && old.hasDefault !== now.hasDefault) {
      if (old.hasDefault) breaking.push(`${path}: default removed`);
      else if (now.defaults.every((value) => value === "null")) {
        additive.push(`${path}: default added`);
      } else breaking.push(`${path}: default added ${now.defaults.join(" | ")}`);
    }
    if (old.hasDefault && now.hasDefault && !same(old.defaults, now.defaults)) {
      breaking.push(`${path}: default is now ${now.defaults.join(" | ")}`);
    }

    const oldValues = restriction(old);
    const newValues = restriction(now);
    if (newValues) {
      if (!oldValues) {
        breaking.push(`${path}: now restricted to ${JSON.stringify(newValues)}`);
      } else {
        const dropped = oldValues.filter((value) => !newValues.some((v) => same(v, value)));
        const added = newValues.filter((value) => !oldValues.some((v) => same(v, value)));
        if (dropped.length) breaking.push(`${path}: no longer accepts ${JSON.stringify(dropped)}`);
        if (added.length) additive.push(`${path}: now also accepts ${JSON.stringify(added)}`);
      }
    } else if (oldValues) {
      additive.push(`${path}: no longer restricted to listed values`);
    }

    for (const [keyword, value] of now.bounds) {
      const had = old.bounds.has(keyword);
      const previous = old.bounds.get(keyword);
      const tighter =
        !had ||
        (LOWER_BOUNDS.has(keyword) && Number(value) > Number(previous)) ||
        (UPPER_BOUNDS.has(keyword) && Number(value) < Number(previous)) ||
        (!LOWER_BOUNDS.has(keyword) && !UPPER_BOUNDS.has(keyword) && !same(value, previous));
      if (tighter) breaking.push(`${path}: ${keyword} is now ${JSON.stringify(value)}`);
      else if (!same(value, previous)) additive.push(`${path}: ${keyword} loosened`);
    }
    for (const keyword of old.bounds.keys()) {
      if (!now.bounds.has(keyword)) additive.push(`${path}: ${keyword} removed`);
    }

    if (
      mode === "input" &&
      old.closed !== null &&
      now.closed !== null &&
      old.closed !== now.closed
    ) {
      (now.closed ? breaking : additive).push(
        `${path}: ${now.closed ? "now rejects unknown keys" : "now accepts unknown keys"}`,
      );
    }
    if (mode === "input" && !old.itemsClosed && now.itemsClosed) {
      breaking.push(`${path}: no longer accepts extra items`);
    }
  }

  for (const [path, facet] of after) {
    if (before.has(path)) continue;
    const inExisting = before.has(parentOf(path)) && !path.endsWith(">");
    const added = `${path}: added`;
    if (!inExisting || mode === "output" || /(\[\]|\{\})$/.test(path)) {
      additive.push(added);
    } else if (/\[\d+\]$/.test(path)) {
      breaking.push(`${path}: tuple grows`);
    } else if (path.endsWith("{key}")) {
      breaking.push(`${path}: record keys now restricted`);
    } else if (facet.required) {
      breaking.push(`${path}: new required field`);
    } else {
      additive.push(added);
    }
  }

  return { breaking, additive };
}
