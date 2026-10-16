/**
 * Tests for database.ts, store.ts, and cache.ts
 * Run: npm run test:db -w apps/api
 */

import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { initializeDatabase, closeDatabase, isDatabaseHealthy, getDb } from "./database.js";
import { SqliteStore } from "./store.js";
import { SonicCache } from "./cache.js";

// =============================================================================
// Test Helpers
// =============================================================================

let tmpDir: string;
let testCount = 0;
let passCount = 0;
let failCount = 0;

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
  testCount++;
  if (condition) {
    passCount++;
    console.log(`  ✅ ${message}`);
  } else {
    failCount++;
    console.error(`  ❌ ${message}`);
  }
}

function assertEqual<T>(actual: T, expected: T, message: string): void {
  testCount++;
  if (actual === expected) {
    passCount++;
    console.log(`  ✅ ${message}`);
  } else {
    failCount++;
    console.error(
      `  ❌ ${message} (expected: ${JSON.stringify(expected)}, got: ${JSON.stringify(actual)})`,
    );
  }
}

// =============================================================================
// Test 1: Database Initialization & Health
// =============================================================================

async function testDbInitialization(): Promise<void> {
  console.log("\n📦 Test 1: Database Initialization & Health");
  const dbPath = setup();

  try {
    const db = initializeDatabase(dbPath);
    assert(db != null, "Database instance returned");
    assert(isDatabaseHealthy(), "Database is healthy");

    // Check WAL mode
    const journalMode = db.pragma("journal_mode", { simple: true });
    assertEqual(journalMode, "wal", "WAL mode enabled");

    // Check user_version
    const version = db.pragma("user_version", { simple: true }) as number;
    assertEqual(version, 1, "Schema version is 1");
  } finally {
    cleanup();
  }
}

// =============================================================================
// Test 2: Schema Versioning (re-open sees correct version)
// =============================================================================

async function testSchemaVersioning(): Promise<void> {
  console.log("\n📦 Test 2: Schema Versioning");
  const dbPath = setup();

  try {
    // First open
    initializeDatabase(dbPath);
    const version1 = getDb().pragma("user_version", { simple: true }) as number;
    assertEqual(version1, 1, "First open: version 1");
    closeDatabase();

    // Second open — should detect version and skip migration
    initializeDatabase(dbPath);
    const version2 = getDb().pragma("user_version", { simple: true }) as number;
    assertEqual(version2, 1, "Second open: still version 1");

    // Tables should exist
    const tables = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);
    assert(tableNames.includes("store_items"), "store_items table exists");
    assert(tableNames.includes("audio_cache"), "audio_cache table exists");
    assert(tableNames.includes("research_cache"), "research_cache table exists");
    assert(tableNames.includes("artwork_cache"), "artwork_cache table exists");
  } finally {
    cleanup();
  }
}

// =============================================================================
// Test 3: SqliteStore — Put/Get/Delete/Search/ListNamespaces
// =============================================================================

async function testSqliteStore(): Promise<void> {
  console.log("\n📦 Test 3: SqliteStore");
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
  console.log("\n📦 Test 4: SqliteStore — Filters");
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
  console.log("\n📦 Test 5: SonicCache — Audio");
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
    };

    // Put and get
    cache.putAudio("spotify-123", audioFeatures);
    const retrieved = cache.getAudio("spotify-123");
    assert(retrieved != null, "Audio cache hit");
    assertEqual(retrieved?.bpm, 105, "BPM matches");
    assertEqual(retrieved?.key, "D Minor", "Key matches");

    // Overwrite protection: don't downgrade high → low
    const lowConfidence = { ...audioFeatures, confidence: "low" as const, bpm: 100 };
    cache.putAudio("spotify-123", lowConfidence);
    const afterDowngrade = cache.getAudio("spotify-123");
    assertEqual(afterDowngrade?.bpm, 105, "High confidence not overwritten by low");

    // Allow upgrade: low → high
    cache.putAudio("spotify-456", { ...audioFeatures, confidence: "low" as const, bpm: 90 });
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
  console.log("\n📦 Test 6: SonicCache — Research & Artwork");
  const dbPath = setup();

  try {
    const db = initializeDatabase(dbPath);
    const cache = new SonicCache(db);

    // Research cache
    const researchData = {
      samples: ["Sample A"],
      productionTrivia: ["Trivia 1", "Trivia 2"],
      songMeaning: [],
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
  console.log("\n📦 Test 7: SonicCache — TTL Expiration");
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
        songMeaning: [],
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
  console.log("\n📦 Test 8: Corruption Recovery");
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
  console.log("\n📦 Test 9: Graceful Degradation after close");
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
  console.log("\n📦 Test 10: Concurrent Writes");
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
      });
    });

    const historianWrite = Promise.resolve().then(() => {
      cache.putResearch("concurrent-1", {
        samples: ["Sample 1"],
        productionTrivia: ["Trivia 1"],
        songMeaning: ["Meaning"],
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

async function runAllTests(): Promise<void> {
  console.log("🧪 Running Sonic Agent Database Tests\n" + "=".repeat(50));

  await testDbInitialization();
  await testSchemaVersioning();
  await testSqliteStore();
  await testSqliteStoreFilters();
  await testSonicCacheAudio();
  await testSonicCacheResearchArtwork();
  await testSonicCacheTTL();
  await testCorruptionRecovery();
  await testGracefulDegradation();
  await testConcurrentWrites();

  console.log("\n" + "=".repeat(50));
  console.log(`Results: ${passCount}/${testCount} passed, ${failCount} failed`);

  if (failCount > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
