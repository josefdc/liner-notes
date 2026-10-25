// Fixture tests for the honesty guard: each rule must keep catching the forms below, and the
// baseline must stay one-way. Run with `npm test`.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { countInText, rules } from "./guard-honest.mjs";

const rule = (id) => rules.find((candidate) => candidate.id === id);
// `path` decides how comments and strings are read; snippets default to a TSX file.
const count = (id, text, path = "apps/web/src/snippet.tsx") =>
  countInText(rule(id), text, path).total;

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
    ["a JSDoc block", "/**\n * Matches #abc in the docs\n */\nconst a = 1;"],
    ["an element id", 'href="#add-button"'],
  ])("ignores %s", (_name, line) => {
    expect(count("hex-colours-outside-tokens", line)).toBe(0);
  });
});

describe("comment stripping", () => {
  it("keeps `//` inside a string and in JSX text, and counts code after a block comment", () => {
    expect(count("hex-colours-outside-tokens", "const url = 'a // #fff';")).toBe(1);
    expect(count("prototype-copy", "<p>X9-ALPHA {'//'} STATUS: ONLINE</p>")).toBe(2);
    expect(count("prototype-copy", "<p>AGENT_ID // STATUS: ONLINE</p>")).toBe(2);
    expect(count("prototype-copy", "/* note */ const t = 'Command Center';")).toBe(1);
  });

  it("blanks comments that span lines in scripts, CSS and HTML", () => {
    expect(
      count("hex-colours-outside-tokens", "/*\n  old: #fff\n*/\na { color: red; }", "a.css"),
    ).toBe(0);
    expect(
      count("prototype-copy", "<!--\n  <title>The Sonic Agent</title>\n-->", "apps/web/index.html"),
    ).toBe(0);
  });

  it("reports matches on their own line numbers", () => {
    const text = "/*\n * Command Center\n */\nconst a = 'Command Center';\n";
    expect(countInText(rule("prototype-copy"), text, "apps/web/src/a.ts")).toEqual({
      total: 1,
      lines: [4],
    });
  });
});

describe("prototype-copy", () => {
  it.each([
    ["the old product name in JSX text", "<h1>The Sonic Agent</h1>"],
    ["the old product name in the page title", "<title>The Sonic Agent</title>"],
    ["a dashboard heading", "<h2>Command Center</h2>"],
    ["an upper-case variant", "const done = 'INTEL READY';"],
    ["a button label", "<button>ANALYZE_SONG</button>"],
    ["the decrypt button", "<span>[ DECRYPT MORE ]</span>"],
    [
      "a progress message",
      'status("GRAPH-ENRICH", "Cross-referencing visual artifacts from Spotify...");',
    ],
    ["a template literal", `const m = \`Target acquired: \${title}\`;`],
    ["a word in any case", "return 'Uplink unstable. Check your connection.';"],
  ])("counts %s", (_name, line) => {
    expect(count("prototype-copy", line)).toBe(1);
  });

  it("counts each phrase on a line", () => {
    expect(count("prototype-copy", "<p>AGENT_ID: X9-ALPHA {'//'} STATUS: ONLINE</p>")).toBe(3);
  });

  it.each([
    ["plain copy", "<h1>Liner Notes</h1>"],
    ["identifiers", "const graph = buildSonicAgentGraph(); type S = SonicAgentStateType;"],
    ["handler and constant names", "onClick={handleDecryptMore} const n = DECRYPT_COUNT;"],
    ["the route path", 'router.post("/api/factoids/decrypt", handler);'],
    ["the database file name", 'join(root, "data", "sonic-agent.db")'],
    ["a word that only contains a phrase", "const intelligent = 'INTELLIGENT';"],
  ])("ignores %s", (_name, line) => {
    expect(count("prototype-copy", line)).toBe(0);
  });

  it.each([
    ["a line comment", "// The Sonic Agent dashboard"],
    ["a trailing comment", "const a = 1; // was Command Center"],
    ["a JSDoc block", "/**\n * Genealogy Enricher for The Sonic Agent\n */\nexport {};"],
    ["a JSX comment", "<div>\n  {/* Factoids added by DECRYPT MORE */}\n</div>"],
    ["a JSX comment over several lines", "<div>\n  {/*\n    BACK TO BASE\n  */}\n</div>"],
  ])("ignores %s", (_name, text) => {
    expect(count("prototype-copy", text)).toBe(0);
  });

  it("scans web and API source and the page, but not tests, test helpers or fixtures", () => {
    const { files } = rule("prototype-copy");
    expect(files("apps/web/src/components/Dashboard.tsx")).toBe(true);
    expect(files("apps/api/src/agent/nodes/scoutNode.ts")).toBe(true);
    expect(files("apps/web/index.html")).toBe(true);
    expect(files("apps/web/src/components/Player.test.tsx")).toBe(false);
    expect(files("apps/api/src/agent/testing/stubLlm.ts")).toBe(false);
    expect(files("apps/api/test/fixtures/odd-exception.ts")).toBe(false);
    expect(files("tests/web/mock.ts")).toBe(false);
    expect(files("fixtures/replays/one-more-time-daft-punk.json")).toBe(false);
  });
});

describe("emoji-in-progress", () => {
  const api = "apps/api/src/agent/nodes/scoutNode.ts";

  it.each([
    ["a status message", 'statusMessages: ["❌ No usable matches"],'],
    ["a template literal", `status(\`🔍 \${plan.reasoning}\`);`],
    ["an emoji with a variation selector", 'const m = "⚠️ Skipping audio analysis";'],
    ["a sequence of several code points", 'const m = "👩‍🔬 Researching";'],
    ["a web log line", "addLog(`🎵 Resuming with selected track...`);"],
  ])("counts %s", (_name, line) => {
    expect(count("emoji-in-progress", line, api)).toBe(1);
  });

  it.each([
    ["plain text", 'status("Searching samples...");'],
    ["a symbol that is not an emoji", 'const m = "BPM — 120 • ▶ ©";'],
    ["a line comment", "// 🔎 shown while searching"],
    ["a block comment", "/*\n 🔬 deep research\n*/\nconst a = 1;"],
    ["JSX text", "<span>⚡ Explore</span>"],
  ])("ignores %s", (_name, line) => {
    expect(count("emoji-in-progress", line, api.replace(/\.ts$/, ".tsx"))).toBe(0);
  });

  it("scans API source and the web's agent hooks, but not components or tests", () => {
    const { files } = rule("emoji-in-progress");
    expect(files("apps/api/src/agent/researcherSubgraph.ts")).toBe(true);
    expect(files("apps/web/src/hooks/useAgent.ts")).toBe(true);
    expect(files("apps/web/src/components/GenealogyGraph.tsx")).toBe(false);
    expect(files("apps/api/src/agent/researcherSubgraph.test.ts")).toBe(false);
    expect(files("apps/web/src/hooks/useAgent.test.ts")).toBe(false);
    expect(files("apps/api/src/sources/testing/iceIceBaby.ts")).toBe(false);
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
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const script = join(repoRoot, "scripts", "guard-honest.mjs");
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
      "prototype-copy": 0,
      "emoji-in-progress": 0,
      ...baseline,
    };
    writeFileSync(join(dir, "scripts/guard-baseline.json"), `${JSON.stringify(full)}\n`);
    writeFileSync(join(dir, "apps/api/src/a.ts"), source);
    // The guard reads scripts with the TypeScript parser from the repository's node_modules.
    symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
    writeFileSync(join(dir, ".gitignore"), "node_modules\n");
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
        "prototype-copy": 0,
        "emoji-in-progress": 0,
      }),
    );
    const result = run("--base", "HEAD");
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/raised from 1 to 5/);
  });

  it("fails when prototype copy or an emoji progress message is added", () => {
    repo({}, 'status("Searching samples...");\n');
    expect(run().status).toBe(0);
    writeFileSync(
      join(dir, "apps/api/src/a.ts"),
      'status("🔎 Searching samples..."); status("Target acquired");\n',
    );
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/prototype-copy\s+1 \/ 0\s+ABOVE BASELINE/);
    expect(result.stdout).toMatch(/emoji-in-progress\s+1 \/ 0\s+ABOVE BASELINE/);
  });

  it("rejects a baseline that is not a non-negative integer", () => {
    repo({ "random-values-api": "many" }, "Math.random();\n");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must be a non-negative integer/);
  });
});
