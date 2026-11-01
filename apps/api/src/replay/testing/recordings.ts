/**
 * The committed showcase recordings (fixtures/replays/<slug>.json), read for tests: one by its
 * slug, or every one, so a check about what a recording shows runs on each showcase track.
 *
 * A test about a result stored before a later fix (for instance before one claim per fact) reads
 * the pinned One More Time recording instead (`pinnedRecord`): a byte-for-byte copy of that
 * showcase as recorded at commit 98e88946b9b5, in fixtures/pinned/98e88946b9b5 under its own
 * slug. It is outside the replay directory, so it is never served unless a test points
 * REPLAY_DIR at PINNED_DIR, and a re-record of the showcase leaves what those tests are about in
 * place.
 *
 * The same holds for the four showcases served until the showcase was recorded from the golden
 * run (Bitter Sweet Symphony, Hung Up, Juicy and One More Time): a test about the exact text one
 * of them holds reads it from fixtures/pinned/9971adea845d (`PREVIOUS_SHOWCASES_DIR`,
 * `previousShowcase`), byte-for-byte copies of fixtures/replays at commit 9971adea845d. The
 * agent evals' perturbation set is generated from them too (evals/agent/make-perturb.mjs).
 */

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ReplayRecord } from "@liner-notes/contract";
import { API_ROOT } from "../../config/apiPackage.js";
import { DEFAULT_REPLAY_DIR } from "../records.js";

/** The first showcase: the recording the README, the demo and most specs open. */
export const DEMO_SLUG = "one-more-time-daft-punk";

/** The slug of every committed recording in `dir`, in order. */
export function recordingSlugs(dir: string = DEFAULT_REPLAY_DIR): string[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => file.slice(0, -".json".length))
    .sort();
}

/** The committed recording `<slug>.json` in `dir`, checked against the contract's schema. */
export function readRecording(slug: string = DEMO_SLUG, dir: string = DEFAULT_REPLAY_DIR) {
  return ReplayRecord.parse(JSON.parse(readFileSync(resolve(dir, `${slug}.json`), "utf8")));
}

/**
 * A replay directory holding the One More Time recording made at 98e88946b9b5, before one claim
 * per fact (#216): fixtures/pinned/98e88946b9b5 at the repository root.
 */
export const PINNED_DIR = resolve(API_ROOT, "..", "..", "fixtures", "pinned", "98e88946b9b5");

/** The pinned One More Time recording (see the header). */
export const pinnedRecord = (): ReplayRecord => readRecording(DEMO_SLUG, PINNED_DIR);

/**
 * The four showcases served before the golden run's (see the header): fixtures/pinned/9971adea845d
 * at the repository root.
 */
export const PREVIOUS_SHOWCASES_DIR = resolve(
  API_ROOT,
  "..",
  "..",
  "fixtures",
  "pinned",
  "9971adea845d",
);

/** One of the four showcases served before the golden run's, by its slug then. */
export const previousShowcase = (slug: string): ReplayRecord =>
  readRecording(slug, PREVIOUS_SHOWCASES_DIR);
