// The database and spend log steps of backup.sh and restore.sh. It runs inside a throwaway
// container of the API image (node and better-sqlite3, as the API's user), never on the host:
//
//   node backup-ops.cjs snapshot <out>  a consistent copy of /app/data/sonic-agent.db (VACUUM
//                                       INTO, one read transaction, while the API runs) and of
//                                       /app/spend/llm-spend.jsonl when it exists, into <out>;
//                                       fails when the copy does not pass `verify`. A spend log
//                                       that breaks the API's rules is kept as
//                                       llm-spend.jsonl.invalid, which no restore applies
//   node backup-ops.cjs copy <out>      the files as they are (database, its -wal and -shm, spend
//                                       log), for the copy restore.sh takes with the API stopped
//   node backup-ops.cjs verify <dir>    <dir>/sonic-agent.db (with any -wal beside it applied)
//                                       passes PRAGMA integrity_check, and every line of
//                                       <dir>/llm-spend.jsonl, if any, is a spend record by the
//                                       API's rules (apps/api/src/llm/spendLog.ts)
//   node backup-ops.cjs install <dir>   with every container using the volumes stopped: the
//                                       database of <dir> replaces the volume's, and the spend
//                                       logs are merged (below)
//   node backup-ops.cjs total <log>     the log's records and USD total, as the API counts them
//   node backup-ops.cjs repair-tail <log>  with the API stopped: moves the last line to <log>.torn
//                                       when it is not a valid record (a write cut by a crash),
//                                       as the API's repairTornTail does
//   node backup-ops.cjs place <log>     with the API stopped and no log at <log>: writes the log
//                                       on stdin there, its last line moved aside as above
//
// Spend logs are merged, never replaced by a shorter one: the volume's log keeps every line, and
// the backup's records it lacks are appended. The API sums the records in any order (a settle
// line replaces the reservation with its id), so the merged log is never below the spend either
// log records.
//
// Messages go to stderr: backup.sh streams the archive on stdout.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");

// better-sqlite3 as the API itself resolves it (/app/apps/api in the image), loaded when a
// command needs it.
let sqlite = null;
function openDatabase(file, options) {
  sqlite ??= createRequire("/app/apps/api/package.json")("better-sqlite3");
  return new sqlite(file, options);
}

const DATA = "/app/data";
const DB = `${DATA}/sonic-agent.db`;
const SPEND = "/app/spend/llm-spend.jsonl";
const DB_NAME = "sonic-agent.db";
const SPEND_NAME = "llm-spend.jsonl";
const INVALID_NAME = `${SPEND_NAME}.invalid`;

function say(message) {
  process.stderr.write(`${message}\n`);
}

function fail(message) {
  say(`error: ${message}`);
  process.exit(1);
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function fsyncPath(file) {
  const fd = fs.openSync(file, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Why one line is not a spend record (the API's parseLine), or null. */
function lineProblem(row) {
  let line;
  try {
    line = JSON.parse(row);
  } catch {
    return "not JSON";
  }
  if (!line || typeof line !== "object" || Array.isArray(line)) return "not an object";
  if (typeof line.usd_est !== "number" || !Number.isFinite(line.usd_est) || line.usd_est < 0) {
    return "usd_est is not an amount";
  }
  if (typeof line.ts !== "string" || Number.isNaN(Date.parse(line.ts))) return "ts is not a date";
  if (line.kind !== undefined && line.kind !== "reserve" && line.kind !== "settle") {
    return "unknown kind";
  }
  if (line.kind !== undefined && typeof line.id !== "string") return "no id";
  return null;
}

/**
 * The records of a spend log (blank lines skipped, as the API skips them), their USD total as
 * the API counts it, and the first malformed line, if any.
 */
function readSpend(text) {
  const records = [];
  let bad = null;
  let badRow = -1;
  const rows = text.split("\n");
  rows.forEach((row, index) => {
    if (row.trim() === "") return;
    const problem = lineProblem(row);
    if (problem && !bad) {
      bad = `line ${index + 1} (${problem})`;
      badRow = index;
    }
    if (!problem) records.push(row);
  });
  // The only malformed line is the last one, with no newline after it: an append in progress.
  const torn = bad !== null && badRow === rows.length - 1;
  const lines = records.map((row) => JSON.parse(row));
  const settled = new Set(lines.filter((l) => l.kind === "settle").map((l) => l.id));
  const usd = lines
    .filter((l) => !(l.kind === "reserve" && settled.has(l.id)))
    .reduce((sum, l) => sum + l.usd_est, 0);
  return { records, usd, bad, torn };
}

/**
 * The records of `theirs` to append to `mine` so that the result counts all that either log
 * counts. A record with an id (every line the API writes: reserve and settle) is the same record
 * wherever it appears, so it is added when `mine` lacks it. Identical lines without an id
 * (written by hand) cannot be told apart: each is kept as many times as the log with more of them
 * holds it. Merging the same backup again adds nothing.
 */
function missingRecords(mine, theirs) {
  const count = new Map();
  for (const row of mine) count.set(row, (count.get(row) ?? 0) + 1);
  const missing = [];
  for (const row of theirs) {
    const left = count.get(row) ?? 0;
    if (left > 0) count.set(row, left - 1);
    else missing.push(row);
  }
  return missing;
}

function describeSpend(spend) {
  return `${spend.records.length} records, USD ${spend.usd.toFixed(4)} counted`;
}

/** Checkpoints any -wal beside the database at `file` into it, and leaves it a single file. */
function settle(file) {
  const db = openDatabase(file, { fileMustExist: true, timeout: 15000 });
  try {
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.pragma("journal_mode = DELETE");
  } finally {
    db.close();
  }
}

/** Fails unless the database at `file` passes integrity_check. */
function checkDatabase(file) {
  let result;
  let version;
  let tables;
  try {
    settle(file);
    const db = openDatabase(file, { fileMustExist: true });
    try {
      result = db.pragma("integrity_check", { simple: false }).map((row) => row.integrity_check);
      version = db.pragma("user_version", { simple: true });
      tables = db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type = 'table'").get().n;
    } finally {
      db.close();
    }
  } catch (error) {
    fail(`${path.basename(file)} cannot be read: ${error.message}`);
  }
  if (result.length !== 1 || result[0] !== "ok") {
    fail(`integrity_check on ${path.basename(file)}: ${result.slice(0, 5).join("; ")}`);
  }
  say(`database: integrity ok, schema version ${version}, ${tables} tables`);
}

function verify(dir) {
  const file = path.join(dir, DB_NAME);
  if (!fs.existsSync(file)) fail(`no ${DB_NAME} in the backup`);
  checkDatabase(file);
  const spendFile = path.join(dir, SPEND_NAME);
  if (!fs.existsSync(spendFile)) {
    say(
      fs.existsSync(path.join(dir, INVALID_NAME))
        ? `spend log: not in this backup (one that broke the API's rules is in ${INVALID_NAME})`
        : "spend log: not in this backup",
    );
    return null;
  }
  const spend = readSpend(fs.readFileSync(spendFile, "utf8"));
  if (spend.bad) fail(`spend log: ${spend.bad} is not a spend record`);
  say(`spend log: ${describeSpend(spend)}, all valid`);
  return spend;
}

function snapshot(out) {
  fs.mkdirSync(out, { recursive: true });
  if (!fs.existsSync(DB)) fail(`${DB} does not exist (has the API ever started on this volume?)`);
  const target = path.join(out, DB_NAME);
  // Opened as the API opens it; VACUUM INTO reads one consistent snapshot, whatever the API
  // writes meanwhile, and waits up to 15 s for a lock. It copies a damaged index as it is, so
  // the copy is checked below.
  try {
    const db = openDatabase(DB, { fileMustExist: true, timeout: 15000 });
    try {
      db.exec(`VACUUM INTO '${target}'`);
    } finally {
      db.close();
    }
  } catch (error) {
    fail(`the database on the volume cannot be copied: ${error.message}`);
  }

  if (fs.existsSync(SPEND)) {
    // The log only grows, a line at a time: a copy that ends inside a line caught an append in
    // progress, so it is read again (for up to 30 s). A log that still breaks the API's rules
    // (a line cut by a crash, or a malformed one) does not stop the database's backup: it is
    // kept under a name no restore applies, and backup.sh fails the run.
    let text = "";
    let spend = null;
    for (let attempt = 0; attempt < 120; attempt++) {
      text = fs.readFileSync(SPEND, "utf8");
      spend = readSpend(text);
      if (!spend.torn) break;
      if (attempt === 0) say("spend log: an append was in progress; reading it again");
      sleep(250);
    }
    if (spend.bad) {
      const cut = spend.torn ? ", the last one, cut short (a crash during an append?)" : "";
      say(`spend log: INVALID: ${spend.bad}${cut} breaks the API's rules; kept as ${INVALID_NAME}`);
      fs.writeFileSync(path.join(out, INVALID_NAME), text, { mode: 0o600 });
    } else {
      fs.writeFileSync(path.join(out, SPEND_NAME), text, { mode: 0o600 });
    }
  } else {
    say("spend log: none on the volume");
  }
  verify(out);
}

function copy(out) {
  fs.mkdirSync(out, { recursive: true });
  const files = [DB, `${DB}-wal`, `${DB}-shm`, SPEND].filter((file) => fs.existsSync(file));
  for (const file of files) fs.copyFileSync(file, path.join(out, path.basename(file)));
  say(files.length ? `copied as they are: ${files.join(", ")}` : "nothing on the volumes to copy");
}

function install(dir) {
  let spend = verify(dir);
  try {
    fs.accessSync(path.dirname(SPEND), fs.constants.W_OK);
  } catch {
    if (spend) say("warning: no spend log volume is mounted; the backup's spend log is left out");
    spend = null;
  }
  if (!spend) say("spend log: the volume's is left as it is");

  // The spend log to write, worked out before anything changes.
  let spendText = null;
  if (spend && !fs.existsSync(SPEND)) {
    spendText = spend.records.map((row) => `${row}\n`).join("");
    say("spend log: none on the volume; the backup's is restored");
  } else if (spend) {
    const current = fs.readFileSync(SPEND, "utf8");
    const mine = readSpend(current);
    if (mine.bad) fail(`the spend log on the volume has a malformed ${mine.bad}; nothing changed`);
    const missing = missingRecords(mine.records, spend.records);
    if (missing.length === 0) {
      say(`spend log: the volume's (${describeSpend(mine)}) holds every record of the backup's`);
    } else {
      const sep = current === "" || current.endsWith("\n") ? "" : "\n";
      spendText = `${current}${sep}${missing.map((row) => `${row}\n`).join("")}`;
      say(
        `spend log: merged, ${missing.length} records of the backup's added to the volume's ` +
          `(${describeSpend(mine)} before, ${describeSpend(readSpend(spendText))} now)`,
      );
    }
  }

  // The old database first takes in what its -wal holds (when it can still be read), so no
  // committed write lives only in a file about to be removed; restore.sh has copied them all.
  if (fs.existsSync(DB)) {
    try {
      settle(DB);
    } catch (error) {
      say(`warning: the old database could not be checkpointed (${error.message})`);
    }
  }
  // Written next to the database and renamed over it. Any -wal and -shm left go before the
  // rename: SQLite would otherwise apply an old log to the new file.
  const temp = `${DB}.restoring`;
  fs.copyFileSync(path.join(dir, DB_NAME), temp);
  fsyncPath(temp);
  for (const suffix of ["-wal", "-shm"]) fs.rmSync(`${DB}${suffix}`, { force: true });
  fs.renameSync(temp, DB);
  fsyncPath(DATA);
  say(`database: restored to ${DB}`);

  if (spendText !== null) {
    const spendTemp = `${SPEND}.restoring`;
    fs.writeFileSync(spendTemp, spendText, { mode: 0o600 });
    fsyncPath(spendTemp);
    fs.renameSync(spendTemp, SPEND);
    fsyncPath(path.dirname(SPEND));
    say(`spend log: written to ${SPEND}`);
  }
}

function total(file) {
  if (!fs.existsSync(file)) fail(`no spend log at ${file}`);
  const spend = readSpend(fs.readFileSync(file, "utf8"));
  say(`spend log: ${describeSpend(spend)}`);
  if (spend.bad) fail(`spend log: ${spend.bad} is not a spend record; the API refuses the log`);
}

/**
 * The API's repairTornTail (apps/api/src/llm/spendLog.ts) on a log's text: the part to keep and
 * the last line to move aside, or null when that line is a valid record (or there is none).
 */
function tornTail(text) {
  const body = text.replace(/\n+$/, "");
  const cut = body.lastIndexOf("\n") + 1;
  const lastLine = body.slice(cut);
  if (body === "" || lineProblem(lastLine) === null) return null;
  return { keep: text.slice(0, cut), lastLine, bytes: Buffer.byteLength(text.slice(cut), "utf8") };
}

function moveAside(file, tail) {
  fs.appendFileSync(
    `${file}.torn`,
    `# ${new Date().toISOString()} last line (${tail.bytes} bytes) moved from the spend log by hand\n${tail.lastLine}\n`,
  );
  say(`spend log: moved the last line (${tail.bytes} bytes), not a valid record, to ${file}.torn`);
}

function repairTail(file) {
  if (!fs.existsSync(file)) fail(`no spend log at ${file}`);
  const tail = tornTail(fs.readFileSync(file, "utf8"));
  if (!tail) {
    say("spend log: its last line is a valid record (or it is empty); nothing moved");
  } else {
    moveAside(file, tail);
    fs.truncateSync(file, Buffer.byteLength(tail.keep, "utf8"));
  }
  const spend = readSpend(fs.readFileSync(file, "utf8"));
  if (spend.bad)
    fail(`spend log: ${spend.bad} is still not a spend record: fix or remove it by hand`);
  say(`spend log: ${describeSpend(spend)}, all valid`);
}

/**
 * Puts the log on stdin (a backup's llm-spend.jsonl.invalid, say) where there is none: its last
 * line moved aside first when it is not a valid record, as repairTail does; any other malformed
 * line refuses it.
 */
function place(file) {
  if (fs.existsSync(file))
    fail(`${file} exists; place only fills a volume with none (repair-tail repairs one)`);
  const text = fs.readFileSync(0, "utf8");
  const tail = tornTail(text);
  const keep = tail ? tail.keep : text;
  const spend = readSpend(keep);
  if (spend.bad)
    fail(
      `spend log: ${spend.bad} is not a spend record: fix or remove it by hand; nothing changed`,
    );
  const temp = `${file}.placing`;
  fs.writeFileSync(temp, keep, { mode: 0o600 });
  fsyncPath(temp);
  try {
    fs.linkSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
  if (tail) moveAside(file, tail);
  fsyncPath(path.dirname(file));
  say(`spend log: placed at ${file}, ${describeSpend(spend)}, all valid`);
}

const [command, dir] = process.argv.slice(2);
if (!dir)
  fail("usage: backup-ops.cjs snapshot|copy|verify|install <dir> | total|repair-tail <log>");
if (command === "snapshot") snapshot(dir);
else if (command === "copy") copy(dir);
else if (command === "verify") verify(dir);
else if (command === "install") install(dir);
else if (command === "total") total(dir);
else if (command === "repair-tail") repairTail(dir);
else if (command === "place") place(dir);
else fail(`unknown command ${command}`);
