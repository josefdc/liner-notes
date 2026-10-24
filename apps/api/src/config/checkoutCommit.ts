/**
 * The commit of the code running, read from the checkout: HEAD (12 characters), with "-dirty"
 * when the working tree has uncommitted changes (untracked files included), so a recording never
 * names a commit that does not hold exactly the code it ran with. Recordings (replay records,
 * LLM cassettes) are made from a checkout; a deployed image has no repository, and its runs say
 * null (unknown), never a guess.
 *
 * Recorded artefacts (`exclude`, by default apps/api/cassettes) do not make the code dirty: a
 * session that records cassettes would otherwise make every later one "-dirty".
 *
 * git runs at the checkout itself: GIT_DIR, GIT_WORK_TREE and the other GIT_* variables a hook
 * or a shell may have exported are dropped, so another repository is never read, and it takes
 * no optional locks, so a concurrent git command in the same checkout is not disturbed.
 */

import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative } from "node:path";
import { API_ROOT } from "./apiPackage.js";

/** Where recorded cassettes live by default (LLM and source cassettes). */
export const DEFAULT_RECORDING_DIRS = [join(API_ROOT, "cassettes")];

export interface CheckoutCommitOptions {
  /** Directories whose changes do not count as changes to the code (absolute paths). */
  exclude?: readonly string[];
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("GIT_")) env[name] = value;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

/** The checkout's commit; throws when git or the repository cannot be read. */
export function checkoutCommit(
  cwd: string = API_ROOT,
  { exclude = DEFAULT_RECORDING_DIRS }: CheckoutCommitOptions = {},
): string {
  const env = gitEnv();
  const git = (...args: string[]) =>
    execFileSync("git", ["--no-optional-locks", ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const head = git("rev-parse", "--short=12", "HEAD");
  const top = git("rev-parse", "--show-toplevel");
  const excluded = exclude
    .map((dir) => relative(top, dir))
    .filter((path) => path !== "" && !path.startsWith("..") && !isAbsolute(path))
    .map((path) => `:(top,exclude)${path.split("\\").join("/")}`);
  const status = git("status", "--porcelain", "--", ":(top)", ...excluded);
  return status === "" ? head : `${head}-dirty`;
}

/** The checkout's commit, or null when it cannot be read (unknown, never guessed). */
export function checkoutCommitOrNull(
  cwd: string = API_ROOT,
  options: CheckoutCommitOptions = {},
): string | null {
  try {
    return checkoutCommit(cwd, options);
  } catch {
    return null;
  }
}

let running: { value: string | null } | null = null;

/**
 * The commit of the code this process runs, read once (when the analysis routes are loaded, at
 * server start) and stored with each run the server starts.
 */
export function runningCommit(): string | null {
  running ??= { value: checkoutCommitOrNull() };
  return running.value;
}
