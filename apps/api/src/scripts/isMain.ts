import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The real path of `path`, or null when it cannot be resolved (it does not exist). */
function realPath(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Whether the module whose `import.meta` is `meta` is the script node was started with. Node
 * says so itself (`import.meta.main`, from Node 24.2); before, the script (`argv[1]`) is
 * compared with the module as real paths, with `.js` added when it names no file, as node does
 * for `node dist/report`. Either way a script started through a symbolic link (a linked
 * checkout, or a link to dist/) or without its extension still runs.
 */
export function isMainModule(
  meta: { url: string; main?: boolean },
  argv: readonly string[] = process.argv,
): boolean {
  if (typeof meta.main === "boolean") return meta.main;
  const script = argv[1];
  if (!script) return false;
  const self = realPath(fileURLToPath(meta.url));
  const started = realPath(resolve(script)) ?? realPath(`${resolve(script)}.js`);
  return self !== null && started === self;
}
