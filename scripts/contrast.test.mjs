// Tests for the token contrast check (scripts/contrast.mjs, apps/web/config/contrast.mjs) and the
// token sheet reader it shares with the theme generator. Run with `npm test`.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  contrastRatio,
  contrastReport,
  distancesFromInferred,
  MIN_DISTANCE_FROM_INFERRED,
  main,
  over,
  surfaceStacks,
} from "../apps/web/config/contrast.mjs";
import {
  parseColor,
  readTokens,
  resolveToken,
  validateTokens,
} from "../apps/web/config/tokens.mjs";

const root = join(import.meta.dirname, "..");
const tokensPath = join(root, "apps", "web", "src", "styles", "tokens.css");
const tokens = readFileSync(tokensPath, "utf8");
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
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "contrast-"));
  dirs.push(dir);
  return dir;
}
function sheet(css) {
  const path = join(tempDir(), "tokens.css");
  writeFileSync(path, css);
  return path;
}
/** A source directory with one component file holding `code`. */
function source(code) {
  const dir = tempDir();
  mkdirSync(join(dir, "components"));
  writeFileSync(join(dir, "components", "Thing.tsx"), code);
  return dir;
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
const entry = (report, name) => report.find((item) => item.name === name);
/** tokens.css with one declaration's value replaced (the declaration must be there). */
function withToken(name, value) {
  const declaration = new RegExp(`${name}: [^;]+;`);
  expect(tokens).toMatch(declaration);
  return tokens.replace(declaration, `${name}: ${value};`);
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

describe("surfaces", () => {
  it("stack a state on a panel on a base, never one state on another", () => {
    const names = surfaceStacks(readTokens(tokens)).map((stack) => stack.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "void",
        "void-lighter",
        "surface on void-lighter",
        "surface-active on void",
        "surface-active on surface on void-lighter",
        "surface-hover on surface-subtle on void-light",
      ]),
    );
    const stateOnState = /surface-(hover|active) on surface-(hover|active)/;
    expect(names.some((name) => stateOnState.test(name))).toBe(false);
  });

  it("checks text on the deepest stack: tertiary at 0.5 fails there", () => {
    const css = withToken("--color-text-tertiary", "rgba(255, 255, 255, 0.5)");
    const tertiary = entry(contrastReport(css), "--color-text-tertiary");
    expect(tertiary.passes).toBe(false);
    expect(tertiary.lowest.surface).toBe("surface-active on surface on void-lighter");
    expect(tertiary.lowest.ratio).toBeCloseTo(4.21, 2);
  });
});

describe("contrast report", () => {
  it("passes the tokens and every text colour the app uses", () => {
    const { code, out } = run([tokensPath]);
    expect(code, out).toBe(0);
    for (const name of [
      "--color-text-tertiary",
      "--color-text-muted",
      "--color-prov-inferred",
      "--color-status-warning",
      "--color-accent-pink",
      "--color-spotify",
      // Text by use in the source, not by name:
      "--color-cyber/70",
    ]) {
      expect(out).toMatch(new RegExp(`^ok {3}${name.replace("/", "\\/")} +needs 4\\.5:1 `, "m"));
    }
    expect(out).toMatch(/^ok {3}--color-viz-blue +needs 3:1 /m);
    expect(out).toMatch(/^ok {3}--color-relation-cover +needs 3:1 /m);
    expect(out).toMatch(/^ok {3}--color-black +needs 4\.5:1 +lowest 21\.00:1 on white$/m);
  });

  it("holds every accent to 4.5:1 as text, used or not", () => {
    const css = withToken("--color-accent-pink", "#db2777");
    const { code, out } = run([sheet(css), "--src", "none"]);
    expect(code).toBe(1);
    expect(out).toMatch(/^FAIL --color-accent-pink +needs 4\.5:1 +[23]\.\d\d:1 on surface-active/m);
  });

  it("holds a colour the source draws text with to 4.5:1, at the class's opacity", () => {
    const src = source(
      'export const A = () => <p className="text-gray-500">a</p>;\n' +
        "const b = 'text-cyber/40';\n",
    );
    const { code, out } = run([tokensPath, "--src", src]);
    expect(code).toBe(1);
    expect(out).toMatch(
      /^FAIL --color-gray-500 +needs 4\.5:1 .*; text at components\/Thing\.tsx:1$/m,
    );
    expect(out).toMatch(
      /^FAIL --color-cyber\/40 +needs 4\.5:1 .*; text at components\/Thing\.tsx:2$/m,
    );
    // A grey only used for backgrounds is not text.
    expect(out).not.toMatch(/--color-gray-700/);
  });

  it("fails a too-dark grey used as text", () => {
    const css = withToken("--color-gray-400", "#4b5563");
    const src = source('<span className="hover:text-gray-400">x</span>');
    const { code, out } = run([sheet(css), "--src", src]);
    expect(code).toBe(1);
    expect(out).toMatch(/^FAIL --color-gray-400 /m);
  });

  it("checks text on the tint its own class string sets, at rest and hovered", () => {
    // A darker pink: far below 4.5:1 as text on its own hover tint.
    const css = withToken("--color-accent-pink", "#db2777");
    const src = source(
      "const chip = 'text-accent-pink hover:bg-accent-pink/20 border-accent-pink/30';",
    );
    const pink = entry(contrastReport(css, src), "--color-accent-pink");
    expect(pink.passes).toBe(false);
    const tinted = pink.results.filter((result) =>
      result.surface.startsWith("bg-accent-pink/20 on "),
    );
    expect(tinted.length).toBeGreaterThan(0);
    expect(Math.min(...tinted.map((result) => result.ratio))).toBeLessThan(3.5);
    // The tint stands in for a state: it is never drawn on a hover or active surface.
    expect(tinted.some((result) => /on surface-(hover|active)/.test(result.surface))).toBe(false);
    // The token as it is passes there.
    expect(entry(contrastReport(tokens, src), "--color-accent-pink").passes).toBe(true);
  });

  it("checks dark text on its light fill instead of on the surfaces", () => {
    const src = source('<button className="bg-white text-black">Play</button>');
    const black = entry(contrastReport(tokens, src), "--color-black");
    expect(black.results.map((result) => result.surface)).toEqual(["white"]);
  });

  it("checks the colours of chart roles that colour text, at 4.5:1 with their role named", () => {
    const roles = {
      tooltipColors: {
        doc: "A chart's tooltip text.",
        text: true,
        map: { dim: "--color-gray-600" },
      },
      lineColors: { doc: "A chart's lines.", map: { dim: "--color-gray-700" } },
    };
    const report = contrastReport(tokens, null, [], roles);
    const text = entry(report, "--color-gray-600");
    expect(text.minimum).toBe(4.5);
    expect(text.sites).toContain("theme.ts tooltipColors.dim");
    expect(text.passes).toBe(false);
    // A role that does not colour text is not held to the text minimum.
    expect(report.find((item) => item.name === "--color-gray-700")).toBeUndefined();
  });

  it("checks data-visualisation and relation colours at 3:1 on the page and panels only", () => {
    for (const name of ["--color-viz-blue", "--color-relation-remix"]) {
      const graphic = entry(contrastReport(tokens), name);
      expect(graphic.minimum, name).toBe(3);
      expect(
        graphic.results.some((result) => /surface-(hover|active)/.test(result.surface)),
        name,
      ).toBe(false);
    }
  });

  it("fails the old text colours: tertiary 4.45:1 and muted 2.07:1 on the page", () => {
    const { code, err } = run([sheet(OLD_THEME), "--src", "none"]);
    expect(code).toBe(1);
    expect(err).toContain("2 of 3 colours fall short");
    const report = contrastReport(OLD_THEME);
    const onPage = (name) =>
      entry(report, name).results.find((result) => result.surface === "void").ratio;
    expect(onPage("--color-text-tertiary")).toBeCloseTo(4.455, 3);
    expect(onPage("--color-text-muted")).toBeCloseTo(2.076, 3);
    expect(entry(report, "--color-text-primary").passes).toBe(true);
  });

  it("does not round a ratio up to the minimum", () => {
    // 4.4999:1 must not print as 4.50:1.
    const css = "@theme { --color-void: #ffffff; --color-text-primary: #767777; }";
    const { code, out } = run([sheet(css), "--src", "none"]);
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
    expect(run([sheet("@theme { --color-void: #000; }"), "--src", "none"]).code).toBe(2);
  });

  it("runs as a script", () => {
    const pass = spawnSync(process.execPath, [script, tokensPath], { encoding: "utf8" });
    expect(pass.status, pass.stderr).toBe(0);
    const fail = spawnSync(process.execPath, [script, sheet(OLD_THEME), "--src", "none"], {
      encoding: "utf8",
    });
    expect(fail.status).toBe(1);
    // Two processes that each load the TypeScript parser and read the app's source: on a busy
    // machine that alone can take several seconds.
  }, 30_000);
});

describe("token sheet", () => {
  it("reads the declarations of @theme blocks, not of nested rules or comments", () => {
    const read = readTokens(`
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
    expect([...read]).toEqual([
      ["--a", "#000"],
      ["--b", "linear-gradient(red, blue)"],
      ["--c", "var(--a)"],
    ]);
  });

  it("reads quoted strings and url() whole", () => {
    const read = readTokens(
      '@theme { --font-x: "a}b;c", serif; --img: url("data:image/svg+xml;utf8,<svg>{}</svg>"); --after: 1px; }',
    );
    expect([...read]).toEqual([
      ["--font-x", '"a}b;c", serif'],
      ["--img", 'url("data:image/svg+xml;utf8,<svg>{}</svg>")'],
      ["--after", "1px"],
    ]);
  });

  it("fails on an unclosed block, string or comment, and on a stray brace", () => {
    expect(() => readTokens("@theme { --a: 1px;")).toThrow("not closed");
    expect(() => readTokens('@theme { --a: "x; }')).toThrow("unclosed string");
    expect(() => readTokens("@theme { --a: 1px; } /* open")).toThrow("unclosed comment");
    expect(() => readTokens("@theme { --a: 1px; } }")).toThrow('unmatched "}"');
  });

  it("resolves aliases, with fallbacks, and rejects circular ones", () => {
    const read = readTokens(
      "@theme { --a: #111; --b: var(--a); --c: var(--b); --d: var(--none, var(--a)); --e: var(--f); --f: var(--e); }",
    );
    expect(resolveToken(read, "--c")).toBe("#111");
    expect(resolveToken(read, "--d")).toBe("#111");
    expect(() => resolveToken(read, "--e")).toThrow("circular reference");
    expect(() => resolveToken(read, "--none")).toThrow("--none is not defined");
  });

  it("validates every alias, colour or not", () => {
    expect(() => validateTokens(readTokens(tokens))).not.toThrow();
    // A shadow is not a colour, but the colour it mixes must exist.
    const broken = withToken(
      "--shadow-glow-analog-subtle",
      "0 0 12px color-mix(in srgb, var(--color-analog-sutble) 15%, transparent)",
    );
    expect(() => validateTokens(readTokens(broken))).toThrow(
      "--shadow-glow-analog-subtle: --color-analog-sutble is not defined",
    );
  });

  it("parses hex and rgb() colours", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#00F0FF80")).toEqual({ r: 0, g: 240, b: 255, a: 128 / 255 });
    expect(parseColor("rgba(0, 240, 255, 0.5)")).toEqual({ r: 0, g: 240, b: 255, a: 0.5 });
    expect(parseColor("rgb(0 240 255 / 50%)")).toEqual({ r: 0, g: 240, b: 255, a: 0.5 });
    expect(parseColor("red")).toBeNull();
    expect(parseColor("rgb(300, 0, 0)")).toBeNull();
    expect(parseColor("color-mix(in srgb, #fff 50%, transparent)")).toBeNull();
    // Browsers reject these, so a token written that way must not pass as a colour.
    expect(parseColor("rgb(0 0 0 0.5)")).toBeNull();
    expect(parseColor("rgb(0, 0 0)")).toBeNull();
    expect(parseColor("rgba(0, 0, 0 / 0.5)")).toBeNull();
    expect(parseColor("rgb(0 0 0 / 0.5 / 1)")).toBeNull();
  });

  it("reads a CSS escape outside a string as part of a name", () => {
    expect([...readTokens(".a\\{b { color: red; } .c\\:d { } @theme { --a: #000; }")]).toEqual([
      ["--a", "#000"],
    ]);
    expect(() => readTokens("@theme { --a: 1px; }\\")).toThrow("escape at the end");
  });
});

describe("class strings", () => {
  /** The checked colours that `code`, as a component, draws text with: name → passes. */
  const checked = (code) => {
    const report = contrastReport(tokens, source(code));
    return Object.fromEntries(
      report
        .filter((item) => item.sites.some((site) => site.startsWith("components/")))
        .map((item) => [item.name, item.passes]),
    );
  };

  it("reads a className over several lines", () => {
    const code = `export const A = () => (
  <p
    className="text-xs font-mono
               text-white/40 uppercase"
  >
    a
  </p>
);`;
    expect(checked(code)).toMatchObject({ "--color-white/40": false });
    const { out } = run([tokensPath, "--src", source(code)]);
    expect(out).toMatch(/^FAIL --color-white\/40 .*; text at components\/Thing\.tsx:3$/m);
  });

  it("reads quoted classes inside a template placeholder, each branch on its own", () => {
    const code = `export const A = ({ dim, on }) => (
  <p className={\`font-mono \${dim ? 'text-white/40' : 'text-text-secondary'} \${on ? 'bg-cyber text-void' : 'text-text-tertiary'}\`}>a</p>
);`;
    const report = contrastReport(tokens, source(code));
    const names = (name) => report.find((item) => item.name === name);
    expect(names("--color-white/40").passes).toBe(false);
    expect(names("--color-text-secondary").sites).toContain("components/Thing.tsx:2");
    // One branch's background is not drawn under the other branch's text.
    expect(
      names("--color-text-tertiary").results.some((r) => r.surface.startsWith("bg-cyber ")),
    ).toBe(false);
  });

  it("reads the important mark and arbitrary opacities", () => {
    expect(checked("const a = 'text-white/40!';")).toMatchObject({ "--color-white/40": false });
    expect(checked("const a = '!text-white/40';")).toMatchObject({ "--color-white/40": false });
    expect(checked("const a = 'text-white/[0.4]';")).toMatchObject({ "--color-white/40": false });
    expect(checked("const a = 'text-white/[40%]';")).toMatchObject({ "--color-white/40": false });
  });

  it("applies the element's own opacity, and reads a hidden-at-rest element as shown", () => {
    expect(checked("const a = 'text-text-secondary opacity-50';")).toMatchObject({
      "--color-text-secondary/50": false,
    });
    expect(checked("const a = 'text-text-secondary hover:opacity-50';")).toMatchObject({
      "--color-text-secondary": true,
    });
    expect(
      checked("const a = 'opacity-0 group-hover:opacity-100 text-text-secondary';"),
    ).toMatchObject({ "--color-text-secondary": true });
  });

  it("takes a tint passed to a class-joining call as the same element's", () => {
    const css = withToken("--color-accent-pink", "#db2777");
    const code = "const a = cn('text-accent-pink', active && 'hover:bg-accent-pink/20');";
    const pink = contrastReport(css, source(code)).find(
      (item) => item.name === "--color-accent-pink",
    );
    expect(pink.results.some((r) => r.surface.startsWith("bg-accent-pink/20 on "))).toBe(true);
  });

  it("fails a default-palette colour used as text: it is not a design token", () => {
    const { code, out } = run([tokensPath, "--src", source('<p className="text-red-900">a</p>')]);
    expect(code).toBe(1);
    expect(out).toMatch(
      /^FAIL text-red-900 .*not a design token.*; text at components\/Thing\.tsx:1$/m,
    );
  });

  it("ignores classes in comments", () => {
    const code = "// was 'text-white/30'\n/* also \"text-white/30\" */\nexport const a = 1;";
    expect(checked(code)).toEqual({});
  });

  it("reports a listed known failure without failing, and fails a listed one that is gone", () => {
    const faint = source("const a = 'text-text-tertiary opacity-60';");
    const listed = contrastReport(tokens, faint, [
      { name: "--color-text-tertiary/60", file: "components/Thing.tsx", issue: "fixed elsewhere" },
    ]);
    const known = listed.find((item) => item.name === "--color-text-tertiary/60");
    expect(known.passes).toBe(false);
    expect(known.known).toBe("fixed elsewhere");
    const src = source("const a = 'text-text-secondary';");
    const stale = contrastReport(tokens, src, [
      { name: "--color-white/40", file: "components/Thing.tsx", issue: "fixed elsewhere" },
    ]);
    const entry = stale.find((item) => item.name === "--color-white/40");
    expect(entry.passes).toBe(false);
    expect(entry.lowest.surface).toContain("no longer fails");
  });

  it("prints a listed known failure as KNOWN, says how many there are, and exits 0", () => {
    const out = [];
    const err = [];
    const faint = source("const a = 'text-text-tertiary opacity-60';");
    const known = [
      { name: "--color-text-tertiary/60", file: "components/Thing.tsx", issue: "fixed elsewhere" },
    ];
    const code = main(
      [tokensPath, "--src", faint],
      (line) => out.push(line),
      (line) => err.push(line),
      known,
    );
    expect(code).toBe(0);
    expect(err).toEqual([]);
    const text = out.join("\n");
    expect(text).toMatch(
      /^KNOWN --color-text-tertiary\/60 .*text at components\/Thing\.tsx:1 \[known: fixed elsewhere\]$/m,
    );
    expect(text).toMatch(/\(1 known, listed in KNOWN with the issue that fixes it\)$/m);
    expect(text).not.toMatch(/^FAIL /m);
  });

  it("passes the app's own source with nothing listed as known", () => {
    const { code, out } = run([tokensPath]);
    expect(code).toBe(0);
    expect(out).not.toMatch(/^(KNOWN|FAIL) /m);
    expect(out).not.toContain("known");
  });
});

describe("distance from the inferred violet", () => {
  it("passes the tokens, the measured cyan closest at ΔE 17.5 with deuteranopia", () => {
    const rows = distancesFromInferred(tokens);
    expect(rows.every((row) => row.passes)).toBe(true);
    expect(rows[0]).toMatchObject({ name: "--color-cyber", vision: "deuteranopia" });
    expect(rows[0].distance).toBeGreaterThanOrEqual(MIN_DISTANCE_FROM_INFERRED);
  });

  it.each([
    ["a lavender under any name", "--color-accent-lavender", "#d8b4fe", "protanopia"],
    [
      "a light blue that red-green deficiencies see as violet",
      "--color-status-info",
      "#60a5fa",
      "protanopia",
    ],
    ["the old album blue", "--color-accent-sky", "#93c5fd", "deuteranopia"],
  ])("fails %s", (_name, token, value, vision) => {
    const css = tokens.replace("@theme {", `@theme {\n  ${token}: ${value};`);
    const row = distancesFromInferred(css).find((item) => item.name === token);
    expect(row).toMatchObject({ passes: false, vision });
    const { code, out } = run([sheet(css), "--src", "none"]);
    expect(code).toBe(1);
    expect(out).toMatch(
      new RegExp(`^FAIL ${token} +ΔE \\d+\\.\\d from --color-prov-inferred \\(${vision}\\)`, "m"),
    );
  });

  it("reads a translucent token as drawn on the page", () => {
    const css = tokens.replace("@theme {", "@theme {\n  --color-wash: rgba(196, 164, 252, 0.9);");
    expect(distancesFromInferred(css).find((row) => row.name === "--color-wash")?.passes).toBe(
      false,
    );
  });

  it("says nothing for a sheet without the inferred token", () => {
    expect(
      distancesFromInferred("@theme { --color-void: #050505; --color-cyber: #00f0ff; }"),
    ).toEqual([]);
  });
});
