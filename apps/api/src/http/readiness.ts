/**
 * Readiness: whether this API can serve what it is set up to serve now. GET /api/ready
 * (routes/health.ts) runs these checks; /api/health stays the liveness probe.
 *
 *   database    open, answers a query, and can write: a page write inside a transaction that
 *               is rolled back (nothing is kept), without waiting for another connection's lock
 *   migrations  every migration of this code is recorded, and none other
 *   audio       the audio service's /health answers (ok, or degraded without its models)
 *   provider    the model provider is configured: configured, not configured or invalid
 *               (what is missing or invalid is logged at warn, by variable name)
 *   budget      the state of the model budget only (available, exhausted, unverifiable or
 *               not_live), never an amount; read only where live analysis can be served, and
 *               quietly (a probe logs no pause)
 *
 * Whether live analysis is served comes from the decision the routes take (replay/mode.ts
 * `liveRefused`). When it is refused (REPLAY_MODE=only; fallback without the Spotify keys, with
 * a spend log that cannot be used or with the budget spent), only recorded runs and stored
 * results are served: the audio and provider checks are `not_needed`, the budget is reported
 * (not read where the decision needs no budget: REPLAY_MODE=only, fallback without the Spotify
 * keys) and readiness rests on the database and its migrations. When live analysis is served, the
 * audio service and the provider must be there; with REPLAY_MODE=off, where nothing else is
 * served, an exhausted or unverifiable budget fails too (every model call would be refused).
 * Should that decision not come within the timeout, live analysis is taken as needed.
 *
 * Every check reports its name, whether it is ok, a status and a short reason. The answer is
 * public (rate-limited per address, http/app.ts): no reason holds a key, an endpoint, a host,
 * an amount, the provider's name or a variable name; the schema version and the states are
 * shown. No check makes a paid call: the provider check reads
 * the configuration, the budget check reads the spend log (llm/budgetState.ts, cached there).
 * A check that does not answer within READY_CHECK_TIMEOUT_MS is cut and reported as timed out.
 *
 * Known limits:
 * - The audio probe's answer, a failure included, is reused for AUDIO_PROBE_TTL_MS (from when
 *   the probe started), so frequent probes do not become frequent requests to the audio
 *   service, and a recovery shows up to that much later.
 * - /health answering does not prove /analyze works (e.g. a wrong AUDIO_SERVICE_TOKEN).
 * - Another connection holding the write lock reads as ok (the file takes writes), even if it
 *   never lets go; the API's own writes would then fail after the busy timeout.
 * - The database probe never commits, so nothing reaches the disk: a full disk, an I/O error on
 *   write or a database file deleted while open all read as "open and writable".
 */

import type { ReadyCheck } from "@liner-notes/contract";
import type { ReplayMode } from "../config/settings.js";
import { defaultAgentRuntime } from "../agent/runtime.js";
import { readLlmSettings } from "../config/settings.js";
import { liveBudgetState } from "../llm/budgetState.js";
import { assertProviderConfigured } from "../llm/factory.js";
import { logger } from "../logger.js";
import {
  currentReplayMode,
  type LiveRefusal,
  liveRefused,
  liveUnavailableReason,
} from "../replay/mode.js";
import { getDb } from "../store/database.js";
import { LATEST_SCHEMA_VERSION } from "../store/migrations.js";
import { DEFAULT_AUDIO_SERVICE_URL } from "../sources/audio.js";

export type { ReadyCheck };

/** The checks, in the order they are reported. */
export type CheckName = "database" | "migrations" | "audio" | "provider" | "budget";

/** Longest wait for one check. */
export const READY_CHECK_TIMEOUT_MS = 2_000;

/** How long one answer of the audio service's /health is reused. */
export const AUDIO_PROBE_TTL_MS = 5_000;

/** The audio service's URL, as sources/audio.ts reads it (never reported). */
const audioServiceUrl = (env: NodeJS.ProcessEnv) =>
  env.AUDIO_ANALYSIS_URL || DEFAULT_AUDIO_SERVICE_URL;

/**
 * Largest /health answer read: the body is read as it streams in and the request is stopped
 * past this many bytes. The service's answer is a few dozen bytes.
 */
export const MAX_HEALTH_BYTES = 4096;

/** The body as text, or null once it is longer than MAX_HEALTH_BYTES (the rest is not read). */
async function readLimited(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_HEALTH_BYTES) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_HEALTH_BYTES) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const check = (
  name: CheckName,
  ok: boolean,
  status: string,
  reason: string,
  extra: Partial<ReadyCheck> = {},
): ReadyCheck => ({ name, ok, status, reason, ...extra });

// =============================================================================
// Database
// =============================================================================

/** SQLite's error code of a failed statement, if any. */
const sqliteCode = (error: unknown): string | undefined => {
  const code = typeof error === "object" && error !== null ? Reflect.get(error, "code") : null;
  return typeof code === "string" ? code : undefined;
};

/**
 * Open, answering, writable: takes the write lock (BEGIN IMMEDIATE) without waiting for another
 * connection's, writes a page (PRAGMA user_version set to its own value) and rolls back. A file
 * SQLite could only open read-only (e.g. mode 0444) still takes the lock in WAL mode; the write
 * is what fails there, with SQLITE_READONLY.
 */
export function databaseCheck(): ReadyCheck {
  let db: ReturnType<typeof getDb>;
  try {
    db = getDb();
  } catch {
    return check("database", false, "unavailable", "the database is not open");
  }
  try {
    if (db.prepare("SELECT 1").get() == null) {
      return check("database", false, "unavailable", "the database does not answer a query");
    }
  } catch {
    return check("database", false, "unavailable", "the database does not answer a query");
  }
  if (db.readonly) return check("database", false, "read_only", "opened read-only");
  // Every transaction of the API is synchronous (better-sqlite3), so one open between requests
  // was left open by a failure, and holds what it took.
  if (db.inTransaction) {
    return check("database", false, "unavailable", "a transaction was left open");
  }
  const busyTimeout = db.pragma("busy_timeout", { simple: true });
  try {
    db.pragma("busy_timeout = 0");
    try {
      db.exec("BEGIN IMMEDIATE");
      const version = Number(db.pragma("user_version", { simple: true })) || 0;
      db.pragma(`user_version = ${version}`);
      db.exec("ROLLBACK");
      return check("database", true, "ok", "open and writable");
    } catch (error) {
      const code = sqliteCode(error) ?? "";
      // Another connection is writing: the file takes writes.
      if (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED")) {
        return check("database", true, "ok", "open; another connection holds the write lock");
      }
      if (code.startsWith("SQLITE_READONLY")) {
        return check("database", false, "read_only", "the database file cannot be written");
      }
      return check("database", false, "unavailable", "the write lock cannot be taken");
    } finally {
      try {
        if (db.inTransaction) db.exec("ROLLBACK");
      } catch {
        // The connection failed meanwhile; the next probe reports the open transaction.
      }
    }
  } finally {
    try {
      db.pragma(`busy_timeout = ${Number(busyTimeout) || 0}`);
    } catch {
      // The connection failed meanwhile; the next probe reports it.
    }
  }
}

/** The recorded migrations are exactly this code's: versions 1..LATEST_SCHEMA_VERSION. */
export function migrationsCheck(): ReadyCheck {
  let row: { count: number; latest: number | null } | undefined;
  try {
    row = getDb()
      .prepare("SELECT COUNT(*) AS count, MAX(version) AS latest FROM schema_migrations")
      .get() as typeof row;
  } catch {
    return check("migrations", false, "unavailable", "the migrations cannot be read");
  }
  const latest = row?.latest ?? 0;
  const expected = `schema v${LATEST_SCHEMA_VERSION}`;
  if (latest === LATEST_SCHEMA_VERSION && row?.count === LATEST_SCHEMA_VERSION) {
    return check("migrations", true, "ok", `at ${expected}`);
  }
  return check("migrations", false, "mismatch", `at schema v${latest}, expected ${expected}`);
}

// =============================================================================
// Audio service
// =============================================================================

/** Why a request to the audio service failed, without its URL or host. */
function audioFailure(error: unknown): ReadyCheck {
  if (error instanceof Error && error.name === "TimeoutError") {
    return check("audio", false, "timeout", `no answer within ${READY_CHECK_TIMEOUT_MS} ms`, {
      models: null,
    });
  }
  let code: unknown;
  for (let e: unknown = error, depth = 0; e && depth < 4 && code === undefined; depth++) {
    code = typeof e === "object" ? Reflect.get(e, "code") : undefined;
    e = typeof e === "object" ? Reflect.get(e, "cause") : undefined;
  }
  const reason =
    code === "ECONNREFUSED"
      ? "connection refused"
      : code === "ENOTFOUND" || code === "EAI_AGAIN"
        ? "the host name does not resolve"
        : code === "ECONNRESET"
          ? "the connection was reset"
          : "the request failed";
  return check("audio", false, "unreachable", reason, { models: null });
}

/** One request to the audio service's /health. Never rejects. */
async function probeAudio(url: string): Promise<ReadyCheck> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, "")}/health`, {
      signal: AbortSignal.timeout(READY_CHECK_TIMEOUT_MS),
      redirect: "error",
      headers: { accept: "application/json" },
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return check("audio", false, "unreachable", `/health answered ${res.status}`, {
        models: null,
      });
    }
    const text = await readLimited(res);
    let body: unknown = null;
    try {
      body = text === null ? null : JSON.parse(text);
    } catch {
      body = null;
    }
    const status = typeof body === "object" && body !== null ? Reflect.get(body, "status") : null;
    const models = typeof body === "object" && body !== null ? Reflect.get(body, "models") : null;
    if (status !== "ok" && status !== "degraded") {
      return check("audio", false, "unreachable", "/health did not answer as the audio service", {
        models: null,
      });
    }
    const loaded = typeof models === "boolean" ? models : null;
    return status === "ok"
      ? check("audio", true, "ok", "answering, with its models", { models: loaded })
      : check(
          "audio",
          true,
          "degraded",
          "answering without its models: tempo and key only, no perceptual features",
          { models: loaded },
        );
  } catch (error) {
    return audioFailure(error);
  }
}

let audioProbe: { url: string; at: number; result: Promise<ReadyCheck> } | null = null;

/** The audio service's state, probed at most once per AUDIO_PROBE_TTL_MS. */
export function audioCheck(env: NodeJS.ProcessEnv = process.env): Promise<ReadyCheck> {
  const url = audioServiceUrl(env);
  const now = Date.now();
  if (audioProbe && audioProbe.url === url && now - audioProbe.at < AUDIO_PROBE_TTL_MS) {
    return audioProbe.result;
  }
  const result = probeAudio(url);
  audioProbe = { url, at: now, result };
  return result;
}

// =============================================================================
// Model provider and budget
// =============================================================================

const log = logger("Readiness");

/** Leading variable names of the settings errors (the messages themselves are not logged). */
const variableNames = (errors: string[]) => [
  ...new Set(errors.map((error) => /^[A-Z][A-Z0-9_]*/.exec(error)?.[0]).filter(Boolean)),
];

let providerWarning = "";

/** Logs what the provider lacks at warn level, once until it changes. Names only, never values. */
function warnProvider(warning: string): void {
  if (warning === providerWarning) return;
  providerWarning = warning;
  log.warn(warning);
}

/**
 * The model provider can be called: configuration only, no request. The answer is public, so
 * its reason names no provider and no variable: what is missing or invalid goes to the log.
 */
export function providerCheck(env: NodeJS.ProcessEnv = process.env): ReadyCheck {
  const { settings, errors } = readLlmSettings(env);
  if (errors.length > 0) {
    const names = variableNames(errors);
    warnProvider(
      `Not ready: invalid model settings${names.length > 0 ? `: ${names.join(", ")}` : ""}`,
    );
    return check(
      "provider",
      false,
      "invalid",
      "the model settings are invalid (see the API's log)",
    );
  }
  if (settings.cassette === "replay") {
    providerWarning = "";
    return check("provider", true, "cassettes", "model answers come from recorded calls");
  }
  try {
    assertProviderConfigured(settings);
  } catch (error) {
    // Its messages name variables only (llm/factory.ts).
    warnProvider(`Not ready: ${error instanceof Error ? error.message : "no model provider"}`);
    return check(
      "provider",
      false,
      "not_configured",
      "no model provider is configured (see the API's log)",
    );
  }
  providerWarning = "";
  return check("provider", true, "configured", "a model provider is configured");
}

export type BudgetStateName = "available" | "exhausted" | "unverifiable" | "not_live";

/**
 * The budget's state, never its amounts or caps. Read quietly: a probe logs no pause (the
 * routes do, when they act on it).
 */
export async function budgetState(env: NodeJS.ProcessEnv = process.env): Promise<BudgetStateName> {
  try {
    return (await liveBudgetState(env, defaultAgentRuntime.purpose, { quiet: true })).state;
  } catch {
    return "unverifiable";
  }
}

const SERVED_RECORDED = "recorded runs and stored results are served";
const LIVE_ONLY = "and this server serves live analysis only";

/**
 * The budget check for `state` under `mode`. It fails only with REPLAY_MODE=off, where live
 * analysis is all that is served: there an exhausted or unverifiable budget refuses every model
 * call. In fallback mode recorded runs and stored results are still served.
 */
export function budgetCheck(
  state: BudgetStateName,
  mode: ReplayMode,
  refusal: LiveRefusal | null = null,
): ReadyCheck {
  if (mode === "off") {
    switch (state) {
      case "exhausted":
        return check(
          "budget",
          false,
          state,
          `a budget cap is reached: every model call is refused, ${LIVE_ONLY}`,
        );
      case "unverifiable":
        return check(
          "budget",
          false,
          state,
          `the spend log cannot be used: every model call is refused, ${LIVE_ONLY}`,
        );
      case "available":
        return check("budget", true, state, "live analysis can start");
      default:
        return check("budget", true, state, "no paid provider is configured: nothing is spent");
    }
  }
  switch (state) {
    case "exhausted":
      return check(
        "budget",
        true,
        state,
        `a budget cap is reached: live analysis is paused; ${SERVED_RECORDED}`,
      );
    case "unverifiable":
      return check(
        "budget",
        true,
        state,
        `the spend log cannot be used: live analysis is off; ${SERVED_RECORDED}`,
      );
    case "available":
      return check(
        "budget",
        true,
        state,
        refusal ? `within the caps; ${refusalReason(refusal, mode)}` : "live analysis can start",
      );
    default:
      return check("budget", true, state, "no paid provider is configured: nothing is spent");
  }
}

/** Why live analysis is not served, as a check's reason. */
function refusalReason(refusal: LiveRefusal, mode: ReplayMode): string {
  if (mode === "only") return `replay-only mode: ${SERVED_RECORDED} only`;
  return refusal === "budget_exhausted"
    ? `live analysis is paused (budget_exhausted): ${SERVED_RECORDED} only`
    : `live analysis is off (live_disabled): ${SERVED_RECORDED} only`;
}

// =============================================================================
// All checks
// =============================================================================

/** `run()`, or what `onTimeout` gives once `timeoutMs` has passed. */
async function withTimeout<T>(
  run: () => Promise<T>,
  onTimeout: () => T,
  timeoutMs: number,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(onTimeout()), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([run(), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

export interface Readiness {
  ready: boolean;
  checks: ReadyCheck[];
}

/**
 * Runs every check (the slow ones cut at `timeoutMs`). The budget is read only where live
 * analysis can be served: REPLAY_MODE=off, or fallback with the Spotify keys set (where it is
 * part of the routes' decision, and that read is shared).
 */
export async function readiness(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = READY_CHECK_TIMEOUT_MS,
): Promise<Readiness> {
  const cut = `no answer within ${timeoutMs} ms`;
  const mode = currentReplayMode(env);
  const readsBudget =
    mode === "off" || (mode === "fallback" && liveUnavailableReason(env) === null);
  const [state, refusal] = await Promise.all([
    readsBudget
      ? withTimeout(
          () => budgetState(env),
          (): BudgetStateName | "timeout" => "timeout",
          timeoutMs,
        )
      : null,
    // The routes' own decision; undecided in time: live analysis is taken as needed.
    withTimeout(
      () => liveRefused(env, defaultAgentRuntime.purpose, { quiet: true }).catch(() => null),
      () => null,
      timeoutMs,
    ),
  ]);

  let audio: ReadyCheck;
  let provider: ReadyCheck;
  if (refusal !== null) {
    const reason = refusalReason(refusal, mode);
    audio = check("audio", true, "not_needed", reason, { models: null });
    provider = check("provider", true, "not_needed", reason);
  } else {
    audio = await withTimeout(
      () => audioCheck(env),
      () => check("audio", false, "timeout", cut, { models: null }),
      timeoutMs,
    );
    provider = providerCheck(env);
  }
  let budget: ReadyCheck;
  if (state === null) {
    budget = check("budget", true, "not_needed", refusalReason(refusal ?? "live_disabled", mode));
  } else if (state === "timeout") {
    budget = { ...budgetCheck("unverifiable", mode, refusal), reason: cut };
  } else {
    budget = budgetCheck(state, mode, refusal);
  }
  const checks = [databaseCheck(), migrationsCheck(), audio, provider, budget];
  return { ready: checks.every((c) => c.ok), checks };
}

/** For tests: forgets the cached audio probe and the provider warning already logged. */
export function resetReadinessForTests(): void {
  audioProbe = null;
  providerWarning = "";
}
