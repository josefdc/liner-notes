#!/usr/bin/env node
// Checks the web app's built CSS, which `vite build` writes even when it is broken:
//
//   npm run check:css                               (after npm run build)
//   node scripts/check-built-css.mjs [dist-dir]     default: apps/web/dist
//
// - Tailwind ran: the stylesheet that index.html links starts with the `/*! tailwindcss v4`
//   banner (after any @charset/@import statements) and has the `.flex` utility. Without the
//   Tailwind plugin the build still exits 0 and ships the raw source CSS. Other CSS files (a
//   lazily loaded chunk's styles, say) are not required to carry them.
// - No CSS file keeps Tailwind source at-rules (`@tailwind`, `@theme`, `@apply`, ...).
// - No declaration uses a bare `--name` as a value. Tailwind v3's `p-[--space-md]` compiles in v4
//   to `padding:--space-md`, which browsers drop, so the padding silently disappears; v4 spells it
//   `p-(--space-md)`, i.e. `var(--space-md)`. Allowed: `var(--x)`, `anchor(--x ...)`, custom
//   property values, and the properties whose values are dashed idents (anchor-name,
//   view-transition-name, transition-property, ...). Strings, comments and url() are skipped.

import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const TAILWIND_BANNER = "/*! tailwindcss v4";
const KNOWN_UTILITY = ".flex";
const SOURCE_AT_RULES = new Set([
  "tailwind",
  "theme",
  "apply",
  "utility",
  "custom-variant",
  "variant",
  "source",
  "plugin",
  "config",
  "reference",
]);
// Properties whose values may be dashed idents (`--name`) or custom property names.
const DASHED_IDENT_PROPERTIES = new Set([
  "anchor-name",
  "anchor-scope",
  "position-anchor",
  "position-try",
  "position-try-fallbacks",
  "animation",
  "animation-name",
  "animation-timeline",
  "scroll-timeline",
  "scroll-timeline-name",
  "view-timeline",
  "view-timeline-name",
  "timeline-scope",
  "view-transition-name",
  "view-transition-class",
  "container",
  "container-name",
  "font-palette",
  "transition",
  "transition-property",
  "will-change",
  "counter-reset",
  "counter-increment",
  "counter-set",
]);
// Functions whose arguments may be dashed idents anywhere (var() only as its first argument).
const DASHED_IDENT_FUNCTIONS = new Set(["anchor", "anchor-size"]);

const isNameChar = (ch) => /[\w-]/.test(ch) || ch > "\x7f";
const isNameStart = (ch) => /[a-zA-Z_]/.test(ch) || ch > "\x7f";

/** Index just past the string starting at `i` (a quote character). */
function skipString(css, i) {
  const quote = css[i];
  let j = i + 1;
  while (j < css.length && css[j] !== quote && css[j] !== "\n") j += css[j] === "\\" ? 2 : 1;
  return j + 1;
}

/** Index just past the comment starting at `i` ("/*"). */
function skipComment(css, i) {
  const end = css.indexOf("*/", i + 2);
  return end === -1 ? css.length : end + 2;
}

/** Index of the end of a name (ident) starting at `i`; escapes are part of the name. */
function nameEnd(css, i) {
  let j = i;
  while (j < css.length) {
    if (css[j] === "\\") j += 2;
    else if (isNameChar(css[j])) j += 1;
    else break;
  }
  return j;
}

/** Whether an ident starts at `i`: `--x`, `-x`, `x`, or an escape. */
function startsName(css, i) {
  const [a, b, c] = [css[i], css[i + 1], css[i + 2]];
  if (a === "-") return b === "-" || isNameStart(b ?? "") || (b === "\\" && c !== undefined);
  return isNameStart(a ?? "") || a === "\\";
}

/**
 * Where a statement or block item that starts at `i` ends: the index of the first `;`, `{` or
 * `}` outside strings, comments and parentheses/brackets (or the end of the text).
 */
function itemEnd(css, i) {
  let depth = 0;
  let j = i;
  while (j < css.length) {
    const ch = css[j];
    if (ch === '"' || ch === "'") j = skipString(css, j);
    else if (ch === "/" && css[j + 1] === "*") j = skipComment(css, j);
    else if (ch === "\\") j += 2;
    else {
      if (ch === "(" || ch === "[") depth += 1;
      else if ((ch === ")" || ch === "]") && depth > 0) depth -= 1;
      else if (depth === 0 && (ch === ";" || ch === "{" || ch === "}")) return j;
      j += 1;
    }
  }
  return css.length;
}

/** Index of the `}` that closes the block whose `{` is at `open` (or the end of the text). */
function blockEnd(css, open) {
  let j = open + 1;
  while (j < css.length) {
    const end = itemEnd(css, j);
    if (end >= css.length || css[end] === "}") return end;
    j = css[end] === ";" ? end + 1 : blockEnd(css, end) + 1;
  }
  return css.length;
}

/**
 * Parses CSS into the at-rule names, rule selectors and declarations the checks need. Rules and
 * at-rules nest (CSS nesting, @media, @layer, @supports, @keyframes): a block item that reaches
 * `{` before `;` is a nested rule, anything else with a `:` is a declaration.
 */
export function parseCss(css) {
  const atRules = [];
  const declarations = [];
  const selectors = [];

  const parseItems = (start, end) => {
    let i = start;
    while (i < end) {
      if (/\s|;|}/.test(css[i])) {
        i += 1;
        continue;
      }
      if (css.startsWith("/*", i)) {
        i = skipComment(css, i);
        continue;
      }
      const stop = Math.min(itemEnd(css, i), end);
      const prelude = css.slice(i, stop);
      const atRule = css[i] === "@";
      if (atRule) atRules.push(css.slice(i + 1, nameEnd(css, i + 1)).toLowerCase());
      if (css[stop] === "{") {
        const close = blockEnd(css, stop);
        if (!atRule) selectors.push(prelude.trim());
        parseItems(stop + 1, close);
        i = close + 1;
        continue;
      }
      const colon = prelude.indexOf(":");
      if (!atRule && colon > 0) {
        declarations.push({
          property: prelude.slice(0, colon).trim().toLowerCase(),
          value: prelude.slice(colon + 1).trim(),
        });
      }
      i = stop + 1;
    }
  };

  parseItems(0, css.length);
  return { atRules, declarations, selectors };
}

/** The dashed idents (`--name`) a declaration value uses outside var()'s first argument. */
export function bareDashedIdents(value) {
  const found = [];
  // One entry per open parenthesis: the function's name ("" for a plain group) and whether a
  // token was seen inside it yet.
  const functions = [];
  const sawToken = () => {
    const top = functions.at(-1);
    if (top) top.seen = true;
  };
  let i = 0;
  while (i < value.length) {
    const ch = value[i];
    if (ch === '"' || ch === "'") {
      i = skipString(value, i);
      sawToken();
    } else if (ch === "/" && value[i + 1] === "*") {
      i = skipComment(value, i);
    } else if (/[\s,]/.test(ch)) {
      i += 1;
    } else if (ch === ")") {
      functions.pop();
      i += 1;
    } else if (ch === "(") {
      sawToken();
      functions.push({ name: "", seen: false });
      i += 1;
    } else if (/[0-9.]/.test(ch) || (/[-+]/.test(ch) && /[0-9.]/.test(value[i + 1] ?? ""))) {
      // A number and its unit: `1px`, `-0.5em`, `1e-3`, `50%`.
      let j = i + 1;
      while (j < value.length && /[0-9.]/.test(value[j])) j += 1;
      if (/[eE]/.test(value[j] ?? "") && /[-+0-9]/.test(value[j + 1] ?? "")) {
        j += 2;
        while (j < value.length && /[0-9]/.test(value[j])) j += 1;
      }
      if (value[j] === "%") j += 1;
      else if (j < value.length && startsName(value, j)) j = nameEnd(value, j);
      sawToken();
      i = j;
    } else if (startsName(value, i)) {
      const end = nameEnd(value, i);
      const name = value.slice(i, end);
      const top = functions.at(-1);
      if (value[end] === "(") {
        sawToken();
        if (name.toLowerCase() === "url") {
          // An unquoted url() is a single token: skip to its closing parenthesis.
          const close = value.indexOf(")", end);
          i = close === -1 ? value.length : close + 1;
          continue;
        }
        if (name.startsWith("--")) found.push(`${name}()`);
        functions.push({ name: name.toLowerCase(), seen: false });
        i = end + 1;
        continue;
      }
      if (name.startsWith("--")) {
        const allowed =
          (top?.name === "var" && !top.seen) ||
          functions.some((fn) => DASHED_IDENT_FUNCTIONS.has(fn.name));
        if (!allowed) found.push(name);
      }
      sawToken();
      i = end;
    } else {
      sawToken();
      i += 1;
    }
  }
  return found;
}

/** Whether `css`, after leading @charset/@import statements, starts with the Tailwind banner. */
export function startsWithBanner(css) {
  let i = 0;
  for (;;) {
    while (i < css.length && /\s/.test(css[i])) i += 1;
    const next = css.slice(i, i + 8).toLowerCase();
    if (!next.startsWith("@charset") && !next.startsWith("@import")) break;
    i = itemEnd(css, i) + 1;
  }
  return css.startsWith(TAILWIND_BANNER, i);
}

/** Problems in one CSS file. `entry` adds the checks that Tailwind generated it. */
export function checkCss(css, { entry = false } = {}) {
  const problems = [];
  const { atRules, declarations, selectors } = parseCss(css);
  if (entry) {
    if (!startsWithBanner(css)) {
      problems.push(`does not start with the "${TAILWIND_BANNER}" banner (Tailwind did not run)`);
    }
    const hasUtility = selectors.some((list) =>
      list.split(",").some((selector) => selector.trim() === KNOWN_UTILITY),
    );
    if (!hasUtility) {
      problems.push(`has no "${KNOWN_UTILITY}" rule (Tailwind did not generate utilities)`);
    }
  }
  const leftover = [...new Set(atRules.filter((name) => SOURCE_AT_RULES.has(name)))];
  if (leftover.length > 0) {
    problems.push(`still has Tailwind source at-rules: ${leftover.map((n) => `@${n}`).join(", ")}`);
  }
  const reported = new Set();
  for (const { property, value } of declarations) {
    if (property.startsWith("--") || DASHED_IDENT_PROPERTIES.has(property)) continue;
    const names = bareDashedIdents(value);
    const declaration = `${property}:${value}`;
    if (names.length === 0 || reported.has(declaration)) continue;
    reported.add(declaration);
    problems.push(
      `bare variable name ${names.join(", ")} as a value (use var() or the -(--token) form): ${declaration}`,
    );
  }
  return problems;
}

/** Local stylesheets that an index.html links, as paths relative to the dist directory. */
export function linkedStylesheets(html) {
  const links = [];
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    if (!/\brel\s*=\s*["']?stylesheet\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (!href || /^([a-z][\w+.-]*:)?\/\//i.test(href)) continue;
    links.push(href.replace(/^\.?\//, ""));
  }
  return links;
}

/**
 * Checks every CSS file in `<dist>/assets`. The Tailwind checks apply to the stylesheets that
 * index.html links (without index.html: the largest CSS file).
 * Returns `{ files, problems }`, each problem as "<file>: <problem>".
 */
export function checkDist(dist) {
  const assets = join(dist, "assets");
  if (!existsSync(assets)) {
    return { files: [], problems: [`assets/ does not exist; build the web app first`] };
  }
  const files = readdirSync(assets)
    .filter((name) => name.endsWith(".css"))
    .sort()
    .map((name) => `assets/${name}`);
  if (files.length === 0) {
    return { files, problems: ["assets/ has no .css file; build the web app first"] };
  }

  const problems = [];
  const indexPath = join(dist, "index.html");
  let entries;
  if (existsSync(indexPath)) {
    entries = linkedStylesheets(readFileSync(indexPath, "utf8"));
    if (entries.length === 0) problems.push("index.html: links no local stylesheet");
    for (const entry of entries) {
      if (!files.includes(entry)) problems.push(`index.html: links ${entry}, which does not exist`);
    }
  } else {
    const size = (file) => statSync(join(dist, file)).size;
    entries = [files.reduce((a, b) => (size(b) > size(a) ? b : a))];
  }

  for (const file of files) {
    const css = readFileSync(join(dist, file), "utf8");
    for (const problem of checkCss(css, { entry: entries.includes(file) })) {
      problems.push(`${file}: ${problem}`);
    }
  }
  return { files, problems };
}

function main() {
  const dist = process.argv[2] ?? join(import.meta.dirname, "..", "apps", "web", "dist");
  const { files, problems } = checkDist(dist);
  const shown = relative(process.cwd(), dist) || ".";
  for (const problem of problems) console.error(`[css] ${shown}: ${problem}`);
  if (problems.length > 0) process.exit(1);
  console.log(`[css] ${shown}: ok (${files.join(", ")})`);
}

// Runs when executed directly, not when the tests import it. (import.meta.main is undefined
// before Node 24.2, which would turn the check into a silent no-op there.)
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked === realpathSync(fileURLToPath(import.meta.url))) main();
