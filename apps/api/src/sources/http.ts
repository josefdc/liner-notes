/**
 * The one way the source clients reach the network.
 *
 * Every request has a timeout, every failure is a typed SourceError, and responses can be
 * recorded to or replayed from a cassette:
 *
 *   SOURCE_CASSETTE=record   live requests; each response is scrubbed and written to the cassette
 *   SOURCE_CASSETTE=replay   no network: a request without a cassette entry fails (cassette_miss)
 *   SOURCE_CASSETTE_DIR      where cassettes live (default: apps/api/cassettes)
 *   SOURCE_TIMEOUT_MS        default timeout per request (default: 10000)
 *
 * Cassettes are for tests and evals: either mode is refused when NODE_ENV=production.
 *
 * Recorded payloads keep only the fields the pipeline reads (the request's `scrub`); every
 * recorded value, error and text bodies included, loses secrets, media URLs, e-mail addresses
 * and phone numbers, and long text is capped, so a cassette can be committed. Error messages
 * are redacted the same way before they reach a log or a tool result, and hold the status and at
 * most a short plain-text reason, never a response body (which is logged at debug level only).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCE_CREDENTIALS } from "../config/settings.js";
import { logger } from "../logger.js";
import { PaceRefused, pacingClock, type RequestPacer } from "./pacing.js";

const log = logger("sources");

// =============================================================================
// Redaction
// =============================================================================

/** Cap for recorded data the pipeline reads: well above what any consumer reads (800). */
const MAX_TEXT = 4000;
/** Cap for recorded error and text bodies, which only feed error handling and the debug log. */
const MAX_ERROR_TEXT = 500;
/** Cap for a source's own reason in an error message: a short line, never a body. */
const MAX_DETAIL = 120;

/** The source credentials, redacted whatever their length: each is sent on every request. */
const SOURCE_CREDENTIAL_NAMES: ReadonlySet<string> = new Set(Object.values(SOURCE_CREDENTIALS));

/** Values of the environment's credentials, so an echoed key is recognised wherever it appears. */
function knownSecrets(): string[] {
  return (
    Object.entries(process.env)
      .filter(([name, value]) =>
        SOURCE_CREDENTIAL_NAMES.has(name)
          ? Boolean(value)
          : /KEY|SECRET|TOKEN|PASSWORD/i.test(name) && (value?.length ?? 0) >= 8,
      )
      .map(([, value]) => value as string)
      // Longest first, so a key that contains a shorter one is removed whole.
      .sort((a, b) => b.length - a.length)
  );
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Case-sensitive and token-shaped, so prose such as "the basic track" is left alone.
  [/\b(Bearer|Basic) [A-Za-z0-9._~+/=-]{12,}/g, "$1 [redacted]"],
  [
    /\b(api_?key|key|token|access_token|refresh_token|client_secret|password|secret)=([^&\s"'<>]+)/gi,
    "$1=[redacted]",
  ],
  [/\btvly-[A-Za-z0-9_-]+/g, "tvly-[redacted]"],
  // Spotify access tokens, and any long mixed-case token-like run.
  [/\bBQ[A-Za-z0-9_-]{40,}/g, "[redacted]"],
  [
    /\b(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Z])(?=[A-Za-z0-9_-]*[a-z])[A-Za-z0-9_-]{64,}\b/g,
    "[redacted]",
  ],
];

/** Removes credentials from text: known key values, bearer tokens, `key=…` pairs, token shapes. */
function redactSecrets(text: string): string {
  let out = text;
  for (const secret of knownSecrets()) out = out.split(secret).join("[redacted]");
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Removes credentials from an error message or log line. Besides `redactSecrets`, a quoted value
 * in a message about a header is removed: fetch echoes an invalid header value, which is the
 * credential.
 */
export function redactText(text: string): string {
  const out = /header/i.test(text) ? text.replace(/"[^"]*"/g, '"[redacted]"') : text;
  return redactSecrets(out);
}

/** Ids the pipeline reads (MBIDs, Spotify ids, ISRCs) are never rewritten by a scrubber. */
const ID_SHAPED =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9A-Za-z]{22}|[A-Z]{2}[A-Z0-9]{3}\d{7})$/i;

const MEDIA_HOST =
  /(?:^|\.)(?:scdn\.co|dzcdn\.net|coverartarchive\.org|us\.archive\.org|lastfm\.freetls\.fastly\.net|mzstatic\.com|ytimg\.com|ggpht\.com)$/i;
const MEDIA_PATH =
  /\.(?:jpe?g|png|gif|webp|avif|svg|bmp|ico|heic|mp3|mp4|m4a|aac|ogg|oga|opus|flac|wav|webm|mov)$|\/images?(?:\/|$)/i;

/** True for a URL (absolute or protocol-relative) to an image, audio or video file or CDN. */
export function isMediaUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value.startsWith("//") ? `https:${value}` : value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return MEDIA_HOST.test(url.hostname) || MEDIA_PATH.test(url.pathname);
}

const URL_IN_TEXT = /(?:https?:)?\/\/[^\s"'<>()[\]{}]+/gi;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
// Not inside a longer token (a UUID's digit groups are not a phone number).
const PHONE_LIKE = /(?<![\w-])\+?\(?\d[\d\s().-]{7,}\d(?![\w-])/g;

const withoutMediaUrls = (text: string) =>
  text.replace(URL_IN_TEXT, (url) => (isMediaUrl(url) ? "[media]" : url));

/**
 * A string the pipeline reads, for a cassette: secrets redacted and media URLs removed, capped
 * well above what consumers read. Nothing else changes, so replay reproduces the recorded run;
 * id-shaped values are kept as they are.
 */
export function scrubReadText(text: string): string {
  if (ID_SHAPED.test(text)) return text;
  const out = withoutMediaUrls(redactSecrets(text));
  return out.length > MAX_TEXT ? out.slice(0, MAX_TEXT) : out;
}

/**
 * An error or text body for a cassette: secrets, media URLs, e-mails and phone numbers removed,
 * capped. These bodies only feed error handling and the debug log.
 */
export function scrubText(text: string): string {
  if (ID_SHAPED.test(text)) return text;
  const out = withoutMediaUrls(redactText(text))
    .replace(EMAIL, "[email]")
    .replace(PHONE_LIKE, (match) => {
      const digits = match.replace(/\D/g, "").length;
      const isDate = /^\d{4}-\d{2}-\d{2}/.test(match);
      return digits >= 9 && digits <= 15 && !isDate ? "[phone]" : match;
    });
  return out.length > MAX_ERROR_TEXT ? out.slice(0, MAX_ERROR_TEXT) : out;
}

// =============================================================================
// Typed errors
// =============================================================================

export type SourceName =
  | "spotify"
  | "musicbrainz"
  | "listenbrainz"
  | "lastfm"
  | "deezer"
  | "discogs"
  | "secondhandsongs"
  | "genius"
  | "tavily"
  | "audio";

export type SourceErrorKind =
  /** The source is not configured (e.g. no API key); nothing was requested. */
  | "unavailable"
  /** The input was rejected before any request (e.g. a malformed id). */
  | "invalid_input"
  | "timeout"
  /** The caller's signal aborted the request. */
  | "aborted"
  /** DNS, connection or TLS failure. */
  | "network"
  /** 429, or the source's own "slow down" status; `retryAfterMs` when the source said. */
  | "rate_limited"
  /** Any other non-2xx status; `status` and `body` hold the answer. */
  | "http"
  /** A 2xx answer that is not JSON (e.g. an HTML bot challenge). */
  | "content_type"
  /** A JSON content type whose body does not parse, or a body of the wrong shape. */
  | "parse"
  /** Replay mode and the cassette has no entry for this request. */
  | "cassette_miss"
  /** A cassette could not be read, parsed or written. */
  | "cassette_io";

export class SourceError extends Error {
  override readonly name = "SourceError";
  readonly status?: number;
  readonly retryAfterMs?: number;
  /** The error body: parsed JSON, or capped text. */
  readonly body?: unknown;

  constructor(
    readonly source: SourceName,
    readonly kind: SourceErrorKind,
    message: string,
    details: { status?: number; retryAfterMs?: number; body?: unknown; cause?: unknown } = {},
  ) {
    super(
      redactText(`${source}: ${message}`),
      details.cause === undefined ? {} : { cause: details.cause },
    );
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
    this.body = details.body;
  }
}

export function isSourceError(error: unknown, kind?: SourceErrorKind): error is SourceError {
  return error instanceof SourceError && (kind === undefined || error.kind === kind);
}

/** One line for logs and tool results, with credentials redacted. */
export function describeError(error: unknown): string {
  return redactText(error instanceof Error ? error.message : String(error));
}

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Identifies the app to the APIs that ask for it (MusicBrainz requires a name, version and
 * contact). Override with SOURCE_USER_AGENT (or MUSICBRAINZ_USER_AGENT).
 */
export function userAgent(): string {
  return (
    process.env.SOURCE_USER_AGENT ||
    process.env.MUSICBRAINZ_USER_AGENT ||
    "LinerNotes/0.1.0 ( https://github.com/josefdc/liner-notes )"
  );
}

function defaultTimeoutMs(): number {
  const value = Number(process.env.SOURCE_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

type CassetteMode = "off" | "record" | "replay";

function requestedMode(): CassetteMode {
  const mode = process.env.SOURCE_CASSETTE?.trim() ?? "";
  if (mode === "record" || mode === "replay") return mode;
  if (mode === "" || mode === "off") return "off";
  throw new Error(`SOURCE_CASSETTE: expected "record", "replay" or "off", got "${mode}"`);
}

/**
 * Throws on an unknown SOURCE_CASSETTE value, and when a cassette mode is set in production;
 * called at startup and on every request.
 */
export function assertCassetteAllowed(): void {
  const mode = requestedMode();
  if (mode !== "off" && process.env.NODE_ENV === "production") {
    throw new Error(
      `SOURCE_CASSETTE=${mode} is not allowed when NODE_ENV=production: cassettes are for tests ` +
        "and evals. Unset SOURCE_CASSETTE.",
    );
  }
}

let loggedMode: CassetteMode | null = null;

export function cassetteMode(): CassetteMode {
  assertCassetteAllowed();
  const mode = requestedMode();
  if (mode !== "off" && loggedMode !== mode) {
    loggedMode = mode;
    log.warn(
      `SOURCE_CASSETTE=${mode}: ${
        mode === "replay" ? "answers come from" : "answers are recorded to"
      } ${cassetteDir()}`,
    );
  }
  return mode;
}

// A cassette mode in production stops the server at startup, not at the first request.
assertCassetteAllowed();

function apiRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    dir = dirname(dir);
  }
  return process.cwd();
}

/**
 * A credential from the environment. Under replay nothing is sent, so a missing credential is
 * a placeholder and the cassette decides the answer. In any other mode a missing credential
 * stays missing.
 */
export function credential(name: string): string | undefined {
  const value = process.env[name];
  if (value) return value;
  return requestedMode() === "replay" && cassetteMode() === "replay" ? "replay" : undefined;
}

export function cassetteDir(): string {
  return process.env.SOURCE_CASSETTE_DIR || join(apiRoot(), "cassettes");
}

// =============================================================================
// Scrubbing
// =============================================================================

/**
 * Which fields of a payload to keep: `true` keeps the value, an object keeps the listed keys,
 * `[shape]` applies the shape to each item. A single object where a list is expected (Last.fm
 * sends one tag as an object) is kept as an object, so replay sees what the API sent.
 */
export type Shape = true | { readonly [key: string]: Shape } | readonly [Shape];

export function pick(value: unknown, shape: Shape): unknown {
  if (shape === true || value === null || typeof value !== "object") return value;
  if (Array.isArray(shape)) {
    const item = shape[0];
    return Array.isArray(value) ? value.map((v) => pick(v, item)) : pick(value, item);
  }
  if (Array.isArray(value)) return value.map((v) => pick(v, shape));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(shape as Record<string, Shape>)) {
    if (key in value) out[key] = pick((value as Record<string, unknown>)[key], inner);
  }
  return out;
}

const SECRET_KEYS = new Set([
  "x-api-key",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "client_secret",
  "password",
  "token",
  "secret",
  "authorization",
]);
const MEDIA_KEY =
  /^(?:preview|images?|picture|cover|thumbnail|artwork|favicon|avatar)(?:[_-]?\w*)$/i;

function scrubWith(text: (value: string) => string) {
  const scrub = (value: unknown): unknown => {
    if (typeof value === "string") return isMediaUrl(value.trim()) ? null : text(value);
    if (Array.isArray(value)) return value.map(scrub);
    if (value === null || typeof value !== "object") return value;
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      if (MEDIA_KEY.test(key)) continue;
      out[key] = SECRET_KEYS.has(key.toLowerCase()) ? "[redacted]" : scrub(inner);
    }
    return out;
  };
  return scrub;
}

/**
 * Data the pipeline reads (a successful answer, already cut to its shape): drops preview and
 * image fields and media URLs and redacts secrets (by key and by value). Values are otherwise
 * kept byte for byte, so a replayed run matches the recorded one.
 */
export const scrubReadPayload = scrubWith(scrubReadText);

/**
 * An error body: as scrubReadPayload, and also masks e-mails and phone numbers and caps text.
 */
export const scrubPayload = scrubWith(scrubText);

const SECRET_PARAMS = new Set([
  "api_key",
  "apikey",
  "key",
  "token",
  "access_token",
  "client_secret",
  "secret",
  "password",
]);

/**
 * The cassette key: method, URL without credentials (secret parameters in any case, user info)
 * and a digest of the body, so two POSTs to one URL with different bodies are different entries.
 */
export function cassetteKey(method: string, url: string, body?: string): string {
  const parsed = new URL(url);
  parsed.username = "";
  parsed.password = "";
  for (const name of [...parsed.searchParams.keys()]) {
    if (SECRET_PARAMS.has(name.toLowerCase())) parsed.searchParams.delete(name);
  }
  parsed.searchParams.sort();
  const digest = body ? ` #${createHash("sha256").update(body).digest("hex").slice(0, 16)}` : "";
  return `${method} ${parsed.href}${digest}`;
}

// =============================================================================
// Cassettes
// =============================================================================

/** A response as it is recorded: exactly one of `json` and `text`. */
interface Recorded {
  status: number;
  contentType: string;
  retryAfterMs?: number;
  json?: unknown;
  text?: string;
}

interface Cassette {
  version: 1;
  entries: Record<string, Recorded>;
}

function cassettePath(source: SourceName): string {
  return join(cassetteDir(), `${source}.json`);
}

function parseCassette(source: SourceName, text: string): Cassette {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new SourceError(source, "cassette_io", `cassette is not valid JSON`, { cause: error });
  }
  const entries = (data as { entries?: unknown })?.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new SourceError(source, "cassette_io", "cassette has no entries object");
  }
  return { version: 1, entries: entries as Record<string, Recorded> };
}

function readCassette(source: SourceName): Cassette {
  const path = cassettePath(source);
  let text: string;
  try {
    if (!existsSync(path)) return { version: 1, entries: {} };
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new SourceError(source, "cassette_io", `cannot read cassette: ${describeError(error)}`);
  }
  return parseCassette(source, text);
}

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30_000;
let tmpCounter = 0;

/** False when no process has this pid (a recorder that crashed while holding the lock). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * A lock file shared with other recording processes, holding the owner's pid; returns the
 * release function. A lock whose owner is no longer alive, or older than 30 s, is broken.
 */
async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      return () => unlink(lock).catch(() => {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number(await readFile(lock, "utf8").catch(() => ""));
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      const dead = Number.isSafeInteger(owner) && owner > 0 && !processAlive(owner);
      if (dead || age > LOCK_STALE_MS) {
        // Only if it is still the same lock: another recorder may have broken it and taken it.
        const again = Number(await readFile(lock, "utf8").catch(() => ""));
        if (again === owner) await unlink(lock).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error(`cassette lock ${lock} is held`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

/** Adds one entry: under the lock, re-reads the file and replaces it atomically (temp + rename). */
async function writeEntry(source: SourceName, key: string, entry: Recorded): Promise<void> {
  const path = cassettePath(source);
  try {
    await mkdir(dirname(path), { recursive: true });
    const release = await acquireLock(path);
    try {
      const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      const cassette: Cassette =
        text === null ? { version: 1, entries: {} } : parseCassette(source, text);
      cassette.entries[key] = entry;
      const sorted = Object.fromEntries(
        Object.entries(cassette.entries).sort(([a], [b]) => a.localeCompare(b)),
      );
      // A partial write (full disk, crash) leaves the previous cassette intact.
      const tmp = `${path}.${process.pid}.${++tmpCounter}.tmp`;
      try {
        await writeFile(tmp, `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`);
        await rename(tmp, path);
      } catch (error) {
        await unlink(tmp).catch(() => {});
        throw error;
      }
    } finally {
      await release();
    }
  } catch (error) {
    if (isSourceError(error)) throw error;
    throw new SourceError(source, "cassette_io", `cannot write cassette: ${describeError(error)}`);
  }
}

// Writes from this process run one at a time; the lock file orders them with other processes.
let writeQueue: Promise<unknown> = Promise.resolve();

let lostRecordings = 0;

/** Counts an answer that could not be recorded; the count is reported once when the process exits. */
function recordingLost(): void {
  if (lostRecordings++ === 0) {
    process.once("exit", () => {
      log.warn(
        `SOURCE_CASSETTE=record: ${lostRecordings} answer(s) could not be recorded; ` +
          `the cassettes in ${cassetteDir()} are incomplete. Record again.`,
      );
    });
  }
}

function queueWrite(source: SourceName, key: string, entry: Recorded): Promise<void> {
  const next = writeQueue.then(() => writeEntry(source, key, entry));
  writeQueue = next.catch(() => {});
  return next;
}

// =============================================================================
// Requests
// =============================================================================

export interface SourceRequest {
  source: SourceName;
  url: string | URL;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Statuses that mean "slow down" (429 always; MusicBrainz also answers 503). */
  rateLimitStatuses?: readonly number[];
  /** The fields the pipeline reads, kept when a successful answer is recorded. */
  scrub?: Shape;
  /**
   * What a successful JSON answer is recorded as, before `scrub`: the source's own filter, so a
   * cassette keeps nothing the source would drop. Replaying it must give what the live answer
   * gave.
   */
  recordAs?: (json: unknown) => unknown;
  /** false: never recorded or replayed (local services). */
  cassette?: boolean;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  // A date in the past, or one that does not parse, says nothing: the caller's default applies.
  const date = Date.parse(value);
  return Number.isNaN(date) || date <= Date.now() ? undefined : date - Date.now();
}

const isJsonType = (contentType: string) => /\bjson\b/i.test(contentType);

/** Markup, also escaped as entities, once or more ("&lt;", "&#60;", "&#x3c;", "&amp;lt;"). */
export const MARKUP = /[<>]|&(?:amp;)*(?:lt|gt|#0*6[02]|#x0*3[ce]);/i;
/**
 * A stack trace: a JavaScript frame ("at fn (/path/file.js:10:5)", with a path, so "at 10:30:00"
 * is not one) or a Python traceback.
 */
const STACK_TRACE =
  /\bat\s+(?:\S+\s+\()?\S*[/\\.]\S*:\d+:\d+\)?|Traceback \(most recent call last\)|File "[^"]+", line \d+/;
/** A signature or token parameter, also in a link written without a scheme. */
const SIGNED_PARAM = /(?:^|[?&;~\s])(?:sig|signature|token|hdnts|hdnea)=|X-Amz-/i;

/**
 * A source's own reason for an error, as a short line of plain text: undefined when it is not a
 * string, is empty, or holds markup (an HTML page in a JSON field, also entity-escaped), a
 * stack trace or a signature or token parameter (a link without a scheme can carry one); links
 * become "[link]"; cut to MAX_DETAIL. Error
 * messages are stored with the result and sent to the client, so a page never reaches them.
 */
export function plainReason(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const line = text.replace(/\s+/g, " ").trim().replace(URL_IN_TEXT, "[link]");
  if (!line || MARKUP.test(line) || STACK_TRACE.test(line) || SIGNED_PARAM.test(line)) {
    return undefined;
  }
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line;
}

/** What an error status says, in words, for an answer that gave no plain-text reason. */
function statusReason(status: number): string | undefined {
  if (status === 401 || status === 403) return "the source refused the request";
  if (status === 404) return "not found";
  if (status === 400 || status === 422) return "the source rejected the request";
  if (status >= 500) return "the source could not answer";
  return undefined;
}

/**
 * A short human-readable detail from a JSON error body (Last.fm, Tavily, FastAPI, Spotify), as
 * plain text. A text body (an HTML error page, a bot challenge) gives none: it is logged at
 * debug level only.
 */
function errorDetail(body: unknown): string | undefined {
  if (typeof body === "string") return plainReason(body);
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  const nested = (v: unknown) =>
    v && typeof v === "object" ? (v as Record<string, unknown>).message : undefined;
  const detail = b.detail;
  const candidates = [
    b.message,
    nested(b.error),
    typeof b.error === "string" ? b.error : undefined,
    b.error_description,
    typeof detail === "string" ? detail : nested(detail),
    detail && typeof detail === "object" ? (detail as Record<string, unknown>).error : undefined,
  ];
  return candidates.map(plainReason).find((reason) => reason !== undefined);
}

/** Headers that carry a credential: such a request never follows a redirect off its origin. */
const CREDENTIAL_HEADERS = new Set(["authorization", "proxy-authorization", "x-api-key", "cookie"]);
const MAX_REDIRECTS = 5;
/** Headers that describe a request body; dropped when a redirect turns the request into a GET. */
const BODY_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-location",
]);

/**
 * Fetches `url`. A request that carries a credential follows redirects itself, and only within
 * its own origin: fetch drops Authorization on a cross-origin redirect but forwards other
 * headers (an X-API-Key), and a downgrade to http would send it in clear. As fetch does, a 303,
 * or a 301/302 answer to a POST, is followed as a GET without the body. The body of every
 * redirect answer is discarded, so its connection is released.
 */
async function fetchWithin(req: SourceRequest, url: string, init: RequestInit): Promise<Response> {
  const credentialed = Object.keys(req.headers ?? {}).some((name) =>
    CREDENTIAL_HEADERS.has(name.toLowerCase()),
  );
  if (!credentialed) return fetch(url, init);
  let current = new URL(url);
  let request: RequestInit = { ...init, redirect: "manual" };
  for (let hop = 0; ; hop++) {
    const response = await fetch(current, request);
    const location = response.headers.get("location");
    if (response.status < 300 || response.status > 399 || !location) return response;
    await response.body?.cancel().catch(() => {});
    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new SourceError(
        req.source,
        "parse",
        `HTTP ${response.status} redirect to a Location that is not a URL`,
        { status: response.status },
      );
    }
    if (next.origin !== current.origin) {
      throw new SourceError(
        req.source,
        "http",
        `HTTP ${response.status} redirect to ${next.origin} refused: the request carries a credential`,
        { status: response.status },
      );
    }
    if (hop >= MAX_REDIRECTS) {
      throw new SourceError(req.source, "http", "too many redirects", { status: response.status });
    }
    const method = (request.method ?? "GET").toUpperCase();
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === "POST")
    ) {
      const headers = Object.fromEntries(
        Object.entries((request.headers ?? {}) as Record<string, string>).filter(
          ([name]) => !BODY_HEADERS.has(name.toLowerCase()),
        ),
      );
      request = {
        ...request,
        method: method === "HEAD" ? "HEAD" : "GET",
        body: undefined,
        headers,
      };
    }
    current = next;
  }
}

/**
 * The error for a request stopped by its signal: "timeout" when the signal was a deadline
 * (AbortSignal.timeout), "aborted" when the caller cancelled it.
 */
export function abortError(source: SourceName, signal: AbortSignal, cause?: unknown): SourceError {
  const reason = signal.reason as { name?: string } | undefined;
  return reason?.name === "TimeoutError"
    ? new SourceError(source, "timeout", "deadline reached", { cause })
    : new SourceError(source, "aborted", "request aborted", { cause });
}

async function fetchLive(req: SourceRequest, url: string, method: string): Promise<Recorded> {
  const timeoutMs = req.timeoutMs ?? defaultTimeoutMs();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  try {
    const response = await fetchWithin(req, url, {
      method,
      headers: { "User-Agent": userAgent(), ...req.headers },
      body: req.body,
      signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    const text = await response.text();
    const recorded: Recorded = { status: response.status, contentType };
    const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"));
    if (retryAfterMs !== undefined) recorded.retryAfterMs = retryAfterMs;
    if (isJsonType(contentType)) {
      try {
        recorded.json = JSON.parse(text);
        return recorded;
      } catch {
        // Falls through: kept as text, reported as a parse error.
      }
    }
    recorded.text = text.slice(0, MAX_TEXT * 4);
    return recorded;
  } catch (error) {
    if (isSourceError(error)) throw error;
    if (req.signal?.aborted) throw abortError(req.source, req.signal, error);
    if (timeout.aborted) {
      throw new SourceError(req.source, "timeout", `no answer within ${timeoutMs} ms`, {
        cause: error,
      });
    }
    // No cause: a fetch error can echo a header value, which may be a credential.
    throw new SourceError(req.source, "network", describeError(error));
  }
}

/** Turns a live or replayed answer into data or a typed error. */
function interpret<T>(req: SourceRequest, answer: Recorded): T {
  const { source } = req;
  const body = answer.json !== undefined ? answer.json : answer.text;
  const ok = answer.status >= 200 && answer.status <= 299;
  if (answer.json === undefined && answer.text) {
    // An answer that is not JSON is an error; its text (an error page, a bot challenge) goes to
    // the debug log only, never into the error message.
    log.debug(`${source} answered HTTP ${answer.status} with a body that is not JSON`, {
      answerText: scrubText(answer.text),
    });
  }
  const detail = answer.json !== undefined ? errorDetail(answer.json) : undefined;
  const why = statusReason(answer.status);
  const reason = detail ? ` — ${detail}` : why ? ` (${why})` : "";
  const rateLimits = req.rateLimitStatuses ?? [429];
  if (rateLimits.includes(answer.status) || answer.status === 429) {
    const after = answer.retryAfterMs;
    const wait = after === undefined ? "" : `; retry after ${Math.ceil(after / 1000)} s`;
    throw new SourceError(source, "rate_limited", `rate limited (HTTP ${answer.status})${wait}`, {
      status: answer.status,
      retryAfterMs: after,
      body,
    });
  }
  if (!ok) {
    throw new SourceError(source, "http", `HTTP ${answer.status}${reason}`, {
      status: answer.status,
      body,
    });
  }
  if (!isJsonType(answer.contentType)) {
    const got = plainReason(answer.contentType.slice(0, 80)) ?? "no content type";
    throw new SourceError(source, "content_type", `expected JSON, got ${got}`, {
      status: answer.status,
      body: answer.text,
    });
  }
  if (answer.json === undefined) {
    throw new SourceError(source, "parse", "response body is not valid JSON", {
      status: answer.status,
      body: answer.text,
    });
  }
  return answer.json as T;
}

/**
 * The answer as it is written to a cassette: filtered by the source (`recordAs`) and picked (2xx
 * JSON), scrubbed, capped.
 */
function forCassette(req: SourceRequest, answer: Recorded): Recorded {
  const entry: Recorded = { status: answer.status, contentType: answer.contentType };
  if (answer.retryAfterMs !== undefined) entry.retryAfterMs = answer.retryAfterMs;
  const ok = answer.status >= 200 && answer.status <= 299;
  if (answer.json !== undefined) {
    const kept = ok && req.recordAs ? req.recordAs(answer.json) : answer.json;
    entry.json = ok
      ? scrubReadPayload(req.scrub ? pick(kept, req.scrub) : kept)
      : scrubPayload(answer.json);
  } else {
    entry.text = scrubText(answer.text ?? "");
  }
  return entry;
}

/**
 * Requests JSON from a source. Resolves with the parsed body of a 2xx JSON answer; anything
 * else rejects with a SourceError.
 */
export async function fetchJson<T>(req: SourceRequest): Promise<T> {
  const url = String(req.url);
  const method = req.method ?? "GET";
  const mode = req.cassette === false ? "off" : cassetteMode();
  const key = mode === "off" ? "" : cassetteKey(method, url, req.body);

  if (mode === "replay") {
    const entry = readCassette(req.source).entries[key];
    if (!entry) {
      throw new SourceError(req.source, "cassette_miss", `no cassette entry for ${key}`);
    }
    return interpret<T>(req, entry);
  }

  const answer = await fetchLive(req, url, method);

  if (mode === "record") {
    try {
      await queueWrite(req.source, key, forCassette(req, answer));
    } catch (error) {
      // The live answer is still good; only the recording is lost.
      log.error(`${describeError(error)}`);
      recordingLost();
    }
  }

  return interpret<T>(req, answer);
}

// =============================================================================
// Paced requests
// =============================================================================

/** The longest wait honoured from a source's Retry-After before the one retry. */
export const MAX_RETRY_WAIT_MS = 5000;
/** The wait before the one retry when the source said "slow down" without a Retry-After. */
const DEFAULT_RETRY_WAIT_MS = 2000;

/** Waits `ms`, or rejects with the signal's reason as soon as it aborts. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Options of a paced request. */
export interface PacedOptions {
  /** On `pacingClock`: the latest the request may start (the caller's deadline, less a margin). */
  notAfter?: number;
}

/**
 * `fetchJson` through the source's pacer (sources/pacing.ts). A request the pacer refuses (its
 * slot is too far away, or later than `notAfter`) rejects with the pacer's PaceRefused and is
 * never sent ("pace"); so does one whose deadline (a TimeoutError abort of `req.signal`) had
 * passed before it was made or came while it waited for its slot ("deadline"). The caller reports such a source as not asked, never as a timeout.
 *
 * When the source answers "slow down" (429), its requests are held for its Retry-After (2 s when
 * it sends none or a date in the past; at most MAX_HOLD_MS) and the request is retried once
 * after it, when that is at most MAX_RETRY_WAIT_MS and still before `notAfter`; otherwise, or
 * on a second "slow down", the source's `rate_limited` error is the answer. A refusal of the
 * pacer is never retried. A replayed request is not paced: nothing reaches the source.
 */
export async function pacedFetchJson<T>(
  pacer: RequestPacer,
  req: SourceRequest,
  options: PacedOptions = {},
): Promise<T> {
  if (req.cassette !== false && cassetteMode() === "replay") return fetchJson<T>(req);
  const { signal } = req;
  const { notAfter } = options;
  const stopped = (error: unknown) =>
    signal?.aborted && !isSourceError(error) ? abortError(req.source, signal, error) : error;
  const deadlinePassed = () =>
    signal?.aborted === true && (signal.reason as { name?: string })?.name === "TimeoutError";
  const slot = async () => {
    try {
      await pacer.slot({ signal, notAfter });
    } catch (error) {
      if (error instanceof PaceRefused) throw error;
      // The caller's deadline had passed before the request was made, or came while it waited
      // for its slot (the pacer refuses a slot past `notAfter`, so the time went elsewhere):
      // the run's time ran out, and the request is not sent.
      if (deadlinePassed()) {
        throw new PaceRefused(
          0,
          `the deadline came before the ${pacer.name} request could start`,
          "deadline",
        );
      }
      throw stopped(error);
    }
  };
  await slot();
  try {
    return await fetchJson<T>(req);
  } catch (error) {
    // Only the source's own "slow down" answer is retried.
    if (signal?.aborted || !isSourceError(error, "rate_limited")) throw stopped(error);
    const after = error.retryAfterMs ?? DEFAULT_RETRY_WAIT_MS;
    const held = pacer.holdFor(after);
    if (held < after) {
      log.warn(
        `${req.source} asked to wait ${Math.ceil(after / 1000)} s; holding it ${Math.ceil(held / 1000)} s`,
      );
    }
    if (after > MAX_RETRY_WAIT_MS) throw error;
    if (notAfter !== undefined && pacingClock() + after > notAfter) throw error;
    log.info(`${req.source} asked to slow down; retrying once in ${Math.ceil(after / 1000)} s`);
    try {
      await wait(after, signal);
      await slot();
    } catch (stop) {
      // The retry is not made: the source's own answer stands.
      if (stop instanceof PaceRefused) throw error;
      throw stopped(stop);
    }
    return await fetchJson<T>(req);
  }
}
