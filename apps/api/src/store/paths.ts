/**
 * Where the database file is. Kept apart from database.ts, so a command-line tool that only needs
 * the path (the report, the replay recorder) does not load the checkpoint saver with it.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The API package root: the nearest directory above this module with a package.json. */
export function apiPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/**
 * The database path: SQLITE_DB_PATH, or `data/sonic-agent.db` in the API package. A relative
 * SQLITE_DB_PATH is resolved against the API package root as well, so the file does not move
 * with the directory the server was started from.
 */
export function getDefaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SQLITE_DB_PATH?.trim();
  const root = apiPackageRoot();
  if (!configured) return join(root, "data", "sonic-agent.db");
  return isAbsolute(configured) ? configured : resolve(root, configured);
}
