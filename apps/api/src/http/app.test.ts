/**
 * Tests for createApp: CORS, rate limits, body limit, error handling and the wiring of the
 * routes. Model and Spotify calls are stubbed and never reached by these requests.
 */

import { Router } from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RATE_LIMIT,
  DEFAULT_SEARCH_RATE_LIMIT,
  type HttpSettings,
} from "../config/settings.js";
import { createApp } from "./app.js";
import { asyncRoute } from "./middleware/errors.js";

vi.mock("../agent/geminiClient.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agent/geminiClient.js")>()),
  generateStructuredOutput: vi.fn(async () => {
    throw new Error("the model must not be called in these tests");
  }),
}));

vi.mock("../sources/spotify.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../sources/spotify.js")>()),
  searchMultipleTracks: {
    invoke: vi.fn(async () => {
      throw new Error("Spotify must not be called in these tests");
    }),
  },
}));

const LISTED = "http://localhost:3110";

function settings(overrides: Partial<HttpSettings> = {}): HttpSettings {
  return {
    corsOrigins: [LISTED],
    trustProxy: 0,
    rateLimit: DEFAULT_RATE_LIMIT,
    searchRateLimit: DEFAULT_SEARCH_RATE_LIMIT,
    ...overrides,
  };
}

const app = (overrides?: Partial<HttpSettings>) => createApp({ http: settings(overrides) });

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

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

    const res = await request(server).post("/api/factoids/decrypt").send(body).timeout(2000);
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
      .post("/api/factoids/decrypt")
      .send({ trackTitle: "a".repeat(17 * 1024) });

    expect(res.status).toBe(413);
    expect(res.body).toMatchObject({ success: false, code: "payload_too_large" });
  });

  it("accepts a body just under the limit", async () => {
    const res = await request(app())
      .post("/api/factoids/decrypt")
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
      .options("/api/factoids/decrypt")
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
      .options("/api/factoids/decrypt")
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
      last = await request(server).post("/api/factoids/decrypt").send({});
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

    const stream = await request(server).get("/api/factoids/decrypt/stream?trackTitle=x");
    const resume = await request(server).get("/api/analyze/stream/resume");
    expect(stream.status).toBe(429);
    expect(resume.status).toBe(429);
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
    expect((await request(server).post("/api/factoids/decrypt").send({})).status).toBe(400);
  });

  it("keys on the client address from X-Forwarded-For only behind a trusted proxy", async () => {
    const behindProxy = app({ ...limited, trustProxy: 1 });
    const from = (ip: string) =>
      request(behindProxy).post("/api/factoids/decrypt").set("X-Forwarded-For", ip).send({});
    for (let i = 0; i < 3; i++) await from("203.0.113.1");
    expect((await from("203.0.113.1")).status).toBe(429);
    expect((await from("203.0.113.2")).status).toBe(400);

    // Without a trusted proxy the header is ignored: a client cannot pick a fresh key.
    const direct = app(limited);
    const spoofed = (ip: string) =>
      request(direct).post("/api/factoids/decrypt").set("X-Forwarded-For", ip).send({});
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await spoofed(`203.0.113.${i + 10}`)).status);
    expect(statuses).toEqual([400, 400, 400, 429]);
  });

  it("lets a listed origin read the 429", async () => {
    const server = app({ rateLimit: { windowMs: 60_000, max: 1 } });
    await request(server).post("/api/factoids/decrypt").send({});
    const res = await request(server).post("/api/factoids/decrypt").set("Origin", LISTED).send({});

    expect(res.status).toBe(429);
    expect(res.headers["access-control-allow-origin"]).toBe(LISTED);
  });
});
