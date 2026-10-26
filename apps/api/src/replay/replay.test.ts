/**
 * Replay mode end to end, in process: a stubbed live run is stored by the real analysis routes
 * (the nodes that call outside services are stubs, as in runs.test.ts), recorded with the
 * recorder, written to a scratch replay directory and served under REPLAY_MODE by the app
 * createApp builds. Under REPLAY_MODE=only nothing live may run: the stub scout, the Spotify
 * search and the model layer count their calls, and every replay test requires 0.
 *
 * The stub scout picks its path from the query: "ambiguous …" offers two candidates (the run
 * pauses), anything else matches TRACK_ID; for "echo …" its status repeats the typed query. The
 * stub composer's result carries a preview URL (under `previewUrl`, as a genealogy image and as a
 * genealogy node's clip), a cover URL and the typed query in a field the contract does not name.
 */

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  AnalyzeStreamEvent,
  measuredCopyIssues,
  ReplayRecord,
  ReplaysResponse,
  RunResponse,
  runIssues,
  SourceError,
  SourceId,
  TrackAnalysis,
} from "@liner-notes/contract";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { finalizeResult } from "../agent/finalize.js";
import type { TrackData } from "../agent/schema.js";
import type { SonicAgentStateType } from "../agent/state.js";
import {
  heldTextIssue,
  STORED_LINE,
  STORED_UNCHECKED_LINE,
  storedErrorStatus,
} from "../agent/storedResults.js";
import {
  foundLine,
  lostRecordsLine,
  MODEL_FAILURE_TEXT,
  selectedLine,
  sourceErrorLine,
} from "../agent/statusText.js";
import {
  cachedLine,
  MEASURING_LINE,
  measuredLine,
  measuredSummary,
  UNVERSIONED_REASON,
} from "../agent/nodes/engineerNode.js";
import { PLANNER_LINES, plannerLine } from "../agent/research/plannerLines.js";
import { reasonIssue } from "../sources/http.js";
import { INTERNAL_ERROR_PREFIX } from "../sources/toolResult.js";
import {
  ANALYZER_VERSION,
  audioV2,
  gatedV2,
  ISRC_MATCH,
  keyWithheldV2,
  measurementOf,
  signalOnlyV2,
} from "../agent/testing/measuredAudio.js";
import { DEFAULT_RATE_LIMIT, DEFAULT_SEARCH_RATE_LIMIT } from "../config/settings.js";
import { runningCommit } from "../config/checkoutCommit.js";
import { main as recordMain } from "./record.js";
import { createApp } from "../http/app.js";
import { resolveSpendLogPath } from "../llm/budget.js";
import { resetBudgetStateForTests } from "../llm/budgetState.js";
import { acquireLock } from "../llm/fileLock.js";
import { captureLogsForTests } from "../logger.js";
import { FORUM_THREADS } from "../sources/testing/forumThreads.js";
import { closeDatabase, getDb, initializeDatabase } from "../store/database.js";
import { getRun, listRunEvents } from "../store/runs.js";
import { chooseReplay, currentReplayMode, liveRefused } from "./mode.js";
import { playRecord, replayedAnalysis, setReplayPacingForTests } from "./player.js";
import {
  archiveCoverOf,
  buildRecord,
  leaks,
  publicTextsOf,
  RecordRefused,
  recordedRunId,
  withoutMediaFields,
} from "./recorder.js";
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
  searchTracks: async () => {
    live.search += 1;
    return [];
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
      status(
        config,
        "scout",
        state.songQuery.startsWith("echo") ? `Searching for "${state.songQuery}"` : "Searching",
      );
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
          {
            id: "fa",
            title: "A fact",
            content: "Recorded fact one.",
            type: "production",
            claimId: "claim-a",
          },
          { id: "fb", title: "B fact", content: "Recorded fact two.", type: "trivia" },
        ],
        genealogy: {
          nodes: [
            { id: "self", group: 1, label: "Recorded Song", size: 10, img: preview },
            // A genealogy node's own clip (Spotify's, or Deezer's by ISRC).
            {
              id: "influence",
              group: 4,
              label: "An Influence",
              size: 8,
              spotifyId: "0ReplayInfluence000001",
              previewUrl: preview,
            },
          ],
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

/** The stored result without what the recorder describes rather than records. */
const content = (analysis: unknown) => {
  const { run: _run, ...rest } = withoutMediaFields(TrackAnalysis.parse(analysis)) as TrackAnalysis;
  return rest;
};

/** A record's run as the stored live run it was recorded from, typed as `typed`. */
function fixtureAsLiveRun(fixture: ReplayRecord, typed: string) {
  const runId = "0f0e0d0c-aaaa-4bbb-8ccc-000000000001";
  const analysis = {
    ...fixture.analysis,
    run: {
      ...fixture.analysis.run!,
      id: runId,
      mode: "live" as const,
      recordedAt: null,
      commit: null,
    },
  };
  const events = fixture.events.map(({ atMs, event }, seq) => ({
    stream: 0,
    seq,
    sentAt: 1_000 + atMs,
    event: {
      ...event,
      runId,
      ...("threadId" in event && { threadId: runId }),
      ...(event.type === "complete" && { data: analysis }),
    },
  }));
  const run = {
    runId,
    threadId: runId,
    query: typed,
    status: "completed" as const,
    createdAt: 1,
    finishedAt: 2,
    modelAvailable: null,
    audioAvailable: null,
    payload: null,
    spotifyId: fixture.analysis.id,
    mode: "live" as const,
    analysis,
    commit: "abc1234",
  };
  return { run, events };
}

describe("the recorder", () => {
  it("replay:record names the commit stored with the run, never the checkout's", async () => {
    const runId = await liveRun("source run");
    vi.stubEnv("SQLITE_DB_PATH", join(dir, "test.db"));
    const out = join(dir, "recorded");
    const warn = vi.mocked(console.warn);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const deps = { settingsFileValues: () => ({}), checkout: () => "bbbbbbbbbbbb" };
    const args = (slug: string, ...extra: string[]) => [
      "--run",
      runId,
      "--slug",
      slug,
      "--out",
      out,
      ...extra,
    ];

    getDb().prepare("UPDATE runs SET code_commit = ? WHERE run_id = ?").run("aaaaaaaaaaaa", runId);
    expect(recordMain(args("stored"), deps)).toBe(0);
    const written = JSON.parse(readFileSync(join(out, "stored.json"), "utf8"));
    expect(written.commit).toBe("aaaaaaaaaaaa");
    expect(written.analysis.run.commit).toBe("aaaaaaaaaaaa");
    expect(warn.mock.calls.map(([m]) => String(m)).join("\n")).toMatch(
      /checkout is at bbbbbbbbbbbb; the record names aaaaaaaaaaaa/,
    );

    // A contradicting --commit is refused; so is a run with none and no --commit.
    expect(recordMain(args("contradicted", "--commit", "bbbbbbbbbbbb"), deps)).toBe(1);
    getDb().prepare("UPDATE runs SET code_commit = NULL WHERE run_id = ?").run(runId);
    expect(recordMain(args("unknown"), deps)).toBe(1);
    expect(errors.mock.calls.map(([m]) => String(m)).join("\n")).toMatch(
      /differs from the commit the run ran at[\s\S]*has no stored commit/,
    );
    expect(recordMain(args("vouched", "--commit", "ccccccc"), deps)).toBe(0);
    expect(JSON.parse(readFileSync(join(out, "vouched.json"), "utf8")).commit).toBe("ccccccc");
  });

  it("a run resumed by a server at another commit keeps no commit; on the same server it keeps it", async () => {
    const pausedRun = async () => {
      const events = await sse(streamPath("ambiguous one"));
      expect(events.some((event) => event.type === "interrupt")).toBe(true);
      return events[0].runId as string;
    };
    const resume = (runId: string) =>
      sse(`/api/analyze/stream/resume?threadId=${runId}&selectedTrackId=${CHOICE_A}`);

    const same = await pausedRun();
    expect(stored(same).run.commit).toBe(runningCommit());
    await resume(same);
    expect(stored(same).run).toMatchObject({ status: "completed", commit: runningCommit() });

    // Paused by a server running other code (as after a restart on an edit).
    const other = await pausedRun();
    getDb().prepare("UPDATE runs SET code_commit = ? WHERE run_id = ?").run("aaaaaaaaaaaa", other);
    await resume(other);
    expect(stored(other).run).toMatchObject({ status: "completed", commit: null });
  });

  it("records a live run as it was sent: only previews, images and the run id are changed", async () => {
    const typed = "zebra typed words";
    const runId = await liveRun(typed);
    const { record: built } = record(runId);

    expect(built.request).toEqual({ query: "Recorded Song The Recorders", selectedTrackId: null });
    expect(built.analysis.run).toMatchObject({
      id: recordedRunId("recorded-song"),
      mode: "replay",
      replayed: "run",
      recordedAt: built.recordedAt,
      commit: "abc1234",
      analyzerVersion: null,
    });
    expect(runIssues(built.analysis.run!, built.analysis.audio)).toEqual([]);
    const complete = built.events.find((e) => (e.event as Event).type === "complete");
    expect((complete?.event as { data?: TrackAnalysis } | undefined)?.data?.run?.replayed).toBe(
      "run",
    );
    // The server stored the commit it runs with on the run, which a recording names.
    expect(stored(runId).run.commit).toBe(runningCommit());

    // A record is a whole run: one that says only its model answers were replayed is refused.
    const modelOnly = structuredClone(built);
    modelOnly.analysis.run = { ...modelOnly.analysis.run!, replayed: "model_answers" };
    expect(
      ReplayRecord.safeParse(modelOnly).error?.issues.map((issue) => issue.path.join(".")),
    ).toEqual(["analysis.run.replayed"]);
    for (const item of modelOnly.events) {
      if (item.event.type === "complete") item.event.data = modelOnly.analysis;
    }
    expect(
      ReplayRecord.safeParse(modelOnly).error?.issues.map((issue) => issue.path.join(".")),
    ).toEqual(["analysis.run.replayed", "events.3.event.data.run.replayed"]);
    expect(built.analysis.coverUrl).toBe("");
    expect(built.analysis).not.toHaveProperty("previewUrl");
    expect(built.analysis.preview).toEqual({ provider: "deezer", method: "isrc", score: null });
    expect(built.analysis.genealogy.nodes[0].img).toBe("");
    expect(built.analysis.genealogy.nodes[1].spotifyId).toBe("0ReplayInfluence000001");
    expect(built.analysis.genealogy.nodes[1]).not.toHaveProperty("previewUrl");
    expect(content(built.analysis)).toEqual(content(stored(runId).run.analysis));
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
  });

  it("never rewrites content that holds the typed query when it is the track's own text", async () => {
    for (const typed of ["Recorded Song", "the recorders", "RECORDED SONG by The Recorders"]) {
      const runId = await liveRun(typed);
      const { record: built } = record(runId);
      expect(built.analysis.title).toBe("Recorded Song");
      expect(built.analysis.artist).toBe("The Recorders");
      expect(content(built.analysis)).toEqual(content(stored(runId).run.analysis));
    }
    // A typed query that is not the track's own text, repeated in a status: refused, never edited.
    const echoed = await liveRun("echo my private words");
    expect(refusal(() => record(echoed))).toEqual(
      expect.arrayContaining([expect.stringMatching(/the query the user typed/)]),
    );
  });

  it("records the dev fixture's content unchanged whatever public text was typed", () => {
    const fixture = loadReplays(DEFAULT_REPLAY_DIR).records[0];
    for (const typed of ["One More Time", "daft punk"]) {
      const { run, events } = fixtureAsLiveRun(fixture, typed);
      const { record: built } = buildRecord(run, events, {
        slug: fixture.slug,
        commit: fixture.commit,
        secrets: [],
      });
      expect(content(built.analysis)).toEqual(content(fixture.analysis));
      const comparable = (event: Event) =>
        event.type === "complete" ? { ...event, data: content(event.data) } : event;
      expect(built.events.map((e) => comparable(e.event as Event))).toEqual(
        fixture.events.map((e) => comparable(e.event as Event)),
      );
    }
  });

  it("does not record how the recorded run's search text matched the track", () => {
    const fixture = loadReplays(DEFAULT_REPLAY_DIR).records[0];
    const matched = {
      ...fixture,
      analysis: { ...fixture.analysis, queryMatch: "partial" as const },
    };
    const { run, events } = fixtureAsLiveRun(matched, "daft punk one more");
    const { record: built } = buildRecord(run, events, {
      slug: fixture.slug,
      commit: fixture.commit,
      secrets: [],
    });
    expect(built.analysis).not.toHaveProperty("queryMatch");
    expect(JSON.stringify(built.events)).not.toContain("queryMatch");
  });

  it("records a measured result's audio block and analyzer version unchanged, and replays them", () => {
    const fixture = loadReplays(DEFAULT_REPLAY_DIR).records[0];
    // The fixture's result as the API finalises it today: with the measurement it came from.
    const measured = {
      ...fixture,
      analysis: finalizeResult(
        fixture.analysis as TrackData,
        measurementOf(audioV2()),
      ) as TrackAnalysis,
    };
    const { run, events } = fixtureAsLiveRun(measured, "daft punk one more");
    const { record: built, warnings } = buildRecord(run, events, {
      slug: fixture.slug,
      commit: fixture.commit,
      secrets: [],
    });

    expect(built.analysis.audio).toEqual(audioV2());
    expect(built.analyzerVersion).toBe(ANALYZER_VERSION);
    expect(built.analysis.run?.analyzerVersion).toBe(ANALYZER_VERSION);
    expect(measuredCopyIssues(built.analysis)).toEqual([]);
    expect(warnings.filter((w) => /measured|audio|bpm|energy|keyMoments/.test(w))).toEqual([]);
    const served = replayedAnalysis(built, "0f0e0d0c-aaaa-4bbb-8ccc-000000000003");
    expect(served.audio).toEqual(audioV2());
    expect(served.run?.analyzerVersion).toBe(ANALYZER_VERSION);
    expect(runIssues(served.run!, served.audio)).toEqual([]);
  });

  it("records source evidence as it is: MusicBrainz ids and long source URLs are content", () => {
    const fixture = loadReplays(DEFAULT_REPLAY_DIR).records[0];
    const mbid = "4f5e6d7c-1111-4222-8333-944455566677";
    const foreignRun = "9a8b7c6d-2222-4333-8444-a55566677788";
    // As sources/identity.ts builds a MusicBrainz recording item, plus long Discogs and
    // Wikipedia pages (long slugs, a path that looks like an image) cited the same way.
    const evidence = [
      {
        id: `musicbrainz:track/recording/${mbid}`,
        source: "musicbrainz",
        sourceTier: "primary-record",
        url: `https://musicbrainz.org/recording/${mbid}`,
        title: "One More Time — MusicBrainz recording",
        retrievedAt: "2026-10-24T16:23:30.000Z",
        excerpt: 'MusicBrainz recording "One More Time" by Daft Punk (5:20), ISRC GBDUW0000059.',
        recordRef: `track/recording/${mbid}`,
      },
      {
        id: "discogs:track/master/12345",
        source: "discogs",
        sourceTier: "primary-record",
        url: "https://www.discogs.com/master/12345-Daft-Punk-One-More-Time-Aerodynamic-Remixes",
        title: "One More Time — Discogs master",
        retrievedAt: "2026-10-24T16:23:30.000Z",
        excerpt: "Discogs master release of One More Time.",
        recordRef: "track/master/12345",
      },
      {
        id: "wikipedia:track/List_of_UK_Singles_Chart_number_ones_of_the_2000s",
        source: "tavily",
        sourceTier: "editorial",
        url: "https://en.wikipedia.org/wiki/File:Daft_Punk_logo.svg",
        title: "List of UK Singles Chart number ones of the 2000s — Wikipedia",
        retrievedAt: "2026-10-24T16:23:30.000Z",
        excerpt:
          "See https://en.wikipedia.org/wiki/List_of_UK_Singles_Chart_number_ones_of_the_2000s.",
        recordRef: null,
      },
    ];
    const withEvidence = (extra: string) => {
      const analysis = structuredClone(fixture.analysis);
      analysis.evidence = TrackAnalysis.parse({ ...analysis, evidence }).evidence;
      expect(analysis.evidence).toHaveLength(3);
      analysis.claims![0].evidenceIds = [evidence[0].id];
      analysis.factoids[0].content = `${analysis.factoids[0].content}${extra}`;
      return { ...fixture, analysis };
    };

    const sourced = withEvidence("");
    const { run, events } = fixtureAsLiveRun(sourced, "One More Time Daft Punk");
    const { record: built } = buildRecord(run, events, {
      slug: fixture.slug,
      commit: fixture.commit,
      secrets: [],
      otherRunIds: [foreignRun],
    });
    expect(built.analysis.evidence).toEqual(sourced.analysis.evidence);
    expect(content(built.analysis)).toEqual(content(sourced.analysis));

    // Another run's id in the content is refused.
    const leaked = withEvidence(` (see run ${foreignRun})`);
    const other = fixtureAsLiveRun(leaked, "One More Time Daft Punk");
    expect(
      refusal(() =>
        buildRecord(other.run, other.events, {
          slug: fixture.slug,
          commit: fixture.commit,
          secrets: [],
          otherRunIds: [foreignRun],
        }),
      ),
    ).toEqual(expect.arrayContaining(["analysis.factoids[0].content: another run's id"]));
  });

  it("joins a paused and resumed run into one stream numbered from 0, without the pause", async () => {
    const events = await sse(streamPath("ambiguous pick"));
    const threadId = events[0].runId as string;
    expect(types(events)).toContain("interrupt");
    const resumed = await sse(
      `/api/analyze/stream/resume?threadId=${threadId}&selectedTrackId=${CHOICE_A}`,
    );
    expect(resumed.some((e) => /^Selected: /.test(String(e.message)))).toBe(true);
    expect(new Set(stored(threadId).events.map((e) => e.stream))).toEqual(new Set([0, 1]));

    const { record: built } = record(threadId);
    const recorded = built.events.map((e) => e.event as Event);
    expect(types(recorded)).not.toContain("interrupt");
    expect(types(recorded)).not.toContain("resuming");
    expect(types(recorded)[0]).toBe("connected");
    expect(types(recorded).slice(-2)).toEqual(["complete", "done"]);
    expect(recorded.map((e) => e.seq)).toEqual(recorded.map((_, i) => i));
    // The user's own choice in that run is not part of the recording.
    expect(recorded.some((e) => /^Selected: /.test(String(e.message)))).toBe(false);
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

  it("reports what a record must not hold, by path, without echoing it", () => {
    const otherRun = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
    const found = leaks(
      {
        a: `token ${SECRET}`,
        b: "Authorization: Bearer abcdefghijklmnop1234",
        c: "listen at https://cdnt-preview.dzcdn.net/x.mp3",
        d: ["https://i.scdn.co/image/abc"],
        e: "they typed my private’s words",
        f: "Recorded Song by The Recorders",
        g: `see https://example.org/q?k=${encodeURIComponent(SECRET)}`,
        h: "write to someone@example.com",
        i: "https://lh3.googleusercontent.com/abc=w544",
        j: `from run ${otherRun}`,
        k: "query=my%20private%27s%20words",
        l: "https://open.spotify.com/track/0ReplayTestTrack000001",
        claimId: "2b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d",
        m: "backs claim 2b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d",
      },
      {
        secrets: [SECRET],
        typedQuery: "my  private's words",
        publicTexts: ["Recorded Song", "The Recorders"],
        otherRunIds: [otherRun],
      },
    );
    expect(found).toEqual(
      expect.arrayContaining([
        "a: a configured credential",
        "b: a bearer or basic credential",
        "c: a preview URL",
        "d[0]: an image or media URL",
        "e: the query the user typed",
        "g: a configured credential",
        "h: an e-mail address",
        "i: a URL outside the allow-listed sites",
        "j: another run's id",
        "k: the query the user typed",
      ]),
    );
    expect(found.join(" ")).not.toContain(SECRET);
    for (const fine of ["f:", "l:", "m:", "claimId:"]) {
      expect(found.some((line) => line.startsWith(fine))).toBe(false);
    }
  });

  it("keeps the pages of web-tier evidence, and refuses preview and secret-bearing links", () => {
    const webItem = (url: string) => ({
      id: `tavily:${url}`,
      source: "tavily",
      sourceTier: "web",
      url,
      title: "A page",
      retrievedAt: "2026-10-20T12:00:00.000Z",
      excerpt: "The bass line comes from Under Pressure.",
      recordRef: null,
    });
    const check = { secrets: [SECRET], typedQuery: "", publicTexts: [] };
    const page = "https://www.rollingstone.com/music/news/ice-ice-baby-under-pressure-1234/";
    const wiki = "https://example.org/wiki/Ice_Ice_Baby_(song)";
    const cited = { evidenceIds: [`tavily:${page}`, `tavily:${wiki}`] };
    expect(
      leaks(
        {
          analysis: { evidence: [webItem(page), webItem(wiki)], claims: [cited] },
          events: [{ type: "evidence", evidence: webItem(page) }],
        },
        check,
      ),
    ).toEqual([]);

    const preview = "https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/x.mp3";
    const keyed = `https://example.org/article?api_key=${"k".repeat(12)}`;
    const found = leaks(
      {
        preview: { evidence: [webItem(preview)] },
        keyed: { evidence: [webItem(keyed)] },
        // Not web-tier evidence: a URL outside the allow-listed sites, as before.
        other: { url: page },
      },
      check,
    );
    expect(found).toEqual(
      expect.arrayContaining([
        "preview.evidence[0].url: a preview URL",
        "keyed.evidence[0].url: a key or token parameter",
        "keyed.evidence[0].url: a URL outside the allow-listed sites",
        "other.url: a URL outside the allow-listed sites",
      ]),
    );
  });

  it("refuses a web evidence page whose path carries a token or an address", () => {
    const webItem = (url: string) => ({
      id: `tavily:${url}`,
      source: "tavily",
      sourceTier: "web",
      url,
      title: "A page",
      retrievedAt: "2026-10-20T12:00:00.000Z",
      excerpt: "A page about the track.",
      recordRef: null,
    });
    const check = { secrets: [SECRET], typedQuery: "", publicTexts: [] };
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJl";
    const refused = [
      `https://example.org/magic-login/${jwt}/`,
      "https://example.org/share/sk-AbCdEfGhIjKlMnOpQr12/press",
      "https://example.org/dl/token=abc123def456/file",
      "https://example.org/people/jane.doe@example.com",
      "https://example.org/s/Ab3dEf6hIj9kLm2nOp5qRs8tUv1wXy4zAb7d/view",
      "https://example.org/f/0123456789abcdef0123456789abcdef/report",
    ];
    for (const url of refused) {
      expect(leaks({ evidence: [webItem(url)] }, check), url).not.toEqual([]);
    }
    // Slugs of words and short ids are pages, not tokens, Title-Case and dated ones too.
    for (const url of [
      "https://www.example.com/music/news/ice-ice-baby-under-pressure-lawsuit-1234/",
      "https://example.org/wiki/List_of_songs_recorded_by_Vanilla_Ice_and_others",
      "https://example.org/articles/2024/10/a1b2c3",
      "https://www.songfacts.com/Why-was-Ice-Ice-Baby-so-popular-in-1990",
      "https://music.fandom.com/wiki/Billboard_Hot_100_Number_Ones_of_1990",
      "https://www.wikiwand.com/en/articles/List_of_Billboard_Hot_100_number_ones_of_1990",
      "https://www.scribd.com/document/123456789/Ice-Ice-Baby-Copyright-Case-1990-Settlement",
      "https://archive.org/details/IceIceBabyVanillaIce1990SingleRelease",
      "https://pitchfork.com/thepitch/Ice-Ice-Baby-at-30-An-Oral-History/",
      "https://www.nme.com/news/music/Vanilla-Ice-Ice-Ice-Baby-Sample-Lawsuit-2024",
    ]) {
      expect(leaks({ evidence: [webItem(url)] }, check), url).toEqual([]);
    }
  });

  it("refuses markup in a source error's message, in the result and in its events", () => {
    const check = { secrets: [SECRET], typedQuery: "", publicTexts: [] };
    const page = {
      source: "secondhandsongs",
      code: "unavailable",
      message: 'secondhandsongs: HTTP 403 — <!DOCTYPE html><html lang="en-US"><head>',
    };
    const plain = {
      source: "secondhandsongs",
      code: "unavailable",
      message: "secondhandsongs: HTTP 403 (the source refused the request)",
    };
    expect(
      leaks(
        {
          analysis: { run: { sourceErrors: [plain, page] } },
          events: [{ event: { type: "complete", data: { run: { sourceErrors: [page] } } } }],
        },
        check,
      ),
    ).toEqual([
      "analysis.run.sourceErrors[1].message: markup in a source error",
      "events[0].event.data.run.sourceErrors[0].message: markup in a source error",
    ]);
    expect(leaks({ analysis: { run: { sourceErrors: [plain] } } }, check)).toEqual([]);
  });

  it("refuses a social platform page and profile boilerplate, which carry people's handles", () => {
    const webItem = (url: string, excerpt = "A caption about the song.") => ({
      id: `tavily:${url}`,
      source: "tavily",
      sourceTier: "web",
      url,
      title: "A page",
      retrievedAt: "2026-10-20T12:00:00.000Z",
      excerpt,
      recordRef: null,
    });
    const check = { secrets: [SECRET], typedQuery: "", publicTexts: [] };
    expect(
      leaks(
        {
          analysis: {
            evidence: [
              webItem("https://www.instagram.com/p/abc123/"),
              webItem("https://example.org/post", "some_one's profile picture some_one 2w Love it"),
            ],
          },
        },
        check,
      ),
    ).toEqual(
      expect.arrayContaining([
        "analysis.evidence[0].url: a social platform page",
        "analysis.evidence[1].excerpt: profile or handle boilerplate",
      ]),
    );
    expect(
      leaks({ analysis: { evidence: [webItem("https://www.youtube.com/watch?v=abc")] } }, check),
    ).toEqual([]);
  });

  it("checks only web evidence for handles: model prose and primary records may name them", () => {
    const check = { secrets: [SECRET], typedQuery: "", publicTexts: [] };
    const primary = {
      id: "musicbrainz:track/recording/x",
      source: "musicbrainz",
      sourceTier: "primary-record",
      url: "https://musicbrainz.org/recording/x",
      title: "A record",
      retrievedAt: "2026-10-20T12:00:00.000Z",
      excerpt: "MusicBrainz credits @daftpunk @thomasbangalter @guymanuel.",
      recordRef: "track/recording/x",
    };
    expect(
      leaks(
        {
          analysis: {
            claims: [
              { text: "In 2021 the band changed Daft Punk's profile picture to an hourglass." },
            ],
            evidence: [primary],
          },
          events: [{ event: { type: "status", message: "@a @b @c wrote about it" } }],
        },
        check,
      ),
    ).toEqual([]);
  });

  it("refuses escaped markup in a source error's message", () => {
    const check = { secrets: [SECRET], typedQuery: "", publicTexts: [] };
    const escaped = {
      source: "secondhandsongs",
      code: "unavailable",
      message: "secondhandsongs: HTTP 403 — &lt;!DOCTYPE html&gt;",
    };
    expect(leaks({ analysis: { run: { sourceErrors: [escaped] } } }, check)).toEqual([
      "analysis.run.sourceErrors[0].message: markup in a source error",
    ]);
  });

  it("refuses a stored run whose source error holds a stack trace, a traceback or a link, as /api/runs does", async () => {
    const runId = await liveRun("plain words");
    const plain = "musicbrainz: HTTP 503 (the source could not answer)";
    const refusedMessages: Array<[string, string]> = [
      ["a stack trace", "musicbrainz: fetch failed at fetchJson (/app/src/sources/http.ts:120:11)"],
      [
        "a stack trace",
        'secondhandsongs: Traceback (most recent call last): File "/srv/app.py", line 42, in get',
      ],
      // On an allow-listed site, so only the source-error rule refuses it.
      ["a link", "musicbrainz: HTTP 503 from https://musicbrainz.org/ws/2/recording"],
    ];
    const withError = (message: string) => {
      const { run, events } = stored(runId);
      const analysis = run.analysis as TrackAnalysis;
      const sourceErrors = [
        { source: "musicbrainz" as const, code: "unavailable" as const, message },
      ];
      return {
        run: { ...run, analysis: { ...analysis, run: { ...analysis.run!, sourceErrors } } },
        events,
      };
    };
    const build = ({ run, events }: ReturnType<typeof withError>) =>
      buildRecord(run, events, { slug: "recorded-song", commit: "abc1234", secrets: [SECRET] });
    for (const [what, message] of refusedMessages) {
      const reasons = refusal(() => build(withError(message)));
      expect(reasons, message).toContain(
        `analysis.run.sourceErrors[0].message: ${what} in a source error`,
      );
      expect(reasons.join(" ")).not.toContain(message);
    }
    expect(build(withError(plain)).record.analysis.run?.sourceErrors).toEqual([
      { source: "musicbrainz", code: "unavailable", message: plain },
    ]);
  });

  it("refuses a status line with a stack trace or a token parameter, as a source error's message", async () => {
    const check = { secrets: [SECRET], typedQuery: "", publicTexts: [] };
    const trace = "MusicBrainz failed at fetchJson (/app/src/sources/http.ts:120:11)";
    const tokenLink = "MusicBrainz failed: https://musicbrainz.org/ws/2/recording?token=abc";
    expect(
      leaks(
        {
          events: [
            { event: { type: "status", message: trace } },
            { event: { type: "status", message: tokenLink } },
            { event: { type: "status", message: "Research finished" } },
          ],
        },
        check,
      ),
    ).toEqual(
      expect.arrayContaining([
        "events[0].event.message: a stack trace in a status line",
        "events[1].event.message: a signature or token parameter in a status line",
      ]),
    );
    // A stored run's status line, recorded: refused, never echoed.
    const runId = await liveRun("plain words");
    const { run, events } = stored(runId);
    const first = events.findIndex((item) => (item.event as Event).type === "status");
    const edited = events.map((item, i) =>
      i === first ? { ...item, event: { ...(item.event as Event), message: trace } } : item,
    );
    const reasons = refusal(() =>
      buildRecord(run, edited, { slug: "recorded-song", commit: "abc1234", secrets: [SECRET] }),
    );
    expect(reasons.join("\n")).toMatch(/\.event\.message: a stack trace in a status line/);
    expect(reasons.join(" ")).not.toContain("fetchJson");
  });

  it("passes every kind of status line today's code writes, with the track's own text", async () => {
    const codes = SourceError.shape.code.options;
    // The scout's and the clarification's lines carry the track's title and artist as Spotify
    // gives them; the engineer's, the analyzer's version and a date.
    const track = { title: "One More Time <3 -> Edit", artist: "Daft Punk", album: "Discovery" };
    const ownLines = [foundLine(track), selectedLine(track)];
    const measurements = [
      measurementOf(audioV2()),
      measurementOf(signalOnlyV2()),
      measurementOf(gatedV2("noise")),
      measurementOf(keyWithheldV2()),
      { audio: null, unavailableReason: "no_preview" as const },
    ];
    const engineerLines = [
      MEASURING_LINE,
      ...measurements.flatMap((measurement) => {
        const summary = measuredSummary(measurement);
        return [summary.text, measuredLine(summary)];
      }),
      ...measurements.slice(0, 4).flatMap((m) => {
        const measurement = { ...m, audio: m.audio!, previewMatch: ISRC_MATCH };
        return [
          cachedLine({ measurement }),
          ...Object.values(UNVERSIONED_REASON).map((reason) =>
            cachedLine({ measurement, unversioned: { reason, measuredAt: new Date(1e12) } }),
          ),
        ];
      }),
    ];
    const lines = [
      ...ownLines,
      ...engineerLines,
      ...SourceId.options.flatMap((source) => [
        ...codes.flatMap((code) => [
          sourceErrorLine({ source, code }),
          sourceErrorLine({ source, code, message: "musicbrainz: HTTP 503 (from [link])" }),
          sourceErrorLine({ source, code, message: `${INTERNAL_ERROR_PREFIX}x is undefined` }),
          lostRecordsLine({ source, code }),
        ]),
        sourceErrorLine({ source, code: "unavailable" }, true),
      ]),
      ...Object.values(MODEL_FAILURE_TEXT),
      ...Object.values(MODEL_FAILURE_TEXT).map((reason) =>
        plannerLine(PLANNER_LINES.ended, { reason }),
      ),
      PLANNER_LINES.starting,
      PLANNER_LINES.finished,
      plannerLine(PLANNER_LINES.planning, { step: 2, steps: 4 }),
      STORED_LINE,
      STORED_UNCHECKED_LINE,
      ...storedErrorStatus(codes.map((code) => ({ source: "lastfm" as const, code }))),
    ];
    // And the status lines of real runs: the committed recordings' and a run made here.
    const committed = loadReplays(DEFAULT_REPLAY_DIR).records.flatMap((r) => r.events);
    const made = record(await liveRun("plain words")).record.events;
    const sent = [...committed, ...made].flatMap(({ event }) =>
      event.type === "status" ? [event.message] : [],
    );
    expect(sent.length).toBeGreaterThan(10);
    const all = [...lines, ...sent];
    const check = { secrets: [], typedQuery: "", publicTexts: publicTextsOf(track), track };
    const statusEvents = all.map((message) => ({ event: { type: "status", message } }));
    expect(leaks({ events: statusEvents }, check)).toEqual([]);
    // Every line but the track's own two passes, whole, what an error message is held to.
    for (const message of all.filter((line) => !ownLines.includes(line))) {
      expect(reasonIssue(message), message).toBeNull();
    }
  });

  it("lets no text of the track's own hide a stack trace or markup in another status line", () => {
    const stack = "Error: boom at fetchJson (/srv/app/dist/sources/http.js:120:15)";
    const entity = "upstream said &lt;html&gt;&lt;body&gt;Bad gateway&lt;/body&gt;&lt;/html&gt;";
    const page = "<html><body>Bad gateway</body></html>";
    const cases: Array<[string, string, string, string, string]> = [
      // title, artist, album, a status line, why it is refused
      [".", "Daft Punk", "Discovery", stack, "a stack trace"],
      [":", "Daft Punk", "Discovery", stack, "a stack trace"],
      ["/", "Daft Punk", "Discovery", stack, "a stack trace"],
      ["a", "Daft Punk", "Discovery", stack, "a stack trace"],
      ["at", "Daft Punk", "Discovery", stack, "a stack trace"],
      ["One More Time", "Daft Punk", "", stack, "a stack trace"],
      ["&", "Daft Punk", "Discovery", entity, "markup"],
      ["<", ">", "Discovery", page, "markup"],
      ["One More Time", "Daft Punk", page, page, "markup"],
    ];
    const fixture = loadReplays(DEFAULT_REPLAY_DIR).records[0];
    const at = (prefix: string) =>
      fixture.events.findIndex(
        ({ event }) => event.type === "status" && event.message.startsWith(prefix),
      );
    const found = at("Found the track");
    const other = at("Measuring tempo");
    expect(found).toBeGreaterThan(0);
    expect(other).toBeGreaterThan(0);
    for (const [title, artist, album, line, why] of cases) {
      const own = { title, artist, album };
      const label = JSON.stringify(own);
      const check = { secrets: [], typedQuery: "", publicTexts: publicTextsOf(own), track: own };
      const status = (message: string) => ({ event: { type: "status", message } });
      // The track's own line passes; the other line, and the own line with more after it, do not.
      expect(
        leaks(
          { events: [status(foundLine(own)), status(line), status(`${foundLine(own)} ${line}`)] },
          check,
        ),
        label,
      ).toEqual([
        `events[1].event.message: ${why} in a status line`,
        `events[2].event.message: ${why} in a status line`,
      ]);
      // And a file of that track holding the line is left out when loaded.
      const out = join(dir, "own-texts");
      rmSync(out, { recursive: true, force: true });
      mkdirSync(out);
      const file: ReplayRecord = {
        ...fixture,
        analysis: { ...fixture.analysis, ...own },
        events: fixture.events.map((item, i) =>
          item.event.type === "status" && (i === found || i === other)
            ? {
                ...item,
                event: { ...item.event, message: i === found ? foundLine(own) : line },
              }
            : item,
        ),
      };
      writeFileSync(join(out, `${fixture.slug}.json`), JSON.stringify(file));
      const set = loadReplays(out);
      expect(set.records, label).toEqual([]);
      expect(set.problems, label).toEqual([
        `${fixture.slug}.json: holds text a recording must not (events[${other}].event.message: ${why} in a status line)`,
      ]);
    }
    // The track's own line is spared the markup rule only: a stack trace in it is refused.
    const traced = { title: "Boom at fetchJson (/srv/app/http.js:120:15)", artist: "Daft Punk" };
    expect(
      leaks(
        { events: [{ event: { type: "status", message: foundLine(traced) } }] },
        { secrets: [], typedQuery: "", publicTexts: [], track: traced },
      ),
    ).toEqual(["events[0].event.message: a stack trace in a status line"]);
    // A title that holds the artist's text, or the other way round, is still the track's own.
    const overlap = { title: "A", artist: "A <3 B" };
    expect(
      leaks(
        { events: [{ event: { type: "status", message: foundLine(overlap) } }] },
        { secrets: [], typedQuery: "", publicTexts: [], track: overlap },
      ),
    ).toEqual([]);
  });

  it("records and loads a track whose title or artist holds < or >, and still refuses markup in a status line", () => {
    const fixture = loadReplays(DEFAULT_REPLAY_DIR).records[0];
    const found = fixture.events.findIndex(
      ({ event }) => event.type === "status" && event.message.startsWith("Found the track"),
    );
    expect(found).toBeGreaterThan(0);
    const retitled = (id: string, title: string, artist: string): ReplayRecord => ({
      ...fixture,
      analysis: { ...fixture.analysis, id, title, artist },
      events: fixture.events.map((item, i) =>
        i === found
          ? { ...item, event: { ...item.event, message: foundLine({ title, artist }) } }
          : item,
      ),
    });
    const build = (fixtureRecord: ReplayRecord, slug: string) => {
      const { run, events } = fixtureAsLiveRun(fixtureRecord, fixtureRecord.analysis.title);
      return buildRecord(run, events, { slug, commit: "abc1234", secrets: [SECRET] }).record;
    };
    const out = join(dir, "titles");
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out);
    for (const [slug, id, title, artist] of [
      ["heart", "0ReplayTitleTrack00001", "One More Time <3", "Daft Punk"],
      ["arrow", "0ReplayTitleTrack00002", "One More Time -> Edit", "Daft Punk"],
      ["artist", "0ReplayTitleTrack00003", "One More Time", "<Daft> Punk"],
    ]) {
      writeFileSync(
        join(out, `${slug}.json`),
        JSON.stringify(build(retitled(id, title, artist), slug)),
      );
    }
    const set = loadReplays(out);
    expect(set.problems).toEqual([]);
    expect(set.records.map((r) => r.slug).sort()).toEqual(["arrow", "artist", "heart"]);

    // A line that holds markup besides the track's own text is still refused when recorded,
    // and left out when loaded.
    const markup = " <html><body>Bad gateway</body></html>";
    const withPage = (r: ReplayRecord): ReplayRecord => ({
      ...r,
      events: r.events.map((item, i) =>
        i === found && item.event.type === "status"
          ? { ...item, event: { ...item.event, message: item.event.message + markup } }
          : item,
      ),
    });
    const pageTrack = retitled("0ReplayTitleTrack00004", "One More Time <3 (Live)", "Daft Punk");
    expect(refusal(() => build(withPage(pageTrack), "page"))).toContain(
      `events[${found}].event.message: markup in a status line`,
    );
    writeFileSync(join(out, "page.json"), JSON.stringify(withPage(build(pageTrack, "page"))));
    const again = loadReplays(out);
    expect(again.records.map((r) => r.slug).sort()).toEqual(["arrow", "artist", "heart"]);
    expect(again.problems).toEqual([
      `page.json: holds text a recording must not (events[${found}].event.message: markup in a status line)`,
    ]);
  });

  it("refuses a token or signature parameter in any link, also on an allow-listed site", () => {
    const check = { secrets: [SECRET], typedQuery: "", publicTexts: [] };
    const page = "https://www.discogs.com/release/123-One-More-Time?token=abc";
    expect(
      leaks(
        {
          analysis: {
            claims: [
              { text: "See https://musicbrainz.org/recording/x?token=abc for the credits." },
            ],
            evidence: [
              {
                id: "discogs:release/123",
                source: "discogs",
                sourceTier: "primary-record",
                url: page,
                title: "A release",
                retrievedAt: "2026-10-20T12:00:00.000Z",
                excerpt: "Released 2000.",
                recordRef: "release/123",
              },
            ],
          },
        },
        check,
      ),
    ).toEqual(
      expect.arrayContaining([
        "analysis.claims[0].text: a signed URL",
        "analysis.evidence[0].url: a signed URL",
      ]),
    );
  });

  it("refuses a stored run whose web evidence the run routes refuse, so the loader never drops what it writes", async () => {
    const runId = await liveRun("plain words");
    const { run, events } = stored(runId);
    const analysis = run.analysis as TrackAnalysis;
    const page = {
      id: "tavily:www.instagram.com/p/abc123/",
      source: "tavily" as const,
      sourceTier: "web" as const,
      // Without its scheme: the URL scan of `leaks` does not see it, the run routes' check does.
      url: "www.instagram.com/p/abc123/",
      title: "A page about the song",
      retrievedAt: "2026-10-20T12:00:00.000Z",
      excerpt: "A caption about the song.",
      recordRef: null,
    };
    const evidence = [...(analysis.evidence ?? []), page];
    const reasons = refusal(() =>
      buildRecord({ ...run, analysis: { ...analysis, evidence } }, events, {
        slug: "recorded-song",
        commit: "abc1234",
        secrets: [SECRET],
      }),
    );
    expect(reasons).toContain(`analysis.evidence[${evidence.length - 1}]: a social platform page`);
  });

  it("refuses a configured credential the stored result holds, rather than editing it", async () => {
    const runId = await liveRun("plain words");
    const { run, events } = stored(runId);
    const reasons = refusal(() =>
      buildRecord(run, events, { slug: "recorded-song", commit: "abc1234", secrets: ["Tapes"] }),
    );
    expect(reasons).toEqual(
      expect.arrayContaining([expect.stringMatching(/album: a configured credential/)]),
    );
  });
});

describe("the recorded cover from the Cover Art Archive", () => {
  const RELEASE = "ae103b0a-b932-4009-acb6-388db1cf890b";
  const ARCHIVE = `https://coverartarchive.org/release/${RELEASE}/front-500`;
  const OTHER = "5a260489-c99d-485b-902e-24751e5b1c69";
  const SPOTIFY_COVER = "https://i.scdn.co/image/ab67616d0000b273spotifycover";
  /** A MusicBrainz release item as sources/identity.ts builds it. */
  const releaseItem = (mbid = RELEASE) => ({
    id: `musicbrainz:release/${mbid}`,
    source: "musicbrainz" as const,
    sourceTier: "primary-record" as const,
    url: `https://musicbrainz.org/release/${mbid}`,
    title: "Discovery — MusicBrainz release",
    retrievedAt: "2026-10-24T16:23:30.000Z",
    excerpt:
      'MusicBrainz: "One More Time" by Daft Punk appears on the official album "Discovery" (2001-03-07).',
    recordRef: `release/${mbid}`,
  });

  /** The dev fixture as a live run that showed Spotify's cover and cited `evidence`. */
  function liveRunWith(evidence: unknown[], extraText = "") {
    const fixture = structuredClone(loadReplays(DEFAULT_REPLAY_DIR).records[0]);
    const analysis = TrackAnalysis.parse({ ...fixture.analysis, evidence });
    analysis.coverUrl = SPOTIFY_COVER;
    analysis.genealogy.nodes[0].img = SPOTIFY_COVER;
    analysis.factoids[0].content = `${analysis.factoids[0].content}${extraText}`;
    return fixtureAsLiveRun({ ...fixture, analysis }, "One More Time Daft Punk");
  }
  const build = ({ run, events }: ReturnType<typeof liveRunWith>) =>
    buildRecord(run, events, { slug: "one-more-time-daft-punk", commit: "abc1234", secrets: [] });

  it("keeps the Cover Art Archive cover of the run's MusicBrainz release, and no other image", () => {
    const { record: built } = build(liveRunWith([releaseItem()]));
    expect(built.analysis.coverUrl).toBe(ARCHIVE);
    const complete = built.events.find((e) => e.event.type === "complete")?.event as
      | { data: TrackAnalysis }
      | undefined;
    expect(complete?.data.coverUrl).toBe(ARCHIVE);
    // Spotify's cover of the same run is gone, as the cover and as a genealogy image.
    expect(built.analysis.genealogy.nodes[0].img).toBe("");
    const text = JSON.stringify(built);
    expect(text).not.toMatch(/i\.scdn|spotifycover/);
    // The link appears as the two covers only.
    expect(text.split("coverartarchive.org").length - 1).toBe(2);
    // The evidence it comes from is kept as it was.
    expect(built.analysis.evidence).toEqual([releaseItem()]);
  });

  it("keeps no Cover Art Archive cover without exactly one MusicBrainz release item", () => {
    const discogs = {
      ...releaseItem(),
      id: "discogs:release/599648/credit/0",
      source: "discogs" as const,
      url: "https://www.discogs.com/release/599648",
      recordRef: "release/599648/credit/0",
    };
    const other = "5a260489-c99d-485b-902e-24751e5b1c69";
    for (const [what, evidence] of [
      ["no evidence", []],
      ["a Discogs release only", [discogs]],
      ["two MusicBrainz releases", [releaseItem(), releaseItem(other)]],
      [
        "a release item on another release's page",
        [{ ...releaseItem(), url: releaseItem(other).url }],
      ],
    ] as const) {
      const { record: built } = build(liveRunWith([...evidence]));
      expect(built.analysis.coverUrl, what).toBe("");
      expect(JSON.stringify(built), what).not.toMatch(/coverartarchive|i\.scdn/);
    }
    expect(archiveCoverOf({})).toBe("");
    expect(archiveCoverOf({ evidence: [releaseItem()] })).toBe(ARCHIVE);
    // Upper case is not how the sources name a release.
    expect(archiveCoverOf({ evidence: [releaseItem(RELEASE.toUpperCase())] })).toBe("");
  });

  it("refuses a Cover Art Archive link anywhere but the kept cover", () => {
    // In the text of a fact, the recorder refuses the run rather than editing it.
    expect(refusal(() => build(liveRunWith([releaseItem()], ` See ${ARCHIVE}.`)))).toEqual(
      expect.arrayContaining(["analysis.factoids[0].content: an image or media URL"]),
    );
    const check = { secrets: [], typedQuery: "", publicTexts: [], allowedCover: ARCHIVE };
    const otherCover = ARCHIVE.replace(RELEASE, "5a260489-c99d-485b-902e-24751e5b1c69");
    const found = leaks(
      {
        analysis: {
          coverUrl: ARCHIVE,
          genealogy: { nodes: [{ img: ARCHIVE, coverUrl: ARCHIVE }, { coverUrl: otherCover }] },
          factoids: [{ content: ARCHIVE }],
          foo: { bar: { coverUrl: ARCHIVE } },
        },
        events: [
          { event: { type: "status", coverUrl: ARCHIVE, data: { coverUrl: ARCHIVE } } },
          { event: { type: "complete", data: { coverUrl: ARCHIVE } } },
          { event: { type: "interrupt", candidates: [{ coverUrl: ARCHIVE }] } },
        ],
        coverUrl: ARCHIVE,
        coverUrlNote: ARCHIVE,
        suggestion: { coverUrl: `${ARCHIVE}?size=big` },
      },
      check,
    );
    // Allowed only as the result's cover and the complete event's: any other cover field,
    // at any depth, is refused.
    expect(found.sort()).toEqual([
      "analysis.factoids[0].content: an image or media URL",
      "analysis.foo.bar.coverUrl: an image or media URL",
      "analysis.genealogy.nodes[0].coverUrl: an image or media URL",
      "analysis.genealogy.nodes[0].img: an image or media URL",
      "analysis.genealogy.nodes[1].coverUrl: an image or media URL",
      "coverUrl: an image or media URL",
      "coverUrlNote: an image or media URL",
      "events[0].event.coverUrl: an image or media URL",
      "events[0].event.data.coverUrl: an image or media URL",
      "events[2].event.candidates[0].coverUrl: an image or media URL",
      "suggestion.coverUrl: an image or media URL",
    ]);
    // Only the 500 px front image is the kept cover: no other size, nor the plain front.
    for (const size of ["front-250", "front-1200", "front"]) {
      const other = ARCHIVE.replace("front-500", size);
      expect(leaks({ analysis: { coverUrl: other } }, { ...check, allowedCover: other })).toEqual([
        "analysis.coverUrl: an image or media URL",
      ]);
    }
    // Without a kept cover, the cover field is refused too.
    expect(leaks({ analysis: { coverUrl: ARCHIVE } }, { ...check, allowedCover: "" })).toEqual([
      "analysis.coverUrl: an image or media URL",
    ]);
    // Only an archive link can be the allowed cover.
    expect(
      leaks({ analysis: { coverUrl: SPOTIFY_COVER } }, { ...check, allowedCover: SPOTIFY_COVER }),
    ).toEqual(["analysis.coverUrl: an image or media URL"]);
  });

  it("says why a record keeps no Cover Art Archive cover, and replay:record prints it", async () => {
    expect(build(liveRunWith([releaseItem()]))).not.toHaveProperty("noCover");
    expect(build(liveRunWith([])).noCover).toBe(
      "the evidence names no MusicBrainz recording, so no release was read: the track has no ISRC, MusicBrainz matched no recording to it, or MusicBrainz could not be read",
    );
    const recordingItem = {
      ...releaseItem(),
      id: `musicbrainz:track/recording/${OTHER}`,
      url: `https://musicbrainz.org/recording/${OTHER}`,
      title: "One More Time — MusicBrainz recording",
      excerpt: 'MusicBrainz recording "One More Time" by Daft Punk (5:20), ISRC GBDUW0000059.',
      recordRef: `track/recording/${OTHER}`,
    };
    expect(build(liveRunWith([recordingItem])).noCover).toBe(
      "the evidence names the MusicBrainz recording but no release: its releases could not be read in time, none is an official album, EP or single the Cover Art Archive holds a front image of, or the run was made by earlier code (before releases were read, or before the evidence pack's size cap always kept the release)",
    );
    expect(build(liveRunWith([releaseItem(), releaseItem(OTHER)])).noCover).toBe(
      "the evidence names 2 MusicBrainz releases, not one",
    );

    // The stub run cites no release: the recording command says the record keeps no cover.
    const runId = await liveRun("source run");
    vi.stubEnv("SQLITE_DB_PATH", join(dir, "test.db"));
    const out = join(dir, "no-cover");
    const deps = { settingsFileValues: () => ({}), checkout: () => runningCommit() ?? "abc1234" };
    expect(recordMain(["--run", runId, "--slug", "no-cover", "--out", out], deps)).toBe(0);
    expect(vi.mocked(console.warn).mock.calls.map(([m]) => String(m))).toContain(
      "Warning: no cover kept: the evidence names no MusicBrainz recording, so no release was read: the track has no ISRC, MusicBrainz matched no recording to it, or MusicBrainz could not be read",
    );
  });

  it("serves no cover from a record but the Cover Art Archive link its evidence gives", () => {
    const scratch = mkdtempSync(join(tmpdir(), "replay-cover-"));
    try {
      const kept = build(liveRunWith([releaseItem()])).record;
      const edited = structuredClone(build(liveRunWith([])).record);
      // A record edited by hand to show Spotify's cover: never served.
      edited.slug = "edited";
      edited.analysis.id = "0EditedRecordTrack0001";
      edited.analysis.title = "Edited Song";
      edited.analysis.artist = "Edit Artist";
      edited.analysis.album = "Edit Album";
      edited.request.query = "Edited Song Edit Artist";
      edited.analysis.coverUrl = SPOTIFY_COVER;
      for (const { event } of edited.events) {
        if (event.type === "complete") event.data = { ...edited.analysis };
      }
      writeFileSync(join(scratch, `${kept.slug}.json`), JSON.stringify(kept));
      writeFileSync(join(scratch, "edited.json"), JSON.stringify(edited));
      const set = loadReplays(scratch);
      expect(set.problems, set.problems.join("\n")).toEqual([]);
      const served = (slug: string) => {
        const record = set.records.find((r) => r.slug === slug);
        const complete = record?.events.find((e) => e.event.type === "complete")?.event as
          | { data: TrackAnalysis }
          | undefined;
        return [record?.analysis.coverUrl, complete?.data.coverUrl];
      };
      expect(served(kept.slug)).toEqual([ARCHIVE, ARCHIVE]);
      expect(served("edited")).toEqual(["", ""]);
      expect(set.warnings).toContain(
        "edited.json: its cover is not the one its evidence gives; served without it",
      );
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("the player", () => {
  it("serves no search match from a record: it belonged to the recorded run", () => {
    const fixture = loadReplays(DEFAULT_REPLAY_DIR).records[0];
    // A record written before the recorder left the match out.
    const older = { ...fixture, analysis: { ...fixture.analysis, queryMatch: "none" as const } };
    const served = replayedAnalysis(older, "0f0e0d0c-aaaa-4bbb-8ccc-000000000002");
    expect(served).not.toHaveProperty("queryMatch");
    expect(served.run).toMatchObject({ mode: "replay" });
  });
});

describe("the committed records", () => {
  it("keep only the cover their evidence gives, and hold nothing a record must not", () => {
    const files = readdirSync(DEFAULT_REPLAY_DIR).filter((file) => file.endsWith(".json"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      // As committed, not as the loader serves it.
      const record = ReplayRecord.parse(
        JSON.parse(readFileSync(join(DEFAULT_REPLAY_DIR, file), "utf8")),
      );
      const cover = archiveCoverOf(record.analysis);
      expect(record.analysis.coverUrl, file).toBe(cover);
      for (const { event } of record.events) {
        if (event.type === "complete") expect(event.data.coverUrl, file).toBe(cover);
      }
      expect(
        leaks(record, {
          secrets: [],
          typedQuery: "",
          publicTexts: publicTextsOf(record.analysis),
          allowedCover: cover,
        }),
        file,
      ).toEqual([]);
    }
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

  it("reads the mode: off, fallback without keys, only; anything else as only", async () => {
    vi.stubEnv("REPLAY_MODE", "off");
    expect(await liveRefused()).toBeNull();
    vi.stubEnv("REPLAY_MODE", "fallback");
    expect(await liveRefused()).toBeNull();
    vi.stubEnv("SPOTIFY_CLIENT_SECRET", "");
    expect(await liveRefused()).toBe("live_disabled");
    vi.stubEnv("REPLAY_MODE", "only");
    expect(await liveRefused()).toBe("live_disabled");
    vi.stubEnv("REPLAY_MODE", "sometimes");
    expect(currentReplayMode()).toBe("only");
    expect(await chooseReplay((set) => set.forQuery("nothing recorded"))).toEqual({
      kind: "refused",
      code: "live_disabled",
    });
  });

  it("only: replays a recorded track as a new run, stored as a replay, with no live call", async () => {
    vi.stubEnv("REPLAY_MODE", "only");
    const events = await sse(streamPath("the RECORDERS — recorded song"));
    const runId = events[0].runId as string;

    // The recording's events, with a notice that it is a replay right after `connected`.
    const recorded = types(fixture.events.map((e) => e.event as Event));
    expect(types(events)).toEqual([recorded[0], "status", ...recorded.slice(1)]);
    expect(events[1]).toMatchObject({
      type: "status",
      node: "replay",
      message: `Replaying an analysis recorded on ${fixture.recordedAt} (commit abc1234); nothing below runs live.`,
    });
    expect(events.every((event) => AnalyzeStreamEvent.safeParse(event).success)).toBe(true);
    expect(events.every((event, i) => event.runId === runId && event.seq === i)).toBe(true);
    expect(events[0]).toMatchObject({ type: "connected", threadId: runId });
    const complete = events.find((event) => event.type === "complete") as Event;
    const result = TrackAnalysis.parse(complete.data);
    expect(result.run).toMatchObject({
      id: runId,
      mode: "replay",
      replayed: "run",
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

    // A replay is not a live run's spend: its usage is its own (none).
    expect(result.run?.usage).toEqual({
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      usd: 0,
    });

    // The run is bound to the content it was sent: a record edited in place (same slug and
    // recording time) serves nothing for it.
    const edited = structuredClone(fixture);
    edited.analysis.title = "Edited after the run";
    for (const event of edited.events) {
      if (event.event.type === "complete") event.event = { ...event.event, data: edited.analysis };
    }
    writeFileSync(join(replayDir, `${fixture.slug}.json`), JSON.stringify(edited));
    resetReplaysForTests();
    expect(loadReplays(replayDir).records).toHaveLength(1);
    expect((await request(app).get(`/api/runs/${runId}`)).body.analysis).toBeNull();
    expect((await request(app).get(`/api/runs/by-track/${TRACK_ID}`)).status).toBe(404);

    // Restored, it serves again; but not for a run whose track is not the record's.
    writeFileSync(join(replayDir, `${fixture.slug}.json`), JSON.stringify(fixture));
    resetReplaysForTests();
    expect((await request(app).get(`/api/runs/${runId}`)).body.analysis).not.toBeNull();
    getDb().prepare("UPDATE runs SET spotify_id = ? WHERE run_id = ?").run(CHOICE_B, runId);
    expect((await request(app).get(`/api/runs/${runId}`)).body.analysis).toBeNull();
    expect((await request(app).get(`/api/runs/by-track/${CHOICE_B}`)).status).toBe(404);
    getDb().prepare("UPDATE runs SET spotify_id = ? WHERE run_id = ?").run(TRACK_ID, runId);

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

  it("only: a request by track id replays that track's recording, never another track's", async () => {
    vi.stubEnv("REPLAY_MODE", "only");
    // The query need not name it: the id does.
    const byId = await sse(`${streamPath("anything at all")}&trackId=${TRACK_ID}`);
    expect(byId.find((e) => e.type === "complete")?.data).toMatchObject({ id: TRACK_ID });

    // The text names the recording, but the id asks for another track.
    const other = await request(app)
      .post("/api/analyze")
      .send({ query: "Recorded Song The Recorders", trackId: CHOICE_A });
    expect(other.status).toBe(503);
    expect(other.body.code).toBe("live_disabled");
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
      { id: "fb", title: "B fact", content: "Recorded fact two.", type: "trivia", entities: [] },
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

  it("only: a replay is recorded as a replay from its start, also when the client leaves", async () => {
    vi.stubEnv("REPLAY_MODE", "only");
    // One second between recorded events, sent at speed 1 with gaps capped at 150 ms.
    const spaced = {
      ...fixture,
      events: fixture.events.map((item, i) => ({ ...item, atMs: i * 1000 })),
    };
    writeFileSync(join(replayDir, `${fixture.slug}.json`), JSON.stringify(spaced));
    resetReplaysForTests();
    const restore = setReplayPacingForTests({ speed: 1, maxGapMs: 150 });
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise((resolve) => server.once("listening", resolve));
      const { port } = server.address() as AddressInfo;
      const runId = await new Promise<string>((resolve, reject) => {
        const req = http.get(
          `http://127.0.0.1:${port}${streamPath("Recorded Song The Recorders")}`,
          (res) => {
            res.setEncoding("utf8");
            res.once("data", (chunk: string) => {
              const first = JSON.parse(chunk.split("\n")[0].slice("data: ".length)) as Event;
              resolve(first.runId as string);
              req.destroy();
            });
          },
        );
        req.on("error", (err) => {
          if (!req.destroyed) reject(err);
        });
      });
      expect(getRun(getDb(), runId)).toMatchObject({ mode: "replay" });
      for (let i = 0; i < 150 && getRun(getDb(), runId)?.status === "running"; i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(getRun(getDb(), runId)).toMatchObject({
        status: "cancelled",
        mode: "replay",
        spotifyId: null,
        payload: { replayOf: { slug: fixture.slug } },
      });
      const res = await request(app).get(`/api/runs/${runId}`);
      expect(res.body.run).toMatchObject({ status: "cancelled", mode: "replay" });
      expect(res.body.analysis).toBeNull();
    } finally {
      restore();
      server.close();
    }
  });

  it("caps the wait between recorded events", async () => {
    const dev = loadReplays(DEFAULT_REPLAY_DIR).records[0];
    const recordedMs = dev.events.at(-1)?.atMs ?? 0;
    expect(recordedMs).toBeGreaterThan(5_000);
    const started = Date.now();
    const sent: string[] = [];
    const result = await playRecord(
      dev,
      "some-run",
      (body) => {
        sent.push(body.type);
        return true;
      },
      new AbortController().signal,
      { speed: 1, maxGapMs: 5 },
    );
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result?.run?.id).toBe("some-run");
    expect(sent.at(-1)).toBe("complete");
  });

  it("reports no result when the stream did not send the recorded one", async () => {
    const dev = loadReplays(DEFAULT_REPLAY_DIR).records[0];
    const result = await playRecord(
      dev,
      "some-run",
      (body) => body.type !== "complete",
      new AbortController().signal,
      { speed: 1, maxGapMs: 0 },
    );
    expect(result).toBeNull();
  });

  it("stamps every replayed event with the time it is sent, so times never go back", async () => {
    vi.stubEnv("REPLAY_MODE", "only");
    const before = new Date().toISOString();
    const events = await sse(streamPath("Recorded Song The Recorders"));
    const times = events.map((event) => event.timestamp).filter(Boolean) as string[];
    expect(times.length).toBeGreaterThan(2);
    expect(times.every((time) => time >= before)).toBe(true);
    expect([...times].sort()).toEqual(times);
  });

  it("by-track: replays of a recording since changed do not hide an older live run", async () => {
    vi.stubEnv("REPLAY_MODE", "");
    const liveId = await liveRun("an older live run");
    vi.stubEnv("REPLAY_MODE", "only");
    for (let i = 0; i < 6; i++) await sse(streamPath("Recorded Song The Recorders"));
    expect((await request(app).get(`/api/runs/by-track/${TRACK_ID}`)).body.run.mode).toBe("replay");
    // Recorded again: the earlier replays no longer have their recording.
    const again = structuredClone(fixture);
    again.commit = "def5678";
    again.analysis.run!.commit = "def5678";
    for (const item of again.events) {
      if (item.event.type === "complete") item.event = { ...item.event, data: again.analysis };
    }
    writeFileSync(join(replayDir, `${fixture.slug}.json`), JSON.stringify(again));
    resetReplaysForTests();
    const res = await request(app).get(`/api/runs/by-track/${TRACK_ID}`);
    expect(res.status).toBe(200);
    expect(res.body.run).toMatchObject({ id: liveId, mode: "live" });
  });

  it("only: factoids are looked up by the Spotify track id when there is one", async () => {
    vi.stubEnv("REPLAY_MODE", "only");
    const post = (body: Record<string, unknown>) =>
      request(app)
        .post("/api/factoids/decrypt")
        .send({ existingFactoidIds: [], ...body });
    // The id alone names the recording, whatever the title says.
    expect((await post({ trackId: TRACK_ID, trackTitle: "Something else" })).status).toBe(200);
    // Another track's id with the recording's title and artist: not that recording.
    const other = await post({
      trackId: CHOICE_B,
      trackTitle: "Recorded Song",
      trackArtist: "The Recorders",
    });
    expect(other.status).toBe(503);
    expect(other.body.code).toBe("live_disabled");
    // Without a Spotify id, the exact title and artist.
    const byName = await post({
      trackId: "local-1",
      trackTitle: "Recorded Song",
      trackArtist: "The Recorders",
    });
    expect(byName.status).toBe(200);
    expect(byName.body.factoids.map((f: { claimId?: string }) => f.claimId)).toEqual([
      "claim-a",
      undefined,
    ]);
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

describe("REPLAY_MODE=fallback once the model budget is spent", () => {
  let fixture: ReplayRecord;
  let spendLog: string;

  /** A spend log holding one settled call of `usd`, made at `ts`. */
  const spent = (usd: number, ts = new Date().toISOString()) =>
    writeFileSync(
      spendLog,
      `${JSON.stringify({ ts, deployment: "gpt", in: 0, out: 0, usd_est: usd, unit: "dev" })}\n`,
    );

  beforeEach(async () => {
    const runId = await liveRun("source run");
    fixture = record(runId).record;
    writeFileSync(join(replayDir, `${fixture.slug}.json`), JSON.stringify(fixture));
    resetReplaysForTests();
    getDb().exec("DELETE FROM runs; DELETE FROM run_events;");
    live.scout = 0;
    live.search = 0;
    live.model = 0;

    // A paid provider configured (dummy key, never called: the model layer is a stub here),
    // with its spend log in the scratch directory and the default caps (USD 25 in total).
    spendLog = join(dir, "spend.jsonl");
    spent(0);
    vi.stubEnv("REPLAY_MODE", "fallback");
    vi.stubEnv("LLM_CASSETTE", "off");
    vi.stubEnv("AZURE_OPENAI_API_KEY", "dummy-key");
    vi.stubEnv("AZURE_OPENAI_ENDPOINT", "https://example.openai.azure.com/");
    vi.stubEnv("LLM_SPEND_LOG", spendLog);
    vi.stubEnv("BUDGET_TOTAL_USD", "");
    vi.stubEnv("BUDGET_DAILY_USD", "");
    vi.stubEnv("BUDGET_EVAL_FLOOR_USD", "");
    resetBudgetStateForTests();
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => resetBudgetStateForTests());

  it("replays a recorded track and answers any other query budget_exhausted, never a result", async () => {
    spent(30);
    const replayed = await sse(streamPath("Recorded Song The Recorders"));
    const complete = replayed.find((event) => event.type === "complete") as Event;
    expect(TrackAnalysis.parse(complete.data).run).toMatchObject({
      mode: "replay",
      recordedAt: fixture.recordedAt,
      commit: "abc1234",
    });
    expect(replayed[1]).toMatchObject({ type: "status", node: "replay" });

    const refused = await sse(streamPath("Something else"));
    expect(refused.map((e) => [e.type, e.code])).toEqual([
      ["error", "budget_exhausted"],
      ["done", undefined],
    ]);
    expect(String(refused[0].error)).toMatch(/paused/i);
    expect(refused.some((e) => e.type === "complete")).toBe(false);

    const post = await request(app).post("/api/analyze").send({ query: "Something else" });
    expect(post.status).toBe(503);
    expect(post.body).toMatchObject({ success: false, code: "budget_exhausted" });
    const postReplay = await request(app)
      .post("/api/analyze")
      .send({ query: "Recorded Song The Recorders" });
    expect(postReplay.status).toBe(200);
    expect(postReplay.body.data.run).toMatchObject({ mode: "replay" });

    // A paused run cannot go on either.
    const resume = await request(app)
      .post("/api/analyze/resume")
      .send({ threadId: "some-thread", selectedTrackId: CHOICE_A });
    expect(resume.body.code).toBe("budget_exhausted");
    const resumed = await sse(
      `/api/analyze/stream/resume?threadId=some-thread&selectedTrackId=${CHOICE_A}`,
    );
    expect(resumed.map((e) => e.code ?? e.type)).toEqual(["budget_exhausted", "done"]);

    // Suggestions are the recordings; "more facts" the recorded ones, or budget_exhausted.
    const suggest = await request(app).get("/api/search/suggest?query=recorded");
    expect(suggest.body.suggestions.map((c: { id: string }) => c.id)).toEqual([TRACK_ID]);
    const facts = await request(app)
      .post("/api/factoids/decrypt")
      .send({ trackId: TRACK_ID, trackTitle: "Recorded Song", existingFactoidIds: [] });
    expect(facts.status).toBe(200);
    expect(facts.body.meta).toMatchObject({ mode: "replay" });
    const otherFacts = await request(app)
      .post("/api/factoids/decrypt")
      .send({ trackId: CHOICE_B, trackTitle: "Other", existingFactoidIds: [] });
    expect(otherFacts.status).toBe(503);
    expect(otherFacts.body.code).toBe("budget_exhausted");
    const streamedFacts = await sse("/api/factoids/decrypt/stream?trackTitle=Other");
    expect(streamedFacts.map((e) => e.code ?? e.type)).toEqual(["budget_exhausted", "done"]);
    noLiveCalls();

    // REPLAY_MODE=off never switches to recordings: the run is live (and its model calls meet
    // the budget guard one by one).
    vi.stubEnv("REPLAY_MODE", "off");
    const offEvents = await sse(streamPath("Recorded Song The Recorders"));
    expect(live.scout).toBe(1);
    const offComplete = offEvents.find((event) => event.type === "complete") as Event;
    expect((offComplete.data as TrackAnalysis).run?.mode).toBe("live");
  });

  it("pauses at the daily cap and once a full run no longer fits; runs live with budget left", async () => {
    // Spent yesterday only: today's cap is untouched.
    vi.stubEnv("BUDGET_DAILY_USD", "2");
    spent(2, new Date(Date.now() - 36 * 3600_000).toISOString());
    const liveEvents = await sse(streamPath("Something else"));
    expect(live.scout).toBe(1);
    expect(liveEvents.some((event) => event.type === "complete")).toBe(true);

    // The same spending today reaches the daily cap.
    spent(2);
    resetBudgetStateForTests();
    expect((await sse(streamPath("Something else"))).map((e) => e.code ?? e.type)).toEqual([
      "budget_exhausted",
      "done",
    ]);

    // Below the cap, but a run of the design-target size (USD 0.54) would pass it.
    spent(1.6);
    resetBudgetStateForTests();
    expect((await sse(streamPath("Something else"))).map((e) => e.code ?? e.type)).toEqual([
      "budget_exhausted",
      "done",
    ]);
    spent(1.4);
    resetBudgetStateForTests();
    await sse(streamPath("Something else"));
    expect(live.scout).toBe(2);
  });

  it("pauses at the floor kept for evaluations, with the analysis runtime's purpose", async () => {
    // Default caps: USD 25 in total, 20 kept for evaluations, so dev work stops at 5. A run of
    // USD 0.54 still fits on 4.4 spent, not on 4.6.
    spent(4.4);
    await sse(streamPath("Something else"));
    expect(live.scout).toBe(1);
    spent(4.6);
    resetBudgetStateForTests();
    expect((await sse(streamPath("Something else"))).map((e) => e.code ?? e.type)).toEqual([
      "budget_exhausted",
      "done",
    ]);
    const facts = await request(app)
      .post("/api/factoids/decrypt")
      .send({ trackId: CHOICE_B, trackTitle: "Other", existingFactoidIds: [] });
    expect(facts.body.code).toBe("budget_exhausted");
    expect(live.scout).toBe(1);
  });

  it("says live analysis is off, not that the budget is spent, when the spend log cannot be used", async () => {
    const refusal = async () =>
      (await sse(streamPath("Something else"))).map((e) => e.code ?? e.type);

    // Unset, missing, malformed.
    vi.stubEnv("LLM_SPEND_LOG", "");
    expect(await refusal()).toEqual(["live_disabled", "done"]);
    vi.stubEnv("LLM_SPEND_LOG", join(dir, "no-such-spend-log.jsonl"));
    expect(await refusal()).toEqual(["live_disabled", "done"]);
    vi.stubEnv("LLM_SPEND_LOG", spendLog);
    writeFileSync(spendLog, "not a spend record\n");
    expect(await refusal()).toEqual(["live_disabled", "done"]);
    // A recorded track still replays.
    const replayed = await sse(streamPath("Recorded Song The Recorders"));
    expect(replayed.some((e) => e.type === "complete")).toBe(true);

    // Its lock held past the wait: refused, and the answer is not kept once the lock is free.
    spent(0);
    const release = await acquireLock(await resolveSpendLogPath(spendLog));
    try {
      expect(await refusal()).toEqual(["live_disabled", "done"]);
    } finally {
      await release();
    }
    await sse(streamPath("Something else"));
    expect(live.scout).toBe(1);

    // Without a paid provider (cassettes) nothing can be spent: the budget stops nothing.
    vi.stubEnv("LLM_SPEND_LOG", join(dir, "no-such-spend-log.jsonl"));
    vi.stubEnv("LLM_CASSETTE", "replay");
    await sse(streamPath("Something else"));
    expect(live.scout).toBe(2);
  }, 15_000);

  it("keeps more facts on the side of the result: recorded for a replay, never for a live one", async () => {
    const stream = (mode: string) =>
      sse(
        `/api/factoids/decrypt/stream?trackTitle=Recorded%20Song&trackArtist=The%20Recorders&existingIds=fa&mode=${mode}`,
      );
    // Budget spent: a live result of a recorded track gets the refusal, not recorded facts.
    spent(30);
    expect((await stream("live")).map((e) => e.code ?? e.type)).toEqual([
      "budget_exhausted",
      "done",
    ]);
    // Budget available: a replayed result still gets only its recorded facts, no model call.
    spent(0);
    resetBudgetStateForTests();
    const recorded = await stream("replay");
    expect(recorded.map((e) => e.type)).toEqual(["connected", "factoid", "done"]);
    expect((recorded[1].data as { id: string }).id).toBe("fb");
    // Its recording no longer served: said so (not_found), never live facts.
    rmSync(join(replayDir, `${fixture.slug}.json`));
    resetReplaysForTests();
    const gone = await stream("replay");
    expect(gone.map((e) => e.code ?? e.type)).toEqual(["not_found", "done"]);
    expect(String(gone[0].error)).toMatch(/no longer served/);
    // Even with REPLAY_MODE=off.
    vi.stubEnv("REPLAY_MODE", "off");
    expect((await stream("replay")).map((e) => e.code ?? e.type)).toEqual(["not_found", "done"]);
    noLiveCalls();
  });
});

describe("GET /api/replays", () => {
  it("lists the recorded tracks with when they were recorded, or none", async () => {
    rmSync(replayDir, { recursive: true, force: true });
    mkdirSync(replayDir);
    resetReplaysForTests();
    const empty = await request(app).get("/api/replays");
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual({ success: true, replays: [] });

    const runId = await liveRun("source run");
    const fixture = record(runId).record;
    writeFileSync(join(replayDir, `${fixture.slug}.json`), JSON.stringify(fixture));
    resetReplaysForTests();
    const res = await request(app).get("/api/replays");
    expect(res.status).toBe(200);
    expect(ReplaysResponse.parse(res.body)).toEqual({
      success: true,
      replays: [
        {
          id: TRACK_ID,
          title: "Recorded Song",
          artist: "The Recorders",
          album: "Tapes",
          recordedAt: fixture.recordedAt,
        },
      ],
    });
    // Nothing of the recorded request (the curated query) or the result beyond the track.
    expect(Object.keys(res.body.replays[0]).sort()).toEqual(
      ["album", "artist", "id", "recordedAt", "title"].sort(),
    );
  });
});

describe("the replay directory", () => {
  it("leaves out files that are not valid records, and never matches loosely", async () => {
    const runId = await liveRun("source run");
    const good = record(runId, "good-one").record;
    const bad = join(dir, "bad-replays");
    mkdirSync(bad, { recursive: true });
    writeFileSync(join(bad, "good-one.json"), JSON.stringify(good));
    // Its parse error would quote the file: the problem names the file only.
    writeFileSync(join(bad, "not-json.json"), '{"key": sk-live-SECRETVALUE0123456789}');
    writeFileSync(join(bad, "renamed.json"), JSON.stringify(good));
    writeFileSync(
      join(bad, "live-result.json"),
      JSON.stringify({
        ...good,
        slug: "live-result",
        analysis: { ...good.analysis, run: { ...good.analysis.run, mode: "live" } },
      }),
    );

    // Fits the record's schema, but a replay of a measured result must name its analyzer.
    const audio = {
      version: 2,
      analyzerVersion: "2.0.0+librosa",
      window: { kind: "preview-30s", durationSeconds: 30 },
      gate: { passed: true, reason: null },
      tempo: {
        bpm: 120,
        confidence: 0.8,
        rawConfidence: { value: 4, range: [0, 5] },
        method: "librosa.beat.beat_track",
        basis: "signal",
      },
      key: null,
      loudness: null,
      beats: null,
      energyContour: null,
      sections: null,
      keyMoments: [],
      fingerprint: null,
    };
    const measured = { ...good.analysis, audio };
    expect(TrackAnalysis.parse(measured).audio).not.toBeNull();
    writeFileSync(
      join(bad, "unnamed-analyzer.json"),
      JSON.stringify({
        ...good,
        slug: "unnamed-analyzer",
        analysis: { ...measured, id: CHOICE_B },
        events: good.events.map((item) =>
          item.event.type === "complete"
            ? { ...item, event: { ...item.event, data: { ...measured, id: CHOICE_B } } }
            : item,
        ),
        request: { query: "unnamed analyzer", selectedTrackId: null },
      }),
    );

    const set = loadReplays(bad);
    expect(set.problems.join("\n")).toMatch(
      /unnamed-analyzer\.json: the recorded run information is wrong \(analysis\.run\.analyzerVersion: null although audio was measured\)/,
    );
    expect(set.records.map((r) => r.slug)).toEqual(["good-one"]);
    // Kept, but the producer rules its result breaks are reported.
    expect(set.warnings).toEqual([
      'good-one.json: the recorded result breaks factoids[0].claimId: unknown claim "claim-a"',
    ]);
    expect(set.problems).toContain("not-json.json: not JSON");
    expect(set.problems.join("\n")).not.toContain("sk-live");
    expect(set.problems.join("\n")).toMatch(/renamed\.json: slug "good-one"/);
    expect(set.problems.join("\n")).toMatch(/live-result\.json: not a replay record/);
    expect(set.forQuery("Recorded Song The Recorders")?.slug).toBe("good-one");
    expect(set.forQuery("The Recorders: Recorded Song!")?.slug).toBe("good-one");
    expect(set.forQuery("Recorded Song The Recorder")).toBeNull();
    expect(set.forQuery("Recorded")).toBeNull();
    expect(normalizeQuery("  Beyoncé — HALO!! ")).toBe("beyonce halo");
  });

  it("leaves out a recording that holds text the run routes or the recorder refuse: not listed, never replayed", async () => {
    rmSync(replayDir, { recursive: true, force: true });
    mkdirSync(replayDir);
    const runId = await liveRun("source run");
    const clean = record(runId).record;
    getDb().exec("DELETE FROM runs; DELETE FROM run_events;");
    live.scout = 0;
    live.search = 0;
    live.model = 0;
    vi.stubEnv("REPLAY_MODE", "only");

    const complete = clean.events.findIndex(({ event }) => event.type === "complete");
    const status = clean.events.findIndex(({ event }) => event.type === "status");
    expect(complete).toBeGreaterThan(0);
    expect(status).toBeGreaterThan(0);
    const added = clean.analysis.evidence?.length ?? 0;

    // The clean recording as another track, changed as given: its result (which a replay
    // sends, player.ts), the result its complete event stores (which a replay replaces with the
    // record's result), its first status line, an event added before the complete event, and
    // the commit it names.
    const variant = (
      slug: string,
      id: string,
      title: string,
      change: {
        analysis?: (a: TrackAnalysis) => TrackAnalysis;
        stored?: (a: TrackAnalysis) => TrackAnalysis;
        statusLine?: string;
        added?: Record<string, unknown>;
        commit?: string;
      },
    ): ReplayRecord => {
      const commit = change.commit ?? clean.commit;
      const withCommit = (a: TrackAnalysis) => ({ ...a, run: { ...a.run!, commit } });
      const base = withCommit({ ...clean.analysis, id, title });
      const analysis = change.analysis?.(base) ?? base;
      const stored = change.stored?.(base) ?? analysis;
      const events = clean.events.flatMap((item, i) => {
        if (item.event.type === "complete") {
          const done = { ...item, event: { ...item.event, data: stored } };
          return change.added ? [{ atMs: item.atMs, event: change.added }, done] : [done];
        }
        if (i === status && change.statusLine !== undefined) {
          return [{ ...item, event: { ...item.event, message: change.statusLine } }];
        }
        return [item];
      });
      return ReplayRecord.parse({
        ...clean,
        slug,
        commit,
        request: { query: `${title} The Recorders`, selectedTrackId: null },
        analysis,
        events: events.map((item, seq) => ({ ...item, event: { ...item.event, seq } })),
      });
    };
    const webItem = (url: string, excerpt: string) => ({
      id: `tavily:${url}`,
      source: "tavily" as const,
      sourceTier: "web" as const,
      url,
      title: "A page about the song",
      retrievedAt: "2026-10-20T12:00:00.000Z",
      excerpt,
      recordRef: null,
    });
    const envelope = { runId: clean.events[0].event.runId, seq: 0 };
    const social = webItem("www.instagram.com/p/abc123/", "A caption about the song.");
    const withItem = (item: ReturnType<typeof webItem>) => (a: TrackAnalysis) => ({
      ...a,
      evidence: [...(a.evidence ?? []), item],
    });
    const [, thread] = FORUM_THREADS[0];
    const trace = "musicbrainz: fetch failed at fetchJson (/app/src/sources/http.ts:120:11)";
    const withTrace = (a: TrackAnalysis) => ({
      ...a,
      run: {
        ...a.run!,
        sourceErrors: [
          { source: "musicbrainz" as const, code: "unavailable" as const, message: trace },
        ],
      },
    });
    // The checks the loader runs on a file, as far as it can tell.
    const recorderCheck = (file: ReplayRecord) =>
      leaks(file, {
        secrets: [],
        typedQuery: "",
        publicTexts: [],
        allowedCover: archiveCoverOf(file.analysis),
      });

    const bad: Record<string, [ReplayRecord, string]> = {
      // In the result and in the result its complete event stores: both checks see it.
      "forum-thread": [
        variant("forum-thread", CHOICE_A, "Forum Song", {
          analysis: withItem(webItem("https://example.org/threads/one-more-time.1234/", thread)),
        }),
        `events[${complete}].event.data.evidence[${added}].excerpt: a comment thread; analysis.evidence[${added}].excerpt: a comment thread`,
      ],
      // In the result its complete event stores: both checks see it.
      "stack-trace": [
        variant("stack-trace", CHOICE_B, "Trace Song", { stored: withTrace }),
        `events[${complete}].event.data.run.sourceErrors[0].message: a stack trace in a source error`,
      ],
      // A social page written without its scheme: the run routes' check (heldTextIssue) sees
      // it, the recorder's URL scan (leaks) does not. In the result, which a replay sends.
      "social-analysis": [
        variant("social-analysis", "0ReplayTestTrackF00001", "Profile Song", {
          analysis: withItem(social),
          stored: (a) => a,
        }),
        `analysis.evidence[${added}]: a social platform page`,
      ],
      // In an evidence event, which a replay sends as it is.
      "social-event": [
        variant("social-event", "0ReplayTestTrackG00001", "Event Song", {
          added: { type: "evidence", ...envelope, evidence: social },
        }),
        `events[${complete}].event.evidence: a social platform page`,
      ],
      // Only in the result the complete event stores, which a replay never sends (it sends the
      // record's result): checked all the same, should the player ever send it.
      "social-stored": [
        variant("social-stored", "0ReplayTestTrackC00001", "Social Song", {
          stored: withItem(social),
        }),
        `events[${complete}].event.data.evidence[${added}]: a social platform page`,
      ],
      // Only the recorder's check (leaks) sees an address or a stack trace in a status line.
      "email-status": [
        variant("email-status", "0ReplayTestTrackD00001", "Mail Song", {
          statusLine: "Write to someone@example.com for the stems",
        }),
        `events[${status}].event.message: an e-mail address`,
      ],
      "trace-status": [
        variant("trace-status", "0ReplayTestTrackE00001", "Status Song", { statusLine: trace }),
        `events[${status}].event.message: a stack trace in a status line`,
      ],
      // Events the recorder never writes, and a commit that is not a commit hash.
      "error-event": [
        variant("error-event", "0ReplayTestTrackH00001", "Error Song", {
          added: { type: "error", ...envelope, code: "failed", error: trace },
        }),
        `events[${complete}].event: an error event, which a recording never holds`,
      ],
      "interrupt-event": [
        variant("interrupt-event", "0ReplayTestTrackI00001", "Pause Song", {
          added: {
            type: "interrupt",
            ...envelope,
            reason: "disambiguation",
            threadId: envelope.runId,
            candidates: [],
            message: trace,
          },
        }),
        `events[${complete}].event: an interrupt event, which a recording never holds`,
      ],
      "bad-commit": [
        variant("bad-commit", "0ReplayTestTrackJ00001", "Commit Song", {
          commit: "abc1234 <b>at fetchJson (/x.ts:1:2)</b>",
        }),
        "commit: not a commit hash",
      ],
    };
    for (const slug of ["social-analysis", "social-event", "social-stored"]) {
      expect(recorderCheck(bad[slug][0]), slug).toEqual([]);
    }
    for (const slug of ["email-status", "trace-status"]) {
      const [file] = bad[slug];
      const sent = file.events.find(({ event }) => event.type === "complete")?.event;
      expect(heldTextIssue(file.analysis), slug).toBeNull();
      expect(sent?.type === "complete" && heldTextIssue(sent.data), slug).toBeNull();
    }

    for (const [slug, file] of [
      [clean.slug, clean] as const,
      ...Object.entries(bad).map(([slug, [file]]) => [slug, file] as const),
    ]) {
      writeFileSync(join(replayDir, `${slug}.json`), JSON.stringify(file));
    }

    const set = loadReplays(replayDir);
    expect(set.records.map((r) => r.slug)).toEqual([clean.slug]);
    // Each place once, with the first reason found for it.
    expect([...set.problems].sort()).toEqual(
      Object.entries(bad)
        .map(([slug, [, why]]) => `${slug}.json: holds text a recording must not (${why})`)
        .sort(),
    );

    resetReplaysForTests();
    const logs = captureLogsForTests();
    try {
      const listed = await request(app).get("/api/replays");
      expect(listed.body.replays.map((r: { id: string }) => r.id)).toEqual([TRACK_ID]);
      for (const [file] of Object.values(bad)) {
        const query = `${file.analysis.title} The Recorders`;
        for (const path of [
          streamPath(query),
          `${streamPath(query)}&trackId=${file.analysis.id}`,
        ]) {
          const events = await sse(path);
          expect(types(events), path).toEqual(["error", "done"]);
          expect(events[0].code).toBe("live_disabled");
        }
      }
      // The clean recording still replays.
      expect(types(await sse(streamPath("Recorded Song The Recorders")))).toContain("complete");
    } finally {
      logs.restore();
    }
    noLiveCalls();
    // The log names the file and why, never the text.
    const logged = logs.lines().join("\n");
    for (const slug of Object.keys(bad)) {
      expect(logged).toContain(`${slug}.json: holds text a recording must not`);
    }
    for (const text of ["RecordFan", "fetchJson", "someone@example.com", "instagram"]) {
      expect(logged).not.toContain(text);
    }
  });
});
