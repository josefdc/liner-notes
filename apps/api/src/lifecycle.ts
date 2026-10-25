/**
 * Process lifecycle: graceful shutdown on a signal, and logging of process-level errors. Kept
 * apart from index.ts so it can be tested with a real server and no process exit.
 */

import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { logger, scrub } from "./logger.js";

const log = logger("Server");

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
        log.info(`${signal} again while shutting down; ignored as a duplicate`);
        return;
      }
      log.warn(`${signal} again; exiting now`);
      exit(1);
      return;
    }
    startedAt = now();
    log.info(`${signal} received; shutting down`);

    stopBackground();

    const forced = setTimeout(() => {
      log.error("Connections still open after the shutdown timeout; exiting");
      void closeOnce().then(() => exit(1));
    }, timeoutMs);
    forced.unref();

    const drain = setTimeout(() => server.closeAllConnections(), drainMs);
    drain.unref();

    // Stops accepting connections and closes idle ones; the callback runs once every open
    // connection has ended. On Node 26 a connection whose first request head has not been parsed
    // yet counts as idle too, so it is closed here and not drained.
    server.close(() => {
      clearTimeout(forced);
      clearTimeout(drain);
      void closeOnce().then(() => {
        log.info("Stopped");
        exit(0);
      });
    });
  };
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * Holds requests while some startup work runs: `handler` passes requests on at once, except
 * while the promise given to `until` is pending, when they wait for it (whether it resolves or
 * rejects).
 */
export function requestGate(handler: Handler): {
  handler: Handler;
  until: (work: Promise<unknown>) => Promise<void>;
} {
  let held: Promise<void> | null = null;
  return {
    handler: (req, res) => {
      if (held) void held.then(() => handler(req, res));
      else handler(req, res);
    },
    until: (work) => {
      const done = work.then(
        () => {},
        () => {},
      );
      held = done.then(() => {
        held = null;
      });
      return held;
    },
  };
}

/** Errors a standard stream reports when its reader has gone (e.g. the dev launcher exited). */
const READER_GONE = new Set(["EPIPE", "ERR_STREAM_DESTROYED"]);

/**
 * Logs a rejected promise nobody handled and keeps serving: it is a bug, but not one that should
 * take every other request down with it. After an uncaught exception the process state is
 * unknown, so it is logged, `onFatal` runs (closing the database) and the process exits 1;
 * Docker's restart policy or the dev watcher brings it back.
 *
 * A closed stdout or stderr (the process reading the log has exited) is not fatal: the log
 * lines are lost, but a shutdown in progress still drains and records its runs.
 */
export function installProcessHandlers(
  onFatal: () => void,
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code && READER_GONE.has(error.code)) return;
      throw error;
    });
  }
  process.on("unhandledRejection", (reason) => {
    logger("Process").error("Unhandled promise rejection", { err: reason });
  });
  process.on("uncaughtException", (error) => {
    // Whatever happens to the log line, the store is still closed and the process exits 1.
    try {
      try {
        logger("Process").error("Uncaught exception; exiting", { err: error });
      } catch {
        process.stderr.write(`Uncaught exception; exiting: ${scrub(error)}\n`);
      }
      onFatal();
    } finally {
      exit(1);
    }
  });
}
