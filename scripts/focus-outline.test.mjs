// Every element of the web app keeps an outline that forced-colors mode (Windows High Contrast)
// can draw when it has the keyboard focus. That mode drops box-shadow, so the focus-visible:ring-*
// rings disappear and the outline is the only focus indicator left. `outline-none` (with any
// variant) and an inline `outline: none` take it away; `focus-visible:outline-hidden` keeps a
// transparent outline that only forced-colors mode draws, and looks the same as outline-none
// otherwise. A bare `outline-hidden` would draw that outline round the element all the time in
// forced-colors mode, focused or not, so it takes a focus variant.
// tests/web/forced-colors-focus.spec.ts measures the outlines as drawn.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { classStrings } from "../apps/web/config/classes.mjs";
import { SRC_DIR } from "../apps/web/config/theme.mjs";

const OUTLINE_NONE = /(?:^|\s)((?:[^\s:]+:)*outline-none)(?=\s|$)/g;
const OUTLINE_HIDDEN = /(?:^|\s)((?:[^\s:]+:)*)outline-hidden(?=\s|$)/g;
const FOCUS_VARIANT = /(?:^|:)focus(?:-visible|-within)?:$/;
// An outline removed in a style: d3's .style('outline', 'none'), a React style object's
// outline: 'none' / outlineStyle: 'none', or a stylesheet's outline: none / outline: 0.
const INLINE_NONE = [
  /\.style\(\s*["'](?:outline|outline-style)["']\s*,\s*["'](?:none|0)["']/,
  /\boutline(?:Style)?\s*:\s*["'](?:none|0)["']/,
];
const CSS_NONE = /\boutline(?:-style)?\s*:\s*(?:none|0)\s*(?:!important\s*)?[;}]/;

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
 * Where a class string, a style or a stylesheet takes the focus outline away (each place once,
 * though a conditional's branches give its class string more than once).
 */
function outlineProblems(files) {
  const problems = [];
  let hidden = 0;
  for (const { path, site, text } of files) {
    if (path.endsWith(".css")) {
      text.split("\n").forEach((line, i) => {
        if (CSS_NONE.test(line)) problems.push(`${site}:${i + 1}: ${line.trim()}`);
      });
      continue;
    }
    for (const { text: classes, line } of classStrings(text, path)) {
      for (const [, token] of classes.matchAll(OUTLINE_NONE)) {
        problems.push(`${site}:${line}: ${token} (use focus-visible:outline-hidden)`);
      }
      for (const [, variants] of classes.matchAll(OUTLINE_HIDDEN)) {
        hidden += 1;
        if (!FOCUS_VARIANT.test(variants)) {
          problems.push(
            `${site}:${line}: ${variants}outline-hidden without a focus variant (use focus-visible:outline-hidden)`,
          );
        }
      }
    }
    text.split("\n").forEach((line, i) => {
      if (INLINE_NONE.some((pattern) => pattern.test(line))) {
        problems.push(`${site}:${i + 1}: ${line.trim()} (use focus-visible:outline-hidden)`);
      }
    });
  }
  return { problems: [...new Set(problems)], hidden };
}

describe("focus outlines in forced-colors mode", () => {
  it("are not taken away anywhere in apps/web/src", () => {
    const { problems, hidden } = outlineProblems(sourceFiles());
    expect(problems).toEqual([]);
    expect(hidden, "focus-visible:outline-hidden is found in the source").toBeGreaterThan(20);
  });

  it("are checked in class strings, styles and stylesheets", () => {
    const file = (site, text) => ({ path: join(SRC_DIR, site), site, text });
    const { problems } = outlineProblems([
      file("a.tsx", '<a className="rounded-sm focus-visible:outline-none" />;'),
      file("b.tsx", "const c = x ? 'focus:outline-none' : 'p-2 outline-none';"),
      file("c.tsx", '<h1 className="text-xl outline-hidden" />;'),
      file("d.ts", "node.style('outline', 'none');"),
      file("e.tsx", "<div style={{ outline: 'none' }} />;"),
      file("f.css", ".x:focus { outline: none; }"),
      file(
        "ok.tsx",
        '<a className="focus-visible:outline-hidden md:focus-visible:outline-hidden outline-2 outline-offset-1" />;',
      ),
      file("ok.css", ".x { outline-offset: 0; outline: 2px solid transparent; }"),
    ]);
    expect(problems.map((problem) => problem.split(":")[0])).toEqual([
      "a.tsx",
      "b.tsx",
      "b.tsx",
      "c.tsx",
      "d.ts",
      "e.tsx",
      "f.css",
    ]);
  });
});
