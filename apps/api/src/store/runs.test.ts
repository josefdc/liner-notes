import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Annotation, Command, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { emptyCheckpoint } from "@langchain/langgraph-checkpoint";
import { SqliteSaver } from "@langchain/langgraph-checkpoint-sqlite";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { timed } from "../sources/testing/strings.js";
import { MIGRATIONS, runMigrations } from "./migrations.js";
import {
  appendRunEvent,
  EVENT_BUSY_TIMEOUT_MS,
  getRun,
  isPreviewUrl,
  lastStreamElapsedMs,
  latestRunsForTrack,
  runDurationSql,
  SIGNED_URL,
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

describe("time waiting for the user's choice", () => {
  const T0 = Date.UTC(2026, 9, 25, 12, 0, 0);
  /** Sets the clock to `seconds` after T0. */
  const at = (seconds: number) => vi.setSystemTime(T0 + seconds * 1000);
  const pauseOf = (runId: string) =>
    db
      .prepare(
        `SELECT paused_since AS since, paused_seconds AS seconds,
           ${runDurationSql()} AS duration FROM runs WHERE run_id = ?`,
      )
      .get(runId) as { since: number | null; seconds: number | null; duration: number | null };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    at(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves the wait at the track picker out of the run's duration", () => {
    startRun(db, { runId: "r", threadId: "r", query: "ambiguous" });
    at(4);
    updateRun(db, "r", { status: "interrupted" });
    expect(pauseOf("r")).toEqual({ since: T0 / 1000 + 4, seconds: 0, duration: null });

    at(4 + 600);
    updateRun(db, "r", { status: "running" });
    expect(pauseOf("r")).toMatchObject({ since: null, seconds: 600 });
    at(4 + 600 + 30);
    updateRun(db, "r", { status: "completed" });

    expect(getRun(db, "r")).toMatchObject({ createdAt: T0 / 1000, finishedAt: T0 / 1000 + 634 });
    expect(pauseOf("r")).toEqual({ since: null, seconds: 600, duration: 34 });
  });

  it("adds up every wait: a resume that stopped before the choice was applied waits again", () => {
    startRun(db, { runId: "r", threadId: "r", query: "ambiguous" });
    at(2);
    updateRun(db, "r", { status: "interrupted" });
    at(102);
    updateRun(db, "r", { status: "running" });
    at(103);
    updateRun(db, "r", { status: "interrupted" });
    // Recorded again as waiting (e.g. by a second outcome): the wait keeps its start.
    at(150);
    updateRun(db, "r", { status: "interrupted" });
    at(303);
    updateRun(db, "r", { status: "running" });
    at(313);
    updateRun(db, "r", { status: "completed" });

    expect(pauseOf("r")).toEqual({ since: null, seconds: 300, duration: 13 });
  });

  it("ends the wait when a waiting run is given a final status", () => {
    startRun(db, { runId: "r", threadId: "r", query: "ambiguous" });
    at(5);
    updateRun(db, "r", { status: "interrupted" });
    at(65);
    updateRun(db, "r", { status: "cancelled" });

    expect(pauseOf("r")).toEqual({ since: null, seconds: 60, duration: 5 });
  });

  // Recovery paths: 10 s of work before the pick and 20 s after, so the run's own time is 30 s,
  // but when the wait began is not known, so the duration must read as unknown, never as more.
  it("knows no duration for a run found waiting at a restart (down an hour after the interrupt)", async () => {
    startRun(db, { runId: "r", threadId: "r", query: "ambiguous" });
    // The thread paused at 10 s, and the server stopped before the run was recorded as waiting.
    at(3610);
    await settleOpenRuns(db, async () => true);
    expect(getRun(db, "r")?.status).toBe("interrupted");
    at(3670);
    updateRun(db, "r", { status: "running" });
    at(3690);
    updateRun(db, "r", { status: "completed" });

    // Wall time 3690 s less the 60 s seen waiting would read 3630 s.
    expect(pauseOf("r")).toEqual({ since: null, seconds: null, duration: null });
  });

  it("knows no duration for a run whose thread could not be read at a restart, then resumed", async () => {
    startRun(db, { runId: "r", threadId: "r", query: "ambiguous" });
    at(10);
    await settleOpenRuns(db, async () => {
      throw new Error("unreadable");
    });
    expect(getRun(db, "r")?.status).toBe("cancelled");
    // Unknown already: whether it was waiting, and since when, could not be read.
    expect(pauseOf("r")).toEqual({ since: null, seconds: null, duration: null });
    // The thread was in fact waiting: the choice is still pending, and it is resumed.
    at(310);
    updateRun(db, "r", { status: "running" });
    at(330);
    updateRun(db, "r", { status: "completed" });

    expect(pauseOf("r")).toEqual({ since: null, seconds: null, duration: null });
  });

  it("knows no duration for a run opened again after a final status", () => {
    startRun(db, { runId: "r", threadId: "r", query: "ambiguous" });
    at(10);
    updateRun(db, "r", { status: "interrupted" });
    at(610);
    updateRun(db, "r", { status: "running" });
    // The resume stopped before the choice was applied and could not tell: recorded cancelled.
    at(615);
    updateRun(db, "r", { status: "cancelled" });
    expect(pauseOf("r")).toEqual({ since: null, seconds: 600, duration: 15 });
    at(1515);
    updateRun(db, "r", { status: "running" });
    at(1535);
    updateRun(db, "r", { status: "completed" });

    // Wall time 1535 s less the 600 s wait would read 935 s.
    expect(pauseOf("r")).toEqual({ since: null, seconds: null, duration: null });
  });

  it("knows no duration when the clock went back, during a wait or over the run", () => {
    startRun(db, { runId: "wait", threadId: "wait", query: "ambiguous" });
    at(10);
    updateRun(db, "wait", { status: "interrupted" });
    at(5);
    updateRun(db, "wait", { status: "running" });
    at(20);
    updateRun(db, "wait", { status: "completed" });
    expect(pauseOf("wait")).toEqual({ since: null, seconds: null, duration: null });

    at(100);
    startRun(db, { runId: "run", threadId: "run", query: "q" });
    at(50);
    updateRun(db, "run", { status: "completed" });
    expect(pauseOf("run")).toEqual({ since: null, seconds: 0, duration: null });
  });

  it("records when a run started as waiting began to wait", () => {
    at(3);
    startRun(db, { runId: "r", threadId: "r", query: "ambiguous", status: "interrupted" });
    expect(pauseOf("r")).toMatchObject({ since: T0 / 1000 + 3, seconds: 0 });
    at(63);
    updateRun(db, "r", { status: "running" });
    at(66);
    updateRun(db, "r", { status: "completed" });
    expect(pauseOf("r")).toEqual({ since: null, seconds: 60, duration: 3 });
  });

  it("knows no duration for a run first recorded at its resume, nor for one stored before waits were kept", () => {
    startRun(db, { runId: "late", threadId: "late", query: "q", pausesKnown: false });
    at(20);
    updateRun(db, "late", { status: "completed" });
    expect(pauseOf("late")).toEqual({ since: null, seconds: null, duration: null });

    const old = new Database(":memory:");
    try {
      runMigrations(old, MIGRATIONS.slice(0, 10));
      old
        .prepare(
          `INSERT INTO runs (run_id, thread_id, query, status, created_at, finished_at)
           VALUES ('done', 't1', 'q', 'completed', 100, 160), ('waiting', 't2', 'q', 'interrupted', 100, NULL)`,
        )
        .run();
      runMigrations(old);
      updateRun(old, "waiting", { status: "running" });
      updateRun(old, "waiting", { status: "completed" });
      const rows = old
        .prepare(`SELECT run_id, paused_seconds, ${runDurationSql()} AS duration FROM runs`)
        .all();
      expect(rows).toEqual([
        { run_id: "done", paused_seconds: null, duration: null },
        { run_id: "waiting", paused_seconds: null, duration: null },
      ]);
    } finally {
      old.close();
    }
  });

  it("counts no wait for a run that never waited", () => {
    startRun(db, { runId: "r", threadId: "r", query: "q" });
    at(42);
    updateRun(db, "r", { status: "completed" });
    expect(pauseOf("r")).toEqual({ since: null, seconds: 0, duration: 42 });
  });
});

// =============================================================================
// Results and events
// =============================================================================

const TRACK = "4uLU6hMCjMI75M1A2tKUQC";
const SPOTIFY_NODE_CLIP = "https://p.scdn.co/mp3-preview/node";
const DEEZER_NODE_CLIP = "https://cdnt-preview.dzcdn.net/api/1/1/a/b/0/n.mp3?hdnea=exp=1~hmac=y";

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

describe("SIGNED_URL", () => {
  // The expression before #189: it rescans the rest of the string for each candidate parameter.
  const QUADRATIC = /^https?:\/\/\S*[?&;~](?:hdnea|hdnts|x-amz-signature)=\S*$/i;

  it("matches exactly the strings the earlier expression matched", () => {
    const markers = ["hdnea", "hdnts", "x-amz-signature", "HDNEA", "HdNtS", "X-Amz-Signature"];
    const near = ["hdne", "hdnea_", "x-amz-signatur", "x-amz-credential", "hmac", "sig", "token"];
    const cases = [
      "https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/x.mp3?hdnea=exp=1~hmac=f",
      "https://p.scdn.co/mp3-preview/abc",
      "https://cdn.example.com/a.mp3?hdnea=exp=1~acl=x",
      "https://bucket.s3.amazonaws.com/a.mp3?X-Amz-Signature=abc",
      "https://e-cdns-preview-1.dzcdn.net/stream/x",
      "https://cdn-images.dzcdn.net/images/cover/0a1b2c/250x250-000000-80-0-0.jpg",
      "https://dzcdn.net.example.com/x",
      "Signed links end in ?hdnts=… and expire",
      "see https://example.com/a?hdnea=x for details",
      "plain text",
      "",
      "https://",
      "http://?hdnea=",
      "https://~hdnts=",
      "ftp://x/a?hdnea=1",
      " https://x/a?hdnea=1",
      "HTTPS://X/A?HDNEA=1",
      "http://x/a?hdnea=1 ",
      "http://x/a?hdnea=1\n",
      "http://x/a?hdnea=1\tb",
      "http://x/a b?hdnea=1",
      "http://x/\u00a0?hdnea=1",
      "http://x/a?hdnea",
      "http://x/a?hdnea =1",
      "http://x/a?=hdnea=1",
      "http://x/a/hdnea=1",
      "http://x/a#hdnea=1",
      `http://x/${"~hdnea=".repeat(50)} b`,
      `http://x/${"~hdnea=".repeat(50)}`,
    ];
    for (const marker of [...markers, ...near])
      for (const sep of ["?", "&", ";", "~", "/", "#", "=", ""])
        for (const tail of ["", "1", "a=b&c=d", "1 2", "1\n"])
          for (const head of ["https://h/p", "http://h", "https:/h/p", "x https://h/p"])
            cases.push(`${head}${sep}${marker}=${tail}`);

    for (const value of cases) expect(SIGNED_URL.test(value), value).toBe(QUADRATIC.test(value));
    // Both kinds of answer are exercised.
    expect(cases.filter((value) => QUADRATIC.test(value)).length).toBeGreaterThan(100);
    expect(cases.filter((value) => !QUADRATIC.test(value)).length).toBeGreaterThan(100);
  });

  it("answers quickly on a long run of signed-looking parameters before a space", () => {
    // A few milliseconds; about 12 s with QUADRATIC, so the bound leaves room for a loaded machine.
    // The fastest of three runs is timed, since load only adds time; one run five times over ends it.
    const value = `http://x/${"~hdnea=".repeat(60_000)} b`;
    const { ms, result } = timed(() => isPreviewUrl(value), { runs: 3, stopAboveMs: 2_000 });
    expect(ms).toBeLessThan(400);
    expect(result).toBe(false);
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

  it("stores no genealogy node's clip, Spotify's or Deezer's, in the result or the run's events", () => {
    const nodes = [
      { id: "a", group: 4, label: "A", size: 22, spotifyId: "a1", previewUrl: SPOTIFY_NODE_CLIP },
      { id: "b", group: 4, label: "B", size: 22, spotifyId: "b1", previewUrl: DEEZER_NODE_CLIP },
    ];
    const withClips = result("r", { genealogy: { nodes, links: [] } });
    startRun(db, { runId: "r", threadId: "r", query: "q" });
    appendRunEvent(db, "r", 0, { seq: 0, type: "complete", data: withClips } as { seq: number });
    expect(storeRunResult(db, "r", withClips)).toBe("stored");

    const saved = [
      db.prepare("SELECT analysis FROM runs WHERE run_id = 'r'").pluck().get(),
      ...db.prepare("SELECT event FROM run_events WHERE run_id = 'r'").pluck().all(),
    ].join("\n");
    expect(saved).toContain('"spotifyId":"b1"');
    expect(saved).not.toMatch(/previewUrl|p\.scdn\.co|dzcdn|hdnea/);
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
    // A result stored as a replay (its model answers came from cassettes) is the run's own
    // result: its pack is kept with it, as its analysis is.
    startRun(db, { runId: "replayed", threadId: "replayed", query: "q" });
    storeRunResult(db, "replayed", result("replayed", { evidence: [item] }), "replay");
    expect(JSON.parse(evidence("replayed") as string)).toEqual([item]);
    // A replayed recording (storeReplayOf) keeps no result of its own, so no pack either.
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

describe("lastStreamElapsedMs", () => {
  const event = (seq: number, type: string, elapsedMs?: number) =>
    ({ seq, type, runId: "r", ...(elapsedMs !== undefined && { elapsedMs }) }) as { seq: number };

  it("reads the time the run's last stored stream ended with, from its done", () => {
    startRun(db, { runId: "r", threadId: "r", query: "q" });
    appendRunEvent(db, "r", 0, event(0, "connected", 0));
    appendRunEvent(db, "r", 0, event(1, "interrupt", 140));
    appendRunEvent(db, "r", 0, event(2, "done", 152));
    expect(lastStreamElapsedMs(db, "r")).toBe(152);

    // A later stream's done, not the first stream's.
    appendRunEvent(db, "r", 1, event(0, "resuming", 152));
    appendRunEvent(db, "r", 1, event(1, "done", 900));
    expect(lastStreamElapsedMs(db, "r")).toBe(900);
  });

  it("knows no time when the last stored event is not a done, has none, or there is none", () => {
    expect(lastStreamElapsedMs(db, "none")).toBeNull();

    // A stream stored in part: its last stored event is not the done that ended it.
    appendRunEvent(db, "cut", 0, event(0, "connected", 0));
    appendRunEvent(db, "cut", 0, event(1, "interrupt", 140));
    expect(lastStreamElapsedMs(db, "cut")).toBeNull();

    // A stream sent without times, or with a time that is not one.
    appendRunEvent(db, "untimed", 0, event(0, "done"));
    expect(lastStreamElapsedMs(db, "untimed")).toBeNull();
    appendRunEvent(db, "odd", 0, event(0, "done", -5));
    expect(lastStreamElapsedMs(db, "odd")).toBeNull();
  });
});
