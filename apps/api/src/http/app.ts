/**
 * The Express app: middleware and routes, with no side effects. index.ts opens the database,
 * creates the app and listens; tests drive it with supertest.
 */

import express, { type Router } from "express";
import type { HttpSettings } from "../config/settings.js";
import { cors } from "./middleware/cors.js";
import { acceptedEncodingsOnly } from "./middleware/encoding.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { listedOriginsOnly } from "./middleware/origin.js";
import { globalLimit, perIpLimit } from "./middleware/rateLimit.js";
import { requestLog } from "./middleware/requestLog.js";
import { requireRunToken } from "./middleware/requireRunToken.js";
import type { RunTokens } from "./runToken.js";
import { createRunTokenRouter } from "./routes/runTokens.js";
import type { TurnstileVerifier } from "./turnstile.js";
import {
  analyzeRouter,
  factoidsRouter,
  healthRouter,
  runsRouter,
  searchRouter,
} from "./routes/index.js";

/** Largest accepted JSON body. The API's bodies are a query or a few ids. */
export const JSON_BODY_LIMIT = "16kb";

export interface AppDeps {
  http: HttpSettings;
  /** Issues and checks the run tokens the analysis and factoid routes require (runToken.ts). */
  runTokens: RunTokens;
  /** The Turnstile check a visitor passes before POST /api/runs issues a token (turnstile.ts). */
  verifyTurnstile: TurnstileVerifier;
  /** Routers to mount instead of the API's own (for tests). */
  routers?: Router[];
}

export function createApp({ http, runTokens, verifyTurnstile, routers }: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // Hop count of trusted proxies; req.ip (the rate-limit key) comes from X-Forwarded-For only
  // through them.
  app.set("trust proxy", http.trustProxy > 0 ? http.trustProxy : false);

  // First, so every request is logged, refused ones included.
  app.use(requestLog);
  app.use(cors(http.corsOrigins));

  // Routes that cost money: the analysis (POST and both streams), factoids and search (Spotify).
  // Requests other sites make a visitor's browser send are refused first, so they cost nothing
  // and use no one's budget. Every other request counts, valid or not: the limits run before
  // the body is parsed or validated. The per-IP limit runs before the shared one, so a client
  // past its own limit does not use up everyone's. The analysis and factoid routes, their JSON
  // forms included, also need a run token, checked between the two limits: a request without a
  // valid one counts against its own address only, never against everyone's.
  const paidRoutes = ["/api/analyze", "/api/factoids", "/api/search"];
  const modelRoutes = ["/api/analyze", "/api/factoids"];
  const originCheck = listedOriginsOnly(http.corsOrigins);
  app.use(paidRoutes, originCheck);
  app.use(modelRoutes, perIpLimit(http.rateLimit));
  app.use(modelRoutes, requireRunToken(runTokens));
  app.use(modelRoutes, globalLimit(http.globalRateLimit));
  app.use("/api/search", perIpLimit(http.searchRateLimit));
  // Run tokens: each one is a Turnstile check, so the origin and a per-IP limit (counted apart
  // from the analysis's, over the same window) come before the body is read.
  app.post("/api/runs", originCheck, perIpLimit(http.rateLimit));
  // Readiness is public and does a little work per request (the database's write probe): the
  // search limit, counted on its own. Liveness (/api/health) is not limited.
  app.use("/api/ready", perIpLimit(http.searchRateLimit));

  app.use(acceptedEncodingsOnly);
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  app.use(createRunTokenRouter({ tokens: runTokens, verifyTurnstile }));
  const defaultRouters = [healthRouter, searchRouter, analyzeRouter, factoidsRouter, runsRouter];
  for (const router of routers ?? defaultRouters) {
    app.use(router);
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
