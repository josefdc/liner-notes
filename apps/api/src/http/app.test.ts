/**
 * Tests for createApp: CORS, rate limits, body limit, error handling and the wiring of the
 * routes. Model and Spotify calls are stubbed and never reached by these requests.
 */

import { Router } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  DEFAULT_RATE_LIMIT,
  DEFAULT_SEARCH_RATE_LIMIT,
  type HttpSettings,
} from "../config/settings.js";
import { request as httpRequest } from "node:http";
import { connect } from "node:net";
import { brotliCompressSync, deflateSync, gzipSync, constants as zlibConstants } from "node:zlib";
import express from "express";
import { llm } from "../llm/invoke.js";
import { type CapturedLogs, captureLogsForTests } from "../logger.js";
import { createApp } from "./app.js";
import { asyncRoute } from "./middleware/errors.js";
import { listedOriginsOnly } from "./middleware/origin.js";

vi.mock("../llm/invoke.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../llm/invoke.js")>();
  return {
    ...actual,
    llm: {
      ...actual.llm,
      invoke: vi.fn(async () => {
        throw new Error("the model must not be called in these tests");
      }),
    },
  };
});

vi.mock("../sources/spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/spotify.js")>()),
  searchTracks: vi.fn(async () => {
    throw new Error("Spotify must not be called in these tests");
  }),
}));

const LISTED = "http://localhost:3110";

function settings(overrides: Partial<HttpSettings> = {}): HttpSettings {
  return {
    corsOrigins: [LISTED],
    trustProxy: 0,
    rateLimit: DEFAULT_RATE_LIMIT,
    globalRateLimit: { windowMs: DEFAULT_RATE_LIMIT.windowMs, max: 10_000 },
    searchRateLimit: DEFAULT_SEARCH_RATE_LIMIT,
    ...overrides,
  };
}

const app = (overrides?: Partial<HttpSettings>) => createApp({ http: settings(overrides) });

let logs: CapturedLogs;
beforeEach(() => {
  logs = captureLogsForTests();
});

afterEach(() => {
  logs.restore();
  vi.restoreAllMocks();
  vi.mocked(llm.invoke).mockReset();
});

/** The lines logged at `level` (component HTTP and others alike). */
const logsAt = (level: string) => logs.entries().filter((entry) => entry.level === level);

/** Makes the stubbed model answer, so paid requests succeed (200). */
function modelAnswers() {
  const factoid = {
    title: "t",
    text: "c",
    type: "production",
    entities: [],
    evidenceIds: [],
    scope: "recording",
  };
  vi.mocked(llm.invoke).mockImplementation(async (_site, tier, _input, schema) => ({
    output: schema.parse({ factoids: [factoid, factoid, factoid] }),
    callId: "stub",
    mode: "replay",
    tier,
    deployment: "stub",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      usdEst: 0,
      multiplier: 1,
      latencyMs: 1,
      attempts: 1,
    },
  }));
}

const DECRYPT = { trackId: "t1", trackTitle: "Midnight City", trackArtist: "M83" };

/** The `data:` messages of an event-stream response. */
function messages(res: request.Response): Array<Record<string, unknown>> {
  return res.text
    .split("\n\n")
    .filter((part) => part.startsWith("data: "))
    .map((part) => JSON.parse(part.slice(6)));
}

/** No stack frames or absolute paths in a response body. */
function expectNoInternals(text: string) {
  expect(text).not.toMatch(/\bat \S+ \(|node_modules|\/home\/|\/app\/|<pre>|SyntaxError/);
}

describe("malformed factoids body (acceptance 1)", () => {
  // The second body passes the required-field check that used to come first, so it reached
  // `existingFactoidIds.join` outside any try.
  it.each([
    { existingFactoidIds: "not-an-array" },
    { trackId: "x", trackTitle: "y", existingFactoidIds: "not-an-array" },
  ])("answers 400 to %j and the app keeps serving", async (body) => {
    const server = app();

    const res = await request(server).post("/api/factoids/more").send(body).timeout(2000);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_input");

    const health = await request(server).get("/api/health").timeout(2000);
    expect(health.status).toBe(200);
  });
});

describe("error handling", () => {
  it("answers malformed JSON with a JSON 400 and no stack trace", async () => {
    const res = await request(app())
      .post("/api/analyze")
      .set("Content-Type", "application/json")
      .send("{bad");

    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toContain("application/json");
    expect(res.body).toEqual({
      success: false,
      code: "invalid_json",
      error: "The request body is not valid JSON.",
    });
    expectNoInternals(res.text);
  });

  it("answers a body over 16 kB with a JSON 413", async () => {
    const res = await request(app())
      .post("/api/factoids/more")
      .send({ trackTitle: "a".repeat(17 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ success: false, code: "payload_too_large" });
  });

  it("accepts a body just under the limit", async () => {
    const res = await request(app())
      .post("/api/factoids/more")
      .send({ padding: "a".repeat(15 * 1024) });

    expect(res.status).toBe(400); // reaches validation
    expect(res.body.code).toBe("invalid_input");
  });

  it("answers a thrown error with a generic JSON 500", async () => {
    const router = Router();
    router.get("/api/throws", () => {
      throw new Error("secret detail at /home/user/app/src/x.ts");
    });
    router.get(
      "/api/rejects",
      asyncRoute(async () => {
        throw new Error("secret detail at /home/user/app/src/y.ts");
      }),
    );
    const server = createApp({ http: settings(), routers: [router] });

    for (const path of ["/api/throws", "/api/rejects"]) {
      const res = await request(server).get(path).timeout(2000);
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        success: false,
        code: "internal_error",
        error: "Something went wrong. Please try again.",
      });
      expect(res.text).not.toContain("secret");
    }
  });

  it("handles a rejected promise once, from a wrapped or a plain async handler", async () => {
    const router = Router();
    router.get(
      "/api/wrapped",
      asyncRoute(async () => {
        throw new Error("wrapped");
      }),
    );
    router.get("/api/plain", async () => {
      throw new Error("plain");
    });
    const server = createApp({ http: settings(), routers: [router] });

    for (const path of ["/api/wrapped", "/api/plain"]) {
      logs.clear();
      const res = await request(server).get(path).timeout(2000);
      expect(res.status).toBe(500);
      expect(res.body.code).toBe("internal_error");
      expect(logsAt("error")).toHaveLength(1);
    }
  });

  it("ends a response that had already started when the error came", async () => {
    const router = Router();
    router.get("/api/partial", (_req, res, next) => {
      res.write("partial");
      next(new Error("failed half way"));
    });
    const server = createApp({ http: settings(), routers: [router] });

    const res = await request(server).get("/api/partial").timeout(2000);
    expect(res.status).toBe(200);
    expect(res.text).toBe("partial");
  });

  it("logs a request body the client abandoned, and answers nothing", async () => {
    const server = createApp({ http: settings() }).listen(0, "127.0.0.1");
    await new Promise((resolve) => server.once("listening", resolve));
    const { port } = server.address() as { port: number };
    try {
      const socket = connect(port, "127.0.0.1");
      await new Promise((resolve) => socket.once("connect", resolve));
      socket.write(
        "POST /api/analyze HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\n" +
          "Content-Length: 100\r\n\r\n{",
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      socket.destroy();

      const warned = () =>
        logsAt("warn").some((entry) =>
          String(entry.msg).includes("client aborted the request body"),
        );
      for (let i = 0; i < 100 && !warned(); i++) await new Promise((r) => setTimeout(r, 10));
      expect(warned()).toBe(true);
      expect(logsAt("error")).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("answers an unknown route with a JSON 404", async () => {
    const res = await request(app()).get("/api/nope");

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ success: false, code: "not_found" });
  });

  it("does not advertise the framework", async () => {
    const res = await request(app()).get("/api/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

/** Listens on a free port and returns a raw POST helper: node:http sends the body byte for byte. */
async function listen(server: express.Express) {
  const http = server.listen(0, "127.0.0.1");
  await new Promise((resolve) => http.once("listening", resolve));
  const { port } = http.address() as { port: number };
  const post = (path: string, headers: Record<string, string | number>, body: Buffer) =>
    new Promise<{ status?: number; code?: string }>((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, method: "POST", path, headers }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode, code: JSON.parse(text).code }));
      });
      req.on("error", reject);
      req.end(body);
    });
  const close = async () => {
    http.closeAllConnections();
    await new Promise((resolve) => http.close(resolve));
  };
  return { post, close };
}

describe("content encodings", () => {
  const postEncoded = (
    post: Awaited<ReturnType<typeof listen>>["post"],
    encoding: string,
    body: Buffer,
    path = "/api/factoids/more",
  ) =>
    post(
      path,
      {
        "Content-Type": "application/json",
        "Content-Encoding": encoding,
        "Content-Length": body.length,
      },
      body,
    );

  it("decodes gzip and deflate bodies and applies the size limit to the decoded body", async () => {
    const { post, close } = await listen(app());
    try {
      const small = JSON.stringify({ padding: "a" });
      for (const [encoding, body] of [
        ["gzip", gzipSync(small)],
        ["deflate", deflateSync(small)],
        ["identity", Buffer.from(small)],
      ] as const) {
        expect(await postEncoded(post, encoding, body)).toEqual({
          status: 400,
          code: "invalid_input",
        });
      }

      // Under 1 kB on the wire, 64 kB once decoded.
      const large = gzipSync(JSON.stringify({ padding: "a".repeat(64 * 1024) }));
      expect(large.length).toBeLessThan(1024);
      expect(await postEncoded(post, "gzip", large)).toEqual({
        status: 413,
        code: "payload_too_large",
      });
      expect(await postEncoded(post, "gzip", Buffer.from(small))).toEqual({
        status: 400,
        code: "bad_request",
      });
    } finally {
      await close();
    }
  });

  it("refuses brotli, several codings and unknown codings with 415", async () => {
    const { post, close } = await listen(app());
    try {
      const body = brotliCompressSync(JSON.stringify({ padding: "a" }));
      for (const encoding of [
        "br",
        "BR",
        " br ",
        "gzip, br",
        "gzip, deflate",
        "compress",
        "x-gzip",
      ]) {
        expect(await postEncoded(post, encoding, body), encoding).toEqual({
          status: 415,
          code: "unsupported_media_type",
        });
      }
      // A chunked body (no Content-Length) is refused the same way.
      expect(
        await post(
          "/api/factoids/more",
          {
            "Content-Type": "application/json",
            "Content-Encoding": "br",
            "Transfer-Encoding": "chunked",
          },
          body,
        ),
      ).toEqual({ status: 415, code: "unsupported_media_type" });
      // An empty header means identity: the body reaches validation.
      const plain = Buffer.from(JSON.stringify({ padding: "a" }));
      expect(await postEncoded(post, "", plain)).toEqual({ status: 400, code: "invalid_input" });
      // A request without a body passes, whatever it says about the body's encoding.
      const health = await request(app()).get("/api/health").set("Content-Encoding", "br");
      expect(health.status).toBe(200);
    } finally {
      await close();
    }
  });

  it("does not decode brotli: 50 bodies of 71 bytes that need a 16 MB window each use no memory", async () => {
    const raw = Buffer.concat([
      Buffer.from('{"padding":"'),
      Buffer.alloc(64 * 1024 * 1024, 0x61),
      Buffer.from('"}'),
    ]);
    const bomb = brotliCompressSync(raw, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 5,
        [zlibConstants.BROTLI_PARAM_LGWIN]: 24,
        [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length,
      },
    });
    expect(bomb.length).toBeLessThan(100);

    const { post, close } = await listen(app());
    try {
      // Any path parses JSON bodies; this one has no rate limit. Warm it up first, so the
      // measurement only sees the bodies.
      await postEncoded(post, "br", bomb, "/api/nope");
      const before = process.memoryUsage().rss;
      let peak = before;
      const sample = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 1);
      const results = await Promise.all(
        Array.from({ length: 50 }, () => postEncoded(post, "br", bomb, "/api/nope")),
      );
      clearInterval(sample);
      peak = Math.max(peak, process.memoryUsage().rss);

      expect(new Set(results.map((r) => r.status))).toEqual(new Set([415]));
      // Decoding them would take about 50 x 16 MB.
      expect((peak - before) / 2 ** 20).toBeLessThan(32);
    } finally {
      await close();
    }
  });
});

describe("requests without a JSON body", () => {
  // Express 5 leaves req.body undefined when nothing was parsed: no body, or another type.
  const bodies: Array<[string, string | undefined, string | undefined]> = [
    ["no body", undefined, undefined],
    ["a text/plain body", "text/plain", "Midnight City M83"],
    [
      "a JSON body under another media type",
      "application/vnd.api+json",
      '{"query":"x","threadId":"a","selectedTrackId":"b"}',
    ],
  ];

  it.each(
    ["/api/analyze", "/api/analyze/resume"].flatMap((path) =>
      bodies.map(([label, type, body]) => [path, label, type, body] as const),
    ),
  )("POST %s with %s answers 400 invalid_input", async (path, _label, type, body) => {
    let req = request(app()).post(path).timeout(2000);
    if (type) req = req.set("Content-Type", type);
    const res = await (body === undefined ? req : req.send(body));

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: "invalid_input" });
  });
});

describe("CORS", () => {
  it("allows a listed origin, without credentials", async () => {
    const res = await request(app()).get("/api/health").set("Origin", LISTED);

    expect(res.headers["access-control-allow-origin"]).toBe(LISTED);
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers.vary).toMatch(/\bOrigin\b/);
  });

  it("sends no CORS headers to an unlisted origin, and still varies on Origin", async () => {
    const res = await request(app()).get("/api/health").set("Origin", "https://evil.example");

    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers.vary).toMatch(/\bOrigin\b/);
  });

  it("varies on Origin when there is none", async () => {
    const res = await request(app()).get("/api/health");
    expect(res.headers.vary).toMatch(/\bOrigin\b/);
  });

  it("answers a preflight from a listed origin", async () => {
    const res = await request(app())
      .options("/api/factoids/more")
      .set("Origin", LISTED)
      .set("Access-Control-Request-Method", "POST")
      .set("Access-Control-Request-Headers", "content-type");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe(LISTED);
    expect(res.headers["access-control-allow-methods"]).toContain("POST");
    expect(res.headers["access-control-allow-headers"]?.toLowerCase()).toContain("content-type");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
  });

  it("answers a preflight from an unlisted origin without allowing it", async () => {
    const res = await request(app())
      .options("/api/factoids/more")
      .set("Origin", "https://evil.example")
      .set("Access-Control-Request-Method", "POST");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-methods"]).toBeUndefined();
  });
});

describe("rate limits", () => {
  const limited = { rateLimit: { windowMs: 60_000, max: 3 } };

  it("answers 429 with JSON and Retry-After once a client passes the limit", async () => {
    const server = app(limited);
    const statuses: number[] = [];
    let last: request.Response | undefined;
    for (let i = 0; i < 5; i++) {
      last = await request(server).post("/api/factoids/more").send({});
      statuses.push(last.status);
    }

    expect(statuses).toEqual([400, 400, 400, 429, 429]);
    expect(last?.body).toEqual({
      success: false,
      code: "rate_limited",
      error: "Too many requests. Please try again later.",
    });
    expect(Number(last?.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("counts the analysis routes and the factoid stream in the same limit", async () => {
    const server = app(limited);
    await request(server).post("/api/analyze").send({});
    await request(server).get("/api/analyze/stream");
    await request(server).post("/api/analyze/resume").send({});

    const stream = await request(server).get("/api/factoids/more/stream?trackTitle=x");
    const resume = await request(server).get("/api/analyze/stream/resume");
    // Typed events (see sse.ts): a factoid stream has no analysis run; a refused analysis
    // stream gets a run id of its own.
    for (const [res, runId] of [
      [stream, null],
      [resume, expect.any(String)],
    ] as const) {
      expect(messages(res)).toEqual([
        {
          type: "error",
          runId,
          seq: 0,
          code: "rate_limited",
          error: "Too many requests. Please try again later.",
        },
        { type: "done", runId, seq: 1, timestamp: expect.any(String) },
      ]);
    }
  });

  it("refuses an event-stream request in the stream with 200, a JSON one with 429", async () => {
    const server = app({ rateLimit: { windowMs: 60_000, max: 1 } });
    await request(server).post("/api/factoids/more").send({});

    const stream = await request(server).get("/api/factoids/more/stream?trackTitle=x");
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(messages(stream).map((m) => [m.type, m.code])).toEqual([
      ["error", "rate_limited"],
      ["done", undefined],
    ]);

    // A request for an event stream (an EventSource sends this Accept header) on any route.
    const accepting = await request(server)
      .get("/api/factoids/more")
      .set("Accept", "text/event-stream");
    expect(accepting.status).toBe(200);
    expect(messages(accepting)[0]).toMatchObject({ type: "error", code: "rate_limited" });

    const json = await request(server).post("/api/factoids/more").send({});
    expect(json.status).toBe(429);
    expect(Number(json.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("refuses on the factoid routes' old paths as on the new ones", async () => {
    const server = app({ rateLimit: { windowMs: 60_000, max: 1 } });
    await request(server).post("/api/factoids/more").send({});

    const answers = [];
    for (const path of ["/api/factoids/more", "/api/factoids/decrypt"]) {
      const stream = await request(server).get(`${path}/stream?trackTitle=x`);
      const json = await request(server).post(path).send({});
      answers.push({
        stream: [
          stream.status,
          stream.headers["content-type"],
          messages(stream).map((m) => m.code),
        ],
        json: [json.status, json.body],
      });
    }
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[0]).toEqual({
      stream: [200, expect.stringContaining("text/event-stream"), ["rate_limited", undefined]],
      json: [429, expect.objectContaining({ code: "rate_limited" })],
    });
  });

  it("counts requests whose JSON is invalid: the limit runs before the body is parsed", async () => {
    const server = app({ rateLimit: { windowMs: 60_000, max: 2 } });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const res = await request(server)
        .post("/api/factoids/more")
        .set("Content-Type", "application/json")
        .send("{bad");
      statuses.push(res.status);
    }
    expect(statuses).toEqual([400, 400, 429]);
  });

  it("caps the paid routes across all clients, counting only requests that did not fail", async () => {
    modelAnswers();
    const server = app({
      trustProxy: 1,
      rateLimit: { windowMs: 60_000, max: 100 },
      globalRateLimit: { windowMs: 60_000, max: 3 },
    });
    const from = (i: number) => ({ "X-Forwarded-For": `203.0.113.${i + 1}` });

    // Invalid requests (JSON and in-stream) from many addresses use none of the shared budget.
    for (let i = 0; i < 10; i++) {
      expect((await request(server).post("/api/analyze").set(from(i)).send({})).status).toBe(400);
      const stream = await request(server).get("/api/factoids/more/stream").set(from(i));
      expect(messages(stream)[0]).toMatchObject({ code: "invalid_input" });
    }

    const statuses = [];
    for (let i = 0; i < 5; i++) {
      const res = await request(server).post("/api/factoids/more").set(from(i)).send(DECRYPT);
      statuses.push(res.status);
    }
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    // Health and search are outside the shared cap.
    expect((await request(server).get("/api/health")).status).toBe(200);
    expect((await request(server).get("/api/search/suggest?query=a")).status).toBe(400);
  });

  it("leaves the shared budget alone for a client past its own limit", async () => {
    modelAnswers();
    const server = app({
      trustProxy: 1,
      rateLimit: { windowMs: 60_000, max: 2 },
      globalRateLimit: { windowMs: 60_000, max: 3 },
    });
    const send = (ip: string) =>
      request(server).post("/api/factoids/more").set("X-Forwarded-For", ip).send(DECRYPT);

    const greedy = [];
    for (let i = 0; i < 6; i++) greedy.push((await send("203.0.113.1")).status);
    expect(greedy).toEqual([200, 200, 429, 429, 429, 429]);

    expect((await send("203.0.113.2")).status).toBe(200);
    expect((await send("203.0.113.3")).status).toBe(429);
  });

  it("limits search separately and never limits health", async () => {
    const server = app({ ...limited, searchRateLimit: { windowMs: 60_000, max: 2 } });
    const search = [];
    for (let i = 0; i < 3; i++) {
      search.push((await request(server).get("/api/search/suggest?query=a")).status);
    }
    expect(search).toEqual([400, 400, 429]);

    for (let i = 0; i < 5; i++) {
      expect((await request(server).get("/api/health")).status).toBe(200);
    }
    expect((await request(server).post("/api/factoids/more").send({})).status).toBe(400);
  });

  it("limits readiness per address, on a counter of its own", async () => {
    // Replay-only: the readiness checks ask no audio service.
    const replayMode = process.env.REPLAY_MODE;
    process.env.REPLAY_MODE = "only";
    try {
      const server = app({ ...limited, searchRateLimit: { windowMs: 60_000, max: 2 } });
      const ready = [];
      for (let i = 0; i < 3; i++) ready.push((await request(server).get("/api/ready")).status);
      expect(ready[0]).not.toBe(429);
      expect(ready[1]).not.toBe(429);
      expect(ready[2]).toBe(429);
      // Search and health are counted apart.
      expect((await request(server).get("/api/search/suggest?query=a")).status).toBe(400);
      expect((await request(server).get("/api/health")).status).toBe(200);
    } finally {
      if (replayMode === undefined) delete process.env.REPLAY_MODE;
      else process.env.REPLAY_MODE = replayMode;
    }
  });

  it("keys on the client address from X-Forwarded-For only behind a trusted proxy", async () => {
    const behindProxy = app({ ...limited, trustProxy: 1 });
    const from = (ip: string) =>
      request(behindProxy).post("/api/factoids/more").set("X-Forwarded-For", ip).send({});
    for (let i = 0; i < 3; i++) await from("203.0.113.1");
    expect((await from("203.0.113.1")).status).toBe(429);
    expect((await from("203.0.113.2")).status).toBe(400);

    // Without a trusted proxy the header is ignored: a client cannot pick a fresh key.
    const direct = app(limited);
    const spoofed = (ip: string) =>
      request(direct).post("/api/factoids/more").set("X-Forwarded-For", ip).send({});
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await spoofed(`203.0.113.${i + 10}`)).status);
    expect(statuses).toEqual([400, 400, 400, 429]);
  });

  it("lets a listed origin read the 429", async () => {
    const server = app({ rateLimit: { windowMs: 60_000, max: 1 } });
    await request(server).post("/api/factoids/more").send({});
    const res = await request(server).post("/api/factoids/more").set("Origin", LISTED).send({});

    expect(res.status).toBe(429);
    expect(res.headers["access-control-allow-origin"]).toBe(LISTED);
  });
});

describe("requests other sites make a browser send", () => {
  const EVIL = "https://evil.example";

  it("refuses a paid JSON route with 403 when the Origin is not listed", async () => {
    for (const send of [
      (server: ReturnType<typeof app>) =>
        request(server).post("/api/factoids/more").set("Origin", EVIL).send({}),
      (server: ReturnType<typeof app>) =>
        request(server).post("/api/analyze").set("Origin", "null").send({ query: "x" }),
      (server: ReturnType<typeof app>) =>
        request(server).get("/api/search/suggest?query=midnight").set("Origin", EVIL),
    ]) {
      const res = await send(app());
      expect(res.status).toBe(403);
      expect(res.body).toEqual({
        success: false,
        code: "forbidden_origin",
        error: "Requests from this site are not allowed.",
      });
    }
  });

  it("refuses a paid event stream in the stream when the Origin is not listed", async () => {
    for (const path of [
      "/api/factoids/more/stream?trackTitle=Midnight+City",
      "/api/analyze/stream?query=Midnight+City",
      "/API/Analyze/Stream/Resume/?threadId=a&selectedTrackId=b",
    ]) {
      const res = await request(app()).get(path).set("Origin", EVIL);
      expect(res.status).toBe(200);
      expect(messages(res).map((m) => [m.type, m.code])).toEqual([
        ["error", "forbidden_origin"],
        ["done", undefined],
      ]);
    }
  });

  it("refuses a same-site request with no Origin (another page on localhost, any port)", async () => {
    const res = await request(app())
      .get("/api/factoids/more/stream?trackTitle=Midnight+City")
      .set("Sec-Fetch-Site", "same-site");
    expect(messages(res)[0]).toMatchObject({ type: "error", code: "forbidden_origin" });

    const typed = await request(app())
      .get("/api/search/suggest?query=a")
      .set("Sec-Fetch-Site", "none"); // typed into the address bar
    expect(typed.status).toBe(400);
  });

  it("logs a refusal once per origin per minute", async () => {
    let clock = 0;
    const guarded = express();
    guarded.use(listedOriginsOnly([LISTED], () => clock));
    const warnings = () => logsAt("warn").length;

    for (let i = 0; i < 5; i++) {
      await request(guarded).get("/api/search/suggest").set("Origin", "https://evil.example");
    }
    expect(warnings()).toBe(1);
    await request(guarded).get("/api/search/suggest").set("Origin", "https://other.example");
    expect(warnings()).toBe(2);

    clock = 61_000;
    await request(guarded).get("/api/search/suggest").set("Origin", "https://evil.example");
    expect(warnings()).toBe(3);
  });

  it("measures the refusal log's minute on the monotonic clock, whatever the wall clock does", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const guarded = express();
    guarded.use(listedOriginsOnly([LISTED]));
    const warnings = () => logsAt("warn").length;
    const refused = () =>
      request(guarded).get("/api/search/suggest").set("Origin", "https://evil.example");

    await refused();
    expect(warnings()).toBe(1);
    // A step back does not mute the next refusal past its minute...
    vi.setSystemTime(Date.now() - 60 * 60_000);
    vi.advanceTimersByTime(61_000);
    await refused();
    expect(warnings()).toBe(2);
    // ...nor does a step forward log it sooner.
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
    await refused();
    expect(warnings()).toBe(2);
  });

  it("refuses a cross-site request with no Origin (an <img> or a no-cors GET)", async () => {
    const stream = await request(app())
      .get("/api/factoids/more/stream?trackTitle=Midnight+City")
      .set("Sec-Fetch-Site", "cross-site");
    expect(messages(stream)[0]).toMatchObject({ type: "error", code: "forbidden_origin" });

    const search = await request(app())
      .get("/api/search/suggest?query=midnight")
      .set("Sec-Fetch-Site", "cross-site");
    expect(search.status).toBe(403);
  });

  it("lets the web app's own requests through", async () => {
    // Cross-origin fetch or EventSource from the listed web origin (a different port).
    const listed = await request(app())
      .post("/api/factoids/more")
      .set("Origin", LISTED)
      .set("Sec-Fetch-Site", "same-site")
      .send({});
    expect(listed.status).toBe(400); // reached validation
    // The listed origin on another site (a deployment with the API on its own domain).
    const otherSite = await request(app())
      .get("/api/analyze/stream")
      .set("Origin", LISTED)
      .set("Sec-Fetch-Site", "cross-site");
    expect(messages(otherSite)[0]).toMatchObject({ code: "invalid_input" });
    // Same-origin GET behind a proxy: no Origin.
    const sameOrigin = await request(app())
      .get("/api/search/suggest?query=a")
      .set("Sec-Fetch-Site", "same-origin");
    expect(sameOrigin.status).toBe(400);
  });

  it("lets requests with neither header through (curl, server to server)", async () => {
    const res = await request(app()).post("/api/factoids/more").send({});
    expect(res.status).toBe(400);
  });

  it("does not guard health, and refused requests use no rate-limit budget", async () => {
    const server = app({ rateLimit: { windowMs: 60_000, max: 1 } });
    expect((await request(server).get("/api/health").set("Origin", EVIL)).status).toBe(200);
    for (let i = 0; i < 3; i++) {
      await request(server).post("/api/factoids/more").set("Origin", EVIL).send({});
    }
    expect((await request(server).post("/api/factoids/more").send({})).status).toBe(400);
  });
});

describe("error messages", () => {
  it("are the same on every route for the same code", async () => {
    const analyze = await request(app()).post("/api/analyze").send({});
    const factoids = await request(app()).post("/api/factoids/more").send({});
    expect(analyze.body.code).toBe("invalid_input");
    expect(analyze.body.error).toBe(factoids.body.error);

    const stream = await request(app()).get("/api/analyze/stream");
    expect(messages(stream)[0]).toMatchObject({
      code: "invalid_input",
      error: factoids.body.error,
    });
  });
});

describe("OPTIONS and exposed headers", () => {
  it("answers an OPTIONS request that is not a preflight with 204 and Allow", async () => {
    const res = await request(app()).options("/api/health");
    expect(res.status).toBe(204);
    expect(res.headers.allow).toBe("GET, POST, OPTIONS");
    expect(res.text).toBe("");
  });

  it("lets only a listed origin read the rate-limit headers", async () => {
    const listed = await request(app()).get("/api/health").set("Origin", LISTED);
    expect(listed.headers["access-control-expose-headers"]).toBe(
      "RateLimit, RateLimit-Policy, Retry-After",
    );
    const other = await request(app()).get("/api/health").set("Origin", "https://evil.example");
    expect(other.headers["access-control-expose-headers"]).toBeUndefined();
  });
});

describe("logging", () => {
  /** The message of the first warning that contains `marker`. */
  const logged = (marker: string) =>
    logsAt("warn")
      .map((entry) => String(entry.msg))
      .find((line) => line.includes(marker));

  it("keeps a client's text from breaking the log line", async () => {
    // The parser's message quotes the start of the body, line breaks included.
    await request(app())
      .post("/api/analyze")
      .set("Content-Type", "application/json")
      .send('{"a": bad\n[Server] forged line\n}');

    const line = logged("invalid_json");
    expect(line).toContain("[Serve");
    expect(line).not.toMatch(/[\n\r]/);
  });

  it("caps a client's text in the log", async () => {
    const origin = `https://${"a".repeat(1000)}.example`;
    await request(app()).post("/api/factoids/more").set("Origin", origin).send({});

    const line = logged("refused origin");
    expect(line).toBeDefined();
    expect(line?.length).toBeLessThan(300);
  });
});
