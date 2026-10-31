/**
 * `contract-check --base <ref>` against throwaway git repositories: the base commit's
 * snapshots decide, so deleting or editing snapshots in a change cannot hide a breaking change,
 * and only acknowledgements added in the change itself excuse one.
 */

import { execFileSync, spawnSync } from "node:child_process";
import {
  type Dirent,
  copyFileSync,
  cpSync,
  existsSync,
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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { packageDir, repoDir } from "./testing/samples.js";

// The script runs on the built package, which it finds at ../dist from its own location. The
// tests build into a directory of their own and run a copy of the script there, so they never
// rewrite packages/contract/dist while other test files import it. That directory sits under
// the package's node_modules, so the build resolves the same zod as packages/contract/dist does.
const builds = join(packageDir, "node_modules", ".cache");
let build = "";
let distBefore = "";
let script = "";
let repo = "";

// Git in these repositories ignores the user's and the machine's configuration, so settings
// such as automatic packing or another object format cannot change what the tests see.
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
// Git and the check run as real processes, which a busy machine can make take seconds each. One
// that hangs is stopped and fails its test, well inside the test's own timeout.
const CHILD_TIMEOUT_MS = 15_000;

const git = (...args: string[]) =>
  execFileSync(
    "git",
    ["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", ...args],
    { encoding: "utf8", env: gitEnv, timeout: CHILD_TIMEOUT_MS },
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
    timeout: CHILD_TIMEOUT_MS,
  });
  if (result.error) throw result.error; // ETIMEDOUT when it hung
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

/** Every file under packages/contract/dist with its modification time ("" when there is none). */
function distStamp(): string {
  const dist = join(packageDir, "dist");
  return (readdirSync(dist, { recursive: true, withFileTypes: true }) as Dirent[])
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = join(entry.parentPath, entry.name);
      return `${file}:${statSync(file).mtimeMs}`;
    })
    .sort()
    .join("\n");
}

beforeAll(() => {
  distBefore = existsSync(join(packageDir, "dist")) ? distStamp() : "";
  mkdirSync(builds, { recursive: true });
  // A run that was killed leaves its build behind; remove those, but not ones a run in
  // progress may still be using.
  for (const name of readdirSync(builds)) {
    const old = join(builds, name);
    // Another run starting at the same time may already have removed it.
    const modified = statSync(old, { throwIfNoEntry: false })?.mtimeMs;
    if (name.startsWith("contract-check-") && modified && Date.now() - modified > 3_600_000) {
      rmSync(old, { recursive: true, force: true });
    }
  }
  build = mkdtempSync(join(builds, "contract-check-"));
  execFileSync(
    join(repoDir, "node_modules", ".bin", "tsc"),
    ["-p", "tsconfig.build.json", "--outDir", join(build, "dist")],
    { cwd: packageDir },
  );
  // Under node_modules Node does not see the package's own package.json, so say the build is ESM.
  writeFileSync(join(build, "package.json"), '{ "type": "module" }\n');
  script = join(build, "scripts", "contract-check.mjs");
  mkdirSync(dirname(script));
  copyFileSync(join(packageDir, "scripts", "contract-check.mjs"), script);
}, 60_000);

afterAll(() => {
  if (build) rmSync(build, { recursive: true, force: true });
});

// Every test gets a repository of its own, so no test reads what another wrote or committed.
// Four git processes: given more than a hook's default 10 s, as they can take on a busy machine.
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "contract-check-"));
  git("init", "-q");
  commit("initial");
}, 60_000);

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

const ciFile = () => join(repo, ".github", "workflows", "ci.yml");
const STEP_CHANGED = '.github/workflows/ci.yml (the "Contract compatibility" step)';
const STEP_UNREADABLE = 'no step named "Contract compatibility" could be found';
const NAME = "      - name: Contract compatibility";
const RUN = "        run: npm run contract:check -- --base HEAD^1";
/** The step as ci.yml writes it: a block scalar that runs the check. */
const STEP = [
  NAME,
  "        if: matrix.node == 24",
  "        run: |",
  "          base=HEAD^1",
  '          npm run contract:check -- --base "$base"',
];

/**
 * A workflow with the given contract step between other steps of a matrix job, and a job after
 * it that runs the steps `e2e` before its own.
 */
function ciWith(step: string[], e2e: string[] = []): string {
  return [
    "name: ci",
    "jobs:",
    "  node:",
    "    runs-on: ubuntu-latest",
    "    strategy:",
    "      matrix:",
    "        node: [24, 26]",
    "    steps:",
    "      - uses: actions/checkout@v7",
    "        with:",
    "          fetch-depth: 2",
    "      - name: Lint",
    "        run: npm run lint",
    "      # The contract is additive-only: compare with the parent commit's snapshots.",
    ...step,
    "      - run: npm run typecheck",
    "  e2e:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    ...e2e,
    "      - run: npm run build -w packages/contract",
    "      - run: npm run test:e2e",
    "",
  ].join("\n");
}

/** Commits a base with matching snapshots and the given ci.yml, which the check passes. */
function ciBase(ci: string): string {
  seedSnapshots();
  mkdirSync(dirname(ciFile()), { recursive: true });
  writeFileSync(ciFile(), ci);
  writeFileSync(ackFile(), "# Acknowledged breaking changes\n");
  const base = commit("ci at the base");
  expect(check(base)).toMatchObject({ status: 0 });
  return base;
}

/** Replaces the one occurrence of `from` in ci.yml (`$&` in `to` is the matched text). */
function edit(from: string, to: string) {
  const text = readFileSync(ciFile(), "utf8");
  expect(text.split(from)).toHaveLength(2);
  writeFileSync(ciFile(), text.replace(from, to));
}

/** Copies the code's own snapshots into the working tree of the repository. */
function seedSnapshots() {
  mkdirSync(snapshotsDir(), { recursive: true });
  cpSync(join(packageDir, "snapshots"), snapshotsDir(), { recursive: true });
}

/**
 * Commits a base whose TrackAnalysis snapshot had a field the code no longer has, and leaves
 * the working tree with the snapshots that match the code.
 */
function baseWithExtraField(): string {
  seedSnapshots();
  withExtraField();
  const base = commit("base with an extra field");
  seedSnapshots();
  return base;
}

/** The breaking lines the code reports as unacknowledged against a base with the extra field. */
function breakingLines(base: string): string[] {
  return [...check(base).out.matchAll(/^\[contract\] breaking: (.*)$/gm)].map((m) => m[1]);
}

/** A base that has the extra field in its snapshots and already acknowledges every line. */
function acknowledgedBase(): string {
  const lines = breakingLines(baseWithExtraField());
  writeFileSync(ackFile(), `# Acknowledged breaking changes\n${lines.join("\n")}\n`);
  withExtraField();
  return commit("acknowledged at the base");
}

// Each test runs node and git as processes up to about ten times, up to about 2 s in all at
// normal load and several times that on a busy machine: allow well beyond the 5 s default.
describe("contract-check", { timeout: 120_000 }, () => {
  it("builds without touching packages/contract/dist, which other test files import", () => {
    expect(existsSync(join(packageDir, "dist")) ? distStamp() : "").toBe(distBefore);
  });

  it("passes when the base has no snapshots yet, and fails on an unknown base", () => {
    const empty = commit("empty");
    expect(check(empty)).toMatchObject({ status: 0 });
    expect(check(empty).out).toContain("nothing to compare");
    expect(check("no-such-ref").status).toBe(2);
  });

  it("passes when the code matches the base snapshots", () => {
    seedSnapshots();
    const base = commit("snapshots");
    const result = check(base);
    expect(result.out).toContain("0 breaking, 0 acknowledged, 0 additive");
    expect(result.status).toBe(0);
  });

  it("fails when the code removed a field the base had", () => {
    const base = baseWithExtraField();
    const result = check(base);
    expect(result.status).toBe(1);
    expect(result.out).toContain("[contract] breaking: TrackAnalysis input $.legacyField: removed");
    expect(result.out).toContain(
      "[contract] breaking: TrackAnalysis output $.legacyField: removed",
    );
  });

  it("still fails when the change deletes or rewrites its snapshots", () => {
    const base = baseWithExtraField();
    rmSync(snapshotsDir(), { recursive: true });
    expect(check(base).status).toBe(1);
    seedSnapshots();
    expect(check(base).status).toBe(1);
  });

  it("passes when the change acknowledges each breaking line, and only then", () => {
    const base = baseWithExtraField();
    // The field is reported wherever TrackAnalysis is used (events, responses, replays).
    const lines = breakingLines(base);
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
    const base = acknowledgedBase();
    expect(git("show", `${base}:packages/contract/BREAKING-CHANGES`)).toContain("legacyField");
    expect(check(base).status).toBe(1);
  });

  it("lets a later change acknowledge the same line again by adding it once more", () => {
    const base = acknowledgedBase();
    // The lines the base already has excuse nothing in this change.
    expect(check(base).status).toBe(1);
    const acknowledged = readFileSync(ackFile(), "utf8");
    const lines = acknowledged.split("\n").filter((line) => line.includes("legacyField"));
    writeFileSync(ackFile(), `${acknowledged}${lines.join("\n")}\n`);
    const result = check(base);
    expect(result.out).toContain(`: 0 breaking, ${lines.length} acknowledged`);
    expect(result.status).toBe(0);
  });

  it("needs an engine-change line when the comparison code or its CI step changed", () => {
    // A base whose snapshots match the code, carrying the comparison code and the CI step.
    seedSnapshots();
    mkdirSync(join(repo, "packages", "contract", "src"), { recursive: true });
    mkdirSync(join(repo, ".github", "workflows"), { recursive: true });
    const compat = join(repo, "packages", "contract", "src", "compat.ts");
    const ci = ciFile();
    const step = (run: string, name = "Contract compatibility") =>
      `jobs:\n  node:\n    steps:\n      - name: ${name}\n        run: ${run}\n`;
    writeFileSync(compat, "// comparison\n");
    writeFileSync(ci, step("npm run contract:check -- --base HEAD^1"));
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
    writeFileSync(ci, step("echo skipped"));
    expect(check(base).out).toContain(STEP_CHANGED);
    expect(check(base).status).toBe(1);
    // A step that is gone, or renamed, is a change, and one that an engine-change line does
    // not excuse.
    writeFileSync(ci, step("npm run contract:check -- --base HEAD^1", "Contract check"));
    writeFileSync(ackFile(), "# Acknowledged breaking changes\nengine changed: rename\n");
    const renamed = check(base);
    expect(renamed.status).toBe(1);
    expect(renamed.out).toContain(`${STEP_CHANGED.slice(0, -1)}, removed)`);
    expect(renamed.out).toContain(STEP_UNREADABLE);
    writeFileSync(ackFile(), "# Acknowledged breaking changes\n");
    writeFileSync(ci, step("npm run contract:check -- --base HEAD^1"));
    expect(check(base).status).toBe(0);
  });

  describe("the CI step", () => {
    it("ignores lines about the contract outside the step", () => {
      const base = ciBase(ciWith(STEP));
      edit("      - run: npm run typecheck", "      # Not about the contract at all.\n$&");
      edit("# The contract is additive-only", "# The contract check is additive-only");
      // A blank line and a comment at column 0 between the step and the next one.
      edit("      - run: npm run typecheck", "\n# Typecheck after the contract.\n$&");
      expect(check(base)).toMatchObject({ status: 0 });
    });

    it("passes when a different step or another job's settings change", () => {
      // The other step's input is called name, as the step's own key is: not the step.
      const base = ciBase(
        ciWith([
          "      - uses: actions/github-script@v8",
          "        with:",
          "          name: Contract compatibility",
          "          script: console.log(1)",
          ...STEP,
        ]),
      );
      edit("npm run build -w packages/contract", "$& --if-present");
      edit("npm run lint", "npm run lint -- --max-diagnostics=50");
      edit("console.log(1)", "console.log(2)");
      edit(
        "  e2e:\n    runs-on: ubuntu-latest",
        "  e2e:\n    runs-on: ubuntu-24.04\n    if: false",
      );
      expect(check(base)).toMatchObject({ status: 0 });
    });

    it("fails when a commented-out key in the step comes before the edit", () => {
      // Comments at column 0 inside the step, as an editor's toggle-comment writes them.
      const base = ciBase(ciWith([NAME, "#        continue-on-error: true", ...STEP.slice(1)]));
      edit("base=HEAD^1", "base=HEAD");
      const result = check(base);
      expect(result.out).toContain(STEP_CHANGED);
      expect(result.status).toBe(1);
    });

    it("fails when a key follows a comment ended by a lone CR", () => {
      const base = ciBase(ciWith(STEP));
      writeFileSync(
        ciFile(),
        ciWith([...STEP, "      # Advisory for now.\r        continue-on-error: true"]),
      );
      const result = check(base);
      expect(result.out).toContain(STEP_CHANGED);
      expect(result.status).toBe(1);
    });

    // The job decides whether the step runs, and whether its failure fails the run.
    it.each([
      ["the step moves to another job", () => ciWith([], STEP)],
      [
        "continue-on-error",
        (ci: string) => ci.replace("  node:\n", "$&    continue-on-error: true\n"),
      ],
      ["if: false", (ci: string) => ci.replace("  node:\n", "$&    if: false\n")],
      ["a matrix without Node 24", (ci: string) => ci.replace("node: [24, 26]", "node: [26, 28]")],
      [
        "a default shell that swallows errors",
        (ci: string) =>
          ci.replace(
            "  node:\n",
            '$&    defaults:\n      run:\n        shell: bash -c "bash {0}; exit 0"\n',
          ),
      ],
    ])("fails when the step's job changes: %s", (_, change) => {
      const ci = ciWith(STEP);
      const base = ciBase(ci);
      expect(change(ci)).not.toBe(ci);
      writeFileSync(ciFile(), change(ci));
      const result = check(base);
      expect(result.out).toContain(STEP_CHANGED);
      expect(result.status).toBe(1);
    });

    it.each([
      ["renamed", ciWith([NAME.replace("compatibility", "check"), ...STEP.slice(1)])],
      [
        "in flow style",
        ciWith([
          "      - { name: Contract compatibility, run: npm run contract:check -- --base HEAD^1 }",
        ]),
      ],
    ])("fails on every run while the step is %s, at the base and now", (_, ci) => {
      seedSnapshots();
      mkdirSync(dirname(ciFile()), { recursive: true });
      writeFileSync(ciFile(), ci);
      writeFileSync(ackFile(), "# Acknowledged breaking changes\n");
      const base = commit("an unreadable step at the base");
      const unchanged = check(base);
      expect(unchanged.out).toContain(STEP_UNREADABLE);
      expect(unchanged.status).toBe(1);
      edit("HEAD^1", "HEAD");
      writeFileSync(ackFile(), "# Acknowledged breaking changes\nengine changed: compare HEAD\n");
      expect(check(base)).toMatchObject({ status: 1 });
    });

    it("fails when the step's run changes, though the changed line does not say contract", () => {
      const base = ciBase(ciWith(STEP));
      edit("base=HEAD^1", "base=HEAD");
      const result = check(base);
      expect(result.out).toContain(STEP_CHANGED);
      expect(result.status).toBe(1);
    });

    it("reads the lines of block scalars as content, though they start with a dash", () => {
      const base = ciBase(
        ciWith([
          // Another step whose script prints a step by that name: not the step.
          "      - name: Example",
          "        run: |",
          "          cat <<'EOF'",
          NAME.replace("      ", "          "),
          "            run: true",
          "          EOF",
          ...STEP.slice(0, 3),
          "          cat <<'EOF'",
          "          - compares the schemas with the parent commit's snapshots",
          "          - name: not a step",
          "          EOF",
          ...STEP.slice(3),
        ]),
      );
      edit("run: true", "run: false");
      expect(check(base)).toMatchObject({ status: 0 });
      edit("base=HEAD^1", "base=HEAD");
      const result = check(base);
      expect(result.out).toContain(STEP_CHANGED);
      expect(result.status).toBe(1);
    });

    // However the step is written, adding continue-on-error, which hides its failure, fails.
    it.each([
      ["with name: first", STEP],
      ["with name: after - run:", [RUN.replace("        ", "      - "), NAME.replace("- ", "  ")]],
      [
        "with name: after - uses:",
        ["      - uses: ./.github/actions/contract", NAME.replace("- ", "  ")],
      ],
      ["with a double-quoted name", ['      - name: "Contract compatibility"', RUN]],
      [
        "with a single-quoted name and a comment",
        ["      - name: 'Contract compatibility' # x", RUN],
      ],
      ["with the dash on a line of its own", ["      -", NAME.replace("- ", "  "), RUN]],
      ["after a comment at the dash's column", [...STEP, "      # Advisory for now."]],
      ["after a comment at column 0", [...STEP, "# TODO: drop once the snapshots settle"]],
    ])("fails when continue-on-error is added to the step %s, and names it", (_, step) => {
      const base = ciBase(ciWith(step));
      writeFileSync(ciFile(), ciWith([...step, "        continue-on-error: true"]));
      const result = check(base);
      expect(result.out).toContain(STEP_CHANGED);
      expect(result.status).toBe(1);
    });
  });

  it("needs an engine-change line when the zod the contract resolves changed", () => {
    seedSnapshots();
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
