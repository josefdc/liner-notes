import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { runMigrations } from "./migrations.js";
import {
  DEFAULT_RETENTION,
  pruneDatabase,
  RETENTION_INTERVAL_MS,
  retentionFromEnv,
  startRetention,
} from "./retention.js";
import { getRun, startRun, updateRun } from "./runs.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);

describe("pruneDatabase", () => {
  let db: Database.Database;
  let saver: SqliteSaver;

  beforeEach(() => {
    db = new Database(":memory:");
    runMigrations(db);
    saver = new SqliteSaver(db);
  });
  afterEach(() => {
    vi.useRealTimers();
    db.close();
  });

  /** Stores one checkpoint (and one pending write) for `threadId` dated `at`. */
  async function checkpointAt(threadId: string, at: number): Promise<void> {
    const checkpoint = { ...emptyCheckpoint(), ts: new Date(at).toISOString() };
    const config = await saver.put(
      { configurable: { thread_id: threadId, checkpoint_ns: "" } },
      checkpoint,
      { source: "input", step: 1, parents: {} },
    );
    await saver.putWrites(config, [["channel", { v: 1 }]], "task-1");
  }

  const threads = () =>
    db.prepare("SELECT DISTINCT thread_id FROM checkpoints ORDER BY thread_id").pluck().all();
  const writeThreads = () =>
    db.prepare("SELECT DISTINCT thread_id FROM writes ORDER BY thread_id").pluck().all();

  /** Inserts a run with explicit times (unix seconds from ms). */
  function runAt(runId: string, threadId: string, createdMs: number, finishedMs: number | null) {
    db.prepare(
      "INSERT INTO runs (run_id, thread_id, query, status, created_at, finished_at) VALUES (?, ?, 'q', ?, ?, ?)",
    ).run(
      runId,
      threadId,
      finishedMs == null ? "running" : "completed",
      Math.floor(createdMs / 1000),
      finishedMs == null ? null : Math.floor(finishedMs / 1000),
    );
  }

  it("deletes checkpoints and writes of threads idle longer than the retention", async () => {
    await checkpointAt("idle", NOW - 2 * DAY);
    await checkpointAt("recent", NOW - HOUR);

    const result = pruneDatabase(db, DEFAULT_RETENTION, NOW);

    expect(result).toMatchObject({ threads: 1, checkpoints: 1, writes: 1 });
    expect(threads()).toEqual(["recent"]);
    expect(writeThreads()).toEqual(["recent"]);
  });

  it("uses run records: a recently finished run keeps its thread, an old one does not", async () => {
    await checkpointAt("finished-recently", NOW - 3 * DAY);
    runAt("r1", "finished-recently", NOW - 3 * DAY, NOW - HOUR);
    await checkpointAt("finished-long-ago", NOW - 3 * DAY);
    runAt("r2", "finished-long-ago", NOW - 3 * DAY, NOW - 2 * DAY);

    pruneDatabase(db, DEFAULT_RETENTION, NOW);

    expect(threads()).toEqual(["finished-recently"]);
  });

  it("keeps a thread whose activity time cannot be read", async () => {
    await saver.getTuple({ configurable: { thread_id: "none" } }); // creates the tables
    db.prepare(
      "INSERT INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, type, checkpoint, metadata) VALUES ('opaque', '', 'c1', 'msgpack', x'00', x'00')",
    ).run();
    pruneDatabase(db, DEFAULT_RETENTION, NOW + 365 * DAY);
    expect(threads()).toEqual(["opaque"]);
  });

  it("deletes store items not updated within the store retention", () => {
    const put = db.prepare("INSERT INTO store_items VALUES (?, ?, '{}', ?, ?)");
    const iso = (ms: number) => new Date(ms).toISOString();
    put.run('["tracks"]', "old", iso(NOW - 40 * DAY), iso(NOW - 31 * DAY));
    put.run('["tracks"]', "fresh", iso(NOW - 40 * DAY), iso(NOW - 29 * DAY));

    const result = pruneDatabase(db, DEFAULT_RETENTION, NOW);

    expect(result.storeItems).toBe(1);
    expect(db.prepare("SELECT key FROM store_items").pluck().all()).toEqual(["fresh"]);
  });

  it("deletes run records older than the run retention", () => {
    runAt("finished-old", "t1", NOW - 40 * DAY, NOW - 31 * DAY);
    runAt("finished-new", "t2", NOW - 40 * DAY, NOW - 29 * DAY);
    runAt("never-finished-old", "t3", NOW - 31 * DAY, null);
    runAt("running", "t4", NOW - HOUR, null);

    const result = pruneDatabase(db, DEFAULT_RETENTION, NOW);

    expect(result.runs).toBe(2);
    expect(db.prepare("SELECT run_id FROM runs ORDER BY run_id").pluck().all()).toEqual([
      "finished-new",
      "running",
    ]);
  });

  it("honours a shorter run retention", () => {
    runAt("week-old", "t1", NOW - 8 * DAY, NOW - 7 * DAY);
    pruneDatabase(db, { ...DEFAULT_RETENTION, runRetentionMs: 5 * DAY }, NOW);
    expect(db.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
  });

  it("works before the checkpointer has created its tables", () => {
    const fresh = new Database(":memory:");
    runMigrations(fresh);
    expect(pruneDatabase(fresh, DEFAULT_RETENTION, NOW)).toEqual({
      threads: 0,
      checkpoints: 0,
      writes: 0,
      storeItems: 0,
      runs: 0,
    });
    fresh.close();
  });
});

describe("startRetention", () => {
  afterEach(() => vi.useRealTimers());

  it("prunes at start and then every hour, and purges the cache each time", () => {
    vi.useFakeTimers({ now: NOW });
    const db = new Database(":memory:");
    runMigrations(db);
    const insertRun = db.prepare(
      "INSERT INTO runs (run_id, thread_id, query, status, created_at, finished_at) VALUES (?, 't', 'q', 'completed', ?, ?)",
    );
    const sec = (ms: number) => Math.floor(ms / 1000);
    const runIds = () => db.prepare("SELECT run_id FROM runs ORDER BY run_id").pluck().all();
    // Past the 30-day run retention now; another that passes it 30 minutes from now.
    insertRun.run("expired", sec(NOW - 31 * DAY), sec(NOW - 31 * DAY));
    insertRun.run("expires-soon", sec(NOW - 31 * DAY), sec(NOW - 30 * DAY + 30 * 60 * 1000));
    const cache = { purgeExpired: vi.fn() };

    const stop = startRetention(db, cache);
    expect(runIds()).toEqual(["expires-soon"]);
    expect(cache.purgeExpired).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(RETENTION_INTERVAL_MS);
    expect(runIds()).toEqual([]);
    expect(cache.purgeExpired).toHaveBeenCalledTimes(2);

    stop();
    insertRun.run("after-stop", sec(NOW - 40 * DAY), sec(NOW - 40 * DAY));
    vi.advanceTimersByTime(2 * RETENTION_INTERVAL_MS);
    expect(runIds()).toEqual(["after-stop"]);
    db.close();
  });

  it("keeps pruning when the cache purge fails", () => {
    vi.useFakeTimers({ now: NOW });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = new Database(":memory:");
    runMigrations(db);
    db.prepare(
      "INSERT INTO runs (run_id, thread_id, query, status, created_at) VALUES ('old', 't', 'q', 'running', ?)",
    ).run(Math.floor((NOW - 40 * DAY) / 1000));
    const stop = startRetention(db, {
      purgeExpired: () => {
        throw new Error("purge failed");
      },
    });
    expect(db.prepare("SELECT COUNT(*) FROM runs").pluck().get()).toBe(0);
    expect(error).toHaveBeenCalledWith("[Retention] Cache purge failed:", expect.any(Error));
    stop();
    error.mockRestore();
    db.close();
  });
});

describe("retentionFromEnv", () => {
  it("defaults to 24 hours for checkpoints and 30 days for store items and runs", () => {
    expect(retentionFromEnv({})).toEqual({
      checkpointRetentionMs: 24 * HOUR,
      storeRetentionMs: 30 * DAY,
      runRetentionMs: 30 * DAY,
    });
  });

  it("reads overrides and ignores invalid values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(
      retentionFromEnv({
        CHECKPOINT_RETENTION_HOURS: "6",
        STORE_RETENTION_DAYS: "abc",
        RUN_RETENTION_DAYS: "7",
      }),
    ).toEqual({
      checkpointRetentionMs: 6 * HOUR,
      storeRetentionMs: 30 * DAY,
      runRetentionMs: 7 * DAY,
    });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("STORE_RETENTION_DAYS"));
    warn.mockRestore();
  });
});

describe("run records", () => {
  it("records a run's start, flags and final status", () => {
    const db = new Database(":memory:");
    runMigrations(db);

    startRun(db, { runId: "run-1", threadId: "thread-1", query: "Midnight City M83" });
    expect(getRun(db, "run-1")).toMatchObject({
      status: "running",
      finishedAt: null,
      modelAvailable: null,
      audioAvailable: null,
      payload: null,
    });

    updateRun(db, "run-1", { status: "interrupted" });
    expect(getRun(db, "run-1")?.finishedAt).toBeNull();

    expect(
      updateRun(db, "run-1", {
        status: "completed",
        modelAvailable: true,
        audioAvailable: false,
        payload: { audioUnavailableReason: "no_preview" },
      }),
    ).toBe(true);
    const done = getRun(db, "run-1");
    expect(done).toMatchObject({
      threadId: "thread-1",
      status: "completed",
      modelAvailable: true,
      audioAvailable: false,
      payload: { audioUnavailableReason: "no_preview" },
    });
    expect(done?.finishedAt).toBeTypeOf("number");

    updateRun(db, "run-1", { status: "failed" });
    expect(getRun(db, "run-1")).toMatchObject({ modelAvailable: true, audioAvailable: false });
    expect(updateRun(db, "missing", { status: "failed" })).toBe(false);
    db.close();
  });
});
