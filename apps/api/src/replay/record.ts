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
 * --commit is the commit of the code the run was made with; by default the checkout's HEAD, with
 * "-dirty" when the working tree has uncommitted changes.
 * The credentials the record is checked against are the environment's and those in
 * apps/api/.env, read here only for that check and never printed.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import Database from "better-sqlite3";
import dotenv from "dotenv";
import { API_ROOT } from "../config/apiPackage.js";
import { checkoutCommit } from "../config/checkoutCommit.js";
import { knownSecrets } from "../llm/cassette.js";
import { getDefaultDbPath } from "../store/database.js";
import { getRun, listRunEvents } from "../store/runs.js";
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

export function main(argv: string[]): number {
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
    run = getRun(db, values.run);
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

  let commit = values.commit ?? "";
  if (!commit) {
    try {
      commit = checkoutCommit();
    } catch {
      console.error("Could not read the checkout's commit; pass --commit");
      return 1;
    }
  }

  const secrets = knownSecrets({ ...settingsFileValues(), ...process.env });
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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
