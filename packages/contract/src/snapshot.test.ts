/**
 * snapshots/ and schemas/ stay in step with the code, and nothing breaks readers silently.
 *
 * Each named schema's snapshot (snapshot.ts: reader and parse-side JSON Schema, unknown-key
 * policies, named refinements) is compared with the code. A breaking change fails; an additive
 * change fails too until the snapshot records it, so a later removal is caught as well.
 *
 *   npm run snapshot:update -w packages/contract
 *     records additive changes and refuses breaking ones;
 *   CONTRACT_BREAKING=1 npm run snapshot:update -w packages/contract
 *     records breaking changes as well. CI compares against the base commit's snapshots
 *     (`npm run contract:check -- --base <ref>`), so a breaking change also needs its line in
 *     packages/contract/BREAKING-CHANGES.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { audioFeaturesJsonSchema } from "./audioSchema.js";
import { CONTRACT_SCHEMAS } from "./schemas.js";
import {
  type ContractSnapshot,
  compareSnapshots,
  contractSnapshots,
  snapshotFileName,
} from "./snapshot.js";
import { packageDir, readJson, repoDir } from "./testing/samples.js";

const dir = join(packageDir, "snapshots");
const audioSchemaFile = join(packageDir, "schemas", "audio-features.schema.json");
const update = process.env.UPDATE_CONTRACT_SNAPSHOT === "1";
const allowBreaking = process.env.CONTRACT_BREAKING === "1";
const UPDATE = "npm run snapshot:update -w packages/contract";

function stored(): Record<string, ContractSnapshot> {
  if (!existsSync(dir)) return {};
  return Object.fromEntries(
    readdirSync(dir)
      .filter((file) => file.endsWith(".schema.json"))
      .map((file) => [
        file.replace(/\.schema\.json$/, ""),
        readJson(join(dir, file)) as ContractSnapshot,
      ]),
  );
}

const current = contractSnapshots();
const snapshots = stored();
const changes = compareSnapshots(snapshots, current);
const written: string[] = [];

afterAll(() => {
  if (written.length === 0) return;
  // Store files the way the formatter wants them, so lint stays clean.
  execFileSync(join(repoDir, "node_modules", ".bin", "biome"), ["format", "--write", ...written]);
});

function write(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value)}\n`);
  written.push(file);
}

const report = (lines: string[]) => lines.map((line) => `\n  ${line}`).join("");

describe.each(Object.keys(CONTRACT_SCHEMAS))("%s", (name) => {
  it("keeps every field, policy and refinement of its snapshot", () => {
    const { breaking, additive } = changes[name];
    if (update) {
      if (snapshots[name] && breaking.length > 0 && !allowBreaking) {
        expect.fail(`breaking changes to ${name}, snapshot not updated:${report(breaking)}`);
      }
      if (JSON.stringify(snapshots[name]) !== JSON.stringify(current[name])) {
        write(join(dir, snapshotFileName(name)), current[name]);
      }
      return;
    }
    if (!snapshots[name]) expect.fail(`no snapshot for ${name}: run ${UPDATE}`);
    expect(breaking, `breaking changes to ${name}:${report(breaking)}`).toEqual([]);
    expect(
      current[name],
      `${name} changed (additive:${report(additive) || " descriptions only"}); run ${UPDATE}`,
    ).toEqual(snapshots[name]);
  });
});

it("reader facts are still found (a zod release that hid them would read as additive)", () => {
  // Known facts of the contract as it stands; each comes from zod internals readerFacts reads.
  expect(current.ReplayRecord.refinements).toContain("$: replay.event-order");
  expect(current.ComposerOutput.unknownKeys.$).toBe("strict");
  expect(current.TrackAnalysis.unknownKeys.$).toBe("strip");
  expect(current.ApiError.unknownKeys.$).toBe("passthrough");
  expect(current.TrackAnalysis.tolerant).toEqual(
    expect.arrayContaining([
      "$.segments: drops unreadable items",
      "$.audio: absent when unreadable",
    ]),
  );
});

it("every snapshot belongs to a schema of the contract (a removed schema is breaking)", () => {
  const orphans = Object.keys(snapshots).filter((name) => !(name in CONTRACT_SCHEMAS));
  expect(orphans).toEqual([]);
});

it("schemas/audio-features.schema.json is up to date", () => {
  const generated = audioFeaturesJsonSchema();
  if (update) {
    const committed = existsSync(audioSchemaFile) ? readJson(audioSchemaFile) : null;
    if (JSON.stringify(committed) !== JSON.stringify(generated)) write(audioSchemaFile, generated);
    return;
  }
  expect(existsSync(audioSchemaFile), `missing; run ${UPDATE}`).toBe(true);
  expect(readJson(audioSchemaFile), `out of date; run ${UPDATE}`).toEqual(generated);
});
