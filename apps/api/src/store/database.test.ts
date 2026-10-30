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
import { appendRunEvent, getRun, listRunEvents, startRun, storeRunResult } from "./runs.js";
import { SqliteStore } from "./store.js";
import { SonicCache } from "./cache.js";
import {
  ANALYZER_VERSION,
  audioV2,
  measurementOf,
  signalOnlyV2,
} from "../agent/testing/measuredAudio.js";

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
    assert(tableNames.includes("llm_usage"), "llm_usage table exists");
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

    // Put and get, by track key and analyzer version
    const tempo = (bpm: number) => ({ ...audioV2().tempo!, bpm });
    cache.putAudio("spotify:123", "123", measurementOf(audioV2({ tempo: tempo(105) })));
    const retrieved = cache.getAudio("spotify:123", ANALYZER_VERSION);
    assert(retrieved != null, "Audio cache hit");
    assertEqual(retrieved?.audio.tempo?.bpm, 105, "BPM matches");
    assertEqual(retrieved?.audio.key?.tonic, "D", "Key matches");
    assertEqual(cache.getAudio("spotify:123", "9.9.9"), null, "Another analyzer: a miss");

    // Overwrite protection: don't downgrade high → low (no models: a partial measurement)
    const partial = (bpm: number) =>
      measurementOf(signalOnlyV2({ analyzerVersion: ANALYZER_VERSION, tempo: tempo(bpm) }));
    cache.putAudio("spotify:123", "123", partial(100));
    const afterDowngrade = cache.getAudio("spotify:123", ANALYZER_VERSION);
    assertEqual(afterDowngrade?.audio.tempo?.bpm, 105, "High confidence not overwritten by low");

    // Allow upgrade: low → high
    cache.putAudio("spotify:456", "456", partial(90));
    cache.putAudio("spotify:456", "456", measurementOf(audioV2({ tempo: tempo(95) })));
    const upgraded = cache.getAudio("spotify:456", ANALYZER_VERSION);
    assertEqual(upgraded?.audio.tempo?.bpm, 95, "Low confidence overwritten by high");

    // Missing key
    assertEqual(cache.getAudio("spotify:none", ANALYZER_VERSION), null, "Missing audio is null");
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
    };
    cache.putResearch("spotify-789", researchData);
    const research = cache.getResearch("spotify-789");
    assert(research != null, "Research cache hit");
    assertEqual(research?.samples?.length, 1, "Research samples count matches");

    // Artwork cache
    const artwork = {
      coverUrl: "https://i.scdn.co/image/test",
      spotifyUrl: "https://open.spotify.com/track/abc",
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
    cache.putAudio("spotify:expired-1", "expired-1", measurementOf(), 0);

    // Should be expired
    const expired = cache.getAudio("spotify:expired-1", ANALYZER_VERSION);
    assertEqual(expired, null, "Expired audio entry returns null");

    // Purge expired
    cache.putResearch(
      "expired-r",
      {
        samples: [],
        productionTrivia: [],
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
      cache.putAudio("spotify:concurrent-1", "concurrent-1", measurementOf());
    });

    const historianWrite = Promise.resolve().then(() => {
      cache.putResearch("concurrent-1", {
        samples: ["Sample 1"],
        productionTrivia: ["Trivia 1"],
      });
    });

    const storeWrite = Promise.resolve().then(async () => {
      await store.put(["tracks"], "concurrent-1", { title: "Test", timestamp: Date.now() });
    });

    // All writes should succeed without deadlock
    await Promise.all([engineerWrite, historianWrite, storeWrite]);

    // Verify all data persisted
    const audio = cache.getAudio("spotify:concurrent-1", ANALYZER_VERSION);
    const research = cache.getResearch("concurrent-1");
    const storeItem = await store.get(["tracks"], "concurrent-1");

    assert(audio != null, "Concurrent audio write succeeded");
    assert(research != null, "Concurrent research write succeeded");
    assert(storeItem != null, "Concurrent store write succeeded");
    assertEqual(audio?.audio.tempo?.bpm, 115.8, "Audio data correct after concurrent write");
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
const FIXTURES = join(apiRoot, "test", "fixtures");

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
            LOG_LEVEL: "info",
            LOG_FILE: "",
          },
        });
      } finally {
        chmodSync(dbPath, 0o644);
      }
      expect(result.status).toBe(1);
      // The log is JSON lines on stdout.
      const failure = String(result.stdout)
        .split("\n")
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as { component?: string; msg?: string })
        .find((entry) => entry.component === "Database");
      expect(failure?.msg).toContain("Cannot open database");
      expect(failure?.msg).toContain("left untouched");
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

  it("sets up the checkpoint tables at startup, adding task_path to those of checkpoint-sqlite 1.0", () => {
    const columns = (db: Database.Database) =>
      (db.prepare("PRAGMA table_info(writes)").all() as Array<{ name: string }>).map(
        ({ name }) => name,
      );
    const dbPath = setup();
    const raw = new Database(dbPath);
    raw.exec(readFileSync(join(FIXTURES, "checkpoints-sqlite-1.0.4.sql"), "utf8"));
    expect(columns(raw)).not.toContain("task_path");
    raw.close();

    const db = initializeDatabase(dbPath);

    expect(columns(db)).toContain("task_path");
    // The rows saved before keep their values, with no path.
    expect(
      db.prepare("SELECT DISTINCT task_path FROM writes WHERE thread_id = 't-paused-1.0'").all(),
    ).toEqual([{ task_path: "" }]);
    expect(db.prepare("SELECT COUNT(*) FROM writes").pluck().get()).toBe(8);

    // A new database has the saver's tables from the start too.
    closeDatabase();
    const fresh = initializeDatabase(join(tmpDir, "fresh.db"));
    expect(columns(fresh)).toContain("task_path");
  });

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
      .run(JSON.stringify({ samples: [], productionTrivia: [] }));
    raw.close();

    const db = initializeDatabase(dbPath);

    const versions = db
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all();
    expect(versions).toEqual(MIGRATIONS.map((m) => ({ version: m.version, name: m.name })));
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);

    // Migration 3 kept the marked row only (see below); migration 14 dropped it with every other
    // flat row: none of them holds a v2 block.
    expect(db.prepare("SELECT COUNT(*) FROM audio_cache").pluck().get()).toBe(0);

    const namespaces = db.prepare("SELECT namespace FROM store_items").pluck().all();
    // Track choices of earlier versions are deleted too (migration 8).
    expect(namespaces).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) FROM research_cache").pluck().get()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
  });

  it("drops the flat audio rows and files measurements by track and analyzer version (migration 14)", () => {
    const migration = MIGRATIONS.findIndex((m) => m.name === "audio_cache_by_analyzer");
    expect(MIGRATIONS[migration].version).toBe(14);
    const dbPath = setup();
    const raw = new Database(dbPath);
    runMigrations(raw, MIGRATIONS.slice(0, migration));
    raw
      .prepare(
        "INSERT INTO audio_cache (spotify_id, bpm, key_signature, energy, confidence, full_data, expires_at) VALUES ('sp1', 120, 'C Major', 0.5, 'high', ?, unixepoch() + 86400)",
      )
      .run(JSON.stringify(audioRow({ measured: true, analyzer: "audio-service" })));
    raw.close();

    const db = initializeDatabase(dbPath);
    expect(db.prepare("SELECT COUNT(*) FROM audio_cache").pluck().get()).toBe(0);
    const columns = db.pragma("table_info(audio_cache)") as Array<{ name: string; pk: number }>;
    expect(
      columns
        .filter((c) => c.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((c) => c.name),
    ).toEqual(["track_key", "analyzer_version"]);

    const cache = new SonicCache(db);
    cache.putAudio("isrc:USSB29000129", "sp1", measurementOf());
    expect(cache.getAudio("spotify:sp1", ANALYZER_VERSION)).toBeNull();
    expect(cache.getAudio("isrc:USSB29000129", ANALYZER_VERSION)).toEqual(measurementOf());
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
    // Up to the migration before 14, which drops these flat rows altogether.
    runMigrations(raw, MIGRATIONS.slice(0, 13));

    const db = raw;
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
    db.close();
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

  it("adds run results and events to an existing database, keeping its runs", () => {
    const resultsMigration = MIGRATIONS.findIndex((m) => m.name === "run_results");
    expect(resultsMigration).toBeGreaterThan(0);
    const dbPath = setup();
    const raw = new Database(dbPath);
    runMigrations(raw, MIGRATIONS.slice(0, resultsMigration));
    raw
      .prepare(
        "INSERT INTO runs (run_id, thread_id, query, status, created_at, finished_at) VALUES ('old', 'old', 'typed', 'completed', 100, 200)",
      )
      .run();
    raw.close();

    const db = initializeDatabase(dbPath);
    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(getRun(db, "old")).toMatchObject({
      status: "completed",
      finishedAt: 200,
      spotifyId: null,
      mode: "live",
      analysis: null,
    });

    const analysis = {
      id: "4uLU6hMCjMI75M1A2tKUQC",
      title: "T",
      artist: "A",
      album: "B",
      coverUrl: "",
      bpm: null,
      genealogy: { nodes: [], links: [] },
      run: { id: "old", mode: "live", recordedAt: null, commit: null, analyzerVersion: null },
    };
    expect(storeRunResult(db, "old", analysis)).toBe("stored");
    expect(getRun(db, "old")).toMatchObject({ spotifyId: analysis.id, analysis });

    // A resumed run's second stream numbers its events from 0 again.
    appendRunEvent(db, "old", 0, { seq: 0 });
    appendRunEvent(db, "old", 1, { seq: 0 });
    expect(() => appendRunEvent(db, "old", 1, { seq: 0 })).toThrow(/UNIQUE/);
    expect(listRunEvents(db, "old").map((e) => [e.stream, e.seq])).toEqual([
      [0, 0],
      [1, 0],
    ]);
  });

  it("clears stored preview URLs and drops results stored under the search text", () => {
    const migration = MIGRATIONS.findIndex((m) => m.name === "no_stored_previews");
    expect(migration).toBeGreaterThan(0);
    const dbPath = setup();
    const raw = new Database(dbPath);
    runMigrations(raw, MIGRATIONS.slice(0, migration));
    // What the code before this migration wrote: Spotify's preview in the artwork cache, and
    // results keyed by the search text, one of them from before stored results lost their
    // preview URLs.
    raw
      .prepare(
        `INSERT INTO artwork_cache (search_key, cover_url, spotify_url, preview_url, spotify_id, track_title, track_artist, expires_at)
         VALUES ('under pressure - queen', 'https://i.scdn.co/image/c', 'https://open.spotify.com/track/u', 'https://p.scdn.co/mp3-preview/u', 'u', 'Under Pressure', 'Queen', unixepoch() + 86400)`,
      )
      .run();
    const now = new Date().toISOString();
    const putItem = raw.prepare("INSERT INTO store_items VALUES (?, ?, ?, ?, ?)");
    const oldResult = JSON.stringify({ trackData: { id: "x", previewUrl: "https://p.scdn.co/x" } });
    putItem.run('["tracks","v3"]', "midnight city|lastfm=0:tavily=0", oldResult, now, now);
    putItem.run('["tracks","v2"]', "midnight city", oldResult, now, now);
    // Written under the plain namespace after migration 3 ran, until results were versioned.
    putItem.run('["tracks"]', "midnight city", oldResult, now, now);
    // A result keyed by track (this code's namespace) is kept.
    const byTrack = JSON.stringify({ trackData: { id: "x" }, timestamp: 1 });
    putItem.run('["tracks","v4"]', "x|lastfm=0:tavily=0", byTrack, now, now);
    putItem.run('["disambiguation"]', "midnight city", '{"selectedTrackId":"abc"}', now, now);
    const storedPreviews = (db: Database.Database) => [
      db
        .prepare("select count(*) n from artwork_cache where preview_url is not null")
        .pluck()
        .get(),
      db
        .prepare(
          "select count(*) n from store_items where namespace like '%tracks%' and value like '%previewUrl%'",
        )
        .pluck()
        .get(),
    ];
    expect(storedPreviews(raw)).toEqual([1, 3]);
    raw.close();

    const db = initializeDatabase(dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(storedPreviews(db)).toEqual([0, 0]);
    // The artwork itself is kept; only the preview is gone.
    expect(new SonicCache(db).getArtwork("under pressure - queen")).toEqual({
      coverUrl: "https://i.scdn.co/image/c",
      spotifyUrl: "https://open.spotify.com/track/u",
      spotifyId: "u",
      trackTitle: "Under Pressure",
      trackArtist: "Queen",
    });
    expect(
      db.prepare("SELECT namespace FROM store_items ORDER BY namespace").pluck().all(),
    ).toEqual(['["tracks","v4"]']);
  });

  it("keeps the commit a run ran at; runs stored before say none", () => {
    const migration = MIGRATIONS.findIndex((m) => m.name === "run_commit");
    expect(MIGRATIONS[migration].version).toBe(7);
    const dbPath = setup();
    const raw = new Database(dbPath);
    runMigrations(raw, MIGRATIONS.slice(0, migration));
    raw
      .prepare(
        "INSERT INTO runs (run_id, thread_id, query, status, created_at) VALUES ('old', 'old', 'q', 'completed', 1)",
      )
      .run();
    raw.close();
    const db = initializeDatabase(dbPath);
    expect(getRun(db, "old")).toMatchObject({ commit: null });
    startRun(db, { runId: "new", threadId: "new", query: "q", commit: "abc123def456-dirty" });
    expect(getRun(db, "new")).toMatchObject({ commit: "abc123def456-dirty" });
    startRun(db, { runId: "unknown", threadId: "unknown", query: "q" });
    expect(getRun(db, "unknown")).toMatchObject({ commit: null });
  });

  it("deletes the track choices earlier versions remembered for every user", () => {
    const migration = MIGRATIONS.findIndex((m) => m.name === "no_remembered_choices");
    expect(migration).toBeGreaterThan(0);
    const dbPath = setup();
    const raw = new Database(dbPath);
    runMigrations(raw, MIGRATIONS.slice(0, migration));
    const now = new Date().toISOString();
    const putItem = raw.prepare("INSERT INTO store_items VALUES (?, ?, ?, ?, ?)");
    putItem.run('["disambiguation"]', "hurt", '{"selectedTrackId":"abc"}', now, now);
    putItem.run('["tracks","v4"]', "x|lastfm=0:tavily=0", '{"trackData":{}}', now, now);
    raw.close();

    const db = initializeDatabase(dbPath);

    expect(db.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(db.prepare("SELECT namespace FROM store_items").pluck().all()).toEqual([
      '["tracks","v4"]',
    ]);
  });

  it("adds the credited artists to the artwork cache, keeping the rows it has", () => {
    const migration = MIGRATIONS.findIndex((m) => m.name === "artwork_credits");
    expect(migration).toBeGreaterThan(0);
    const dbPath = setup();
    const raw = new Database(dbPath);
    runMigrations(raw, MIGRATIONS.slice(0, migration));
    raw
      .prepare(
        `INSERT INTO artwork_cache (search_key, cover_url, spotify_id, track_title, track_artist, expires_at)
         VALUES ('under pressure - queen', 'https://i.scdn.co/image/c', 'u', 'Under Pressure', 'Queen', unixepoch() + 86400)`,
      )
      .run();
    raw.close();

    const db = initializeDatabase(dbPath);
    const cache = new SonicCache(db);

    expect(cache.getArtwork("under pressure - queen")).toMatchObject({ trackArtist: "Queen" });
    expect(cache.getArtwork("under pressure - queen")).not.toHaveProperty("trackArtists");
    cache.putArtwork("under pressure - queen", {
      coverUrl: "https://i.scdn.co/image/c",
      spotifyUrl: null,
      spotifyId: "u",
      trackTitle: "Under Pressure",
      trackArtist: "Queen",
      trackArtists: ["Queen", "David Bowie"],
    });
    expect(cache.getArtwork("under pressure - queen")?.trackArtists).toEqual([
      "Queen",
      "David Bowie",
    ]);
  });

  it("adds the track details to the artwork cache; the rows it has keep none", () => {
    const migration = MIGRATIONS.findIndex((m) => m.name === "artwork_track_details");
    expect(MIGRATIONS[migration].version).toBe(13);
    const dbPath = setup();
    const raw = new Database(dbPath);
    runMigrations(raw, MIGRATIONS.slice(0, migration));
    raw
      .prepare(
        `INSERT INTO artwork_cache (search_key, cover_url, spotify_id, track_title, track_artist, track_artists, expires_at)
         VALUES ('under pressure - queen', 'https://i.scdn.co/image/c', 'u', 'Under Pressure', 'Queen', '["Queen"]', unixepoch() + 86400)`,
      )
      .run();
    raw.close();

    const db = initializeDatabase(dbPath);
    const cache = new SonicCache(db);

    expect(cache.getArtwork("under pressure - queen")).toEqual({
      coverUrl: "https://i.scdn.co/image/c",
      spotifyUrl: null,
      spotifyId: "u",
      trackTitle: "Under Pressure",
      trackArtist: "Queen",
      trackArtists: ["Queen"],
    });
    const details = {
      isrc: "GBUM71029601",
      durationMs: 248000,
      album: "Hot Space",
      releaseDate: "1982-05-21",
    };
    cache.putArtwork("under pressure - queen", {
      coverUrl: "https://i.scdn.co/image/c",
      spotifyUrl: null,
      spotifyId: "u",
      trackTitle: "Under Pressure",
      trackArtist: "Queen",
      trackDetails: details,
    });
    expect(cache.getArtwork("under pressure - queen")?.trackDetails).toEqual(details);
  });

  it("adds the runs' evidence column, filled from each stored result's pack", () => {
    const migration = MIGRATIONS.findIndex((m) => m.name === "run_evidence");
    expect(MIGRATIONS[migration].version).toBe(10);
    const dbPath = setup();
    const raw = new Database(dbPath);
    runMigrations(raw, MIGRATIONS.slice(0, migration));
    const insert = raw.prepare(
      "INSERT INTO runs (run_id, thread_id, query, status, created_at, analysis) VALUES (?, ?, 'q', 'completed', 1, ?)",
    );
    const item = { id: "tavily:https://example.test/", source: "tavily" };
    insert.run("cited", "cited", JSON.stringify({ id: "x", evidence: [item] }));
    insert.run("empty", "empty", JSON.stringify({ id: "x", evidence: [] }));
    insert.run("older", "older", JSON.stringify({ id: "x" }));
    insert.run("broken", "broken", "{not json");
    insert.run("open", "open", null);
    raw.close();

    const db = initializeDatabase(dbPath);
    const evidence = (id: string) =>
      db.prepare("SELECT evidence FROM runs WHERE run_id = ?").pluck().get(id);

    expect(JSON.parse(evidence("cited") as string)).toEqual([item]);
    expect(evidence("empty")).toBe("[]");
    for (const id of ["older", "broken", "open"]) expect(evidence(id)).toBeNull();
  });

  it("requires migrations numbered 1..n in order", () => {
    const db = new Database(":memory:");
    expect(() => runMigrations(db, [MIGRATIONS[1]])).toThrow(/numbered 1\.\.n/);
    db.close();
  });
});
