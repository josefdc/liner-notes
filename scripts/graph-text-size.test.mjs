// The genealogy graph sets its text sizes from script (D3), where the honesty guard's tiny-text
// rule cannot follow a constant: they are held here to the chrome size of the token sheet.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TOKENS_PATH } from "../apps/web/config/theme.mjs";
import {
  GRAPH_TEXT_PX,
  LINE_LABEL_PX,
  NODE_LABEL_PX,
  SUB_LABEL_PX,
} from "../apps/web/src/components/genealogy/textSize.ts";

describe("the genealogy graph's text", () => {
  it("is never under 12 px, the chrome size of the token sheet", () => {
    const chrome = /--text-chrome:\s*(\d+(?:\.\d+)?)px;/.exec(readFileSync(TOKENS_PATH, "utf8"));
    expect(chrome).not.toBeNull();
    const chromePx = Number(chrome?.[1]);
    expect(chromePx).toBeGreaterThanOrEqual(12);
    for (const size of [GRAPH_TEXT_PX, LINE_LABEL_PX, NODE_LABEL_PX, SUB_LABEL_PX]) {
      expect(size).toBeGreaterThanOrEqual(chromePx);
    }
  });
});
