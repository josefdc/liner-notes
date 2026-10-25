import type { ReadyResponse } from "@liner-notes/contract";
import { Router } from "express";
import { API_VERSION } from "../../config/apiPackage.js";
import { isDatabaseHealthy } from "../../store/database.js";
import { readiness } from "../readiness.js";

const router = Router();

/**
 * Liveness: 200 while the process can answer. The version comes from the API's package.json;
 * `database` is informational only (readiness is /api/ready).
 */
router.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "liner-notes-api",
    version: API_VERSION,
    database: isDatabaseHealthy() ? "connected" : "unavailable",
    timestamp: new Date().toISOString(),
  });
});

/**
 * Readiness: 200 when the API can serve an analysis, 503 with the failing checks otherwise
 * (http/readiness.ts): the database, its migrations, the audio service, the model provider and
 * the budget's state. A spent budget is reported and is not a failure: replays and stored
 * results are still served. `checks` maps each check to its status; `details` has each in full.
 */
router.get("/api/ready", async (_req, res) => {
  const { ready, checks } = await readiness();
  const body: ReadyResponse = {
    status: ready ? "ready" : "unavailable",
    checks: Object.fromEntries(checks.map((check) => [check.name, check.status])),
    details: checks,
    timestamp: new Date().toISOString(),
  };
  res.status(ready ? 200 : 503).json(body);
});

export default router;
