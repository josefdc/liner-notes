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
 * Recorded payloads keep only the fields the pipeline reads (the request's `scrub`), lose
 * preview and image URLs and secrets, and have long text capped, so a cassette can be committed.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  | "cassette_miss";

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
    super(`${source}: ${message}`, details.cause === undefined ? {} : { cause: details.cause });
    this.status = details.status;
    this.retryAfterMs = details.retryAfterMs;
    this.body = details.body;
  }
}

export function isSourceError(error: unknown, kind?: SourceErrorKind): error is SourceError {
  return error instanceof SourceError && (kind === undefined || error.kind === kind);
}

/** One line for logs and tool results; never includes response bodies beyond a short detail. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

// =============================================================================
// Configuration
// =============================================================================

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TEXT = 500;
const MAX_DETAIL = 200;

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

export function cassetteMode(): CassetteMode {
  const mode = process.env.SOURCE_CASSETTE;
  return mode === "record" || mode === "replay" ? mode : "off";
}

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
 * a placeholder and the cassette decides the answer.
 */
export function credential(name: string): string | undefined {
  return process.env[name] || (cassetteMode() === "replay" ? "replay" : undefined);
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
]);
const MEDIA_KEY =
  /^(?:preview|images?|picture|cover|thumbnail|artwork|favicon|avatar)(?:[_-]?\w*)$/i;
const MEDIA_URL =
  /^https?:\/\/[^\s]*(?:\.(?:jpe?g|png|gif|webp|svg|mp3|m4a|aac|ogg|wav)(?:[?#]|$)|scdn\.co\/|dzcdn\.net\/|fastly\.net\/i\/)/i;

/** Drops preview and image URLs and secrets, and caps long text. Applied to every recording. */
export function scrubPayload(value: unknown): unknown {
  if (typeof value === "string") {
    if (MEDIA_URL.test(value)) return null;
    return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value;
  }
  if (Array.isArray(value)) return value.map(scrubPayload);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (MEDIA_KEY.test(key)) continue;
    out[key] = SECRET_KEYS.has(key.toLowerCase()) ? "redacted" : scrubPayload(inner);
  }
  return out;
}

const SECRET_PARAMS = ["api_key", "apikey", "key", "token", "access_token", "client_secret"];

/** The cassette key: method, URL without secret parameters, and a digest of the body. */
export function cassetteKey(method: string, url: string, body?: string): string {
  const parsed = new URL(url);
  for (const name of SECRET_PARAMS) parsed.searchParams.delete(name);
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

function readCassette(source: SourceName): Cassette {
  const path = cassettePath(source);
  if (!existsSync(path)) return { version: 1, entries: {} };
  return JSON.parse(readFileSync(path, "utf8")) as Cassette;
}

function writeEntry(source: SourceName, key: string, entry: Recorded): void {
  const cassette = readCassette(source);
  cassette.entries[key] = entry;
  const sorted = Object.fromEntries(
    Object.entries(cassette.entries).sort(([a], [b]) => a.localeCompare(b)),
  );
  mkdirSync(cassetteDir(), { recursive: true });
  writeFileSync(
    cassettePath(source),
    `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`,
  );
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
    throw new SourceError(req.source, "network", describeError(error), { cause: error });
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
    const entry: Recorded = { status: answer.status, contentType: answer.contentType };
    if (answer.retryAfterMs !== undefined) entry.retryAfterMs = answer.retryAfterMs;
    const ok = answer.status >= 200 && answer.status <= 299;
    if (answer.json !== undefined) {
      entry.json = scrubPayload(ok && req.scrub ? pick(answer.json, req.scrub) : answer.json);
    } else {
      entry.text = (answer.text ?? "").slice(0, MAX_TEXT);
    }
    writeEntry(req.source, key, entry);
  }

  return interpret<T>(req, answer);
}
