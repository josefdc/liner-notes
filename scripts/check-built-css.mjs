#!/usr/bin/env node
// Checks the web app's built CSS, which `vite build` writes even when it is broken:
//
//   node scripts/check-built-css.mjs [dist-dir]     (default: apps/web/dist)
//
// - Tailwind ran: the file starts with the `/*! tailwindcss v4` banner, contains a known utility
//   (`.flex{`) and has no Tailwind source at-rules left (`@tailwind`, `@theme`, `@apply`, ...).
//   Without the Tailwind plugin the build still exits 0 and ships the raw source CSS.
// - No value starts with `--`. Tailwind v3's `p-[--space-md]` form compiles in v4 to
//   `padding:--space-md`, which browsers drop, so the padding silently disappears; v4 spells it
//   `p-(--space-md)`. An escaped `\:--` inside a class name is not a value and is not counted.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const TAILWIND_BANNER = "/*! tailwindcss v4";
const KNOWN_UTILITY = ".flex{";
const SOURCE_AT_RULES =
  /@(?:tailwind|theme|apply|utility|custom-variant|variant|source|plugin|config|reference)\b/g;
// A `:` that is not escaped (so not part of a selector such as `.md\:p-4`) followed by `--x`.
const VARIABLE_AS_VALUE = /(?<!\\):--[a-zA-Z]/g;

/** Returns the problems found in one built stylesheet (an empty list when it passes). */
export function checkCss(css) {
  const problems = [];
  if (!css.startsWith(TAILWIND_BANNER)) {
    problems.push(`does not start with the "${TAILWIND_BANNER}" banner (Tailwind did not run)`);
  }
  if (!css.includes(KNOWN_UTILITY)) {
    problems.push(`has no "${KNOWN_UTILITY}" utility (Tailwind did not generate utilities)`);
  }
  const atRules = [...new Set(css.match(SOURCE_AT_RULES) ?? [])];
  if (atRules.length > 0) {
    problems.push(`still has Tailwind source at-rules: ${atRules.join(", ")}`);
  }
  const rules = new Set();
  for (const match of css.matchAll(VARIABLE_AS_VALUE)) {
    const start = css.lastIndexOf("}", match.index) + 1;
    const end = css.indexOf("}", match.index);
    rules.add(css.slice(start, end === -1 ? undefined : end + 1));
  }
  for (const rule of rules) {
    problems.push(`a value is a bare variable name (use var() or the -(--token) form): ${rule}`);
  }
  return problems;
}

function main() {
  const dist = process.argv[2] ?? join(import.meta.dirname, "..", "apps", "web", "dist");
  const assets = join(dist, "assets");
  let files;
  try {
    files = readdirSync(assets).filter((name) => name.endsWith(".css"));
  } catch (error) {
    console.error(`[css] cannot read ${assets}: ${error.message}; build the web app first`);
    process.exit(1);
  }
  if (files.length === 0) {
    console.error(`[css] no .css file in ${assets}; build the web app first`);
    process.exit(1);
  }

  let failed = false;
  for (const name of files) {
    const path = join(assets, name);
    const problems = checkCss(readFileSync(path, "utf8"));
    const shown = relative(process.cwd(), path);
    if (problems.length === 0) {
      console.log(`[css] ${shown}: ok`);
      continue;
    }
    failed = true;
    for (const problem of problems) console.error(`[css] ${shown}: ${problem}`);
  }
  if (failed) process.exit(1);
}

// Runs only when executed directly, not when the tests import checkCss.
if (import.meta.main) main();
