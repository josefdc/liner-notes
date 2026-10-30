// The database and spend log steps of backup.sh and restore.sh. It runs inside a throwaway
// container of the API image (node and better-sqlite3, as the API's user), never on the host:
//
//   node backup-ops.cjs snapshot <out>  a consistent copy of /app/data/sonic-agent.db (VACUUM
//                                       INTO, a single read transaction, while the API runs) and
//                                       of /app/spend/llm-spend.jsonl when it exists, into <out>
//   node backup-ops.cjs verify <dir>    PRAGMA integrity_check on <dir>/sonic-agent.db, and every
//                                       line of <dir>/llm-spend.jsonl (if any) parsed as JSON
//   node backup-ops.cjs install <dir>   with the API stopped: <dir>/sonic-agent.db replaces the
//                                       database; the spend log is copied only when the volume
//                                       has none (an older log would undercount the spending)
//
// Messages go to stderr: backup.sh streams the archive on stdout.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

// better-sqlite3 as the API itself resolves it (/app/apps/api in the image).
const Database = createRequire("/app/apps/api/package.json")("better-sqlite3");

const DB = "/app/data/sonic-agent.db";
const SPEND = "/app/spend/llm-spend.jsonl";
const DB_NAME = "sonic-agent.db";
const SPEND_NAME = "llm-spend.jsonl";

function say(message) {
  process.stderr.write(`${message}\n`);
}

function fail(message) {
  say(`error: ${message}`);
  process.exit(1);
}

/** The lines of a spend log that do not parse as a JSON object (1-based numbers). */
function badSpendLines(text) {
  const bad = [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  lines.forEach((line, i) => {
    try {
      const value = JSON.parse(line);
      if (value === null || typeof value !== "object" || Array.isArray(value)) bad.push(i + 1);
    } catch {
      bad.push(i + 1);
    }
  });
  return { count: lines.length, bad };
}

/** integrity_check, the schema version and the number of tables of a database file. */
function checkDatabase(file) {
  const db = new Database(file, { fileMustExist: true });
  try {
    const result = db
      .pragma("integrity_check", { simple: false })
      .map((row) => row.integrity_check);
    if (result.length !== 1 || result[0] !== "ok") {
      fail(`integrity_check on ${path.basename(file)}: ${result.slice(0, 5).join("; ")}`);
    }
    const version = db.pragma("user_version", { simple: true });
    const tables = db
      .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'")
      .get().n;
    return { version, tables };
  } finally {
    db.close();
  }
}

function snapshot(out) {
  fs.mkdirSync(out, { recursive: true });
  if (!fs.existsSync(DB)) fail(`${DB} does not exist (has the API ever started on this volume?)`);
  const target = path.join(out, DB_NAME);
  // Opened as the API opens it; VACUUM INTO reads one consistent snapshot, whatever the API
  // writes meanwhile, and waits up to 15 s for a lock.
  const db = new Database(DB, { fileMustExist: true, timeout: 15000 });
  try {
    db.exec(`VACUUM INTO '${target}'`);
  } finally {
    db.close();
  }
  // A single file: the copy needs no -wal next to it.
  const copy = new Database(target, { fileMustExist: true });
  copy.pragma("journal_mode = DELETE");
  copy.close();
  const { version, tables } = checkDatabase(target);
  say(`database: integrity ok, schema version ${version}, ${tables} tables`);

  if (!fs.existsSync(SPEND)) {
    say("spend log: none on the volume");
    return;
  }
  // The log only grows, a line at a time. A copy that ends inside a line caught an append in
  // progress: read it again.
  let text = "";
  let check = { count: 0, bad: [] };
  for (let attempt = 0; attempt < 20; attempt++) {
    text = fs.readFileSync(SPEND, "utf8");
    check = badSpendLines(text);
    if (check.bad.length === 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  fs.writeFileSync(path.join(out, SPEND_NAME), text, { mode: 0o600 });
  if (check.bad.length > 0) {
    say(
      `warning: the spend log has malformed lines (${check.bad.slice(0, 5).join(", ")}); copied as is`,
    );
  }
  say(`spend log: ${check.count} lines`);
}

function verify(dir) {
  const { version, tables } = checkDatabase(path.join(dir, DB_NAME));
  say(`database: integrity ok, schema version ${version}, ${tables} tables`);
  const spend = path.join(dir, SPEND_NAME);
  if (!fs.existsSync(spend)) {
    say("spend log: not in this backup");
    return;
  }
  const check = badSpendLines(fs.readFileSync(spend, "utf8"));
  if (check.bad.length > 0) fail(`spend log: malformed lines ${check.bad.slice(0, 5).join(", ")}`);
  say(`spend log: ${check.count} lines, all valid`);
}

function install(dir) {
  verify(dir);
  // Written next to the database, then renamed over it. The old database's -wal and -shm go
  // first: SQLite would otherwise apply the old log to the new file.
  const temp = `${DB}.restoring`;
  fs.copyFileSync(path.join(dir, DB_NAME), temp);
  const fd = fs.openSync(temp, "r+");
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${DB}${suffix}`, { force: true });
  fs.renameSync(temp, DB);
  say(`database: restored to ${DB}`);

  const spend = path.join(dir, SPEND_NAME);
  if (!fs.existsSync(spend)) return;
  if (fs.existsSync(SPEND)) {
    say(`spend log: kept the one on the volume (${SPEND}); the backup's copy was not restored`);
    return;
  }
  fs.copyFileSync(spend, SPEND, fs.constants.COPYFILE_EXCL);
  say(`spend log: restored to ${SPEND}`);
}

const [command, dir] = process.argv.slice(2);
if (!dir) fail("usage: backup-ops.cjs snapshot|verify|install <dir>");
if (command === "snapshot") snapshot(dir);
else if (command === "verify") verify(dir);
else if (command === "install") install(dir);
else fail(`unknown command ${command}`);
