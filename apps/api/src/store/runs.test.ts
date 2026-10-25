import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Annotation, Command, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runMigrations } from "./migrations.js";
import {
  appendRunEvent,
  EVENT_BUSY_TIMEOUT_MS,
  getRun,
  latestRunsForTrack,
  settleOpenRuns,
  startRun,
  storeReplayOf,
  storeRunResult,
  updateRun,
  withoutPreviewUrls,
} from "./runs.js";
import { isWaitingAtInterrupt } from "./threads.js";

/** A one-node graph that pauses for a choice when the query is "ambiguous". */
function pausingGraph(db: Database.Database) {
  const State = Annotation.Root({
    query: Annotation<string>(),
    choice: Annotation<string | undefined>(),
  });
  return new StateGraph(State)
    .addNode("clarification", (state) =>
      state.query === "ambiguous"
        ? { choice: interrupt({ candidates: [{ id: "a" }, { id: "b" }] }) as string }
        : { choice: "only" },
    )
    .addEdge(START, "clarification")
    .addEdge("clarification", END)
    .compile({ checkpointer: new SqliteSaver(db) });
}

const thread = (id: string) => ({ configurable: { thread_id: id } });

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
});

describe("isWaitingAtInterrupt", () => {
  it("is true only while the thread is paused at the interrupt", async () => {
    const graph = pausingGraph(db);
    await graph.invoke({ query: "ambiguous" }, thread("paused"));
    await graph.invoke({ query: "clear" }, thread("finished"));

    expect(await isWaitingAtInterrupt(db, "paused")).toBe(true);
    expect(await isWaitingAtInterrupt(db, "finished")).toBe(false);
    expect(await isWaitingAtInterrupt(db, "unknown")).toBe(false);

    await graph.invoke(new Command({ resume: "a" }), thread("paused"));
    expect(await isWaitingAtInterrupt(db, "paused")).toBe(false);
  });
});

describe("isWaitingAtInterrupt, from the checkpoint alone", () => {
  /** Saves one checkpoint for the thread with a pending write on `channel`. */
  async function pendingWrite(threadId: string, channel: string) {
    const saver = new SqliteSaver(db);
    const config = await saver.put(
      { configurable: { thread_id: threadId, checkpoint_ns: "" } },
      emptyCheckpoint(),
      { source: "loop", step: 1, parents: {} },
    );
    await saver.putWrites(config, [[channel, { value: "x" }]], "task-1");
  }

  it("is true for a pending __interrupt__ write and false for any other pending write", async () => {
    await pendingWrite("interrupted", "__interrupt__");
    await pendingWrite("writing", "query");
    await pendingWrite("erred", "__error__");

    expect(await isWaitingAtInterrupt(db, "interrupted")).toBe(true);
    expect(await isWaitingAtInterrupt(db, "writing")).toBe(false);
    expect(await isWaitingAtInterrupt(db, "erred")).toBe(false);
  });
});

describe("settleOpenRuns", () => {
  it("marks open runs interrupted when their thread waits for a choice, otherwise cancelled", async () => {
    const graph = pausingGraph(db);
    await graph.invoke({ query: "ambiguous" }, thread("paused"));
    await graph.invoke({ query: "clear" }, thread("finished"));
    startRun(db, { runId: "paused", threadId: "paused", query: "ambiguous" });
    startRun(db, { runId: "finished", threadId: "finished", query: "clear" });
    startRun(db, { runId: "lost", threadId: "lost", query: "q" });
    startRun(db, { runId: "done", threadId: "done", query: "q" });
    updateRun(db, "done", { status: "completed" });
    const doneBefore = getRun(db, "done");

    const settled = await settleOpenRuns(db, (threadId) => isWaitingAtInterrupt(db, threadId));

    expect(settled).toEqual({ interrupted: 1, cancelled: 2 });
    expect(getRun(db, "paused")).toMatchObject({ status: "interrupted", finishedAt: null });
    expect(getRun(db, "finished")).toMatchObject({ status: "cancelled" });
    expect(getRun(db, "finished")?.finishedAt).toEqual(expect.any(Number));
    expect(getRun(db, "lost")).toMatchObject({ status: "cancelled" });
    expect(getRun(db, "done")).toEqual(doneBefore);
  });

  it("cancels a run whose thread cannot be read", async () => {
    startRun(db, { runId: "r", threadId: "t", query: "q" });

    const settled = await settleOpenRuns(db, async () => {
      throw new Error("unreadable");
    });

    expect(settled).toEqual({ interrupted: 0, cancelled: 1 });
    expect(getRun(db, "r")?.status).toBe("cancelled");
  });

  it("keeps an outcome the run recorded while it was being settled", async () => {
    startRun(db, { runId: "r", threadId: "t", query: "q" });

    const settled = await settleOpenRuns(db, async () => {
      updateRun(db, "r", { status: "completed" });
      return false;
    });

    expect(settled).toEqual({ interrupted: 0, cancelled: 0 });
    expect(getRun(db, "r")?.status).toBe("completed");
  });
});

// =============================================================================
// Results and events
// =============================================================================

const TRACK = "4uLU6hMCjMI75M1A2tKUQC";

/** A result of run `runId` that fits the contract, with any extra fields. */
const result = (runId: string, extra: Record<string, unknown> = {}) => ({
  id: TRACK,
  title: "T",
  artist: "A",
  album: "B",
  coverUrl: "",
  bpm: null,
  genealogy: { nodes: [], links: [] },
  run: { id: runId, mode: "live", recordedAt: null, commit: null, analyzerVersion: null },
  ...extra,
});

describe("withoutPreviewUrls", () => {
  it("removes previewUrl fields and blanks preview URLs anywhere else", () => {
    expect(
      withoutPreviewUrls({
        previewUrl: "https://example.com/anything.mp3",
        cover: "https://i.scdn.co/image/abc",
        page: "https://open.spotify.com/track/abc",
        deezer: "https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/x.mp3?hdnea=exp=1~hmac=f",
        spotify: "https://p.scdn.co/mp3-preview/abc",
        signed: "https://cdn.example.com/a.mp3?hdnea=exp=1~acl=x",
        s3: "https://bucket.s3.amazonaws.com/a.mp3?X-Amz-Signature=abc",
        list: ["https://e-cdns-preview-1.dzcdn.net/stream/x", "plain text"],
        nested: { previewUrl: null, keep: 1 },
      }),
    ).toEqual({
      cover: "https://i.scdn.co/image/abc",
      page: "https://open.spotify.com/track/abc",
      deezer: "",
      spotify: "",
      signed: "",
      s3: "",
      list: ["", "plain text"],
      nested: { keep: 1 },
    });
  });

  it("keeps Deezer images, look-alike hosts and text that only mentions a token", () => {
    const kept = [
      "https://cdn-images.dzcdn.net/images/cover/0a1b2c/250x250-000000-80-0-0.jpg",
      "https://e-cdns-images.dzcdn.net/images/artist/0a1b2c/500x500.jpg",
      "https://dzcdn.net.example.com/x",
      "https://notp.scdn.co.example/x",
      "Signed links end in ?hdnts=… and expire",
      "see https://example.com/a?hdnea=x for details",
    ];
    expect(withoutPreviewUrls(kept)).toEqual(kept);
  });
});

describe("storeRunResult", () => {
  it("stores the result as the contract reads it, without previews or unknown fields", () => {
    startRun(db, { runId: "r", threadId: "r", query: "typed words" });
    const stored = storeRunResult(
      db,
      "r",
      result("r", { previewUrl: "https://p.scdn.co/mp3-preview/x", songQuery: "typed words" }),
    );
    expect(stored).toBe("stored");
    const row = db.prepare("SELECT analysis FROM runs WHERE run_id = 'r'").pluck().get() as string;
    expect(row).not.toMatch(/typed words|p\.scdn\.co|previewUrl/);
    expect(getRun(db, "r")).toMatchObject({
      spotifyId: TRACK,
      mode: "live",
      analysis: { id: TRACK, segments: [], samples: [], factoids: [] },
    });
  });

  it("does not store how the run's search text matched the track", () => {
    startRun(db, { runId: "r", threadId: "r", query: "typed words" });
    expect(storeRunResult(db, "r", result("r", { queryMatch: "none" }))).toBe("stored");
    const row = db.prepare("SELECT analysis FROM runs WHERE run_id = 'r'").pluck().get() as string;
    expect(row).not.toContain("queryMatch");
    expect(getRun(db, "r")?.analysis).not.toHaveProperty("queryMatch");
  });

  it("marks a result composed by another run instead of storing it as the run's own", () => {
    startRun(db, { runId: "r", threadId: "r", query: "q" });
    const { run: _run, ...cached } = result("earlier");
    expect(storeRunResult(db, "r", cached)).toBe("another_run");
    expect(storeRunResult(db, "r", result("earlier"))).toBe("another_run");
    expect(getRun(db, "r")).toMatchObject({
      spotifyId: null,
      mode: "replay",
      analysis: null,
      payload: { resultFrom: "another_run" },
    });
  });

  it("refuses a result that fails the contract, and a run that does not exist", () => {
    startRun(db, { runId: "r", threadId: "r", query: "q" });
    expect(storeRunResult(db, "r", { ...result("r"), title: undefined })).toBe("invalid");
    expect(storeRunResult(db, "missing", result("missing"))).toBe("no_run");
    expect(getRun(db, "r")?.analysis).toBeNull();
  });

  it("keeps the stored result's evidence pack in its own column", () => {
    const item = {
      id: "musicbrainz:track/recording/875c24bc-fe9e-4ac6-80d3-beaacb70ee43",
      source: "musicbrainz",
      sourceTier: "primary-record",
      url: "https://musicbrainz.org/recording/875c24bc-fe9e-4ac6-80d3-beaacb70ee43",
      title: "Ice Ice Baby — MusicBrainz recording",
      retrievedAt: "2026-10-20T12:00:00.000Z",
      excerpt: "MusicBrainz recording.",
      recordRef: "track/recording/875c24bc-fe9e-4ac6-80d3-beaacb70ee43",
    };
    for (const id of ["cites", "empty", "none", "other"])
      startRun(db, { runId: id, threadId: id, query: "q" });
    storeRunResult(db, "cites", result("cites", { evidence: [item] }));
    storeRunResult(db, "empty", result("empty", { evidence: [] }));
    storeRunResult(db, "none", result("none"));
    storeRunResult(db, "other", result("earlier", { evidence: [item] }));
    const evidence = (id: string) =>
      db.prepare("SELECT evidence FROM runs WHERE run_id = ?").pluck().get(id);
    expect(JSON.parse(evidence("cites") as string)).toEqual([item]);
    expect(evidence("empty")).toBe("[]");
    // No pack in the result, or no result of the run's own: nothing is stored.
    expect(evidence("none")).toBeNull();
    expect(evidence("other")).toBeNull();
    // A replayed run keeps no result of its own, so no pack either.
    storeReplayOf(db, "cites", { slug: "s", recordedAt: "2026-01-01T00:00:00.000Z", digest: "d" });
    expect(evidence("cites")).toBeNull();
  });

  it("stores a replay when either the caller or the result says so", () => {
    for (const id of ["caller", "result", "neither"])
      startRun(db, { runId: id, threadId: id, query: "q" });
    storeRunResult(db, "caller", result("caller"), "replay");
    storeRunResult(
      db,
      "result",
      result("result", { run: { ...result("result").run, mode: "replay" } }),
    );
    storeRunResult(db, "neither", result("neither"));
    expect(["caller", "result", "neither"].map((id) => getRun(db, id)?.mode)).toEqual([
      "replay",
      "replay",
      "live",
    ]);
    // The stored result's own run information agrees with the run's mode.
    expect(
      ["caller", "result", "neither"].map(
        (id) => (getRun(db, id)?.analysis as { run?: { mode: string } } | undefined)?.run?.mode,
      ),
    ).toEqual(["replay", "replay", "live"]);
  });
});

describe("latestRunsForTrack", () => {
  /** A completed run of TRACK with the given times (unix seconds), recorded in call order. */
  function completedRun(runId: string, createdAt: number, finishedAt: number) {
    startRun(db, { runId, threadId: runId, query: "q" });
    storeRunResult(db, runId, result(runId));
    db.prepare(
      "UPDATE runs SET status = 'completed', created_at = ?, finished_at = ? WHERE run_id = ?",
    ).run(createdAt, finishedAt, runId);
  }

  it("orders by finish time, then start time, then recording order", () => {
    completedRun("started-first-finished-last", 100, 300);
    completedRun("tie-recorded-first", 150, 200);
    completedRun("tie-recorded-second", 150, 200);
    completedRun("same-finish-started-later", 160, 200);
    expect(latestRunsForTrack(db, TRACK, 10).map((run) => run.runId)).toEqual([
      "started-first-finished-last",
      "same-finish-started-later",
      "tie-recorded-second",
      "tie-recorded-first",
    ]);
    expect(latestRunsForTrack(db, TRACK, 1)).toHaveLength(1);
  });
});

describe("appendRunEvent", () => {
  it("gives up quickly when another connection holds the write lock", () => {
    const dir = mkdtempSync(join(tmpdir(), "run-events-"));
    const file = new Database(join(dir, "test.db"));
    const other = new Database(join(dir, "test.db"));
    try {
      runMigrations(file);
      file.pragma("busy_timeout = 5000");
      startRun(file, { runId: "r", threadId: "r", query: "q" });
      other.exec("BEGIN IMMEDIATE");
      const started = Date.now();
      expect(() => appendRunEvent(file, "r", 0, { seq: 0 })).toThrow(/locked|busy/i);
      expect(Date.now() - started).toBeLessThan(EVENT_BUSY_TIMEOUT_MS + 1000);
      expect(file.pragma("busy_timeout", { simple: true })).toBe(5000);
      other.exec("ROLLBACK");
      appendRunEvent(file, "r", 0, { seq: 0 });
    } finally {
      other.close();
      file.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
