/**
 * Route tests for /api/runs*: runs started through the real analysis routes and the real
 * compiled graph, on the app createApp builds, with the nodes that call outside services replaced
 * by stubs (as in analyze.test.ts). The clarification node is the real one, so a run that pauses
 * for a choice and is resumed goes through LangGraph's interrupt().
 *
 * The stub scout picks its path from the query: "ambiguous …" offers two candidates, so the run
 * pauses; anything else matches TRACK_ID. The composer reports a result for the matched track.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import { RunResponse } from "@liner-notes/contract";
import request from "supertest";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SonicAgentStateType } from "../../agent/state.js";
import { DEFAULT_RATE_LIMIT, DEFAULT_SEARCH_RATE_LIMIT } from "../../config/settings.js";
import { closeDatabase, getDb, initializeDatabase } from "../../store/database.js";
import { DEFAULT_RETENTION, pruneDatabase } from "../../store/retention.js";
import { getRun, listRunEvents } from "../../store/runs.js";
import { createApp } from "../app.js";

const TRACK_ID = "0RunsRouteTestTrack001";
const CHOICE_A = "0RunsRouteTestTrackA01";
const CHOICE_B = "0RunsRouteTestTrackB01";

vi.mock("../../sources/spotify.js", () => ({
  getTrackDetails: {
    invoke: async ({ trackId }: { trackId: string }) =>
      JSON.stringify({
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
  },
}));

vi.mock("../../agent/nodes/index.js", async () => {
  const { clarificationNode } = await vi.importActual<
    typeof import("../../agent/nodes/clarificationNode.js")
  >("../../agent/nodes/clarificationNode.js");

  type State = SonicAgentStateType;
  type Config = LangGraphRunnableConfig;
  const status = (config: Config, node: string, message: string) =>
    config.writer?.({ type: "status", node, message, timestamp: new Date().toISOString() });

  return {
    clarificationNode,
    scoutNode: async (state: State, config: Config) => {
      status(config, "scout", "searching");
      if (state.songQuery.startsWith("ambiguous")) {
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
      return { spotifyData: { id: "0RunsRouteTestTrack001", title: "Title", artist: "Artist" } };
    },
    engineerNode: async (_state: State, config: Config) => {
      status(config, "engineer", "measuring");
      return {};
    },
    historianNode: async () => ({}),
    composerNode: async (state: State, config: Config) => {
      const trackData = {
        id: state.spotifyData?.id,
        title: "Composed",
        artist: "Artist",
        album: "Album",
        coverUrl: "",
        previewUrl: "https://cdnt-preview.dzcdn.net/stream/c-abc?hdnea=exp=1~hmac=secret",
        bpm: null,
        genealogy: { nodes: [], links: [] },
        // Not a TrackAnalysis field: the runs routes must never pass it on.
        songQuery: state.songQuery,
      };
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

const storedEvents = (runId: string) =>
  listRunEvents(getDb(), runId).map(({ stream, seq, event }) => ({
    stream,
    seq,
    type: (event as Event).type,
  }));

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
    getDb().exec("DELETE FROM runs; DELETE FROM run_events;");
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("serves the latest completed run of a track, without the typed query", async () => {
    const typed = "midnight zebra typed words";
    await analyze(`${typed} first`);
    const { runId, events } = await analyze(typed);
    expect(events.map((e) => e.type)).toContain("complete");

    const res = await request(app).get(`/api/runs/by-track/${TRACK_ID}`);
    expect(res.status).toBe(200);
    const parsed = RunResponse.safeParse(res.body);
    expect(parsed.success).toBe(true);
    expect(res.body.run).toMatchObject({
      id: runId,
      status: "completed",
      mode: "live",
      spotifyId: TRACK_ID,
      finishedAt: expect.any(String),
    });
    expect(res.body.analysis).toMatchObject({ id: TRACK_ID, title: "Composed" });

    // Neither the query nor an expiring preview URL is served back.
    expect(res.text).not.toContain("zebra");
    expect(res.text).not.toContain("dzcdn");
    expect(JSON.stringify(getRun(getDb(), runId)?.analysis)).not.toContain("dzcdn");

    const byId = await request(app).get(`/api/runs/${runId}`);
    expect(byId.status).toBe(200);
    expect(byId.body).toEqual(res.body);
  });

  it("stores the events the stream sent, in order", async () => {
    const { runId, events } = await analyze("plain query");
    const sent = events.filter((e) => e.type !== "heartbeat");
    expect(storedEvents(runId)).toEqual(sent.map((e, i) => ({ stream: 0, seq: i, type: e.type })));
    const complete = listRunEvents(getDb(), runId).find(
      (e) => (e.event as Event).type === "complete",
    );
    expect(JSON.stringify(complete?.event)).not.toContain("dzcdn");
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

    const strip = (events: Event[], stream: number) =>
      events
        .filter((e) => e.type !== "heartbeat")
        .map((e, i) => ({ stream, seq: i, type: e.type }));
    expect(storedEvents(runId)).toEqual([...strip(first.events, 0), ...strip(second, 1)]);

    // A refused resume of the finished run stores nothing.
    const refused = await sse(resumePath(runId, CHOICE_A));
    expect(refused.map((e) => e.type)).toEqual(["error", "done"]);
    expect(storedEvents(runId)).toHaveLength(first.events.length + second.length);

    const res = await request(app).get(`/api/runs/by-track/${CHOICE_B}`);
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ id: runId, status: "completed", spotifyId: CHOICE_B });
  });

  it("stores the result of a POST analysis", async () => {
    const res = await request(app).post("/api/analyze").send({ query: "posted query" });
    expect(res.status).toBe(200);
    const stored = await request(app).get(`/api/runs/${res.body.threadId}`);
    expect(stored.status).toBe(200);
    expect(stored.body.run).toMatchObject({ status: "completed", spotifyId: TRACK_ID });
    expect(stored.body.analysis).toMatchObject({ id: TRACK_ID });
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
