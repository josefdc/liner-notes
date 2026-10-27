/**
 * Test helpers: an Express app with the given routers mounted, for route tests with supertest,
 * and the run tokens its analysis and factoid routes require, as the API's own app does.
 *
 *   const app = createTestApp(healthRouter);
 *   const res = await request(app).get("/api/health");
 *   await request(app).get(withRunToken("/api/analyze/stream?query=Hurt"));
 */

import express, { type Router } from "express";
import { requireRunToken } from "./middleware/requireRunToken.js";
import { createRunTokens, RUN_TOKEN_PARAM } from "./runToken.js";
import type { TurnstileVerifier } from "./turnstile.js";

/** The key test tokens are signed with: fixed, and only ever used by tests. */
const TEST_RUN_TOKEN_KEY = Buffer.alloc(32, "test-only-run-token-key");

/** Run tokens signed with the tests' key. */
export const testRunTokens = createRunTokens(TEST_RUN_TOKEN_KEY);

/** The Turnstile token testTurnstile passes; it rejects any other. */
export const TEST_TURNSTILE_TOKEN = "test-turnstile-pass";

/** A Turnstile check for tests: it never calls Cloudflare. */
export const testTurnstile: TurnstileVerifier = async (token) =>
  token === TEST_TURNSTILE_TOKEN ? { ok: true } : { ok: false, reason: "rejected" };

/** What createApp needs for run tokens, in tests. */
export const testAuth = { runTokens: testRunTokens, verifyTurnstile: testTurnstile };

/**
 * A run token for tests: for a new run (a fresh thread id), or, given a thread id, the token
 * that run started with, as a resume of it sends. A thread id that is not one (a test of invalid
 * input) gets a token for a new run.
 */
export function mintRunToken(threadId?: string): string {
  const named = threadId !== undefined && /^[A-Za-z0-9_-]{1,100}$/.test(threadId);
  return testRunTokens.mint(named ? threadId : undefined).runToken;
}

/** `path` with a run token (mintRunToken) in its query. */
export function withRunToken(path: string, threadId?: string): string {
  const token = encodeURIComponent(mintRunToken(threadId));
  return `${path}${path.includes("?") ? "&" : "?"}${RUN_TOKEN_PARAM}=${token}`;
}

export function createTestApp(...routers: Router[]): express.Express {
  const app = express();
  app.use(["/api/analyze", "/api/factoids"], requireRunToken(testRunTokens));
  app.use(express.json());
  for (const router of routers) app.use(router);
  return app;
}
