// Every element of the web app keeps an outline that forced-colors mode (Windows High Contrast)
// can draw when it has the keyboard focus. That mode drops box-shadow, so the focus-visible:ring-*
// rings disappear and the outline is the only focus indicator left. What takes it away fails
// here, in the spellings CASES lists: an outline, outline-style or outline-width whose value has
// a `none` or a zero length in any unit (calc() and min() too), or resets it (unset, initial,
// inherit); an outline colour of Canvas, ButtonFace or Field, the backgrounds forced-colors mode
// keeps and so hides it against (light-dark() and color-mix() too); in a stylesheet, a JSX
// style, the DOM (el.style, setProperty, attributeStyleMap.set) or d3, an [property, value]
// entry of a list or Map, through var() and the custom properties set in the source; the same
// as a class (`outline-none`, `outline-0`, `outline-[0px]`, `[outline:2px_none]`,
// `outline-[Canvas]`, any variant, `!`, @apply); `all: unset` or `initial`; any
// `forced-color-adjust` but `auto`, under which the outline stays transparent; and a class name
// built at run time from `outline-` or after a variant (`focus-visible:${x}`, `focus:!${x}`,
// 'focus-visible:' + x). A value known only at run time, such as one read from data, is beyond
// what it reads.
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

/** A value token that removes the outline: none, a zero length in any unit, or a reset. */
const REMOVES = /^(?:none|unset|initial|inherit|[+-]?(?:0+(?:\.0*)?|\.0+)(?:[a-z]+|%)?)$/i;
/** The properties that can remove it. */
const NAMES = "outline(?:-?(?:style|width|color))?|all|forced-?color-?adjust";
/** A declaration, wherever it is written: CSS, JSX, el.style.x or el.style['x'], a computed key. */
const PROPERTY = new RegExp(`(?<![\\w-])(${NAMES})["'\x60]?\\]?\\s*[:=](?![=>])\\s*`, "gi");
/**
 * The same as the arguments of d3's style(), setProperty() or attributeStyleMap.set(), or as
 * an entry of a list of pairs or a Map: [['outline', 'none']] (a lone pair is not one).
 */
const CALL = new RegExp(
  `(?:\\b(?:style|setProperty|set)\\(|(?<=[\\[(,]\\s*)\\[)\\s*["'\x60](${NAMES})["'\x60]\\s*,\\s*`,
  "gi",
);
/** Colour functions, whose arguments are not lengths. */
const COLOUR = /^(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)$/i;
/** Functions that mix colours: only the system colours named in them are read. */
const MIX = /^(?:color-mix|light-dark)$/i;
/** The system colours of the backgrounds forced-colors mode keeps. */
const BACKGROUND = /^(?:canvas|buttonface|field)$/i;
/** A Tailwind variant that a class built at run time can follow. */
const VARIANT =
  "(?<![\\w-])(?:(?:group|peer)-)?(?:focus(?:-visible|-within)?|hover|active|forced-colors|dark|sm|md|lg|xl|2xl):!?";
/**
 * A class name built at run time: `outline-${x}`, 'focus:outline-' + x, `focus-visible:${x}`,
 * `focus:!${x}`, 'focus-visible:' + x.
 */
const DYNAMIC = new RegExp(
  `outline-\\$\\{|["'\x60][^"'\x60\\n]*outline-["'\x60]\\s*\\+|${VARIANT}\\$\\{|["'\x60][^"'\x60\\n]*${VARIANT}["'\x60]\\s*\\+`,
  "g",
);
const APPLY = /@apply\s+([^;}]+)/g;
/** Custom properties, for the var() an outline's value reads. */
const CUSTOM = /["']?(--[\w-]+)["']?\s*:\s*["']?([^;}'",]+)/g;
const CUSTOM_CALL = /setProperty\(\s*["'\x60](--[\w-]+)["'\x60]\s*,\s*["'\x60]([^"'\x60]*)/g;

/**
 * Places the guard lets through, each with its reason: the source line it must be, and how many
 * times, so an entry covers that line only and cannot outlive it; and, for a helper, how many
 * times the file uses it, so a new use fails here.
 */
const ALLOWED = [
  {
    site: "components/GenealogyGraph.tsx",
    line: "selection.style('outline', 'none');",
    count: 1,
    uses: { name: "withoutOutline", count: 2 },
    why: "withoutOutline, typed to take SVG selections only, for the map's SVG cards and links, which show their focus with a ring and a band of their own; forced-colors mode does not recolour SVG, so an outline there would be transparent",
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

/**
 * A value's tokens: var() replaced by the custom property's value (and its fallback), other
 * functions (colours, calc) left out, then split on whitespace, `_`, `,` and `/`.
 */
function tokens(value, vars) {
  let text = value;
  for (let i = 0; i < 5 && /var\(/.test(text); i += 1) {
    text = text.replace(
      /var\(\s*(--[\w-]+)\s*(?:,([^()]*))?\)/g,
      (_, name, fallback) => ` ${vars.get(name) ?? ""} ${fallback ?? ""} `,
    );
  }
  // Innermost first: a colour function goes, a mix leaves the system colours it names, any
  // other function (calc, min) leaves its arguments.
  for (let i = 0; i < 8 && /\(/.test(text); i += 1) {
    text = text.replace(/([\w-]*)\(([^()]*)\)/g, (_, name, inner) =>
      COLOUR.test(name)
        ? " "
        : MIX.test(name)
          ? ` ${inner
              .split(/[\s,]+/)
              .filter((word) => BACKGROUND.test(word))
              .join(" ")} `
          : ` ${inner} `,
    );
  }
  return text
    .replace(/["'\x60]/g, " ")
    .split(/[\s_,/]+/)
    .map((token) => token.replace(/^!|!(?:important)?$/i, ""))
    .filter(Boolean);
}

/** Whether `property: value` removes the outline. */
function removes(property, value, vars) {
  const name = property.toLowerCase().replace(/^forcedcoloradjust$/, "forced-color-adjust");
  const words = tokens(value, vars);
  if (name === "all") return words.some((word) => /^(?:unset|initial)$/i.test(word));
  if (/^forced-?color-?adjust$/.test(name)) {
    return words.some((word) => !/^(?:auto|important)$/i.test(word));
  }
  const canvas = words.some((word) => BACKGROUND.test(word));
  if (/color$/.test(name)) return canvas;
  return canvas || words.some((word) => REMOVES.test(word));
}

/** A declaration's value, from `i`: a quoted string, or up to the end of the declaration. */
function valueAt(body, from) {
  let i = from;
  const arrow = /^\([^)]*\)\s*=>\s*/.exec(body.slice(i));
  if (arrow) i += arrow[0].length;
  const quote = body[i];
  if (quote === '"' || quote === "'" || quote === "`") {
    const end = body.indexOf(quote, i + 1);
    return body.slice(i + 1, end < 0 ? undefined : end);
  }
  let depth = 0;
  let j = i;
  for (; j < body.length; j += 1) {
    const c = body[j];
    if (c === "(") depth += 1;
    else if (c === ")") {
      if (depth === 0) break;
      depth -= 1;
    } else if (depth === 0 && /[;},\]]/.test(c)) break;
  }
  return body.slice(i, j);
}

/** A class token's variant chain and utility (the part after the last top-level colon). */
function splitClass(token) {
  let depth = 0;
  let last = -1;
  for (let i = 0; i < token.length; i += 1) {
    const c = token[i];
    if (c === "[" || c === "(") depth += 1;
    else if (c === "]" || c === ")") depth -= 1;
    else if (c === ":" && depth === 0) last = i;
  }
  return {
    variants: token.slice(0, last + 1),
    utility: token.slice(last + 1).replace(/^!|!$/g, ""),
  };
}

/** The problems in a class string, and how many outline-hidden classes it has. */
function classProblems(classes, vars) {
  const found = [];
  let hidden = 0;
  for (const token of classes.split(/\s+/).filter(Boolean)) {
    const { variants, utility } = splitClass(token);
    const arbitrary = /^\[([\w-]+):(.*)\]$/.exec(utility);
    const valued = /^outline-(?:\[(?:[\w-]+:)?(.*)\]|\((?:[\w-]+:)?(--[\w-]+)\))$/.exec(utility);
    let bad = false;
    if (/^outline-(?:none|0)$/.test(utility)) bad = true;
    else if (/^forced-color-adjust-/.test(utility)) bad = utility !== "forced-color-adjust-auto";
    else if (arbitrary)
      bad =
        /^(?:outline(?:-style|-width|-color)?|all|forced-color-adjust)$/.test(arbitrary[1]) &&
        removes(arbitrary[1], arbitrary[2], vars);
    else if (valued) bad = removes("outline", valued[1] ?? `var(${valued[2]})`, vars);
    else if (utility === "outline-hidden") {
      hidden += 1;
      if (!variants.includes("focus")) found.push(`class ${token} without a focus variant`);
    }
    if (bad) found.push(`class ${token}`);
  }
  return { found, hidden };
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

/** The custom properties the files declare, for var(). */
function customProperties(files) {
  const vars = new Map();
  for (const { path, text } of files) {
    const body = withoutComments(text, path);
    for (const [, name, value] of [...body.matchAll(CUSTOM), ...body.matchAll(CUSTOM_CALL)]) {
      vars.set(name, `${vars.get(name) ?? ""} ${value}`);
    }
  }
  return vars;
}

/**
 * Where a file takes the focus outline away, as { line, what }, each place once (a
 * conditional's branches give its class string more than once). Also counts the
 * outline-hidden classes, to show that the class strings were read.
 */
function fileProblems({ path, text }, vars = customProperties([{ path, text }])) {
  const problems = new Map();
  let hidden = 0;
  const body = withoutComments(text, path);
  const lineOf = (index) => body.slice(0, index).split("\n").length;
  const add = (line, what) => problems.set(`${line}: ${what}`, { line, what });
  for (const match of [...body.matchAll(PROPERTY), ...body.matchAll(CALL)]) {
    const value = valueAt(body, match.index + match[0].length);
    if (removes(match[1], value, vars)) {
      add(lineOf(match.index), `style ${match[1]}: ${value.trim().replace(/\s+/g, " ")}`);
    }
  }
  if (path.endsWith(".css")) {
    for (const match of body.matchAll(APPLY)) {
      for (const what of classProblems(match[1], vars).found) {
        add(lineOf(match.index), `@apply ${what}`);
      }
    }
  } else {
    for (const match of body.matchAll(DYNAMIC)) {
      add(lineOf(match.index), `class built at run time ${match[0]}`);
    }
    for (const { text: classes, line } of classStrings(text, path)) {
      const found = classProblems(classes, vars);
      hidden += found.hidden;
      for (const what of found.found) add(line, what);
    }
  }
  return { problems: [...problems.values()], hidden };
}

/**
 * The problems in `files` that ALLOWED does not let through, the allowances used, and how many
 * times each allowed helper is used (its definition apart).
 */
function outlineProblems(files, allowed = ALLOWED) {
  const vars = customProperties(files);
  const problems = [];
  const used = new Map(allowed.map((entry) => [entry, 0]));
  const uses = new Map(allowed.filter((entry) => entry.uses).map((entry) => [entry, 0]));
  let hidden = 0;
  for (const file of files) {
    const found = fileProblems(file, vars);
    hidden += found.hidden;
    const lines = file.text.split("\n");
    for (const entry of uses.keys()) {
      if (entry.site !== file.site) continue;
      const { name } = entry.uses;
      const body = withoutComments(file.text, file.path);
      const all = body.match(new RegExp(`\\b${name}\\b`, "g"))?.length ?? 0;
      const defined = body.match(new RegExp(`\\bfunction\\s+${name}\\b`, "g"))?.length ?? 0;
      uses.set(entry, all - defined);
    }
    for (const { line, what } of found.problems) {
      const entry = allowed.find(
        (one) => one.site === file.site && lines[line - 1]?.trim() === one.line,
      );
      if (entry) used.set(entry, used.get(entry) + 1);
      else problems.push(`${file.site}:${line}: ${what}`);
    }
  }
  return { problems, hidden, used, uses };
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
  // Values read token by token: a none or a zero length anywhere in the value, in any unit.
  ["v1.tsx", 'export const A = () => <a className="focus-visible:outline-[0px]" />;', true],
  ["v2.tsx", 'export const A = () => <a className="focus:outline-[0]" />;', true],
  ["v3.tsx", 'export const A = () => <a className="focus:[outline:0_solid]" />;', true],
  ["v4.tsx", 'export const A = () => <a className="focus:[outline:2px_none]" />;', true],
  ["v5.css", ".x:focus { outline: 2px none; }", true],
  ["v6.css", ".x:focus { outline: solid 0; }", true],
  ["v7.css", ".x:focus { outline: transparent none; }", true],
  ["v8.ts", "node.style('outline', '1px none');", true],
  ["v9.css", ".x:focus { outline-width: 0pt; }", true],
  ["v10.css", ".x:focus { outline: 0vw solid red; }", true],
  ["v11.css", ".x { all: unset; }", true],
  ["v12.tsx", 'export const A = () => <button className="[all:unset]" />;', true],
  ["v13.css", ":root { --x: none; }\n.x:focus { outline: var(--x); }", true],
  [
    "v14.tsx",
    'export const A = () => <a className="[forced-color-adjust:preserve-parent-color]" />;',
    true,
  ],
  ["v15.css", ".x { forced-color-adjust: preserve-parent-color; }", true],
  ["v16.css", ".x { all: initial; }", true],
  ["v17.tsx", "export const A = () => <div style={{ all: 'unset' }} />;", true],
  ["v18.css", ".x:focus { outline: 0.0em solid; }", true],
  ["v19.css", ".x:focus { outline: var(--missing, none); }", true],
  ["v20.tsx", 'export const A = () => <a className="focus:outline-[length:0rem]" />;', true],
  ["v21.tsx", 'export const A = () => <a className="focus:[outline-style:none]!" />;', true],
  // Element style keys, computed keys, math functions, a Canvas colour, set custom properties.
  ["k1.ts", "export function f(el: HTMLElement) { el.style['outline'] = 'none'; }", true],
  ["k2.ts", 'export function f(el: HTMLElement) { el.style["outline-style"] = "none"; }', true],
  ["k3.tsx", "export const S = { ['outline']: 'none' };", true],
  ["k4.css", ".x:focus { outline: calc(0px) solid; }", true],
  ["k5.css", ".x:focus { outline-width: min(0px, 2px); }", true],
  ["k6.css", ".x:focus-visible { outline-color: Canvas; }", true],
  ["k7.tsx", 'export const A = () => <a className="focus-visible:outline-[Canvas]" />;', true],
  ["k8.tsx", 'export const A = () => <a className="focus:[outline-color:Canvas]" />;', true],
  ["k9.tsx", "export const A = () => <a style={{ outlineColor: 'Canvas' }} />;", true],
  ["k10.css", ".x:focus { outline: 2px solid canvas; }", true],
  [
    "k11.ts",
    "export function f(el: HTMLElement) {\n  el.style.setProperty('--ring', 'none');\n  el.style.outline = 'var(--ring)';\n}",
    true,
  ],
  ["k12.ts", "node.style('outline-color', 'Canvas');", true],
  ["k13.css", ".x:focus { outline: 2px solid rgb(calc(0) 0 0); outline-width: max(0em); }", true],
  // Pairs and maps, other system backgrounds, colour mixes, variants joined at run time.
  [
    "m1.ts",
    "export function f(el: HTMLElement) { el.attributeStyleMap.set('outline-style', 'none'); }",
    true,
  ],
  ["m2.ts", "export const S = Object.fromEntries([['outline', 'none']]);", true],
  ["m3.ts", "export const S = new Map([['outline-width', '0']]);", true],
  ["m4.css", ".x:focus-visible { outline-color: ButtonFace; }", true],
  ["m5.css", ".x:focus-visible { outline: 2px solid Field; }", true],
  ["m6.css", ".x:focus-visible { outline-color: light-dark(Canvas, CanvasText); }", true],
  ["m7.css", ".x:focus-visible { outline: 2px solid color-mix(in srgb, Field 80%, red); }", true],
  [
    "m8.tsx",
    "export const A = ({ x }: { x: string }) => <a className={'focus-visible:' + x} />;",
    true,
  ],
  [
    "m9.tsx",
    `export const A = ({ x }: { x: string }) => <a className={\`focus-visible:!\${x}\`} />;`,
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
  ["s1.css", ".x:focus { outline: 0.5px solid; outline-offset: 0px; }", false],
  [
    "s2.tsx",
    'export const A = () => <a className="focus:outline-[2px] focus:[outline:2px_solid_red]" />;',
    false,
  ],
  ["s3.css", ":root { --ring: 2px solid red; }\n.x:focus { outline: var(--ring); }", false],
  ["s4.css", ".x { forced-color-adjust: auto; all: revert; }", false],
  ["s5.ts", "export const both = Promise.all([a, b]);\nexport const opts = { all: true };", false],
  [
    "s6.tsx",
    "export const A = () => <div style={{ forcedColorAdjust: 'auto', outlineOffset: 0 }} />;",
    false,
  ],
  [
    "s7.tsx",
    'export const A = () => <a className="forced-color-adjust-auto outline-10" />;',
    false,
  ],
  ["s8.ts", "export const button = { variant: 'outline', padding: 0 };", false],
  ["s9.ts", "export const options = [{ value: 'all', label: 'Initial' }];", false],
  ["s10.ts", "export const props = ['forced-color-adjust', 'color'];", false],
  ["s11.ts", "export const flat = (v: { outline: number }) => v.outline === 0;", false],
  ["s12.css", ".x:focus { outline: 2px solid rgb(0 0 0 / 0); outline-color: CanvasText; }", false],
  ["s13.ts", "node.style('outline-offset', '0px').style('outline-color', 'Highlight');", false],
  ["s14.css", ".x:focus { outline: 2px solid color-mix(in srgb, CanvasText 0%, red); }", false],
  ["s15.ts", "export const seen = new Set(['outline']);\nseen.has('outline');", false],
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
    const { problems, hidden, used, uses } = outlineProblems(sourceFiles());
    expect(problems).toEqual([]);
    expect(hidden, "focus-visible:outline-hidden is found in the source").toBeGreaterThan(20);
    for (const [entry, count] of used) {
      expect(count, `${entry.site}: "${entry.line}" is let through (${entry.why})`).toBe(
        entry.count,
      );
    }
    for (const [entry, count] of uses) {
      expect(count, `${entry.site}: ${entry.uses.name} is used`).toBe(entry.uses.count);
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
    const allowed = [
      {
        site: "a.ts",
        line: "node.style('outline', 'none');",
        count: 1,
        uses: { name: "bare", count: 2 },
        why: "a test",
      },
    ];
    const helper =
      "function bare(node) {\n  node.style('outline', 'none');\n}\n// bare(comment)\nx.call(bare);\ny.call(bare);\nz.call(bare);";
    const files = [
      { path: join(SRC_DIR, "a.ts"), site: "a.ts", text: helper },
      { path: join(SRC_DIR, "b.ts"), site: "b.ts", text: "node.style('outline', 'none');" },
      {
        path: join(SRC_DIR, "c.ts"),
        site: "c.ts",
        text: "node.style('outline', 'none');\nother.style('outline', 'none');",
      },
    ];
    const { problems, used, uses } = outlineProblems(files, allowed);
    expect([...uses.values()], "a third use of the helper is counted").toEqual([3]);
    expect(problems.map((problem) => problem.split(":").slice(0, 2).join(":"))).toEqual([
      "b.ts:1",
      "c.ts:1",
      "c.ts:2",
    ]);
    expect([...used.values()]).toEqual([1]);
  });
});
