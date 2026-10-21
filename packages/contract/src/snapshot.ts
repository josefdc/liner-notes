/**
 * Snapshots of the contract, and the additive-only comparison between two sets of them.
 *
 * A snapshot records, for one named schema, everything a reader depends on:
 * - its JSON Schema as a reader accepts it (`input`: optional fields, defaults, whether
 *   unknown keys are allowed) and as a parse returns it (`output`);
 * - the unknown-key policy of each object (`strip`, `strict` or `passthrough`);
 * - its refinements, by id (see refinements.ts), which JSON Schema cannot show;
 * - the lists and values a reader tolerates when it cannot read them (see tolerant.ts).
 * Snapshots refer to each other (`"$ref": "TrackAnalysis.schema.json"`) instead of repeating a
 * schema wherever it is used, and the facts of one schema stop where another named schema
 * starts.
 */

import { z } from "zod";
import { type Compatibility, compareSchemas, type Schema } from "./compat.js";
import { jsonSchemaOptions } from "./jsonSchema.js";
import { refinementId } from "./refinements.js";
import { CONTRACT_SCHEMAS } from "./schemas.js";
import { isTolerantFilter } from "./tolerant.js";

export interface ContractSnapshot {
  input: Schema;
  output: Schema;
  unknownKeys: Record<string, "strip" | "strict" | "passthrough">;
  refinements: string[];
  /** Paths of lists that drop unreadable items and of values that become absent instead. */
  tolerant: string[];
}

export const snapshotFileName = (name: string) => `${name}.schema.json`;
const nameOf = (ref: string) => ref.replace(/\.schema\.json$/, "");

type ZodDef = {
  type: string;
  checks?: Array<{ _zod: { def: { check: string } } }>;
  [key: string]: unknown;
};
const defOf = (schema: unknown) => (schema as { _zod: { def: ZodDef } })._zod.def;

/**
 * What a `.catch()` reads an unreadable value as: absent (undefined or null), or the fallback,
 * so a fallback that invents a value is recorded and changing to one is breaking.
 */
function unreadableAs(catchValue: (ctx: unknown) => unknown): string {
  let fallback: unknown;
  try {
    fallback = catchValue(undefined);
  } catch {
    return "a computed value when unreadable";
  }
  if (fallback === undefined || fallback === null) return "absent when unreadable";
  let text: string | undefined;
  try {
    text = JSON.stringify(fallback);
  } catch {
    // No JSON form.
  }
  return `reads as ${text ?? `<${typeof fallback} ${String(fallback)}>`} when unreadable`;
}

/** Unknown-key policies and named refinements of `root`, down to other named schemas. */
export function readerFacts(
  root: z.ZodType,
  named: ReadonlySet<unknown> = new Set(Object.values(CONTRACT_SCHEMAS)),
): Pick<ContractSnapshot, "unknownKeys" | "refinements" | "tolerant"> {
  const unknownKeys: ContractSnapshot["unknownKeys"] = {};
  const refinements: string[] = [];
  const tolerant: string[] = [];

  const walk = (schema: unknown, path: string, stack: readonly unknown[]) => {
    if (stack.includes(schema)) return;
    if (schema !== root && named.has(schema)) return;
    const def = defOf(schema);
    const inner = [...stack, schema];
    for (const check of def.checks ?? []) {
      if (check._zod.def.check === "custom") refinements.push(`${path}: ${refinementId(check)}`);
    }
    switch (def.type) {
      case "object": {
        const catchall = def.catchall ? defOf(def.catchall).type : null;
        unknownKeys[path] = !catchall ? "strip" : catchall === "never" ? "strict" : "passthrough";
        for (const [key, value] of Object.entries(def.shape as Record<string, unknown>)) {
          walk(value, `${path}.${key}`, inner);
        }
        return;
      }
      case "array":
        walk(def.element, `${path}[]`, inner);
        return;
      case "union": {
        const tag = def.discriminator as string | undefined;
        (def.options as unknown[]).forEach((option, index) => {
          const literal = tag ? defOf(option).shape : undefined;
          const value = literal
            ? (defOf((literal as Record<string, unknown>)[tag as string]).values as unknown[])
            : undefined;
          walk(option, value ? `${path}<${tag}=${String(value[0])}>` : `${path}|${index}`, inner);
        });
        return;
      }
      case "record":
        walk(def.keyType, `${path}{key}`, inner);
        walk(def.valueType, `${path}{}`, inner);
        return;
      case "tuple":
        (def.items as unknown[]).forEach((item, index) => {
          walk(item, `${path}[${index}]`, inner);
        });
        if (def.rest) walk(def.rest, `${path}[]`, inner);
        return;
      case "intersection":
        walk(def.left, path, inner);
        walk(def.right, path, inner);
        return;
      case "pipe":
        if (isTolerantFilter(def.in as object)) tolerant.push(`${path}: drops unreadable items`);
        walk(def.in, path, inner);
        walk(def.out, path, inner);
        return;
      case "lazy":
        walk((def.getter as () => unknown)(), path, inner);
        return;
      case "catch":
        tolerant.push(`${path}: ${unreadableAs(def.catchValue as (ctx: unknown) => unknown)}`);
        walk(def.innerType, path, inner);
        return;
      default:
        if (def.innerType) walk(def.innerType, path, inner);
    }
  };

  walk(root, "$", []);
  return { unknownKeys, refinements: refinements.sort(), tolerant: tolerant.sort() };
}

/**
 * The snapshot of every named schema, as the code stands (or of `schemas`, which tests use to
 * snapshot a changed contract).
 */
export function contractSnapshots(
  schemas: Record<string, z.ZodType> = CONTRACT_SCHEMAS,
): Record<string, ContractSnapshot> {
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of Object.entries(schemas)) registry.add(schema, { id: name });
  const json = (io: "input" | "output") =>
    z.toJSONSchema(registry, { ...jsonSchemaOptions(io), uri: snapshotFileName }).schemas as Record<
      string,
      Schema
    >;
  const input = json("input");
  const output = json("output");
  const named = new Set<unknown>(Object.values(schemas));
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      { input: input[name], output: output[name], ...readerFacts(schema, named) },
    ]),
  );
}

const POLICY_RANK = { strict: 0, strip: 1, passthrough: 2 } as const;

function countOf(list: readonly string[]) {
  const counts = new Map<string, number>();
  for (const item of list) counts.set(item, (counts.get(item) ?? 0) + 1);
  return counts;
}

/**
 * What changed from the `before` snapshots to the `after` ones, per schema name. A schema that
 * disappeared is breaking; a new one is additive.
 */
export function compareSnapshots(
  before: Record<string, ContractSnapshot>,
  after: Record<string, ContractSnapshot>,
): Record<string, Compatibility> {
  const result: Record<string, Compatibility> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const old = before[name];
    const now = after[name];
    if (!old || !now) {
      result[name] = old
        ? { breaking: ["schema removed"], additive: [] }
        : { breaking: [], additive: ["schema added"] };
      continue;
    }
    const breaking: string[] = [];
    const additive: string[] = [];
    for (const mode of ["input", "output"] as const) {
      const changes = compareSchemas(old[mode], now[mode], {
        mode,
        snapshot: (ref) => before[nameOf(ref)]?.[mode],
        current: (ref) => after[nameOf(ref)]?.[mode],
      });
      breaking.push(...changes.breaking.map((change) => `${mode} ${change}`));
      additive.push(...changes.additive.map((change) => `${mode} ${change}`));
    }
    for (const [path, policy] of Object.entries(old.unknownKeys ?? {})) {
      const next = now.unknownKeys?.[path];
      if (!next || next === policy) continue;
      const change = `unknown keys ${path}: ${policy} -> ${next}`;
      (POLICY_RANK[next] < POLICY_RANK[policy] ? breaking : additive).push(change);
    }
    const oldRefinements = countOf(old.refinements ?? []);
    const newRefinements = countOf(now.refinements ?? []);
    for (const [refinement, count] of newRefinements) {
      if (count > (oldRefinements.get(refinement) ?? 0)) {
        breaking.push(`refinement added ${refinement}`);
      }
    }
    for (const [refinement, count] of oldRefinements) {
      if (count > (newRefinements.get(refinement) ?? 0)) {
        additive.push(`refinement removed ${refinement}`);
      }
    }
    const nowTolerant = new Set(now.tolerant ?? []);
    const oldTolerant = new Set(old.tolerant ?? []);
    for (const entry of oldTolerant) {
      if (!nowTolerant.has(entry)) breaking.push(`no longer tolerant ${entry}`);
    }
    for (const entry of nowTolerant) {
      if (!oldTolerant.has(entry)) additive.push(`now tolerant ${entry}`);
    }
    result[name] = { breaking, additive };
  }
  return result;
}

const ackLines = (lines: readonly string[]) =>
  lines.map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));

/**
 * The acknowledgement lines added by this change: each line counted as many times as it occurs
 * now, minus the times it occurred at the base. Counting (not a set) lets a later change
 * acknowledge the same line again by adding it once more.
 */
export function freshAcknowledgements(
  acknowledgedNow: readonly string[],
  acknowledgedAtBase: readonly string[],
): Map<string, number> {
  const fresh = countOf(ackLines(acknowledgedNow));
  for (const [line, count] of countOf(ackLines(acknowledgedAtBase))) {
    const left = (fresh.get(line) ?? 0) - count;
    if (left > 0) fresh.set(line, left);
    else fresh.delete(line);
  }
  return fresh;
}

/**
 * Breaking changes against a base, minus the ones acknowledged for this change: each fresh
 * acknowledgement line (`<Schema> <change>` exactly as reported) excuses one breaking change.
 * Acknowledgements already at the base never excuse a new change.
 */
export function unacknowledgedBreaking(
  changes: Record<string, Compatibility>,
  acknowledgedNow: readonly string[],
  acknowledgedAtBase: readonly string[],
): string[] {
  const fresh = freshAcknowledgements(acknowledgedNow, acknowledgedAtBase);
  return Object.entries(changes).flatMap(([name, { breaking }]) =>
    breaking
      .map((change) => `${name} ${change}`)
      .filter((line) => {
        const left = fresh.get(line) ?? 0;
        if (left === 0) return true;
        fresh.set(line, left - 1);
        return false;
      }),
  );
}

/** The prefix of the acknowledgement a change to the comparison itself needs. */
export const ENGINE_ACK_PREFIX = "engine changed:";

/**
 * True when the code that compares the contract changed and this change does not say why with
 * a fresh `engine changed: <reason>` line: otherwise a change could loosen the comparison and
 * pass its own check.
 */
export function engineChangeUnacknowledged(
  changedFiles: readonly string[],
  acknowledgedNow: readonly string[],
  acknowledgedAtBase: readonly string[],
): boolean {
  if (changedFiles.length === 0) return false;
  const fresh = freshAcknowledgements(acknowledgedNow, acknowledgedAtBase);
  return ![...fresh.keys()].some(
    (line) => line.startsWith(ENGINE_ACK_PREFIX) && line.slice(ENGINE_ACK_PREFIX.length).trim(),
  );
}
