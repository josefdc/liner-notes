/**
 * Shared SQLite database (better-sqlite3), used by:
 *   - SqliteSaver (LangGraph checkpointer)
 *   - SqliteStore  (LangGraph BaseStore)
 *   - SonicCache   (typed audio/research/artwork caches)
 *   - runs         (one record per analysis run)
 *
 * Opening is careful about what it calls corruption. A database file is moved aside (renamed
 * `<file>.corrupt.<timestamp>`) only when SQLite reports SQLITE_CORRUPT or SQLITE_NOTADB, or
 * `PRAGMA quick_check` fails. Every other failure (a permission problem, a lock held by another
 * process, a native module built for another Node version, a missing native module) leaves the
 * file untouched and throws a DatabaseOpenError that says how to fix it.
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_SCHEMA_VERSION, runMigrations, SchemaTooNewError } from "./migrations.js";

// =============================================================================
// Errors
// =============================================================================

export type DatabaseOpenErrorKind =
  | "native_binding" // better-sqlite3's native module is missing or built for another Node
  | "busy" // another process holds a lock on the file
  | "permission" // the file or its directory cannot be read or written
  | "schema_too_new" // the file was migrated by a newer release
  | "corrupt_unrecoverable" // corrupt, and it could not be moved aside
  | "open_failed"; // anything else

export class DatabaseOpenError extends Error {
  constructor(
    readonly kind: DatabaseOpenErrorKind,
    readonly dbPath: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "DatabaseOpenError";
  }
}

function errorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : "";
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    const code = errorCode(err);
    return code ? `${code}: ${err.message}` : err.message;
  }
  return String(err);
}

/** True only for errors that mean the file itself is damaged or is not a database. */
export function isCorruptionError(err: unknown): boolean {
  const code = errorCode(err);
  return code === "SQLITE_NOTADB" || code.startsWith("SQLITE_CORRUPT");
}

class QuickCheckFailed extends Error {
  readonly code = "SQLITE_CORRUPT";
}

const LEFT_UNTOUCHED = "The database file was left untouched.";

function toOpenError(err: unknown, dbPath: string): DatabaseOpenError {
  if (err instanceof DatabaseOpenError) return err;
  if (err instanceof SchemaTooNewError) {
    return new DatabaseOpenError("schema_too_new", dbPath, `${err.message} ${LEFT_UNTOUCHED}`, {
      cause: err,
    });
  }

  const code = errorCode(err);
  const detail = describeError(err);

  if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
    return new DatabaseOpenError(
      "busy",
      dbPath,
      `Database ${dbPath} is locked by another process (${detail}). Stop the other process ` +
        "(another API instance or an open sqlite3 shell) or set SQLITE_DB_PATH to a different " +
        `file. ${LEFT_UNTOUCHED}`,
      { cause: err },
    );
  }

  if (
    code === "EACCES" ||
    code === "EPERM" ||
    code === "EROFS" ||
    code.startsWith("SQLITE_CANTOPEN") ||
    code.startsWith("SQLITE_READONLY") ||
    code === "SQLITE_PERM" ||
    code === "SQLITE_AUTH"
  ) {
    return new DatabaseOpenError(
      "permission",
      dbPath,
      `Cannot open database ${dbPath} for reading and writing (${detail}). Check that the user ` +
        "running the API can read and write the file and its directory, or set SQLITE_DB_PATH " +
        `to a writable location. ${LEFT_UNTOUCHED}`,
      { cause: err },
    );
  }

  return new DatabaseOpenError(
    "open_failed",
    dbPath,
    `Cannot open database ${dbPath} (${detail}). ${LEFT_UNTOUCHED}`,
    { cause: err },
  );
}

// =============================================================================
// Native binding preflight
// =============================================================================

/**
 * better-sqlite3 loads its native module on the first `new Database()`. Opening an in-memory
 * database first separates "the driver cannot load" from "this file cannot be opened", so a
 * driver problem never touches the database file.
 */
export function checkNativeBinding(): void {
  try {
    new Database(":memory:").close();
  } catch (err) {
    throw new DatabaseOpenError(
      "native_binding",
      ":memory:",
      `better-sqlite3 cannot load its native module under Node ${process.version} ` +
        `(module ABI ${process.versions.modules}): ${describeError(err)}. It is missing or was ` +
        "built for another Node version. Rebuild it with `npm rebuild better-sqlite3` from the " +
        "repository root (or reinstall with `npm ci` without --ignore-scripts), then start " +
        "again. No database file was opened.",
      { cause: err },
    );
  }
}

// =============================================================================
// Pragmas
// =============================================================================

function configurePragmas(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000"); // 64MB
  db.pragma("foreign_keys = ON");
}

// =============================================================================
// Corruption handling
// =============================================================================

/** Moves a corrupt database (and its WAL/SHM files) aside. Throws if it cannot. */
function quarantineCorruptDatabase(dbPath: string, cause: unknown): string {
  const corruptPath = `${dbPath}.corrupt.${Date.now()}`;
  console.error(
    `[Database] ${dbPath} is corrupt (${describeError(cause)}). Moving it to ${corruptPath} and starting empty.`,
  );
  try {
    renameSync(dbPath, corruptPath);
    for (const suffix of ["-wal", "-shm"]) {
      if (existsSync(`${dbPath}${suffix}`)) {
        renameSync(`${dbPath}${suffix}`, `${corruptPath}${suffix}`);
      }
    }
  } catch (err) {
    throw new DatabaseOpenError(
      "corrupt_unrecoverable",
      dbPath,
      `Database ${dbPath} is corrupt (${describeError(cause)}) and could not be moved aside ` +
        `(${describeError(err)}). Move or delete it by hand, then start again.`,
      { cause: err },
    );
  }
  return corruptPath;
}

/** Opens, checks, configures and migrates one file. Closes the handle on any failure. */
function openAndPrepare(dbPath: string, busyTimeoutMs: number): Database.Database {
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { timeout: busyTimeoutMs });
    const check = db.pragma("quick_check", { simple: true });
    if (check !== "ok") {
      throw new QuickCheckFailed(`quick_check reported: ${String(check)}`);
    }
    configurePragmas(db);
    runMigrations(db);
    return db;
  } catch (err) {
    try {
      db?.close();
    } catch {
      /* the original error is the one worth reporting */
    }
    throw err;
  }
}

// =============================================================================
// Paths
// =============================================================================

/** The API package root: the nearest directory above this module with a package.json. */
function apiPackageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/**
 * The database path: SQLITE_DB_PATH, or `data/sonic-agent.db` in the API package. A relative
 * SQLITE_DB_PATH is resolved against the API package root as well, so the file does not move
 * with the directory the server was started from.
 */
export function getDefaultDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SQLITE_DB_PATH?.trim();
  const root = apiPackageRoot();
  if (!configured) return join(root, "data", "sonic-agent.db");
  return isAbsolute(configured) ? configured : resolve(root, configured);
}

// =============================================================================
// Singleton
// =============================================================================

let dbInstance: Database.Database | null = null;

export interface InitializeOptions {
  /** How long to wait for another process's lock before failing with "busy" (default 5000). */
  busyTimeoutMs?: number;
}

/**
 * Initializes the database. Call once at server startup; later calls return the same instance.
 * Throws a DatabaseOpenError (whose message says what to do) when the database cannot be used.
 */
export function initializeDatabase(
  dbPath?: string,
  options: InitializeOptions = {},
): Database.Database {
  if (dbInstance) return dbInstance;

  checkNativeBinding();

  const resolvedPath = dbPath ? resolve(dbPath) : getDefaultDbPath();
  try {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  } catch (err) {
    throw toOpenError(err, resolvedPath);
  }

  const busyTimeoutMs = options.busyTimeoutMs ?? 5000;
  let db: Database.Database;
  try {
    db = openAndPrepare(resolvedPath, busyTimeoutMs);
  } catch (err) {
    if (!isCorruptionError(err)) throw toOpenError(err, resolvedPath);
    quarantineCorruptDatabase(resolvedPath, err);
    try {
      db = openAndPrepare(resolvedPath, busyTimeoutMs);
    } catch (retryErr) {
      throw toOpenError(retryErr, resolvedPath);
    }
  }

  dbInstance = db;
  console.log(
    `[Database] Initialized at ${resolvedPath} (schema v${LATEST_SCHEMA_VERSION}, WAL mode)`,
  );
  return dbInstance;
}

/**
 * Get the current database instance. Throws if not initialized.
 */
export function getDb(): Database.Database {
  if (!dbInstance) {
    throw new Error("[Database] Not initialized. Call initializeDatabase() first.");
  }
  return dbInstance;
}

/**
 * Check if the database is healthy (can execute a simple query).
 */
export function isDatabaseHealthy(): boolean {
  if (!dbInstance) return false;
  try {
    const result = dbInstance.prepare("SELECT 1").get();
    return result != null;
  } catch {
    return false;
  }
}

/**
 * Close the database connection. Call on graceful shutdown.
 */
export function closeDatabase(): void {
  if (dbInstance) {
    try {
      dbInstance.close();
      console.log("[Database] Connection closed.");
    } catch (err) {
      console.error("[Database] Error closing:", err);
    }
    dbInstance = null;
  }
}
