/**
 * The Express app: middleware and routes, with no side effects. index.ts opens the database,
 * creates the app and listens; tests drive it with supertest.
 */

import express, { type Router } from "express";
import type { HttpSettings } from "../config/settings.js";
import { cors } from "./middleware/cors.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { perIpLimit } from "./middleware/rateLimit.js";
import { analyzeRouter, factoidsRouter, healthRouter, searchRouter } from "./routes/index.js";

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
  // Every request counts, so the limit runs before the body is parsed or validated.
  app.use(["/api/analyze", "/api/factoids"], perIpLimit(http.rateLimit));
  app.use("/api/search", perIpLimit(http.searchRateLimit));

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  for (const router of routers ?? [healthRouter, searchRouter, analyzeRouter, factoidsRouter]) {
    app.use(router);
  }

  app.use(notFound);
  app.use(errorHandler);
  return app;
}
