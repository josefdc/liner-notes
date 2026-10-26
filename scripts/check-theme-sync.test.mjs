// Tests for the theme generator (apps/web/config/theme.mjs) and its staleness check
// (scripts/check-theme-sync.mjs). Run with `npm test`.

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  generateTheme,
  strayThemeTokens,
  THEME_PATH,
  TOKENS_PATH,
  themeColors,
} from "../apps/web/config/theme.mjs";
import { checkThemeSync } from "./check-theme-sync.mjs";

const script = join(import.meta.dirname, "check-theme-sync.mjs");
const generator = join(import.meta.dirname, "..", "apps", "web", "config", "theme.mjs");

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "theme-sync-"));
  dirs.push(dir);
  return dir;
}
function files(tokens, theme) {
  const dir = tempDir();
  writeFileSync(join(dir, "tokens.css"), tokens);
  writeFileSync(join(dir, "theme.ts"), theme);
  return [join(dir, "tokens.css"), join(dir, "theme.ts")];
}
/** A source directory: styles/tokens.css plus other stylesheets ({ "styles/x.css": css }). */
function sourceDir(sheets) {
  const dir = tempDir();
  mkdirSync(join(dir, "styles"));
  writeFileSync(join(dir, "styles", "tokens.css"), "@theme { --color-void: #050505; }");
  for (const [path, css] of Object.entries(sheets)) writeFileSync(join(dir, path), css);
  return dir;
}
function check(tokensPath, themePath, srcDir) {
  const out = [];
  const code = checkThemeSync(
    tokensPath,
    themePath,
    (line) => out.push(line),
    (line) => out.push(line),
    srcDir,
  );
  return { code, out: out.join("\n") };
}

const tokens = readFileSync(TOKENS_PATH, "utf8");

describe("check-theme-sync", () => {
  it("passes on the theme.ts in the repository", () => {
    const { code, out } = check(TOKENS_PATH, THEME_PATH);
    expect(code, out).toBe(0);
  });

  it("fails when a token changed and theme.ts was not regenerated", () => {
    const changed = tokens.replace("--color-cyber: #00f0ff;", "--color-cyber: #00e0ff;");
    expect(changed).not.toBe(tokens);
    const [tokensPath, themePath] = files(changed, readFileSync(THEME_PATH, "utf8"));
    const { code, out } = check(tokensPath, themePath);
    expect(code).toBe(1);
    expect(out).toContain("is out of date");
    expect(out).toContain(`expected "  cyber: '#00e0ff',", found "  cyber: '#00f0ff',"`);
    expect(out).toContain("npm run theme -w apps/web");
  });

  it("fails on a hand edit of theme.ts", () => {
    const edited = readFileSync(THEME_PATH, "utf8").replace("#ffb000", "#f59e0b");
    const [tokensPath, themePath] = files(tokens, edited);
    expect(check(tokensPath, themePath).code).toBe(1);
  });

  it("fails when another stylesheet declares a token in an @theme block", () => {
    const src = sourceDir({
      "styles/index.css":
        "@theme { @keyframes k { from { opacity: 0; } } --color-text-faint: rgba(255, 255, 255, 0.2); }",
    });
    const { code, out } = check(TOKENS_PATH, THEME_PATH, src);
    expect(code).toBe(1);
    expect(out).toContain("tokens declared outside tokens.css");
    expect(out).toContain("styles/index.css: --color-text-faint");
  });

  it("allows @keyframes alone in another @theme block, and finds the app's sheets clean", () => {
    const src = sourceDir({
      "styles/index.css": "@theme { @keyframes k { from { opacity: 0; } } }\n:root { --x: 1px; }",
    });
    expect(strayThemeTokens(src)).toEqual([]);
    expect(strayThemeTokens()).toEqual([]);
  });

  it("exits 2 when a file is missing or a token does not resolve", () => {
    const [tokensPath] = files(tokens, "");
    expect(check(tokensPath, join(tokensPath, "..", "missing.ts")).code).toBe(2);
    const broken = tokens.replace(
      "--shadow-glow-analog: 0 0 20px color-mix(in srgb, var(--color-analog) 25%, transparent);",
      "--shadow-glow-analog: 0 0 20px color-mix(in srgb, var(--color-analgo) 25%, transparent);",
    );
    expect(broken).not.toBe(tokens);
    const [brokenPath, themePath] = files(broken, readFileSync(THEME_PATH, "utf8"));
    const { code, out } = check(brokenPath, themePath);
    expect(code).toBe(2);
    expect(out).toContain("--shadow-glow-analog: --color-analgo is not defined");
  });

  it("runs as a script", () => {
    const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
    expect(run().status).toBe(0);
    const stale = files(tokens.replace("#ec4899", "#ec4898"), readFileSync(THEME_PATH, "utf8"));
    const result = run(...stale);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("is out of date");
  });
});

describe("theme generator", () => {
  const sample = `@theme {
    --color-void: #050505;
    --color-void-light: #0a0a0a;
    --color-cyber: #00f0ff;
    --color-analog: #ffb000;
    --color-viz-cyan: var(--color-cyber);
    --color-viz-pink: #ec4899;
    --color-viz-blue: #3b82f6;
    --color-viz-green: #22c55e;
    --color-relation-sample: var(--color-analog);
    --color-relation-interpolation: var(--color-viz-pink);
    --color-relation-cover: var(--color-viz-green);
    --color-relation-remix: #e5e7eb;
    --color-relation-producer: var(--color-viz-blue);
    --color-relation-influence: var(--color-gray-400);
    --color-accent-pink: #f9a8d4;
    --color-accent-blue: #93c5fd;
    --color-status-warning: #fb923c;
    --color-text-tertiary: rgba(255, 255, 255, 0.55);
    --color-gray-400: #9ca3af;
    --color-gray-500: #6b7280;
    --color-gray-600: #4b5563;
    --space-md: 16px;
  }`;

  it("names each colour token and resolves its aliases", () => {
    expect(themeColors(sample)).toEqual({
      void: "#050505",
      voidLight: "#0a0a0a",
      cyber: "#00f0ff",
      analog: "#ffb000",
      viz: { cyan: "#00f0ff", pink: "#ec4899", blue: "#3b82f6", green: "#22c55e" },
      // The data-visualisation colours under their hue names too.
      cyan: "#00f0ff",
      pink: "#ec4899",
      blue: "#3b82f6",
      green: "#22c55e",
      // The genealogy relations, named by relation.
      relation: {
        sample: "#ffb000",
        interpolation: "#ec4899",
        cover: "#22c55e",
        remix: "#e5e7eb",
        producer: "#3b82f6",
        influence: "#9ca3af",
      },
      accent: { pink: "#f9a8d4", blue: "#93c5fd" },
      warning: "#fb923c",
      text: { tertiary: "rgba(255, 255, 255, 0.55)" },
      gray: { 400: "#9ca3af", 500: "#6b7280", 600: "#4b5563" },
    });
  });

  it("writes the colours and the chart roles as TypeScript", () => {
    const theme = generateTheme(sample);
    expect(theme).toMatch(/^\/\/ Generated from tokens\.css/);
    expect(theme).toContain("  viz: {\n    cyan: '#00f0ff',\n    pink: '#ec4899',\n");
    expect(theme).toContain("  gray: {\n    400: '#9ca3af',\n");
    expect(theme).toContain("export const genealogyColors = {\n  current: colors.cyber,\n");
    expect(theme).toContain("export const linkColors = {\n  sample: colors.relation.sample,\n");
    expect(theme).toContain("  cover: colors.relation.cover,\n");
    expect(theme).not.toContain("space");
  });

  it("keeps the export names and colour keys the charts and the graph use", () => {
    const theme = generateTheme(tokens);
    for (const name of ["colors", "genealogyColors", "linkColors"]) {
      expect(theme).toContain(`export const ${name} = {`);
    }
    const colors = themeColors(tokens);
    for (const key of ["void", "cyber", "analog", "pink", "green", "blue"]) {
      expect(colors[key], key).toMatch(/^#[0-9a-f]{6}$/);
    }
    // Violet is the inferred colour alone: no purple or indigo hue is left.
    for (const key of ["purple", "indigo", "violet"]) {
      expect(colors[key], key).toBeUndefined();
      expect(colors.viz[key], key).toBeUndefined();
      expect(colors.accent[key], key).toBeUndefined();
    }
    // Every genealogy relation has a colour of its own, named by relation.
    expect(Object.keys(colors.relation)).toEqual([
      "sample",
      "interpolation",
      "cover",
      "remix",
      "producer",
      "influence",
    ]);
    expect(new Set(Object.values(colors.relation)).size).toBe(6);
    // The chart and graph hues stay the data-visualisation values, not the lighter text ones.
    for (const hue of ["pink", "blue"]) {
      expect(colors[hue], hue).toBe(colors.viz[hue]);
      expect(colors.accent[hue], hue).not.toBe(colors.viz[hue]);
    }
    for (const shade of [300, 400, 500, 600, 700]) {
      expect(colors.gray[shade], `gray ${shade}`).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(Object.keys(colors.prov)).toEqual(["measured", "sourced", "inferred", "missing"]);
  });

  it("has one amber for history and sources, and an orange of its own for warnings", () => {
    const colors = themeColors(tokens);
    const amber = new Set([colors.analog, colors.amber, colors.accent.amber, colors.prov.sourced]);
    expect(amber).toEqual(new Set([colors.analog]));
    for (const other of [colors.analog, colors.prov.inferred, colors.error]) {
      expect(colors.warning).not.toBe(other);
    }
  });

  it("rejects a colour token that is not a colour, and two tokens with one key", () => {
    expect(() => generateTheme("@theme { --color-void: red; }")).toThrow(
      '--color-void: "red" is not a hex or rgb() colour',
    );
    expect(() =>
      generateTheme("@theme { --color-pink: #ec4899; --color-viz-pink: #ec4898; }"),
    ).toThrow("--color-viz-pink: colors.pink is already taken by another token");
    expect(() =>
      generateTheme("@theme { --color-text: #ffffff; --color-text-primary: #eeeeee; }"),
    ).toThrow("--color-text-primary: colors.text is a colour, so it cannot also be a family");
  });

  it("takes names an object already has (constructor, toString) as colour names", () => {
    expect(
      themeColors("@theme { --color-constructor: #111111; --color-to-string: #222222; }"),
    ).toEqual({ constructor: "#111111", toString: "#222222" });
  });

  it("rejects a token whose alias does not resolve, colour or not", () => {
    expect(() =>
      generateTheme("@theme { --color-void: #050505; --shadow-x: 0 0 1px var(--color-nope); }"),
    ).toThrow("--shadow-x: --color-nope is not defined");
  });

  it("rejects a chart role whose colour is not a token", () => {
    expect(() => generateTheme("@theme { --color-void: #050505; }")).toThrow(
      "genealogyColors.current: --color-cyber is not a token",
    );
  });

  it("writes theme.ts only when it changes", () => {
    const [tokensPath, themePath] = files(tokens, "stale");
    const run = () =>
      spawnSync(process.execPath, [generator, tokensPath, themePath], { encoding: "utf8" });
    expect(run().status).toBe(0);
    expect(readFileSync(themePath, "utf8")).toBe(generateTheme(tokens));
    const past = new Date("2020-01-01T00:00:00Z");
    utimesSync(themePath, past, past);
    expect(run().status).toBe(0);
    expect(statSync(themePath).mtime.getTime()).toBe(past.getTime());
  });

  it("fails and writes nothing on a broken sheet", () => {
    const [tokensPath, themePath] = files("@theme { --color-void: #050505;", "kept");
    const result = spawnSync(process.execPath, [generator, tokensPath, themePath], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("theme: 1 block(s) not closed");
    expect(readFileSync(themePath, "utf8")).toBe("kept");
  });
});
