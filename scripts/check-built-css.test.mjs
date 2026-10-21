// Fixture tests for the built-CSS check. Run with `npm test`.

import { describe, expect, it } from "vitest";
import { checkCss } from "./check-built-css.mjs";

const banner = "/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */\n";
const valid = `${banner}@layer utilities{.flex{display:flex}.p-\\(--space-md\\){padding:var(--space-md)}.md\\:p-4{padding:1rem}}`;

describe("checkCss", () => {
  it("passes Tailwind output with variable utilities and escaped selectors", () => {
    expect(checkCss(valid)).toEqual([]);
  });

  it("does not count an escaped colon before -- in a class name", () => {
    const css = `${valid}.text-\\(length\\:--text-chrome\\){font-size:var(--text-chrome)}`;
    expect(checkCss(css)).toEqual([]);
  });

  it.each([
    ["padding", ".p-\\[--space-md\\]{padding:--space-md}"],
    ["border radius", ".rounded-\\[--radius-md\\]{border-radius:--radius-md}"],
    ["a duration", ".duration-\\[--duration-fast\\]{transition-duration:--duration-fast}"],
  ])("fails a bare variable name as the %s value", (_name, rule) => {
    const problems = checkCss(`${valid}${rule}`);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(rule);
  });

  it("reports a rule with several bare variable names once", () => {
    const rule = ".x{padding:--space-md;margin:--space-sm}";
    expect(checkCss(`${valid}${rule}`)).toEqual([expect.stringContaining(rule)]);
  });

  it("fails CSS that Tailwind did not process", () => {
    const raw = '@import "tailwindcss";\n@theme {\n  --radius-md: 8px;\n}\n.x{color:red}';
    const problems = checkCss(raw);
    expect(problems.some((problem) => problem.includes("banner"))).toBe(true);
    expect(problems.some((problem) => problem.includes(".flex{"))).toBe(true);
    expect(problems.some((problem) => problem.includes("@theme"))).toBe(true);
  });

  it("fails leftover @tailwind and @apply at-rules", () => {
    const problems = checkCss(`${valid}@tailwind utilities;.a{@apply flex;}`);
    expect(problems).toEqual([expect.stringContaining("@tailwind, @apply")]);
  });
});
