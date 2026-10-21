// Fixture tests for the built-CSS check. Run with `npm test`.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bareDashedIdents, checkCss, checkDist, linkedStylesheets } from "./check-built-css.mjs";

const script = join(import.meta.dirname, "check-built-css.mjs");

// Outputs of real `vite build` runs with @tailwindcss/vite 4.3.3, on a page using `flex`,
// `p-(--space-md)`, `rounded-md` and `text-chrome`, with this entry stylesheet:
//   @layer theme, base, components, utilities;
//   @import "tailwindcss/theme.css" layer(theme);
//   @import "tailwindcss/utilities.css" layer(utilities) source(none);
//   @source "../index.html";
//   @theme { --space-md: 16px; --text-chrome: 10px; --text-chrome--line-height: 14px; }
// - tailwind.css: main.js imports only that stylesheet.
// - after-font-import.css: the stylesheet starts with `@import url("https://fonts...")`.
// - after-vendor-css.css: main.js imports a library stylesheet before it.
// - after-component-css.css: main.js first imports a component that imports its own CSS.
// In the last three the minifier drops Tailwind's `/*! ... */` banner.
// - no-tailwind-plugin.css: the build without tailwindcss() in the Vite config, from an entry
//   with `@import "tailwindcss/utilities.css" layer(utilities)`, a `@theme` and an `@apply`.
const fixture = (name) =>
  readFileSync(join(import.meta.dirname, "fixtures", "built-css", `${name}.css`), "utf8");
const banner = "/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */\n";
// Excerpts of a real minified build (apps/web/dist) that must pass.
const realExcerpt = [
  "@layer properties{@supports (((-webkit-hyphens:none)) and (not (margin-trim:inline))) or ((-moz-orient:inline) and (not (color:rgb(from red r g b)))){*{--tw-ease:initial}}}",
  "@layer theme,base,components,utilities;",
  "@layer theme{:root,:host{--space-md:16px;--ease-out-expo:cubic-bezier(.16, 1, .3, 1)}}",
  "@layer utilities{.flex{display:flex}.p-\\(--space-md\\){padding:var(--space-md)}.md\\:p-4{padding:1rem}",
  ".transition-colors{transition-property:color,background-color,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to;transition-timing-function:var(--tw-ease,var(--default-transition-timing-function))}",
  ".hover\\:bg-x:hover{@media (hover:hover){background:var(--color-x)}}}",
  '@property --tw-ease{syntax:"*";inherits:false}',
  "@keyframes scan-vertical{0%{top:0}to{top:100%}}",
].join("");
const valid = `${banner}${realExcerpt}`;
const entry = (css) => checkCss(css, { entry: true });

describe("checkCss", () => {
  it("passes Tailwind output with variable utilities, nesting and escaped selectors", () => {
    expect(entry(valid)).toEqual([]);
  });

  it("passes unminified output", () => {
    const css = `${banner}@layer utilities {\n  .flex {\n    display: flex;\n  }\n  .p {\n    padding: var(--space-md);\n  }\n}\n`;
    expect(entry(css)).toEqual([]);
  });

  it.each(["tailwind", "after-font-import", "after-vendor-css", "after-component-css"])(
    "passes the real build %s.css",
    (name) => {
      expect(entry(fixture(name))).toEqual([]);
    },
  );

  it("fails the real build without the Tailwind plugin", () => {
    expect(entry(fixture("no-tailwind-plugin"))).toEqual([
      expect.stringContaining("Tailwind did not run"),
      expect.stringContaining('no ".flex" rule'),
      expect.stringContaining("@tailwind, @theme, @apply"),
    ]);
  });

  it("takes the banner anywhere, or an @layer theme/properties block, as Tailwind's marker", () => {
    const utilities = "@layer utilities{.flex{display:flex}}";
    expect(entry(`.vendor{color:red}${banner}${utilities}`)).toEqual([]);
    expect(entry(`.vendor{color:red}@layer theme{:root{--a:1px}}${utilities}`)).toEqual([]);
    expect(entry(`@layer properties{@supports (x:y){*{--tw-a:0}}}${utilities}`)).toEqual([]);
    // The source's layer order statement is not output.
    expect(entry(`@layer theme,base,components,utilities;${utilities}`)).toEqual([
      expect.stringContaining("Tailwind did not run"),
    ]);
  });

  it.each([
    ["anchor-name", ".a{anchor-name:--anc}"],
    ["position-anchor", ".a{position-anchor:--anc;top:anchor(--anc bottom)}"],
    ["animation-timeline", ".a{animation-timeline:--tl;timeline-scope:--tl}"],
    ["view-transition-name", ".a{view-transition-name:--card}"],
    ["container-name", ".a{container-name:--sidebar}"],
    ["a dashed ident in a string", '.a{--tw-content:":--lit";content:":--lit"}'],
    ["a data URI", '.a{background:url("data:image/svg+xml,%3Csvg style=%22a:--b%22/%3E")}'],
    ["an unquoted url()", ".a{background:url(data:image/svg+xml;a:--b)}"],
    ["@reference inside a string", '.a{content:"mail me@reference.example"}'],
    ["a var() fallback", ".a{color:var(--x,var(--y,red))}"],
    ["a custom property set to a dashed ident", ".a{--name:--other}"],
    ["a counter-style name", ".a{list-style:--ctr;list-style-type:--ctr}"],
    ["Tailwind's own variables", ".a{--tw-gradient-stops:var(--a,var(--b));--tw-ease:initial}"],
    ["a dashed ident in a comment", ".a{color:red/* :--x */}"],
  ])("does not flag %s", (_name, rule) => {
    expect(entry(`${valid}${rule}`)).toEqual([]);
  });

  it.each([
    ["padding", ".p-\\[--space-md\\]{padding:--space-md}", "--space-md"],
    ["border radius", ".r{border-radius:--radius-md}", "--radius-md"],
    ["a value inside calc()", ".m{margin:calc(--m-x * 2)}", "--m-x"],
    ["the second value", ".p{padding:1px --p-x}", "--p-x"],
    ["an unminified value", ".p {\n  padding: --x;\n}", "--x"],
    ["a var() second argument", ".c{color:var(--a, --b)}", "--b"],
    ["a function named like a variable", ".f{font-family:--theme(--f, serif)}", "--theme()"],
    ["a Tailwind variable (leading-[--x])", ".l{--tw-leading:--leading-tight}", "--leading-tight"],
  ])("flags a bare variable name as %s", (_name, rule, name) => {
    const problems = entry(`${valid}${rule}`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(name);
  });

  it("reports a declaration once", () => {
    const rule = ".x{padding:--space-md}.md\\:x{padding:--space-md}";
    expect(entry(`${valid}${rule}`)).toEqual([expect.stringContaining("padding:--space-md")]);
  });

  it("fails CSS that Tailwind did not process", () => {
    const raw = '@import "tailwindcss";\n@theme {\n  --radius-md: 8px;\n}\n.x{color:red}';
    const problems = entry(raw);
    expect(problems.some((problem) => problem.includes("did not run"))).toBe(true);
    expect(problems.some((problem) => problem.includes('".flex"'))).toBe(true);
    expect(problems.some((problem) => problem.includes("@theme"))).toBe(true);
  });

  it("does not take a .flex inside a longer selector or a string for the utility", () => {
    expect(entry(`${banner}.flex-1{flex:1}.a .flex{x:y}.b{content:".flex{"}`)).toEqual([
      expect.stringContaining('".flex"'),
    ]);
  });

  it("fails leftover source at-rules in any file", () => {
    const problems = checkCss(".a{@apply flex;}@tailwind utilities;");
    expect(problems).toEqual([expect.stringContaining("@apply, @tailwind")]);
  });

  it("needs the banner and .flex only in the entry stylesheet", () => {
    expect(checkCss(".probe-lazy{color:red}")).toEqual([]);
    expect(entry(".probe-lazy{color:red}")).toHaveLength(2);
  });
});

describe("bareDashedIdents", () => {
  it("allows var()'s first argument only", () => {
    expect(bareDashedIdents("var(--a)")).toEqual([]);
    expect(bareDashedIdents("calc(var(--a) * 2) var(--b, --c)")).toEqual(["--c"]);
  });

  it("does not take negative numbers or vendor names for variables", () => {
    expect(bareDashedIdents("-1px -webkit-box -0.5em 1e-3")).toEqual([]);
  });
});

describe("linkedStylesheets", () => {
  it("lists local stylesheets and skips other links and remote ones", () => {
    const html = `
      <link rel="preconnect" href="https://fonts.googleapis.com">
      <link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">
      <link rel="modulepreload" crossorigin href="/assets/a.js">
      <link rel="stylesheet" crossorigin href="/assets/index-1.css">
      <link rel=stylesheet href=./assets/extra.css>`;
    expect(linkedStylesheets(html)).toEqual(["assets/index-1.css", "assets/extra.css"]);
  });
});

describe("checkDist and the command", () => {
  const dirs = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  const dist = (files) => {
    const dir = mkdtempSync(join(tmpdir(), "check-css-"));
    dirs.push(dir);
    mkdirSync(join(dir, "assets"));
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  };
  const indexHtml = '<link rel="stylesheet" crossorigin href="/assets/index-1.css">';
  const run = (dir) => spawnSync(process.execPath, [script, dir], { encoding: "utf8" });

  it("passes a build with an entry stylesheet and a lazily loaded one", () => {
    const dir = dist({
      "index.html": indexHtml,
      "assets/index-1.css": valid,
      "assets/Player-2.css": ".probe-lazy{color:red}",
    });
    expect(checkDist(dir)).toEqual({
      files: ["assets/Player-2.css", "assets/index-1.css"],
      problems: [],
    });
    const result = run(dir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok (assets/Player-2.css, assets/index-1.css)");
  });

  it("fails when the linked stylesheet is not Tailwind output, naming the file", () => {
    const dir = dist({
      "index.html": indexHtml,
      "assets/index-1.css": ".x{color:red}",
      "assets/other.css": valid,
    });
    const result = run(dir);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("assets/index-1.css: has neither the");
    expect(result.stderr).not.toContain("assets/other.css");
  });

  it("fails a bare variable in a lazily loaded file", () => {
    const dir = dist({
      "index.html": indexHtml,
      "assets/index-1.css": valid,
      "assets/lazy.css": ".p{padding:--space-md}",
    });
    expect(checkDist(dir).problems).toEqual([expect.stringMatching(/^assets\/lazy\.css: bare/)]);
  });

  it("uses the largest file as the entry without index.html", () => {
    const dir = dist({ "assets/big.css": valid, "assets/small.css": ".a{color:red}" });
    expect(checkDist(dir).problems).toEqual([]);
  });

  it("fails when index.html links no stylesheet from assets/ or a missing one", () => {
    const none = dist({ "index.html": "<p>", "assets/index-1.css": valid });
    expect(checkDist(none).problems).toEqual(["index.html: links no stylesheet from assets/"]);
    const missing = dist({ "index.html": indexHtml, "assets/other.css": valid });
    expect(checkDist(missing).problems).toContain(
      "index.html: links assets/index-1.css, which is not in the build",
    );
  });

  it("resolves links under a base path (vite build --base /app/)", () => {
    const dir = dist({
      "index.html": '<link rel="stylesheet" href="/app/assets/index-1.css?v=1">',
      "assets/index-1.css": valid,
    });
    expect(checkDist(dir)).toEqual({ files: ["assets/index-1.css"], problems: [] });
  });

  it("checks a stylesheet copied from public/ for values only", () => {
    const html = `${indexHtml}<link rel="stylesheet" href="/fonts.css">`;
    const ok = dist({ "index.html": html, "assets/index-1.css": valid, "fonts.css": ".f{x:y}" });
    expect(checkDist(ok)).toEqual({ files: ["assets/index-1.css", "fonts.css"], problems: [] });
    const bad = dist({
      "index.html": html,
      "assets/index-1.css": valid,
      "fonts.css": ".f{margin:--gap}",
    });
    expect(checkDist(bad).problems).toEqual([expect.stringMatching(/^fonts\.css: bare/)]);
    const onlyPublic = dist({
      "index.html": '<link rel="stylesheet" href="/fonts.css">',
      "assets/index-1.css": valid,
      "fonts.css": ".f{x:y}",
    });
    expect(checkDist(onlyPublic).problems).toEqual([
      "index.html: links no stylesheet from assets/",
    ]);
  });

  it("fails without a build", () => {
    const empty = dist({});
    expect(run(empty).status).toBe(1);
    expect(run(empty).stderr).toContain("has no .css file");
    const result = run(join(empty, "missing"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not exist");
  });
});
