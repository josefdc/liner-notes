/**
 * Run tokens: how they are issued (POST /api/runs, behind Turnstile), what they say and how they
 * are checked (http/runToken.ts), and the routes that require one (middleware/requireRunToken.ts)
 * on the app createApp builds. Turnstile is stubbed: no test calls Cloudflare. The analyses here
 * are replays of the committed recordings (REPLAY_MODE=only), so nothing live runs.
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeSseStream, AnalyzeStreamEvent, RunTokenResponse } from "@liner-notes/contract";
import request from "supertest";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RATE_LIMIT,
  DEFAULT_SEARCH_RATE_LIMIT,
  type HttpSettings,
  type RunTokenSettings,
} from "../config/settings.js";
import { type CapturedLogs, captureLogsForTests } from "../logger.js";
import { setReplayPacingForTests } from "../replay/player.js";
import { closeDatabase, getDb, initializeDatabase } from "../store/database.js";
import { getRun, runExists } from "../store/runs.js";
import { createApp } from "./app.js";
import {
  createRunTokens,
  RUN_TOKEN_START_WINDOW_MS,
  RUN_TOKEN_TTL_MS,
  type RunTokens,
  runTokensFor,
} from "./runToken.js";
import { TEST_TURNSTILE_TOKEN, testTurnstile } from "./testApp.js";
import {
  bypassTurnstileVerifier,
  createTurnstileVerifier,
  DEV_BYPASS_TOKEN,
  TURNSTILE_VERIFY_URL,
  type TurnstileVerifier,
  turnstileVerifierFor,
} from "./turnstile.js";

// The runs store as it is; a test can make runExists lag behind a run being started.
vi.mock("../store/runs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../store/runs.js")>();
  return { ...actual, runExists: vi.fn(actual.runExists) };
});

const KEY = Buffer.alloc(32, "run-token-test-key");
const LISTED = "http://localhost:3110";
const SHOWCASE = "One More Time Daft Punk";
const SPOTIFY_ID = "0DiWol3AO6WpXZgp0goxAV";

const http: HttpSettings = {
  corsOrigins: [LISTED],
  trustProxy: 0,
  rateLimit: { ...DEFAULT_RATE_LIMIT, max: 10_000 },
  globalRateLimit: { windowMs: DEFAULT_RATE_LIMIT.windowMs, max: 10_000 },
  searchRateLimit: DEFAULT_SEARCH_RATE_LIMIT,
};

/** A clock the tests move by hand. */
let now = Date.UTC(2026, 9, 27, 12);
const clock = () => now;

/** The app as the API builds it, with tokens on the test clock and a stubbed Turnstile. */
function appWith(
  tokens: RunTokens = createRunTokens(KEY, clock),
  verifyTurnstile: TurnstileVerifier = testTurnstile,
  overrides: Partial<HttpSettings> = {},
) {
  return createApp({ http: { ...http, ...overrides }, runTokens: tokens, verifyTurnstile });
}

const tokens = createRunTokens(KEY, clock);
const app = appWith(tokens);

const withToken = (path: string, token: string) =>
  `${path}${path.includes("?") ? "&" : "?"}runToken=${encodeURIComponent(token)}`;
const streamPath = (query = SHOWCASE) => `/api/analyze/stream?query=${encodeURIComponent(query)}`;
const resumePath = (threadId: string) =>
  `/api/analyze/stream/resume?threadId=${threadId}&selectedTrackId=${SPOTIFY_ID}`;

/** A GET of an event stream, read to its end. */
async function sse(
  target: ReturnType<typeof appWith>,
  path: string,
  headers: Record<string, string> = {},
) {
  const res = await request(target)
    .get(path)
    .set(headers)
    .buffer(true)
    .parse((response, callback) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => callback(null, body));
    });
  const body = typeof res.body === "string" ? res.body : "";
  return { res, body, events: decodeSseStream(body, AnalyzeStreamEvent) };
}

const runCount = () => getDb().prepare("SELECT COUNT(*) FROM runs").pluck().get() as number;

/** A refusal for the token: a real 401 with the JSON error, never a stream. */
function expectUnauthorized(res: request.Response) {
  expect(res.status).toBe(401);
  expect(res.headers["content-type"]).toContain("application/json");
  expect(res.body).toEqual({
    success: false,
    code: "auth_expired",
    error: expect.any(String),
  });
}

let dir: string;
let logs: CapturedLogs;
let restorePacing: () => void;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "run-token-"));
  initializeDatabase(join(dir, "test.db"));
  restorePacing = setReplayPacingForTests({ speed: 1000, maxGapMs: 1 });
});
afterAll(() => {
  restorePacing();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  now = Date.UTC(2026, 9, 27, 12);
  vi.stubEnv("REPLAY_MODE", "only");
  logs = captureLogsForTests();
});
afterEach(() => {
  logs.restore();
  vi.unstubAllEnvs();
});

// =============================================================================
// The token
// =============================================================================

describe("a run token", () => {
  it("names its thread, scope and times, signed, and verifies", () => {
    const { runToken, claims } = tokens.mint();
    const [version, payload, signature] = runToken.split(".");
    expect(version).toBe("v1");
    expect(signature).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))).toEqual({
      t: claims.threadId,
      s: "run",
      i: now,
      e: now + RUN_TOKEN_TTL_MS,
    });
    expect(claims.threadId).toMatch(/^[0-9a-f-]{36}$/);
    expect(tokens.verify(runToken)).toEqual({ ok: true, claims });
    // Each token names a run of its own.
    expect(tokens.mint().claims.threadId).not.toBe(claims.threadId);
  });

  it("is refused when anything in it is changed, or another key signed it", () => {
    const { runToken } = tokens.mint("thread-a");
    const [version, payload, signature] = runToken.split(".");
    const other = (claims: object) => Buffer.from(JSON.stringify(claims)).toString("base64url");
    const lastChar = signature.at(-1) === "A" ? "B" : "A";
    for (const forged of [
      `${version}.${payload}.${signature.slice(0, -1)}${lastChar}`,
      `${version}.${other({ t: "thread-b", s: "run", i: now, e: now + RUN_TOKEN_TTL_MS })}.${signature}`,
      `${version}.${other({ t: "thread-a", s: "run", i: now, e: now + 10 * RUN_TOKEN_TTL_MS })}.${signature}`,
      `v2.${payload}.${signature}`,
      `${version}.${payload}`,
      `${version}.${payload}.${signature}.x`,
      `${version}.${payload}.`,
      createRunTokens(Buffer.alloc(32, "another-key")).mint("thread-a").runToken,
      "",
      "x".repeat(10_000),
    ]) {
      expect(tokens.verify(forged), forged.slice(0, 80)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("expires 30 minutes after it was issued", () => {
    const { runToken, claims } = tokens.mint();
    now += RUN_TOKEN_TTL_MS - 1;
    expect(tokens.verify(runToken).ok).toBe(true);
    now += 1;
    expect(tokens.verify(runToken)).toEqual({ ok: false, reason: "expired", claims });
  });

  it("is signed with RUN_TOKEN_SECRET, or a key of the process's own when it is not set", () => {
    const settings: RunTokenSettings = {
      secret: "s".repeat(48),
      turnstileSecret: null,
      expectedHostname: null,
      bypass: true,
    };
    const { runToken } = runTokensFor(settings).mint();
    // The same secret after a restart checks the tokens issued before it.
    expect(runTokensFor(settings).verify(runToken).ok).toBe(true);
    const ownKey = runTokensFor({ ...settings, secret: null });
    expect(ownKey.verify(ownKey.mint().runToken).ok).toBe(true);
    expect(runTokensFor({ ...settings, secret: null }).verify(ownKey.mint().runToken).ok).toBe(
      false,
    );
    expect(() => createRunTokens(Buffer.alloc(31))).toThrow();
  });
});

// =============================================================================
// POST /api/runs
// =============================================================================

describe("POST /api/runs", () => {
  it("issues a token for a visitor who passed Turnstile", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set("Origin", LISTED)
      .send({ turnstileToken: TEST_TURNSTILE_TOKEN });

    expect(res.status).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = RunTokenResponse.parse(res.body);
    expect(body.expiresAt).toBe(new Date(now + RUN_TOKEN_TTL_MS).toISOString());
    expect(tokens.verify(body.runToken).ok).toBe(true);
  });

  it("asks Turnstile with the visitor's address, and refuses what it does not pass", async () => {
    const seen: Array<[string, string | undefined]> = [];
    const rejecting = appWith(tokens, async (token, ip) => {
      seen.push([token, ip]);
      return { ok: false, reason: "rejected" };
    });
    expectUnauthorized(await request(rejecting).post("/api/runs").send({ turnstileToken: "t-1" }));
    expect(seen).toEqual([["t-1", expect.stringMatching(/127\.0\.0\.1/)]]);

    // Turnstile could not be asked: the check fails closed.
    const unavailable = appWith(tokens, async () => ({ ok: false, reason: "unavailable" }));
    const res = await request(unavailable).post("/api/runs").send({ turnstileToken: "t-2" });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, code: "failed" });
    expect(res.body).not.toHaveProperty("runToken");
  });

  it("refuses a body that is not a RunTokenRequest, without asking Turnstile", async () => {
    const verify = vi.fn(testTurnstile);
    const target = appWith(tokens, verify);
    for (const body of [
      {},
      { turnstileToken: "" },
      { turnstileToken: 1 },
      { turnstileToken: "x".repeat(2049) },
    ]) {
      const res = await request(target).post("/api/runs").send(body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).toBe(400);
      expect(res.body).toMatchObject({ code: "invalid_input" });
    }
    expect(verify).not.toHaveBeenCalled();
  });

  it("checks the origin, then a per-IP limit, before the body is read", async () => {
    const refused = await request(app)
      .post("/api/runs")
      .set("Origin", "https://evil.example")
      .send({ turnstileToken: TEST_TURNSTILE_TOKEN });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ code: "forbidden_origin" });

    const limited = appWith(tokens, testTurnstile, { rateLimit: { windowMs: 60_000, max: 2 } });
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      const res = await request(limited)
        .post("/api/runs")
        .set("Content-Type", "application/json")
        .send(i === 0 ? "{bad" : JSON.stringify({ turnstileToken: TEST_TURNSTILE_TOKEN }));
      statuses.push(res.status);
    }
    expect(statuses).toEqual([400, 200, 429]);
    // Counted apart from the analysis's own limit.
    const analysis = await request(limited)
      .post(withToken("/api/analyze", tokens.mint().runToken))
      .send({});
    expect(analysis.status).toBe(400);
  });

  it("logs neither the body nor either token", async () => {
    const turnstileToken = "0.turnstile-token-value-1234567890";
    const issued = await request(app)
      .post("/api/runs")
      .send({ turnstileToken: TEST_TURNSTILE_TOKEN });
    const rejected = await request(app).post("/api/runs").send({ turnstileToken });
    const malformed = await request(app)
      .post("/api/runs")
      .set("Content-Type", "application/json")
      .send(`{"turnstileToken":"${turnstileToken}`);
    expect([issued.status, rejected.status, malformed.status]).toEqual([200, 401, 400]);
    // A request that carries a token, refused or accepted.
    const forged = `${issued.body.runToken.slice(0, -2)}xx`;
    await request(app).get(withToken(streamPath(), forged));
    await sse(app, withToken(streamPath(), issued.body.runToken));

    const logged = logs.lines().join("\n");
    expect(logs.lines().length).toBeGreaterThan(0);
    for (const secret of [turnstileToken, TEST_TURNSTILE_TOKEN, issued.body.runToken, forged]) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).not.toContain(issued.body.runToken.split(".")[2]);
  });
});

// =============================================================================
// The routes that require a token
// =============================================================================

/**
 * Sends `head` as it is over a raw socket (supertest always sends origin-form targets) and
 * returns everything the server answered once it closes the connection.
 */
async function rawRequest(target: ReturnType<typeof appWith>, head: string, body = "") {
  const server = target.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    return await new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1");
      let answer = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        answer += chunk;
      });
      // What came within 1.5 s, if the server keeps the connection open longer.
      const timer = setTimeout(() => socket.destroy(), 1500);
      socket.on("close", () => {
        clearTimeout(timer);
        resolve(answer);
      });
      socket.on("error", reject);
      socket.write(`${head}\r\nConnection: close\r\n\r\n${body}`);
    });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

describe("the analysis and factoid routes", () => {
  it("start one run per token when the request target is in absolute form", async () => {
    const { runToken, claims } = tokens.mint();
    const target = `http://liner.example${withToken(streamPath(), runToken)}`;
    const runs = runCount();
    const answers = [];
    for (let i = 0; i < 3; i++) {
      answers.push(await rawRequest(app, `GET ${target} HTTP/1.1\r\nHost: liner.example`));
    }
    const post = JSON.stringify({ query: SHOWCASE });
    answers.push(
      await rawRequest(
        app,
        `POST http://liner.example${withToken("/api/analyze", runToken)} HTTP/1.1\r\n` +
          `Host: liner.example\r\nContent-Type: application/json\r\nContent-Length: ${post.length}`,
        post,
      ),
    );
    const outcome = (answer: string) =>
      `${answer.split("\r\n")[0]}${answer.includes('"type":"complete"') ? " complete" : ""}`;
    expect(answers.map(outcome)).toEqual([
      "HTTP/1.1 200 OK complete",
      "HTTP/1.1 401 Unauthorized",
      "HTTP/1.1 401 Unauthorized",
      "HTTP/1.1 401 Unauthorized",
    ]);
    expect(runCount()).toBe(runs + 1);
    expect(getRun(getDb(), claims.threadId)).not.toBeNull();
  }, 20_000);

  it("refuse a request without a token with a 401, streams and JSON routes alike", async () => {
    const runs = runCount();
    for (const [method, path] of [
      ["GET", streamPath()],
      ["GET", resumePath("thread-a")],
      ["POST", "/api/analyze"],
      ["POST", "/api/analyze/resume"],
      ["GET", "/api/factoids/more/stream?trackTitle=x"],
      ["GET", "/api/factoids/decrypt/stream?trackTitle=x"],
      ["POST", "/api/factoids/more"],
      ["POST", "/api/factoids/decrypt"],
      ["GET", "/API/Factoids/More/Stream/?trackTitle=x"],
      ["GET", "/api/factoids/anything-else"],
    ] as const) {
      const req = method === "GET" ? request(app).get(path) : request(app).post(path).send({});
      const res = await req.set("Accept", "text/event-stream");
      expectUnauthorized(res);
    }
    // Repeated, it is not one token.
    const { runToken } = tokens.mint();
    expectUnauthorized(
      await request(app).get(withToken(withToken(streamPath(), runToken), runToken)),
    );
    expect(runCount()).toBe(runs);
  });

  it("refuse a forged token with a 401, and start nothing", async () => {
    const { runToken, claims } = tokens.mint();
    const forged = createRunTokens(Buffer.alloc(32, "not-the-server-key"), clock).mint(
      claims.threadId,
    ).runToken;
    for (const token of [
      forged,
      `${runToken.slice(0, -1)}${runToken.at(-1) === "A" ? "B" : "A"}`,
    ]) {
      expectUnauthorized(await request(app).get(withToken(streamPath(), token)));
      expectUnauthorized(
        await request(app).post(withToken("/api/analyze", token)).send({ query: SHOWCASE }),
      );
      expectUnauthorized(await request(app).post(withToken("/api/factoids/more", token)).send({}));
    }
    expect(getRun(getDb(), claims.threadId)).toBeNull();
  });

  it("let HEAD on the streams through without a token, and start nothing", async () => {
    const runs = runCount();
    for (const path of [
      streamPath(),
      resumePath("thread-a"),
      "/api/factoids/more/stream?trackTitle=x",
      "/api/factoids/decrypt/stream?trackTitle=x",
    ]) {
      const res = await request(app).head(path).timeout(2000);
      expect(res.status, path).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
    }
    expect(runCount()).toBe(runs);
  });

  it("start the analysis with the token's thread id, once", async () => {
    const { runToken, claims } = tokens.mint();
    const { res, events } = await sse(app, withToken(streamPath(), runToken));
    expect(res.status).toBe(200);
    expect(events.map((event) => event.type)).toContain("complete");
    expect(events.find((event) => event.type === "connected")).toMatchObject({
      threadId: claims.threadId,
    });
    expect(new Set(events.map((event) => event.runId))).toEqual(new Set([claims.threadId]));
    expect(getRun(getDb(), claims.threadId)?.status).toBe("completed");

    // Used: refused on both start routes.
    expectUnauthorized(await request(app).get(withToken(streamPath(), runToken)));
    expectUnauthorized(
      await request(app).post(withToken("/api/analyze", runToken)).send({ query: SHOWCASE }),
    );
  });

  it("start one analysis per token when two requests use it at once", async () => {
    // The store has not recorded the first run yet when the second asks: only the claim this
    // process holds can refuse it.
    vi.mocked(runExists).mockReturnValue(false);
    const { runToken, claims } = tokens.mint();
    const [a, b] = await Promise.all([
      sse(app, withToken(streamPath(), runToken)),
      request(app).post(withToken("/api/analyze", runToken)).send({ query: SHOWCASE }),
    ]);
    vi.mocked(runExists).mockRestore();
    const statuses = [a.res.status, b.status].sort();
    expect(statuses).toEqual([200, 401]);
    expect(getRun(getDb(), claims.threadId)).not.toBeNull();
    // Refused by the claim, before any run was started.
    expect(logs.messages()).toContain("Run token refused: already used");
    expect(logs.messages().some((msg) => msg.includes("the run is recorded already"))).toBe(false);
  });

  it("start no second run of a thread the store has recorded, whatever the claim says", async () => {
    const { runToken, claims } = tokens.mint();
    expect((await sse(app, withToken(streamPath(), runToken))).res.status).toBe(200);
    // Another process on the same store, whose read of the runs lags: the claim lets it pass,
    // and the run's record refuses it.
    vi.mocked(runExists).mockReturnValue(false);
    const other = () => appWith(createRunTokens(KEY, clock));
    const stream = await request(other()).get(withToken(streamPath(), runToken));
    const posted = await request(other())
      .post(withToken("/api/analyze", runToken))
      .send({ query: SHOWCASE });
    vi.mocked(runExists).mockRestore();
    expectUnauthorized(stream);
    expectUnauthorized(posted);
    expect(
      logs.messages().filter((msg) => msg.includes("the run is recorded already")),
    ).toHaveLength(2);
    expect(getRun(getDb(), claims.threadId)?.status).toBe("completed");
  });

  it("POST /api/analyze answers with the token's thread id", async () => {
    const { runToken, claims } = tokens.mint();
    const res = await request(app)
      .post(withToken("/api/analyze", runToken))
      .send({ query: SHOWCASE });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "complete", threadId: claims.threadId });
    expect(res.body.data.run.id).toBe(claims.threadId);
  });

  it("refuse a token a run already used, after a restart too", async () => {
    const { runToken, claims } = tokens.mint();
    expect((await sse(app, withToken(streamPath(), runToken))).res.status).toBe(200);
    expect(getRun(getDb(), claims.threadId)).not.toBeNull();

    // A new process: the same database file and key, nothing held in memory.
    closeDatabase();
    initializeDatabase(join(dir, "test.db"));
    const restarted = appWith(createRunTokens(KEY, clock));
    expectUnauthorized(await request(restarted).get(withToken(streamPath(), runToken)));
    expectUnauthorized(
      await request(restarted).post(withToken("/api/analyze", runToken)).send({ query: SHOWCASE }),
    );
    // A new token still starts one.
    const fresh = await sse(restarted, withToken(streamPath(), tokens.mint().runToken));
    expect(fresh.events.map((event) => event.type)).toContain("complete");
  });

  it("refuse a resume with another run's token, and pass the run's own", async () => {
    const own = tokens.mint("thread-own").runToken;
    const other = tokens.mint("thread-other").runToken;

    expectUnauthorized(await request(app).get(withToken(resumePath("thread-own"), other)));
    expectUnauthorized(
      await request(app)
        .post(withToken("/api/analyze/resume", other))
        .send({ threadId: "thread-own", selectedTrackId: SPOTIFY_ID }),
    );

    // The run's own token reaches the route, which refuses the resume for its own reason
    // (nothing live runs here).
    const { res, events } = await sse(app, withToken(resumePath("thread-own"), own));
    expect(res.status).toBe(200);
    expect(events.map((event) => (event.type === "error" ? event.code : event.type))).toEqual([
      "live_disabled",
      "done",
    ]);
    const posted = await request(app)
      .post(withToken("/api/analyze/resume", own))
      .send({ threadId: "thread-own", selectedTrackId: SPOTIFY_ID });
    expect(posted.status).toBe(503);
    expect(posted.body).toMatchObject({ code: "live_disabled" });
  });

  it("take any valid token for factoids, a used one included", async () => {
    const { runToken } = tokens.mint();
    await sse(app, withToken(streamPath(), runToken));
    const another = tokens.mint("some-other-run").runToken;
    for (const token of [runToken, another]) {
      for (const path of ["/api/factoids/more", "/api/factoids/decrypt"]) {
        const res = await request(app).post(withToken(path, token)).send({});
        // Past the token check: the body is what is refused.
        expect(res.status, path).toBe(400);
        expect(res.body).toMatchObject({ code: "invalid_input" });
      }
      for (const path of ["/api/factoids/more/stream", "/api/factoids/decrypt/stream"]) {
        const { res, body } = await sse(app, withToken(`${path}?trackTitle=`, token));
        expect(res.status, path).toBe(200);
        expect(body).toContain('"code":"invalid_input"');
      }
    }
  });

  it("refuse an expired token inside the stream, and with a 401 on a JSON route", async () => {
    const { runToken, claims } = tokens.mint("thread-late");
    now += RUN_TOKEN_TTL_MS;

    for (const path of [
      streamPath(),
      resumePath("thread-late"),
      "/api/factoids/more/stream?trackTitle=x",
    ]) {
      const { res, body, events } = await sse(app, withToken(path, runToken));
      expect(res.status, path).toBe(200);
      expect(res.headers["content-type"]).toContain("text/event-stream");
      expect(body).toContain('"code":"auth_expired"');
      if (path.startsWith("/api/analyze")) {
        expect(events.map((event) => (event.type === "error" ? event.code : event.type))).toEqual([
          "auth_expired",
          "done",
        ]);
      }
    }
    for (const path of ["/api/analyze", "/api/analyze/resume", "/api/factoids/more"]) {
      expectUnauthorized(
        await request(app)
          .post(withToken(path, runToken))
          .send({ query: SHOWCASE, threadId: "thread-late", selectedTrackId: SPOTIFY_ID }),
      );
    }
    expect(getRun(getDb(), claims.threadId)).toBeNull();
  });

  it("start a run only within 5 minutes of the token; resumes and factoids take it longer", async () => {
    const { runToken, claims } = tokens.mint();
    now += RUN_TOKEN_START_WINDOW_MS + 1;

    const { res, events } = await sse(app, withToken(streamPath(), runToken));
    expect(res.status).toBe(200);
    expect(events.map((event) => (event.type === "error" ? event.code : event.type))).toEqual([
      "auth_expired",
      "done",
    ]);
    expectUnauthorized(
      await request(app).post(withToken("/api/analyze", runToken)).send({ query: SHOWCASE }),
    );
    expect(getRun(getDb(), claims.threadId)).toBeNull();

    const factoids = await request(app).post(withToken("/api/factoids/more", runToken)).send({});
    expect(factoids.status).toBe(400);
    const resume = await sse(app, withToken(resumePath(claims.threadId), runToken));
    expect(
      resume.events.map((event) => (event.type === "error" ? event.code : event.type)),
    ).toEqual(["live_disabled", "done"]);
  });

  it("count a request without a valid token against its own address only", async () => {
    const limited = appWith(tokens, testTurnstile, {
      trustProxy: 1,
      rateLimit: { windowMs: 60_000, max: 2 },
      globalRateLimit: { windowMs: 60_000, max: 1 },
    });
    const from = (ip: string) => ({ "X-Forwarded-For": ip });
    expectUnauthorized(await request(limited).get(streamPath()).set(from("203.0.113.1")));
    expectUnauthorized(await request(limited).get(streamPath()).set(from("203.0.113.1")));
    // That address has used up its own limit, token or not.
    const spent = await sse(
      limited,
      withToken(streamPath(), tokens.mint().runToken),
      from("203.0.113.1"),
    );
    expect(spent.events[0]).toMatchObject({ type: "error", code: "rate_limited" });
    // Everyone's limit is left: another address starts a run, and only then is it used up.
    const other = await sse(
      limited,
      withToken(streamPath(), tokens.mint().runToken),
      from("203.0.113.2"),
    );
    expect(other.events.map((event) => event.type)).toContain("complete");
    const third = await sse(
      limited,
      withToken(streamPath(), tokens.mint().runToken),
      from("203.0.113.3"),
    );
    expect(third.events[0]).toMatchObject({ type: "error", code: "rate_limited" });
  });
});

// =============================================================================
// Turnstile
// =============================================================================

describe("the Turnstile check", () => {
  /** A fetch that answers siteverify with `answer`, and records what it was sent. */
  function siteverify(answer: () => Promise<Response> | Response) {
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    const fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: init?.body as URLSearchParams });
      return answer();
    }) as typeof globalThis.fetch;
    return { fetch, calls };
  }
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  it("posts the secret, the token and the address to siteverify, and passes a success", async () => {
    const { fetch, calls } = siteverify(() => json({ success: true, hostname: "liner.example" }));
    const verify = createTurnstileVerifier({ secret: "test-secret", fetch });
    expect(await verify("tok-1", "198.51.100.7")).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(TURNSTILE_VERIFY_URL);
    expect(Object.fromEntries(calls[0].body)).toEqual({
      secret: "test-secret",
      response: "tok-1",
      remoteip: "198.51.100.7",
    });
  });

  it("fails closed on anything but a clear success", async () => {
    const cases: Array<[string, () => Promise<Response> | Response, string]> = [
      [
        "success false",
        () => json({ success: false, "error-codes": ["invalid-input-response"] }),
        "rejected",
      ],
      ["no success field", () => json({ hostname: "liner.example" }), "rejected"],
      ["success as text", () => json({ success: "true" }), "rejected"],
      ["another hostname", () => json({ success: true, hostname: "evil.example" }), "rejected"],
      ["no hostname", () => json({ success: true }), "rejected"],
      ["a 500", () => json({ success: true, hostname: "liner.example" }, 500), "unavailable"],
      ["a body that is not JSON", () => new Response("<html>"), "unavailable"],
      ["null", () => json(null), "unavailable"],
      ["a network error", () => Promise.reject(new TypeError("fetch failed")), "unavailable"],
    ];
    for (const [label, answer, reason] of cases) {
      const { fetch } = siteverify(answer);
      const verify = createTurnstileVerifier({
        secret: "test-secret",
        expectedHostname: "liner.example",
        fetch,
      });
      expect(await verify("tok", undefined), label).toEqual({ ok: false, reason });
    }
  });

  it("gives up after its timeout", async () => {
    const fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      })) as unknown as typeof globalThis.fetch;
    const verify = createTurnstileVerifier({ secret: "test-secret", fetch, timeoutMs: 20 });
    expect(await verify("tok", undefined)).toEqual({ ok: false, reason: "unavailable" });
  });

  it("refuses an empty or oversized token without asking", async () => {
    const { fetch, calls } = siteverify(() => json({ success: true }));
    const verify = createTurnstileVerifier({ secret: "test-secret", fetch });
    expect(await verify("", undefined)).toEqual({ ok: false, reason: "rejected" });
    expect(await verify("x".repeat(2049), undefined)).toEqual({ ok: false, reason: "rejected" });
    expect(calls).toEqual([]);
  });

  it("is bypassed only where the settings say, with dev-bypass alone", async () => {
    const base: RunTokenSettings = {
      secret: null,
      turnstileSecret: null,
      expectedHostname: null,
      bypass: true,
    };
    expect(turnstileVerifierFor(base)).toBe(bypassTurnstileVerifier);
    expect(await bypassTurnstileVerifier(DEV_BYPASS_TOKEN, undefined)).toEqual({ ok: true });
    expect(await bypassTurnstileVerifier("anything-else", undefined)).toEqual({
      ok: false,
      reason: "rejected",
    });

    // With a secret, dev-bypass is just a token Cloudflare is asked about.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ success: false }));
    const real = turnstileVerifierFor({ ...base, turnstileSecret: "test-secret", bypass: false });
    expect(real).not.toBe(bypassTurnstileVerifier);
    expect(await real(DEV_BYPASS_TOKEN, undefined)).toEqual({ ok: false, reason: "rejected" });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();

    // Neither a secret nor the bypass (settings readSettings refuses): nothing passes.
    const none = turnstileVerifierFor({ ...base, bypass: false });
    expect(await none(DEV_BYPASS_TOKEN, undefined)).toEqual({ ok: false, reason: "rejected" });
  });

  it("lets POST /api/runs issue a token for dev-bypass under the bypass only", async () => {
    const bypassed = appWith(tokens, bypassTurnstileVerifier);
    const res = await request(bypassed)
      .post("/api/runs")
      .send({ turnstileToken: DEV_BYPASS_TOKEN });
    expect(res.status).toBe(200);
    expect(tokens.verify(res.body.runToken).ok).toBe(true);

    const checked = appWith(tokens, testTurnstile);
    expectUnauthorized(
      await request(checked).post("/api/runs").send({ turnstileToken: DEV_BYPASS_TOKEN }),
    );
  });
});

// =============================================================================
// SSE_HOLD_MS
// =============================================================================

describe("SSE_HOLD_MS", () => {
  /** The stream's messages, heartbeats included, once it ends; timers are advanced by hand. */
  async function heldStream(): Promise<Array<{ type: string }>> {
    let ended = false;
    const pending = request(app)
      .get(withToken(streamPath(), tokens.mint().runToken))
      .buffer(true)
      .parse((response, callback) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => callback(null, body));
      })
      .then((res) => {
        ended = true;
        return res;
      });
    // The request reaches the route over a real socket; only the timers are fake.
    const holding = () => logs.messages().some((msg) => msg.startsWith("Holding the stream"));
    for (let i = 0; i < 500 && !holding() && !ended; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (let i = 0; i < 200 && !ended; i++) await vi.advanceTimersByTimeAsync(1000);
    const res = await pending;
    return String(res.body)
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice("data: ".length)) as { type: string });
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds a replayed stream open, with heartbeats, before its first event", async () => {
    vi.stubEnv("SSE_HOLD_MS", "40000");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

    const events = await heldStream();
    const first = events.findIndex((event) => event.type !== "heartbeat");
    // A heartbeat every 15 s while the stream is held 40 s.
    expect(first).toBe(2);
    expect(events[first].type).toBe("connected");
    expect(events.map((event) => event.type)).toContain("complete");
    expect(events.at(-1)?.type).toBe("done");
    expect(logs.messages()).toContain("Holding the stream for 40000 ms (SSE_HOLD_MS)");
  });

  it("holds nothing under NODE_ENV=production, whatever it says", async () => {
    vi.stubEnv("SSE_HOLD_MS", "40000");
    vi.stubEnv("NODE_ENV", "production");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });

    const events = await heldStream();
    expect(events[0].type).toBe("connected");
    expect(events.map((event) => event.type)).not.toContain("heartbeat");
    expect(logs.messages().some((msg) => msg.startsWith("Holding the stream"))).toBe(false);
  });
});
