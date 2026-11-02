// The visual baselines are drawn by one image: the one scripts/visual.mjs runs locally is the one
// CI's visual job runs in, pinned by digest, and it is the release of the @playwright/test that
// package.json pins (its browsers are the ones that version drives).

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IMAGE } from "./visual.mjs";

const root = join(import.meta.dirname, "..");
const ci = readFileSync(join(root, ".github", "workflows", "ci.yml"), "utf8");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** The image of the job `id` in ci.yml (`container: image:`), or null. */
function jobImage(id) {
  const job = ci.split(/\n(?= {2}[\w-]+:\n)/).find((block) => block.startsWith(`  ${id}:\n`));
  return /\n\s+container:\n\s+image:\s*(\S+)/.exec(job ?? "")?.[1] ?? null;
}

describe("the visual baselines' image", () => {
  it("is pinned by digest", () => {
    expect(IMAGE).toMatch(/^mcr\.microsoft\.com\/playwright:v[\d.]+-noble@sha256:[0-9a-f]{64}$/);
  });

  it("is the release of the pinned @playwright/test", () => {
    expect(IMAGE).toContain(`:v${pkg.devDependencies["@playwright/test"]}-`);
  });

  it("is the one CI's visual job runs in", () => {
    expect(jobImage("visual")).toBe(IMAGE);
  });
});
