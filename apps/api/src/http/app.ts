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
  /** Routers to mount instead of the API's own (for tests). */
  routers?: Router[];
}

export function createApp({ http, routers }: AppDeps): express.Express {
  const app = express();
  app.disable("x-powered-by");
  // Hop count of trusted proxies; req.ip (the rate-limit key) comes from X-Forwarded-For only
  // through them.
  app.set("trust proxy", http.trustProxy > 0 ? http.trustProxy : false);

  app.use(cors(http.corsOrigins));

  // Routes that cost money: the analysis (POST and both streams), factoids and search (Spotify).
  // Requests other sites make a visitor's browser send are refused first, so they cost nothing
  // and use no one's budget. Every other request counts, valid or not: the limits run before
  // the body is parsed or validated. The per-IP limit runs before the shared one, so a client
  // past its own limit does not use up everyone's.
  const paidRoutes = ["/api/analyze", "/api/factoids", "/api/search"];
  const modelRoutes = ["/api/analyze", "/api/factoids"];
  app.use(paidRoutes, listedOriginsOnly(http.corsOrigins));
  app.use(modelRoutes, perIpLimit(http.rateLimit), globalLimit(http.globalRateLimit));
  app.use("/api/search", perIpLimit(http.searchRateLimit));

  app.use(acceptedEncodingsOnly);
  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  const defaultRouters = [healthRouter, searchRouter, analyzeRouter, factoidsRouter, runsRouter];
  for (const router of routers ?? defaultRouters) {
    app.use(router);
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
