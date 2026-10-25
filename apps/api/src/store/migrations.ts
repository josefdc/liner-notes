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
import { z } from "zod";

// =============================================================================
// Frozen inputs of migration 3
// =============================================================================

/**
 * What migration 3 keeps as a measurement, and how long a low-confidence one may stay cached.
 * These are copies of measuredAudio.ts as of this migration, so later changes to the live cache
 * rules cannot change what a shipped migration does. Since migration 14 the live cache holds v2
 * blocks instead; these stay as they shipped.
 */
const unitScoreV3 = z.number().min(0).max(1).nullable();
const MEASURED_AUDIO_V3 = z
  .object({
    bpm: z.number().positive(),
    key: z.string().min(1),
    energy: unitScoreV3,
    valence: unitScoreV3,
    danceability: unitScoreV3,
    acousticness: unitScoreV3,
    instrumentalness: unitScoreV3,
    confidence: z.enum(["low", "high"]),
    keyMoments: z.array(z.unknown()).optional(),
    // Absent or undefined; zod 4 needs `.optional()` to accept an absent key here.
    unavailableReason: z.undefined().optional(),
    measured: z.literal(true),
    analyzer: z.literal("audio-service"),
  })
  .passthrough();
const LOW_CONFIDENCE_TTL_MS_V3 = 24 * 60 * 60 * 1000;

/** Exposed for the test that compares them with the live rules; not for other use. */
export const MIGRATION_3_FROZEN = {
  measuredAudioSchema: MEASURED_AUDIO_V3,
  lowConfidenceTtlMs: LOW_CONFIDENCE_TTL_MS_V3,
};

function parseMeasuredAudioV3(fullData: string): z.infer<typeof MEASURED_AUDIO_V3> | null {
  let value: unknown;
  try {
    value = JSON.parse(fullData);
  } catch {
    return null;
  }
  const parsed = MEASURED_AUDIO_V3.safeParse(value);
  return parsed.success ? parsed.data : null;
}

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
      // marker (MEASURED_AUDIO_V3 above). Rows without it were written before the audio cache held
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
      const lowConfidenceLimit = Math.floor((Date.now() + LOW_CONFIDENCE_TTL_MS_V3) / 1000);
      for (const row of rows) {
        const features = parseMeasuredAudioV3(row.full_data);
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
  {
    version: 4,
    name: "llm_usage",
    up(db) {
      // One row per model call attempt, a per-database copy of the spend log (llm/spendLog.ts),
      // which stays the authoritative record across processes. See llm/usage.ts for the columns.
      db.exec(`
        CREATE TABLE llm_usage (
          id TEXT PRIMARY KEY,
          run_id TEXT NOT NULL,
          call_site TEXT NOT NULL,
          tier TEXT NOT NULL,
          deployment TEXT NOT NULL,
          purpose TEXT NOT NULL,
          mode TEXT NOT NULL,
          status TEXT NOT NULL,
          input_tokens INTEGER,
          output_tokens INTEGER,
          reasoning_tokens INTEGER,
          usd_est REAL NOT NULL,
          price_multiplier REAL NOT NULL,
          estimated INTEGER NOT NULL,
          latency_ms INTEGER NOT NULL,
          created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        CREATE INDEX llm_usage_run_id ON llm_usage (run_id);
        CREATE INDEX llm_usage_created_at ON llm_usage (created_at);
      `);
    },
  },
  {
    version: 5,
    name: "run_results",
    up(db) {
      // A run keeps its result, the track it is about and whether it was live or replayed, and
      // the events its streams sent. A resumed run sends a second stream whose `seq` starts at 0
      // again, so an event is keyed by its run, the stream's number within the run and its seq.
      // Runs recorded before this migration have no stored result; their mode is the column's
      // default, live, which says nothing about how their result was produced.
      db.exec(`
        ALTER TABLE runs ADD COLUMN spotify_id TEXT;
        ALTER TABLE runs ADD COLUMN mode TEXT NOT NULL DEFAULT 'live';
        ALTER TABLE runs ADD COLUMN analysis TEXT;
        CREATE INDEX runs_spotify_id ON runs (spotify_id, finished_at);

        CREATE TABLE run_events (
          run_id TEXT NOT NULL,
          stream INTEGER NOT NULL,
          seq INTEGER NOT NULL,
          sent_at INTEGER NOT NULL,
          event TEXT NOT NULL,
          PRIMARY KEY (run_id, stream, seq)
        );
      `);
    },
  },
  {
    version: 6,
    name: "no_stored_previews",
    up(db) {
      // Preview URLs are looked up for each run and never stored: they are signed links that
      // expire, handed out for preview use only. The artwork cache kept Spotify's for 7 days;
      // the column stays (always null) and the values are cleared.
      db.exec("UPDATE artwork_cache SET preview_url = NULL WHERE preview_url IS NOT NULL");

      // Results stored by the scout under the search text (["tracks"], ["tracks", "v2"] and
      // ["tracks", "v3"]) are never served again: results are now keyed by track, under
      // ["tracks", "v4"]. Many were written before results were stored without preview URLs.
      // Every tracks namespace but that one is dropped.
      db.prepare(
        `DELETE FROM store_items
         WHERE (namespace = ? OR namespace LIKE ?) AND namespace <> ?`,
      ).run(JSON.stringify(["tracks"]), '["tracks",%', JSON.stringify(["tracks", "v4"]));
    },
  },
  {
    version: 7,
    name: "run_commit",
    up(db) {
      // A run keeps the commit of the code that ran it, read by the server when it started, so a
      // recording of the run names that commit rather than whatever is checked out when it is
      // recorded. Runs stored before this migration, and runs of a server that could not read
      // its commit (no repository), have none.
      db.exec("ALTER TABLE runs ADD COLUMN code_commit TEXT");
    },
  },
  {
    version: 8,
    name: "no_remembered_choices",
    up(db) {
      // Track choices that earlier versions remembered under the typed text, for every user who
      // typed it. Nothing reads them since a pick became one user's choice, and choices are not
      // remembered across users; they are deleted, and retention no longer keeps them.
      db.prepare("DELETE FROM store_items WHERE namespace = ?").run(
        JSON.stringify(["disambiguation"]),
      );
    },
  },
  {
    version: 9,
    name: "artwork_credits",
    up(db) {
      // The artwork cache keeps every credited artist of the track it found (a JSON list), not
      // only the lead, so a cached answer is judged against the node's credit as a fresh search
      // is. Rows written before have none and are judged on the lead artist.
      db.exec("ALTER TABLE artwork_cache ADD COLUMN track_artists TEXT");
    },
  },
  {
    version: 10,
    name: "run_evidence",
    up(db) {
      // A run keeps its result's evidence pack apart (a JSON list of Evidence), so the sources a
      // run read can be queried without parsing the whole result. Runs stored before take their
      // stored result's pack; a run without a stored result has none (null).
      db.exec(`
        ALTER TABLE runs ADD COLUMN evidence TEXT;
        UPDATE runs SET evidence = json_extract(analysis, '$.evidence')
          WHERE CASE WHEN json_valid(analysis)
            THEN json_type(analysis, '$.evidence') = 'array' ELSE 0 END;
      `);
    },
  },
  {
    version: 11,
    name: "run_pauses",
    up(db) {
      // A run keeps how long it waited for the user's choice (the track picker), so its duration
      // can leave that time out: `paused_since` is when its current wait began (null while it is
      // not waiting), `paused_seconds` the waits that have ended. A run stored before this
      // migration may have waited for any time, which nothing recorded: its paused_seconds is
      // null (unknown), and stays null.
      db.exec(`
        ALTER TABLE runs ADD COLUMN paused_since INTEGER;
        ALTER TABLE runs ADD COLUMN paused_seconds INTEGER;
      `);
    },
  },
  {
    version: 12,
    name: "retention_record_sent_calls",
    up(db) {
      // `retention_state` keeps, in its one row, what the run report needs to mark pruned days:
      // `run_cutoff`, the latest run cutoff retention has applied (unix seconds: runs and usage
      // rows at or before it may have been deleted; null until the first prune after this
      // migration), and `recorded_since`, when cutoffs began to be recorded. The prunes before
      // that were not recorded, so on a database that may have been pruned (below) it is this
      // migration's time; on a new one it is null: no record can have been deleted unseen.
      // `llm_usage.sent` is 1 when the attempt's request was sent to the provider, 0 when it was
      // not (stopped before sending, no connection made, or answered from stored answers), and
      // null for rows written before this migration (llm/usage.ts).
      db.exec(`
        CREATE TABLE retention_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          run_cutoff INTEGER,
          recorded_since INTEGER,
          updated_at INTEGER NOT NULL
        );
        ALTER TABLE llm_usage ADD COLUMN sent INTEGER;
      `);
      // A database may have had records pruned unseen if it holds runs or usage rows, or if it
      // was first migrated more than a day ago (the shortest run retention: a younger one can
      // have had nothing old enough), since it may have been pruned to empty.
      const now = Math.floor(Date.now() / 1000);
      const held = db
        .prepare(
          `SELECT EXISTS (SELECT 1 FROM runs) OR EXISTS (SELECT 1 FROM llm_usage)
             OR (SELECT MIN(applied_at) FROM schema_migrations) <= ?`,
        )
        .pluck()
        .get(now - 24 * 60 * 60);
      db.prepare(
        "INSERT INTO retention_state (id, run_cutoff, recorded_since, updated_at) VALUES (1, NULL, ?, ?)",
      ).run(held ? now : null, now);
    },
  },
  {
    version: 13,
    name: "artwork_track_details",
    up(db) {
      // The artwork cache keeps, for the track it found, what a node's preview is decided on: its
      // ISRC, duration, album name and release date (a JSON object; never a link). A row served
      // from the cache is then judged on its album and date as a fresh search is, and gets its
      // Deezer preview by ISRC. Rows written before have none (null): one with a Spotify id is then
      // a miss for the enricher (searched again and written with the details), one without is
      // still served (the cover only).
      db.exec("ALTER TABLE artwork_cache ADD COLUMN track_details TEXT");
    },
  },
  {
    version: 14,
    name: "audio_cache_by_analyzer",
    up(db) {
      // The audio cache holds the audio service's AudioFeatures v2 block, filed under
      // (track key, analyzer version): the track key is `isrc:<ISRC>` for a clip matched by ISRC
      // and `spotify:<id>` otherwise (store/measuredAudio.ts). A measurement by another analyzer
      // version is a miss. The rows kept so far hold flat values without the block (method,
      // confidence, window): they are dropped, never turned into a block, and those tracks are
      // measured again.
      db.exec(`
        DROP TABLE audio_cache;
        CREATE TABLE audio_cache (
          track_key TEXT NOT NULL,
          analyzer_version TEXT NOT NULL,
          spotify_id TEXT NOT NULL,
          confidence TEXT NOT NULL,
          full_data TEXT NOT NULL,
          created_at INTEGER DEFAULT (unixepoch()),
          expires_at INTEGER NOT NULL,
          PRIMARY KEY (track_key, analyzer_version)
        );
      `);
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
