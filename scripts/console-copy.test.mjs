// The run log, the activity log and the progress screen say plainly what happened: none of the
// prototype's copy or emoji the honesty guard counts, no mock window controls or CRT effect, and
// none of the measured cyan or sourced amber, which mean how a value is known, not a log step.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { countInText, rules } from "./guard-honest.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFileSync(join(root, path), "utf8");
const rule = (id) => rules.find((candidate) => candidate.id === id);
const found = (id, text, path) =>
  countInText(rule(id), text, path).matches.map(({ line, text: match }) => `${line}: ${match}`);

const CONSOLE = "apps/web/src/components/SystemConsole.tsx";
const ACTIVITY_LOG = "apps/web/src/components/ActivityLog.tsx";
const LOG_CODES = "apps/web/src/components/console/logCodes.ts";
const AGENT_HOOK = "apps/web/src/hooks/useAgent.ts";
const ONBOARDING = "apps/web/src/components/Onboarding.tsx";
const STYLES = "apps/web/src/styles/index.css";
const TOKENS = "apps/web/src/styles/tokens.css";

/**
 * The part of a file from the line holding `from` up to the line holding `to` (excluded), `to`
 * searched for from `skip` characters after `from`.
 */
function section(text, from, to, skip = 0) {
  const start = text.indexOf(from);
  const end = text.indexOf(to, start + skip);
  expect(start, `"${from}" is in the file`).toBeGreaterThanOrEqual(0);
  expect(end, `"${to}" follows "${from}"`).toBeGreaterThan(start);
  return text.slice(text.lastIndexOf("\n", start) + 1, end);
}

describe("console copy", () => {
  it.each([CONSOLE, ACTIVITY_LOG, LOG_CODES, AGENT_HOOK])(
    "%s holds no prototype copy or emoji",
    (path) => {
      const text = read(path);
      expect(found("prototype-copy", text, path)).toEqual([]);
      expect(found("emoji-in-progress", text, path)).toEqual([]);
    },
  );

  it("the progress screen's status lines and completion button hold no prototype copy", () => {
    const text = read(ONBOARDING);
    const parts = [
      section(text, "const STATUS_MESSAGES", "function statusMessage"),
      section(text, "{/* System Console */}", "export default Onboarding"),
    ];
    for (const part of parts) {
      expect(found("prototype-copy", part, ONBOARDING)).toEqual([]);
      expect(found("emoji-in-progress", part, ONBOARDING)).toEqual([]);
    }
    // Every status has a line: none falls back to the raw status name.
    expect(text).not.toMatch(/Status: \$\{status\}/);
  });

  it("the progress screen uses neither cyan nor amber: reticle, picker, countdown, bar, button", () => {
    const screen = section(
      read(ONBOARDING),
      "{/* Central Node Graphic",
      "export default Onboarding",
    );
    expect(screen).not.toMatch(/cyber|analog|-amber/);
    // The reticle's completion glow, drawn by a keyframe in the stylesheet.
    expect(screen).toContain("animate-completion-reveal");
    const glow = section(read(STYLES), "@keyframes completion-reveal", "@keyframes", 1);
    expect(glow).not.toMatch(/cyber|analog|amber/);
  });

  it("the completion button's old cyan glow is gone, with its animation token", () => {
    expect(read(STYLES)).not.toMatch(/@keyframes glow-breathe\s*\{/);
    expect(read(TOKENS)).not.toMatch(/--animate-glow-breathe:/);
  });

  it("the run log has no mock window controls and no CRT scanlines", () => {
    expect(read(CONSOLE)).not.toMatch(/just kidding|\(nope\)|dreaming|crt-scanlines/);
  });

  it.each([CONSOLE, ACTIVITY_LOG, LOG_CODES])("%s uses neither cyan nor amber", (path) => {
    expect(read(path)).not.toMatch(/cyber|analog|-amber/);
  });
});
