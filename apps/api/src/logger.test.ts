import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Annotation, END, MemorySaver, START, StateGraph } from "@langchain/langgraph";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type CapturedLogs,
  captureLogsForTests,
  configureLogger,
  currentRunId,
  installConsoleBridge,
  ipHash,
  logger,
  scrub,
  serializeError,
  withRun,
} from "./logger.js";

const KEY = "dummy-azure-key-0123456789";
const ENDPOINT = "https://dummy-resource.example.net";

let logs: CapturedLogs;
beforeEach(() => {
  configureLogger({ AZURE_OPENAI_API_KEY: KEY, AZURE_OPENAI_ENDPOINT: ENDPOINT });
  logs = captureLogsForTests();
});
afterEach(() => {
  logs.restore();
  configureLogger({ LOG_LEVEL: "silent" });
});

describe("scrub", () => {
  it.each([
    [
      "a Deezer preview link, signed",
      "GET https://cdnt-preview.dzcdn.net/api/1/1/a/b/c.mp3?hdnea=exp=1~acl=*~hmac=ab12 failed",
      "GET [preview link] failed",
    ],
    [
      "a Deezer preview link on another CDN host",
      "url: 'https://cdns-preview-d.dzcdn.net/stream/c-deadbeef-1.mp3'",
      "url: '[preview link]'",
    ],
    [
      "a Spotify preview link",
      "preview https://p.scdn.co/mp3-preview/abc?cid=123",
      "preview [preview link]",
    ],
    ["a Bearer token", "Authorization: Bearer abc.def-ghi", "Authorization: [redacted]"],
    ["a Bearer token alone", "sent Bearer abc.def-ghi", "sent Bearer [redacted]"],
    [
      "nothing twice",
      "Authorization: Bearer [redacted], token=[redacted]",
      "Authorization: Bearer [redacted], token=[redacted]",
    ],
    ["Basic credentials", "Basic dXNlcjpwYXNzd29yZA==", "Basic [redacted]"],
    ["a Discogs token", "Discogs token=abcdef123", "Discogs token=[redacted]"],
    ["an api-key header", '{"api-key":"k-123456"}', '{"api-key":"[redacted]"}'],
    [
      "a key in a URL",
      "https://ws.audioscrobbler.com/2.0/?method=track.getTopTags&api_key=abc123&format=json",
      "https://ws.audioscrobbler.com/2.0/?method=track.getTopTags&api_key=[redacted]&format=json",
    ],
    ["credentials in a URL", "https://user:pw@db.example/x", "https://[redacted]@db.example/x"],
    ["a configured key", `failed with ${KEY}`, "failed with [redacted]"],
    [
      "the configured endpoint",
      `${ENDPOINT}/openai/v1/responses timed out`,
      "[provider endpoint] timed out",
    ],
    [
      "the configured endpoint's host",
      "getaddrinfo ENOTFOUND dummy-resource.example.net",
      "getaddrinfo ENOTFOUND [provider endpoint]",
    ],
    [
      "any Azure OpenAI host",
      "connect to other-res.openai.azure.com failed",
      "connect to [provider endpoint] failed",
    ],
  ])("replaces %s", (_label, text, expected) => {
    expect(scrub(text)).toBe(expected);
  });

  it("leaves ordinary text alone", () => {
    for (const text of [
      "Found 12 track tags",
      "maxTokens: 300, tokens: 12",
      "Basic info about the track",
      "https://i.scdn.co/image/ab67616d0000b273",
      "https://musicbrainz.org/ws/2/recording/abc?inc=artist-rels&fmt=json",
    ]) {
      expect(scrub(text)).toBe(text);
    }
  });
});

describe("serializeError", () => {
  it("keeps the type, the scrubbed message and stack, code, status and cause; nothing else", () => {
    const cause = new Error(`upstream said Bearer secret-cause-token`);
    const error = Object.assign(
      new Error(`401 from ${ENDPOINT}/openai/v1 with ${KEY}`, { cause }),
      {
        name: "APIError",
        status: 401,
        code: "invalid_api_key",
        headers: { authorization: "Bearer header-token", "api-key": KEY },
        config: { apiKey: KEY, baseURL: ENDPOINT },
      },
    );
    const serialized = serializeError(error) as Record<string, unknown>;
    expect(Object.keys(serialized).sort()).toEqual([
      "cause",
      "code",
      "message",
      "stack",
      "status",
      "type",
    ]);
    expect(serialized).toMatchObject({
      type: "APIError",
      status: 401,
      code: "invalid_api_key",
      message: "401 from [provider endpoint] with [redacted]",
      cause: { type: "Error", message: "upstream said Bearer [redacted]" },
    });
    const text = JSON.stringify(serialized);
    for (const secret of [KEY, "dummy-resource", "secret-cause-token", "header-token"]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("a log line", () => {
  it("is one JSON object with the level, the time, the component and the fields", () => {
    logger("Scout").info("Found a match", { candidates: 2 });
    expect(logs.lines()).toHaveLength(1);
    expect(logs.entries()[0]).toMatchObject({
      level: "info",
      time: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      component: "Scout",
      candidates: 2,
      msg: "Found a match",
    });
  });

  it("replaces secret fields, at any depth, and serializes errors", () => {
    logger("Engineer").warn("Lookup failed", {
      previewUrl: "https://p.scdn.co/mp3-preview/abc",
      nested: {
        headers: { Authorization: "Bearer t" },
        apiKey: KEY,
        list: [{ preview: "https://e.dzcdn.net/x" }, { token: "t-123456" }],
      },
      err: new Error(`failed: ${KEY}`),
    });
    const [entry] = logs.entries();
    expect(entry).toMatchObject({
      previewUrl: "[redacted]",
      nested: {
        headers: "[redacted]",
        apiKey: "[redacted]",
        list: [{ preview: "[redacted]" }, { token: "[redacted]" }],
      },
      err: { type: "Error", message: "failed: [redacted]" },
    });
    expect(logs.lines()[0]).not.toContain(KEY);
  });

  it("writes the typed query at debug level only; above, its length", () => {
    const log = logger("Run");
    log.info("Analysis", { query: "Midnight City" });
    log.warn("No match", { songQuery: "Midnight City" });
    log.debug("Analysis: query", { query: "Midnight City" });
    const [info, warn, debug] = logs.entries();
    expect(info).toMatchObject({ queryLength: 13 });
    expect(info).not.toHaveProperty("query");
    expect(warn).toMatchObject({ songQueryLength: 13 });
    expect(debug).toMatchObject({ query: "Midnight City" });
  });

  it("is not written below the level", () => {
    logs.restore();
    logs = captureLogsForTests({ level: "info" });
    logger("Run").debug("hidden", { query: "x" });
    logger("Run").info("shown");
    expect(logs.messages()).toEqual(["shown"]);
  });
});

describe("the run id", () => {
  it("is on every line logged inside withRun, after awaits and timers, and on no other", async () => {
    const log = logger("Test");
    log.info("before");
    await withRun("run-a", async () => {
      log.info("sync");
      await new Promise((resolve) => setTimeout(resolve, 1));
      log.info("after a timer");
      await Promise.all([1, 2].map(async (i) => log.info(`parallel ${i}`)));
      setImmediate(() => log.info("from setImmediate"));
      await new Promise((resolve) => setImmediate(resolve));
    });
    log.info("after");
    const byMessage = Object.fromEntries(logs.entries().map((entry) => [entry.msg, entry.runId]));
    expect(byMessage).toEqual({
      before: undefined,
      sync: "run-a",
      "after a timer": "run-a",
      "parallel 1": "run-a",
      "parallel 2": "run-a",
      "from setImmediate": "run-a",
      after: undefined,
    });
  });

  it("an explicit runId field wins over the context's", () => {
    withRun("run-a", () => logger("Test").info("x", { runId: "run-b" }));
    expect(logs.entries()[0].runId).toBe("run-b");
  });

  it("survives LangGraph's async chain: parallel nodes, a timer, a checkpointer, a resume", async () => {
    const State = Annotation.Root({
      seen: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
    });
    const log = logger("Node");
    const node = (name: string, wait: number) => async () => {
      await new Promise((resolve) => setTimeout(resolve, wait));
      log.info(name, { contextRunId: currentRunId() ?? null });
      return { seen: [name] };
    };
    const graph = new StateGraph(State)
      .addNode("first", node("first", 2))
      .addNode("left", node("left", 3))
      .addNode("right", node("right", 1))
      .addNode("last", node("last", 0))
      .addEdge(START, "first")
      .addEdge("first", "left")
      .addEdge("first", "right")
      .addEdge(["left", "right"], "last")
      .addEdge("last", END)
      .compile({ checkpointer: new MemorySaver(), interruptBefore: ["last"] });

    const run = (runId: string, input: Parameters<typeof graph.stream>[0]) =>
      withRun(runId, async () => {
        const stream = await graph.stream(input, {
          configurable: { thread_id: runId },
          streamMode: "updates",
        });
        for await (const _update of stream) {
          // drained
        }
      });

    // Two runs at once, each paused before its last node, then each resumed.
    await Promise.all([run("run-1", { seen: [] }), run("run-2", { seen: [] })]);
    await Promise.all([run("run-1", null), run("run-2", null)]);

    const entries = logs.entries();
    expect(entries).toHaveLength(8);
    for (const entry of entries) {
      expect(entry.runId).toMatch(/^run-[12]$/);
      expect(entry.contextRunId).toBe(entry.runId);
    }
    expect(
      entries
        .filter((entry) => entry.runId === "run-1")
        .map((entry) => entry.msg)
        .sort(),
    ).toEqual(["first", "last", "left", "right"]);
  });
});

describe("the console bridge", () => {
  it("sends console calls through the logger: JSON, level, tag as component, error as err", () => {
    const target = {
      log: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    } as unknown as Console;
    const original = target.log;
    const restore = installConsoleBridge(target);
    try {
      withRun("run-c", () => {
        target.log("🔍 [Cache] Hit for", "track-1");
        target.warn("[Store] Write failed:", new Error(`disk full near ${KEY}`));
        target.error("no tag here", { previewUrl: "https://p.scdn.co/mp3-preview/a" });
        target.debug("[Researcher] step 2");
      });
    } finally {
      restore();
    }
    expect(target.log).toBe(original);

    const entries = logs.entries();
    expect(entries).toEqual([
      expect.objectContaining({
        level: "info",
        component: "Cache",
        msg: "Hit for track-1",
        runId: "run-c",
      }),
      expect.objectContaining({
        level: "warn",
        component: "Store",
        msg: "Write failed",
        err: expect.objectContaining({ message: "disk full near [redacted]" }),
        runId: "run-c",
      }),
      expect.objectContaining({ level: "error", msg: expect.stringContaining("[preview link]") }),
      expect.objectContaining({ level: "debug", component: "Researcher", msg: "step 2" }),
    ]);
    expect(entries[2]).not.toHaveProperty("component");
    expect(logs.lines().join("\n")).not.toMatch(/p\.scdn\.co|dummy-azure-key/);
  });
});

describe("client addresses", () => {
  it("are hashed with a key: the same address alike, another key another hash", () => {
    configureLogger({ LOG_IP_SALT: "salt-one" });
    const first = ipHash("203.0.113.7");
    expect(first).toMatch(/^[0-9a-f]{16}$/);
    expect(ipHash("203.0.113.7")).toBe(first);
    expect(ipHash("203.0.113.8")).not.toBe(first);
    configureLogger({ LOG_IP_SALT: "salt-two" });
    expect(ipHash("203.0.113.7")).not.toBe(first);
    // No LOG_IP_SALT: a random key for this process.
    configureLogger({});
    expect(ipHash("203.0.113.7")).not.toBe(first);
    expect(ipHash(undefined)).toBeUndefined();
  });
});

describe("configureLogger", () => {
  it("appends the lines to LOG_FILE as well", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-file-"));
    try {
      const file = join(dir, "logs", "api.jsonl");
      expect(configureLogger({ LOG_FILE: file })).toEqual([]);
      withRun("run-f", () => logger("Run").info("to the file"));
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        expect.objectContaining({ msg: "to the file", runId: "run-f" }),
      ]);
      // And to stdout (here, the capture) as well.
      expect(logs.messages()).toEqual(["to the file"]);
    } finally {
      configureLogger({ LOG_LEVEL: "silent" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns about an unknown LOG_LEVEL and an unusable LOG_FILE, and goes on at info", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-file-"));
    try {
      const warnings = configureLogger({ LOG_LEVEL: "loud", LOG_FILE: join(dir, "\0bad") });
      expect(warnings).toEqual([
        expect.stringContaining("LOG_LEVEL=loud is not one of"),
        expect.stringContaining("cannot be opened"),
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
