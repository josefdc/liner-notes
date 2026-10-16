import { Router } from "express";
import { isDatabaseHealthy } from "../../store/database.js";

const router = Router();

/**
 * Health check endpoint
 */
router.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "sonic-agent",
    version: "2.0.0",
    database: isDatabaseHealthy() ? "connected" : "unavailable",
    features: ["streaming", "human-in-the-loop", "parallel-execution", "persistent-cache"],
    timestamp: new Date().toISOString(),
  });
});

export default router;
