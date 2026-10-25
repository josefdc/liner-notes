import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
  MAX_LOGGED_TEXT,
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
    ["an api-key header", '{"api-key":"k-123456"}', '{"api-key":[redacted]}'],
    [
      "a quoted Bearer token",
      'header was Authorization: Bearer "abc123def"',
      "header was Authorization: [redacted]",
    ],
    ["a quoted Bearer token alone", 'sent Bearer "abc123def" on', "sent Bearer [redacted] on"],
    [
      "a quoted password",
      'login failed with password="hunter2" for user',
      "login failed with password=[redacted] for user",
    ],
    [
      "a subscription key header",
      "Ocp-Apim-Subscription-Key: rtSubKey123456",
      "Ocp-Apim-Subscription-Key: [redacted]",
    ],
    [
      "api_sig and sk in a URL",
      "https://ws.example/2.0/?api_sig=abc123&sk=def456&x=1",
      "https://ws.example/2.0/?api_sig=[redacted]&sk=[redacted]&x=1",
    ],
    [
      "a Deezer preview link without a scheme",
      "clip cdnt-preview.dzcdn.net/api/1/1/a.mp3?hdnea=exp=1~hmac=abc ok",
      "clip [preview link] ok",
    ],
    [
      "a Spotify preview link without a scheme",
      "clip p.scdn.co/mp3-preview/abc?cid=1 ok",
      "clip [preview link] ok",
    ],
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
      "i.scdn.co/image/ab67 and scdn.co",
    ]) {
      expect(scrub(text)).toBe(text);
    }
  });

  it("cuts text off past MAX_LOGGED_TEXT, and takes linear time on long host-like text", () => {
    const long = scrub("x".repeat(MAX_LOGGED_TEXT + 100));
    expect(long).toHaveLength(MAX_LOGGED_TEXT + "…[truncated]".length);
    expect(long.endsWith("…[truncated]")).toBe(true);
    const started = performance.now();
    scrub("a-".repeat(8000));
    scrub("a.".repeat(8000));
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("does not replace short or numeric configured values", () => {
    configureLogger({ SOME_API_KEY: "200000", SHORT_TOKEN: "abc1234", LONG_KEY: KEY });
    expect(scrub("count 200000, word abc1234")).toBe("count 200000, word abc1234");
    logger("X").info("count", { n: 200000 });
    expect(logs.entries()[0]).toMatchObject({ n: 200000 });
  });
});

describe("a configured secret that cannot be replaced safely", () => {
  it("withholds the line instead of writing the secret", () => {
    // A value that also occurs as JSON structure in every line.
    configureLogger({ ODD_SECRET: ',"time":' });
    logs = captureLogsForTests();
    logger("Probe").info("something happened", { runId: "run-1" });
    const raw = logs.lines();
    expect(raw).toHaveLength(1);
    const line = JSON.parse(raw[0]) as Record<string, unknown>;
    expect(line.msg).toBe("log line withheld: it contained a configured secret");
    expect(line.component).toBe("Probe");
    expect(raw[0]).not.toContain("something happened");
  });
});

describe("every line", () => {
  // The forms the scrubber rewrites, and characters JSON must escape, in random order.
  const PIECES = [
    '"',
    "'",
    "\\",
    '\\"',
    "\n",
    "\u0000",
    " ",
    ":",
    "=",
    ",",
    "}",
    "]",
    "Bearer ",
    "Basic ",
    "Discogs token=",
    "password=",
    "password: ",
    "token=",
    "api-key: ",
    "Authorization: ",
    "https://",
    "p.scdn.co/x",
    "cdnt-preview.dzcdn.net/a?hdnea=1",
    "dummy-resource.example.net",
    KEY,
    "[redacted]",
    "abc123",
    "é",
    "😀",
  ];

  it("is valid JSON and holds no configured secret, whatever text it is given (fuzz)", () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const text = () =>
      Array.from(
        { length: 1 + Math.floor(random() * 12) },
        () => PIECES[Math.floor(random() * PIECES.length)],
      ).join("");
    const log = logger("Fuzz");
    for (let i = 0; i < 10_000; i++) {
      const t = text();
      log.warn(t, { [text()]: t, note: t, err: new Error(t) });
    }
    const lines = logs.lines();
    expect(lines).toHaveLength(10_000);
    for (const line of lines) {
      expect(() => JSON.parse(line), line).not.toThrow();
      expect(line).not.toContain(KEY);
      expect(line).not.toContain("dummy-resource");
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

describe("serializeError, the API's own errors", () => {
  it("keeps the kind, how long to wait, why an answer was cut off and an AggregateError's errors", () => {
    const sourceError = Object.assign(new Error("rate limited"), {
      name: "SourceError",
      kind: "rate_limited",
      source: "spotify",
      retryAfterMs: 30_000,
      body: '{"error":"secret upstream body"}',
    });
    const llmError = Object.assign(new Error("cut off"), {
      kind: "invalid_output",
      incompleteReason: "max_output_tokens",
    });
    const aggregate = new AggregateError([sourceError, new Error(`with ${KEY}`)], "both failed");
    const serialized = serializeError(aggregate) as Record<string, unknown>;
    expect(serialized).toMatchObject({
      type: "AggregateError",
      message: "both failed",
      errors: [
        { type: "SourceError", kind: "rate_limited", source: "spotify", retryAfterMs: 30_000 },
        { message: "with [redacted]" },
      ],
    });
    expect(serializeError(llmError)).toMatchObject({
      kind: "invalid_output",
      incompleteReason: "max_output_tokens",
    });
    expect(JSON.stringify(serialized)).not.toContain("secret upstream body");
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

describe("a log call", () => {
  it("never throws on fields it cannot read, and says so", () => {
    const odd = new Error("x");
    (odd as unknown as { message: unknown }).message = { detail: "an object" };
    Object.defineProperty(odd, "code", {
      get() {
        throw new Error("getter exploded");
      },
    });
    const throwingFields = Object.defineProperty({}, "boom", {
      enumerable: true,
      get() {
        throw new Error("field getter exploded");
      },
    });
    const proxy = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("proxy boom");
        },
      },
    );
    const log = logger("Odd");
    expect(() => log.error("odd error", { err: odd })).not.toThrow();
    expect(() => log.error("odd fields", throwingFields)).not.toThrow();
    expect(() => log.error("proxy field", { inner: proxy })).not.toThrow();
    expect(() =>
      log.error("undefined message", { err: Object.assign(new Error(), { message: undefined }) }),
    ).not.toThrow();

    const [oddError, fields, proxied] = logs.entries();
    expect(oddError).toMatchObject({
      msg: "odd error",
      err: { type: "Error", message: "[object Object]", stack: expect.any(String) },
    });
    expect(oddError.err).not.toHaveProperty("code");
    expect(fields).toMatchObject({ component: "Odd", msg: "log line could not be written" });
    expect(proxied).toMatchObject({ msg: "proxy field", inner: "[unreadable]" });
    expect(logs.lines()).toHaveLength(4);
  });

  it("keeps numbers and booleans under secret-looking names, and redacts token lists", () => {
    logger("X").info("usage", {
      apiKeyConfigured: true,
      response: 503,
      tokensIn: 12,
      input_tokens_details: { cached_tokens: 4 },
      refreshTokens: ["rt-0123456789abcdef"],
      accessToken: "at-0123456789abcdef",
    });
    const entry = logs.entries()[0];
    expect(entry).toMatchObject({
      apiKeyConfigured: true,
      response: 503,
      tokensIn: 12,
      input_tokens_details: { cached_tokens: 4 },
      refreshTokens: "[redacted]",
      accessToken: "[redacted]",
    });
    expect(JSON.stringify(entry)).not.toContain("0123456789abcdef");
  });

  it("replaces fields whose name says they are secret, compound names included", () => {
    logger("X").info("fields", {
      spotifyAccessToken: "BQD-1",
      bearerToken: "t-2",
      secretKey: "s-3",
      azureOpenAIApiKey: "k-4",
      subscriptionKey: "k-5",
      clientPassword: "p-6",
      key: "k-7",
      spotifyPreviewUrl: "https://e.dzcdn.net/x",
      inputTokens: 900,
      tokenCount: 3,
      cacheKey: "track:1",
    });
    const [entry] = logs.entries();
    for (const name of [
      "spotifyAccessToken",
      "bearerToken",
      "secretKey",
      "azureOpenAIApiKey",
      "subscriptionKey",
      "clientPassword",
      "key",
      "spotifyPreviewUrl",
    ]) {
      expect(entry[name], name).toBe("[redacted]");
    }
    expect(entry).toMatchObject({ inputTokens: 900, tokenCount: 3, cacheKey: "track:1" });
  });

  it("writes a query that is not a string as its length too", () => {
    logger("X").info("q", { query: ["typed a", "typed b"], q: { value: "typed obj" } });
    const [entry] = logs.entries();
    expect(entry).toMatchObject({ queryLength: 2, qLength: 21 });
    expect(logs.lines()[0]).not.toContain("typed");
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
        target.error(
          "no tag here",
          { previewUrl: "https://p.scdn.co/mp3-preview/a", note: "https://p.scdn.co/b" },
          Object.assign(new Error("second"), {
            config: { headers: { "Ocp-Apim-Subscription-Key": "rtSubKey123456" } },
          }),
          { nested: { mySecretToken: "tok-1234567" } },
        );
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
    expect(logs.lines().join("\n")).not.toMatch(
      /p\.scdn\.co|dummy-azure-key|rtSubKey123456|tok-1234567/,
    );
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

  it("creates LOG_FILE readable by its owner only, and takes a relative path from baseDir", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-file-"));
    try {
      expect(configureLogger({ LOG_FILE: "logs/api.jsonl" }, { baseDir: dir })).toEqual([]);
      logger("Run").info("to the file");
      const file = join(dir, "logs", "api.jsonl");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, "utf8")).toContain("to the file");
    } finally {
      configureLogger({ LOG_LEVEL: "silent" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("warns when an existing LOG_FILE can be read by other users", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-file-"));
    try {
      const file = join(dir, "api.jsonl");
      writeFileSync(file, "");
      chmodSync(file, 0o644);
      expect(configureLogger({ LOG_FILE: file })).toEqual([
        expect.stringContaining("can be read or written by other users (mode 644)"),
      ]);
    } finally {
      configureLogger({ LOG_LEVEL: "silent" });
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a LOG_FILE that is not a regular file, at once (a FIFO would hold startup)", () => {
    const dir = mkdtempSync(join(tmpdir(), "log-file-"));
    try {
      const fifo = join(dir, "fifo");
      execFileSync("mkfifo", [fifo]);
      const started = Date.now();
      expect(configureLogger({ LOG_FILE: fifo })).toEqual([
        expect.stringContaining("is not a regular file; logging to stdout only"),
      ]);
      expect(configureLogger({ LOG_FILE: dir })).toEqual([
        expect.stringContaining("is not a regular file"),
      ]);
      expect(Date.now() - started).toBeLessThan(1000);
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
