// Every focus ring the web app draws reaches 3:1 (WCAG 1.4.11) against what is beside it: the
// page or a panel on it outside, and the ring offset (the page colour) inside when it has one.
// Rings are read from the class strings in apps/web/src (focus-visible:ring-<colour>[/<alpha>]),
// with the token sheet's colours. tests/web/component-styles.spec.ts measures some of them as
// drawn, too.

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { classStrings } from "../apps/web/config/classes.mjs";
import { contrastRatio, over, PAGE, surfaceStacks } from "../apps/web/config/contrast.mjs";
import { SRC_DIR, TOKENS_PATH } from "../apps/web/config/theme.mjs";
import { parseColor, readTokens, resolveToken } from "../apps/web/config/tokens.mjs";

const RING = /(?:^|\s)focus-visible:ring-([a-z][\w-]*?)(?:\/(\d+))?(?=\s|$)/g;
const NOT_A_COLOUR = /^(?:\d+|inset|offset-.*)$/;

/** Every focus ring colour in the source: [{ token, alpha, site }]. */
function focusRings() {
  const found = [];
  const visit = (folder) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !/\.(test|spec)\./.test(entry.name)) {
        for (const { text, line } of classStrings(readFileSync(path, "utf8"), path)) {
          for (const [, name, alpha] of text.matchAll(RING)) {
            if (NOT_A_COLOUR.test(name)) continue;
            found.push({
              token: `--color-${name}`,
              alpha: alpha === undefined ? 1 : Number(alpha) / 100,
              site: `${relative(SRC_DIR, path)}:${line}`,
            });
          }
        }
      }
    }
  };
  visit(SRC_DIR);
  return found;
}

describe("focus rings", () => {
  const tokens = readTokens(readFileSync(TOKENS_PATH, "utf8"));
  const page = parseColor(resolveToken(tokens, PAGE));
  // Rings sit on the page and on panels, not on a hover or active state.
  const behind = surfaceStacks(tokens).filter((stack) => stack.layer);

  it("are found in the source", () => {
    expect(focusRings().length).toBeGreaterThan(20);
  });

  it("reach 3:1 against the page, every panel, and the ring offset", () => {
    const short = [];
    for (const { token, alpha, site } of focusRings()) {
      const colour = parseColor(resolveToken(tokens, token));
      expect(colour, `${site}: ${token} is not a colour token`).not.toBeNull();
      const ring = { ...colour, a: colour.a * alpha };
      const lowest = Math.min(
        ...behind.map((stack) => contrastRatio(over(ring, stack.color), stack.color)),
        contrastRatio(over(ring, page), page),
      );
      if (lowest < 3) short.push(`${site} ${token}/${alpha * 100} ${lowest.toFixed(2)}:1`);
    }
    expect(short).toEqual([]);
  });
});
