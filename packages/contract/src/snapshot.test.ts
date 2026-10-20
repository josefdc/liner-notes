/**
 * The contract is additive-only. Each named schema's JSON Schema is compared with its snapshot
 * in snapshots/: a removed or retyped field, a narrower type, enum or bound, or a new required
 * field fails the test. Additive changes fail too until the snapshot records them, so that a
 * later removal of the new field is caught as well.
 *
 *   npm run snapshot:update -w packages/contract
 *     records additive changes and refuses breaking ones;
 *   CONTRACT_BREAKING=1 npm run snapshot:update -w packages/contract
 *     records breaking changes as well: only for a change that owns the contract.
 *
 * Snapshots refer to each other (`"$ref": "TrackAnalysis.schema.json"`) instead of repeating a
 * schema wherever it is used; the comparison follows those references.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { CONTRACT_SCHEMAS } from "./schemas.js";
import { compareSchemas, type Schema } from "./testing/compat.js";
import { packageDir, readJson, repoDir } from "./testing/samples.js";

const dir = join(packageDir, "snapshots");
const update = process.env.UPDATE_CONTRACT_SNAPSHOT === "1";
const allowBreaking = process.env.CONTRACT_BREAKING === "1";
const UPDATE = "npm run snapshot:update -w packages/contract";

const fileName = (name: string) => `${name}.schema.json`;
const nameOf = (ref: string) => ref.replace(/\.schema\.json$/, "");

/** Every named schema's JSON Schema, with references between them. */
function currentSchemas(): Record<string, Schema> {
  const registry = z.registry<{ id: string }>();
  for (const [name, schema] of Object.entries(CONTRACT_SCHEMAS)) registry.add(schema, { id: name });
  return z.toJSONSchema(registry, {
    target: "draft-2020-12",
    unrepresentable: "throw",
    io: "output",
    uri: fileName,
  }).schemas as Record<string, Schema>;
}

function snapshotSchemas(): Record<string, Schema> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .filter((file) => file.endsWith(".schema.json"))
      .map((file) => [nameOf(file), readJson(join(dir, file)) as Schema]),
  );
}

const current = currentSchemas();
const snapshots = snapshotSchemas();
const written: string[] = [];

afterAll(() => {
  if (written.length === 0) return;
  // Store snapshots the way the formatter wants them, so lint stays clean.
  execFileSync(join(repoDir, "node_modules", ".bin", "biome"), ["format", "--write", ...written]);
});

function write(name: string) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, fileName(name));
  writeFileSync(file, `${JSON.stringify(current[name])}\n`);
  written.push(file);
}

describe.each(Object.keys(CONTRACT_SCHEMAS))("%s", (name) => {
  it("keeps every field of its snapshot", () => {
    const snapshot = snapshots[name];
    if (!snapshot) {
      if (!update) expect.fail(`no snapshot for ${name}: run ${UPDATE}`);
      write(name);
      return;
    }

    const { breaking, additive } = compareSchemas(snapshot, current[name], {
      snapshot: (ref) => snapshots[nameOf(ref)],
      current: (ref) => current[nameOf(ref)],
    });
    const report = (changes: string[]) => changes.map((change) => `\n  ${change}`).join("");

    if (update) {
      if (breaking.length > 0 && !allowBreaking) {
        expect.fail(`breaking changes to ${name}, snapshot not updated:${report(breaking)}`);
      }
      if (JSON.stringify(snapshot) !== JSON.stringify(current[name])) write(name);
      return;
    }

    expect(breaking, `breaking changes to ${name}:${report(breaking)}`).toEqual([]);
    expect(
      current[name],
      `${name} changed (additive:${report(additive) || " descriptions only"}); run ${UPDATE}`,
    ).toEqual(snapshot);
  });
});

it("every snapshot belongs to a schema of the contract (a removed schema is breaking)", () => {
  const orphans = Object.keys(snapshots).filter((name) => !(name in CONTRACT_SCHEMAS));
  expect(orphans).toEqual([]);
});
