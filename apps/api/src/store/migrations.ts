/**
 * Numbered schema migrations.
 *
 * Each migration runs once, in order, inside its own transaction, and is recorded in
 * `schema_migrations`. To change the schema, append a migration with the next version number;
 * never edit or reorder one that has shipped. `PRAGMA user_version` mirrors the latest applied
 * version so external tools can read it.
 *
 * Databases created before this table existed (user_version 1, no `schema_migrations`) migrate
 * cleanly: migration 1 only creates what is missing, and later migrations run as usual.
 */

import type Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  up(db: Database.Database): void;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    up(db) {
      // store_items: LangGraph BaseStore persistence. `namespace` is the JSON-encoded array.
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

      // audio_cache: audio analysis results (made nullable and measured-only in migration 3)
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

      // research_cache: research data from the historian
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

      // artwork_cache: Spotify artwork lookups
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
    },
  },
  {
    version: 2,
    name: "runs",
    up(db) {
      // One row per analysis run. See runs.ts for the columns' meaning; later migrations may add
      // columns, so readers must not rely on `SELECT *` column order.
      db.exec(`
        CREATE TABLE runs (
          run_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          query TEXT NOT NULL,
          status TEXT NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch()),
          finished_at INTEGER,
          model_available INTEGER,
          audio_available INTEGER,
          payload TEXT
        );
        CREATE INDEX runs_thread_id ON runs (thread_id);
        CREATE INDEX runs_created_at ON runs (created_at);
      `);
    },
  },
  {
    version: 3,
    name: "measured_audio_cache",
    up(db) {
      // A measurement may lack energy (or, in principle, tempo or key), so those columns accept
      // null. SQLite cannot drop NOT NULL in place, so the table is rebuilt.
      //
      // Only rows carrying the `measured` marker are kept. Rows without it were written before
      // the audio cache held measurements only and may contain estimated or random values.
      db.exec(`
        CREATE TABLE audio_cache_new (
          spotify_id TEXT PRIMARY KEY,
          bpm REAL,
          key_signature TEXT,
          energy REAL,
          confidence TEXT NOT NULL,
          full_data TEXT NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()),
          expires_at INTEGER NOT NULL
        );
        INSERT INTO audio_cache_new
          SELECT spotify_id, bpm, key_signature, energy, confidence, full_data, created_at, expires_at
          FROM audio_cache
          WHERE json_valid(full_data) AND json_extract(full_data, '$.measured') IS 1;
        DROP TABLE audio_cache;
        ALTER TABLE audio_cache_new RENAME TO audio_cache;
      `);

      // Track results cached by the scout under ["tracks"] carry no per-value marker, so results
      // stored before measured-only writes cannot be told apart from later ones. They are only
      // served for 24 hours anyway; all of them are dropped and rebuilt on the next request.
      db.prepare("DELETE FROM store_items WHERE namespace = ?").run(JSON.stringify(["tracks"]));
    },
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export class SchemaTooNewError extends Error {
  constructor(
    readonly found: number,
    readonly supported: number,
  ) {
    super(
      `Database schema version ${found} is newer than this code supports (${supported}). ` +
        "It was written by a newer release; run that release, or point SQLITE_DB_PATH at another file.",
    );
    this.name = "SchemaTooNewError";
  }
}

/**
 * Applies every pending migration in order. Each one runs in an IMMEDIATE transaction that first
 * re-checks whether another process has applied it, so two processes starting together do not
 * apply a migration twice. Returns the versions applied by this call.
 */
export function runMigrations(
  db: Database.Database,
  migrations: readonly Migration[] = MIGRATIONS,
): number[] {
  migrations.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(`Migrations must be numbered 1..n in order; found ${m.version} at ${i + 1}`);
    }
  });

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);

  const latest = migrations.length;
  const appliedMax = () =>
    (db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as { v: number | null })
      .v ?? 0;

  const found = appliedMax();
  if (found > latest) throw new SchemaTooNewError(found, latest);

  const applied: number[] = [];
  for (const migration of migrations) {
    db.transaction(() => {
      if (appliedMax() >= migration.version) return;
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(
        migration.version,
        migration.name,
      );
      db.pragma(`user_version = ${migration.version}`);
      applied.push(migration.version);
    }).immediate();
  }
  return applied;
}
