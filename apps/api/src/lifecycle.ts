/**
 * Process lifecycle: graceful shutdown on a signal, and logging of process-level errors. Kept
 * apart from index.ts so it can be tested with a real server and no process exit.
 */

import type { Server } from "node:http";

export interface ShutdownOptions {
  server: Server;
  /** Stops background work (retention). */
  stopBackground: () => void;
  /** Records runs still in flight as ended and closes the database. Must not reject. */
  closeStore: () => Promise<void>;
  exit: (code: number) => void;
  /** How long open streams may keep running before their connections are closed. */
  drainMs: number;
  /** Exit even if connections are still open this long after the signal. */
  timeoutMs: number;
  /** A further signal within this time of the first is a duplicate and is ignored. */
  repeatWindowMs?: number;
  now?: () => number;
}

/** Docker waits 10 s after SIGTERM before it kills the container. */
export const STREAM_DRAIN_MS = 3_000;
export const SHUTDOWN_TIMEOUT_MS = 8_000;
export const REPEAT_SIGNAL_WINDOW_MS = 1_000;

/**
 * Returns the signal handler. The first signal stops accepting connections and background work,
 * lets open streams run for `drainMs`, then closes every connection (which aborts the streams);
 * once all connections have ended, the store is closed and the process exits 0. If that takes
 * longer than `timeoutMs`, the store is closed and the process exits 1.
 *
 * In development the same signal often arrives twice within milliseconds (the dev runner signals
 * the process group and `tsx watch` relays it), so a signal within `repeatWindowMs` of the first
 * is ignored. A signal after that exits at once with 1.
 */
export function createShutdown({
  server,
  stopBackground,
  closeStore,
  exit,
  drainMs,
  timeoutMs,
  repeatWindowMs = REPEAT_SIGNAL_WINDOW_MS,
  now = Date.now,
}: ShutdownOptions): (signal: string) => void {
  let startedAt: number | null = null;
  let closing: Promise<void> | undefined;
  const closeOnce = () => {
    closing ??= closeStore();
    return closing;
  };

  return (signal) => {
    if (startedAt !== null) {
      if (now() - startedAt < repeatWindowMs) {
        console.log(`[Server] ${signal} again while shutting down; ignored as a duplicate`);
        return;
      }
      console.warn(`[Server] ${signal} again; exiting now`);
      exit(1);
      return;
    }
    startedAt = now();
    console.log(`[Server] ${signal} received; shutting down`);

    stopBackground();

    const forced = setTimeout(() => {
      console.error("[Server] Connections still open after the shutdown timeout; exiting");
      void closeOnce().then(() => exit(1));
    }, timeoutMs);
    forced.unref();

    const drain = setTimeout(() => server.closeAllConnections(), drainMs);
    drain.unref();

    // Stops accepting connections and closes idle ones; the callback runs once every open
    // connection has ended.
    server.close(() => {
      clearTimeout(forced);
      clearTimeout(drain);
      void closeOnce().then(() => {
        console.log("[Server] Stopped");
        exit(0);
      });
    });
  };
}

/**
 * Logs a rejected promise nobody handled and keeps serving: it is a bug, but not one that should
 * take every other request down with it. After an uncaught exception the process state is
 * unknown, so it is logged, `onFatal` runs (closing the database) and the process exits 1;
 * Docker's restart policy or the dev watcher brings it back.
 */
export function installProcessHandlers(
  onFatal: () => void,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  process.on("unhandledRejection", (reason) => {
    console.error("[Process] Unhandled promise rejection:", reason);
  });
  process.on("uncaughtException", (error) => {
    console.error("[Process] Uncaught exception; exiting:", error);
    try {
      onFatal();
    } finally {
      exit(1);
    }
  });
}
