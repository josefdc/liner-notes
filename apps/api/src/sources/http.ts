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
 * are redacted the same way before they reach a log or a tool result.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// =============================================================================
// Redaction
// =============================================================================

const MAX_TEXT = 500;
const MAX_DETAIL = 200;

/** Values of the environment's credentials, so an echoed key is recognised wherever it appears. */
function knownSecrets(): string[] {
  return Object.entries(process.env)
    .filter(([name, value]) => /KEY|SECRET|TOKEN|PASSWORD/i.test(name) && (value?.length ?? 0) >= 8)
    .map(([, value]) => value as string);
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]"],
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
export function redactText(text: string): string {
  let out = text;
  for (const secret of knownSecrets()) out = out.split(secret).join("[redacted]");
  // An invalid header value is echoed in quotes by fetch; the value is the credential.
  if (/header/i.test(out)) out = out.replace(/"[^"]*"/g, '"[redacted]"');
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

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
const PHONE_LIKE = /\+?\(?\d[\d\s().-]{7,}\d/g;

/** Redacts and masks text for a cassette: secrets, media URLs, e-mails, phone numbers; capped. */
export function scrubText(text: string): string {
  const out = redactText(text)
    .replace(URL_IN_TEXT, (url) => (isMediaUrl(url) ? "[media]" : url))
    .replace(EMAIL, "[email]")
    .replace(PHONE_LIKE, (match) => {
      const digits = match.replace(/\D/g, "").length;
      const isDate = /^\d{4}-\d{2}-\d{2}/.test(match);
      return digits >= 9 && digits <= 15 && !isDate ? "[phone]" : match;
    });
  return out.length > MAX_TEXT ? out.slice(0, MAX_TEXT) : out;
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
  const mode = process.env.SOURCE_CASSETTE;
  return mode === "record" || mode === "replay" ? mode : "off";
}

/** Throws when a cassette mode is set in production; called at startup and on every request. */
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
    console.warn(
      `[sources] SOURCE_CASSETTE=${mode}: ${
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

/**
 * Drops preview and image fields and media URLs, redacts secrets (by key and by value), masks
 * e-mails and phone numbers, and caps long text. Applied to every recorded value.
 */
export function scrubPayload(value: unknown): unknown {
  if (typeof value === "string") return isMediaUrl(value.trim()) ? null : scrubText(value);
  if (Array.isArray(value)) return value.map(scrubPayload);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (MEDIA_KEY.test(key)) continue;
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? "[redacted]" : scrubPayload(inner);
  }
  return out;
}

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

/** A lock file shared with other recording processes; returns the release function. */
async function acquireLock(path: string): Promise<() => Promise<void>> {
  const lock = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      const handle = await open(lock, "wx");
      await handle.close();
      return () => unlink(lock).catch(() => {});
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = await stat(lock).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > LOCK_STALE_MS) await unlink(lock).catch(() => {});
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
      const tmp = `${path}.${process.pid}.${++tmpCounter}.tmp`;
      await writeFile(tmp, `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`);
      await rename(tmp, path);
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
  /** false: never recorded or replayed (local services). */
  cassette?: boolean;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const isJsonType = (contentType: string) => /\bjson\b/i.test(contentType);

/** A short human-readable detail from an error body (Last.fm, Tavily, FastAPI, Spotify). */
function errorDetail(body: unknown): string | undefined {
  if (typeof body === "string") return body.trim().slice(0, MAX_DETAIL) || undefined;
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
  const found = candidates.find((c): c is string => typeof c === "string" && c.trim() !== "");
  return found?.trim().slice(0, MAX_DETAIL);
}

async function fetchLive(req: SourceRequest, url: string, method: string): Promise<Recorded> {
  const timeoutMs = req.timeoutMs ?? defaultTimeoutMs();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  try {
    const response = await fetch(url, {
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
    if (req.signal?.aborted) {
      throw new SourceError(req.source, "aborted", "request aborted", { cause: error });
    }
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
  const detail = errorDetail(body);
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
  if (answer.status < 200 || answer.status > 299) {
    throw new SourceError(source, "http", `HTTP ${answer.status}${detail ? ` — ${detail}` : ""}`, {
      status: answer.status,
      body,
    });
  }
  if (!isJsonType(answer.contentType)) {
    throw new SourceError(
      source,
      "content_type",
      `expected JSON, got ${answer.contentType || "no content type"}`,
      { status: answer.status, body: answer.text },
    );
  }
  if (answer.json === undefined) {
    throw new SourceError(source, "parse", "response body is not valid JSON", {
      status: answer.status,
      body: answer.text,
    });
  }
  return answer.json as T;
}

/** The answer as it is written to a cassette: picked (2xx JSON), scrubbed, capped. */
function forCassette(req: SourceRequest, answer: Recorded): Recorded {
  const entry: Recorded = { status: answer.status, contentType: answer.contentType };
  if (answer.retryAfterMs !== undefined) entry.retryAfterMs = answer.retryAfterMs;
  const ok = answer.status >= 200 && answer.status <= 299;
  if (answer.json !== undefined) {
    entry.json = scrubPayload(ok && req.scrub ? pick(answer.json, req.scrub) : answer.json);
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
      console.error(`[sources] ${describeError(error)}`);
    }
  }

  return interpret<T>(req, answer);
}
