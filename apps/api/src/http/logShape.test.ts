/**
 * The shape of the log of one analysis, end to end: the real app (createApp, with its request
 * log), the real analyze routes and the real compiled graph, with the nodes replaced by stubs
 * that log the way the real ones do (through the logger and through the console) and that try to
 * log what must never reach the log: preview links, keys, tokens, the provider endpoint and the
 * typed query.
 *
 * Every line is one JSON object carrying the run's id, though the nodes run inside LangGraph,
 * in parallel, after timers; no line holds a client address, a query string, a preview host or a
 * secret; the typed text is written at debug level only.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SonicAgentStateType } from "../agent/state.js";
import {
  DEFAULT_RATE_LIMIT,
  DEFAULT_SEARCH_RATE_LIMIT,
  type HttpSettings,
} from "../config/settings.js";
import {
  type CapturedLogs,
  captureLogsForTests,
  configureLogger,
  installConsoleBridge,
  logger,
} from "../logger.js";
import { closeDatabase, initializeDatabase } from "../store/database.js";
import { createApp } from "./app.js";

const SECRETS = vi.hoisted(() => ({
  key: "dummy-azure-key-0123456789",
  bearer: "dummy-bearer-token-abcdef",
  endpointHost: "dummy-resource.example.net",
  deezerPreview:
    "https://cdnt-preview.dzcdn.net/api/1/1/a/b/c/0/abc.mp3?hdnea=exp=1761360000~acl=/api/1/1/a/b/c/0/abc.mp3*~data=user_id=0,application_id=42~hmac=0123abcd",
  spotifyPreview: "https://p.scdn.co/mp3-preview/0123456789abcdef?cid=fedcba9876543210",
}));

vi.mock("../agent/nodes/index.js", () => {
  type State = SonicAgentStateType;
  type Config = LangGraphRunnableConfig;
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const threadOf = (config: Config) => config.configurable?.thread_id as string;
  const status = (config: Config, node: string, message: string) =>
    config.writer?.({ type: "status", node, message, timestamp: new Date().toISOString() });

  return {
    clarificationNode: async () => ({}),
    scoutNode: async (state: State, config: Config) => {
      const log = logger("Scout");
      status(config, "scout", "searching");
      // The typed text as a field: written at debug only.
      log.info("Searching", { query: state.songQuery, threadId: threadOf(config) });
      await pause(5);
      // An upstream error that carries what must never be logged, through the console.
      console.warn(
        "[Scout] Preview lookup failed:",
        new Error(
          `GET ${SECRETS.deezerPreview} failed; Authorization: Bearer ${SECRETS.bearer}; ` +
            `api-key=${SECRETS.key} at https://${SECRETS.endpointHost}/openai/v1/responses`,
        ),
      );
      return { spotifyData: { id: "track-only", title: "Title", artist: "Artist" } };
    },
    engineerNode: async (_state: State, config: Config) => {
      await pause(3);
      logger("Engineer").info("Measured", {
        threadId: threadOf(config),
        previewUrl: SECRETS.spotifyPreview,
        request: { headers: { authorization: `Bearer ${SECRETS.bearer}` } },
      });
      return {};
    },
    historianNode: async (_state: State, config: Config) => {
      await new Promise((resolve) => setImmediate(resolve));
      console.log(`[Historian] Read the sources for ${threadOf(config)}`, {
        preview: SECRETS.deezerPreview,
      });
      return {};
    },
    composerNode: async (state: State, config: Config) => {
      logger("Composer").info("Composing", { threadId: threadOf(config) });
      const trackData = {
        id: "track-only",
        title: "Title",
        artist: "Artist",
        album: "Album",
        coverUrl: "",
        bpm: null,
        genealogy: { nodes: [], links: [] },
        spotify: state.spotifyData,
      };
      config.writer?.({ type: "complete", data: trackData });
      return { trackData, statusMessages: ["done"] };
    },
  };
});

const QUERY = "Midnight City M83 typed-text-marker";

const settings: HttpSettings = {
  corsOrigins: [],
  trustProxy: 0,
  rateLimit: DEFAULT_RATE_LIMIT,
  globalRateLimit: { windowMs: DEFAULT_RATE_LIMIT.windowMs, max: 10_000 },
  searchRateLimit: DEFAULT_SEARCH_RATE_LIMIT,
};

const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
const IPV6 = /::1\b|::ffff:|\b[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){7}\b/i;

let dir: string;
let logs: CapturedLogs;
let restoreConsole: () => void;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "log-shape-"));
  initializeDatabase(join(dir, "test.db"));
});
afterAll(() => {
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  // As at startup (config/env.ts): the values the log must never hold.
  configureLogger({
    AZURE_OPENAI_API_KEY: SECRETS.key,
    AZURE_OPENAI_ENDPOINT: `https://${SECRETS.endpointHost}`,
  });
  logs = captureLogsForTests({ level: "debug" });
  restoreConsole = installConsoleBridge();
});
afterEach(() => {
  restoreConsole();
  logs.restore();
  configureLogger({ LOG_LEVEL: "silent" });
});

/** Runs one analysis stream and returns its run id. */
async function analyze(app: ReturnType<typeof createApp>): Promise<string> {
  const res = await request(app)
    .get(`/api/analyze/stream?query=${encodeURIComponent(QUERY)}`)
    .buffer(true)
    .parse((response, callback) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => callback(null, body));
    });
  const events = String(res.body)
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as { type: string; threadId?: string });
  expect(events.map((event) => event.type)).toContain("complete");
  return events.find((event) => event.type === "connected")?.threadId as string;
}

describe("the log of one analysis", () => {
  it("is JSON lines that all carry the run id, with nothing secret and no client address", async () => {
    const runId = await analyze(createApp({ http: settings }));
    const lines = logs.lines();
    const entries = logs.entries();

    // Every line: JSON, and the run's id.
    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) expect(() => JSON.parse(line), line).not.toThrow();
    for (const entry of entries) expect(entry.runId, JSON.stringify(entry)).toBe(runId);

    // Lines from the nodes (logger and console alike), from the route and the request line.
    const components = new Set(entries.map((entry) => entry.component));
    for (const component of ["Scout", "Engineer", "Historian", "Composer", "Run", "HTTP"]) {
      expect(components, component).toContain(component);
    }
    const requestLine = entries.find((entry) => entry.path === "/api/analyze/stream");
    expect(requestLine).toMatchObject({ method: "GET", status: 200, runId });
    expect(requestLine?.ipHash).toMatch(/^[0-9a-f]{16}$/);

    const text = lines.join("\n");
    // No client address, no query string.
    expect(text).not.toMatch(IPV4);
    expect(text).not.toMatch(IPV6);
    expect(text).not.toContain("query=");
    // No preview link, key, token or endpoint, whatever field it was in.
    for (const host of ["dzcdn.net", "p.scdn.co", "hdnea", "hmac="])
      expect(text).not.toContain(host);
    for (const secret of [SECRETS.key, SECRETS.bearer, SECRETS.endpointHost]) {
      expect(text).not.toContain(secret);
    }
    expect(text).toContain("[redacted]");
    expect(text).toContain("[preview link]");
    expect(text).toContain("[provider endpoint]");

    // The typed text: only at debug level; at info its length.
    for (const entry of entries) {
      if (entry.level !== "debug") expect(JSON.stringify(entry)).not.toContain("typed-text-marker");
    }
    expect(entries.find((entry) => entry.msg === "Streaming analysis")).toMatchObject({
      level: "info",
      queryLength: [...QUERY].length,
    });
    expect(
      entries.find((entry) => entry.component === "Scout" && entry.msg === "Searching"),
    ).toMatchObject({
      queryLength: [...QUERY].length,
    });
  });

  it("keeps each run's id on its own lines when runs overlap", async () => {
    const app = createApp({ http: settings });
    const runIds = await Promise.all([analyze(app), analyze(app), analyze(app)]);
    expect(new Set(runIds).size).toBe(3);

    const entries = logs.entries();
    for (const entry of entries) expect(runIds).toContain(entry.runId);
    // A node's line names its thread; the run id the logger added is that thread's.
    const nodeLines = entries.filter((entry) => typeof entry.threadId === "string");
    expect(nodeLines.length).toBe(3 * 3);
    for (const entry of nodeLines) expect(entry.runId).toBe(entry.threadId);
  });
});
