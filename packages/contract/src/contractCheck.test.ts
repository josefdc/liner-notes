/**
 * `contract-check --base <ref>` against throwaway git repositories: the base commit's
 * snapshots decide, so deleting or editing snapshots in a change cannot hide a breaking change,
 * and only acknowledgements added in the change itself excuse one.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { packageDir, repoDir } from "./testing/samples.js";

// The script runs on the built package, which it finds at ../dist from its own location. The
// tests build into a directory of their own and run a copy of the script there, so they never
// rewrite packages/contract/dist while other test files import it. That directory sits under
// the package's node_modules, so the build resolves the same zod as packages/contract/dist does.
const builds = join(packageDir, "node_modules", ".cache");
let build = "";
let script = "";
let repo = "";

// Git in these repositories ignores the user's and the machine's configuration, so settings
// such as automatic packing or another object format cannot change what the tests see.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

const git = (...args: string[]) =>
  execFileSync(
    "git",
    ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { encoding: "utf8", env: gitEnv },
  ).trim();

const snapshotsDir = () => join(repo, "packages", "contract", "snapshots");
const ackFile = () => join(repo, "packages", "contract", "BREAKING-CHANGES");

function commit(message: string): string {
  git("add", "-A");
  git("commit", "-q", "--allow-empty", "-m", message);
  return git("rev-parse", "HEAD");
}

function check(base: string) {
  const result = spawnSync("node", [script, "--base", base, "--repo", repo], {
    encoding: "utf8",
    env: gitEnv,
  });
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
  mkdirSync(builds, { recursive: true });
  // A run that was killed leaves its build behind; remove those, but not ones a run in
  // progress may still be using.
  for (const name of readdirSync(builds)) {
    const old = join(builds, name);
    if (name.startsWith("contract-check-") && Date.now() - statSync(old).mtimeMs > 3_600_000) {
      rmSync(old, { recursive: true, force: true });
    }
  }
  build = mkdtempSync(join(builds, "contract-check-"));
  execFileSync(
    join(repoDir, "node_modules", ".bin", "tsc"),
    ["-p", "tsconfig.build.json", "--outDir", join(build, "dist")],
    { cwd: packageDir },
  );
  script = join(build, "scripts", "contract-check.mjs");
  mkdirSync(dirname(script));
  copyFileSync(join(packageDir, "scripts", "contract-check.mjs"), script);
  repo = mkdtempSync(join(tmpdir(), "contract-check-"));
  git("init", "-q");
}, 60_000);

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
  if (build) rmSync(build, { recursive: true, force: true });
});

// Each test spawns node and git several times: allow well beyond the 5 s default.
describe("contract-check", { timeout: 30_000 }, () => {
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

  it("lets a later change acknowledge the same line again by adding it once more", () => {
    const base = git("rev-parse", "HEAD");
    const acknowledged = readFileSync(ackFile(), "utf8");
    const lines = acknowledged.split("\n").filter((line) => line.includes("legacyField"));
    writeFileSync(ackFile(), `${acknowledged}${lines.join("\n")}\n`);
    expect(check(base).status).toBe(0);
  });

  it("needs an engine-change line when the comparison code or its CI step changed", () => {
    // A base whose snapshots match the code, carrying the comparison code and the CI step.
    cpSync(join(packageDir, "snapshots"), snapshotsDir(), { recursive: true });
    mkdirSync(join(repo, "packages", "contract", "src"), { recursive: true });
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    const compat = join(repo, "packages", "contract", "src", "compat.ts");
    const ci = join(repo, ".github", "workflows", "ci.yml");
    writeFileSync(compat, "// comparison\n");
    writeFileSync(ci, "steps:\n  - run: npm run contract:check -- --base HEAD^1\n");
    writeFileSync(ackFile(), "# Acknowledged breaking changes\n");
    const base = commit("engine at the base");
    expect(check(base).status).toBe(0);

    writeFileSync(compat, "// a looser comparison\n");
    const changed = check(base);
    expect(changed.status).toBe(1);
    expect(changed.out).toContain("the comparison itself changed (not acknowledged)");
    writeFileSync(ackFile(), "# Acknowledged breaking changes\nengine changed:\n");
    expect(check(base).status).toBe(1);
    writeFileSync(ackFile(), "# Acknowledged breaking changes\nengine changed: stricter enums\n");
    expect(check(base).status).toBe(0);

    writeFileSync(compat, "// comparison\n");
    writeFileSync(ackFile(), "# Acknowledged breaking changes\n");
    writeFileSync(ci, "steps:\n  - run: echo skipped\n");
    expect(check(base).out).toContain(".github/workflows/ci.yml (the contract step)");
    expect(check(base).status).toBe(1);
    writeFileSync(ci, "steps:\n  - run: npm run contract:check -- --base HEAD^1\n");
    expect(check(base).status).toBe(0);
  });

  it("needs an engine-change line when the zod the contract resolves changed", () => {
    const lock = join(repo, "package-lock.json");
    const lockWith = (packages: Record<string, { version: string }>) =>
      writeFileSync(lock, JSON.stringify({ lockfileVersion: 3, packages }));
    lockWith({ "node_modules/zod": { version: "4.6.5" } });
    const base = commit("zod 4.6.5 at the base");
    expect(check(base).status).toBe(0);

    lockWith({ "node_modules/zod": { version: "4.6.7" } });
    const bumped = check(base);
    expect(bumped.status).toBe(1);
    expect(bumped.out).toContain("zod 4.6.5 -> 4.6.7 (package-lock.json)");
    // The contract's own copy wins over the hoisted one.
    lockWith({
      "node_modules/zod": { version: "4.6.5" },
      "packages/contract/node_modules/zod": { version: "4.7.0" },
    });
    expect(check(base).out).toContain("zod 4.6.5 -> 4.7.0 (package-lock.json)");
    writeFileSync(ackFile(), "# Acknowledged breaking changes\nengine changed: zod 4.7.0\n");
    expect(check(base).status).toBe(0);

    lockWith({ "node_modules/zod": { version: "4.6.5" } });
    writeFileSync(ackFile(), "# Acknowledged breaking changes\n");
    expect(check(base).status).toBe(0);
  });

  it("exits 2 when git cannot read the base, instead of reporting no snapshots", () => {
    // A commit whose tree object does not exist: git resolves the base but cannot read its
    // files. Writing the commit directly keeps this independent of how git stores objects
    // (deleting a loose object fails when git has packed it). The id has the repository's
    // own hash length.
    const missingTree = "1".repeat(git("rev-parse", "HEAD").length);
    const base = execFileSync("git", ["-C", repo, "hash-object", "-t", "commit", "-w", "--stdin"], {
      encoding: "utf8",
      env: gitEnv,
      input: `tree ${missingTree}\nauthor test <test@example.com> 0 +0000\ncommitter test <test@example.com> 0 +0000\n\nbase without its tree\n`,
    }).trim();
    const result = check(base);
    expect(result.status).toBe(2);
    expect(result.out).toContain("cannot read packages/contract/snapshots");
    expect(result.out).not.toContain("nothing to compare");
  });

  it("exits 2 when the base lists the snapshots but cannot read them", () => {
    // packages/contract/snapshots points at a tree that was never written.
    const missingTree = "1".repeat(git("rev-parse", "HEAD").length);
    const mktree = (input: string, ...flags: string[]) =>
      execFileSync("git", ["-C", repo, "mktree", ...flags], {
        encoding: "utf8",
        env: gitEnv,
        input,
      }).trim();
    const contract = mktree(`040000 tree ${missingTree}\tsnapshots\n`, "--missing");
    const packages = mktree(`040000 tree ${contract}\tcontract\n`);
    const root = mktree(`040000 tree ${packages}\tpackages\n`);
    const base = git("commit-tree", root, "-m", "snapshots listed but unreadable");
    const result = check(base);
    expect(result.status).toBe(2);
    expect(result.out).toContain("cannot read packages/contract/snapshots");
    expect(result.out).not.toContain("nothing to compare");
  });
});
