/**
 * The API's log: one JSON object per line on stdout (and appended to LOG_FILE when it is set),
 * written by pino.
 *
 * - Every line written while an analysis runs carries its run id (`runId`): the analyze routes
 *   run each analysis inside `withRun`, and the id follows the run's async chain (graph nodes,
 *   sources, timers) through an AsyncLocalStorage. Work a queue shared by runs carries out must
 *   be bound to its caller (`AsyncLocalStorage.bind`); work runs share (one token refresh for
 *   all) is logged under the run that started it.
 * - Nothing secret reaches a line. Before a line is serialized, fields whose name says they are
 *   secret (keys, tokens, passwords, Authorization and other headers, preview links, the
 *   provider endpoint, request and response objects) are replaced; errors are reduced to a few
 *   known properties; and every string (the message, string fields, error messages and stacks)
 *   is scrubbed of configured secret values, Authorization values and Bearer tokens, keys and
 *   signatures in URLs, the provider endpoint and preview links (Spotify p.scdn.co, Deezer
 *   dzcdn.net). The serialized line is then searched once more for the configured secret values
 *   and endpoint hosts only, so a line is always valid JSON.
 * - The text a visitor typed (`query` fields) is written at debug level only; at info and above
 *   only its length is.
 * - A log call never throws because of what it was given: fields that cannot be read give a line
 *   that says so.
 * - `installConsoleBridge` sends console.log/info/warn/error/debug through the same logger, so
 *   modules that still call console write JSON lines with the run id too.
 *
 * LOG_LEVEL (fatal, error, warn, info, debug, trace or silent; default info) and LOG_FILE are
 * read by `configureLogger`, which config/env.ts calls once the settings file is loaded.
 * LOG_IP_SALT keys the hash of client addresses in request lines (`ipHash`); without it each
 * process makes a key of its own, so the same address hashes alike only within one process.
 * Every level goes to stdout (errors included), as one stream.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, generateKeySync, type KeyObject } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, statSync, writeSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { format } from "node:util";
import pino, { type DestinationStream, type Level, type LevelWithSilent } from "pino";

// =============================================================================
// Run context
// =============================================================================

interface RunContext {
  runId: string;
  signal?: AbortSignal;
  /** When the run's deadline passes, on the monotonic clock (`performance.now()`). */
  deadlineAt?: number;
}

const runContext = new AsyncLocalStorage<RunContext>();

/**
 * Runs `fn` as part of run `runId`: every line logged from it (sync or async) carries the id.
 * `signal` is the run's own signal, the one a cancel of the run aborts (a client that left, the
 * run's deadline); `deadlineAt` is when that deadline passes, on the monotonic clock
 * (`performance.now()`). Inside an outer `withRun` without them, the outer ones are kept.
 */
export function withRun<T>(
  runId: string,
  fn: () => T,
  options: { signal?: AbortSignal; deadlineAt?: number } = {},
): T {
  const outer = runContext.getStore();
  const signal = options.signal ?? outer?.signal;
  const deadlineAt = options.deadlineAt ?? outer?.deadlineAt;
  return runContext.run(
    { runId, ...(signal ? { signal } : {}), ...(deadlineAt !== undefined ? { deadlineAt } : {}) },
    fn,
  );
}

/** The id of the run the current code belongs to, if any. */
export function currentRunId(): string | undefined {
  return runContext.getStore()?.runId;
}

/** The signal of the run the current code belongs to, when the run was given one. */
export function currentRunSignal(): AbortSignal | undefined {
  return runContext.getStore()?.signal;
}

/**
 * How many milliseconds the run the current code belongs to has left before its deadline, on
 * the monotonic clock; undefined when the run was given no deadline (a graph run outside the
 * routes).
 */
export function currentRunTimeLeft(): number | undefined {
  const deadlineAt = runContext.getStore()?.deadlineAt;
  return deadlineAt === undefined ? undefined : deadlineAt - performance.now();
}

// =============================================================================
// Scrubbing
// =============================================================================

const REDACTED = "[redacted]";
const PREVIEW_LINK = "[preview link]";
const PROVIDER_ENDPOINT = "[provider endpoint]";
/** What a log call writes when the fields it was given cannot be read. */
const UNWRITABLE = "log line could not be written";

/** Longest text scrubbed and written, in characters; the rest is cut off. */
export const MAX_LOGGED_TEXT = 16 * 1024;
const TRUNCATED = "…[truncated]";

/** Hosts of the signed 30-second preview clips: Spotify's and Deezer's. */
const PREVIEW_HOST = /(?:^|\.)(?:p\.scdn\.co|dzcdn\.net)$/i;
/** A preview host written without a scheme, with whatever path and query follow it. */
const BARE_PREVIEW =
  /(?<![\w.-])(?:(?:[\w-]{1,63}\.){0,8}dzcdn\.net|p\.scdn\.co)(?![\w-])(?:[/?#][^\s"'<>`]*)?/gi;
/** Azure OpenAI resource hosts, configured or not. Starts only at a host's first character. */
const PROVIDER_HOST =
  /(?<![a-z0-9.-])[a-z0-9][a-z0-9.-]{0,252}\.(?:openai|cognitiveservices|services\.ai)\.azure\.com(?![a-z0-9-])/gi;
const URL_IN_TEXT = /\bhttps?:\/\/[^\s"'<>\\`]+/gi;
/** Credentials written into a URL (`https://user:password@host`). */
const USERINFO = /^(https?:\/\/)[^/?#@\s]+@/i;
/** Query parameters that carry a key, a token or a signature (run tokens and Turnstile's too). */
const SECRET_PARAM =
  /([?&;~](?:api[-_]?key|apikey|api[-_]?sig|sk|key|token|access[-_]?token|run[-_]?token|turnstile[-_]?token|client[-_]?secret|secret|sig|signature|hdnea|hdnts|auth|password|subscription[-_]?key|x-amz-signature|x-amz-credential)=)[^&#\s"'<>\\]*/gi;
/** Authorization values: a Bearer token, Basic credentials, a Discogs token; quoted or not. */
const AUTH_SCHEME =
  /\b(Bearer\s+|Discogs\s+token=)(?!["']?\[redacted\])["']?[^\s"',;}\]]+["']?|\b(Basic\s+)["']?[A-Za-z0-9+/=]{8,}["']?/gi;
/**
 * `name: value` or `name=value` pairs whose name says the value is secret; quoted or not. The
 * whitespace after ":" or "=" is taken whole (a value never starts with a space), so a long run
 * of it is not read again from each of its characters.
 */
export const SECRET_PAIR =
  /\b((?:x-)?api[-_]?key|apikey|(?:ocp-apim-)?subscription[-_]?key|authorization|access[-_]?token|refresh[-_]?token|run[-_]?token|turnstile[-_]?token|client[-_]?secret|password|secret|token)(["']?\s*[:=]\s*(?!\s))(?!\s*(?:(?:Bearer|Basic|Discogs)\s+)?["']?\[redacted\])(?:(?:Bearer|Basic|Discogs)\s+)?["']?[^\s"'&,;}\]]+["']?/gi;

/** Environment variables whose values are never written: keys, secrets, tokens, endpoints. */
const SECRET_ENV_NAME = /(?:KEY|SECRET|TOKEN|PASSWORD|SALT|ENDPOINT|BASE_URL)$/;
/** Values shorter than this, or only digits, are not scrubbed (they match ordinary text). */
const MIN_SECRET_LENGTH = 8;
const NUMERIC = /^[\d.]+$/;

let secretValues: string[] = [];
/** The same values as they appear inside a JSON string, where they differ. */
let escapedSecretValues: string[] = [];
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
      if (trimmed.length >= MIN_SECRET_LENGTH && !NUMERIC.test(trimmed)) values.add(trimmed);
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
  escapedSecretValues = secretValues
    .map((value) => JSON.stringify(value).slice(1, -1))
    .filter((escaped, i) => escaped !== secretValues[i]);
  secretHosts = [...hosts].sort((a, b) => b.length - a.length);
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return /^https?:\/\/([^/?#:]+)/i.exec(url)?.[1] ?? null;
  }
}

function replaceAll(text: string, values: readonly string[], replacement: string): string {
  let out = text;
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join(replacement);
  }
  return out;
}

/** Any value as text, without throwing. */
function asText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return String(value);
  } catch {
    return "[unreadable]";
  }
}

/**
 * Text made safe for the log: configured secret values, preview links, the provider endpoint,
 * keys and signatures in URLs, Authorization values and Bearer tokens are replaced, and text
 * longer than MAX_LOGGED_TEXT is cut off. Never throws.
 */
export function scrub(input: unknown): string {
  try {
    let out = replaceAll(asText(input), secretValues, REDACTED);
    if (out.length > MAX_LOGGED_TEXT) out = `${out.slice(0, MAX_LOGGED_TEXT)}${TRUNCATED}`;
    out = out.replace(URL_IN_TEXT, (url) => {
      const host = hostOf(url);
      if (host && PREVIEW_HOST.test(host)) return PREVIEW_LINK;
      if (host && secretHosts.includes(host)) return PROVIDER_ENDPOINT;
      return url.replace(USERINFO, `$1${REDACTED}@`).replace(SECRET_PARAM, `$1${REDACTED}`);
    });
    out = replaceAll(out, secretHosts, PROVIDER_ENDPOINT);
    return out
      .replace(BARE_PREVIEW, PREVIEW_LINK)
      .replace(PROVIDER_HOST, PROVIDER_ENDPOINT)
      .replace(SECRET_PAIR, `$1$2${REDACTED}`)
      .replace(
        AUTH_SCHEME,
        (_match, scheme?: string, basic?: string) => `${scheme ?? basic}${REDACTED}`,
      );
  } catch {
    return "[unreadable]";
  }
}

/**
 * Where scrub replaces something in `text`, as [start, end) spans sorted by start, none
 * overlapping another: each of its rules read on `text` as it is (configured values and hosts,
 * links, preview and provider hosts, Authorization values, secret pairs). The spans hold all it
 * replaces before the cap but the quotes around a value, and may hold more. The redaction of
 * source errors (sources/http.ts) reads them, so that the log line of a text it redacts further
 * never shows what the log line of the text it redacted before hid. Reads the text once per rule.
 */
export function scrubbedSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const value of [...secretValues, ...escapedSecretValues, ...secretHosts]) {
    for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + value.length)) {
      spans.push([at, at + value.length]);
    }
  }
  for (const link of text.matchAll(URL_IN_TEXT)) {
    const url = link[0];
    const start = link.index;
    const host = hostOf(url);
    if (host && (PREVIEW_HOST.test(host) || secretHosts.includes(host))) {
      spans.push([start, start + url.length]);
      continue;
    }
    const userinfo = USERINFO.exec(url);
    if (userinfo) spans.push([start + (userinfo[1] ?? "").length, start + userinfo[0].length - 1]);
    for (const param of url.matchAll(SECRET_PARAM)) {
      const from = start + param.index + (param[1] ?? "").length;
      spans.push([from, start + param.index + param[0].length]);
    }
  }
  for (const pattern of [BARE_PREVIEW, PROVIDER_HOST]) {
    for (const match of text.matchAll(pattern)) {
      spans.push([match.index, match.index + match[0].length]);
    }
  }
  // A value, without the quotes the rule replaces with it: they delimit it.
  const value = (from: number, to: number) => {
    let start = from;
    let end = to;
    if (/["']/.test(text.charAt(start))) start++;
    if (end > start && /["']/.test(text.charAt(end - 1))) end--;
    spans.push([start, end]);
  };
  for (const pair of text.matchAll(SECRET_PAIR)) {
    value(
      pair.index + (pair[1] ?? "").length + (pair[2] ?? "").length,
      pair.index + pair[0].length,
    );
  }
  for (const auth of text.matchAll(AUTH_SCHEME)) {
    value(auth.index + (auth[1] ?? auth[3] ?? "").length, auth.index + auth[0].length);
  }
  // Sorted by start, those that overlap or touch as one.
  const merged: Array<[number, number]> = [];
  for (const [start, end] of spans.filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/**
 * The last pass, over the serialized line: only the configured secret values (as JSON writes
 * them) and endpoint hosts, which no JSON syntax is part of. A line this pass would make
 * unreadable is written as it was (its strings were scrubbed already).
 */
function scrubLine(line: string): string {
  try {
    let out = replaceAll(line, secretValues, REDACTED);
    out = replaceAll(out, escapedSecretValues, REDACTED);
    out = replaceAll(out, secretHosts, PROVIDER_ENDPOINT);
    if (out === line) return line;
    JSON.parse(out);
    return out;
  } catch {
    return withheldLine(line);
  }
}

/**
 * A line in which a configured secret could not be replaced without breaking
 * its JSON is not written; a short line saying so keeps its level, time,
 * component and run id.
 */
function withheldLine(line: string): string {
  const kept: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    for (const field of ["level", "time", "pid", "component", "runId"]) {
      const value = parsed[field];
      if (typeof value === "string" || typeof value === "number") kept[field] = value;
    }
  } catch {
    kept.level = "warn";
  }
  kept.msg = "log line withheld: it contained a configured secret";
  return `${JSON.stringify(kept)}\n`;
}

/** Fields whose value is never written, whatever it holds: these names exactly… */
const SECRET_FIELD =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|headers|key|sig|signature|preview|endpoint|base[-_]?url|baseurl|config|request|response|body)$/i;
/** …and any name that contains one of these. */
const SECRET_FIELD_PART =
  /token|secret|api[-_]?key|password|passwd|subscription[-_]?key|credential|preview[-_]?url/i;
/** Counts named after tokens (`inputTokens`, `tokenCount`, `input_tokens_details`), not secrets. */
const TOKEN_COUNT_FIELD = /tokens$|token[-_]?count$|tokens?[-_]details$/i;
/** Fields that hold text a visitor typed: written at debug level only. */
const QUERY_FIELD = /^(?:query|songQuery|q)$/;

const MAX_DEPTH = 6;
const MAX_ITEMS = 50;
const MAX_ERRORS = 10;
const LEVEL_DEBUG = 20;
const LEVEL_INFO = 30;

/**
 * Whether a field's value is replaced. Numbers and booleans are kept whatever the name
 * (`apiKeyConfigured: true`, `response: 503`); a list under a token-count name is still a list
 * of secrets (`refreshTokens`).
 */
function isSecretField(name: string, value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "number" || typeof value === "boolean") return false;
  if (SECRET_FIELD.test(name)) return true;
  if (!SECRET_FIELD_PART.test(name)) return false;
  return Array.isArray(value) || !TOKEN_COUNT_FIELD.test(name);
}

/** How long a typed query was: characters of a string, items of a list, text of anything else. */
function queryLength(value: unknown): number {
  if (typeof value === "string") return [...value].length;
  if (Array.isArray(value)) return value.length;
  try {
    return (JSON.stringify(value) ?? "").length;
  } catch {
    return 0;
  }
}

/** Reads one property, or undefined when reading it throws. */
function read(object: object, key: string): unknown {
  try {
    return (object as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/**
 * An error as a log field: its type, scrubbed message and stack, code, status, the kind of
 * failure and how long to wait (the API's own errors), why an answer was cut off, its cause and
 * the errors of an AggregateError. Nothing else an error carries (a client's request config,
 * headers, a response body) is kept. Never throws.
 */
export function serializeError(err: unknown, depth = 0): unknown {
  try {
    if (!(err instanceof Error)) {
      return err !== null && typeof err === "object" ? sanitize(err, LEVEL_INFO, depth) : err;
    }
    const out: Record<string, unknown> = {
      type: scrub(read(err, "name") ?? "Error"),
      message: scrub(read(err, "message") ?? ""),
    };
    const code = read(err, "code");
    if (typeof code === "number") out.code = code;
    else if (typeof code === "string") out.code = scrub(code).slice(0, 100);
    const status = read(err, "status");
    const statusCode = read(err, "statusCode");
    if (typeof status === "number") out.status = status;
    else if (typeof statusCode === "number") out.status = statusCode;
    for (const key of ["kind", "source", "incompleteReason"]) {
      const value = read(err, key);
      if (typeof value === "string") out[key] = scrub(value).slice(0, 100);
    }
    const retryAfterMs = read(err, "retryAfterMs");
    if (typeof retryAfterMs === "number" || retryAfterMs === null) out.retryAfterMs = retryAfterMs;
    const stack = read(err, "stack");
    if (stack !== undefined) out.stack = scrub(stack);
    const cause = read(err, "cause");
    if (cause !== undefined && depth < 3) out.cause = serializeError(cause, depth + 1);
    const errors = read(err, "errors");
    if (err instanceof AggregateError && Array.isArray(errors) && depth < 3) {
      out.errors = errors.slice(0, MAX_ERRORS).map((each) => serializeError(each, depth + 1));
    }
    return out;
  } catch {
    return { type: "Error", message: "[unreadable error]" };
  }
}

/**
 * A log field made safe: secret fields replaced, errors serialized, strings scrubbed, a typed
 * query replaced by its length unless the line is at debug level or below. Never throws: what
 * cannot be read is written as "[unreadable]".
 */
function sanitize(value: unknown, level: number, depth = 0): unknown {
  try {
    if (typeof value === "string") return scrub(value);
    if (value === null || typeof value !== "object") return value;
    if (value instanceof Error) return serializeError(value, depth);
    if (depth >= MAX_DEPTH) return "[nested too deep]";
    if (value instanceof Date) return value.toISOString();
    if (ArrayBuffer.isView(value)) return `[${value.byteLength} bytes]`;
    if (Array.isArray(value)) {
      const items = value.slice(0, MAX_ITEMS).map((item) => sanitize(item, level, depth + 1));
      if (value.length > MAX_ITEMS) items.push(`[${value.length - MAX_ITEMS} more]`);
      return items;
    }
    const out: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(value)) {
      if (isSecretField(key, field)) out[key] = REDACTED;
      else if (QUERY_FIELD.test(key) && level > LEVEL_DEBUG) {
        out[`${key}Length`] = queryLength(field);
      } else out[key] = sanitize(field, level, depth + 1);
    }
    return out;
  } catch {
    return "[unreadable]";
  }
}

// =============================================================================
// Client addresses
// =============================================================================

/** The key of the address hash: LOG_IP_SALT, or a key made for this process. */
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
      `Could not write to LOG_FILE ${file.path}; logging to stdout only: ${scrub(error)}\n`,
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

/** The arguments of a log call made safe (fields sanitized, strings scrubbed). Never throws. */
function safeArgs(args: unknown[], level: number): unknown[] {
  const [first, ...rest] = args;
  try {
    const strings = rest.map((arg) => (typeof arg === "string" ? scrub(arg) : arg));
    if (first !== null && typeof first === "object") {
      const fields = first instanceof Error ? { err: first } : first;
      return [sanitize(fields, level), ...strings];
    }
    return [typeof first === "string" ? scrub(first) : first, ...strings];
  } catch {
    const component =
      first !== null && typeof first === "object" ? read(first, "component") : undefined;
    return [typeof component === "string" ? { component: scrub(component) } : {}, UNWRITABLE];
  }
}

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
        method.apply(this, safeArgs(args, level) as Parameters<typeof method>);
      },
      streamWrite: scrubLine,
    },
  },
  destination,
);

function initialLevel(env: NodeJS.ProcessEnv): LevelWithSilent {
  const level = env.LOG_LEVEL?.trim().toLowerCase();
  return level && isLevel(level) ? level : "info";
}

/**
 * Opens LOG_FILE for appending, readable by its owner only when it is created. Anything that is
 * not a regular file (a FIFO would hold startup until something reads it) is refused. Returns
 * the descriptor, or why the file is not used; `warning` is a concern about a file that is used.
 */
function openLogFile(path: string): { fd?: number; refused?: string; warning?: string } {
  try {
    const existing = statSync(path, { throwIfNoEntry: false });
    if (existing && !existing.isFile()) return { refused: "is not a regular file" };
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK,
      0o600,
    );
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      closeSync(fd);
      return { refused: "is not a regular file" };
    }
    const warning =
      (opened.mode & 0o077) !== 0
        ? `LOG_FILE ${path} can be read or written by other users (mode ${(opened.mode & 0o777).toString(8)}); chmod 600 it`
        : undefined;
    return { fd, warning };
  } catch (error) {
    return { refused: `cannot be opened (${scrub(error)})` };
  }
}

/**
 * Reads LOG_LEVEL, LOG_FILE (a relative path is taken from `baseDir`) and LOG_IP_SALT, and the
 * secret values to scrub, from `env`. Returns warnings for settings it could not use (an unknown
 * level, a file it cannot or will not open) or that are unsafe (a file others can read).
 */
export function configureLogger(
  env: NodeJS.ProcessEnv = process.env,
  { baseDir = process.cwd() }: { baseDir?: string } = {},
): string[] {
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
  const given = env.LOG_FILE?.trim();
  if (given) {
    const path = isAbsolute(given) ? given : resolve(baseDir, given);
    const opened = openLogFile(path);
    if (opened.fd !== undefined) file = { fd: opened.fd, path };
    else warnings.push(`LOG_FILE ${path} ${opened.refused}; logging to stdout only`);
    if (opened.warning) warnings.push(opened.warning);
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
 * after the redaction above; pass an error as `err`. Never throws because of its fields.
 */
export function logger(component: string): Log {
  const write = (level: Level) => (message: string, fields?: Fields) => {
    let merged: Fields;
    try {
      merged = { component, ...fields };
    } catch {
      root[level]({ component }, UNWRITABLE);
      return;
    }
    root[level](merged, message);
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

/**
 * One console call as a log line: the text formatted as console would, every object and error
 * sanitized first, the first error as the line's `err`.
 */
function bridgeLine(level: Level, args: unknown[]): void {
  if (!root.isLevelEnabled(level)) return;
  let fields: Fields;
  let message: string;
  try {
    const levelValue = root.levels.values[level];
    const err = args.find((arg) => arg instanceof Error);
    const shown = args
      .filter((arg) => arg !== err)
      .map((arg) => (arg !== null && typeof arg === "object" ? sanitize(arg, levelValue) : arg));
    const text = format(...shown);
    const tag = LEADING_TAG.exec(text);
    const untagged = tag ? text.slice(tag[0].length) : text;
    // "Could not read the file:" followed by the error: the error is a field of its own.
    message = err ? untagged.replace(/:\s*$/, "") : untagged;
    fields = { ...(tag ? { component: tag[1] } : {}), ...(err ? { err } : {}) };
  } catch {
    fields = {};
    message = UNWRITABLE;
  }
  root[level](fields, message);
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
 * instead of writing them. Each line is parsed as it is written, so a line that is not JSON
 * fails the test. `onLine` sees each line as it is written; what it throws, the log call throws.
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
    const entry = JSON.parse(text) as Record<string, unknown>;
    onLine?.(entry);
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
