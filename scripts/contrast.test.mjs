// Tests for the token contrast check (scripts/contrast.mjs, apps/web/config/contrast.mjs).
// Run with `npm test`.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contrastRatio, contrastReport, main, over } from "../apps/web/config/contrast.mjs";
import { parseColor, readTokens, resolveToken } from "../apps/web/config/tokens.mjs";

const root = join(import.meta.dirname, "..");
const tokensPath = join(root, "apps", "web", "src", "styles", "tokens.css");
const script = join(import.meta.dirname, "contrast.mjs");

// The text colours of apps/web/src/styles/index.css before the tokens moved to tokens.css.
const OLD_THEME = `@theme {
  --color-void: #050505;
  --color-surface-active: rgba(255, 255, 255, 0.12);
  --color-text-primary: rgba(255, 255, 255, 0.95);
  --color-text-tertiary: rgba(255, 255, 255, 0.45);
  --color-text-muted: rgba(255, 255, 255, 0.25);
  @keyframes pulse-glow { 0%, 100% { box-shadow: 0 0 5px #00f0ff; } }
}`;

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function sheet(css) {
  const dir = mkdtempSync(join(tmpdir(), "contrast-"));
  dirs.push(dir);
  const path = join(dir, "tokens.css");
  writeFileSync(path, css);
  return path;
}
function run(args) {
  const out = [];
  const err = [];
  const code = main(
    args,
    (line) => out.push(line),
    (line) => err.push(line),
  );
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("contrast ratio", () => {
  it("follows WCAG 2", () => {
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const black = { r: 0, g: 0, b: 0, a: 1 };
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5);
    // #767676 is the darkest grey with 4.5:1 on white.
    expect(contrastRatio(parseColor("#767676"), white)).toBeCloseTo(4.54, 2);
  });

  it("measures a translucent colour as drawn over the one below", () => {
    const drawn = over(parseColor("rgba(255, 255, 255, 0.5)"), parseColor("#000000"));
    expect(drawn).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
  });
});

describe("contrast report", () => {
  it("passes every text and data-visualisation token in tokens.css", () => {
    const { code, out } = run([tokensPath]);
    expect(code, out).toBe(0);
    expect(out).toMatch(/^ok {3}--color-text-tertiary /m);
    expect(out).toMatch(/^ok {3}--color-text-muted /m);
    expect(out).toMatch(/^ok {3}--color-prov-inferred /m);
    expect(out).toMatch(/^ok {3}--color-viz-indigo +needs 3:1 /m);
  });

  it("checks the provenance, status and visualisation families and the surfaces", () => {
    const report = contrastReport(readFileSync(tokensPath, "utf8"));
    const names = report.map((entry) => entry.name);
    for (const kind of ["measured", "sourced", "inferred", "missing"]) {
      expect(names).toContain(`--color-prov-${kind}`);
    }
    expect(names).toContain("--color-status-error");
    expect(names.filter((name) => name.startsWith("--color-viz-")).length).toBeGreaterThanOrEqual(
      6,
    );
    const surfaces = report[0].results.map((result) => result.surface);
    expect(surfaces).toEqual(
      expect.arrayContaining(["--color-void", "--color-void-lighter", "--color-surface-active"]),
    );
    for (const entry of report) {
      expect(entry.lowest.ratio, entry.name).toBeGreaterThanOrEqual(entry.minimum);
    }
  });

  it("fails the old text colours: tertiary 4.45:1 and muted 2.07:1 on the page", () => {
    const { code, out, err } = run([sheet(OLD_THEME)]);
    expect(code).toBe(1);
    expect(out).toMatch(/^FAIL --color-text-tertiary .*4\.45:1 on --color-void(,|$)/m);
    expect(out).toMatch(/^FAIL --color-text-muted .*2\.07:1 on --color-void(,|$)/m);
    expect(out).toMatch(/^ok {3}--color-text-primary /m);
    expect(err).toContain("2 of 3 colours fall short");
  });

  it("measures text on a translucent surface as drawn on the page", () => {
    const report = contrastReport(OLD_THEME);
    const tertiary = report.find((entry) => entry.name === "--color-text-tertiary");
    const active = tertiary.results.find((result) => result.surface === "--color-surface-active");
    // 0.45 white over (0.12 white over #050505) against that surface.
    expect(active.ratio).toBeCloseTo(4.317, 3);
  });

  it("does not round a ratio up to the minimum", () => {
    // 4.4999:1 must not print as 4.50:1.
    const css = "@theme { --color-void: #ffffff; --color-text-primary: #767777; }";
    const { code, out } = run([sheet(css)]);
    expect(code).toBe(1);
    expect(out).toMatch(/4\.4\d:1/);
  });

  it("exits 2 on a sheet it cannot check", () => {
    expect(run([]).code).toBe(2);
    expect(run([sheet("@theme { --color-text-primary: #fff; }")]).err).toContain(
      "--color-void (the page colour) is not defined",
    );
    const unreadable = run([sheet("@theme { --color-void: #000; --color-text-primary: red; }")]);
    expect(unreadable.code).toBe(2);
    expect(unreadable.err).toContain('--color-text-primary: "red" is not a hex or rgb() colour');
    expect(run([sheet("@theme { --color-void: #000; }")]).code).toBe(2);
  });

  it("runs as a script", () => {
    const pass = spawnSync(process.execPath, [script, tokensPath], { encoding: "utf8" });
    expect(pass.status, pass.stderr).toBe(0);
    const fail = spawnSync(process.execPath, [script, sheet(OLD_THEME)], { encoding: "utf8" });
    expect(fail.status).toBe(1);
  });
});

describe("token sheet", () => {
  it("reads the declarations of @theme blocks, not of nested rules or comments", () => {
    const tokens = readTokens(`
      :root { --outside: 1px; }
      /* @theme { --commented: 1px; } */
      @theme {
        --a: #000; /* a comment */
        @keyframes k { from { --inside: 1px; } }
        --b:
          linear-gradient(red, blue);
      }
      @theme inline { --c: var(--a) }
    `);
    expect([...tokens]).toEqual([
      ["--a", "#000"],
      ["--b", "linear-gradient(red, blue)"],
      ["--c", "var(--a)"],
    ]);
  });

  it("resolves aliases, with fallbacks, and rejects circular ones", () => {
    const tokens = readTokens(
      "@theme { --a: #111; --b: var(--a); --c: var(--b); --d: var(--none, var(--a)); --e: var(--f); --f: var(--e); }",
    );
    expect(resolveToken(tokens, "--c")).toBe("#111");
    expect(resolveToken(tokens, "--d")).toBe("#111");
    expect(() => resolveToken(tokens, "--e")).toThrow("circular reference");
    expect(() => resolveToken(tokens, "--none")).toThrow("--none is not defined");
  });

  it("parses hex and rgb() colours", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#00F0FF80")).toEqual({ r: 0, g: 240, b: 255, a: 128 / 255 });
    expect(parseColor("rgba(0, 240, 255, 0.5)")).toEqual({ r: 0, g: 240, b: 255, a: 0.5 });
    expect(parseColor("rgb(0 240 255 / 50%)")).toEqual({ r: 0, g: 240, b: 255, a: 0.5 });
    expect(parseColor("red")).toBeNull();
    expect(parseColor("rgb(300, 0, 0)")).toBeNull();
    expect(parseColor("color-mix(in srgb, #fff 50%, transparent)")).toBeNull();
  });
});
