/**
 * Replay mode end to end, in process: a stubbed live run is stored by the real analysis routes
 * (the nodes that call outside services are stubs, as in runs.test.ts), recorded with the
 * recorder, written to a scratch replay directory and served under REPLAY_MODE by the app
 * createApp builds. Under REPLAY_MODE=only nothing live may run: the stub scout, the Spotify
 * search and the model layer count their calls, and every replay test requires 0.
 *
 * The stub scout picks its path from the query: "ambiguous …" offers two candidates (the run
 * pauses), anything else matches TRACK_ID; for "echo …" its status repeats the typed query. The
 * stub composer's result carries a preview URL (under `previewUrl` and as a genealogy image), a
 * cover URL and the typed query in a field the contract does not name.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  AnalyzeStreamEvent,
  type ReplayRecord,
  ReplaysResponse,
  RunResponse,
  runIssues,
  TrackAnalysis,
} from "@liner-notes/contract";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SonicAgentStateType } from "../agent/state.js";
import { DEFAULT_RATE_LIMIT, DEFAULT_SEARCH_RATE_LIMIT } from "../config/settings.js";
import { createApp } from "../http/app.js";
import { resetBudgetStateForTests } from "../llm/budgetState.js";
import { closeDatabase, getDb, initializeDatabase } from "../store/database.js";
import { getRun, listRunEvents } from "../store/runs.js";
import { chooseReplay, currentReplayMode, liveRefused } from "./mode.js";
import { playRecord, setReplayPacingForTests } from "./player.js";
import {
  buildRecord,
  leaks,
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
  };
  return { run, events };
}

describe("the recorder", () => {
  it("records a live run as it was sent: only previews, images and the run id are changed", async () => {
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
    expect(resumed.some((e) => /^User confirmed/.test(String(e.message)))).toBe(true);
    expect(new Set(stored(threadId).events.map((e) => e.stream))).toEqual(new Set([0, 1]));

    const { record: built } = record(threadId);
    const recorded = built.events.map((e) => e.event as Event);
    expect(types(recorded)).not.toContain("interrupt");
    expect(types(recorded)).not.toContain("resuming");
    expect(types(recorded)[0]).toBe("connected");
    expect(types(recorded).slice(-2)).toEqual(["complete", "done"]);
    expect(recorded.map((e) => e.seq)).toEqual(recorded.map((_, i) => i));
    // The user's own choice in that run is not part of the recording.
    expect(recorded.some((e) => /^User confirmed/.test(String(e.message)))).toBe(false);
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

  it("pauses when the spend log cannot be read: the guard would refuse every model call", async () => {
    vi.stubEnv("LLM_SPEND_LOG", join(dir, "no-such-spend-log.jsonl"));
    const events = await sse(streamPath("Something else"));
    expect(events.map((e) => e.code ?? e.type)).toEqual(["budget_exhausted", "done"]);
    // Without a paid provider (cassettes) nothing can be spent: the budget stops nothing.
    vi.stubEnv("LLM_CASSETTE", "replay");
    await sse(streamPath("Something else"));
    expect(live.scout).toBe(1);
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
