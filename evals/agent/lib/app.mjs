// The app's own TypeScript modules, loaded with tsx, so the harness uses the app's rules (the
// spend log's sums, the numeric check, the judge, the composer prompt) instead of copies of them.
// Needs the contract package built (npm run build -w packages/contract), as the API does.
//
// Every module is loaded in one tsx namespace, so modules imported one after another share their
// dependencies (one settings module, one model layer, one copy of the contract's schemas).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { REPO_ROOT } from "./golden.mjs";

export const CONTRACT_DIST = join(REPO_ROOT, "packages/contract/dist/index.js");

/** Fails when the contract package is not built (the app's modules import it). */
export function requireContract() {
  if (!existsSync(CONTRACT_DIST)) {
    throw new Error("packages/contract is not built: run `npm run build -w packages/contract`");
  }
}

let scope;

/** One of the app's modules, by its path from the repository root. */
export async function importApp(path) {
  requireContract();
  if (!scope) {
    const { register } = await import("tsx/esm/api");
    scope = register({ namespace: "liner-notes-evals" });
  }
  return scope.import(pathToFileURL(join(REPO_ROOT, path)).href, import.meta.url);
}
