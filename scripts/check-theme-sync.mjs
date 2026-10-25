#!/usr/bin/env node
// Fails when apps/web/src/styles/theme.ts is not what apps/web/config/theme.mjs writes from
// apps/web/src/styles/tokens.css, i.e. when a token changed and theme.ts was not regenerated:
//
//   node scripts/check-theme-sync.mjs                          fix: npm run theme -w apps/web
//   node scripts/check-theme-sync.mjs <tokens.css> <theme.ts>
//
// Also fails when a stylesheet under apps/web/src other than tokens.css declares a token in an
// @theme block (tokens.css is their one source; another @theme block may hold @keyframes only),
// or when a token's var() does not resolve.
//
// npm test runs this (check-theme-sync.test.mjs) before the build; the web build regenerates
// theme.ts first, so running this after a build always passes.

import { readFileSync, realpathSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateTheme,
  SRC_DIR,
  strayThemeTokens,
  THEME_PATH,
  TOKENS_PATH,
} from "../apps/web/config/theme.mjs";

/** Returns the exit code: 0 in sync, 1 stale or stray tokens, 2 when a file cannot be read. */
export function checkThemeSync(
  tokensPath,
  themePath,
  log = console.log,
  error = console.error,
  srcDir = SRC_DIR,
) {
  let expected;
  let actual;
  try {
    const stray = strayThemeTokens(srcDir);
    if (stray.length > 0) {
      error(
        "check-theme-sync: tokens declared outside tokens.css (an @theme block elsewhere may" +
          ` hold @keyframes only):\n  ${stray.join("\n  ")}`,
      );
      return 1;
    }
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

// Runs when executed directly, not when the tests import it. (import.meta.main is undefined
// before Node 24.2, which would turn the check into a silent no-op there.)
const invoked = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invoked === realpathSync(fileURLToPath(import.meta.url))) {
  const [tokensPath = TOKENS_PATH, themePath = THEME_PATH] = process.argv.slice(2);
  process.exitCode = checkThemeSync(tokensPath, themePath);
}
