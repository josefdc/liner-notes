#!/usr/bin/env node
// Fails when apps/web/src/styles/theme.ts is not what apps/web/config/theme.mjs writes from
// apps/web/src/styles/tokens.css, i.e. when a token changed and theme.ts was not regenerated:
//
//   node scripts/check-theme-sync.mjs                          fix: npm run theme -w apps/web
//   node scripts/check-theme-sync.mjs <tokens.css> <theme.ts>

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { generateTheme, THEME_PATH, TOKENS_PATH } from "../apps/web/config/theme.mjs";

/** Returns the exit code: 0 in sync, 1 stale, 2 when a file cannot be read or generated. */
export function checkThemeSync(tokensPath, themePath, log = console.log, error = console.error) {
  let expected;
  let actual;
  try {
    expected = generateTheme(readFileSync(tokensPath, "utf8"));
    actual = readFileSync(themePath, "utf8");
  } catch (problem) {
    error(`check-theme-sync: ${problem.message}`);
    return 2;
  }
  const shown = relative(process.cwd(), themePath) || themePath;
  if (actual === expected) {
    log(`check-theme-sync: ${shown} matches ${relative(process.cwd(), tokensPath)}`);
    return 0;
  }
  const want = expected.split("\n");
  const have = actual.split("\n");
  const line = want.findIndex((text, i) => text !== have[i]);
  error(
    `check-theme-sync: ${shown} is out of date with ${relative(process.cwd(), tokensPath)}` +
      ` (first difference at line ${line + 1}: expected ${JSON.stringify(want[line] ?? "")},` +
      ` found ${JSON.stringify(have[line] ?? "")}). Run: npm run theme -w apps/web`,
  );
  return 1;
}

if (import.meta.main) {
  const [tokensPath = TOKENS_PATH, themePath = THEME_PATH] = process.argv.slice(2);
  process.exitCode = checkThemeSync(tokensPath, themePath);
}
