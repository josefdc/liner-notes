/**
 * The additive-only rules, one test per rule of compat.ts and snapshot.ts, and the changes to
 * real contract schemas that must fail the gate.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ReadyResponse } from "./api.js";
import { AudioFeatures, ModelScore } from "./audio.js";
import { type Compatibility, compareSchemas, type Mode, type Schema } from "./compat.js";
import { ConnectedEvent, FactoidStreamEvent, StatusEvent } from "./events.js";
import { Claim, Evidence } from "./evidence.js";
import { toJsonSchema } from "./jsonSchema.js";
import { refineNamed } from "./refinements.js";
import { CONTRACT_SCHEMAS } from "./schemas.js";
import { sampleClaim } from "./testing/samples.js";
import { tolerantList } from "./tolerant.js";
import {
  type ContractSnapshot,
  compareSnapshots,
  contractSnapshots,
  engineChangeUnacknowledged,
  readerFacts,
  unacknowledgedBreaking,
} from "./snapshot.js";
import { Sample, TrackAnalysis } from "./track.js";

const object = (properties: Record<string, Schema>, required: string[], extra: Schema = {}) => ({
  type: "object",
  properties,
  required,
  ...extra,
});
const str: Schema = { type: "string" };
const num: Schema = { type: "number" };

const both = (before: Schema, after: Schema) =>
  Object.fromEntries(
    (["input", "output"] as Mode[]).map((mode) => [mode, compareSchemas(before, after, { mode })]),
  ) as Record<Mode, Compatibility>;

describe("compareSchemas rules", () => {
  it("finds nothing when nothing changed", () => {
    const schema = object({ a: str }, ["a"]);
    expect(both(schema, schema)).toEqual({
      input: { breaking: [], additive: [] },
      output: { breaking: [], additive: [] },
    });
  });

  it("a removed field breaks both sides", () => {
    const result = both(object({ a: str, b: num }, ["a"]), object({ a: str }, ["a"]));
    expect(result.input.breaking).toEqual(["$.b: removed"]);
    expect(result.output.breaking).toEqual(["$.b: removed"]);
  });

  it("a type no longer accepted breaks; a new type is additive", () => {
    const result = compareSchemas(object({ a: str }, ["a"]), object({ a: num }, ["a"]));
    expect(result).toEqual({
      breaking: ["$.a: no longer accepts string"],
      additive: ["$.a: now also accepts number"],
    });
    expect(
      compareSchemas(object({ a: { type: "integer" } }, ["a"]), object({ a: num }, ["a"])).breaking,
    ).toEqual([]);
  });

  it("input: a field made required breaks, made optional is additive", () => {
    const optional = object({ a: str }, []);
    const required = object({ a: str }, ["a"]);
    expect(compareSchemas(optional, required, { mode: "input" }).breaking).toEqual([
      "$.a: now required",
    ]);
    expect(compareSchemas(required, optional, { mode: "input" }).additive).toEqual([
      "$.a: now optional",
    ]);
  });

  it("output: a field made optional breaks, made required is additive", () => {
    const optional = object({ a: str }, []);
    const required = object({ a: str }, ["a"]);
    expect(compareSchemas(required, optional, { mode: "output" }).breaking).toEqual([
      "$.a: now optional",
    ]);
    expect(compareSchemas(optional, required, { mode: "output" }).additive).toEqual([
      "$.a: now required",
    ]);
  });

  it("a new required field breaks readers (input) and is additive for consumers (output)", () => {
    const result = both(object({ a: str }, ["a"]), object({ a: str, b: str }, ["a", "b"]));
    expect(result.input.breaking).toEqual(["$.b: new required field"]);
    expect(result.output).toEqual({ breaking: [], additive: ["$.b: added"] });
    expect(
      compareSchemas(object({ a: str }, ["a"]), object({ a: str, b: str }, ["a"])).additive,
    ).toEqual(["$.b: added"]);
  });

  it("input: a removed default breaks; an added one is additive only when it is null", () => {
    const withDefault = object({ a: { type: "array", items: str, default: [] } }, []);
    const without = object({ a: { type: "array", items: str } }, []);
    const nullable = (extra: Schema) => object({ a: { type: ["string", "null"], ...extra } }, []);
    expect(compareSchemas(withDefault, without).breaking).toEqual(["$.a: default removed"]);
    // A missing value would read as [] instead of as missing.
    expect(compareSchemas(without, withDefault).breaking).toEqual(["$.a: default added []"]);
    expect(compareSchemas(nullable({}), nullable({ default: null }))).toEqual({
      breaking: [],
      additive: ["$.a: default added"],
    });
  });

  it("reads a default written next to a $ref", () => {
    const claim: Schema = { type: "object", properties: { verdict: { type: "string" } } };
    const resolve = () => claim;
    const field = (extra: Schema) => object({ c: { $ref: "Claim.schema.json", ...extra } }, []);
    const compare = (before: Schema, after: Schema) =>
      compareSchemas(before, after, { snapshot: resolve, current: resolve });
    expect(compare(field({}), field({ default: { verdict: "supported" } })).breaking).toEqual([
      '$.c: default added {"verdict":"supported"}',
    ]);
    expect(
      compare(field({ default: { verdict: "unknown" } }), field({ default: { verdict: "x" } }))
        .breaking,
    ).toEqual(['$.c: default is now {"verdict":"x"}']);
  });

  it("a required field that gains a default is additive: every old payload carries it", () => {
    const required = object({ a: str }, ["a"]);
    const defaulted = object({ a: { ...str, default: "x" } }, []);
    expect(compareSchemas(required, defaulted)).toEqual({
      breaking: [],
      additive: ["$.a: now optional", "$.a: default added"],
    });
  });

  it("a default whose value changed breaks, on both sides of a parse", () => {
    const before = object({ a: { type: "string", default: "unavailable" } }, []);
    const after = object({ a: { type: "string", default: "analyzed" } }, []);
    for (const mode of ["input", "output"] as const) {
      expect(compareSchemas(before, after, { mode }).breaking).toEqual([
        '$.a: default is now "analyzed"',
      ]);
    }
    expect(compareSchemas(before, before).breaking).toEqual([]);
    // A default with no JSON form is compared by a stable marker.
    const big = (value: bigint) => object({ a: { type: "integer", default: value } }, []);
    expect(compareSchemas(big(10n), big(10n)).breaking).toEqual([]);
    expect(compareSchemas(big(10n), big(11n)).breaking).toEqual([
      "$.a: default is now <bigint 11>",
    ]);
  });

  it("an enum that drops a value breaks; one that adds a value is additive", () => {
    const ab = object({ a: { type: "string", enum: ["x", "y"] } }, ["a"]);
    const a = object({ a: { type: "string", enum: ["x"] } }, ["a"]);
    expect(compareSchemas(ab, a).breaking).toEqual(['$.a: no longer accepts ["y"]']);
    expect(compareSchemas(a, ab).additive).toEqual(['$.a: now also accepts ["y"]']);
  });

  it("a newly restricted value breaks, e.g. union(enum, string) -> enum; lifting it is additive", () => {
    const open = object({ a: { anyOf: [{ type: "string", enum: ["x"] }, str] } }, ["a"]);
    const closed = object({ a: { type: "string", enum: ["x"] } }, ["a"]);
    expect(compareSchemas(open, closed).breaking).toEqual(['$.a: now restricted to ["x"]']);
    expect(compareSchemas(closed, open).additive).toEqual([
      "$.a: no longer restricted to listed values",
    ]);
  });

  it("a changed const breaks", () => {
    const x = object({ a: { type: "string", const: "x" } }, ["a"]);
    const y = object({ a: { type: "string", const: "y" } }, ["a"]);
    expect(compareSchemas(x, y).breaking).toEqual(['$.a: no longer accepts ["x"]']);
  });

  it("a tighter bound breaks; a looser or removed one is additive", () => {
    const max = (n?: number) =>
      object({ a: { type: "array", items: str, ...(n === undefined ? {} : { maxItems: n }) } }, [
        "a",
      ]);
    const min = (n: number) => object({ a: { type: "number", minimum: n } }, ["a"]);
    expect(compareSchemas(max(8), max(3)).breaking).toEqual(["$.a: maxItems is now 3"]);
    expect(compareSchemas(max(), max(3)).breaking).toEqual(["$.a: maxItems is now 3"]);
    expect(compareSchemas(min(0), min(1)).breaking).toEqual(["$.a: minimum is now 1"]);
    expect(compareSchemas(max(3), max(8)).additive).toEqual(["$.a: maxItems loosened"]);
    expect(compareSchemas(max(3), max()).additive).toEqual(["$.a: maxItems removed"]);
  });

  it("a new or changed multipleOf breaks", () => {
    const step = (n?: number) =>
      object({ a: { type: "number", ...(n === undefined ? {} : { multipleOf: n }) } }, ["a"]);
    expect(compareSchemas(step(), step(2)).breaking).toEqual(["$.a: multipleOf is now 2"]);
    expect(compareSchemas(step(2), step(3)).breaking).toEqual(["$.a: multipleOf is now 3"]);
  });

  it("a new pattern or format breaks; removing one is additive", () => {
    const plain = object({ a: str }, ["a"]);
    const pattern = object({ a: { type: "string", pattern: "^x" } }, ["a"]);
    const format = object({ a: { type: "string", format: "date-time" } }, ["a"]);
    expect(compareSchemas(plain, pattern).breaking).toEqual(['$.a: pattern is now "^x"']);
    expect(compareSchemas(plain, format).breaking).toEqual(['$.a: format is now "date-time"']);
    expect(compareSchemas(pattern, plain).additive).toEqual(["$.a: pattern removed"]);
  });

  it("input: an object that now rejects unknown keys breaks; one that allows them is additive", () => {
    const open = object({ a: str }, ["a"]);
    const closed = object({ a: str }, ["a"], { additionalProperties: false });
    expect(compareSchemas(open, closed, { mode: "input" }).breaking).toEqual([
      "$: now rejects unknown keys",
    ]);
    expect(compareSchemas(closed, open, { mode: "input" }).additive).toEqual([
      "$: now accepts unknown keys",
    ]);
    expect(compareSchemas(open, closed, { mode: "output" }).breaking).toEqual([]);
  });

  it("narrower record keys break (propertyNames added or restricted)", () => {
    const record = (keys?: Schema) =>
      object(
        {
          a: {
            type: "object",
            additionalProperties: str,
            ...(keys ? { propertyNames: keys } : {}),
          },
        },
        ["a"],
      );
    expect(compareSchemas(record(), record({ type: "string", enum: ["x"] })).breaking).toEqual([
      "$.a{key}: record keys now restricted",
    ]);
    expect(compareSchemas(record(str), record({ type: "string", enum: ["x"] })).breaking).toEqual([
      '$.a{key}: now restricted to ["x"]',
    ]);
  });

  it("a tuple that grows or closes breaks", () => {
    const tuple = (n: number, closed: boolean) =>
      object(
        {
          a: {
            type: "array",
            prefixItems: Array(n).fill(num),
            ...(closed ? { items: false } : {}),
          },
        },
        ["a"],
      );
    expect(compareSchemas(tuple(2, true), tuple(3, true)).breaking).toEqual([
      "$.a[2]: tuple grows",
    ]);
    expect(compareSchemas(tuple(2, false), tuple(2, true)).breaking).toEqual([
      "$.a: no longer accepts extra items",
    ]);
  });

  it("follows allOf branches, so removing a field from one breaks", () => {
    const intersection = (q: boolean) =>
      object(
        {
          a: {
            allOf: [
              object({ p: str }, ["p"]),
              object(q ? { q: num, r: str } : { r: str }, q ? ["q", "r"] : ["r"]),
            ],
          },
        },
        ["a"],
      );
    expect(compareSchemas(intersection(true), intersection(false)).breaking).toEqual([
      "$.a.q: removed",
    ]);
  });

  it("keys union variants by the const that tells them apart", () => {
    const variant = (tag: string, fields: Record<string, Schema>) =>
      object(
        { ok: { type: "boolean", const: true }, status: { type: "string", const: tag }, ...fields },
        ["ok", "status", ...Object.keys(fields)],
      );
    const before = { anyOf: [variant("done", { a: str }), variant("paused", { b: str })] };
    const dropped = { anyOf: [variant("done", { a: str }), variant("paused", {})] };
    const grown = { anyOf: [...before.anyOf, variant("new", {})] };
    expect(compareSchemas(before, dropped).breaking).toEqual(["$<status=paused>.b: removed"]);
    expect(compareSchemas(before, grown).breaking).toEqual([]);
    expect(compareSchemas(before, grown).additive).toContain("$<status=new>: added");
    expect(compareSchemas(grown, before).breaking).toContain("$<status=new>: removed");
  });

  it("follows local and external references", () => {
    const local = (fields: Record<string, Schema>) => ({
      ...object({ a: { $ref: "#/$defs/A" } }, ["a"]),
      $defs: { A: object(fields, Object.keys(fields)) },
    });
    expect(compareSchemas(local({ x: str, y: str }), local({ x: str })).breaking).toEqual([
      "$.a.y: removed",
    ]);
    const outer = object({ a: { $ref: "A.schema.json" } }, ["a"]);
    const result = compareSchemas(outer, outer, {
      snapshot: () => object({ x: str, y: str }, ["x", "y"]),
      current: () => object({ x: str }, ["x"]),
    });
    expect(result.breaking).toEqual(["$.a.y: removed"]);
  });

  it("records a reference it cannot resolve, so a missing schema shows up as a change", () => {
    const outer = object({ a: { $ref: "A.schema.json" } }, ["a"]);
    const result = compareSchemas(outer, outer, {
      snapshot: () => object({ x: str }, ["x"]),
      current: () => undefined,
    });
    expect(result.breaking).toEqual(["$.a: no longer accepts object", "$.a.x: removed"]);
  });

  it("drops a bound that only one union branch has, so adding it later breaks", () => {
    const branches = object({ a: { anyOf: [{ type: "number", maximum: 5 }, num] } }, ["a"]);
    const tighter = object({ a: { type: "number", maximum: 5 } }, ["a"]);
    expect(compareSchemas(branches, tighter).breaking).toEqual(["$.a: maximum is now 5"]);
  });

  it("treats a property required in any allOf branch as required", () => {
    const before = object({ a: { allOf: [object({ p: str }, []), object({ p: str }, ["p"])] } }, [
      "a",
    ]);
    const after = object({ a: object({ p: str }, []) }, ["a"]);
    expect(compareSchemas(before, after, { mode: "output" }).breaking).toEqual([
      "$.a.p: now optional",
    ]);
  });

  it("merges union branches on one path with their loosest bounds", () => {
    const branches = object(
      {
        a: {
          anyOf: [
            { type: "number", maximum: 5 },
            { type: "number", maximum: 9 },
          ],
        },
      },
      ["a"],
    );
    const tighter = object({ a: { type: "number", maximum: 5 } }, ["a"]);
    expect(compareSchemas(branches, tighter).breaking).toEqual(["$.a: maximum is now 5"]);
  });
});

const snapshotOf = (schema: z.ZodType): ContractSnapshot => ({
  input: toJsonSchema(schema, "input"),
  output: toJsonSchema(schema, "output"),
  ...readerFacts(schema, new Set()),
});
const breaking = (before: z.ZodType, after: z.ZodType) =>
  compareSnapshots({ S: snapshotOf(before) }, { S: snapshotOf(after) }).S.breaking;
const additive = (before: z.ZodType, after: z.ZodType) =>
  compareSnapshots({ S: snapshotOf(before) }, { S: snapshotOf(after) }).S.additive;

describe("snapshot rules", () => {
  it("a new refinement breaks, named or not; removing one is additive", () => {
    const base = z.object({ a: z.string() });
    const named = refineNamed(base, "a.not-x", (value, ctx) => {
      if (value.a === "x") ctx.addIssue({ code: "custom", message: "x" });
    });
    expect(breaking(base, named)).toEqual(["refinement added $: a.not-x"]);
    expect(
      breaking(
        base,
        base.superRefine(() => {}),
      ),
    ).toEqual(["refinement added $: unnamed"]);
    expect(additive(named, base)).toEqual(["refinement removed $: a.not-x"]);
  });

  it("strip -> strict breaks; strict -> strip is additive", () => {
    const strip = z.object({ a: z.object({ b: z.string() }) });
    const strict = z.object({ a: z.strictObject({ b: z.string() }) });
    expect(breaking(strip, strict)).toContain("unknown keys $.a: strip -> strict");
    expect(additive(strict, strip)).toContain("unknown keys $.a: strict -> strip");
  });

  it("a list or value made strict again breaks; making one tolerant is additive", () => {
    const strict = z.object({ items: z.array(z.string()), reason: z.enum(["a"]).optional() });
    const tolerant = z.object({
      items: tolerantList(z.string()),
      reason: z.enum(["a"]).optional().catch(undefined),
    });
    expect(breaking(tolerant, strict)).toEqual([
      "no longer tolerant $.items: drops unreadable items",
      "no longer tolerant $.reason: absent when unreadable",
    ]);
    expect(additive(strict, tolerant)).toEqual(
      expect.arrayContaining([
        "now tolerant $.items: drops unreadable items",
        "now tolerant $.reason: absent when unreadable",
      ]),
    );
    expect(breaking(strict, tolerant)).toEqual([]);
  });

  it("a value that reads as its fallback, not as absent, when unreadable is recorded so", () => {
    const reason = (schema: z.ZodType) => z.object({ reason: schema });
    const absent = reason(z.enum(["a", "b"]).optional().catch(undefined));
    const invented = reason(z.enum(["a", "b"]).optional().catch("a"));
    expect(readerFacts(invented, new Set()).tolerant).toEqual([
      '$.reason: reads as "a" when unreadable',
    ]);
    expect(readerFacts(reason(z.enum(["a"]).nullable().catch(null)), new Set()).tolerant).toEqual([
      "$.reason: absent when unreadable",
    ]);
    expect(breaking(absent, invented)).toContain(
      "no longer tolerant $.reason: absent when unreadable",
    );
  });

  it("a removed schema breaks; a new one is additive", () => {
    const s = snapshotOf(z.object({ a: z.string() }));
    expect(compareSnapshots({ A: s }, {})).toEqual({
      A: { breaking: ["schema removed"], additive: [] },
    });
    expect(compareSnapshots({}, { A: s })).toEqual({
      A: { breaking: [], additive: ["schema added"] },
    });
  });

  it("adding a field with a default is additive; removing a default breaks", () => {
    const base = z.object({ a: z.string() });
    expect(breaking(base, base.extend({ tags: z.array(z.string()).default([]) }))).toEqual([]);
    const withDefault = base.extend({ tags: z.array(z.string()).default([]) });
    expect(breaking(withDefault, base.extend({ tags: z.array(z.string()) }))).toEqual([
      "input $.tags: now required",
      "input $.tags: default removed",
    ]);
  });
});

describe("changes to the contract that must fail the gate", () => {
  const cases: Array<[string, z.ZodType, z.ZodType]> = [
    ["strictObject on TrackAnalysis", TrackAnalysis, z.strictObject(TrackAnalysis.shape)],
    ["strictObject on AudioFeatures", AudioFeatures, z.strictObject(AudioFeatures.shape)],
    ["strictObject on Evidence", Evidence, z.strictObject(Evidence.shape)],
    ["strictObject on a stream event", ConnectedEvent, z.strictObject(ConnectedEvent.shape)],
    ["a new superRefine on TrackAnalysis", TrackAnalysis, TrackAnalysis.superRefine(() => {})],
    [
      ".default([]) removed from TrackAnalysis.segments",
      TrackAnalysis,
      TrackAnalysis.extend({ segments: TrackAnalysis.shape.segments.removeDefault() }),
    ],
    [
      "TrackAnalysis.audioSource reads an unreadable value as 'analyzed'",
      TrackAnalysis,
      TrackAnalysis.extend({
        audioSource: z.enum(["analyzed", "unavailable"]).optional().catch("analyzed"),
      }),
    ],
    [
      "TrackAnalysis.segments defaults to a made-up segment",
      TrackAnalysis,
      TrackAnalysis.extend({
        segments: TrackAnalysis.shape.segments
          .removeDefault()
          .default([{ label: "Verse", start: 0, end: 100, color: "#000000" }]),
      }),
    ],
    [
      "multipleOf on Sample.time",
      Sample,
      Sample.extend({ time: z.number().multipleOf(0.5).nullable() }),
    ],
    [
      "ReadyResponse.checks record keys narrowed",
      ReadyResponse,
      ReadyResponse.extend({ checks: z.record(z.enum(["database"]), z.string()) }),
    ],
    [
      "a ModelScore range tuple that grows",
      ModelScore,
      ModelScore.extend({ range: z.tuple([z.number(), z.number(), z.number()]) }),
    ],
    [
      "a field removed from one side of an intersection",
      z.object({ a: z.intersection(z.object({ p: z.string() }), z.object({ q: z.number() })) }),
      z.object({ a: z.intersection(z.object({ p: z.string() }), z.object({})) }),
    ],
    [
      "StatusEvent.code: open string -> LogCode enum",
      StatusEvent.extend({ code: z.union([z.enum(["SYS-INIT"]), z.string()]).optional() }),
      StatusEvent.extend({ code: z.enum(["SYS-INIT"]).optional() }),
    ],
  ];

  it.each(cases)("%s", (_name, before, after) => {
    expect(breaking(before, after).length).toBeGreaterThan(0);
  });

  it("a field added with a default to TrackAnalysis passes", () => {
    const after = TrackAnalysis.extend({ tags: z.array(z.string()).default([]) });
    expect(breaking(TrackAnalysis, after)).toEqual([]);
  });

  it("a factoid's claim (a named schema) read as an invented supported claim when unreadable", () => {
    // A default next to a $ref: the claim refers to the Claim snapshot.
    const [connected, factoid, ...rest] = FactoidStreamEvent.options;
    const invented = z.discriminatedUnion("type", [
      connected,
      factoid.extend({ claim: Claim.optional().catch(sampleClaim()) }),
      ...rest,
    ]);
    const changes = compareSnapshots(
      contractSnapshots(),
      contractSnapshots({ ...CONTRACT_SCHEMAS, FactoidStreamEvent: invented }),
    );
    expect(changes.FactoidStreamEvent.breaking).toEqual([
      `input $<type=factoid>.claim: default added ${JSON.stringify(sampleClaim())}`,
    ]);
  });
});

describe("unacknowledgedBreaking", () => {
  const changes = { TrackAnalysis: { breaking: ["input $.album: removed"], additive: [] } };

  it("reports a breaking change that is not acknowledged", () => {
    expect(unacknowledgedBreaking(changes, [], [])).toEqual([
      "TrackAnalysis input $.album: removed",
    ]);
  });

  it("accepts a line added in this change, ignoring comments and blank lines", () => {
    const now = ["# acknowledged breaking changes", "", "TrackAnalysis input $.album: removed"];
    expect(unacknowledgedBreaking(changes, now, ["# acknowledged breaking changes"])).toEqual([]);
  });

  it("counts lines: a line added again excuses the same change again", () => {
    const line = "TrackAnalysis input $.album: removed";
    expect(unacknowledgedBreaking(changes, [line, line], [line])).toEqual([]);
    const twice = {
      TrackAnalysis: {
        breaking: ["input $.album: removed", "input $.album: removed"],
        additive: [],
      },
    };
    expect(unacknowledgedBreaking(twice, [line], [])).toEqual([line]);
  });

  it("needs a fresh engine-change line with a reason when the comparison changed", () => {
    const files = ["packages/contract/src/compat.ts"];
    expect(engineChangeUnacknowledged([], [], [])).toBe(false);
    expect(engineChangeUnacknowledged(files, [], [])).toBe(true);
    expect(engineChangeUnacknowledged(files, ["engine changed:"], [])).toBe(true);
    expect(engineChangeUnacknowledged(files, ["engine changed: wider enums"], [])).toBe(false);
    const old = "engine changed: wider enums";
    expect(engineChangeUnacknowledged(files, [old], [old])).toBe(true);
  });

  it("never lets a line already at the base excuse a new change", () => {
    const line = "TrackAnalysis input $.album: removed";
    expect(unacknowledgedBreaking(changes, [line], [line])).toEqual([line]);
  });
});
