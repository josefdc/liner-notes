// Tests for the theme generator (apps/web/config/theme.mjs) and its staleness check
// (scripts/check-theme-sync.mjs). Run with `npm test`.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateTheme, THEME_PATH, TOKENS_PATH, themeColors } from "../apps/web/config/theme.mjs";
import { checkThemeSync } from "./check-theme-sync.mjs";

const script = join(import.meta.dirname, "check-theme-sync.mjs");

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function files(tokens, theme) {
  const dir = mkdtempSync(join(tmpdir(), "theme-sync-"));
  dirs.push(dir);
  writeFileSync(join(dir, "tokens.css"), tokens);
  writeFileSync(join(dir, "theme.ts"), theme);
  return [join(dir, "tokens.css"), join(dir, "theme.ts")];
}
function check(tokensPath, themePath) {
  const out = [];
  const code = checkThemeSync(
    tokensPath,
    themePath,
    (line) => out.push(line),
    (line) => out.push(line),
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

  it("exits 2 when a file is missing", () => {
    const [tokensPath] = files(tokens, "");
    expect(check(tokensPath, join(tokensPath, "..", "missing.ts")).code).toBe(2);
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
    --color-accent-pink: var(--color-viz-pink);
    --color-status-warning: var(--color-analog);
    --color-text-tertiary: rgba(255, 255, 255, 0.5);
    --color-gray-500: #6b7280;
    --color-gray-600: #4b5563;
    --color-purple: #a855f7;
    --color-green: #22c55e;
    --color-indigo: #6366f1;
    --space-md: 16px;
  }`;

  it("names each colour token and resolves its aliases", () => {
    expect(themeColors(sample)).toEqual({
      void: "#050505",
      voidLight: "#0a0a0a",
      cyber: "#00f0ff",
      analog: "#ffb000",
      viz: { cyan: "#00f0ff", pink: "#ec4899" },
      pink: "#ec4899",
      warning: "#ffb000",
      text: { tertiary: "rgba(255, 255, 255, 0.5)" },
      gray: { 500: "#6b7280", 600: "#4b5563" },
      purple: "#a855f7",
      green: "#22c55e",
      indigo: "#6366f1",
    });
  });

  it("writes the colours and the chart roles as TypeScript", () => {
    const theme = generateTheme(sample);
    expect(theme).toMatch(/^\/\/ Generated from tokens\.css/);
    expect(theme).toContain("  viz: {\n    cyan: '#00f0ff',\n    pink: '#ec4899',\n  },\n");
    expect(theme).toContain("  gray: {\n    500: '#6b7280',\n");
    expect(theme).toContain("export const genealogyColors = {\n  current: colors.cyber,\n");
    expect(theme).toContain("  silence: colors.gray[500],\n");
    expect(theme).not.toContain("space");
  });

  it("keeps the export names and colour keys the charts and the graph use", () => {
    const theme = generateTheme(tokens);
    for (const name of ["colors", "genealogyColors", "linkColors", "keyMomentColors"]) {
      expect(theme).toContain(`export const ${name} = {`);
    }
    const colors = themeColors(tokens);
    for (const key of ["void", "cyber", "analog", "purple", "pink", "green", "indigo", "blue"]) {
      expect(colors[key], key).toMatch(/^#[0-9a-f]{6}$/);
    }
    for (const shade of [300, 400, 500, 600, 700]) {
      expect(colors.gray[shade], `gray ${shade}`).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(Object.keys(colors.prov)).toEqual(["measured", "sourced", "inferred", "missing"]);
  });

  it("has one amber", () => {
    const colors = themeColors(tokens);
    expect(new Set([colors.analog, colors.amber, colors.warning, colors.prov.sourced])).toEqual(
      new Set([colors.analog]),
    );
  });

  it("rejects a colour token that is not a colour, and two tokens with one key", () => {
    expect(() => generateTheme("@theme { --color-void: red; }")).toThrow(
      '--color-void: "red" is not a hex or rgb() colour',
    );
    expect(() =>
      generateTheme("@theme { --color-pink: #ec4899; --color-accent-pink: #ec4898; }"),
    ).toThrow('colors key "pink" is already taken');
  });

  it("rejects a chart role whose colour is not a token", () => {
    expect(() => generateTheme("@theme { --color-void: #050505; }")).toThrow(
      "genealogyColors.current: no colour colors.cyber",
    );
  });
});
