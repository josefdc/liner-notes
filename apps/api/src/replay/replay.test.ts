/**
 * Replay mode end to end, in process: a stubbed live run is stored by the real analysis routes
 * (the nodes that call outside services are stubs, as in runs.test.ts), recorded with the
 * recorder, written to a scratch replay directory and served under REPLAY_MODE by the app
 * createApp builds. Under REPLAY_MODE=only nothing live may run: the stub scout, the Spotify
 * search and the model layer count their calls, and every replay test requires 0.
 *
 * The stub scout picks its path from the query: "ambiguous …" offers two candidates (the run
 * pauses), anything else matches TRACK_ID. The stub composer's result carries a preview URL
 * (under `previewUrl` and as a genealogy image), a cover URL and the typed query in a field the
 * contract does not name, and a status event names the typed query.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  AnalyzeStreamEvent,
  type ReplayRecord,
  RunResponse,
  runIssues,
  TrackAnalysis,
} from "@liner-notes/contract";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SonicAgentStateType } from "../agent/state.js";
import { DEFAULT_RATE_LIMIT, DEFAULT_SEARCH_RATE_LIMIT } from "../config/settings.js";
import { createApp } from "../http/app.js";
import { closeDatabase, getDb, initializeDatabase } from "../store/database.js";
import { getRun, listRunEvents } from "../store/runs.js";
import { chooseReplay, currentReplayMode, liveRefused } from "./mode.js";
import { setReplayPacingForTests } from "./player.js";
import { buildRecord, leaks, RecordRefused, recordedRunId } from "./recorder.js";
import {
  DEFAULT_REPLAY_DIR,
  loadReplays,
  normalizeQuery,
  resetReplaysForTests,
} from "./records.js";

const TRACK_ID = "0ReplayTestTrack000001";
const CHOICE_A = "0ReplayTestTrackA00001";
const CHOICE_B = "0ReplayTestTrackB00001";
const SECRET = "configured-secret-value-123456";

const live = vi.hoisted(() => ({ scout: 0, search: 0, model: 0 }));

vi.mock("../sources/spotify.js", () => ({
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
  searchMultipleTracks: {
    invoke: async () => {
      live.search += 1;
      return JSON.stringify([]);
    },
  },
}));

vi.mock("../llm/invoke.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/invoke.js")>();
  return {
    ...actual,
    llm: {
      ...actual.llm,
      invoke: async () => {
        live.model += 1;
        throw new Error("no model in these tests");
      },
      endRun: () => {},
      callsForRun: () => 0,
    },
  };
});

vi.mock("../agent/nodes/index.js", async () => {
  const { clarificationNode } = await vi.importActual<
    typeof import("../agent/nodes/clarificationNode.js")
  >("../agent/nodes/clarificationNode.js");

  type State = SonicAgentStateType;
  type Config = LangGraphRunnableConfig;
  const status = (config: Config, node: string, message: string) =>
    config.writer?.({ type: "status", node, message, timestamp: new Date().toISOString() });

  return {
    clarificationNode,
    scoutNode: async (state: State, config: Config) => {
      live.scout += 1;
      status(config, "scout", `Searching for "${state.songQuery}"`);
      if (state.songQuery.startsWith("ambiguous")) {
        const candidates = ["0ReplayTestTrackA00001", "0ReplayTestTrackB00001"].map((id) => ({
          id,
          title: `Title ${id}`,
          artist: "Artist",
          album: "Album",
          coverUrl: "https://i.scdn.co/image/candidate",
          popularity: 40,
        }));
        return { candidates };
      }
      return { spotifyData: { id: "0ReplayTestTrack000001", title: "Title", artist: "Artist" } };
    },
    engineerNode: async (_state: State, config: Config) => {
      status(config, "engineer", "measuring");
      return {};
    },
    historianNode: async () => ({}),
    composerNode: async (state: State, config: Config) => {
      const preview = "https://cdnt-preview.dzcdn.net/stream/c-abc?hdnea=exp=1~hmac=secret";
      const trackData: Record<string, unknown> = {
        id: state.spotifyData?.id,
        title: "Recorded Song",
        artist: "The Recorders",
        album: "Tapes",
        coverUrl: "https://i.scdn.co/image/cover",
        previewUrl: preview,
        spotifyUrl: `https://open.spotify.com/track/${state.spotifyData?.id}`,
        bpm: null,
        preview: { provider: "deezer", method: "isrc", score: null },
        factoids: [
          { id: "fa", title: "A fact", content: "Recorded fact one.", type: "production" },
          { id: "fb", title: "B fact", content: "Recorded fact two.", type: "trivia" },
        ],
        genealogy: {
          nodes: [{ id: "self", group: 1, label: "Recorded Song", size: 10, img: preview }],
          links: [],
        },
        run: {
          id: config.configurable?.thread_id,
          mode: state.songQuery.startsWith("replayed") ? "replay" : "live",
          recordedAt: null,
          commit: null,
          analyzerVersion: null,
        },
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

type Event = { type: string; seq?: number; runId?: string; [key: string]: unknown };

const app = createApp({
  http: {
    corsOrigins: ["http://localhost:3110"],
    trustProxy: 0,
    rateLimit: { ...DEFAULT_RATE_LIMIT, max: 10_000 },
    globalRateLimit: { windowMs: DEFAULT_RATE_LIMIT.windowMs, max: 10_000 },
    searchRateLimit: { ...DEFAULT_SEARCH_RATE_LIMIT, max: 10_000 },
  },
});

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
    .map((line) => JSON.parse(line.slice("data: ".length)) as Event)
    .filter((event) => event.type !== "heartbeat");
}

const streamPath = (query: string) => `/api/analyze/stream?query=${encodeURIComponent(query)}`;
const types = (events: Event[]) => events.map((event) => event.type);

/** Runs a live (stubbed) streamed analysis; returns its run id. */
async function liveRun(query: string): Promise<string> {
  const events = await sse(streamPath(query));
  return events[0]?.runId as string;
}

const stored = (runId: string) => {
  const run = getRun(getDb(), runId);
  if (!run) throw new Error(`no run ${runId}`);
  return { run, events: listRunEvents(getDb(), runId) };
};

const record = (runId: string, slug = "recorded-song") =>
  buildRecord(stored(runId).run, stored(runId).events, {
    slug,
    commit: "abc1234",
    secrets: [SECRET],
  });

const refusal = (fn: () => unknown): string[] => {
  try {
    fn();
  } catch (err) {
    if (err instanceof RecordRefused) return err.reasons;
    throw err;
  }
  throw new Error("expected a refusal");
};

const noLiveCalls = () => expect(live).toEqual({ scout: 0, search: 0, model: 0 });

// =============================================================================
// Tests
// =============================================================================

let dir: string;
let replayDir: string;
let restorePacing: () => void;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "replay-"));
  replayDir = join(dir, "replays");
  mkdirSync(replayDir);
  initializeDatabase(join(dir, "test.db"));
  restorePacing = setReplayPacingForTests({ speed: 1000, maxGapMs: 0 });
});
afterAll(() => {
  restorePacing();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  getDb().exec("DELETE FROM runs; DELETE FROM run_events; DELETE FROM store_items;");
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.stubEnv("REPLAY_MODE", "");
  vi.stubEnv("REPLAY_DIR", replayDir);
  vi.stubEnv("SPOTIFY_CLIENT_ID", "x");
  vi.stubEnv("SPOTIFY_CLIENT_SECRET", "x");
  resetReplaysForTests();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("the recorder", () => {
  it("records a live run, scrubbed: no previews, images, typed query or run id", async () => {
    const typed = "zebra typed words";
    const runId = await liveRun(typed);
    const { record: built } = record(runId);

    expect(built.request).toEqual({ query: "Recorded Song The Recorders", selectedTrackId: null });
    expect(built.analysis.run).toMatchObject({
      id: recordedRunId("recorded-song"),
      mode: "replay",
      recordedAt: built.recordedAt,
      commit: "abc1234",
      analyzerVersion: null,
    });
    expect(runIssues(built.analysis.run!, built.analysis.audio)).toEqual([]);
    expect(built.analysis.coverUrl).toBe("");
    expect(built.analysis).not.toHaveProperty("previewUrl");
    expect(built.analysis.preview).toEqual({ provider: "deezer", method: "isrc", score: null });
    expect(built.analysis.genealogy.nodes[0].img).toBe("");
    expect(types(built.events.map((e) => e.event as Event))).toEqual([
      "connected",
      "status",
      "status",
      "complete",
      "done",
    ]);
    expect(built.events.map((e) => (e.event as Event).seq)).toEqual([0, 1, 2, 3, 4]);
    const text = JSON.stringify(built);
    expect(text).not.toContain(runId);
    expect(text).not.toContain(typed);
    expect(text).not.toMatch(/dzcdn|hdnea|i\.scdn/);
    expect(leaks(built, { secrets: [SECRET], typedQuery: typed, allowed: "" })).toEqual([]);
  });

  it("joins a paused and resumed run into one stream numbered from 0, without the pause", async () => {
    const events = await sse(streamPath("ambiguous pick"));
    const threadId = events[0].runId as string;
    expect(types(events)).toContain("interrupt");
    await sse(`/api/analyze/stream/resume?threadId=${threadId}&selectedTrackId=${CHOICE_A}`);
    expect(new Set(stored(threadId).events.map((e) => e.stream))).toEqual(new Set([0, 1]));

    const { record: built } = record(threadId);
    const recorded = built.events.map((e) => e.event as Event);
    expect(types(recorded)).not.toContain("interrupt");
    expect(types(recorded)).not.toContain("resuming");
    expect(types(recorded)[0]).toBe("connected");
    expect(types(recorded).slice(-2)).toEqual(["complete", "done"]);
    expect(recorded.map((e) => e.seq)).toEqual(recorded.map((_, i) => i));
    expect(built.request.selectedTrackId).toBe(CHOICE_A);
    expect(built.analysis.id).toBe(CHOICE_A);
    // The other candidate (and its image) went with the pause.
    expect(JSON.stringify(built)).not.toContain(CHOICE_B);
  });

  it("refuses a stream that was cut short, an unfinished run and a replayed result", async () => {
    const cut = await liveRun("cut short");
    getDb()
      .prepare("DELETE FROM run_events WHERE run_id = ? AND json_extract(event, '$.type') = 'done'")
      .run(cut);
    expect(refusal(() => record(cut)).join(" ")).toContain("does not end with done");

    const events = await sse(streamPath("ambiguous never resumed"));
    const paused = events[0].runId as string;
    expect(refusal(() => record(paused)).join(" ")).toContain("not completed");

    const replayed = await liveRun("replayed answers");
    expect(refusal(() => record(replayed)).join(" ")).toContain("not a live result");

    const gap = await liveRun("missing an event");
    getDb().prepare("DELETE FROM run_events WHERE run_id = ? AND seq = 1").run(gap);
    expect(refusal(() => record(gap)).join(" ")).toContain("missing events");

    expect(refusal(() => record(cut, "Bad Slug")).join(" ")).toContain("slug");
  });

  it("reports credentials, secret shapes, preview and image URLs and the typed query by path", () => {
    const found = leaks(
      {
        a: `token ${SECRET}`,
        b: "Authorization: Bearer abcdefghijklmnop1234",
        c: "listen at https://cdnt-preview.dzcdn.net/x.mp3",
        d: ["https://i.scdn.co/image/abc"],
        e: "they typed my private words",
        f: "Recorded Song by The Recorders",
      },
      { secrets: [SECRET], typedQuery: "my private words", allowed: "Recorded Song" },
    );
    expect(found).toEqual(
      expect.arrayContaining([
        "a: a configured credential",
        "b: a bearer or basic credential",
        "c: a preview URL",
        "d[0]: an image or media URL",
        "e: the query the user typed",
      ]),
    );
    expect(found.join(" ")).not.toContain(SECRET);
    expect(found.some((line) => line.startsWith("f:"))).toBe(false);
  });

  it("redacts a configured credential the stored result holds", async () => {
    const runId = await liveRun("plain words");
    const { run, events } = stored(runId);
    const { record: built } = buildRecord(run, events, {
      slug: "recorded-song",
      commit: "abc1234",
      secrets: ["Tapes"],
    });
    expect(built.analysis.album).toBe("[redacted]");
    expect(JSON.stringify(built)).not.toContain("Tapes");
  });
});

describe("the dev fixture", () => {
  it("loads, says it is a replay, and is found by its title and artist", () => {
    const set = loadReplays(DEFAULT_REPLAY_DIR);
    expect(set.problems).toEqual([]);
    expect(set.records.length).toBeGreaterThan(0);
    for (const fixture of set.records) {
      const run = fixture.analysis.run!;
      expect(run.mode).toBe("replay");
      expect(runIssues(run, fixture.analysis.audio)).toEqual([]);
      expect(JSON.stringify(fixture)).not.toMatch(/dzcdn|hdnea|p\.scdn|i\.scdn|mzstatic/);
      expect(set.forQuery(`${fixture.analysis.title} ${fixture.analysis.artist}`)).toBe(fixture);
    }
  });
});

describe("REPLAY_MODE", () => {
  let fixture: ReplayRecord;

  beforeEach(async () => {
    const runId = await liveRun("source run");
    fixture = record(runId).record;
    writeFileSync(join(replayDir, `${fixture.slug}.json`), JSON.stringify(fixture));
    resetReplaysForTests();
    getDb().exec("DELETE FROM runs; DELETE FROM run_events;");
    live.scout = 0;
    live.search = 0;
    live.model = 0;
  });

  it("reads the mode: off, fallback without keys, only; anything else as only", () => {
    vi.stubEnv("REPLAY_MODE", "off");
    expect(liveRefused()).toBe(false);
    vi.stubEnv("REPLAY_MODE", "fallback");
    expect(liveRefused()).toBe(false);
    vi.stubEnv("SPOTIFY_CLIENT_SECRET", "");
    expect(liveRefused()).toBe(true);
    vi.stubEnv("REPLAY_MODE", "only");
    expect(liveRefused()).toBe(true);
    vi.stubEnv("REPLAY_MODE", "sometimes");
    expect(currentReplayMode()).toBe("only");
    expect(chooseReplay((set) => set.forQuery("nothing recorded"))).toEqual({ kind: "refused" });
  });

  it("only: replays a recorded track as a new run, stored as a replay, with no live call", async () => {
    vi.stubEnv("REPLAY_MODE", "only");
    const events = await sse(streamPath("the RECORDERS — recorded song"));
    const runId = events[0].runId as string;

    expect(types(events)).toEqual(types(fixture.events.map((e) => e.event as Event)));
    expect(events.every((event) => AnalyzeStreamEvent.safeParse(event).success)).toBe(true);
    expect(events.every((event, i) => event.runId === runId && event.seq === i)).toBe(true);
    expect(events[0]).toMatchObject({ type: "connected", threadId: runId });
    const complete = events.find((event) => event.type === "complete") as Event;
    const result = TrackAnalysis.parse(complete.data);
    expect(result.run).toMatchObject({
      id: runId,
      mode: "replay",
      recordedAt: fixture.recordedAt,
      commit: "abc1234",
    });
    expect(runIssues(result.run!, result.audio)).toEqual([]);
    noLiveCalls();

    // Recorded as a replay of the record, which the runs routes serve with this run's id;
    // neither the result nor the events are copied.
    expect(getRun(getDb(), runId)).toMatchObject({
      status: "completed",
      mode: "replay",
      spotifyId: TRACK_ID,
      analysis: null,
      payload: { replayOf: { slug: fixture.slug, recordedAt: fixture.recordedAt } },
    });
    expect(listRunEvents(getDb(), runId)).toEqual([]);
    const byTrack = await request(app).get(`/api/runs/by-track/${TRACK_ID}`);
    expect(byTrack.status).toBe(200);
    expect(RunResponse.safeParse(byTrack.body).success).toBe(true);
    expect(byTrack.body.run).toMatchObject({ id: runId, mode: "replay" });
    expect(byTrack.body.analysis).toEqual(result);
    expect(byTrack.text.toLowerCase()).not.toContain("the recorders — recorded song");
    const byId = await request(app).get(`/api/runs/${runId}`);
    expect(byId.body.analysis.run).toMatchObject({ id: runId, mode: "replay" });

    // A recording that is no longer served (removed, or recorded again) gives no result.
    rmSync(join(replayDir, `${fixture.slug}.json`));
    resetReplaysForTests();
    expect((await request(app).get(`/api/runs/${runId}`)).body.analysis).toBeNull();
    expect((await request(app).get(`/api/runs/by-track/${TRACK_ID}`)).status).toBe(404);
  });

  it("only: refuses a query with no recording (live_disabled), never another recording", async () => {
    vi.stubEnv("REPLAY_MODE", "only");
    const events = await sse(streamPath("Recorded"));
    expect(events.map((e) => [e.type, e.code])).toEqual([
      ["error", "live_disabled"],
      ["done", undefined],
    ]);
    const post = await request(app).post("/api/analyze").send({ query: "Another Song" });
    expect(post.status).toBe(503);
    expect(post.body.code).toBe("live_disabled");
    noLiveCalls();
  });

  it("only: POST /api/analyze answers with the recorded result as a new run", async () => {
    vi.stubEnv("REPLAY_MODE", "only");
    const res = await request(app).post("/api/analyze").send({ query: "Recorded Song" });
    // The title alone does not name a recording: only title and artist do.
    expect(res.status).toBe(503);
    const full = await request(app)
      .post("/api/analyze")
      .send({ query: "Recorded Song The Recorders" });
    expect(full.status).toBe(200);
    expect(full.body.data.run).toMatchObject({ id: full.body.threadId, mode: "replay" });
    expect(getRun(getDb(), full.body.threadId)).toMatchObject({ mode: "replay" });
    noLiveCalls();
  });

  it("only: refuses resumes, a paused live run cannot go on", async () => {
    vi.stubEnv("REPLAY_MODE", "only");
    const post = await request(app)
      .post("/api/analyze/resume")
      .send({ threadId: "some-thread", selectedTrackId: CHOICE_A });
    expect(post.body.code).toBe("live_disabled");
    const events = await sse(
      `/api/analyze/stream/resume?threadId=some-thread&selectedTrackId=${CHOICE_A}`,
    );
    expect(events.map((e) => e.code ?? e.type)).toEqual(["live_disabled", "done"]);
    noLiveCalls();
  });

  it("only: suggestions come from the recordings", async () => {
    vi.stubEnv("REPLAY_MODE", "only");
    const none = await request(app).get("/api/search/suggest?query=dyn");
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ success: true, suggestions: [] });
    const some = await request(app).get("/api/search/suggest?query=recorders%20tap");
    expect(some.body.suggestions).toEqual([
      {
        id: TRACK_ID,
        title: "Recorded Song",
        artist: "The Recorders",
        album: "Tapes",
        coverUrl: "",
      },
    ]);
    noLiveCalls();
  });

  it("only: more facts are the recorded ones the client does not have, or live_disabled", async () => {
    vi.stubEnv("REPLAY_MODE", "only");
    const more = await request(app)
      .post("/api/factoids/decrypt")
      .send({
        trackId: TRACK_ID,
        trackTitle: "Recorded Song",
        trackArtist: "The Recorders",
        existingFactoidIds: ["fa"],
      });
    expect(more.status).toBe(200);
    expect(more.body.factoids).toEqual([
      { id: "f2", title: "B fact", content: "Recorded fact two.", type: "trivia", entities: [] },
    ]);

    const other = await request(app)
      .post("/api/factoids/decrypt")
      .send({ trackId: "other", trackTitle: "Other", existingFactoidIds: [] });
    expect(other.status).toBe(503);
    expect(other.body.code).toBe("live_disabled");

    const streamed = await sse(
      "/api/factoids/decrypt/stream?trackTitle=Recorded%20Song&trackArtist=The%20Recorders",
    );
    expect(streamed.map((e) => e.type)).toEqual(["connected", "factoid", "factoid", "done"]);
    const refused = await sse("/api/factoids/decrypt/stream?trackTitle=Other");
    expect(refused.map((e) => e.code ?? e.type)).toEqual(["live_disabled", "done"]);
    // A title without its artist does not name a recording.
    const titleOnly = await sse("/api/factoids/decrypt/stream?trackTitle=Recorded%20Song");
    expect(titleOnly.map((e) => e.code ?? e.type)).toEqual(["live_disabled", "done"]);
    noLiveCalls();
  });

  it("fallback: live while the keys are set; recordings only without them", async () => {
    vi.stubEnv("REPLAY_MODE", "fallback");
    const liveEvents = await sse(streamPath("Recorded Song The Recorders"));
    expect(live.scout).toBe(1);
    const liveComplete = liveEvents.find((event) => event.type === "complete") as Event;
    expect((liveComplete.data as TrackAnalysis).run?.mode).toBe("live");

    vi.stubEnv("SPOTIFY_CLIENT_ID", "");
    const replayed = await sse(streamPath("Recorded Song The Recorders"));
    const complete = replayed.find((event) => event.type === "complete") as Event;
    expect((complete.data as TrackAnalysis).run?.mode).toBe("replay");
    const refused = await sse(streamPath("Something else"));
    expect(refused.map((e) => e.code ?? e.type)).toEqual(["live_disabled", "done"]);
    expect(live.scout).toBe(1);
  });
});

describe("the replay directory", () => {
  it("leaves out files that are not valid records, and never matches loosely", async () => {
    const runId = await liveRun("source run");
    const good = record(runId, "good-one").record;
    const bad = join(dir, "bad-replays");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "good-one.json"), JSON.stringify(good));
    writeFileSync(join(bad, "not-json.json"), "{");
    writeFileSync(join(bad, "renamed.json"), JSON.stringify(good));
    writeFileSync(
      join(bad, "live-result.json"),
      JSON.stringify({
        ...good,
        slug: "live-result",
        analysis: { ...good.analysis, run: { ...good.analysis.run, mode: "live" } },
      }),
    );

    const set = loadReplays(bad);
    expect(set.records.map((r) => r.slug)).toEqual(["good-one"]);
    expect(set.problems.join("\n")).toMatch(/not-json\.json: not JSON/);
    expect(set.problems.join("\n")).toMatch(/renamed\.json: slug "good-one"/);
    expect(set.problems.join("\n")).toMatch(/live-result\.json: not a replay record/);
    expect(set.forQuery("Recorded Song The Recorders")?.slug).toBe("good-one");
    expect(set.forQuery("The Recorders: Recorded Song!")?.slug).toBe("good-one");
    expect(set.forQuery("Recorded Song The Recorder")).toBeNull();
    expect(set.forQuery("Recorded")).toBeNull();
    expect(normalizeQuery("  Beyoncé — HALO!! ")).toBe("beyonce halo");
  });
});
