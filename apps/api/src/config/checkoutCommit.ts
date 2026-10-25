/**
 * The commit of the code running, read from the checkout: HEAD (12 characters), with "-dirty"
 * when the working tree has uncommitted changes (untracked files included), so a recording never
 * names a commit that does not hold exactly the code it ran with. Recordings (replay records,
 * LLM cassettes) are made from a checkout; a deployed image has no repository, and its runs say
 * null (unknown), never a guess.
 *
 * Recorded artefacts (`exclude`: the cassette and replay directories) do not make the code
 * dirty: otherwise every recording would make each later run "-dirty".
 *
 * git runs at the checkout itself, with a minimal environment (PATH, HOME, LANG: no GIT_*
 * variable, so another repository is never read, and no credentials), a timeout, and settings
 * that make it report every change whatever the user's configuration says (untracked files
 * shown, no global excludes file, submodules counted, no fsmonitor hook). It takes no optional
 * locks, so a concurrent git command in the same checkout is not disturbed.
 */

import { execFileSync } from "node:child_process";
import { isAbsolute, join, relative, resolve } from "node:path";
import { API_ROOT } from "./apiPackage.js";

/** Longest a git command may take before the commit counts as unknown. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * Where recordings are written, by default and as configured: LLM and source cassettes
 * (apps/api/cassettes, LLM_CASSETTE_DIR, SOURCE_CASSETTE_DIR) and replay records
 * (fixtures/replays, REPLAY_DIR). Relative settings are taken from the API package.
 */
export function recordingDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const configured = [env.LLM_CASSETTE_DIR, env.SOURCE_CASSETTE_DIR, env.REPLAY_DIR]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value))
    .map((value) => resolve(API_ROOT, value));
  return [
    join(API_ROOT, "cassettes"),
    resolve(API_ROOT, "..", "..", "fixtures", "replays"),
    ...configured,
  ];
}

export interface CheckoutCommitOptions {
  /** Directories whose changes do not count as changes to the code (absolute paths). */
  exclude?: readonly string[];
}

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { GIT_OPTIONAL_LOCKS: "0" };
  for (const name of ["PATH", "HOME", "LANG"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  return env;
}

/** Settings that would hide a change, set so that none is hidden. */
const REPORT_EVERY_CHANGE = [
  "-c",
  "status.showUntrackedFiles=normal",
  "-c",
  "core.excludesFile=",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "diff.ignoreSubmodules=none",
];

/** The checkout's commit; throws when git or the repository cannot be read. */
export function checkoutCommit(
  cwd: string = API_ROOT,
  { exclude = recordingDirs() }: CheckoutCommitOptions = {},
): string {
  const env = gitEnv();
  const git = (...args: string[]) =>
    execFileSync("git", ["--no-optional-locks", ...REPORT_EVERY_CHANGE, ...args], {
      cwd,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  const head = git("rev-parse", "--short=12", "HEAD");
  const top = git("rev-parse", "--show-toplevel");
  const excluded = exclude
    .map((dir) => relative(top, dir))
    .filter((path) => path !== "" && !path.startsWith("..") && !isAbsolute(path))
    .map((path) => `:(top,exclude)${path.split("\\").join("/")}`);
  const status = git(
    "status",
    "--porcelain",
    "--untracked-files=normal",
    "--ignore-submodules=none",
    "--",
    ":(top)",
    ...excluded,
  );
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
 * The commit of the code this process runs, read once: when the analysis routes are loaded (at
 * server start), or at the first recording of a process without them. Stored with each run the
 * server starts, and recorded with each cassette.
 */
export function runningCommit(): string | null {
  running ??= { value: checkoutCommitOrNull() };
  return running.value;
}
