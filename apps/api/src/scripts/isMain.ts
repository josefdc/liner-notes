import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The real path of `path`, or `path` itself when it cannot be resolved (it does not exist). */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Whether the module at `moduleUrl` (its `import.meta.url`) is the script node was started
 * with (`argv[1]`). Both are compared as real paths, so a script started through a symbolic
 * link (a linked checkout, or a link to dist/) still runs.
 */
export function isMainModule(moduleUrl: string, argv: readonly string[] = process.argv): boolean {
  const script = argv[1];
  if (!script) return false;
  return realPath(resolve(script)) === realPath(fileURLToPath(moduleUrl));
}
