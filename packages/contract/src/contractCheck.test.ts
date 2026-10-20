/**
 * `contract-check --base <ref>` against throwaway git repositories: the base commit's
 * snapshots decide, so deleting or editing snapshots in a change cannot hide a breaking change,
 * and only acknowledgements added in the change itself excuse one.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageDir, repoDir } from "./testing/samples.js";

const script = join(packageDir, "scripts", "contract-check.mjs");
let repo = "";

const git = (...args: string[]) =>
  execFileSync(
    "git",
    ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { encoding: "utf8" },
  ).trim();

const snapshotsDir = () => join(repo, "packages", "contract", "snapshots");
const ackFile = () => join(repo, "packages", "contract", "BREAKING-CHANGES");

function commit(message: string): string {
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", message);
  return git("rev-parse", "HEAD");
}

function check(base: string) {
  const result = spawnSync("node", [script, "--base", base, "--repo", repo], { encoding: "utf8" });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

/** A base whose TrackAnalysis snapshot had one more required field than the code has now. */
function withExtraField() {
  const file = join(snapshotsDir(), "TrackAnalysis.schema.json");
  const snapshot = JSON.parse(readFileSync(file, "utf8"));
  for (const mode of ["input", "output"]) {
    snapshot[mode].properties.legacyField = { type: "string" };
    snapshot[mode].required.push("legacyField");
  }
  writeFileSync(file, JSON.stringify(snapshot));
}

beforeAll(() => {
  // The script runs on the built package.
  execFileSync(join(repoDir, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.build.json"], {
    cwd: packageDir,
  });
  repo = mkdtempSync(join(tmpdir(), "contract-check-"));
  git("init", "-q");
}, 60_000);

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("contract-check", () => {
  it("passes when the base has no snapshots yet, and fails on an unknown base", () => {
    const empty = commit("empty");
    expect(check(empty)).toMatchObject({ status: 0 });
    expect(check(empty).out).toContain("nothing to compare");
    expect(check("no-such-ref").status).toBe(2);
  });

  it("passes when the code matches the base snapshots", () => {
    mkdirSync(join(repo, "packages", "contract"), { recursive: true });
    cpSync(join(packageDir, "snapshots"), snapshotsDir(), { recursive: true });
    const base = commit("snapshots");
    const result = check(base);
    expect(result.out).toContain("0 breaking, 0 acknowledged, 0 additive");
    expect(result.status).toBe(0);
  });

  it("fails when the code removed a field the base had", () => {
    withExtraField();
    const base = commit("base with an extra field");
    const result = check(base);
    expect(result.status).toBe(1);
    expect(result.out).toContain("[contract] breaking: TrackAnalysis input $.legacyField: removed");
    expect(result.out).toContain(
      "[contract] breaking: TrackAnalysis output $.legacyField: removed",
    );
  });

  it("still fails when the change deletes or rewrites its snapshots", () => {
    const base = git("rev-parse", "HEAD");
    rmSync(snapshotsDir(), { recursive: true });
    expect(check(base).status).toBe(1);
    cpSync(join(packageDir, "snapshots"), snapshotsDir(), { recursive: true });
    expect(check(base).status).toBe(1);
  });

  it("passes when the change acknowledges each breaking line, and only then", () => {
    const base = git("rev-parse", "HEAD");
    // The field is reported wherever TrackAnalysis is used (events, responses, replays).
    const lines = [...check(base).out.matchAll(/^\[contract\] breaking: (.*)$/gm)].map((m) => m[1]);
    expect(lines).toContain("RunResponse output $.analysis.legacyField: removed");
    writeFileSync(ackFile(), `# Acknowledged breaking changes\n${lines.slice(1).join("\n")}\n`);
    expect(check(base).out).toContain(`[contract] breaking: ${lines[0]}`);
    writeFileSync(ackFile(), `# Acknowledged breaking changes\n${lines.join("\n")}\n`);
    const result = check(base);
    expect(result.out).toContain(`: 0 breaking, ${lines.length} acknowledged`);
    expect(result.status).toBe(0);
  });

  it("does not let acknowledgements from the base excuse a later change", () => {
    // The acknowledgement is committed, and the base snapshot still has the field.
    withExtraField();
    const base = commit("acknowledged at the base");
    expect(git("show", `${base}:packages/contract/BREAKING-CHANGES`)).toContain("legacyField");
    expect(check(base).status).toBe(1);
  });
});
