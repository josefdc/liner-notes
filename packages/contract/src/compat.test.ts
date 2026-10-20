/**
 * The additive-only rule of the snapshot test, on small schemas: which changes break readers
 * of stored payloads and which do not.
 */

import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { toJsonSchema } from "./jsonSchema.js";
import { compareSchemas } from "./testing/compat.js";

const base = z.object({
  id: z.string(),
  bpm: z.number().nullable(),
  kind: z.enum(["sourced", "inferred"]),
  tags: z.array(z.string()).max(8),
  note: z.string().optional(),
  child: z.object({ label: z.string() }),
});

const changes = (next: z.ZodType) => compareSchemas(toJsonSchema(base), toJsonSchema(next));

describe("compareSchemas", () => {
  it("finds nothing when nothing changed", () => {
    expect(changes(base)).toEqual({ breaking: [], additive: [] });
  });

  it.each([
    ["a removed field", base.omit({ bpm: true }), ["$.bpm: removed"]],
    ["a removed nested field", base.extend({ child: z.object({}) }), ["$.child.label: removed"]],
    ["a retyped field", base.extend({ id: z.number() }), ["$.id: no longer accepts string"]],
    [
      "a field no longer nullable",
      base.extend({ bpm: z.number() }),
      ["$.bpm: no longer accepts null"],
    ],
    [
      "a narrower enum",
      base.extend({ kind: z.enum(["sourced"]) }),
      ['$.kind: enum drops ["inferred"]'],
    ],
    [
      "a tighter bound",
      base.extend({ tags: z.array(z.string()).max(3) }),
      ["$.tags: maxItems is now 3"],
    ],
    ["a new pattern", base.extend({ id: z.string().regex(/^x/) }), ['$.id: pattern is now "^x"']],
    [
      "an optional field made required",
      base.extend({ note: z.string() }),
      ["$.note: now required"],
    ],
    ["a new required field", base.extend({ isrc: z.string() }), ["$.isrc: new required field"]],
  ])("reports %s as breaking", (_name, next, breaking) => {
    expect(changes(next).breaking).toEqual(breaking);
  });

  it.each([
    ["a new optional field", base.extend({ isrc: z.string().optional() }), ["$.isrc: added"]],
    [
      "a new optional object with required fields",
      base.extend({ run: z.object({ id: z.string() }).optional() }),
      ["$.run: added", "$.run.id: added"],
    ],
    [
      "a wider enum",
      base.extend({ kind: z.enum(["sourced", "inferred", "measured"]) }),
      ['$.kind: enum adds ["measured"]'],
    ],
    [
      "a nullable field",
      base.extend({ id: z.string().nullable() }),
      ["$.id: now also accepts null"],
    ],
    [
      "a looser bound",
      base.extend({ tags: z.array(z.string()).max(20) }),
      ["$.tags: maxItems loosened"],
    ],
    [
      "a required field made optional",
      base.extend({ id: z.string().optional() }),
      ["$.id: now optional"],
    ],
  ])("reports %s as additive", (_name, next, additive) => {
    const result = changes(next);
    expect(result.breaking).toEqual([]);
    expect(result.additive).toEqual(additive);
  });

  it("treats union variants by their discriminator, so a new variant is additive", () => {
    const a = z.object({ type: z.literal("a"), x: z.string() });
    const b = z.object({ type: z.literal("b"), y: z.number() });
    const c = z.object({ type: z.literal("c") });
    const before = toJsonSchema(z.discriminatedUnion("type", [a, b]));
    const after = compareSchemas(before, toJsonSchema(z.discriminatedUnion("type", [c, a, b])));
    expect(after.breaking).toEqual([]);
    expect(after.additive).toEqual(["$<type=c>: added", "$<type=c>.type: added"]);

    const dropped = compareSchemas(before, toJsonSchema(z.discriminatedUnion("type", [a])));
    expect(dropped.breaking).toEqual([
      "$<type=b>: removed",
      "$<type=b>.type: removed",
      "$<type=b>.y: removed",
    ]);
  });

  it("tells variants apart by the const that differs, not one they share", () => {
    const complete = z.object({
      success: z.literal(true),
      status: z.literal("complete"),
      a: z.string(),
    });
    const paused = z.object({
      success: z.literal(true),
      status: z.literal("paused"),
      b: z.string(),
    });
    const before = toJsonSchema(z.discriminatedUnion("status", [complete, paused]));
    const after = toJsonSchema(
      z.discriminatedUnion("status", [complete, paused.omit({ b: true })]),
    );
    expect(compareSchemas(before, after).breaking).toEqual(["$<status=paused>.b: removed"]);
  });

  it("follows references to other schemas of the contract", () => {
    const outer = (inner: z.ZodType) => {
      const registry = z.registry<{ id: string }>();
      registry.add(inner, { id: "Inner" });
      registry.add(z.object({ inner }), { id: "Outer" });
      const { schemas } = z.toJSONSchema(registry, { uri: (id) => `${id}.schema.json` });
      return {
        root: schemas.Outer,
        resolve: (ref: string) => schemas[ref.replace(".schema.json", "")],
      };
    };
    const before = outer(z.object({ a: z.string(), b: z.number() }));
    const after = outer(z.object({ a: z.string() }));
    expect(JSON.stringify(before.root)).toContain('"$ref":"Inner.schema.json"');
    expect(
      compareSchemas(before.root, after.root, {
        snapshot: before.resolve,
        current: after.resolve,
      }).breaking,
    ).toEqual(["$.inner.b: removed"]);
  });
});
