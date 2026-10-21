/**
 * Tests for database.ts (opening, error handling, migrations), store.ts and cache.ts
 * Run: npm run test:db -w apps/api
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import {
  initializeDatabase,
  closeDatabase,
  isDatabaseHealthy,
  getDb,
  DatabaseOpenError,
  getDefaultDbPath,
} from "./database.js";
import { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations, type Migration } from "./migrations.js";
import { SqliteStore } from "./store.js";
import { SonicCache } from "./cache.js";

// =============================================================================
// Test Helpers
// =============================================================================

let tmpDir: string;

function setup(): string {
  tmpDir = mkdtempSync(join(tmpdir(), "sonic-db-test-"));
  return join(tmpDir, "test.db");
}

function cleanup(): void {
  closeDatabase();
  if (tmpDir) {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

function assert(condition: boolean, message: string): void {
  expect(condition, message).toBe(true);
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  expect(actual, message).toBe(expected);
}

// =============================================================================
// Test 1: Database Initialization & Health
// =============================================================================

async function testDbInitialization(): Promise<void> {
  const dbPath = setup();

  try {
    const db = initializeDatabase(dbPath);
    assert(db != null, "Database instance returned");
    assert(isDatabaseHealthy(), "Database is healthy");

    // Check WAL mode
    const journalMode = db.pragma("journal_mode", { simple: true });
    assertEqual(journalMode, "wal", "WAL mode enabled");

    // user_version mirrors the latest applied migration
    const version = db.pragma("user_version", { simple: true }) as number;
    assertEqual(version, LATEST_SCHEMA_VERSION, "Schema version is the latest migration");
  } finally {
    cleanup();
  }
}

// =============================================================================
// Test 2: Schema Versioning (re-open sees correct version)
// =============================================================================

async function testSchemaVersioning(): Promise<void> {
  const dbPath = setup();

  try {
    // First open
    initializeDatabase(dbPath);
    const version1 = getDb().pragma("user_version", { simple: true }) as number;
    assertEqual(version1, LATEST_SCHEMA_VERSION, "First open: latest version");
    closeDatabase();

    // Second open — should detect version and skip migration
    initializeDatabase(dbPath);
    const version2 = getDb().pragma("user_version", { simple: true }) as number;
    assertEqual(version2, LATEST_SCHEMA_VERSION, "Second open: still the latest version");

    // Tables should exist
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    assert(tableNames.includes("store_items"), "store_items table exists");
    assert(tableNames.includes("audio_cache"), "audio_cache table exists");
    assert(tableNames.includes("research_cache"), "research_cache table exists");
    assert(tableNames.includes("artwork_cache"), "artwork_cache table exists");
    assert(tableNames.includes("runs"), "runs table exists");
    assert(tableNames.includes("schema_migrations"), "schema_migrations table exists");
  } finally {
    cleanup();
  }
}

// =============================================================================
// Test 3: SqliteStore — Put/Get/Delete/Search/ListNamespaces
// =============================================================================

async function testSqliteStore(): Promise<void> {
  const dbPath = setup();

  try {
    const db = initializeDatabase(dbPath);
    const store = new SqliteStore(db);

    // Put an item
    await store.put(["tracks"], "track-123", {
      title: "Midnight City",
      artist: "M83",
      timestamp: Date.now(),
    });

    // Get it back
    const item = await store.get(["tracks"], "track-123");
    assert(item != null, "Retrieved item is not null");
    assertEqual(item?.value?.title, "Midnight City", "Item title matches");
    assertEqual(item?.key, "track-123", "Item key matches");

    // Update it
    await store.put(["tracks"], "track-123", {
      title: "Midnight City",
      artist: "M83",
      updated: true,
    });
    const updated = await store.get(["tracks"], "track-123");
    assertEqual(updated?.value?.updated, true, "Item was updated");

    // Get non-existent
    const missing = await store.get(["tracks"], "nonexistent");
    assertEqual(missing, null, "Non-existent item returns null");

    // Put another item in different namespace
    await store.put(["disambiguation"], "query-1", { selectedId: "abc" });

    // Search by namespace prefix
    const searchResults = await store.search(["tracks"]);
    assertEqual(searchResults.length, 1, "Search returns 1 item in tracks namespace");

    // List namespaces
    const namespaces = await store.listNamespaces({});
    assert(namespaces.length >= 2, "At least 2 namespaces listed");

    // Delete
    await store.delete(["tracks"], "track-123");
    const deleted = await store.get(["tracks"], "track-123");
    assertEqual(deleted, null, "Deleted item returns null");
  } finally {
    cleanup();
  }
}

// =============================================================================
// Test 4: SqliteStore — Search with filters
// =============================================================================

async function testSqliteStoreFilters(): Promise<void> {
  const dbPath = setup();

  try {
    const db = initializeDatabase(dbPath);
    const store = new SqliteStore(db);

    await store.put(["items"], "a", { score: 10, type: "high" });
    await store.put(["items"], "b", { score: 5, type: "low" });
    await store.put(["items"], "c", { score: 8, type: "high" });

    // Filter by exact value
    const highItems = await store.search(["items"], { filter: { type: "high" } });
    assertEqual(highItems.length, 2, "Filter by type=high returns 2 items");

    // Filter with $gt operator
    const gtItems = await store.search(["items"], { filter: { score: { $gt: 7 } } });
    assertEqual(gtItems.length, 2, "Filter score > 7 returns 2 items");
  } finally {
    cleanup();
  }
}

// =============================================================================
// Test 5: SonicCache — Audio (with overwrite protection)
// =============================================================================

async function testSonicCacheAudio(): Promise<void> {
  const dbPath = setup();

  try {
    const db = initializeDatabase(dbPath);
    const cache = new SonicCache(db);

    const audioFeatures = {
      bpm: 105,
      key: "D Minor",
      energy: 0.82,
      valence: 0.6,
      danceability: 0.7,
      acousticness: 0.2,
      instrumentalness: 0.1,
      confidence: "high" as const,
      keyMoments: [],
      measured: true as const,
      analyzer: "audio-service" as const,
    };

    // Put and get
    cache.putAudio("spotify-123", audioFeatures);
    const retrieved = cache.getAudio("spotify-123");
    assert(retrieved != null, "Audio cache hit");
    assertEqual(retrieved?.bpm, 105, "BPM matches");
    assertEqual(retrieved?.key, "D Minor", "Key matches");

    // Overwrite protection: don't downgrade high → low
    // A partial measurement, as the engineer builds it: perceptual scores not measured are null.
    const partial = {
      valence: null,
      danceability: null,
      acousticness: null,
      instrumentalness: null,
      confidence: "low" as const,
    };
    const lowConfidence = { ...audioFeatures, ...partial, bpm: 100 };
    cache.putAudio("spotify-123", lowConfidence);
    const afterDowngrade = cache.getAudio("spotify-123");
    assertEqual(afterDowngrade?.bpm, 105, "High confidence not overwritten by low");

    // Allow upgrade: low → high
    cache.putAudio("spotify-456", { ...audioFeatures, ...partial, bpm: 90 });
    cache.putAudio("spotify-456", { ...audioFeatures, confidence: "high" as const, bpm: 95 });
    const upgraded = cache.getAudio("spotify-456");
    assertEqual(upgraded?.bpm, 95, "Low confidence overwritten by high");

    // Missing key
    assertEqual(cache.getAudio("nonexistent"), null, "Missing audio returns null");
  } finally {
    cleanup();
  }
}

// =============================================================================
// Test 6: SonicCache — Research & Artwork
// =============================================================================

async function testSonicCacheResearchArtwork(): Promise<void> {
  const dbPath = setup();

  try {
    const db = initializeDatabase(dbPath);
    const cache = new SonicCache(db);

    // Research cache
    const researchData = {
      samples: ["Sample A"],
      productionTrivia: ["Trivia 1", "Trivia 2"],
      relatedArtists: ["Artist X"],
    };
    cache.putResearch("spotify-789", researchData);
    const research = cache.getResearch("spotify-789");
    assert(research != null, "Research cache hit");
    assertEqual(research?.samples?.length, 1, "Research samples count matches");

    // Artwork cache
    const artwork = {
      coverUrl: "https://i.scdn.co/image/test",
      spotifyUrl: "https://open.spotify.com/track/abc",
      previewUrl: null,
      spotifyId: "abc",
      trackTitle: "Test Song",
      trackArtist: "Test Artist",
    };
    cache.putArtwork("test song artist", artwork);
    const artworkResult = cache.getArtwork("test song artist");
    assert(artworkResult != null, "Artwork cache hit");
    assertEqual(artworkResult?.trackTitle, "Test Song", "Artwork title matches");
  } finally {
    cleanup();
  }
}

// =============================================================================
// Test 7: SonicCache — TTL Expiration
// =============================================================================

async function testSonicCacheTTL(): Promise<void> {
  const dbPath = setup();

  try {
    const db = initializeDatabase(dbPath);
    const cache = new SonicCache(db);

    // Put with TTL of 0ms (already expired)
    cache.putAudio(
      "expired-1",
      {
        bpm: 120,
        key: "C Major",
        energy: 0.5,
        valence: 0.5,
        danceability: 0.5,
        acousticness: 0.5,
        instrumentalness: 0.1,
        confidence: "low",
        keyMoments: [],
        measured: true,
        analyzer: "audio-service",
      },
      0,
    );

    // Should be expired
    const expired = cache.getAudio("expired-1");
    assertEqual(expired, null, "Expired audio entry returns null");

    // Purge expired
    cache.putResearch(
      "expired-r",
      {
        samples: [],
        productionTrivia: [],
        relatedArtists: [],
      },
      0,
    );
    const purgeResult = cache.purgeExpired();
    assert(purgeResult.audio >= 1, "Purged at least 1 expired audio entry");
    assert(purgeResult.research >= 1, "Purged at least 1 expired research entry");
  } finally {
    cleanup();
  }
}

// =============================================================================
// Test 8: Corruption Recovery
// =============================================================================

async function testCorruptionRecovery(): Promise<void> {
  const dbPath = setup();

  try {
    // Create a corrupt file
    writeFileSync(dbPath, "THIS IS NOT A VALID SQLITE DATABASE FILE");

    // Initialize should recover
    const db = initializeDatabase(dbPath);
    assert(db != null, "Database recovered from corruption");
    assert(isDatabaseHealthy(), "Recovered database is healthy");

    // Check that corrupt file was renamed
    const files = readdirSync(tmpDir);
    const corruptFiles = files.filter((f) => f.includes(".corrupt."));
    assert(corruptFiles.length > 0, "Corrupt file was renamed with .corrupt. suffix");
  } finally {
    cleanup();
  }
}

// =============================================================================
// Test 9: Graceful Degradation after close
// =============================================================================

async function testGracefulDegradation(): Promise<void> {
  const dbPath = setup();

  try {
    initializeDatabase(dbPath);
    assert(isDatabaseHealthy(), "DB healthy before close");

    closeDatabase();
    assertEqual(isDatabaseHealthy(), false, "DB not healthy after close");
  } finally {
    cleanup();
  }
}

// =============================================================================
// Test 10: Concurrent Writes (parallel engineer + historian)
// =============================================================================

async function testConcurrentWrites(): Promise<void> {
  const dbPath = setup();

  try {
    const db = initializeDatabase(dbPath);
    const cache = new SonicCache(db);
    const store = new SqliteStore(db);

    // Simulate parallel writes from engineer and historian
    const engineerWrite = Promise.resolve().then(() => {
      cache.putAudio("concurrent-1", {
        bpm: 128,
        key: "A Minor",
        energy: 0.9,
        valence: 0.7,
        danceability: 0.8,
        acousticness: 0.1,
        instrumentalness: 0.05,
        confidence: "high",
        keyMoments: [],
        measured: true,
        analyzer: "audio-service",
      });
    });

    const historianWrite = Promise.resolve().then(() => {
      cache.putResearch("concurrent-1", {
        samples: ["Sample 1"],
        productionTrivia: ["Trivia 1"],
        relatedArtists: ["Artist A"],
      });
    });

    const storeWrite = Promise.resolve().then(async () => {
      await store.put(["tracks"], "concurrent-1", { title: "Test", timestamp: Date.now() });
    });

    // All writes should succeed without deadlock
    await Promise.all([engineerWrite, historianWrite, storeWrite]);

    // Verify all data persisted
    const audio = cache.getAudio("concurrent-1");
    const research = cache.getResearch("concurrent-1");
    const storeItem = await store.get(["tracks"], "concurrent-1");

    assert(audio != null, "Concurrent audio write succeeded");
    assert(research != null, "Concurrent research write succeeded");
    assert(storeItem != null, "Concurrent store write succeeded");
    assertEqual(audio?.bpm, 128, "Audio data correct after concurrent write");
  } finally {
    cleanup();
  }
}

// =============================================================================
// Runner
// =============================================================================

it("initializes the database and reports health", testDbInitialization);
it("keeps the schema version across re-opens", testSchemaVersioning);
it("stores and reads items with SqliteStore", testSqliteStore);
it("filters SqliteStore searches", testSqliteStoreFilters);
it("caches audio analysis", testSonicCacheAudio);
it("caches research and artwork", testSonicCacheResearchArtwork);
it("expires cache entries after their TTL", testSonicCacheTTL);
it("recovers from a corrupt database file", testCorruptionRecovery);
it("degrades gracefully after close", testGracefulDegradation);
it("handles concurrent writes", testConcurrentWrites);

// =============================================================================
// Opening: only real corruption moves a database aside
// =============================================================================

/** Creates a healthy database holding marker table `marker` with x = 42. */
function makeHealthyDb(path: string): void {
  const db = new Database(path);
  db.exec("CREATE TABLE marker (x INTEGER); INSERT INTO marker VALUES (42);");
  db.close();
}

function markerValue(path: string): number | undefined {
  const db = new Database(path, { readonly: true, fileMustExist: true });
  try {
    return (db.prepare("SELECT x FROM marker LIMIT 1").get() as { x: number } | undefined)?.x;
  } finally {
    db.close();
  }
}

/** Runs `fn`, which must throw, and returns what it threw. */
function thrown(fn: () => unknown): Error & { kind?: string } {
  try {
    fn();
  } catch (err) {
    return err as Error & { kind?: string };
  }
  throw new Error("expected the call to throw");
}

/** Imports a fresh copy of database.ts whose better-sqlite3 cannot load its native module. */
async function importWithBrokenDriver(error: Error): Promise<typeof import("./database.js")> {
  vi.resetModules();
  vi.doMock("better-sqlite3", () => ({
    default: class {
      constructor() {
        throw error;
      }
    },
  }));
  try {
    return await import("./database.js");
  } finally {
    vi.doUnmock("better-sqlite3");
  }
}

const isRoot = process.getuid?.() === 0;

const betterSqlitePath = createRequire(import.meta.url).resolve("better-sqlite3");
const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = join(apiRoot, "..", "..");

/** Runs a CommonJS snippet in a child Node process with `Database` (better-sqlite3) in scope. */
function runChild(code: string, ...args: string[]) {
  return spawnSync(
    process.execPath,
    ["-e", `const Database = require(${JSON.stringify(betterSqlitePath)});\n${code}`, ...args],
    { encoding: "utf8", timeout: 30_000 },
  );
}

describe("opening a database that cannot be used", () => {
  afterEach(() => {
    vi.resetModules();
    cleanup();
  });

  it.skipIf(isRoot)("leaves an unreadable database untouched (EACCES)", () => {
    const dbPath = setup();
    makeHealthyDb(dbPath);
    chmodSync(dbPath, 0o000);
    let err: Error & { kind?: string };
    try {
      err = thrown(() => initializeDatabase(dbPath));
    } finally {
      chmodSync(dbPath, 0o644);
    }
    expect(err).toBeInstanceOf(DatabaseOpenError);
    expect(err.kind).toBe("permission");
    expect(err.message).toContain("SQLITE_DB_PATH");
    expect(err.message).toContain("left untouched");
    expect(readdirSync(tmpDir)).toEqual(["test.db"]);
    expect(markerValue(dbPath)).toBe(42);
  });

  it.skipIf(isRoot)("leaves a read-only database untouched", () => {
    const dbPath = setup();
    makeHealthyDb(dbPath);
    chmodSync(dbPath, 0o444);
    let err: Error & { kind?: string };
    try {
      err = thrown(() => initializeDatabase(dbPath));
    } finally {
      chmodSync(dbPath, 0o644);
    }
    expect(err.kind).toBe("permission");
    expect(readdirSync(tmpDir).filter((f) => f.includes("corrupt"))).toEqual([]);
    expect(markerValue(dbPath)).toBe(42);
  });

  it("leaves a database locked by another connection untouched (SQLITE_BUSY)", () => {
    const dbPath = setup();
    makeHealthyDb(dbPath);
    const locker = new Database(dbPath);
    locker.pragma("locking_mode = EXCLUSIVE");
    locker.exec("BEGIN EXCLUSIVE; INSERT INTO marker VALUES (1);");
    let err: Error & { kind?: string };
    try {
      err = thrown(() => initializeDatabase(dbPath, { busyTimeoutMs: 100 }));
    } finally {
      locker.exec("ROLLBACK");
      locker.close();
    }
    expect(err.kind).toBe("busy");
    expect(err.message).toContain("locked by another process");
    expect(readdirSync(tmpDir)).toEqual(["test.db"]);
    expect(markerValue(dbPath)).toBe(42);
  });

  it("does not touch the database when the native module was built for another Node (ABI mismatch)", async () => {
    const dbPath = setup();
    makeHealthyDb(dbPath);
    const abiError = Object.assign(
      new Error(
        "The module '/app/node_modules/better-sqlite3/build/Release/better_sqlite3.node'\n" +
          "was compiled against a different Node.js version using\nNODE_MODULE_VERSION 109. " +
          "This version of Node.js requires\nNODE_MODULE_VERSION 137.",
      ),
      { code: "ERR_DLOPEN_FAILED" },
    );
    const broken = await importWithBrokenDriver(abiError);
    const err = thrown(() => broken.initializeDatabase(dbPath));
    expect(err.name).toBe("DatabaseOpenError");
    expect(err.kind).toBe("native_binding");
    expect(err.message).toContain("npm rebuild better-sqlite3");
    expect(err.message).toContain("NODE_MODULE_VERSION 109");
    expect(readdirSync(tmpDir)).toEqual(["test.db"]);
    expect(markerValue(dbPath)).toBe(42);
  });

  it("does not touch the database when the native module is missing", async () => {
    const dbPath = setup();
    makeHealthyDb(dbPath);
    const broken = await importWithBrokenDriver(
      new Error(
        "Could not locate the bindings file. Tried:\n → /app/node_modules/better-sqlite3/build/better_sqlite3.node",
      ),
    );
    const err = thrown(() => broken.initializeDatabase(dbPath));
    expect(err.kind).toBe("native_binding");
    expect(err.message).toContain("npm rebuild better-sqlite3");
    expect(readdirSync(tmpDir)).toEqual(["test.db"]);
    expect(markerValue(dbPath)).toBe(42);
  });

  it("moves a database with damaged pages aside (quick_check / SQLITE_CORRUPT)", () => {
    const dbPath = setup();
    const raw = new Database(dbPath);
    raw.exec("CREATE TABLE filler (x TEXT)");
    const insert = raw.prepare("INSERT INTO filler VALUES (?)");
    raw.transaction(() => {
      for (let i = 0; i < 200; i++) insert.run(`row-${i}-${"x".repeat(200)}`);
    })();
    raw.close();
    const pageSize = 4096;
    expect(statSync(dbPath).size).toBeGreaterThan(pageSize * 3);
    const fd = openSync(dbPath, "r+");
    writeSync(fd, Buffer.alloc(pageSize, 0xa5), 0, pageSize, pageSize);
    closeSync(fd);

    const db = initializeDatabase(dbPath);
    expect(isDatabaseHealthy()).toBe(true);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'filler'").get(),
    ).toBeUndefined();
    const moved = readdirSync(tmpDir).filter((f) => /^test\.db\.corrupt\.\d+$/.test(f));
    expect(moved).toHaveLength(1);
    expect(readFileSync(join(tmpDir, moved[0])).subarray(pageSize, pageSize + 4)).toEqual(
      Buffer.alloc(4, 0xa5),
    );
  });

  it("moves a database judged corrupt aside with its stale WAL and SHM exactly as found", () => {
    // A healthy backup restored over the database while the -wal and -shm of a writer that was
    // killed before checkpointing are still there. The WAL replays onto the wrong pages, so the
    // integrity check fails; the quarantined set must be the original bytes so the backup can
    // still be recovered (by removing the stale WAL).
    const dbPath = setup();
    const other = join(tmpDir, "other");
    mkdirSync(other);
    const backup = new Database(dbPath);
    backup.pragma("journal_mode = WAL");
    backup.exec("CREATE TABLE marker (x INTEGER); INSERT INTO marker VALUES (42);");
    backup.pragma("wal_checkpoint(TRUNCATE)");
    backup.close();

    const crashed = new Database(join(other, "y.db"));
    crashed.pragma("journal_mode = WAL");
    crashed.exec("CREATE TABLE big (x BLOB)");
    const fill = (n: number) =>
      crashed.transaction(() => {
        const insert = crashed.prepare("INSERT INTO big VALUES (randomblob(3000))");
        for (let i = 0; i < n; i++) insert.run();
      })();
    fill(10);
    crashed.pragma("wal_checkpoint(TRUNCATE)");
    crashed.pragma("wal_autocheckpoint = 0");
    fill(300);
    // Copied while the writer still holds them: the state a crash leaves behind.
    copyFileSync(join(other, "y.db-wal"), `${dbPath}-wal`);
    copyFileSync(join(other, "y.db-shm"), `${dbPath}-shm`);
    crashed.close();

    const original = {
      db: readFileSync(dbPath),
      wal: readFileSync(`${dbPath}-wal`),
      shm: readFileSync(`${dbPath}-shm`),
    };

    initializeDatabase(dbPath);
    expect(isDatabaseHealthy()).toBe(true);

    const moved = readdirSync(tmpDir).find((f) => /^test\.db\.corrupt\.\d+$/.test(f));
    expect(moved).toBeDefined();
    const movedPath = join(tmpDir, moved as string);
    expect(readFileSync(movedPath).equals(original.db)).toBe(true);
    expect(readFileSync(`${movedPath}-wal`).equals(original.wal)).toBe(true);
    expect(readFileSync(`${movedPath}-shm`).equals(original.shm)).toBe(true);
  });

  it("rolls back a transaction cut short by a crash (hot journal) instead of failing", () => {
    const dbPath = setup();
    const child = runChild(
      `const db = new Database(process.argv[1]);
       db.pragma("journal_mode = DELETE");
       db.exec("CREATE TABLE big (x BLOB)");
       db.transaction(() => {
         for (let i = 0; i < 20; i++) db.prepare("INSERT INTO big VALUES (randomblob(1000))").run();
       })();
       db.pragma("cache_size = 10");
       db.exec("BEGIN");
       const insert = db.prepare("INSERT INTO big VALUES (randomblob(3000))");
       for (let i = 0; i < 500; i++) insert.run();
       process.kill(process.pid, "SIGKILL");`,
      dbPath,
    );
    expect(child.signal).toBe("SIGKILL");
    expect(readdirSync(tmpDir).sort()).toEqual(["test.db", "test.db-journal"]);

    const db = initializeDatabase(dbPath);
    expect(db.prepare("SELECT COUNT(*) FROM big").pluck().get()).toBe(20);
    expect(readdirSync(tmpDir).filter((f) => f.includes("corrupt"))).toEqual([]);
    expect(readdirSync(tmpDir)).not.toContain("test.db-journal");
  });

  it("does not move into quarantine a -wal that only the integrity check created", () => {
    const dbPath = setup();
    const raw = new Database(dbPath);
    raw.pragma("journal_mode = WAL");
    raw.exec("CREATE TABLE filler (x TEXT)");
    raw.transaction(() => {
      const insert = raw.prepare("INSERT INTO filler VALUES (?)");
      for (let i = 0; i < 200; i++) insert.run(`row-${i}-${"x".repeat(200)}`);
    })();
    raw.close();
    expect(readdirSync(tmpDir)).toEqual(["test.db"]);
    const fd = openSync(dbPath, "r+");
    writeSync(fd, Buffer.alloc(4096, 0xa5), 0, 4096, 4096);
    closeSync(fd);

    initializeDatabase(dbPath);
    const moved = readdirSync(tmpDir).filter((f) => f.startsWith("test.db.corrupt."));
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatch(/^test\.db\.corrupt\.\d+$/);
  });

  it.skipIf(isRoot)(
    "the API entry point exits 1 on an unreadable database and leaves it untouched",
    () => {
      const dbPath = setup();
      makeHealthyDb(dbPath);
      const original = readFileSync(dbPath);
      chmodSync(dbPath, 0o000);
      let result: ReturnType<typeof spawnSync>;
      try {
        result = spawnSync(process.execPath, ["--import", "tsx", "src/index.ts"], {
          cwd: apiRoot,
          encoding: "utf8",
          timeout: 60_000,
          env: {
            ...process.env,
            SQLITE_DB_PATH: dbPath,
            SPOTIFY_CLIENT_ID: "test-client-id",
            SPOTIFY_CLIENT_SECRET: "test-client-secret",
            PORT: "3122",
          },
        });
      } finally {
        chmodSync(dbPath, 0o644);
      }
      expect(result.status).toBe(1);
      expect(String(result.stderr)).toContain("[Database] Cannot open database");
      expect(String(result.stderr)).toContain("left untouched");
      expect(readFileSync(dbPath).equals(original)).toBe(true);
      expect(readdirSync(tmpDir)).toEqual(["test.db"]);
    },
    90_000,
  );

  it("refuses a database migrated by a newer release and leaves it untouched", () => {
    const dbPath = setup();
    initializeDatabase(dbPath);
    closeDatabase();
    const raw = new Database(dbPath);
    raw
      .prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)")
      .run(LATEST_SCHEMA_VERSION + 1, "from_the_future");
    raw.close();

    const err = thrown(() => initializeDatabase(dbPath));
    expect(err.kind).toBe("schema_too_new");
    expect(readdirSync(tmpDir).filter((f) => f.includes("corrupt"))).toEqual([]);
  });

  it("resolves the default path from the API package, not the working directory", () => {
    const fromDefault = getDefaultDbPath({});
    expect(fromDefault).toMatch(/[\\/]apps[\\/]api[\\/]data[\\/]sonic-agent\.db$/);
    const apiRoot = fromDefault.replace(/[\\/]data[\\/]sonic-agent\.db$/, "");
    expect(getDefaultDbPath({ SQLITE_DB_PATH: "./elsewhere/x.db" })).toBe(
      join(apiRoot, "elsewhere", "x.db"),
    );
    expect(getDefaultDbPath({ SQLITE_DB_PATH: "/var/lib/liner/x.db" })).toBe("/var/lib/liner/x.db");
  });
});

// =============================================================================
// Migrations
// =============================================================================

/** The schema as the code before numbered migrations created it (user_version 1). */
const PRE_MIGRATIONS_SCHEMA = `
  CREATE TABLE store_items (
    namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (namespace, key));
  CREATE TABLE audio_cache (
    spotify_id TEXT PRIMARY KEY, bpm REAL NOT NULL, key_signature TEXT NOT NULL,
    energy REAL NOT NULL, confidence TEXT NOT NULL, full_data TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);
  CREATE TABLE research_cache (
    spotify_id TEXT PRIMARY KEY, samples_count INTEGER NOT NULL, trivia_count INTEGER NOT NULL,
    full_data TEXT NOT NULL, created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);
  CREATE TABLE artwork_cache (
    search_key TEXT PRIMARY KEY, cover_url TEXT, spotify_url TEXT, preview_url TEXT,
    spotify_id TEXT, track_title TEXT, track_artist TEXT,
    created_at INTEGER DEFAULT (unixepoch()), expires_at INTEGER NOT NULL);
  PRAGMA user_version = 1;
`;

const audioRow = (extra: Record<string, unknown>) => ({
  bpm: 120,
  key: "C Major",
  energy: 0.5,
  valence: 0.5,
  danceability: 0.5,
  acousticness: 0.5,
  instrumentalness: 0.5,
  confidence: "high",
  keyMoments: [],
  ...extra,
});

describe("migrations", () => {
  afterEach(cleanup);

  it("migrates a database created by the code before numbered migrations", () => {
    const dbPath = setup();
    const raw = new Database(dbPath);
    raw.exec(PRE_MIGRATIONS_SCHEMA);
    const putAudio = raw.prepare(
      "INSERT INTO audio_cache (spotify_id, bpm, key_signature, energy, confidence, full_data, expires_at) VALUES (?, 120, 'C Major', 0.5, ?, ?, unixepoch() + 86400)",
    );
    putAudio.run("estimated", "low", JSON.stringify(audioRow({ confidence: "low" })));
    putAudio.run("analyzed-unmarked", "high", JSON.stringify(audioRow({})));
    putAudio.run(
      "measured",
      "high",
      JSON.stringify(audioRow({ measured: true, analyzer: "audio-service" })),
    );
    putAudio.run("garbage", "high", "{not json");
    const now = new Date().toISOString();
    const putItem = raw.prepare("INSERT INTO store_items VALUES (?, ?, ?, ?, ?)");
    putItem.run('["tracks"]', "midnight city", '{"trackData":{"bpm":120}}', now, now);
    putItem.run('["disambiguation"]', "midnight city", '{"selectedTrackId":"abc"}', now, now);
    raw
      .prepare(
        "INSERT INTO research_cache (spotify_id, samples_count, trivia_count, full_data, expires_at) VALUES ('r1', 0, 0, ?, unixepoch() + 86400)",
      )
      .run(JSON.stringify({ samples: [], productionTrivia: [], relatedArtists: [] }));
    raw.close();

    const db = initializeDatabase(dbPath);

    const versions = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all();
    expect(versions).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);

    const audioIds = db.prepare("SELECT spotify_id FROM audio_cache").pluck().all();
    expect(audioIds).toEqual(["measured"]);

    const notNull = Object.fromEntries(
      (db.pragma("table_info(audio_cache)") as Array<{ name: string; notnull: number }>).map(
        (c) => [c.name, c.notnull],
      ),
    );
    expect(notNull).toMatchObject({ bpm: 0, key_signature: 0, energy: 0 });

    const namespaces = db.prepare("SELECT namespace FROM store_items").pluck().all();
    expect(namespaces).toEqual(['["disambiguation"]']);
    expect(db.prepare("SELECT COUNT(*) FROM research_cache").pluck().get()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
  });

  it("lets the audio cache store a measurement without energy", () => {
    const cache = new SonicCache(initializeDatabase(setup()));
    cache.putAudio("no-energy", {
      ...audioRow({ measured: true, analyzer: "audio-service", confidence: "low" }),
      energy: null,
    } as Parameters<SonicCache["putAudio"]>[1]);
    expect(cache.getAudio("no-energy")).toMatchObject({ bpm: 120, energy: null });
  });

  it("keeps only audio rows the cache would serve and caps low-confidence expiry at a day", () => {
    const dbPath = setup();
    const raw = new Database(dbPath);
    raw.exec(PRE_MIGRATIONS_SCHEMA);
    const put = raw.prepare(
      "INSERT INTO audio_cache (spotify_id, bpm, key_signature, energy, confidence, full_data, expires_at) VALUES (?, 120, 'C Major', 0.5, ?, ?, unixepoch() + 30 * 86400)",
    );
    const marked = { measured: true, analyzer: "audio-service" };
    put.run("high", "high", JSON.stringify(audioRow(marked)));
    put.run(
      "low",
      "low",
      JSON.stringify(
        audioRow({
          ...marked,
          confidence: "low",
          valence: null,
          danceability: null,
          acousticness: null,
          instrumentalness: null,
        }),
      ),
    );
    put.run("zero-bpm", "high", JSON.stringify(audioRow({ ...marked, bpm: 0 })));
    put.run("no-key", "high", JSON.stringify(audioRow({ ...marked, key: "" })));
    put.run("energy-out-of-range", "high", JSON.stringify(audioRow({ ...marked, energy: 3 })));
    put.run(
      "other-analyzer",
      "high",
      JSON.stringify(audioRow({ measured: true, analyzer: "estimator" })),
    );
    raw.close();

    const db = initializeDatabase(dbPath);
    const rows = db
      .prepare(
        "SELECT spotify_id, expires_at - unixepoch() AS ttl FROM audio_cache ORDER BY spotify_id",
      )
      .all() as Array<{ spotify_id: string; ttl: number }>;
    expect(rows.map((r) => r.spotify_id)).toEqual(["high", "low"]);
    const ttl = Object.fromEntries(rows.map((r) => [r.spotify_id, r.ttl]));
    expect(ttl.high).toBeGreaterThan(29 * 86400);
    expect(ttl.low).toBeLessThanOrEqual(86400);
    expect(ttl.low).toBeGreaterThan(86400 - 60);
  });

  it("refuses to start when a recorded migration has another name than this code's", () => {
    const dbPath = setup();
    initializeDatabase(dbPath);
    closeDatabase();
    const raw = new Database(dbPath);
    raw.prepare("UPDATE schema_migrations SET name = 'something_else' WHERE version = 2").run();
    raw.close();
    const before = readFileSync(dbPath);

    const err = thrown(() => initializeDatabase(dbPath));
    expect(err.kind).toBe("schema_mismatch");
    expect(err.message).toContain('recorded as "something_else"');
    expect(err.message).toContain('"runs"');
    expect(readFileSync(dbPath).equals(before)).toBe(true);
  });

  it("says which migrations were applied when a later one fails", () => {
    const dbPath = setup();
    const raw = new Database(dbPath);
    raw.exec(PRE_MIGRATIONS_SCHEMA);
    // Makes migration 3 fail: the table it creates already exists.
    raw.exec("CREATE TABLE audio_cache_new (x)");
    raw.close();

    const err = thrown(() => initializeDatabase(dbPath));
    expect(err.name).toBe("DatabaseOpenError");
    expect(err.message).toContain("migration 3 (measured_audio_cache) failed");
    expect(err.message).toContain("Migration 3 was rolled back");
    expect(err.message).toContain("Migrations 1, 2 were applied");
    expect(err.message).not.toContain("left untouched");
    const check = new Database(dbPath, { readonly: true });
    expect(check.prepare("SELECT version FROM schema_migrations").pluck().all()).toEqual([1, 2]);
    check.close();
  });

  it("runs each migration once", () => {
    const dbPath = setup();
    initializeDatabase(dbPath);
    const before = getDb().prepare("SELECT version, applied_at FROM schema_migrations").all();
    closeDatabase();

    const db = initializeDatabase(dbPath);
    expect(db.prepare("SELECT version, applied_at FROM schema_migrations").all()).toEqual(before);
    expect(runMigrations(db)).toEqual([]);
  });

  it("rolls a failing migration back and keeps the earlier ones", () => {
    const db = new Database(":memory:");
    const broken: Migration[] = [
      MIGRATIONS[0],
      {
        version: 2,
        name: "broken",
        up(d) {
          d.exec("CREATE TABLE half_done (x)");
          throw new Error("migration failed halfway");
        },
      },
    ];
    expect(() => runMigrations(db, broken)).toThrow("migration failed halfway");
    expect(db.prepare("SELECT version FROM schema_migrations").pluck().all()).toEqual([1]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get()).toBe(
      undefined,
    );
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    db.close();
  });

  it("lets two processes migrate the same file at once, applying each migration once", async () => {
    const dbPath = setup();
    const script = join(tmpDir, "migrate.mts");
    const migrationsPath = join(apiRoot, "src", "store", "migrations.ts");
    writeFileSync(
      script,
      `import { runMigrations } from ${JSON.stringify(migrationsPath)};
       import BetterSqlite from ${JSON.stringify(betterSqlitePath)};
       const [dbPath, startAt] = process.argv.slice(2);
       const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
       const slow = (version: number, table: string) => ({
         version,
         name: "slow_" + table,
         up(db: any) {
           sleep(400);
           db.exec("CREATE TABLE IF NOT EXISTS " + table + " (x)");
         },
       });
       const db = new BetterSqlite(dbPath, { timeout: 10000 });
       if (db.pragma("journal_mode", { simple: true }) !== "wal") throw new Error("not in WAL mode");
       while (Date.now() < Number(startAt)) {}
       runMigrations(db, [slow(1, "one"), slow(2, "two")]);
       db.close();`,
    );
    // The file is switched to WAL before the processes start. Two connections switching a new
    // file at once get SQLITE_BUSY at once, without waiting for the busy timeout; that race is
    // not what this test is about.
    const init = new Database(dbPath);
    init.pragma("journal_mode = WAL");
    init.close();
    const startAt = String(Date.now() + 4000);
    const runOne = () =>
      new Promise<{ code: number | null; stderr: string }>((done) => {
        const child = spawn(process.execPath, ["--import", "tsx", script, dbPath, startAt], {
          cwd: repoRoot,
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("close", (code) => done({ code, stderr }));
      });

    const results = await Promise.all([runOne(), runOne()]);
    expect(
      results.map((r) => r.code),
      results.map((r) => r.stderr).join("\n"),
    ).toEqual([0, 0]);
    const db = new Database(dbPath, { readonly: true });
    expect(
      db.prepare("SELECT version, name FROM schema_migrations ORDER BY version").all(),
    ).toEqual([
      { version: 1, name: "slow_one" },
      { version: 2, name: "slow_two" },
    ]);
    db.close();
  }, 60_000);

  it("requires migrations numbered 1..n in order", () => {
    const db = new Database(":memory:");
    expect(() => runMigrations(db, [MIGRATIONS[1]])).toThrow(/numbered 1\.\.n/);
    db.close();
  });
});
