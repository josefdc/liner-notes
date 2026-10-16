/**
 * Shared SQLite Database Singleton
 *
 * Provides a single better-sqlite3 instance configured for WAL mode,
 * schema versioning, and corruption recovery. Used by:
 *   - SqliteSaver (LangGraph checkpointer)
 *   - SqliteStore  (LangGraph BaseStore)
 *   - SonicCache   (typed audio/research/artwork caches)
 */

import Database from "better-sqlite3";
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";

// =============================================================================
// Schema Versioning
// =============================================================================

const SCHEMA_VERSION = 1;

function migrateToV1(db: Database.Database): void {
  // store_items: LangGraph BaseStore persistence
  db.exec(`
    CREATE TABLE IF NOT EXISTS store_items (
      namespace TEXT NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (namespace, key)
    );
  `);

  // audio_cache: cached audio analysis results
  db.exec(`
    CREATE TABLE IF NOT EXISTS audio_cache (
      spotify_id TEXT PRIMARY KEY,
      bpm REAL NOT NULL,
      key_signature TEXT NOT NULL,
      energy REAL NOT NULL,
      confidence TEXT NOT NULL,
      full_data TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );
  `);

  // research_cache: cached research data from historian
  db.exec(`
    CREATE TABLE IF NOT EXISTS research_cache (
      spotify_id TEXT PRIMARY KEY,
      samples_count INTEGER NOT NULL,
      trivia_count INTEGER NOT NULL,
      full_data TEXT NOT NULL,
      created_at INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );
  `);

  // artwork_cache: cached Spotify artwork lookups
  db.exec(`
    CREATE TABLE IF NOT EXISTS artwork_cache (
      search_key TEXT PRIMARY KEY,
      cover_url TEXT,
      spotify_url TEXT,
      preview_url TEXT,
      spotify_id TEXT,
      track_title TEXT,
      track_artist TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      expires_at INTEGER NOT NULL
    );
  `);
}

function runMigrations(db: Database.Database): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  if (currentVersion < SCHEMA_VERSION) {
    db.transaction(() => {
      if (currentVersion < 1) migrateToV1(db);
      db.pragma(`user_version = ${SCHEMA_VERSION}`);
    })();
  }
}

// =============================================================================
// SQLite Pragmas
// =============================================================================

function configurePragmas(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("cache_size = -64000"); // 64MB
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
}

// =============================================================================
// Corruption Recovery
// =============================================================================

function handleCorruptDatabase(dbPath: string): void {
  const timestamp = Date.now();
  const corruptPath = `${dbPath}.corrupt.${timestamp}`;
  console.error(`[Database] Corrupt database detected. Renaming to ${corruptPath}`);
  try {
    renameSync(dbPath, corruptPath);
    // Also rename WAL/SHM files if they exist
    const walPath = `${dbPath}-wal`;
    const shmPath = `${dbPath}-shm`;
    if (existsSync(walPath)) renameSync(walPath, `${corruptPath}-wal`);
    if (existsSync(shmPath)) renameSync(shmPath, `${corruptPath}-shm`);
  } catch (err) {
    console.error("[Database] Failed to rename corrupt database:", err);
  }
}

// =============================================================================
// Singleton
// =============================================================================

let dbInstance: Database.Database | null = null;

function getDefaultDbPath(): string {
  return resolve(process.env.SQLITE_DB_PATH || "./data/sonic-agent.db");
}

/**
 * Initialize the database. Call once at server startup.
 * Returns the configured Database instance.
 */
export function initializeDatabase(dbPath?: string): Database.Database {
  if (dbInstance) return dbInstance;

  const resolvedPath = dbPath || getDefaultDbPath();
  const dir = dirname(resolvedPath);

  // Ensure directory exists
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  try {
    dbInstance = new Database(resolvedPath);

    // Verify integrity on first open
    const integrityResult = dbInstance.pragma("integrity_check", {
      simple: true,
    }) as string;
    if (integrityResult !== "ok") {
      dbInstance.close();
      dbInstance = null;
      handleCorruptDatabase(resolvedPath);
      // Create fresh DB
      dbInstance = new Database(resolvedPath);
    }

    configurePragmas(dbInstance);
    runMigrations(dbInstance);

    console.log(`[Database] Initialized at ${resolvedPath} (v${SCHEMA_VERSION}, WAL mode)`);
    return dbInstance;
  } catch {
    // If open itself fails (e.g., file is corrupt binary)
    if (dbInstance) {
      try {
        dbInstance.close();
      } catch {
        /* ignore close error */
      }
      dbInstance = null;
    }

    if (existsSync(resolvedPath)) {
      handleCorruptDatabase(resolvedPath);
    }

    // Try once more with a fresh file
    dbInstance = new Database(resolvedPath);
    configurePragmas(dbInstance);
    runMigrations(dbInstance);
    console.log(`[Database] Recovered with fresh database at ${resolvedPath}`);
    return dbInstance;
  }
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
