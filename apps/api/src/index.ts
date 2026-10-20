/**
 * API entry point: loads and validates the configuration (first import), opens the database,
 * settles runs a previous process left open, opens the cache, starts retention, creates the app
 * and listens. Routes and middleware live in http/app.ts.
 */

import { settings } from "./config/env.js";
import { createApp } from "./http/app.js";
import { getCache, initCache } from "./store/cache.js";
import { closeDatabase, initializeDatabase } from "./store/database.js";
import { startRetention } from "./store/retention.js";
import { settleOpenRuns } from "./store/runs.js";
import { isWaitingAtInterrupt } from "./store/threads.js";

/** How long open streams may keep running after a shutdown signal before they are closed. */
const STREAM_DRAIN_MS = 3_000;
/** Exit even if connections are still open this long after the signal (Docker waits 10 s). */
const SHUTDOWN_TIMEOUT_MS = 8_000;

// =============================================================================
// Process-level errors
// =============================================================================

// A rejected promise nobody handled is a bug, but not one that should take every other request
// down with it: it is logged and the process keeps serving.
process.on("unhandledRejection", (reason) => {
  console.error("[Process] Unhandled promise rejection:", reason);
});

// After an uncaught exception the process state is unknown, so it is logged and the process
// exits with status 1 (Docker's restart policy or the dev watcher brings it back).
process.on("uncaughtException", (error) => {
  console.error("[Process] Uncaught exception; exiting:", error);
  closeDatabase();
  process.exit(1);
});

// =============================================================================
// Database, cache and retention
// =============================================================================

let db: ReturnType<typeof initializeDatabase>;
try {
  db = initializeDatabase();
} catch (err) {
  console.error(`[Database] ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

/**
 * Finalizes runs still recorded as running: interrupted when the thread waits for the user's
 * choice, otherwise cancelled. Never throws.
 */
async function settleRuns(when: string): Promise<void> {
  try {
    const { interrupted, cancelled } = await settleOpenRuns(db, (threadId) =>
      isWaitingAtInterrupt(db, threadId),
    );
    if (interrupted + cancelled > 0) {
      console.log(
        `[Runs] ${when}: ${cancelled} open runs cancelled, ${interrupted} left waiting for a choice`,
      );
    }
  } catch (err) {
    console.error(`[Runs] ${when}: could not settle open runs:`, err);
  }
}

// Runs left "running" by a process that stopped are not running any more.
await settleRuns("Startup");

initCache(db);
const stopRetention = startRetention(db, getCache());

// =============================================================================
// Server
// =============================================================================

const app = createApp({ http: settings.http });

const server = app.listen(settings.port, settings.host, () => {
  const address = server.address();
  const bound =
    typeof address === "object" && address
      ? `${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`
      : String(address);
  console.log(`[Server] Liner Notes API listening on http://${bound}`);
  console.log(
    `[Server] CORS origins: ${settings.http.corsOrigins.length > 0 ? settings.http.corsOrigins.join(", ") : "none"}`,
  );
  if (settings.replayOnly) console.log("[Server] REPLAY_MODE=only");
});

server.on("error", (error) => {
  console.error("[Server] Could not listen:", error);
  stopRetention();
  closeDatabase();
  process.exit(1);
});

// =============================================================================
// Graceful shutdown
// =============================================================================

let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) {
    console.warn(`[Server] ${signal} again; exiting now`);
    process.exit(1);
  }
  shuttingDown = true;
  console.log(`[Server] ${signal} received; shutting down`);

  stopRetention();

  // Runs still in flight are recorded as ended before the database closes, so retention does
  // not keep their threads as open runs.
  let closing: Promise<void> | undefined;
  const closeStore = () => {
    closing ??= settleRuns("Shutdown").then(closeDatabase);
    return closing;
  };

  const forced = setTimeout(() => {
    console.error("[Server] Connections still open after the shutdown timeout; exiting");
    void closeStore().then(() => process.exit(1));
  }, SHUTDOWN_TIMEOUT_MS);
  forced.unref();

  // Stop accepting connections; the callback runs once every open connection has ended.
  server.close(() => {
    clearTimeout(forced);
    void closeStore().then(() => {
      console.log("[Server] Stopped");
      process.exit(0);
    });
  });
  server.closeIdleConnections();

  // Open event streams get a short drain, then their connections are closed (which aborts them).
  setTimeout(() => server.closeAllConnections(), STREAM_DRAIN_MS).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
