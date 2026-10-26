// Fixture tests for the honesty guard: each rule must keep catching the forms below, and the
// baseline must stay one-way. Run with `npm test`.

import { execFileSync, spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { countInText, PROTOTYPE_PHRASES, rules, TEST_HELPERS } from "./guard-honest.mjs";

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

  it("counts a destructure over several lines", () => {
    expect(count("random-values-api", "const {\n  floor,\n  random,\n} = Math;\n")).toBe(1);
  });

  it("does not join a block with a later destructure of other names", () => {
    const text = [
      "export function backoff(attempt) {",
      "  // no random jitter here",
      "  const { min } = Math;",
      "  return min(attempt * 100, 1000);",
      "}",
    ].join("\n");
    expect(count("random-values-api", text, "apps/api/src/a.ts")).toBe(0);
  });
});

describe("colour-literals-design-system", () => {
  const css = "apps/web/src/a.css";
  it.each([
    ["a 3-digit hex", 'fill="#fff"'],
    ["a 4-digit hex with alpha", 'const c = "#abcd";'],
    ["a 6-digit hex", "color: '#00f0ff'"],
    ["an 8-digit hex", "color: '#00f0ff80'"],
    ["a hex after a block comment", "/* brand */ export const c = '#ff0000';"],
    ["a hex in a class", 'className="shadow-[0_0_6px_#00F0FF]"'],
    ["a hex in an arbitrary value", 'className="bg-[#123]"'],
    ["rgb()", "color: 'rgb(0, 240, 255)'"],
    [
      "rgba() in a class",
      'className="bg-[radial-gradient(circle,_rgba(20,20,30,0.5)_0%,_transparent)]"',
    ],
    ["hsl() in a template literal", "const from = `hsl(` + hue + `, 70%, 35%)`;"],
    ["hsla()", "const c = 'hsla(10, 50%, 50%, 0.5)';"],
    ["hwb()", "const c = 'hwb(10 20% 30%)';"],
    ["lab()", "const c = 'lab(50% 40 59)';"],
    ["lch()", "const c = 'lch(52% 72 56)';"],
    ["oklab()", "const c = 'oklab(0.6 0.1 0.1)';"],
    ["oklch() from Tailwind's palette", "const c = 'oklch(70.4% 0.191 22.216)';"],
    ["oklch() in an arbitrary value", 'className="bg-[oklch(70%_0.1_200)]"'],
    ["color()", "const c = 'color(display-p3 1 0 0)';"],
    ["a named colour in a JSX attribute", '<Play size={28} fill="black" />'],
    ["a named colour in a JSX expression", "<path stroke={'white'} />"],
    ["a named colour in a style object", "style={{ color: 'red' }}"],
    ["a named colour as a background", 'style={{ backgroundColor: "navy" }}'],
    ["a named colour in a D3 attribute", ".attr('fill', 'white')"],
    ["a named colour in a D3 style", '.style("stop-color", "gold")'],
    ["a named colour in an arbitrary class", 'className="bg-[red]"'],
    ["a named colour inside an arbitrary value", 'className="shadow-[0_0_4px_white]"'],
    ["a typed arbitrary value", 'className="text-[color:navy]"'],
    ["a digits-only hex in a style string", "{ boxShadow: '0 0 4px #000' }"],
    ["a digits-only hex in a template literal", "const s = `0 0 2px #222`;"],
    ["a digits-only hex after white space in code", "const shadow = '1px solid ' + ' #333';"],
    ["an issue number in copy", "<p>Fixed in #123.</p>"],
    ["a named colour in a multi-value style string", "style={{ border: '1px solid white' }}"],
    ["a named colour in a shadow", "{ boxShadow: '0 0 4px black' }"],
    ["a named colour in a D3 shorthand", ".style('border', '1px solid red')"],
  ])("counts %s", (_name, line) => {
    expect(count("colour-literals-design-system", line)).toBe(1);
  });

  it.each([
    ["a stylesheet declaration", "a { color: red; }"],
    ["a shorthand in a stylesheet", "a { border: 1px solid white; }"],
    ["upper-case RGB() in a stylesheet", "a { color: RGB(0 0 0); }"],
    ["a digits-only hex", "a { color: #000; }"],
    ["a digits-only background", "a { background: #111; }"],
    ["a digits-only hex in a shorthand", "a { border: 1px solid #333; }"],
    ["a digits-only hex with alpha in a shadow", "a { box-shadow: 0 0 4px #0008; }"],
    ["the last declaration of a block", "a { color: #000 } b { color: var(--x); }"],
  ])("counts %s", (_name, line) => {
    expect(count("colour-literals-design-system", line, css)).toBe(1);
  });

  it.each([
    ["a token in a class", 'className="shadow-[0_0_6px_var(--color-cyber)]"'],
    ["a theme.ts value", "fill: colors.white"],
    ["a theme.ts value in a D3 attribute", ".attr('fill', colors.white)"],
    ["a token class named after a colour", 'className="text-white bg-black/80 text-cyber"'],
    [
      "color-mix() of tokens",
      "background: color-mix(in srgb, var(--color-cyber) 20%, transparent)",
    ],
    ["transparent and currentColor", '<Play fill="currentColor" stroke="transparent" />'],
    ["a comment", "// was rgba(255,255,255,0.3)"],
    ["a function whose name ends in rgb", "const c = toRgb(value);"],
    ["a method named color", "const c = palette.color(1);"],
    ["an element id in url()", 'fill="url(#fade)"'],
    ["an anchor", 'href="#add"'],
    ["an anchor in a JSX expression", "<a href={'#add'}>"],
    ["a word with a hash inside", "const id = 'page#fade';"],
    ["an HTML entity", "<span>a&#160;b</span>"],
    [
      "an issue number in copy with a marker",
      "<p>Fixed in #123.</p> // guard-allow: colour-literals-design-system — an issue number",
    ],
    ["a named colour in a token", "style={{ border: '1px solid var(--color-white)' }}"],
    ["a shadow token", "style={{ boxShadow: 'var(--shadow-glow-white)' }}"],
    ["a named colour as text", "<p>The red line is a sample.</p>"],
    ["a named colour as a prop that is not a colour", '<Badge variant="green">'],
    ["a word that starts with a colour name in an arbitrary value", 'className="font-[redacted]"'],
  ])("ignores %s", (_name, line) => {
    expect(count("colour-literals-design-system", line)).toBe(0);
  });

  it.each([
    ["a selector", "#abc { color: var(--color-cyber); }"],
    ["a selector list", "#abc, #def { color: var(--color-cyber); }"],
    ["a descendant selector", "#abc .x { color: var(--color-cyber); }"],
    ["a selector with a pseudo-class", "#abc:hover { color: var(--color-cyber); }"],
    ["a token in a declaration", "a { color: var(--color-white); }"],
    ["a non-colour value", "a { border: none; transition: color 0.2s; }"],
  ])("ignores %s in a stylesheet", (_name, line) => {
    expect(count("colour-literals-design-system", line, css)).toBe(0);
  });

  it("counts one literal once", () => {
    expect(count("colour-literals-design-system", "style={{ color: '#fff' }}")).toBe(1);
    expect(count("colour-literals-design-system", ".attr('fill', '#fff')")).toBe(1);
  });

  it("scans web source, its stylesheets and the page, but not the tokens, theme.ts or test code", () => {
    const { files } = rule("colour-literals-design-system");
    expect(files("apps/web/src/components/Thing.tsx")).toBe(true);
    expect(files("apps/web/src/styles/index.css")).toBe(true);
    expect(files("apps/web/src/styles/placeholder.ts")).toBe(true);
    expect(files("apps/web/index.html")).toBe(true);
    expect(files("apps/web/src/styles/tokens.css")).toBe(false);
    expect(files("apps/web/src/styles/theme.ts")).toBe(false);
    expect(files("apps/web/src/components/Thing.test.tsx")).toBe(false);
    expect(files("apps/web/src/components/genealogy/testing.ts")).toBe(false);
    // A module of that name that is not a listed test helper is scanned.
    expect(files("apps/web/src/components/Other/testing.ts")).toBe(true);
    expect(files("apps/api/src/a.ts")).toBe(false);
  });

  it("skips only test helpers that nothing but tests imports", () => {
    const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
    const sources = execFileSync("git", ["ls-files", "apps/web/src"], {
      cwd: repo,
      encoding: "utf8",
    })
      .split("\n")
      .filter((path) => /\.[cm]?[jt]sx?$/.test(path));
    for (const helper of TEST_HELPERS) {
      expect(existsSync(join(repo, helper)), helper).toBe(true);
      const importers = sources.filter((path) => {
        if (path === helper) return false;
        const text = readFileSync(join(repo, path), "utf8");
        return [...text.matchAll(/from\s+["']([^"']+)["']/g)].some(
          ([, from]) =>
            from.startsWith(".") &&
            join(dirname(path), from).replace(/\.[cm]?[jt]sx?$/, "") ===
              helper.replace(/\.[cm]?[jt]sx?$/, ""),
        );
      });
      expect(importers.length, helper).toBeGreaterThan(0);
      expect(
        importers.filter((path) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(path)),
        helper,
      ).toEqual([]);
    }
  });
});

describe("default-palette-utilities", () => {
  it.each([
    ["a text class", 'className="text-gray-400 text-xs"'],
    ["a background class", "'bg-gray-900'"],
    ["a gradient stop", 'className="bg-radial from-gray-900 via-void"'],
    ["a class with an opacity", 'className="border-gray-600/50"'],
    ["a class with an arbitrary opacity", 'className="bg-gray-800/[0.4]"'],
    ["a class after a variant", "'group-hover/item:border-gray-400'"],
    ["an important class", "'!bg-gray-800'"],
    ["a side border", "'border-t-gray-700'"],
    ["the zinc palette", "'bg-zinc-800'"],
    ["the slate palette", "'text-slate-400'"],
    ["the neutral palette", "'ring-neutral-500/40'"],
    ["the stone palette", "'divide-stone-700'"],
    ["a coloured palette", "'border-red-500'"],
    ["a ring offset", "'ring-offset-amber-950'"],
  ])("counts %s", (_name, line) => {
    expect(count("default-palette-utilities", line)).toBe(1);
  });

  it("counts each class, and a class in a stylesheet's @apply", () => {
    expect(count("default-palette-utilities", "'bg-gray-50 text-gray-950'")).toBe(2);
    expect(
      count("default-palette-utilities", "a { @apply bg-gray-700; }", "apps/web/src/a.css"),
    ).toBe(1);
  });

  it.each([
    ["the grey tokens in a stylesheet", "a { background: var(--color-gray-700); }"],
    ["a grey token in a class", 'className="bg-(--color-gray-700)"'],
    ["the theme.ts grey scale", "stroke={colors.gray[700]}"],
    ["the Badge variant", '<Badge variant="gray">'],
    ["a comment", "// was text-gray-400"],
    ["a step that is not on the scale", "'text-gray-450'"],
    ["a data attribute", '<li data-gray-500="1">'],
    ["a test id", 'data-testid="swatch-gray-500"'],
    ["a key that is not a class", "const k = 'colors-gray-500';"],
    ["text", "<p>mid-gray-700</p>"],
    ["the token classes", 'className="text-text-tertiary bg-void-lighter border-white/30"'],
  ])("ignores %s", (_name, line) => {
    const path = line.startsWith("a {") ? "apps/web/src/a.css" : "apps/web/src/snippet.tsx";
    expect(count("default-palette-utilities", line, path)).toBe(0);
  });
});

describe("unmeaning-hues-design-system", () => {
  const path = "apps/web/src/components/ui/Badge.tsx";
  it.each([
    ["an accent class", "'bg-accent-pink/10 text-accent-pink'", 2],
    ["a variant name", '<Badge variant="green">', 1],
    ["a variant key", "  purple: 'x',", 1],
    ["a glow", "'shadow-glow-indigo-subtle'", 1],
    ["a theme value", "stroke={colors.violet}", 1],
    ["a camelCase name", "const accentPurple = 1;", 1],
    ["a snake_case name", "const accent_purple = 1;", 1],
    ["a name in capitals", "const PURPLE_GLOW = 1;", 1],
    ["a PascalCase name", "const PinkBadge = () => null;", 1],
    ["a component", "<PurpleDot />", 1],
    ["a capitalised name", "const Lavender = 1;", 1],
    ["fuchsia", "'text-accent-fuchsia'", 1],
    ["lavender", "--color-accent-lavender: #d8b4fe;", 1],
    ["magenta", "const magenta_dim = 1;", 1],
    ["violet", "'bg-violet-glow'", 1],
  ])("counts %s", (_name, line, expected) => {
    expect(count("unmeaning-hues-design-system", line, path)).toBe(expected);
  });

  it.each([
    ["the meaning variants", "'text-prov-inferred bg-status-warning/10'"],
    ["a comment", "// was text-accent-pink"],
    ["a longer word", "const greenhouse = 1; const pinkish = 2;"],
    ["JSX text", "<span>green light</span>"],
    ["an aria-label", '<div aria-label="green light" />'],
    ["a title", "<span title={'pink noise floor'} />"],
    ["an alt text", '<img alt="Green Day live" />'],
  ])("ignores %s", (_name, line) => {
    expect(count("unmeaning-hues-design-system", line, path)).toBe(0);
  });

  it("scans the design system's and the genealogy graph's code, but not the tokens, theme.ts, tests or other components", () => {
    const { files } = rule("unmeaning-hues-design-system");
    for (const scanned of [
      "apps/web/src/components/ui/Badge.tsx",
      "apps/web/src/components/provenance/ClaimChip.tsx",
      "apps/web/src/components/measured/MeasuredValue.tsx",
      "apps/web/src/components/genealogy/linkStyle.ts",
      "apps/web/src/styles/placeholder.ts",
      "apps/web/src/styles/index.css",
    ]) {
      expect(files(scanned), scanned).toBe(true);
    }
    for (const skipped of [
      "apps/web/src/styles/tokens.css",
      "apps/web/src/styles/theme.ts",
      "apps/web/src/components/ui/Badge.test.tsx",
      "apps/web/src/components/provenance/testing.ts",
      "apps/web/src/components/InteractiveFactoid.tsx",
    ]) {
      expect(files(skipped), skipped).toBe(false);
    }
  });
});

describe("near-violet-outside-inference", () => {
  it.each([
    ["an accent class", "'text-accent-purple border-accent-purple/20'", 2],
    ["a chart class", "'fill-viz-indigo'", 1],
    ["a token", "--color-viz-purple: #a855f7;", 1],
    ["a theme value", "onset: colors.accent.indigo,", 1],
    ["a theme hue", "cover: colors.purple,", 1],
    ["a role's token", "sampler: '--color-viz-purple',", 1],
    ["a variant of a token", "'text-accent-purple-dim'", 1],
    ["a glow", "'shadow-glow-purple-subtle'", 1],
    ["a theme value by key", "colors['purple']", 1],
    ["a family value by key", 'colors.viz["indigo"]', 1],
  ])("counts %s", (_name, line, expected) => {
    expect(count("near-violet-outside-inference", line)).toBe(expected);
  });

  it.each([
    ["the inferred token", "'text-prov-inferred'"],
    ["a comment", "// was text-accent-purple"],
    ["another accent", "'text-accent-pink'"],
  ])("ignores %s", (_name, line) => {
    expect(count("near-violet-outside-inference", line)).toBe(0);
  });

  it("scans all web source and its config, the tokens too, but not theme.ts or tests", () => {
    const { files } = rule("near-violet-outside-inference");
    for (const scanned of [
      "apps/web/src/components/ActivityLog.tsx",
      "apps/web/src/styles/tokens.css",
      "apps/web/config/theme.mjs",
    ]) {
      expect(files(scanned), scanned).toBe(true);
    }
    for (const skipped of [
      "apps/web/src/styles/theme.ts",
      "apps/web/src/components/SystemConsole.test.tsx",
      "apps/web/config/apiUrl.test.ts",
    ]) {
      expect(files(skipped), skipped).toBe(false);
    }
  });
});

describe("tiny-text-web", () => {
  it.each([
    ["a pixel size", 'className="text-[10px] font-mono"'],
    ["an 11 px size", "'text-[11px]'"],
    ["a fractional size", "'text-[9.5px]'"],
    ["a rem size", "'text-[0.6rem]'"],
    ["0.7 rem", "'text-[0.7rem]'"],
    ["0.7 em", "'text-[.7em]'"],
    ["0.749 rem", "'text-[0.749rem]'"],
    ["a typed length", "'text-[length:10px]'"],
    ["points", "'text-[8pt]'"],
    ["a size after a variant", "'md:text-[8px]'"],
    ["a D3 font size", ".attr('font-size', 9)"],
    ["a D3 font size in pixels", '.attr("font-size", "10px")'],
    ["a D3 font size from a template", ".attr('font-size', `\u0024{10}px`)"],
    ["a D3 font size from a function", ".attr('font-size', (d) => 10)"],
    ["a D3 font size in rem", ".attr('font-size', '0.6rem')"],
    ["a font size prop", "tick={{ fontSize: 10 }}"],
    ["a font size attribute", "<text fontSize={11}>"],
    ["a font size style in rem", "style={{ fontSize: '0.6rem' }}"],
    ["a font size style from a template", "style={{ fontSize: `\u0024{9}px` }}"],
    ["an SVG font size attribute", '<text fontSize="10">x</text>'],
    ["an SVG font size attribute in pixels", "<text fontSize='10px'>x</text>"],
    ["a decimal font size", "style={{ fontSize: 9.5 }}"],
    ["a decimal font size attribute", "<text fontSize={10.5}>"],
  ])("counts %s", (_name, line) => {
    expect(count("tiny-text-web", line)).toBe(1);
  });

  it.each([
    ["a stylesheet font size", "a { font-size: 10px; }"],
    ["a stylesheet font size in rem", "a { font-size: 0.6rem; }"],
    ["a font shorthand", "a { font: 10px monospace; }"],
    ["a font shorthand with a weight and line height", "a { font: 600 0.7rem/1.2 serif; }"],
    ["a size token", "@theme { --text-tiny: 10px; }"],
  ])("counts %s", (_name, line) => {
    expect(count("tiny-text-web", line, "apps/web/src/a.css")).toBe(1);
  });

  it.each([
    ["the chrome size", 'className="text-chrome"'],
    ["a 12 px size", "'text-[12px] text-[0.75rem] text-[9pt]'"],
    ["0.8 rem", "'text-[0.8rem]'"],
    ["a larger size", ".attr('font-size', 14) tick={{ fontSize: 12 }}"],
    ["a comment", "// was text-[10px]"],
    ["a width", "'w-[10px] h-[9px]'"],
    ["a unitless fraction", "tick={{ fontSize: 1.2 }}"],
    ["a unitless scale under 2", "<text fontSize={1.5}>"],
    ["a 12 px attribute", '<text fontSize="12">'],
    ["a variable named fontSize", "const fontSize = 10;"],
  ])("ignores %s", (_name, line) => {
    expect(count("tiny-text-web", line)).toBe(0);
  });

  it.each([
    [
      "the chrome token and its line height",
      "@theme { --text-chrome: 12px; --text-chrome--line-height: 16px; }",
    ],
    ["a text shadow token", "@theme { --text-shadow-dark: 0 1px 3px black; }"],
    ["a 12 px stylesheet size", "a { font-size: 12px; font: 0.75rem serif; }"],
  ])("ignores %s in a stylesheet", (_name, line) => {
    expect(count("tiny-text-web", line, "apps/web/src/a.css")).toBe(0);
  });
});

describe("allow markers", () => {
  it("exempt only the rule they name", () => {
    const line = (id) => `const s = 'Command Center'; // guard-allow: ${id} — kept for a test`;
    expect(count("prototype-copy", line("prototype-copy"))).toBe(0);
    expect(count("prototype-copy", line("prototype-copy-recordings"))).toBe(1);
    expect(count("prototype-copy", line("prototype"))).toBe(1);
  });
});

describe("what a rule scans", () => {
  it("keeps `//` inside a string and in JSX text, and counts code after a block comment", () => {
    expect(count("colour-literals-design-system", "const url = 'a // #fff';")).toBe(1);
    expect(count("prototype-copy", "<p>X9-ALPHA {'//'} STATUS: ONLINE</p>")).toBe(2);
    expect(count("prototype-copy", "<p>AGENT_ID // STATUS: ONLINE</p>")).toBe(2);
    expect(count("prototype-copy", "/* note */ const t = 'Command Center';")).toBe(1);
  });

  it("blanks comments that span lines in scripts, CSS and HTML", () => {
    expect(
      count(
        "colour-literals-design-system",
        "/*\n  old: #fff\n*/\na { color: var(--x); }",
        "a.css",
      ),
    ).toBe(0);
    expect(
      count("prototype-copy", "<!--\n  <title>The Sonic Agent</title>\n-->", "apps/web/index.html"),
    ).toBe(0);
  });

  it("reports matches on the line where they start", () => {
    const text = "/*\n * Command Center\n */\nconst a = 'Command Center';\n";
    expect(countInText(rule("prototype-copy"), text, "apps/web/src/a.ts")).toEqual({
      total: 1,
      lines: [4],
      matches: [{ line: 4, text: "Command Center" }],
    });
  });

  it("scans only text a user can read for prototype copy, not code or module paths", () => {
    expect(count("prototype-copy", "const x = Decrypt(payload);")).toBe(0);
    expect(count("prototype-copy", "import Decrypted from './Decrypted';")).toBe(0);
    expect(count("prototype-copy", "export { Decrypted } from './Decrypted';")).toBe(0);
    expect(count("prototype-copy", "const m = await import('./Decrypted');")).toBe(0);
    expect(count("prototype-copy", "const label = 'Decrypted';")).toBe(1);
  });
});

describe("prototype-copy", () => {
  // One sample per pattern, so a pattern that is dropped, mistyped or added without a sample
  // fails here, whatever the repository's count is.
  const samples = {
    anyCase: {
      "Sonic(?:[-_]| )?Agent(?!\\.db\\b)": "The Sonic Agent",
      "Command Center": "PROCEED TO COMMAND CENTER",
      "\\bAGENT_ID\\b": "AGENT_ID: X9",
      "X9-ALPHA": "X9-ALPHA",
      "STATUS: ONLINE": "STATUS: ONLINE",
      "\\b(?:ANALYZE_SONG|DEEP_DIVE_MODE|PROCESSING_DATA_STREAM)\\b": "PROCESSING_DATA_STREAM",
      "BACK TO BASE": "BACK TO BASE",
      "D3\\.JS FORCE SIMULATION": "D3.JS FORCE SIMULATION",
      "INTERACTIVE: ENABLED": "INTERACTIVE: ENABLED",
      "\\bINTEL\\b": "NEW INTEL DECODED",
      "RELATED ARTIFACTS": "3 RELATED ARTIFACTS",
      "NO CONNECTIONS MAPPED": "NO CONNECTIONS MAPPED.",
      "\\bCLICK (?:NODE )?TO (?:ANALYZE|EXPLORE)\\b": "CLICK NODE TO EXPLORE",
      "\\bEVENTS RECORDED\\b": "12 EVENTS RECORDED",
      "\\bAWAITING DATA\\b": "AWAITING DATA...",
      "\\bPROCESS COMPLETE\\b": "PROCESS COMPLETE",
      "No signal detected": "No signal detected. Verify track name and artist.",
      "Ready for deployment": "Analysis complete. Ready for deployment.",
      "\\bAgent Analysis\\b": "Agent Analysis",
      "\\bFrequency analysis:": "Frequency analysis: 120 BPM",
      "Cross-referencing visual artifacts": "Cross-referencing visual artifacts from Spotify...",
      "Intelligence extraction": "Intelligence extraction complete",
      "intelligence already extracted": "Research cache hit — intelligence already extracted",
      "intelligence briefing": "Assembling your intelligence briefing...",
      "deep-web research protocols": "Activating deep-web research protocols...",
      "\\bdeep dive\\b": "Starting deep dive research...",
      "Target acquired": "Target acquired: One More Time",
      "Establishing connection to": "Establishing connection to Spotify API...",
      "waveform parser": "Initializing audio waveform parser...",
      "insights decoded": "4 insights decoded",
      "\\buplink\\b": "ESTABLISHING UPLINK...",
      "\\b(?:audio|musical|sample|its) DNA\\b": "Deconstructing audio DNA",
      "Signal lost": "Signal lost. Check your query.",
      "Unexpected interference": "Unexpected interference.",
    },
    exactCase: {
      "\\b(?:DECRYPT(?:ING|ED)?|Decrypt(?:ing|ed)?)\\b": "DECRYPTING...",
      "\\bLOGIC:": "LOGIC: related influence",
      "[●◉](?:\\s|&nbsp;)*[A-Z]{3,}\\b": "◉ BUSY",
      "\\[\\s+[A-Z]+(?:\\s+[A-Z]+)*\\s+\\]": "[ COMPLETE ]",
    },
  };

  it("has a sample for every phrase pattern, and no sample without a pattern", () => {
    expect(Object.keys(samples.anyCase)).toEqual(PROTOTYPE_PHRASES.anyCase);
    expect(Object.keys(samples.exactCase)).toEqual(PROTOTYPE_PHRASES.exactCase);
  });

  it.each(Object.entries(samples.anyCase))("counts /%s/ in any case", (_pattern, sample) => {
    for (const text of [sample, sample.toUpperCase(), sample.toLowerCase()]) {
      expect(count("prototype-copy", `const s = ${JSON.stringify(text)};`)).toBe(1);
    }
  });

  it.each(Object.entries(samples.exactCase))("counts /%s/ as written", (_pattern, sample) => {
    expect(count("prototype-copy", `const s = ${JSON.stringify(sample)};`)).toBe(1);
  });

  it.each([
    ["the lowercase decrypt route", 'fetch("/api/factoids/decrypt/stream")'],
    ["a lowercase logic key", "const s = 'logic: a';"],
    ["a lowercase bracket", "const s = '[ complete ]';"],
    ["a status light in sentence case", "const s = '● Online';"],
  ])("does not count %s", (_name, line) => {
    expect(count("prototype-copy", line)).toBe(0);
  });

  it.each([
    ["the old product name in JSX text", "<h1>The Sonic Agent</h1>"],
    ["the old product name in the page title", "<title>The Sonic Agent</title>"],
    ["a sentence-case heading", "<h2>Back to base</h2>"],
    ["the decrypt button", "<span>[ DECRYPT MORE ]</span>"],
    [
      "a progress message",
      'status("GRAPH-ENRICH", "Cross-referencing visual artifacts from Spotify...");',
    ],
    ["a template literal", `const m = \`Target acquired: \${title}\`;`],
    ["the name without a space", "const ua = 'SonicAgent/1.0';"],
    ["the name with a hyphen", "<span>sonic-agent://analysis.log</span>"],
    ["the name with a non-breaking space", "const t = 'The Sonic Agent';"],
    ["the name with an escaped non-breaking space", "const t = 'The Sonic\\u00a0Agent';"],
    ["the name with &nbsp;", "<h1>The Sonic&nbsp;Agent</h1>"],
    ["words split by a JSX space", "<p>\n  The Sonic{' '}\n  Agent\n</p>"],
    ["a status light", "{done ? '● IDLE' : 'x'}"],
  ])("counts %s", (_name, line) => {
    expect(count("prototype-copy", line)).toBe(1);
  });

  it.each([
    [
      "a phrase the formatter wrapped",
      [
        "export const P = () => (",
        '  <p className="text-text-secondary">',
        "    Paste the title of a song and press the enter key to jump right away straight into the Command",
        "    Center where the results are shown.",
        "  </p>",
        ");",
      ].join("\n"),
      "apps/web/src/P.tsx",
      3,
    ],
    ["a heading over two lines", "<h1>The Sonic\n  Agent</h1>", "apps/web/src/a.tsx", 1],
    [
      "a page title over two lines",
      "<head>\n  <title>The Sonic\n    Agent</title>\n</head>",
      "apps/web/index.html",
      2,
    ],
  ])("counts %s, on the line where it starts", (_name, text, path, line) => {
    expect(countInText(rule("prototype-copy"), text, path)).toMatchObject({
      total: 1,
      lines: [line],
    });
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
    ["two separate strings", "const a = ['Command', 'Center'];"],
    ["a status light with a number", "const s = '● 120 BPM';"],
    ["a legend entry after a dot", "const s = '● Measured';"],
    ["a legend dot in its own element", "<li>\n  <span>●</span> Sampled\n</li>"],
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
    ["an emoji after an interpolation", `status(\`\${n} ✅ done\`);`],
    ["an emoji in a middle part", `addLog(\`a \${b} 🔎 c \${d}\`);`],
    ["an emoji in the last of several parts", `addLog(\`a \${b} c \${d} 🔎\`);`],
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

  it("scans API and web source, but not tests or test helpers", () => {
    const { files } = rule("emoji-in-progress");
    expect(files("apps/api/src/agent/researcherSubgraph.ts")).toBe(true);
    expect(files("apps/web/src/hooks/useAgent.ts")).toBe(true);
    expect(files("apps/web/src/components/GenealogyGraph.tsx")).toBe(true);
    expect(files("apps/api/src/agent/researcherSubgraph.test.ts")).toBe(false);
    expect(files("apps/web/src/hooks/useAgent.test.ts")).toBe(false);
    expect(files("apps/api/src/sources/testing/iceIceBaby.ts")).toBe(false);
  });
});

describe("recordings", () => {
  const path = "fixtures/replays/one-more-time-daft-punk.json";
  const status = (message, node = "scout") => ({ event: { type: "status", message, node } });
  const recording = JSON.stringify(
    {
      events: [
        status("🔎 Searching samples...", "research_tool"),
        status("Establishing connection to Spotify API..."),
        status("🔍 A deep dive into its DNA finds the Command Center", "research_manager"),
        status("🔬 Starting deep dive research...", "research_manager"),
        {
          event: {
            type: "interrupt",
            message: "Target acquired: pick one",
            candidates: [{ title: "Deep Dive" }],
          },
        },
        { event: { type: "error", code: "internal", error: "Signal lost" } },
        {
          event: {
            type: "complete",
            data: {
              factoids: [{ text: "🎧 A deep dive into its DNA" }],
              claims: [{ text: "the Command Center of disco" }],
            },
          },
        },
      ],
      analysis: { factoids: [{ text: "🎧 its DNA" }] },
    },
    null,
    2,
  );
  const found = (id) => countInText(rule(id), recording, path).matches.map(({ text }) => text);

  it("counts the messages the app wrote: status, interrupt and error", () => {
    expect(found("prototype-copy-recordings")).toEqual([
      "Establishing connection to",
      "deep dive",
      "Target acquired",
      "Signal lost",
    ]);
  });

  it("counts the emoji the app puts before the planner's reasoning, not the reasoning", () => {
    expect(found("emoji-in-recordings")).toEqual(["🔎", "🔍", "🔬"]);
  });

  describe("the planner's lines in a newer run, which sends no reasoning", () => {
    const newer = JSON.stringify(
      {
        events: [
          status("Starting the research steps", "research_manager"),
          status("Choosing follow-up step 1 of at most 2", "research_manager"),
          // A line at the planner's node without an emoji is the app's: scanned in full.
          status("A deep dive into its DNA finds the Command Center 🎧", "research_manager"),
          status("Research ended early: Target acquired", "research_manager"),
          // The same phrases in another node's status.
          status("A deep dive into its DNA 🎧", "historian"),
          // An older run's reasoning line: only the emoji before it counts.
          status("🔍 A deep dive into its DNA", "research_manager"),
        ],
      },
      null,
      2,
    );
    const foundIn = (id) => countInText(rule(id), newer, path).matches.map(({ text }) => text);

    it("counts every planner line in full, and only the emoji of an older reasoning line", () => {
      expect(foundIn("prototype-copy-recordings")).toEqual([
        "deep dive",
        "its DNA",
        "Command Center",
        "Target acquired",
        "deep dive",
        "its DNA",
      ]);
      expect(foundIn("emoji-in-recordings")).toEqual(["🎧", "🎧", "🔍"]);
    });
  });

  it("reports a recorded message on its own line", () => {
    const { lines } = countInText(rule("emoji-in-recordings"), recording, path);
    const text = recording.split("\n");
    expect(lines.map((line) => text[line - 1].trim().slice(0, 14))).toEqual([
      '"message": "🔎',
      '"message": "🔍',
      '"message": "🔬',
    ]);
  });

  it("throws on a recording that is not JSON", () => {
    expect(() => countInText(rule("emoji-in-recordings"), "{ not json", path)).toThrow();
  });

  it("scans the recorded runs only", () => {
    for (const id of ["prototype-copy-recordings", "emoji-in-recordings"]) {
      expect(rule(id).files(path)).toBe(true);
      expect(rule(id).files("apps/api/src/sources/fixtures/discogs-release-249504.json")).toBe(
        false,
      );
      expect(rule(id).files("fixtures/replays/notes.md")).toBe(false);
    }
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

  // A throwaway repository with the guard, a baseline and one API file, in `parent`. Its own
  // package.json says it is a module, as the repository's does, so whatever package.json lies
  // above it does not decide how Node loads its files.
  function repo(baseline, source, parent = tmpdir()) {
    dir = mkdtempSync(join(parent, "guard-"));
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "apps/api/src"), { recursive: true });
    copyFileSync(script, join(dir, "scripts/guard-honest.mjs"));
    writeFileSync(join(dir, "package.json"), '{ "private": true, "type": "module" }\n');
    const full = {
      "random-values-api": 0,
      "stock-images-web": 0,
      "tailwind-v3-variable-classes": 0,
      "colour-literals-design-system": 0,
      "default-palette-utilities": 0,
      "unmeaning-hues-design-system": 0,
      "near-violet-outside-inference": 0,
      "tiny-text-web": 0,
      "dotenv-outside-config": 0,
      "string-sentinel-tool-results": 0,
      "prototype-copy": 0,
      "emoji-in-progress": 0,
      "prototype-copy-recordings": 0,
      "emoji-in-recordings": 0,
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

  it("runs the same under a CommonJS package.json", () => {
    const parent = mkdtempSync(join(tmpdir(), "guard-cjs-"));
    try {
      writeFileSync(join(parent, "package.json"), '{ "type": "commonjs" }\n');
      repo({}, "export const a = 1;\n", parent);
      const result = run();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
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
        "colour-literals-design-system": 0,
        "default-palette-utilities": 0,
        "unmeaning-hues-design-system": 0,
        "near-violet-outside-inference": 0,
        "tiny-text-web": 0,
        "dotenv-outside-config": 0,
        "string-sentinel-tool-results": 0,
        "prototype-copy": 0,
        "emoji-in-progress": 0,
        "prototype-copy-recordings": 0,
        "emoji-in-recordings": 0,
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

  it("marks the occurrences that are not at --base, even when lines moved", () => {
    repo({ "prototype-copy": 1 }, 'status("Target acquired");\n');
    writeFileSync(
      join(dir, "apps/api/src/a.ts"),
      'status("Signal lost");\nstatus("Target acquired");\n',
    );
    const result = run("--base", "HEAD");
    expect(result.status).toBe(1);
    expect(result.stdout).toMatch(/prototype-copy\s+2 \/ 1\s+ABOVE BASELINE/);
    expect(result.stdout).toContain("  + apps/api/src/a.ts:1  Signal lost\n");
    expect(result.stdout).toContain("    apps/api/src/a.ts:2  Target acquired\n");
  });

  it("rejects a baseline that is not a non-negative integer", () => {
    repo({ "random-values-api": "many" }, "Math.random();\n");
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/must be a non-negative integer/);
  });
});
