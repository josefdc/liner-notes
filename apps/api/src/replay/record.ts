/**
 * Records a stored live run as a replay record:
 *
 *   npm run replay:record -w apps/api -- --run <run id> --slug <slug> [--commit <sha>]
 *     [--out <dir>] [--force]
 *
 * Reads the run and its events from the database (SQLITE_DB_PATH, as the API does; read-only),
 * builds the record (recorder.ts: scrubbed, then checked) and writes `<out>/<slug>.json` (default
 * out: the replay directory, fixtures/replays). Nothing is written when the run cannot be
 * recorded or the record still holds anything it must not; an existing file is kept unless
 * --force is given.
 *
 * The record names the commit the run ran at, which the server stored with the run (see
 * recordCommit). --commit is needed only for a run stored without one, and must match otherwise.
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
import { getDefaultDbPath } from "../store/database.js";
import { getRun, keepsRunCommits, listRunEvents } from "../store/runs.js";
import { buildRecord, RecordRefused } from "./recorder.js";
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

/** A commit hash as --commit takes it: 7 to 40 hex digits, "-dirty" when the tree had changes. */
const COMMIT_PATTERN = /^[0-9a-f]{7,40}(-dirty)?$/;

/**
 * The commit a record names: the one the run ran at, as the server stored it with the run.
 *   - stored: that commit. A checkout now at another commit gets a warning (the record still
 *     names the run's); a --commit that differs is refused, since it would contradict it.
 *   - none stored (a run from before commits were kept, or a server that could not read its
 *     own): only an explicit --commit, which the person recording vouches for; never the
 *     checkout's, which may hold other code than the run did.
 */
export function recordCommit({
  stored,
  given,
  checkout,
}: {
  stored: string | null;
  given: string | null;
  checkout: string | null;
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
    if (checkout && checkout !== stored) {
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
    },
  });
  if (!values.run || !values.slug) {
    console.error(
      "Usage: npm run replay:record -w apps/api -- --run <run id> --slug <slug> " +
        "[--commit <sha>] [--out <dir>] [--force]",
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

  const chosen = recordCommit({
    stored: run.commit,
    given: values.commit?.trim() || null,
    checkout: (deps.checkout ?? checkoutCommitOrNull)(),
  });
  if ("refused" in chosen) {
    console.error(chosen.refused);
    return 1;
  }
  if (chosen.warning) console.warn(`Warning: ${chosen.warning}`);
  const { commit } = chosen;

  const secrets = knownSecrets({
    ...(deps.settingsFileValues ?? settingsFileValues)(),
    ...process.env,
  });
  let record: ReturnType<typeof buildRecord>["record"];
  try {
    const built = buildRecord(run, events, { slug: values.slug, commit, secrets, otherRunIds });
    record = built.record;
    for (const warning of built.warnings) console.warn(`Warning: the result breaks ${warning}`);
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
