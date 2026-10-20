/**
 * The API package's root directory and version, found at run time so they are right both in
 * development (src/config/) and in the bundled build (dist/).
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

function findApiRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

export const API_ROOT = findApiRoot();

function readVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(API_ROOT, "package.json"), "utf8"));
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}

/** The version in the API's package.json, or null when it cannot be read. */
export const API_VERSION = readVersion();
