/**
 * Readiness: whether this API can serve an analysis now. GET /api/ready (routes/health.ts) runs
 * these checks; /api/health stays the liveness probe.
 *
 *   database    open, answers a query, and its write lock can be taken (nothing is written)
 *   migrations  every migration of this code is recorded, and none other
 *   audio       the audio service's /health answers (ok, or degraded without its models);
 *               not probed with REPLAY_MODE=only, where nothing is analysed
 *   provider    the model provider is configured (variable names only, never a value); with
 *               REPLAY_MODE=only no model is called
 *   budget      the state of the model budget only: available, exhausted, unverifiable or
 *               not_live. Never a failure: a spent budget still serves replays and stored
 *               results. Never an amount.
 *
 * Every check reports its name, whether it is ok, a status and a short reason. No reason holds
 * a key, an endpoint, a host or an amount. No check makes a paid call: the provider check reads
 * the configuration, the budget check reads the spend log (llm/budgetState.ts, cached there).
 * A check that does not answer within READY_CHECK_TIMEOUT_MS is cut and reported as timed out.
 * The audio probe's answer is shared by the probes of the next AUDIO_PROBE_TTL_MS, so frequent
 * readiness probes do not become frequent requests to the audio service.
 */

import type { ReadyCheck } from "@liner-notes/contract";
import { defaultAgentRuntime } from "../agent/runtime.js";
import { readLlmSettings } from "../config/settings.js";
import { liveBudgetState } from "../llm/budgetState.js";
import { assertProviderConfigured } from "../llm/factory.js";
import { currentReplayMode } from "../replay/mode.js";
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
 * Open, answering, writable: takes the write lock and lets it go at once (BEGIN IMMEDIATE,
 * ROLLBACK), without waiting for another connection's lock.
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
  if (currentReplayMode(env) === "only") {
    return Promise.resolve(
      check("audio", true, "skipped", "not needed: REPLAY_MODE=only analyses nothing", {
        models: null,
      }),
    );
  }
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
  if (currentReplayMode(env) === "only") {
    return check("provider", true, "replay_only", "not needed: REPLAY_MODE=only calls no model");
  }
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

const BUDGET_REASONS: Record<string, string> = {
  available: "live analysis can start",
  exhausted:
    "a budget cap is reached: live analysis is paused, replays and stored results are served",
  unverifiable: "the spend log cannot be used: live model calls are refused",
  not_live: "no paid provider is configured: nothing is spent",
};

/** The budget's state, never its amounts. Always ok: a spent budget still serves replays. */
export async function budgetCheck(env: NodeJS.ProcessEnv = process.env): Promise<ReadyCheck> {
  let state: string;
  try {
    state = (await liveBudgetState(env, defaultAgentRuntime.purpose)).state;
  } catch {
    state = "unverifiable";
  }
  return check("budget", true, state, BUDGET_REASONS[state] ?? state);
}

// =============================================================================
// All checks
// =============================================================================

/** `run()`, or the check `onTimeout` gives once READY_CHECK_TIMEOUT_MS has passed. */
async function withTimeout(
  run: () => Promise<ReadyCheck>,
  onTimeout: () => ReadyCheck,
  timeoutMs: number,
): Promise<ReadyCheck> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<ReadyCheck>((resolve) => {
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

/** Runs every check (the slow ones at once, each cut at `timeoutMs`). */
export async function readiness(
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = READY_CHECK_TIMEOUT_MS,
): Promise<Readiness> {
  const cut = `no answer within ${timeoutMs} ms`;
  const [audio, budget] = await Promise.all([
    withTimeout(
      () => audioCheck(env),
      () => check("audio", false, "timeout", cut, { models: null }),
      timeoutMs,
    ),
    withTimeout(
      () => budgetCheck(env),
      () => check("budget", true, "unverifiable", cut),
      timeoutMs,
    ),
  ]);
  const checks = [databaseCheck(), migrationsCheck(), audio, providerCheck(env), budget];
  return { ready: checks.every((c) => c.ok), checks };
}

/** For tests: forgets the cached audio probe. */
export function resetReadinessForTests(): void {
  audioProbe = null;
}
