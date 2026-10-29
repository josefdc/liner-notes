// Every element of the web app keeps an outline that forced-colors mode (Windows High Contrast)
// can draw when it has the keyboard focus. That mode drops box-shadow, so the focus-visible:ring-*
// rings disappear and the outline is the only focus indicator left. What takes it away, in any
// spelling, fails here: an `outline-none` / `outline-0` class (with any variant, `!` or arbitrary
// value), an outline set to none, 0, unset or initial in a style (JSX, the DOM, d3) or a
// stylesheet (also through @apply), a class name built at run time from `outline-`, and
// `forced-color-adjust: none`, under which the outline stays transparent.
// `focus-visible:outline-hidden` keeps a transparent outline that only forced-colors mode draws,
// and looks the same as outline-none otherwise. A bare `outline-hidden` would draw it round the
// element all the time in forced-colors mode, focused or not, so it takes a focus variant.
// tests/web/forced-colors-focus.spec.ts checks the outlines as drawn.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { classStrings } from "../apps/web/config/classes.mjs";
import { SRC_DIR } from "../apps/web/config/theme.mjs";

/** A value that removes the outline: none, a zero width, or the initial value (none). */
const NONE = String.raw`(?:none|0(?:\.0+)?(?:px|r?em)?(?![\w.%])|unset|initial)`;
/** A Tailwind variant chain: `md:`, `focus-visible:`, `[&:focus]:`, `group-focus:`, ... */
const VARIANTS = String.raw`((?:(?:\[[^\]\s]*\]|[^\s:\[]+):)*)`;
/** outline-none, outline-0 and [outline:none] / [outline-style:none] / [outline-width:0]. */
const CLASS_NONE = new RegExp(
  String.raw`(?:^|\s)(${VARIANTS}!?(?:outline-(?:none|0)|\[outline(?:-style|-width)?:${NONE}[^\]]*\])!?)(?=\s|$)`,
  "g",
);
const CLASS_HIDDEN = new RegExp(String.raw`(?:^|\s)${VARIANTS}!?outline-hidden!?(?=\s|$)`, "g");
const CLASS_ADJUST = new RegExp(
  String.raw`(?:^|\s)(${VARIANTS}!?forced-color-adjust-none!?)(?=\s|$)`,
  "g",
);
/**
 * An outline removed in a style, wherever it is written: `outline: none` in CSS, `outline: 0`
 * in a JSX style object, `el.style.outline = 'none'`, `.style('outline', () => 'none')`,
 * `setProperty('outline-width', '0')`, `[outline:none]`. Not a custom property (`--x-outline`).
 */
const STYLE_NONE = new RegExp(
  String.raw`(?<![\w-])outline(?:-?(?:style|width))?["'\x60]?\s*[:=,]\s*(?:\([^)]*\)\s*=>\s*)?["'\x60]?\s*${NONE}`,
  "gi",
);
const STYLE_ADJUST = /(?<![\w-])forced-?color-?adjust["'\x60]?\s*[:=,]\s*["'\x60]?\s*none/gi;
/** A class name built at run time: `outline-${x}`, 'focus:outline-' + x. */
const DYNAMIC = /outline-\$\{|["'\x60][^"'\x60\n]*outline-["'\x60]\s*\+/g;
const APPLY = /@apply\s+([^;}]+)/g;

/**
 * Places the guard lets through, each with its reason; each must still be there as many times,
 * so an entry cannot outlive the code it is for.
 */
const ALLOWED = [
  {
    site: "components/GenealogyGraph.tsx",
    found: "outline', 'none",
    count: 2,
    why: "the map's SVG cards and links show their focus with a ring and a band of their own; forced-colors mode does not recolour SVG, so an outline there would be transparent",
  },
];

const scriptKind = (path) =>
  /\.tsx$/.test(path)
    ? ts.ScriptKind.TSX
    : /\.[cm]?ts$/.test(path)
      ? ts.ScriptKind.TS
      : /\.jsx$/.test(path)
        ? ts.ScriptKind.JSX
        : ts.ScriptKind.JS;

/** The text with its comments blanked (lines kept), read with the TypeScript parser for scripts. */
function withoutComments(text, path) {
  const blank = (pos, end) => text.slice(pos, end).replace(/[^\n]/g, " ");
  if (path.endsWith(".css"))
    return text.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, scriptKind(path));
  const ranges = new Map();
  const add = (list) => {
    for (const range of list ?? []) ranges.set(range.pos, range.end);
  };
  const visit = (node) => {
    add(ts.getLeadingCommentRanges(text, node.getFullStart()));
    add(ts.getTrailingCommentRanges(text, node.getEnd()));
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);
  let out = "";
  let at = 0;
  for (const [pos, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (pos < at) continue;
    out += text.slice(at, pos) + blank(pos, end);
    at = end;
  }
  return out + text.slice(at);
}

/** The problems in a class string. */
function classProblems(classes) {
  const found = [];
  for (const [, token] of classes.matchAll(CLASS_NONE)) found.push(`class ${token}`);
  for (const [, token] of classes.matchAll(CLASS_ADJUST)) found.push(`class ${token}`);
  for (const [whole, variants] of classes.matchAll(CLASS_HIDDEN)) {
    if (!variants.includes("focus")) {
      found.push(`class ${whole.trim()} without a focus variant`);
    }
  }
  return found;
}

/** The web app's source files (tests apart), with their paths from apps/web/src. */
function sourceFiles() {
  const files = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.(test|spec)\./.test(entry.name)) continue;
      else if (/\.([cm]?[jt]sx?|css)$/.test(entry.name)) {
        files.push({ path, site: relative(SRC_DIR, path), text: readFileSync(path, "utf8") });
      }
    }
  };
  visit(SRC_DIR);
  return files;
}

/**
 * Where a file takes the focus outline away, as "<site>:<line>: <what>", each place once (a
 * conditional's branches give its class string more than once). Also counts the
 * outline-hidden classes, to show that the class strings were read.
 */
function fileProblems({ path, site, text }) {
  const problems = [];
  let hidden = 0;
  const body = withoutComments(text, path);
  const lineOf = (index) => body.slice(0, index).split("\n").length;
  const at = (index, what) =>
    problems.push(`${site}:${lineOf(index)}: ${what.replace(/\s+/g, " ")}`);
  for (const pattern of [STYLE_NONE, STYLE_ADJUST]) {
    for (const match of body.matchAll(pattern)) at(match.index, `style ${match[0]}`);
  }
  if (path.endsWith(".css")) {
    for (const match of body.matchAll(APPLY)) {
      for (const what of classProblems(` ${match[1]} `)) at(match.index, `@apply ${what}`);
    }
  } else {
    for (const match of body.matchAll(DYNAMIC))
      at(match.index, `class built at run time ${match[0]}`);
    for (const { text: classes, line } of classStrings(text, path)) {
      hidden += [...classes.matchAll(CLASS_HIDDEN)].length;
      for (const what of classProblems(classes)) problems.push(`${site}:${line}: ${what}`);
    }
  }
  return { problems: [...new Set(problems)], hidden };
}

/** The problems in `files` that ALLOWED does not let through, and the allowances used. */
function outlineProblems(files, allowed = ALLOWED) {
  const problems = [];
  const used = new Map(allowed.map((entry) => [entry, 0]));
  let hidden = 0;
  for (const file of files) {
    const found = fileProblems(file);
    hidden += found.hidden;
    for (const problem of found.problems) {
      const entry = allowed.find(
        (one) => problem.startsWith(`${one.site}:`) && problem.includes(one.found),
      );
      if (entry) used.set(entry, used.get(entry) + 1);
      else problems.push(problem);
    }
  }
  return { problems, hidden, used };
}

// Every spelling the guard knows, as one small file each: `bad` ones must be reported.
const CASES = [
  // Stylesheets.
  ["c1.css", ".x:focus-visible { outline: none; }", true],
  ["c2.css", ".x:focus-visible {\n  color: red;\n  outline: none\n}", true],
  ["c3.css", ".x:focus-visible { outline: 0px; }", true],
  ["c4.css", ".x { @apply outline-none; }", true],
  ["c5.css", ".x { @apply focus-visible:outline-none; }", true],
  ["c6.css", ".x:focus { outline-width: 0; }", true],
  ["c7.css", ".x:focus { outline: unset; }", true],
  ["c8.css", ".x:focus {\n  outline:\n    none;\n}", true],
  ["c9.css", ".x:focus { outline: 0 none; }", true],
  ["c10.css", "*:focus{outline:none}", true],
  ["c11.css", ".x:focus { outline: NONE; }", true],
  ["c12.css", ".x:focus { outline-style: none !important; }", true],
  ["c13.css", ".x { forced-color-adjust: none; }", true],
  ["c14.css", ".x:focus { OUTLINE: initial; }", true],
  // d3 and the DOM.
  ["d1.ts", "node.style('outline', 'none');", true],
  ["d2.ts", "node.style('outline', '0px');", true],
  ["d3.ts", "node.attr('style', 'outline: none');", true],
  ["d4.ts", 'node.style("outline-width", 0);', true],
  ["d5.ts", "node.style('outline', () => 'none');", true],
  ["d6.ts", "node\n  .style(\n    'outline',\n    'none',\n  );", true],
  ["d7.ts", "node.attr('class', 'card outline-none');", true],
  // JSX styles.
  ["st1.tsx", "export const A = () => <div tabIndex={0} style={{ outline: 0 }} />;", true],
  ["st2.tsx", 'export const A = () => <div tabIndex={0} style={{ outline: "0px" }} />;', true],
  [
    "st3.tsx",
    "export const A = () => <div tabIndex={0} style={{ outlineStyle: 'none' }} />;",
    true,
  ],
  ["st4.tsx", "export const A = () => <div tabIndex={0} style={{ outlineWidth: 0 }} />;", true],
  [
    "st5.tsx",
    "const NONE = 'none';\nexport const A = () => <div tabIndex={0} style={{ outline: NONE }} />;",
    true,
  ],
  [
    "st6.tsx",
    "export const A = () => (\n  <div\n    tabIndex={0}\n    style={{\n      outline:\n        'none',\n    }}\n  />\n);",
    true,
  ],
  ["st7.tsx", "export const A = () => <div tabIndex={0} style={{ outline: `none` }} />;", true],
  ["st8.ts", "export function f(el: HTMLElement) { el.style.outline = 'none'; }", true],
  [
    "st9.ts",
    "export function f(el: HTMLElement) { el.style.setProperty('outline', 'none'); }",
    true,
  ],
  ["st10.tsx", "export const A = () => <div style={{ forcedColorAdjust: 'none' }} />;", true],
  // Classes.
  [
    "tw1.tsx",
    `const hide = cond ? 'none' : 'hidden';\nexport const A = () => <a className={\`rounded-sm focus-visible:outline-\${hide}\`} />;`,
    true,
  ],
  ["tw2.tsx", "export const A = () => <a className={'focus-visible:outline-' + 'none'} />;", true],
  ["tw3.tsx", 'export const A = () => <a className="rounded-sm !outline-none" />;', true],
  [
    "tw4.tsx",
    'export const A = () => <a className="rounded-sm focus-visible:outline-none!" />;',
    true,
  ],
  [
    "tw5.tsx",
    'export const A = () => <a className="rounded-sm focus-visible:[outline:none]" />;',
    true,
  ],
  ["tw6.tsx", 'export const A = () => <a className="rounded-sm focus-visible:outline-0" />;', true],
  ["tw7.tsx", 'export const A = () => <a className="rounded-sm [outline-style:none]" />;', true],
  [
    "tw8.tsx",
    "export const A = () => <a className={clsx('rounded-sm', { 'focus:outline-none': open })} />;",
    true,
  ],
  [
    "tw9.tsx",
    `const parts = ['outline', 'none'];\nexport const A = () => <a className={\`focus-visible:\${parts.join('-')}\`} />;`,
    true,
  ],
  [
    "tw10.tsx",
    'export const A = () => <a className="rounded-sm forced-color-adjust-none focus-visible:outline-hidden" />;',
    true,
  ],
  ["tw12.tsx", 'export const A = () => <h1 className="text-xl outline-hidden" />;', true],
  ["tw13.tsx", 'export const A = () => <a className="md:[&:hover]:outline-none" />;', true],
  [
    "tw14.tsx",
    `export const A = () => <a className={\`p-2 \${on ? 'outline-none' : ''}\`} />;`,
    true,
  ],
  // Prose in a string is read like a class string: reported, the stricter side.
  ["fp3.tsx", "export const HELP = 'Do not use outline-none in this app';", true],
  // Allowed: comments, custom properties, prose, focus variant chains, a transparent colour.
  [
    "fp1.tsx",
    "// Never write .style('outline', 'none') here: forced-colors mode needs the outline.\nexport const A = 1;",
    false,
  ],
  ["fp2.css", "/* Not outline: none; forced-colors mode needs it. */\n.x { color: red; }", false],
  [
    "fp4.tsx",
    'export const A = () => <a className="rounded-sm group-focus-visible:outline-hidden" />;',
    false,
  ],
  [
    "fp5.tsx",
    'export const A = () => <a className="rounded-sm focus-visible:md:outline-hidden" />;',
    false,
  ],
  ["fp6.css", ":root { --card-outline: none; }", false],
  [
    "fp7.tsx",
    'export const A = () => <a className="rounded-sm [&:focus-visible]:outline-hidden" />;',
    false,
  ],
  ["fp8.tsx", '/* <a className="focus:outline-none" /> */\nexport const A = 1;', false],
  [
    "fp9.tsx",
    'export const A = () => <a className="rounded-sm focus-visible:outline-hidden!" />;',
    false,
  ],
  [
    "fp10.tsx",
    'export const A = () => (\n  <>\n    {/* style={{ outline: 0 }} */}\n    <a href="https://example.com/outline-none">x</a>\n  </>\n);',
    false,
  ],
  [
    "tw11.tsx",
    'export const A = () => <a className="rounded-sm focus-visible:outline-transparent focus-visible:outline-hidden" />;',
    false,
  ],
  [
    "ok.tsx",
    'export const A = () => <a className="focus-visible:outline-hidden forced-colors:focus-visible:-outline-offset-2 outline-2 outline-offset-0" />;',
    false,
  ],
  [
    "ok.css",
    ".x { outline-offset: 0; outline: 2px solid transparent; outline-color: unset; }",
    false,
  ],
];

describe("focus outlines in forced-colors mode", () => {
  it("are not taken away anywhere in apps/web/src", () => {
    const { problems, hidden, used } = outlineProblems(sourceFiles());
    expect(problems).toEqual([]);
    expect(hidden, "focus-visible:outline-hidden is found in the source").toBeGreaterThan(20);
    for (const [entry, count] of used) {
      expect(count, `${entry.site}: "${entry.found}" is let through (${entry.why})`).toBe(
        entry.count,
      );
    }
  });

  it("are checked in every spelling: classes, styles, stylesheets and built class names", () => {
    const missed = [];
    const wrong = [];
    for (const [site, text, bad] of CASES) {
      const { problems } = fileProblems({ path: join(SRC_DIR, site), site, text });
      if (bad && problems.length === 0) missed.push(site);
      if (!bad) wrong.push(...problems);
    }
    expect(missed, "spellings that take the outline away but are not reported").toEqual([]);
    expect(wrong, "spellings reported that keep the outline").toEqual([]);
  });

  it("let through only what ALLOWED names, as many times as it says", () => {
    const allowed = [{ site: "a.ts", found: "outline', 'none", count: 1, why: "a test" }];
    const files = [
      { path: join(SRC_DIR, "a.ts"), site: "a.ts", text: "node.style('outline', 'none');" },
      { path: join(SRC_DIR, "b.ts"), site: "b.ts", text: "node.style('outline', 'none');" },
    ];
    const { problems, used } = outlineProblems(files, allowed);
    expect(problems.map((problem) => problem.split(":")[0])).toEqual(["b.ts"]);
    expect([...used.values()]).toEqual([1]);
  });
});
