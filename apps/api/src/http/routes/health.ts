import { Router } from "express";
import { API_VERSION } from "../../config/apiPackage.js";
import { isDatabaseHealthy } from "../../store/database.js";

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
 * Readiness: 200 when the database answers a query, 503 otherwise.
 */
router.get("/api/ready", (_req, res) => {
  const ready = isDatabaseHealthy();
  res.status(ready ? 200 : 503).json({
    status: ready ? "ready" : "unavailable",
    checks: { database: ready ? "ok" : "unavailable" },
    timestamp: new Date().toISOString(),
  });
});

export default router;
