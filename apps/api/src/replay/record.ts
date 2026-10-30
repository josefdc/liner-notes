/**
 * Records a stored live run as a replay record:
 *
 *   npm run replay:record -w apps/api -- --run <run id> --slug <slug> [--commit <sha>]
 *     [--out <dir>] [--force] [--allow-dirty] [--allow-moved]
 *
 * Reads the run and its events from the database (SQLITE_DB_PATH, as the API does; read-only),
 * builds the record (recorder.ts: scrubbed, then checked) and writes `<out>/<slug>.json` (default
 * out: the replay directory, fixtures/replays). Nothing is written when the run cannot be
 * recorded or the record still holds anything it must not; an existing file is kept unless
 * --force is given.
 *
 * The record names the commit the run ran at, which the server stored with the run (see
 * recordCommit). --commit is needed only for a run stored without one, and must match otherwise.
 * It is recorded from a checkout at that commit: one checked out at another commit is refused
 * unless --allow-moved (recordCommit).
 *
 * A record comes from a clean commit: one whose run ran from a working tree with uncommitted
 * changes (its commit ends in "-dirty"), or made while the checkout has them or its commit
 * cannot be read (the same checkoutCommit the server stamps on its runs), is refused
 * (cleanCommit). --allow-dirty records it anyway for a local experiment, stamped "-dirty", so the
 * committed recordings' own check (demo-recording.test.ts) still refuses it.
 *
 * A web search page's excerpt that holds a long token-shaped run is recorded, whole, as
 * "[excerpt withheld: it held a token-shaped run]" (recorder.ts `withoutPageTokens`), in every
 * place its item appears, with the item's title, url and source kept; one that also holds a
 * configured credential or a part of one, another secret shape, or a link with a secret, or that
 * a claim or a map link cites, is refused instead. The recorder prints which items it withheld
 * and how many runs each held. The record itself says so only in that note (the replay format
 * has no other place for it): the commit that adds the recording names the items. Only web
 * search excerpts are withheld.
 *
 * The file is written as `JSON.stringify(record, null, 2)`. A committed recording is that file
 * formatted with Biome afterwards (`npx biome format --write fixtures/replays/<slug>.json`, as
 * `npm run lint` requires): only its whitespace changes, and its JSON content must be identical
 * to what the recorder wrote. To compare a rebuilt record with a committed one, compare the
 * parsed JSON, or format the rebuilt file the same way first.
 *
 * The credentials the record is checked against are the environment's and those in
 * apps/api/.env, read here only for that check and never printed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import { API_ROOT } from "../config/apiPackage.js";
import { checkoutCommitOrNull } from "../config/checkoutCommit.js";
import { knownSecrets } from "../llm/cassette.js";
import { isMainModule } from "../scripts/isMain.js";
import { getDefaultDbPath } from "../store/paths.js";
import { getRun, keepsRunCommits, listRunEvents } from "../store/runs.js";
import {
  buildRecord,
  COMMIT_PATTERN,
  RecordRefused,
  WITHHELD_EXCERPT,
  type WithheldExcerpt,
} from "./recorder.js";
import { replayDir } from "./records.js";

/** The settings file's values, for the credential check only; empty when there is none. */
function settingsFileValues(): NodeJS.ProcessEnv {
  const path = join(API_ROOT, ".env");
  if (!existsSync(path)) return {};
  try {
    return dotenv.parse(readFileSync(path));
  } catch {
    return {};
  }
}

/**
 * The commit a record names: the one the run ran at, as the server stored it with the run.
 *   - stored: that commit. A checkout now at another commit (its "-dirty" aside, which
 *     cleanCommit judges) is refused unless `allowMoved` (--allow-moved): the record is checked
 *     and written by the code checked out, and a commit stamped on it names the code that
 *     produced it only when the two are the same; with the flag it is recorded, with a warning
 *     (the record still names the run's commit). A --commit that differs is refused, since it
 *     would contradict it.
 *   - none stored (a run from before commits were kept, or a server that could not read its
 *     own): only an explicit --commit, which the person recording vouches for; never the
 *     checkout's, which may hold other code than the run did.
 */
export function recordCommit({
  stored,
  given,
  checkout,
  allowMoved = false,
}: {
  stored: string | null;
  given: string | null;
  checkout: string | null;
  allowMoved?: boolean;
}): { commit: string; warning?: string } | { refused: string } {
  if (given !== null && !COMMIT_PATTERN.test(given)) {
    return {
      refused: `--commit ${JSON.stringify(given)} is not a commit: give its hash (7 to 40 hex digits, "-dirty" allowed)`,
    };
  }
  if (stored) {
    if (given && given !== stored) {
      return {
        refused:
          `--commit ${given} differs from the commit the run ran at (${stored}), which the ` +
          "server stored with it; leave --commit out",
      };
    }
    if (checkout && withoutDirty(checkout) !== withoutDirty(stored)) {
      if (!allowMoved) {
        return {
          refused:
            `the checkout is at ${checkout}, not ${stored}, the commit the run ran at: check ` +
            `out ${withoutDirty(stored)} to record it, or pass --allow-moved to record it from ` +
            "this checkout (the record still names the run's commit)",
        };
      }
      return {
        commit: stored,
        warning: `the checkout is at ${checkout}; the record names ${stored}, the commit the run ran at`,
      };
    }
    return { commit: stored };
  }
  if (given) return { commit: given };
  return {
    refused:
      "The run has no stored commit (it ran before commits were kept, its server could not read " +
      "one, or it was resumed by a server at another commit); pass --commit with the commit it " +
      "ran at",
  };
}

/** What a refusal of a dirty tree says (the start of the message). */
export const DIRTY_REFUSAL =
  "commit or stash your changes; showcase recordings must come from a clean commit";

const DIRTY = "-dirty";

/** A commit without its "-dirty" mark. */
const withoutDirty = (commit: string) =>
  commit.endsWith(DIRTY) ? commit.slice(0, -DIRTY.length) : commit;

/**
 * The commit a record is stamped with, or why it is refused: `commit` (chosen by recordCommit)
 * ends in "-dirty" when the run ran from uncommitted changes, and `checkout` (the checkout's
 * commit now) when the recorder runs from them. A checkout whose commit cannot be read (null: no
 * repository, or git failed) may be dirty, and counts as such. Any of these is refused unless
 * `allowDirty`; then the stamp says "-dirty" whichever it was.
 */
export function cleanCommit({
  commit,
  checkout,
  allowDirty,
}: {
  commit: string;
  checkout: string | null;
  allowDirty: boolean;
}): { commit: string } | { refused: string } {
  const where = [
    ...(commit.endsWith(DIRTY) ? [`the run ran from uncommitted changes (${commit})`] : []),
    ...(checkout === null
      ? ["the checkout's commit cannot be read, so it may hold uncommitted changes"]
      : checkout.endsWith(DIRTY)
        ? [`the checkout has uncommitted changes (${checkout})`]
        : []),
  ];
  if (where.length === 0) return { commit };
  if (!allowDirty) {
    return {
      refused: `${DIRTY_REFUSAL}: ${where.join("; ")}. Pass --allow-dirty to record anyway for a local experiment (stamped "-dirty").`,
    };
  }
  return { commit: commit.endsWith(DIRTY) ? commit : `${commit}${DIRTY}` };
}

/**
 * The page excerpts the record withheld (recorder.ts `withoutPageTokens`), for the person
 * recording: which evidence items, and how many long token-shaped runs each held; null for none.
 */
export function withheldExcerptsLine(withheld: readonly WithheldExcerpt[]): string | null {
  if (withheld.length === 0) return null;
  const total = withheld.reduce((sum, item) => sum + item.runs, 0);
  const items = withheld.map(({ evidenceId, runs }) => `${evidenceId} (${runs})`).join(", ");
  const pages =
    withheld.length === 1 ? "the excerpt of 1 page" : `the excerpts of ${withheld.length} pages`;
  return (
    `Withheld ${pages}, which held ${total} long token-shaped ${total === 1 ? "run" : "runs"}, ` +
    `as "${WITHHELD_EXCERPT}": ${items}`
  );
}

export interface RecordDependencies {
  /** The settings file's values for the credential check (default: apps/api/.env). */
  settingsFileValues?: () => NodeJS.ProcessEnv;
  /** The checkout's commit now (default: read from git). */
  checkout?: () => string | null;
}

export function main(argv: string[], deps: RecordDependencies = {}): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      run: { type: "string" },
      slug: { type: "string" },
      commit: { type: "string" },
      out: { type: "string" },
      force: { type: "boolean", default: false },
      "allow-dirty": { type: "boolean", default: false },
      "allow-moved": { type: "boolean", default: false },
    },
  });
  if (!values.run || !values.slug) {
    console.error(
      "Usage: npm run replay:record -w apps/api -- --run <run id> --slug <slug> " +
        "[--commit <sha>] [--out <dir>] [--force] [--allow-dirty] [--allow-moved]",
    );
    return 2;
  }

  const dbPath = getDefaultDbPath();
  if (!existsSync(dbPath)) {
    console.error(`No database at ${dbPath} (set SQLITE_DB_PATH)`);
    return 1;
  }
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  let run: ReturnType<typeof getRun>;
  let events: ReturnType<typeof listRunEvents>;
  let otherRunIds: string[];
  try {
    // A database not yet migrated to keep commits (the API has not started since) has none.
    run = getRun(db, values.run, { withoutCommit: !keepsRunCommits(db) });
    events = run ? listRunEvents(db, values.run) : [];
    // Every other run's ids, which a record must not hold.
    otherRunIds = db
      .prepare(
        "SELECT run_id FROM runs WHERE run_id != ? UNION SELECT thread_id FROM runs WHERE run_id != ?",
      )
      .pluck()
      .all(values.run, values.run) as string[];
  } finally {
    db.close();
  }
  if (!run) {
    console.error(`No run ${values.run} in ${dbPath}`);
    return 1;
  }

  const checkout = (deps.checkout ?? checkoutCommitOrNull)();
  const chosen = recordCommit({
    stored: run.commit,
    given: values.commit?.trim() || null,
    checkout,
    allowMoved: values["allow-moved"] ?? false,
  });
  if ("refused" in chosen) {
    console.error(chosen.refused);
    return 1;
  }
  if (chosen.warning) console.warn(`Warning: ${chosen.warning}`);
  const clean = cleanCommit({
    commit: chosen.commit,
    checkout,
    allowDirty: values["allow-dirty"] ?? false,
  });
  if ("refused" in clean) {
    console.error(clean.refused);
    return 1;
  }
  const { commit } = clean;
  if (commit.endsWith(DIRTY))
    console.warn(`Warning: recorded from a dirty tree, stamped ${commit}`);

  const secrets = knownSecrets({
    ...(deps.settingsFileValues ?? settingsFileValues)(),
    ...process.env,
  });
  let record: ReturnType<typeof buildRecord>["record"];
  try {
    const built = buildRecord(run, events, { slug: values.slug, commit, secrets, otherRunIds });
    record = built.record;
    for (const warning of built.warnings) console.warn(`Warning: the result breaks ${warning}`);
    if (built.noCover) console.warn(`Warning: no cover kept: ${built.noCover}`);
    const withheld = withheldExcerptsLine(built.withheldExcerpts);
    if (withheld) console.log(withheld);
  } catch (err) {
    if (err instanceof RecordRefused) {
      console.error(err.message);
      return 1;
    }
    throw err;
  }

  const outDir = values.out ?? replayDir();
  const path = join(outDir, `${record.slug}.json`);
  if (existsSync(path) && !values.force) {
    console.error(`${path} exists; pass --force to replace it`);
    return 1;
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    `Recorded run ${values.run} as ${path}: ${record.events.length} events, ` +
      `recorded ${record.recordedAt} at ${record.commit}`,
  );
  return 0;
}

if (isMainModule(import.meta)) {
  process.exitCode = main(process.argv.slice(2));
}
