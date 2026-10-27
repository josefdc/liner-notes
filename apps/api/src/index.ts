/**
 * API entry point: loads and validates the configuration (first import), opens the database and
 * cache, creates the app and listens. Once listening it settles the runs a previous process left
 * open (requests wait for that), then starts retention. Routes and middleware live in
 * http/app.ts, shutdown and process-level errors in lifecycle.ts.
 *
 * One API process per database file: the runs recorded as running are taken to be this
 * process's, so a second process on the same file would settle the first one's runs.
 */

import { settings } from "./config/env.js";
import { createServer } from "node:http";
import { createApp } from "./http/app.js";
import { runTokensFor } from "./http/runToken.js";
import { turnstileVerifierFor } from "./http/turnstile.js";
import {
  createShutdown,
  installProcessHandlers,
  requestGate,
  SHUTDOWN_TIMEOUT_MS,
  STREAM_DRAIN_MS,
} from "./lifecycle.js";
import { getCache, initCache } from "./store/cache.js";
import { closeDatabase, initializeDatabase } from "./store/database.js";
import { startRetention } from "./store/retention.js";
import { settleOpenRuns } from "./store/runs.js";
import { isWaitingAtInterrupt } from "./store/threads.js";
import { installConsoleBridge, logger } from "./logger.js";

// Modules that still write to the console write JSON log lines too.
installConsoleBridge();
installProcessHandlers(closeDatabase);

const log = logger("Server");

// =============================================================================
// Database and cache
// =============================================================================

let db: ReturnType<typeof initializeDatabase>;
try {
  db = initializeDatabase();
} catch (err) {
  logger("Database").error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
initCache(db);

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
      logger("Runs").info(
        `${when}: ${cancelled} open runs cancelled, ${interrupted} left waiting for a choice`,
        { cancelled, interrupted },
      );
    }
  } catch (err) {
    logger("Runs").error(`${when}: could not settle open runs`, { err });
  }
}

// =============================================================================
// Server
// =============================================================================

const app = createApp({
  http: settings.http,
  runTokens: runTokensFor(settings.runTokens),
  verifyTurnstile: turnstileVerifierFor(settings.runTokens),
});
let stopRetention = () => {};

// Requests wait while startup settles the runs left open. Settling reads the open runs at once,
// so a run a request starts meanwhile is not among them; but a resume of a run left open would
// reopen it while it is being settled, and then be recorded as cancelled while it runs.
const gate = requestGate(app);
const server = createServer(gate.handler);

server.on("error", (error) => {
  // Not listening (e.g. the port is taken): the runs belong to whichever process is.
  log.error("Could not listen", { err: error });
  closeDatabase();
  process.exit(1);
});

server.listen(settings.port, settings.host, () => {
  const address = server.address();
  const bound =
    typeof address === "object" && address
      ? `${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`
      : String(address);
  const port = typeof address === "object" && address ? address.port : settings.port;
  // The bound address is the server's own, not a client's; it is written at debug level so an
  // info-level log holds no address at all.
  log.info(`Liner Notes API listening on port ${port}`, { port });
  log.debug(`Listening on http://${bound}`);
  log.info(
    `CORS origins: ${settings.http.corsOrigins.length > 0 ? settings.http.corsOrigins.join(", ") : "none"}`,
  );
  if (settings.replayMode !== "off") log.info(`REPLAY_MODE=${settings.replayMode}`);
  if (settings.runTokens.bypass) {
    log.warn('Turnstile is bypassed (no TURNSTILE_SECRET_KEY): the token "dev-bypass" passes');
  }

  // Runs left "running" by a process that stopped are not running any more.
  void gate.until(
    settleRuns("Startup").then(() => {
      stopRetention = startRetention(db, getCache());
    }),
  );
});

// =============================================================================
// Graceful shutdown
// =============================================================================

const shutdown = createShutdown({
  server,
  stopBackground: () => stopRetention(),
  // Runs still in flight are recorded as ended before the database closes, so retention does
  // not keep their threads as open runs.
  closeStore: () => settleRuns("Shutdown").then(closeDatabase),
  exit: (code) => process.exit(code),
  drainMs: STREAM_DRAIN_MS,
  timeoutMs: SHUTDOWN_TIMEOUT_MS,
});

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
