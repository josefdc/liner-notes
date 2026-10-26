/**
 * Route tests for /api/runs* and for what the analysis routes store: runs started through the
 * real analysis routes and the real compiled graph, on the app createApp builds, with the nodes
 * that call outside services replaced by stubs (as in analyze.test.ts). The clarification node
 * is the real one, so a run that pauses for a choice and is resumed goes through LangGraph's
 * interrupt().
 *
 * The stub scout picks its path from the query:
 *   "cachehit …"   the real scout, which serves a stored result from the cache
 *   "ambiguous …"  two candidates, so the run pauses
 *   "direct <id>"  matches track <id>
 *   "invalid …"    also writes a progress event that fails the contract
 *   "dropdb …"     also runs the test's `dropTable` hook
 *   "fresh …"      matches TRACK_ID with its full Spotify details; the historian reports the
 *                  test's `sourceErrors` hook, and the composer hands the real verifier a draft
 *   anything else  matches TRACK_ID
 * The stub composer reports a result for the matched track, stamped with the run's id. It
 * carries a preview URL (under `previewUrl` and as a genealogy image) and the typed query in a
 * field the contract does not name. "badresult …" leaves out the title (fails the contract);
 * "replayed …" says its model answers were replayed.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { AnalyzeStreamEvent, RunResponse } from "@liner-notes/contract";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { configuredSources, resultCacheKey, TRACKS_NAMESPACE } from "../../agent/cacheKeys.js";
import type { SonicAgentStateType } from "../../agent/state.js";
import { DEFAULT_RATE_LIMIT, DEFAULT_SEARCH_RATE_LIMIT } from "../../config/settings.js";
import { heldTextIssue } from "../../agent/storedResults.js";
import { captureLogsForTests } from "../../logger.js";
import { fetchJson, SourceError } from "../../sources/http.js";
import { errorRecord, notConfigured } from "../../sources/records.js";
import { type FetchRoute, html, json, stubFetch } from "../../sources/testing/fetchStub.js";
import { FORUM_THREADS } from "../../sources/testing/forumThreads.js";
import { closeDatabase, getDb, initializeDatabase } from "../../store/database.js";
import { DEFAULT_RETENTION, pruneDatabase } from "../../store/retention.js";
import { getRun, listRunEvents, withoutPreviewUrls } from "../../store/runs.js";
import { SqliteStore } from "../../store/store.js";
import { createApp } from "../app.js";
import { unstoredStreamCount } from "./analyze.js";

const TRACK_ID = "0RunsRouteTestTrack001";
const CHOICE_A = "0RunsRouteTestTrackA01";
const CHOICE_B = "0RunsRouteTestTrackB01";

const hooks = vi.hoisted(() => ({
  dropTable: null as null | (() => void),
  sourceErrors: [] as unknown[],
}));

vi.mock("../../sources/spotify.js", () => ({
  // The real scout's search ("cachehit …" queries): it finds TRACK_ID, by the artist and title
  // the query names, so the scout selects it and serves the result stored for it.
  searchTracks: async () => [
    {
      id: "0RunsRouteTestTrack001",
      title: "Someone Else Typed",
      artist: "Cachehit",
      artistIds: [],
      album: "Album",
      releaseDate: "1994",
      coverUrl: "",
      isrc: null,
      duration: "3:38",
      durationMs: 218000,
      explicit: false,
      spotifyUrl: "https://open.spotify.com/track/0RunsRouteTestTrack001",
      previewUrl: null,
    },
  ],
  fetchTrack: async (trackId: string) => ({
    id: trackId,
    title: `Title ${trackId}`,
    artist: "Artist",
    artistIds: [],
    album: "Album",
    releaseDate: "1994",
    coverUrl: "",
    popularity: 50,
    duration: "3:38",
    durationMs: 218000,
    explicit: false,
    spotifyUrl: `https://open.spotify.com/track/${trackId}`,
    previewUrl: null,
  }),
}));

vi.mock("../../agent/nodes/index.js", async () => {
  const { clarificationNode } = await vi.importActual<
    typeof import("../../agent/nodes/clarificationNode.js")
  >("../../agent/nodes/clarificationNode.js");
  const { scoutNode: realScout } = await vi.importActual<
    typeof import("../../agent/nodes/scoutNode.js")
  >("../../agent/nodes/scoutNode.js");
  const { draftOf } = await vi.importActual<typeof import("../../agent/verifier/testing.js")>(
    "../../agent/verifier/testing.js",
  );

  type State = SonicAgentStateType;
  type Config = LangGraphRunnableConfig;
  const status = (config: Config, node: string, message: string) =>
    config.writer?.({ type: "status", node, message, timestamp: new Date().toISOString() });

  return {
    clarificationNode,
    scoutNode: async (state: State, config: Config) => {
      const query = state.songQuery;
      if (query.startsWith("cachehit")) return realScout(state, config);
      status(config, "scout", "searching");
      if (query.startsWith("dropdb")) hooks.dropTable?.();
      if (query.startsWith("invalid")) config.writer?.({ type: "claim", nonsense: true });
      if (query.startsWith("ambiguous")) {
        const candidates = ["0RunsRouteTestTrackA01", "0RunsRouteTestTrackB01"].map((id) => ({
          id,
          title: `Title ${id}`,
          artist: "Artist",
          album: "Album",
          coverUrl: "",
          popularity: 40,
        }));
        return { candidates };
      }
      const id = query.startsWith("direct ") ? query.split(" ")[1] : "0RunsRouteTestTrack001";
      if (query.startsWith("fresh")) {
        const spotifyData = {
          id,
          title: "Title",
          artist: "Artist",
          album: "Album",
          coverUrl: "",
          releaseDate: "1994",
          durationMs: 218000,
        };
        return { spotifyData, selectedBy: "match" };
      }
      return { spotifyData: { id, title: "Title", artist: "Artist" } };
    },
    engineerNode: async (_state: State, config: Config) => {
      status(config, "engineer", "measuring");
      return {};
    },
    historianNode: async (state: State) =>
      state.songQuery.startsWith("fresh") ? { sourceErrors: hooks.sourceErrors } : {},
    composerNode: async (state: State, config: Config) => {
      if (state.songQuery.startsWith("fresh")) return { draft: draftOf([]) };
      const preview = "https://cdnt-preview.dzcdn.net/stream/c-abc?hdnea=exp=1~hmac=secret";
      const trackData: Record<string, unknown> = {
        id: state.spotifyData?.id,
        title: "Composed",
        artist: "Artist",
        album: "Album",
        coverUrl: "https://i.scdn.co/image/cover",
        previewUrl: preview,
        bpm: null,
        genealogy: {
          nodes: [{ id: "self", group: 1, label: "Composed", size: 10, img: preview }],
          links: [],
        },
        run: {
          id: config.configurable?.thread_id,
          mode: state.songQuery.startsWith("replayed") ? "replay" : "live",
          recordedAt: null,
          commit: null,
          analyzerVersion: null,
        },
        // Not a TrackAnalysis field: never stored, never served.
        songQuery: state.songQuery,
        // How this run's text matched the track: sent with the run's result, never stored.
        queryMatch: "partial",
      };
      if (state.songQuery.startsWith("badresult")) delete trackData.title;
      config.writer?.({ type: "complete", data: trackData });
      return { trackData, statusMessages: ["done"] };
    },
  };
});

// =============================================================================
// Helpers
// =============================================================================

type Event = { type: string; seq?: number; [key: string]: unknown };

const app = createApp({
  http: {
    corsOrigins: ["http://localhost:3110"],
    trustProxy: 0,
    rateLimit: { ...DEFAULT_RATE_LIMIT, max: 10_000 },
    globalRateLimit: { windowMs: DEFAULT_RATE_LIMIT.windowMs, max: 10_000 },
    searchRateLimit: DEFAULT_SEARCH_RATE_LIMIT,
  },
});

/** GETs an event stream and returns its messages once it ends. */
async function sse(path: string): Promise<Event[]> {
  const res = await request(app)
    .get(path)
    .buffer(true)
    .parse((response, callback) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => callback(null, body));
    });
  return (res.body as string)
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)) as Event);
}

const streamPath = (query: string) => `/api/analyze/stream?query=${encodeURIComponent(query)}`;
const resumePath = (threadId: string, trackId: string) =>
  `/api/analyze/stream/resume?threadId=${threadId}&selectedTrackId=${trackId}`;

/** Runs a streamed analysis to its end; returns its run id and messages. */
async function analyze(query: string): Promise<{ runId: string; events: Event[] }> {
  const events = await sse(streamPath(query));
  const runId = events[0]?.runId;
  expect(typeof runId).toBe("string");
  return { runId: runId as string, events };
}

/** What a stream's stored events must be: each sent event as the contract reads it, no previews. */
const asStored = (events: Event[]) =>
  events
    .filter((event) => event.type !== "heartbeat")
    .map((event) => withoutPreviewUrls(AnalyzeStreamEvent.parse(event)));

const storedEvents = (runId: string, stream?: number) =>
  listRunEvents(getDb(), runId)
    .filter((row) => stream === undefined || row.stream === stream)
    .map((row) => row.event);

/** The raw stored rows of a run, as text: its result and every event. */
function storedText(runId: string): string {
  const row = getDb().prepare("SELECT analysis, payload FROM runs WHERE run_id = ?").get(runId);
  const events = getDb()
    .prepare("SELECT event FROM run_events WHERE run_id = ?")
    .pluck()
    .all(runId) as string[];
  return JSON.stringify(row) + events.join("\n");
}

/** Runs `body` with a trigger that makes the matching writes fail, then drops it. */
async function withFailingWrite(trigger: string, body: () => Promise<void>): Promise<void> {
  getDb().exec(`CREATE TRIGGER fail_write ${trigger} BEGIN SELECT RAISE(ABORT, 'disk full'); END;`);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    await body();
  } finally {
    errors.mockRestore();
    getDb().exec("DROP TRIGGER IF EXISTS fail_write");
  }
}

/** A web-tier evidence item as the web tier stores one. */
const webItem = (url: string, excerpt: string, title = "A page about the track") => ({
  id: `tavily:${url}`,
  source: "tavily",
  sourceTier: "web",
  url,
  title,
  retrievedAt: "2026-10-20T12:00:00.000Z",
  excerpt,
  recordRef: null,
});

/** A page the web tier keeps. */
const CLEAN_PAGE = webItem(
  "https://www.example.org/news/one-more-time",
  "One More Time was released in November 2000 on Virgin.",
);
/** A forum thread, stored by code older than the forum check. */
const FORUM_TEXT = FORUM_THREADS[0][1];
const FORUM_PAGE = webItem("https://www.example.org/thread/one-more-time", FORUM_TEXT);
/** A social platform page, stored by code older than the social-site check. */
const SOCIAL_TEXT = "Zephyrine Quillfeather shared a memory of One More Time.";
const SOCIAL_PAGE = webItem("https://m.facebook.com/somepage/posts/1", SOCIAL_TEXT);
/** A page whose @handle was not masked, stored by code older than the handle check. */
const HANDLE_PAGE = webItem(
  "https://www.example.org/news/interview",
  "Thomas Bangalter (@thomasbangalter) produced it.",
);
/** A source error whose message is the page the source answered with. */
const MARKUP_ERROR = {
  source: "discogs",
  code: "invalid_response",
  message: "<html><body>Bad gateway</body></html>",
};

/** The answer to a run whose stored result is refused: it says no more than that. */
const REFUSED_BODY = {
  success: false,
  code: "not_found",
  error: "Not found.",
  detail: "The run's stored result is no longer served",
};

/**
 * Rewrites a run's stored result with `evidence` and, in its run information, `sourceErrors`, as
 * code older than the web tier's checks could have stored it.
 */
function storeHeld(
  runId: string,
  { evidence = [], sourceErrors }: { evidence?: object[]; sourceErrors?: object[] },
): void {
  const analysis = getRun(getDb(), runId)?.analysis as { run: object };
  const held = {
    ...analysis,
    evidence,
    run: { ...analysis.run, ...(sourceErrors ? { sourceErrors } : {}) },
  };
  getDb().prepare("UPDATE runs SET analysis = ? WHERE run_id = ?").run(JSON.stringify(held), runId);
}

const RUN_EVENTS_DDL = `CREATE TABLE IF NOT EXISTS run_events (
  run_id TEXT NOT NULL, stream INTEGER NOT NULL, seq INTEGER NOT NULL,
  sent_at INTEGER NOT NULL, event TEXT NOT NULL, PRIMARY KEY (run_id, stream, seq));`;

// =============================================================================
// Tests
// =============================================================================

describe("runs routes", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "runs-routes-"));
    initializeDatabase(join(dir, "test.db"));
  });
  afterAll(() => {
    closeDatabase();
    rmSync(dir, { recursive: true, force: true });
  });
  beforeEach(() => {
    getDb().exec("DELETE FROM runs; DELETE FROM run_events; DELETE FROM store_items;");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("serves the latest completed run of a track, and stores neither the query nor previews", async () => {
    const typed = "midnight zebra typed words";
    await analyze(`${typed} first`);
    const { runId, events } = await analyze(typed);
    expect(events.map((e) => e.type)).toContain("complete");
    const complete = events.find((e) => e.type === "complete") as { data?: object } | undefined;
    expect(complete?.data).toMatchObject({ queryMatch: "partial" });

    const res = await request(app).get(`/api/runs/by-track/${TRACK_ID}`);
    expect(res.status).toBe(200);
    expect(RunResponse.safeParse(res.body).success).toBe(true);
    expect(res.body.run).toMatchObject({
      id: runId,
      status: "completed",
      mode: "live",
      spotifyId: TRACK_ID,
      finishedAt: expect.any(String),
    });
    expect(res.body.analysis).toMatchObject({
      id: TRACK_ID,
      title: "Composed",
      coverUrl: "https://i.scdn.co/image/cover",
    });

    // Neither the typed query nor a preview URL is served, or kept in the database.
    for (const text of [res.text, storedText(runId)]) {
      expect(text).not.toContain("zebra");
      expect(text).not.toMatch(/dzcdn|hdnea/);
    }
    expect(res.body.analysis.genealogy.nodes[0]).toMatchObject({ id: "self", img: "" });
    // How that run's text matched the track is not served to someone who opens the track.
    expect(res.body.analysis).not.toHaveProperty("queryMatch");
    expect(getRun(getDb(), runId)?.analysis).not.toHaveProperty("queryMatch");

    const byId = await request(app).get(`/api/runs/${runId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual(res.body);
  });

  it("stores each event the stream sent, as the contract reads it", async () => {
    const { runId, events } = await analyze("plain query");
    expect(events.map((e) => e.type)).toEqual([
      "connected",
      "status",
      "status",
      "complete",
      "done",
    ]);
    expect(storedEvents(runId)).toEqual(asStored(events));
  });

  it("does not store a progress event that was dropped, and keeps the seqs contiguous", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { runId, events } = await analyze("invalid progress");
    expect(events.map((e) => e.type)).not.toContain("claim");
    expect(storedEvents(runId)).toEqual(asStored(events));
    expect(listRunEvents(getDb(), runId).map((row) => row.seq)).toEqual(events.map((_, i) => i));
  });

  it("stores the error sent in place of a result that fails the contract, and no result", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { runId, events } = await analyze("badresult query");
    expect(events.map((e) => e.type)).toEqual(["connected", "status", "status", "error", "done"]);
    expect(storedEvents(runId)).toEqual(asStored(events));
    expect(getRun(getDb(), runId)).toMatchObject({
      status: "failed",
      analysis: null,
      spotifyId: null,
    });
  });

  it("finishes the run normally when the events cannot be stored at all", async () => {
    hooks.dropTable = () => getDb().exec("DROP TABLE run_events");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { runId, events } = await analyze("dropdb query");
      expect(events.map((e) => e.type)).toEqual([
        "connected",
        "status",
        "status",
        "complete",
        "done",
      ]);
      expect(getRun(getDb(), runId)).toMatchObject({ status: "completed", spotifyId: TRACK_ID });
    } finally {
      hooks.dropTable = null;
      errors.mockRestore();
      getDb().exec(RUN_EVENTS_DDL);
    }
  });

  it("stops storing a stream at the first event it cannot store, so no event is missing", async () => {
    const before = unstoredStreamCount();
    await withFailingWrite("BEFORE INSERT ON run_events WHEN NEW.seq = 1", async () => {
      const { runId, events } = await analyze("plain query");
      expect(events.map((e) => e.type)).toEqual([
        "connected",
        "status",
        "status",
        "complete",
        "done",
      ]);
      expect(storedEvents(runId)).toEqual(asStored(events).slice(0, 1));
      expect(getRun(getDb(), runId)?.status).toBe("completed");
    });
    expect(unstoredStreamCount()).toBe(before + 1);
  });

  it("records the run as completed when its result cannot be written", async () => {
    await withFailingWrite("BEFORE UPDATE OF analysis ON runs", async () => {
      const { runId, events } = await analyze("plain query");
      expect(events.map((e) => e.type)).toContain("complete");
      expect(getRun(getDb(), runId)).toMatchObject({
        status: "completed",
        finishedAt: expect.any(Number),
        analysis: null,
      });
    });
  });

  it("answers 404 for an unknown run or a track without a stored run", async () => {
    const unknown = await request(app).get("/api/runs/no-such-run");
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ success: false, code: "not_found" });

    const track = await request(app).get("/api/runs/by-track/0000000000000000000000");
    expect(track.status).toBe(404);
    expect(track.body).toMatchObject({ success: false, code: "not_found" });
  });

  it("refuses ids that are not run or Spotify ids", async () => {
    expect((await request(app).get("/api/runs/bad.id")).status).toBe(400);
    expect((await request(app).get("/api/runs/by-track/short")).status).toBe(400);
  });

  it("serves an open run without a result", async () => {
    const { runId, events } = await analyze("ambiguous song");
    expect(events.map((e) => e.type)).toContain("interrupt");

    const res = await request(app).get(`/api/runs/${runId}`);
    expect(res.status).toBe(200);
    expect(RunResponse.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({
      run: { id: runId, status: "interrupted", spotifyId: null, finishedAt: null },
      analysis: null,
    });
    expect(res.text).not.toContain("ambiguous");
  });

  it("stores both streams of a run that paused for a choice and was resumed", async () => {
    const first = await analyze("ambiguous song");
    const runId = first.runId;
    const second = await sse(resumePath(runId, CHOICE_B));
    expect(second.map((e) => e.type)).toContain("complete");
    // Both streams number their events from 0.
    expect(first.events[0]).toMatchObject({ type: "connected", seq: 0 });
    expect(second[0]).toMatchObject({ type: "resuming", seq: 0, runId });

    expect(storedEvents(runId, 0)).toEqual(asStored(first.events));
    expect(storedEvents(runId, 1)).toEqual(asStored(second));

    // A refused resume of the finished run stores nothing.
    const refused = await sse(resumePath(runId, CHOICE_A));
    expect(refused.map((e) => e.type)).toEqual(["error", "done"]);
    expect(storedEvents(runId)).toHaveLength(first.events.length + second.length);

    const res = await request(app).get(`/api/runs/by-track/${CHOICE_B}`);
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ id: runId, status: "completed", spotifyId: CHOICE_B });
  });

  it("stores the resume of a run paused by POST as the run's first stream", async () => {
    const posted = await request(app).post("/api/analyze").send({ query: "ambiguous posted" });
    expect(posted.body.status).toBe("interrupted");
    const runId = posted.body.threadId as string;
    const resumed = await sse(resumePath(runId, CHOICE_B));
    expect(resumed.map((e) => e.type)).toContain("complete");
    expect(listRunEvents(getDb(), runId).map((row) => row.stream)).toEqual(resumed.map(() => 0));
    expect(storedEvents(runId, 0)).toEqual(asStored(resumed));
  });

  it("stores the result of a POST analysis", async () => {
    const res = await request(app).post("/api/analyze").send({ query: "posted query" });
    expect(res.status).toBe(200);
    const stored = await request(app).get(`/api/runs/${res.body.threadId}`);
    expect(stored.status).toBe(200);
    expect(stored.body.run).toMatchObject({ status: "completed", spotifyId: TRACK_ID });
    expect(stored.body.analysis).toMatchObject({ id: TRACK_ID });
  });

  it("fails a POST analysis whose result fails the contract, as the stream does", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await request(app).post("/api/analyze").send({ query: "badresult posted" });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, code: "failed" });
    const [run] = getDb().prepare("SELECT run_id FROM runs").pluck().all() as string[];
    expect(getRun(getDb(), run)).toMatchObject({ status: "failed", analysis: null });
  });

  it("does not store a cached result as the run's own", async () => {
    const composed = await analyze("composed first");
    const cached = { ...(getRun(getDb(), composed.runId)?.analysis as object) };
    delete (cached as { run?: unknown }).run;
    const query = "cachehit someone else typed";
    await new SqliteStore(getDb()).put(
      TRACKS_NAMESPACE,
      resultCacheKey(TRACK_ID, configuredSources()),
      { trackData: cached, timestamp: Date.now() },
    );

    const hit = await analyze(query);
    expect(hit.events.map((e) => e.type)).toEqual([
      "connected",
      "status",
      "status",
      "complete",
      "done",
    ]);
    expect(getRun(getDb(), hit.runId)).toMatchObject({
      status: "completed",
      mode: "replay",
      spotifyId: null,
      analysis: null,
      payload: { resultFrom: "another_run" },
    });
    // The result belongs to the run that composed it: the cache hit keeps no events.
    expect(listRunEvents(getDb(), hit.runId)).toEqual([]);
    expect(storedEvents(composed.runId)).toEqual(asStored(composed.events));

    const res = await request(app).get(`/api/runs/by-track/${TRACK_ID}`);
    expect(res.body.run.id).toBe(composed.runId);
    const own = await request(app).get(`/api/runs/${hit.runId}`);
    expect(RunResponse.safeParse(own.body).success).toBe(true);
    expect(own.body).toMatchObject({
      run: { status: "completed", mode: "replay" },
      analysis: null,
    });
  });

  it("stores no events for a run whose record could not be written", async () => {
    await withFailingWrite("BEFORE INSERT ON runs", async () => {
      const { runId, events } = await analyze("plain query");
      expect(events.map((e) => e.type)).toEqual([
        "connected",
        "status",
        "status",
        "complete",
        "done",
      ]);
      expect(getRun(getDb(), runId)).toBeNull();
      expect(listRunEvents(getDb(), runId)).toEqual([]);
    });
  });

  it("records and stores the resume of a paused run that has no record", async () => {
    const paused = await analyze("ambiguous song");
    getDb().prepare("DELETE FROM runs WHERE run_id = ?").run(paused.runId);
    getDb().prepare("DELETE FROM run_events WHERE run_id = ?").run(paused.runId);

    const resumed = await sse(resumePath(paused.runId, CHOICE_B));
    expect(resumed.map((e) => e.type)).toContain("complete");
    expect(getRun(getDb(), paused.runId)).toMatchObject({
      status: "completed",
      spotifyId: CHOICE_B,
    });
    expect(storedEvents(paused.runId, 0)).toEqual(asStored(resumed));
  });

  it("stores a run whose model answers were replayed as a replay", async () => {
    const { runId } = await analyze("replayed query");
    expect(getRun(getDb(), runId)?.mode).toBe("replay");
  });

  it("serves the run of a track that finished last, a resumed one included", async () => {
    const paused = await analyze("ambiguous song");
    const other = await analyze(`direct ${CHOICE_B}`);
    // The other run started after the paused one and finished before it is resumed.
    const now = Math.floor(Date.now() / 1000);
    const setTimes = getDb().prepare(
      "UPDATE runs SET created_at = ?, finished_at = ? WHERE run_id = ?",
    );
    setTimes.run(now - 20, null, paused.runId);
    setTimes.run(now - 10, now - 5, other.runId);

    await sse(resumePath(paused.runId, CHOICE_B));
    const res = await request(app).get(`/api/runs/by-track/${CHOICE_B}`);
    expect(res.body.run.id).toBe(paused.runId);
  });

  it("serves an older run of a track when the latest one's stored result no longer fits", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const older = await analyze("plain query");
    const latest = await analyze("plain query again");
    getDb()
      .prepare("UPDATE runs SET finished_at = finished_at - 60 WHERE run_id = ?")
      .run(older.runId);
    const corrupt = getDb().prepare("UPDATE runs SET analysis = '{\"id\":1}' WHERE run_id = ?");
    corrupt.run(latest.runId);

    const res = await request(app).get(`/api/runs/by-track/${TRACK_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.run.id).toBe(older.runId);
    expect((await request(app).get(`/api/runs/${latest.runId}`)).status).toBe(500);

    corrupt.run(older.runId);
    const none = await request(app).get(`/api/runs/by-track/${TRACK_ID}`);
    expect(none.status).toBe(500);
    expect(none.body).toMatchObject({ success: false, code: "failed" });
  });

  it("serves neither a stored forum thread nor a social page, by id or by track", async () => {
    const older = await analyze("plain query");
    const latest = await analyze("plain query again");
    getDb()
      .prepare("UPDATE runs SET finished_at = finished_at - 60 WHERE run_id = ?")
      .run(older.runId);
    storeHeld(older.runId, { evidence: [CLEAN_PAGE] });
    storeHeld(latest.runId, { evidence: [CLEAN_PAGE, FORUM_PAGE, SOCIAL_PAGE] });
    const logs = captureLogsForTests();

    try {
      const byId = await request(app).get(`/api/runs/${latest.runId}`);
      expect(byId.status).toBe(404);
      // The detail says the result is no longer served, never why.
      expect(byId.body).toEqual(REFUSED_BODY);

      // The track's older run, whose evidence passes, is served instead.
      const byTrack = await request(app).get(`/api/runs/by-track/${TRACK_ID}`);
      expect(byTrack.status).toBe(200);
      expect(byTrack.body.run.id).toBe(older.runId);
      expect(byTrack.body.analysis.evidence).toEqual([CLEAN_PAGE]);

      for (const res of [byId, byTrack]) {
        expect(res.text).not.toContain("RecordFan");
        expect(res.text).not.toContain("Zephyrine");
        expect(res.text).not.toContain("facebook");
        expect(res.text).not.toContain("thread/one-more-time");
      }
      // The log names the run and why; no line holds the text.
      expect(logs.lines().some((line) => line.includes(latest.runId))).toBe(true);
      for (const line of logs.lines()) {
        expect(line).not.toContain("RecordFan");
        expect(line).not.toContain("Zephyrine");
        expect(line).not.toContain("facebook");
      }
    } finally {
      logs.restore();
    }

    // With no run of the track left to serve, the web can offer a fresh analysis.
    storeHeld(older.runId, { evidence: [SOCIAL_PAGE] });
    const none = await request(app).get(`/api/runs/by-track/${TRACK_ID}`);
    expect(none.status).toBe(404);
    expect(none.body).toMatchObject({ success: false, code: "not_found" });
    expect(none.text).not.toContain("Zephyrine");
  });

  it.each([
    ["a forum thread", { evidence: [FORUM_PAGE] }, "RecordFan"],
    ["a social platform page", { evidence: [SOCIAL_PAGE] }, "Zephyrine"],
    ["a handle that was not masked", { evidence: [HANDLE_PAGE] }, "@thomasbangalter"],
    [
      "a forum thread as a page's title",
      { evidence: [{ ...CLEAN_PAGE, title: FORUM_TEXT }] },
      "RecordFan",
    ],
    ["markup in a source error", { sourceErrors: [MARKUP_ERROR] }, "Bad gateway"],
    [
      "entity-escaped markup in a source error",
      { sourceErrors: [{ ...MARKUP_ERROR, message: "&lt;h1&gt;Bad gateway&lt;/h1&gt;" }] },
      "Bad gateway",
    ],
    // The messages older code stored verbatim, which a source error's message no longer keeps.
    [
      "a JavaScript stack trace in a source error",
      {
        sourceErrors: [
          {
            ...MARKUP_ERROR,
            message: "HTTP 500 — TypeError: x is undefined at handler (/srv/app/index.js:10:5)",
          },
        ],
      },
      "/srv/app/index.js",
    ],
    [
      "a token link in a source error",
      {
        sourceErrors: [
          { ...MARKUP_ERROR, message: "HTTP 403 — https://api.example.com/v1?token=abc123 denied" },
        ],
      },
      "abc123",
    ],
    [
      "a Python traceback in a source error",
      {
        sourceErrors: [
          {
            ...MARKUP_ERROR,
            message: 'Traceback (most recent call last): File "/app/main.py", line 3',
          },
        ],
      },
      "/app/main.py",
    ],
    [
      "a raw link in a source error",
      {
        sourceErrors: [
          { ...MARKUP_ERROR, message: "HTTP 404 — see https://api.example.com/v1/private-path" },
        ],
      },
      "private-path",
    ],
  ])("does not serve a stored run that holds %s", async (_name, held, text) => {
    const { runId } = await analyze("plain query");
    storeHeld(runId, held);
    const logs = captureLogsForTests();

    try {
      const byId = await request(app).get(`/api/runs/${runId}`);
      expect(byId.status).toBe(404);
      expect(byId.body).toEqual(REFUSED_BODY);
      const byTrack = await request(app).get(`/api/runs/by-track/${TRACK_ID}`);
      expect(byTrack.status).toBe(404);
      expect(byTrack.body).toMatchObject({ success: false, code: "not_found" });
      for (const res of [byId, byTrack]) expect(res.text).not.toContain(text);
      // The log names the run and why; no line holds the text.
      expect(logs.lines().some((line) => line.includes(runId))).toBe(true);
      for (const line of logs.lines()) expect(line).not.toContain(text);
    } finally {
      logs.restore();
    }
  });

  it.each([
    ["the latest run no longer fits and the older one is refused", "latest", "older"],
    ["the latest run is refused and the older one no longer fits", "older", "latest"],
  ])("answers failed for a track when %s", async (_name, unfitRun, refusedRun) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const runs = {
      older: (await analyze("plain query")).runId,
      latest: (await analyze("plain query again")).runId,
    };
    getDb()
      .prepare("UPDATE runs SET finished_at = finished_at - 60 WHERE run_id = ?")
      .run(runs.older);
    storeHeld(runs[refusedRun as keyof typeof runs], { evidence: [FORUM_PAGE] });
    getDb()
      .prepare("UPDATE runs SET analysis = '{\"id\":1}' WHERE run_id = ?")
      .run(runs[unfitRun as keyof typeof runs]);

    // Something is broken (a result that no longer fits), so the answer is not "no run".
    const res = await request(app).get(`/api/runs/by-track/${TRACK_ID}`);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, code: "failed" });
    expect(res.text).not.toContain("RecordFan");
  });

  it("serves a run stored now whatever its sources' errors said", async () => {
    // Each kind of source error the code writes, made by the code that writes it.
    const failure = async (route: FetchRoute) => {
      stubFetch(route);
      try {
        await fetchJson({
          source: "musicbrainz",
          url: "https://musicbrainz.org/ws/2/recording/x",
          cassette: false,
        });
      } catch (error) {
        return error;
      } finally {
        vi.unstubAllGlobals();
      }
      throw new Error("the request did not fail");
    };
    hooks.sourceErrors = [
      notConfigured("genius", "GENIUS_ACCESS_TOKEN").error,
      errorRecord(
        "musicbrainz",
        await failure(() => html("<html><h1>Bad gateway</h1></html>", 502)),
      ),
      errorRecord(
        "musicbrainz",
        await failure(() => json({ message: "<b>Bad</b> request" }, { status: 400 })),
      ),
      errorRecord(
        "musicbrainz",
        await failure(() =>
          json({ error: "see https://api.example.com/docs?token=abc123" }, { status: 400 }),
        ),
      ),
      errorRecord(
        "musicbrainz",
        await failure(() =>
          json({ detail: "TypeError at handler (/srv/app/index.js:10:5)" }, { status: 500 }),
        ),
      ),
      errorRecord("musicbrainz", await failure(() => json({}, { status: 429 }))),
      // A network error echoes the address it could not reach.
      errorRecord(
        "musicbrainz",
        await failure(() => {
          throw new Error("connect ECONNREFUSED https://musicbrainz.org/ws/2/private-path");
        }),
      ),
      errorRecord("discogs", new SourceError("discogs", "timeout", "no answer within 10000 ms")),
      // Our own reader failing, on a link and on a name with angle brackets.
      errorRecord("lastfm", new TypeError("Failed to parse URL from https://example.org/a path")),
      errorRecord("lastfm", new TypeError("Cannot read properties of Map<string> (reading 'x')")),
    ];
    const raw = JSON.stringify(hooks.sourceErrors);
    // Some of them hold what a stored message no longer keeps.
    expect(raw).toMatch(/private-path|example\.org|Map<string>/);

    const { runId, events } = await analyze("fresh query");
    expect(events.map((e) => e.type)).toContain("complete");

    const res = await request(app).get(`/api/runs/${runId}`);
    expect(res.status).toBe(200);
    const sourceErrors = res.body.analysis.run.sourceErrors as Array<{ message?: string }>;
    expect(sourceErrors).toHaveLength(hooks.sourceErrors.length);
    expect(heldTextIssue(res.body.analysis)).toBeNull();
    expect(res.text).not.toMatch(/private-path|example\.org|Map<string>|abc123|index\.js/);
    // The result sent is the one served.
    const complete = events.find((e) => e.type === "complete") as unknown as {
      data: { run: object };
    };
    expect(complete.data.run).toMatchObject({ sourceErrors });
    const byTrack = await request(app).get(`/api/runs/by-track/${TRACK_ID}`);
    expect(byTrack.body.run.id).toBe(runId);
  });

  it("serves a stored run whose evidence and source errors pass, unchanged", async () => {
    const { runId } = await analyze("plain query");
    const sourceErrors = [
      { source: "discogs", code: "unavailable", message: "the source refused the request" },
    ];
    storeHeld(runId, { evidence: [CLEAN_PAGE], sourceErrors });
    const stored = getRun(getDb(), runId);

    const byId = await request(app).get(`/api/runs/${runId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual({
      success: true,
      run: {
        id: runId,
        status: "completed",
        mode: "live",
        spotifyId: TRACK_ID,
        createdAt: new Date((stored?.createdAt ?? 0) * 1000).toISOString(),
        finishedAt: new Date((stored?.finishedAt ?? 0) * 1000).toISOString(),
      },
      analysis: stored?.analysis,
    });
    expect(byId.body.analysis.evidence).toEqual([CLEAN_PAGE]);
    expect(byId.body.analysis.run.sourceErrors).toEqual(sourceErrors);
    const byTrack = await request(app).get(`/api/runs/by-track/${TRACK_ID}`);
    expect(byTrack.body).toEqual(byId.body);
  });

  it("removes a run's events when retention removes the run", async () => {
    const { runId } = await analyze("plain query");
    expect(storedEvents(runId).length).toBeGreaterThan(0);

    const result = pruneDatabase(getDb(), DEFAULT_RETENTION, Date.now() + 31 * 24 * 3600_000);
    expect(result.runs).toBe(1);
    expect(result.runEvents).toBeGreaterThan(0);
    expect(storedEvents(runId)).toEqual([]);
    expect((await request(app).get(`/api/runs/${runId}`)).status).toBe(404);
    expect((await request(app).get(`/api/runs/by-track/${TRACK_ID}`)).status).toBe(404);
  });
});
