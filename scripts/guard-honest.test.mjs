// Fixture tests for the honesty guard: each rule must keep catching the forms below, and the
// baseline must stay one-way. Run with `npm test`.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { countInText, rules } from "./guard-honest.mjs";

const rule = (id) => rules.find((candidate) => candidate.id === id);
const count = (id, text) => countInText(rule(id), text).total;

describe("random-values-api", () => {
  it.each([
    ["a direct call", "const bpm = 120 + Math.random() * 15;"],
    ["a call with a misleading comment", "const bpm = 120 + Math.random() * 15; // jitter"],
    ["a call in a jitter-named variable", "const jitteredEnergy = 0.5 + Math.random() * 0.3;"],
    ["an alias", "const rnd = Math.random;"],
    ["destructuring", "const { random } = Math;"],
    ["destructuring with other names", "const { floor, random } = Math;"],
    ["renamed destructuring", "const { random: r } = Math;"],
    ["optional chaining", "const v = Math?.random();"],
    ["crypto helpers", "const v = randomInt(10);"],
  ])("counts %s", (_name, line) => {
    expect(count("random-values-api", line)).toBe(1);
  });

  it("allows one match per marked line and counts the rest", () => {
    const marked =
      "const id = Math.random().toString(36); // guard-allow: random-values-api — identifier";
    expect(count("random-values-api", marked)).toBe(0);
    const twice = `const id = Math.random().toString(36) && Math.random(); // guard-allow: random-values-api — identifier`;
    expect(count("random-values-api", twice)).toBe(1);
  });

  it("requires a reason in the marker", () => {
    expect(count("random-values-api", "Math.random(); // guard-allow: random-values-api")).toBe(1);
  });
});

describe("hex-colours-outside-tokens", () => {
  it.each([
    ["3 digits", 'fill="#fff"'],
    ["4 digits with alpha", 'const c = "#abcd";'],
    ["6 digits", "color: '#00f0ff'"],
    ["8 digits", "color: '#00f0ff80'"],
    ["code after a block comment", "/* brand */ export const c = '#ff0000';"],
  ])("counts %s", (_name, line) => {
    expect(count("hex-colours-outside-tokens", line)).toBe(1);
  });

  it.each([
    ["a line comment", "// see issue #100"],
    ["a trailing comment", "const a = 1; // fixed in #123"],
    ["a JSDoc line", " * Matches #abc in the docs"],
    ["an element id", 'href="#add-button"'],
  ])("ignores %s", (_name, line) => {
    expect(count("hex-colours-outside-tokens", line)).toBe(0);
  });
});

describe("dotenv-outside-config", () => {
  it.each([
    ["dotenv.config()", "dotenv.config();"],
    ['import "dotenv/config"', 'import "dotenv/config";'],
    ["a named config import", 'import { config } from "dotenv";'],
  ])("counts %s", (_name, line) => {
    expect(count("dotenv-outside-config", line)).toBe(1);
  });
});

describe("string-sentinel-tool-results", () => {
  it.each([
    ["startsWith", 'if (result.startsWith("Error")) {}'],
    ["includes", 'if (result.includes("No results")) {}'],
    ["equality", 'if (result === "No track found") {}'],
    ["a regex", "if (/^Error/.test(result)) {}"],
  ])("counts %s", (_name, line) => {
    expect(count("string-sentinel-tool-results", line)).toBe(1);
  });
});

describe("stock-images-web", () => {
  it.each([
    ["picsum", "const img = 'https://picsum.photos/200';"],
    ["unsplash", 'src="https://images.unsplash.com/photo-1"'],
  ])("counts %s", (_name, line) => {
    expect(count("stock-images-web", line)).toBe(1);
  });
});

describe("tailwind-v3-variable-classes", () => {
  it("counts each -[--token] class", () => {
    expect(
      count("tailwind-v3-variable-classes", 'className="p-[--space-md] rounded-[--radius-sm]"'),
    ).toBe(2);
  });

  it("ignores the Tailwind v4 form", () => {
    expect(count("tailwind-v3-variable-classes", 'className="p-(--space-md)"')).toBe(0);
  });
});

describe("baselines", () => {
  // The CLI runs in a throwaway repository, isolated from the surrounding git setup
  // (GIT_DIR and friends, hooks, signing, global config).
  const isolatedEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  Object.assign(isolatedEnv, { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" });
  const script = join(dirname(fileURLToPath(import.meta.url)), "guard-honest.mjs");
  let dir;

  // A throwaway repository with the guard, a baseline and one API file.
  function repo(baseline, source) {
    dir = mkdtempSync(join(tmpdir(), "guard-"));
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "apps/api/src"), { recursive: true });
    copyFileSync(script, join(dir, "scripts/guard-honest.mjs"));
    const full = {
      "random-values-api": 0,
      "stock-images-web": 0,
      "tailwind-v3-variable-classes": 0,
      "hex-colours-outside-tokens": 0,
      "dotenv-outside-config": 0,
      "string-sentinel-tool-results": 0,
      ...baseline,
    };
    writeFileSync(join(dir, "scripts/guard-baseline.json"), `${JSON.stringify(full)}\n`);
    writeFileSync(join(dir, "apps/api/src/a.ts"), source);
    const git = (...args) =>
      execFileSync("git", args, { cwd: dir, stdio: "ignore", env: isolatedEnv });
    git("init", "-q");
    git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "base");
    return dir;
  }

  const run = (...args) =>
    spawnSync("node", ["scripts/guard-honest.mjs", ...args], {
      cwd: dir,
      encoding: "utf8",
      env: isolatedEnv,
    });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("fails above the baseline", () => {
    repo({ "random-values-api": 1 }, "Math.random(); Math.random();\n");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/random-values-api\s+2 \/ 1\s+ABOVE BASELINE/);
  });

  it("fails below the baseline until it is lowered, and --update lowers it", () => {
    repo({ "random-values-api": 2 }, "Math.random();\n");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/fell below its baseline/);
    expect(run("--update").status).toBe(0);
    expect(run().status).toBe(0);
  });

  it("fails when a change raises a baseline against --base", () => {
    repo({ "random-values-api": 1 }, "Math.random();\n");
    writeFileSync(
      join(dir, "scripts/guard-baseline.json"),
      JSON.stringify({
        "random-values-api": 5,
        "stock-images-web": 0,
        "tailwind-v3-variable-classes": 0,
        "hex-colours-outside-tokens": 0,
        "dotenv-outside-config": 0,
        "string-sentinel-tool-results": 0,
      }),
    );
    const result = run("--base", "HEAD");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/raised from 1 to 5/);
  });

  it("rejects a baseline that is not a non-negative integer", () => {
    repo({ "random-values-api": "many" }, "Math.random();\n");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must be a non-negative integer/);
  });
});
