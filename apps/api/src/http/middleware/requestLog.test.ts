/**
 * The request log of the app: one line per request with the method, the path without its query
 * string, the status, the time taken and a keyed hash of the client address; never the address,
 * the query string, the User-Agent or the Referer.
 */

import { Router } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RATE_LIMIT,
  DEFAULT_SEARCH_RATE_LIMIT,
  type HttpSettings,
} from "../../config/settings.js";
import { type CapturedLogs, captureLogsForTests, configureLogger, ipHash } from "../../logger.js";
import { createApp } from "../app.js";

vi.mock("../../sources/spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../sources/spotify.js")>()),
  searchTracks: vi.fn(async () => {
    throw new Error("Spotify must not be called in these tests");
  }),
}));

function settings(overrides: Partial<HttpSettings> = {}): HttpSettings {
  return {
    corsOrigins: [],
    trustProxy: 1,
    rateLimit: DEFAULT_RATE_LIMIT,
    globalRateLimit: { windowMs: DEFAULT_RATE_LIMIT.windowMs, max: 10_000 },
    searchRateLimit: DEFAULT_SEARCH_RATE_LIMIT,
    ...overrides,
  };
}

const CLIENT = "198.51.100.23";

let logs: CapturedLogs;
beforeEach(() => {
  configureLogger({ LOG_IP_SALT: "test-salt" });
  logs = captureLogsForTests();
});
afterEach(() => {
  logs.restore();
  configureLogger({ LOG_LEVEL: "silent" });
});

/** The request lines logged (component HTTP, with a status). */
const requestLines = () =>
  logs.entries().filter((entry) => entry.component === "HTTP" && "status" in entry);

describe("the request log", () => {
  it("writes the method, the path, the status, the time and a hash of the address; nothing else", async () => {
    const echo = Router();
    echo.get("/api/echo", (_req, res) => {
      res.json({ ok: true });
    });
    await request(createApp({ http: settings(), routers: [echo] }))
      .get("/api/echo?query=what+the+visitor+typed&limit=5")
      .set("X-Forwarded-For", CLIENT)
      .set("User-Agent", "Secret-Agent/1.0 (visitor@example.com)")
      .set("Referer", "https://referrer.example/page?private=1");

    const [line] = requestLines();
    expect(line).toEqual({
      level: "info",
      time: expect.any(String),
      pid: process.pid,
      component: "HTTP",
      method: "GET",
      path: "/api/echo",
      status: 200,
      durationMs: expect.any(Number),
      ipHash: ipHash(CLIENT),
      msg: "GET /api/echo 200",
    });
    const text = logs.lines().join("\n");
    for (const leaked of [CLIENT, "query=", "visitor typed", "Secret-Agent", "referrer.example"]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
  });

  it("logs the full path of a request refused inside a mounted limit", async () => {
    const app = createApp({ http: settings({ rateLimit: { windowMs: 60_000, max: 1 } }) });
    await request(app).post("/api/factoids/decrypt").send({});
    await request(app).post("/api/factoids/decrypt").send({});
    expect(requestLines().map((line) => [line.path, line.status])).toEqual([
      ["/api/factoids/decrypt", 400],
      ["/api/factoids/decrypt", 429],
    ]);
  });

  it("writes probes, HEAD and OPTIONS at debug level, and answers of 500 and above at warn", async () => {
    const failing = Router();
    failing.get("/api/boom", () => {
      throw new Error("boom");
    });
    const app = createApp({ http: settings() });
    await request(app).get("/api/health");
    await request(app).get("/api/ready");
    await request(app).head("/api/analyze/stream");
    await request(app).options("/api/health");
    await request(app).get("/api/nowhere");
    await request(createApp({ http: settings(), routers: [failing] })).get("/api/boom");

    expect(requestLines().map((line) => [line.method, line.path, line.status, line.level])).toEqual(
      [
        ["GET", "/api/health", 200, "debug"],
        ["GET", "/api/ready", expect.any(Number), "debug"],
        ["HEAD", "/api/analyze/stream", 200, "debug"],
        ["OPTIONS", "/api/health", 204, "debug"],
        ["GET", "/api/nowhere", 404, "info"],
        ["GET", "/api/boom", 500, "warn"],
      ],
    );
  });

  it("is not written at info level for probes", async () => {
    logs.restore();
    logs = captureLogsForTests({ level: "info" });
    await request(createApp({ http: settings() })).get("/api/health");
    expect(requestLines()).toEqual([]);
  });
});
