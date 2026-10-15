/**
 * Sonic Agent Express Server v2
 *
 * Exposes the LangGraph agent via REST API with SSE streaming support.
 */

import express from "express";
import dotenv from "dotenv";
import { healthRouter, searchRouter, analyzeRouter, factoidsRouter } from "./routes/index.js";
import { initializeDatabase, closeDatabase } from "./lib/database.js";
import { initCache, getCache } from "./lib/cache.js";

dotenv.config();

// =============================================================================
// Database Initialization (must happen before routes that use the graph)
// =============================================================================

const db = initializeDatabase();
initCache(db);

const app = express();
const PORT = Number(process.env.PORT) || 3001;

// =============================================================================
// Middleware
// =============================================================================

app.use(express.json());

// CORS middleware for frontend integration
app.use((req, res, next) => {
  // In development, allow any origin (for mobile testing via network IP)
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Cache-Control");
  res.setHeader("Access-Control-Allow-Credentials", "true");

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    res.sendStatus(200);
    return;
  }

  next();
});

// =============================================================================
// Routes
// =============================================================================

app.use(healthRouter);
app.use(searchRouter);
app.use(analyzeRouter);
app.use(factoidsRouter);

// =============================================================================
// Start Server
// =============================================================================

// =============================================================================
// Periodic Cache Purge (every hour)
// =============================================================================

const purgeInterval = setInterval(() => {
  try {
    getCache().purgeExpired();
  } catch {
    // Non-critical
  }
}, 60 * 60 * 1000);

// =============================================================================
// Graceful Shutdown
// =============================================================================

function shutdown() {
  console.log("\n[Server] Shutting down gracefully...");
  clearInterval(purgeInterval);
  closeDatabase();
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// =============================================================================
// Start Server
// =============================================================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(`
🚀 Sonic Agent Server v2 running on http://0.0.0.0:${PORT}

Endpoints:
  GET  /api/health              - Health check
  GET  /api/search/suggest      - Autocomplete suggestions
  POST /api/analyze             - Analyze a song (synchronous)
  GET  /api/analyze/stream      - SSE streaming analysis
  POST /api/analyze/resume      - Resume after disambiguation
  GET  /api/analyze/stream/resume - Resume streaming
  POST /api/factoids/decrypt    - Generate additional obscure facts
  GET  /api/factoids/decrypt/stream - SSE streaming factoids (one-by-one)

Features:
  ✓ Map-Reduce parallel execution
  ✓ Human-in-the-loop disambiguation
  ✓ Real-time SSE streaming
  ✓ Structured output validation
  ✓ Persistent SQLite cache

Example:
  curl -X POST http://localhost:${PORT}/api/analyze \\
    -H "Content-Type: application/json" \\
    -d '{"query": "Midnight City M83"}'

  # Or with streaming:
  curl -N "http://localhost:${PORT}/api/analyze/stream?query=Midnight+City+M83"
`);
});
