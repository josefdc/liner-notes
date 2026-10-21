/**
 * The API extends, composes and converts contract schemas, which needs the one zod both
 * packages resolve: a second copy would build schemas the other's JSON Schema export and
 * registries do not know.
 */

import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const apiDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const contractDir = join(apiDir, "..", "..", "packages", "contract");

/** The zod package.json a package's own imports resolve to, with symlinks resolved. */
const zodOf = (packageDir: string) =>
  realpathSync(createRequire(join(packageDir, "package.json")).resolve("zod/package.json"));

describe("zod", () => {
  it("is the same copy for apps/api and packages/contract", () => {
    expect(zodOf(contractDir)).toBe(zodOf(apiDir));
  });
});
