/**
 * The API's log: one JSON object per line on stdout (and appended to LOG_FILE when it is set),
 * written by pino.
 *
 * - Every line written while an analysis runs carries its run id (`runId`): the analyze routes
 *   run each analysis inside `withRun`, and the id follows the run's async chain (graph nodes,
 *   sources, timers) through an AsyncLocalStorage.
 * - Nothing secret reaches a line: fields with a secret's name (keys, tokens, Authorization and
 *   other headers, preview links, the provider endpoint) are replaced, errors are reduced to
 *   their name, message, code, status, stack and cause, and every line is scrubbed of API keys,
 *   Bearer tokens, signed query parameters, the provider endpoint and preview links (Spotify
 *   p.scdn.co, Deezer dzcdn.net), whatever field they are in.
 * - The text a visitor typed (`query` fields) is written at debug level only; at info and above
 *   only its length is.
 * - `installConsoleBridge` sends console.log/info/warn/error/debug through the same logger, so
 *   modules that still call console write JSON lines with the run id too.
 *
 * LOG_LEVEL (fatal, error, warn, info, debug, trace or silent; default info) and LOG_FILE are
 * read by `configureLogger`, which config/env.ts calls once the settings file is loaded.
 * LOG_IP_SALT keys the hash of client addresses in request lines (`ipHash`); without it each
 * process picks a random key, so the same address hashes alike only within one process.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, generateKeySync, type KeyObject } from "node:crypto";
import { closeSync, mkdirSync, openSync, writeSync } from "node:fs";
import { dirname } from "node:path";
import { format } from "node:util";
import pino, { type DestinationStream, type Level, type LevelWithSilent } from "pino";

// =============================================================================
// Run context
// =============================================================================

const runContext = new AsyncLocalStorage<string>();

/** Runs `fn` as part of run `runId`: every line logged from it (sync or async) carries the id. */
export function withRun<T>(runId: string, fn: () => T): T {
  return runContext.run(runId, fn);
}

/** The id of the run the current code belongs to, if any. */
export function currentRunId(): string | undefined {
  return runContext.getStore();
}

// =============================================================================
// Scrubbing
// =============================================================================

const REDACTED = "[redacted]";
const PREVIEW_LINK = "[preview link]";
const PROVIDER_ENDPOINT = "[provider endpoint]";

/** Hosts of the signed 30-second preview clips: Spotify's and Deezer's. */
const PREVIEW_HOST = /(?:^|\.)(?:p\.scdn\.co|dzcdn\.net)$/i;
/** Azure OpenAI resource hosts, configured or not. */
const PROVIDER_HOST =
  /\b[a-z0-9][a-z0-9-]*\.(?:openai\.azure\.com|cognitiveservices\.azure\.com|services\.ai\.azure\.com)\b/gi;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>\\`]+/gi;
/** Credentials written into a URL (`https://user:password@host`). */
const USERINFO = /^(https?:\/\/)[^/?#@\s]+@/i;
/** Query parameters that carry a key, a token or a signature. */
const SECRET_PARAM =
  /([?&;~](?:api[-_]?key|apikey|key|token|access[-_]?token|client[-_]?secret|secret|sig|signature|hdnea|hdnts|auth|password|x-amz-signature|x-amz-credential)=)[^&#\s"'<>\\]*/gi;
/** Authorization values: a Bearer token, Basic credentials, a Discogs token. */
const AUTH_SCHEME =
  /\b(Bearer\s+|Discogs\s+token=)(?!\[redacted\])[^\s"',;}\]]+|\b(Basic\s+)[A-Za-z0-9+/=]{8,}/gi;
/** `name: value` or `name=value` pairs whose name says the value is secret. */
const SECRET_PAIR =
  /\b((?:x-)?api[-_]?key|apikey|authorization|access[-_]?token|refresh[-_]?token|client[-_]?secret|password|secret|token)(["']?\s*[:=]\s*["']?)(?!\s*(?:(?:Bearer|Basic|Discogs)\s+)?\[redacted\])(?:(?:Bearer|Basic|Discogs)\s+)?[^\s"'&,;}\]]+/gi;

/** Environment variables whose values are never written: keys, secrets, tokens, endpoints. */
const SECRET_ENV_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|SALT|ENDPOINT|BASE_URL)$/;
/** Values shorter than this are not scrubbed as text (they would match ordinary words). */
const MIN_SECRET_LENGTH = 6;

let secretValues: string[] = [];
let secretHosts: string[] = [];

/** Reads the values to scrub from the environment: secrets, and the hosts of endpoint URLs. */
function collectSecrets(env: NodeJS.ProcessEnv): void {
  const values = new Set<string>();
  const hosts = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!value || !SECRET_ENV_NAME.test(name)) continue;
    const trimmed = value.trim();
    // An endpoint is scrubbed by its host, so a line still says it was the provider endpoint.
    if (!/^https?:\/\//i.test(trimmed)) {
      if (trimmed.length >= MIN_SECRET_LENGTH) values.add(trimmed);
    } else {
      try {
        const { host, hostname } = new URL(trimmed);
        if (hostname && hostname !== "localhost" && hostname !== "127.0.0.1") {
          hosts.add(host);
          hosts.add(hostname);
        }
      } catch {
        // not a URL after all
      }
    }
  }
  // Longest first, so a value that contains another is replaced whole.
  secretValues = [...values].sort((a, b) => b.length - a.length);
  secretHosts = [...hosts].sort((a, b) => b.length - a.length);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return /^https?:\/\/([^/?#:]+)/i.exec(url)?.[1] ?? null;
  }
}

/**
 * Text made safe for the log: known secret values, preview links, the provider endpoint, keys
 * and signatures in URLs, Authorization values and Bearer tokens are replaced.
 */
export function scrub(text: string): string {
  let out = text;
  for (const value of secretValues) {
    if (out.includes(value)) out = out.split(value).join(REDACTED);
  }
  out = out.replace(URL_IN_TEXT, (url) => {
    const host = hostOf(url);
    if (host && PREVIEW_HOST.test(host)) return PREVIEW_LINK;
    if (host && secretHosts.includes(host)) return PROVIDER_ENDPOINT;
    return url.replace(USERINFO, `$1${REDACTED}@`).replace(SECRET_PARAM, `$1${REDACTED}`);
  });
  for (const host of secretHosts) {
    if (out.includes(host)) out = out.split(host).join(PROVIDER_ENDPOINT);
  }
  return out
    .replace(PROVIDER_HOST, PROVIDER_ENDPOINT)
    .replace(SECRET_PAIR, `$1$2${REDACTED}`)
    .replace(
      AUTH_SCHEME,
      (_match, scheme?: string, basic?: string) => `${scheme ?? basic}${REDACTED}`,
    );
}

/** Fields whose value is never written, whatever it holds. */
const SECRET_FIELD =
  /^(?:api[-_]?key|apikey|authorization|proxy-authorization|cookie|set-cookie|headers|token|access[-_]?token|refresh[-_]?token|client[-_]?secret|secret|password|preview|preview[-_]?url|endpoint|base[-_]?url|baseurl|config|request|response)$/i;
/** Fields that hold text a visitor typed: written at debug level only. */
const QUERY_FIELD = /^(?:query|songQuery|q)$/;

const MAX_DEPTH = 6;
const MAX_ITEMS = 50;

/**
 * An error as a log field: its type, scrubbed message, code, status, scrubbed stack and cause.
 * Nothing else an error carries (a client's request config, headers, a response body) is kept.
 */
export function serializeError(err: unknown, depth = 0): unknown {
  if (!(err instanceof Error)) {
    return err !== null && typeof err === "object" ? sanitize(err, LEVEL_INFO, depth) : err;
  }
  const { code, status, statusCode } = err as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  const out: Record<string, unknown> = { type: err.name, message: scrub(err.message) };
  if (typeof code === "string" || typeof code === "number") out.code = code;
  const httpStatus = typeof status === "number" ? status : statusCode;
  if (typeof httpStatus === "number") out.status = httpStatus;
  if (err.stack) out.stack = scrub(err.stack);
  if (err.cause !== undefined && depth < 3) out.cause = serializeError(err.cause, depth + 1);
  return out;
}

const LEVEL_DEBUG = 20;
const LEVEL_INFO = 30;

/**
 * A log field made safe: secret fields replaced, errors serialized, strings scrubbed, a typed
 * query replaced by its length unless the line is at debug level or below.
 */
function sanitize(value: unknown, level: number, depth = 0): unknown {
  if (typeof value === "string") return scrub(value);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Error) return serializeError(value, depth);
  if (depth >= MAX_DEPTH) return "[nested too deep]";
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_ITEMS).map((item) => sanitize(item, level, depth + 1));
    if (value.length > MAX_ITEMS) items.push(`[${value.length - MAX_ITEMS} more]`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) {
    if (SECRET_FIELD.test(key)) out[key] = REDACTED;
    else if (QUERY_FIELD.test(key) && typeof field === "string" && level > LEVEL_DEBUG) {
      out[`${key}Length`] = [...field].length;
    } else out[key] = sanitize(field, level, depth + 1);
  }
  return out;
}

// =============================================================================
// Client addresses
// =============================================================================

/**
 * The key of the address hash: LOG_IP_SALT, or a random key made for this
 * process. It is a secret used only to hash client addresses in logs; it is
 * never shown, stored or used as data about a track.
 */
const processKey = () => generateKeySync("hmac", { length: 256 });
let ipSalt: KeyObject | string = processKey();

/**
 * A keyed hash of a client address (16 hex characters), so requests from one address can be
 * told apart without the address being written.
 */
export function ipHash(ip: string | undefined): string | undefined {
  if (!ip) return undefined;
  return createHmac("sha256", ipSalt).update(ip).digest("hex").slice(0, 16);
}

// =============================================================================
// Logger
// =============================================================================

export const LOG_LEVELS = ["fatal", "error", "warn", "info", "debug", "trace", "silent"] as const;

function isLevel(value: string): value is LevelWithSilent {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Where lines go: stdout (whose errors lifecycle.ts handles), and the LOG_FILE descriptor. */
let sink: (line: string) => void = (line) => {
  process.stdout.write(line);
};
let file: { fd: number; path: string } | null = null;

function writeFileLine(line: string): void {
  if (!file) return;
  try {
    writeSync(file.fd, line);
  } catch (error) {
    // Reported once on stderr (not through the logger, which would try the file again).
    process.stderr.write(
      `Could not write to LOG_FILE ${file.path}; logging to stdout only: ${String(error)}\n`,
    );
    file = null;
  }
}

const destination: DestinationStream = {
  write(line: string) {
    sink(line);
    writeFileLine(line);
  },
};

const root = pino(
  {
    level: initialLevel(process.env),
    base: { pid: process.pid },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    mixin: () => {
      const runId = currentRunId();
      return runId ? { runId } : {};
    },
    serializers: { err: (err: unknown) => serializeError(err) },
    hooks: {
      logMethod(args, method, level) {
        const [first, ...rest] = args as unknown[];
        if (first !== null && typeof first === "object") {
          const fields = first instanceof Error ? { err: first } : first;
          const strings = rest.map((arg) => (typeof arg === "string" ? scrub(arg) : arg));
          method.apply(this, [sanitize(fields, level), ...strings] as Parameters<typeof method>);
          return;
        }
        method.apply(
          this,
          args.map((arg) => (typeof arg === "string" ? scrub(arg) : arg)) as Parameters<
            typeof method
          >,
        );
      },
      // The last line of defence: anything that got past the fields is scrubbed as text.
      streamWrite: (line) => scrub(line),
    },
  },
  destination,
);

function initialLevel(env: NodeJS.ProcessEnv): LevelWithSilent {
  const level = env.LOG_LEVEL?.trim().toLowerCase();
  return level && isLevel(level) ? level : "info";
}

/**
 * Reads LOG_LEVEL, LOG_FILE and LOG_IP_SALT, and the secret values to scrub, from `env`.
 * Returns warnings for settings it could not use (an unknown level, a file it cannot open).
 */
export function configureLogger(env: NodeJS.ProcessEnv = process.env): string[] {
  const warnings: string[] = [];
  collectSecrets(env);

  const level = env.LOG_LEVEL?.trim().toLowerCase();
  if (level && !isLevel(level)) {
    warnings.push(`LOG_LEVEL=${scrub(level)} is not one of ${LOG_LEVELS.join(", ")}; using info`);
    root.level = "info";
  } else {
    root.level = (level || "info") as LevelWithSilent;
  }

  ipSalt = env.LOG_IP_SALT ? env.LOG_IP_SALT : processKey();

  if (file) {
    closeSync(file.fd);
    file = null;
  }
  const path = env.LOG_FILE?.trim();
  if (path) {
    try {
      mkdirSync(dirname(path), { recursive: true });
      file = { fd: openSync(path, "a"), path };
    } catch (error) {
      warnings.push(`LOG_FILE ${path} cannot be opened (${String(error)}); logging to stdout only`);
    }
  }
  return warnings;
}

type Fields = Record<string, unknown>;

export interface Log {
  debug(message: string, fields?: Fields): void;
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
}

/**
 * The log of one part of the API (`component`, e.g. "Scout" or "HTTP"). Fields go into the line
 * as they are (after the redaction above); pass an error as `err`.
 */
export function logger(component: string): Log {
  const write = (level: Level) => (message: string, fields?: Fields) => {
    root[level]({ component, ...fields }, message);
  };
  return { debug: write("debug"), info: write("info"), warn: write("warn"), error: write("error") };
}

// =============================================================================
// Console bridge
// =============================================================================

type ConsoleMethod = "log" | "info" | "warn" | "error" | "debug";

const CONSOLE_LEVELS: Record<ConsoleMethod, Level> = {
  log: "info",
  info: "info",
  warn: "warn",
  error: "error",
  debug: "debug",
};

/** A leading "[Tag]" (after any emoji), taken as the line's component. */
const LEADING_TAG =
  /^\s*(?:(?:\p{Extended_Pictographic}|\u{FE0F}|\u{200D})+\s*)?\[([^\]\n]{1,40})\]:?\s*/u;

/** One console call as a log line: the text formatted as console would, the first error apart. */
function bridgeLine(level: Level, args: unknown[]): void {
  if (!root.isLevelEnabled(level)) return;
  const err = args.find((arg) => arg instanceof Error);
  const text = format(...args.filter((arg) => arg !== err));
  const tag = LEADING_TAG.exec(text);
  const untagged = tag ? text.slice(tag[0].length) : text;
  // "Could not read the file:" followed by the error: the error is a field of its own.
  const message = err ? untagged.replace(/:\s*$/, "") : untagged;
  root[level]({ ...(tag ? { component: tag[1] } : {}), ...(err ? { err } : {}) }, message);
}

/**
 * Sends console.log/info/warn/error/debug through the logger (as JSON lines, scrubbed, with the
 * run id). Returns a function that puts the console back.
 */
export function installConsoleBridge(target: Console = console): () => void {
  const originals = Object.fromEntries(
    (Object.keys(CONSOLE_LEVELS) as ConsoleMethod[]).map((method) => [method, target[method]]),
  ) as Record<ConsoleMethod, Console[ConsoleMethod]>;
  for (const [method, level] of Object.entries(CONSOLE_LEVELS) as [ConsoleMethod, Level][]) {
    target[method] = (...args: unknown[]) => bridgeLine(level, args);
  }
  return () => {
    Object.assign(target, originals);
  };
}

// =============================================================================
// Tests
// =============================================================================

export interface CapturedLogs {
  /** The lines written since the capture started, as written. */
  lines(): string[];
  /** The same lines, parsed. */
  entries(): Array<Record<string, unknown>>;
  /** The messages (`msg`) of the lines, or of the lines at `level`. */
  messages(level?: Level): string[];
  /** Forgets the lines captured so far. */
  clear(): void;
  /** Stops capturing: lines go to stdout again, at the previous level. */
  restore(): void;
}

/**
 * For tests: collects the lines written from now on (at `level` and above, debug by default)
 * instead of writing them. `onLine` sees each line as it is written; what it throws, the log
 * call throws.
 */
export function captureLogsForTests(
  options: { level?: LevelWithSilent; onLine?: (entry: Record<string, unknown>) => void } = {},
): CapturedLogs {
  const { level = "debug", onLine } = options;
  const previous = { sink, level: root.level };
  const lines: string[] = [];
  sink = (line) => {
    const text = line.replace(/\n$/, "");
    lines.push(text);
    onLine?.(JSON.parse(text) as Record<string, unknown>);
  };
  root.level = level;
  return {
    lines: () => [...lines],
    entries: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>),
    messages: (level) =>
      lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => level === undefined || entry.level === level)
        .map((entry) => String(entry.msg)),
    clear: () => {
      lines.length = 0;
    },
    restore: () => {
      sink = previous.sink;
      root.level = previous.level;
    },
  };
}
