/**
 * The commit of the code running, read from the checkout: HEAD (12 characters), with "-dirty"
 * when the working tree has uncommitted changes, so a recording never names a commit that does
 * not hold exactly the code it ran with. Recordings (replay records, LLM cassettes) are made
 * from a checkout, never from a deployed image.
 */

import { execFileSync } from "node:child_process";
import { API_ROOT } from "./apiPackage.js";

/** The checkout's commit; throws when git or the repository cannot be read. */
export function checkoutCommit(cwd: string = API_ROOT): string {
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  const head = git("rev-parse", "--short=12", "HEAD");
  return git("status", "--porcelain") === "" ? head : `${head}-dirty`;
}

/** The checkout's commit, or null when it cannot be read (unknown, never guessed). */
export function checkoutCommitOrNull(cwd: string = API_ROOT): string | null {
  try {
    return checkoutCommit(cwd);
  } catch {
    return null;
  }
}
