/**
 * Readiness: whether this API can serve what it is set up to serve now. GET /api/ready
 * (routes/health.ts) runs these checks; /api/health stays the liveness probe.
 *
 *   database    open, answers a query, and can write: a page write inside a transaction that
 *               is rolled back (nothing is kept), without waiting for another connection's lock
 *   migrations  every migration of this code is recorded, and none other
 *   audio       the audio service's /health answers (ok, or degraded without its models)
 *   provider    the model provider is configured (variable names only, never a value)
 *   budget      the state of the model budget only (available, exhausted, unverifiable or
 *               not_live), never an amount
 *
 * Whether live analysis is served comes from the decision the routes take (replay/mode.ts
 * `liveRefused`). When it is refused (REPLAY_MODE=only; fallback without the Spotify keys, with
 * a spend log that cannot be used or with the budget spent), only recorded runs and stored
 * results are served: the audio and provider checks are `not_needed`, the budget is reported
 * and readiness rests on the database and its migrations. When live analysis is served, the
 * audio service and the provider must be there; with REPLAY_MODE=off, where nothing else is
 * served, an exhausted or unverifiable budget fails too (every model call would be refused).
 * Should that decision not come within the timeout, live analysis is taken as needed.
 *
 * Every check reports its name, whether it is ok, a status and a short reason. No reason holds
 * a key, an endpoint, a host or an amount. No check makes a paid call: the provider check reads
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
 */

import type { ReadyCheck } from "@liner-notes/contract";
import type { ReplayMode } from "../config/settings.js";
import { defaultAgentRuntime } from "../agent/runtime.js";
import { readLlmSettings } from "../config/settings.js";
import { liveBudgetState } from "../llm/budgetState.js";
import { assertProviderConfigured } from "../llm/factory.js";
import { currentReplayMode, type LiveRefusal, liveRefused } from "../replay/mode.js";
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

/** Largest /health answer read. The service's is a few dozen bytes. */
const MAX_HEALTH_BYTES = 4096;

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
  // A transaction of this connection is open: it holds the write lock, so writes work.
  if (db.inTransaction) return check("database", true, "ok", "open and writable");
  const busyTimeout = db.pragma("busy_timeout", { simple: true });
  try {
    db.pragma("busy_timeout = 0");
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
    const text = await res.text();
    if (!res.ok) {
      return check("audio", false, "unreachable", `/health answered ${res.status}`, {
        models: null,
      });
    }
    let body: unknown = null;
    try {
      body = text.length <= MAX_HEALTH_BYTES ? JSON.parse(text) : null;
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

/** Leading variable names of the settings errors (the messages themselves are not reported). */
const variableNames = (errors: string[]) => [
  ...new Set(errors.map((error) => /^[A-Z][A-Z0-9_]*/.exec(error)?.[0]).filter(Boolean)),
];

/** The model provider can be called: configuration only, no request. */
export function providerCheck(env: NodeJS.ProcessEnv = process.env): ReadyCheck {
  const { settings, errors } = readLlmSettings(env);
  if (errors.length > 0) {
    const names = variableNames(errors);
    return check(
      "provider",
      false,
      "not_configured",
      names.length > 0 ? `invalid model settings: ${names.join(", ")}` : "invalid model settings",
    );
  }
  if (settings.cassette === "replay") {
    return check("provider", true, "cassettes", "LLM_CASSETTE=replay: answers come from cassettes");
  }
  try {
    assertProviderConfigured(settings);
  } catch (error) {
    // Its messages name variables only (llm/factory.ts).
    const reason = error instanceof Error ? error.message : "not configured";
    return check("provider", false, "not_configured", reason);
  }
  return check("provider", true, "configured", `${settings.provider}: key and endpoint set`);
}

export type BudgetStateName = "available" | "exhausted" | "unverifiable" | "not_live";

/** The budget's state, never its amounts or caps. */
export async function budgetState(env: NodeJS.ProcessEnv = process.env): Promise<BudgetStateName> {
  try {
    return (await liveBudgetState(env, defaultAgentRuntime.purpose)).state;
  } catch {
    return "unverifiable";
  }
}

const SERVED_RECORDED = "recorded runs and stored results are served";

/**
 * The budget check for `state` under `mode`. It fails only with REPLAY_MODE=off, where live
 * analysis is all that is served: there an exhausted or unverifiable budget refuses every model
 * call. In fallback and only mode recorded runs and stored results are still served.
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
          "a budget cap is reached: every model call is refused, and REPLAY_MODE=off serves no recorded runs",
        );
      case "unverifiable":
        return check(
          "budget",
          false,
          state,
          "the spend log cannot be used: every model call is refused, and REPLAY_MODE=off serves no recorded runs",
        );
      case "available":
        return check("budget", true, state, "live analysis can start");
      default:
        return check("budget", true, state, "no paid provider is configured: nothing is spent");
    }
  }
  if (mode === "only") {
    return check("budget", true, state, "REPLAY_MODE=only calls no model: nothing is spent");
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
  if (mode === "only") return `REPLAY_MODE=only: ${SERVED_RECORDED} only`;
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

/** Runs every check (the slow ones cut at `timeoutMs`). */
export async function readiness(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = READY_CHECK_TIMEOUT_MS,
): Promise<Readiness> {
  const cut = `no answer within ${timeoutMs} ms`;
  const mode = currentReplayMode(env);
  const [state, refusal] = await Promise.all([
    withTimeout(
      () => budgetState(env),
      (): BudgetStateName | "timeout" => "timeout",
      timeoutMs,
    ),
    // The routes' own decision; undecided in time: live analysis is taken as needed.
    withTimeout(
      () => liveRefused(env).catch(() => null),
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
  const budget =
    state === "timeout"
      ? { ...budgetCheck("unverifiable", mode, refusal), reason: cut }
      : budgetCheck(state, mode, refusal);
  const checks = [databaseCheck(), migrationsCheck(), audio, provider, budget];
  return { ready: checks.every((c) => c.ok), checks };
}

/** For tests: forgets the cached audio probe. */
export function resetReadinessForTests(): void {
  audioProbe = null;
}
