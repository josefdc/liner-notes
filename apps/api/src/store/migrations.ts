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
import { LOW_CONFIDENCE_AUDIO_TTL_MS, parseMeasuredAudio } from "./measuredAudio.js";

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
      // Only rows the cache would serve are kept: valid measurements carrying the `measured`
      // marker (see measuredAudio.ts). Rows without it were written before the audio cache held
      // measurements only and may contain estimated or random values. Kept low-confidence rows
      // expire within a day, as the cache now writes them.
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
      `);
      const rows = db
        .prepare("SELECT spotify_id, full_data, created_at, expires_at FROM audio_cache")
        .all() as Array<{
        spotify_id: string;
        full_data: string;
        created_at: number | null;
        expires_at: number;
      }>;
      const insert = db.prepare(
        `INSERT INTO audio_cache_new
           (spotify_id, bpm, key_signature, energy, confidence, full_data, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const lowConfidenceLimit = Math.floor((Date.now() + LOW_CONFIDENCE_AUDIO_TTL_MS) / 1000);
      for (const row of rows) {
        const features = parseMeasuredAudio(row.full_data);
        if (!features) continue;
        const expiresAt =
          features.confidence === "low"
            ? Math.min(row.expires_at, lowConfidenceLimit)
            : row.expires_at;
        insert.run(
          row.spotify_id,
          features.bpm,
          features.key,
          features.energy,
          features.confidence,
          row.full_data,
          row.created_at,
          expiresAt,
        );
      }
      db.exec(`
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

/** A recorded migration whose name differs from this code's migration with the same number. */
export class SchemaMismatchError extends Error {
  constructor(
    readonly version: number,
    readonly recordedName: string,
    readonly expectedName: string,
  ) {
    super(
      `Database migration ${version} was recorded as "${recordedName}", but this code's ` +
        `migration ${version} is "${expectedName}". The database was migrated by a different ` +
        "version of the code; run that version, or point SQLITE_DB_PATH at another file.",
    );
    this.name = "SchemaMismatchError";
  }
}

/** A migration that threw. It was rolled back; the migrations before it stay applied. */
export class MigrationFailedError extends Error {
  constructor(
    readonly migration: Pick<Migration, "version" | "name">,
    readonly appliedBefore: number[],
    options: { cause: unknown },
  ) {
    const detail = options.cause instanceof Error ? options.cause.message : String(options.cause);
    super(`Migration ${migration.version} (${migration.name}) failed: ${detail}`, options);
    this.name = "MigrationFailedError";
  }

  /** What state the failure left the database in, for error messages. */
  get outcome(): string {
    const before =
      this.appliedBefore.length > 0
        ? `Migrations ${this.appliedBefore.join(", ")} were applied by this start and stay applied.`
        : "No migration was applied by this start.";
    return `Migration ${this.migration.version} was rolled back. ${before}`;
  }
}

/**
 * Applies every pending migration in order. Each one runs in an IMMEDIATE transaction that first
 * re-checks whether another process has applied it, so two processes starting together do not
 * apply a migration twice. Returns the versions applied by this call.
 *
 * Throws SchemaTooNewError or SchemaMismatchError (before changing anything) when the recorded
 * migrations do not match this code, and MigrationFailedError when a migration throws.
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
  const recorded = () =>
    db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all() as Array<{
      version: number;
      name: string;
    }>;

  for (const row of recorded()) {
    if (row.version > latest) throw new SchemaTooNewError(row.version, latest);
    const expected = migrations[row.version - 1];
    if (!expected || expected.name !== row.name) {
      throw new SchemaMismatchError(row.version, row.name, expected?.name ?? "(none)");
    }
  }

  const applied: number[] = [];
  for (const migration of migrations) {
    try {
      db.transaction(() => {
        const done = db
          .prepare("SELECT 1 FROM schema_migrations WHERE version = ?")
          .get(migration.version);
        if (done) return;
        migration.up(db);
        db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(
          migration.version,
          migration.name,
        );
        db.pragma(`user_version = ${migration.version}`);
        applied.push(migration.version);
      }).immediate();
    } catch (err) {
      throw new MigrationFailedError(migration, [...applied], { cause: err });
    }
  }
  return applied;
}
