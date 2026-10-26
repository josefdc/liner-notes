import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReadyResponse } from "@liner-notes/contract";
import Database from "better-sqlite3";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { resetBudgetStateForTests } from "../../llm/budgetState.js";
import { captureLogsForTests } from "../../logger.js";
import { closeDatabase, getDb, initializeDatabase } from "../../store/database.js";
import { LATEST_SCHEMA_VERSION } from "../../store/migrations.js";
import {
  AUDIO_PROBE_TTL_MS,
  audioCheck,
  databaseCheck,
  MAX_HEALTH_BYTES,
  readiness,
  resetReadinessForTests,
} from "../readiness.js";
import { createTestApp } from "../testApp.js";
import healthRouter from "./health.js";

let dir: string | undefined;
let dbPath: string;

function openDatabase() {
  dir = mkdtempSync(join(tmpdir(), "health-"));
  dbPath = join(dir, "test.db");
  initializeDatabase(dbPath);
}

// What the readiness checks read, as each test sets it; restored after each test.
const READY_ENV = [
  "REPLAY_MODE",
  "AUDIO_ANALYSIS_URL",
  "LLM_PROVIDER",
  "LLM_CASSETTE",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "AZURE_OPENAI_BASE_URL",
  "LLM_SPEND_LOG",
  "BUDGET_TOTAL_USD",
  "SPOTIFY_CLIENT_ID",
  "SPOTIFY_CLIENT_SECRET",
];
let savedEnv: Record<string, string | undefined> = {};
const servers: Server[] = [];

beforeEach(() => {
  savedEnv = Object.fromEntries(READY_ENV.map((name) => [name, process.env[name]]));
  resetReadinessForTests();
  resetBudgetStateForTests();
});

afterEach(() => {
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
  resetReadinessForTests();
  resetBudgetStateForTests();
  closeDatabase();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("GET /api/health", () => {
  it("reports a connected database", async () => {
    openDatabase();

    const res = await request(createTestApp(healthRouter)).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", database: "connected" });
  });

  it("reports an unavailable database when none is open", async () => {
    const res = await request(createTestApp(healthRouter)).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body.database).toBe("unavailable");
  });

  it("reports the version from the API's package.json", async () => {
    const pkg = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../../package.json"), "utf8"),
    ) as { version: string };

    const res = await request(createTestApp(healthRouter)).get("/api/health");

    expect(res.body.version).toBe(pkg.version);
  });
});

// =============================================================================
// GET /api/ready
// =============================================================================

interface Stub {
  url: string;
  port: number;
  requests: () => number;
}

/** A stand-in audio service: `answer` handles GET /health. */
async function audioStub(answer: (res: import("node:http").ServerResponse) => void): Promise<Stub> {
  let count = 0;
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      count++;
      answer(res);
    } else {
      res.writeHead(404).end();
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, port, requests: () => count };
}

const json = (status: number, body: unknown) => (res: import("node:http").ServerResponse) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const healthy = json(200, { status: "ok", analyzer_version: "test-1", models: true });
const degraded = json(200, { status: "degraded", analyzer_version: "test-1", models: false });

/** A port nothing listens on: a server is started and closed. */
async function closedPort(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

const KEY = "dummy-ready-key-0123456789abcdef";
const ENDPOINT_HOST = "ready-resource.example.net";

/** A live provider configuration (a dummy key: no model is called) and its spend log. */
function liveProvider(spentUsd: number | null): string {
  process.env.LLM_CASSETTE = "off";
  process.env.AZURE_OPENAI_API_KEY = KEY;
  process.env.AZURE_OPENAI_ENDPOINT = `https://${ENDPOINT_HOST}/`;
  const spendLog = join(dir as string, "spend.jsonl");
  if (spentUsd !== null) {
    writeFileSync(
      spendLog,
      `${JSON.stringify({ ts: new Date().toISOString(), deployment: "gpt", in: 0, out: 0, usd_est: spentUsd, unit: "dev" })}\n`,
    );
  }
  process.env.LLM_SPEND_LOG = spendLog;
  return spendLog;
}

const ready = () => request(createTestApp(healthRouter)).get("/api/ready");
/** An environment variable's name (REPLAY_MODE, AZURE_OPENAI_API_KEY, …). */
const ENV_NAME = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
const detail = (body: { details?: Array<{ name: string; reason?: string }> }, name: string) =>
  body.details?.find((check) => check.name === name);

describe("GET /api/ready", () => {
  it("answers 200 with every check when the API can serve an analysis", async () => {
    openDatabase();
    const audio = await audioStub(healthy);
    process.env.AUDIO_ANALYSIS_URL = audio.url;

    const res = await ready();

    expect(res.status).toBe(200);
    expect(ReadyResponse.safeParse(res.body).success).toBe(true);
    expect(res.body).toMatchObject({
      status: "ready",
      checks: {
        database: "ok",
        migrations: "ok",
        audio: "ok",
        // Tests replay model calls from cassettes (test/setup/llmReplay.ts).
        provider: "cassettes",
        budget: "not_live",
      },
    });
    expect(res.body.details.map((check: { name: string }) => check.name)).toEqual([
      "database",
      "migrations",
      "audio",
      "provider",
      "budget",
    ]);
    for (const check of res.body.details) {
      expect(Object.keys(check).sort()).toEqual(
        check.name === "audio"
          ? ["models", "name", "ok", "reason", "status"]
          : ["name", "ok", "reason", "status"],
      );
      expect(check.ok).toBe(true);
      expect(check.reason).toMatch(/\S/);
    }
    expect(detail(res.body, "audio")).toMatchObject({ status: "ok", models: true });
    expect(detail(res.body, "migrations")?.reason).toContain(`v${LATEST_SCHEMA_VERSION}`);
    // Never the audio service's address.
    expect(JSON.stringify(res.body)).not.toContain(String(audio.port));
    expect(JSON.stringify(res.body)).not.toContain("127.0.0.1");
  });

  it("answers 200 with a degraded audio service, saying its models are not loaded", async () => {
    openDatabase();
    process.env.AUDIO_ANALYSIS_URL = (await audioStub(degraded)).url;

    const res = await ready();

    expect(res.status).toBe(200);
    expect(detail(res.body, "audio")).toMatchObject({
      ok: true,
      status: "degraded",
      models: false,
    });
  });

  it("answers 503 when the audio service is unreachable, and lists every other check", async () => {
    openDatabase();
    const url = await closedPort();
    process.env.AUDIO_ANALYSIS_URL = url;

    const res = await ready();

    expect(res.status).toBe(503);
    expect(res.body.status).toBe("unavailable");
    expect(detail(res.body, "audio")).toMatchObject({
      ok: false,
      status: "unreachable",
      reason: "connection refused",
      models: null,
    });
    expect(res.body.checks).toMatchObject({ database: "ok", migrations: "ok" });
    expect(JSON.stringify(res.body)).not.toContain(new URL(url).port);
  });

  it("answers 503 when the audio service answers with an error or something else", async () => {
    openDatabase();
    process.env.AUDIO_ANALYSIS_URL = (await audioStub(json(500, { detail: "boom" }))).url;
    expect(detail((await ready()).body, "audio")).toMatchObject({
      ok: false,
      status: "unreachable",
      reason: "/health answered 500",
    });

    resetReadinessForTests();
    process.env.AUDIO_ANALYSIS_URL = (await audioStub(json(200, { hello: "world" }))).url;
    const res = await ready();
    expect(res.status).toBe(503);
    expect(detail(res.body, "audio")).toMatchObject({ ok: false, status: "unreachable" });
  });

  it("cuts a check that does not answer in time, and reports it", async () => {
    openDatabase();
    // Answers only when the test is over.
    process.env.AUDIO_ANALYSIS_URL = (await audioStub(() => {})).url;

    const started = Date.now();
    const result = await readiness(process.env, 100);

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(result.ready).toBe(false);
    expect(result.checks.find((check) => check.name === "audio")).toMatchObject({
      ok: false,
      status: "timeout",
      reason: "no answer within 100 ms",
    });
  });

  it("asks the audio service once for the probes of a few seconds", async () => {
    openDatabase();
    const audio = await audioStub(healthy);
    process.env.AUDIO_ANALYSIS_URL = audio.url;

    await Promise.all([ready(), ready()]);
    await ready();

    expect(audio.requests()).toBe(1);
  });

  it("keeps the audio probe's answer for its TTL on the monotonic clock, whatever the wall clock does", async () => {
    vi.useFakeTimers({ toFake: ["Date", "performance"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const audio = await audioStub(healthy);
    const env = { AUDIO_ANALYSIS_URL: audio.url };

    await audioCheck(env);
    expect(audio.requests()).toBe(1);
    // A step back does not keep the answer past its TTL...
    vi.setSystemTime(Date.now() - 60 * 60_000);
    vi.advanceTimersByTime(AUDIO_PROBE_TTL_MS);
    await audioCheck(env);
    expect(audio.requests()).toBe(2);
    // ...nor does a step forward drop it before.
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000);
    await audioCheck(env);
    expect(audio.requests()).toBe(2);
  });

  it("probes the audio service again when the clock reads earlier than the last probe", async () => {
    const audio = await audioStub(healthy);
    const env = { AUDIO_ANALYSIS_URL: audio.url };
    await audioCheck(env);
    // A fake monotonic clock starts near 0: earlier than the probe just made.
    vi.useFakeTimers({ toFake: ["performance"] });
    onTestFinished(() => {
      vi.useRealTimers();
    });

    await audioCheck(env);

    expect(audio.requests()).toBe(2);
  });

  it("answers 503 when no model provider is configured, naming the variables in the log only", async () => {
    openDatabase();
    process.env.AUDIO_ANALYSIS_URL = (await audioStub(healthy)).url;
    process.env.LLM_CASSETTE = "off";
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_ENDPOINT;
    delete process.env.AZURE_OPENAI_BASE_URL;
    const logs = captureLogsForTests();
    try {
      const res = await ready();
      await ready();

      expect(res.status).toBe(503);
      expect(detail(res.body, "provider")).toEqual({
        name: "provider",
        ok: false,
        status: "not_configured",
        reason: "no model provider is configured (see the API's log)",
      });
      expect(res.text).not.toMatch(ENV_NAME);
      // Logged once, at warn, by variable name.
      const warnings = logs.entries().filter((entry) => entry.level === "warn");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatchObject({
        component: "Readiness",
        msg: expect.stringContaining("AZURE_OPENAI_API_KEY"),
      });
    } finally {
      logs.restore();
    }
  });

  it("answers 503 for invalid model settings, naming the variable in the log, not its value", async () => {
    openDatabase();
    process.env.AUDIO_ANALYSIS_URL = (await audioStub(healthy)).url;
    process.env.LLM_CASSETTE = "off";
    process.env.AZURE_OPENAI_API_KEY = KEY;
    process.env.AZURE_OPENAI_ENDPOINT = `http://${ENDPOINT_HOST}/`;

    const logs = captureLogsForTests();
    try {
      const res = await ready();

      expect(res.status).toBe(503);
      expect(detail(res.body, "provider")).toMatchObject({
        ok: false,
        status: "invalid",
        reason: "the model settings are invalid (see the API's log)",
      });
      expect(res.text).not.toMatch(ENV_NAME);
      const text = `${res.text}\n${logs.lines().join("\n")}`;
      expect(text).not.toContain(ENDPOINT_HOST);
      expect(text).not.toContain(KEY);
      expect(logs.messages("warn")).toEqual([
        "Not ready: invalid model settings: AZURE_OPENAI_ENDPOINT",
      ]);
    } finally {
      logs.restore();
    }
  });

  it("reports a configured provider and an available budget, with no key, endpoint or amount", async () => {
    // The answer's timestamp is read on a pinned clock: at a wall-clock time such as
    // hh:mm:10.5xx, it would hold the amount's digits by chance.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-25T12:00:00.000Z") });
    onTestFinished(() => {
      vi.useRealTimers();
    });
    openDatabase();
    process.env.AUDIO_ANALYSIS_URL = (await audioStub(healthy)).url;
    const spendLog = liveProvider(0.5);

    const res = await ready();

    expect(res.status).toBe(200);
    expect(res.body.checks).toMatchObject({ provider: "configured", budget: "available" });
    const text = JSON.stringify(res.body);
    for (const secret of [KEY, ENDPOINT_HOST, spendLog, "0.5", "usd", "USD", "$"]) {
      expect(text).not.toContain(secret);
    }
    // Neither the provider's name nor a variable.
    expect(text).not.toMatch(/azure/i);
    expect(text).not.toMatch(ENV_NAME);
  });

  it("answers 503 with a spent budget under REPLAY_MODE=off, with no amount", async () => {
    openDatabase();
    process.env.AUDIO_ANALYSIS_URL = (await audioStub(healthy)).url;
    process.env.BUDGET_TOTAL_USD = "25";
    liveProvider(30);

    const res = await ready();

    expect(res.status).toBe(503);
    expect(detail(res.body, "budget")).toMatchObject({
      ok: false,
      status: "exhausted",
      reason: expect.stringContaining("this server serves live analysis only"),
    });
    // The checks, without the timestamp (whose date may hold the same digits).
    const text = JSON.stringify({ checks: res.body.checks, details: res.body.details });
    for (const amount of ["30", "25", "BUDGET_TOTAL_USD", "USD"])
      expect(text).not.toContain(amount);
  });

  it("answers 200 with a spent budget under REPLAY_MODE=fallback: recordings are served", async () => {
    openDatabase();
    const audio = await audioStub(healthy);
    process.env.AUDIO_ANALYSIS_URL = audio.url;
    process.env.REPLAY_MODE = "fallback";
    process.env.SPOTIFY_CLIENT_ID = "dummy-spotify-id";
    process.env.SPOTIFY_CLIENT_SECRET = "dummy-spotify-secret";
    liveProvider(30);

    const res = await ready();

    expect(res.status).toBe(200);
    expect(res.text).toContain('"status":"ready"');
    expect(detail(res.body, "budget")).toMatchObject({
      ok: true,
      status: "exhausted",
      reason: expect.stringContaining("recorded runs and stored results are served"),
    });
    expect(res.body.checks).toMatchObject({ audio: "not_needed", provider: "not_needed" });
    // Not needed: not asked.
    expect(audio.requests()).toBe(0);
  });

  it("with REPLAY_MODE=only, needs neither the audio service nor a model provider", async () => {
    openDatabase();
    process.env.REPLAY_MODE = "only";
    process.env.AUDIO_ANALYSIS_URL = await closedPort();
    process.env.LLM_CASSETTE = "off";
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_ENDPOINT;

    const res = await ready();

    expect(res.status).toBe(200);
    expect(res.text).toContain('"status":"ready"');
    expect(res.body.checks).toMatchObject({ audio: "not_needed", provider: "not_needed" });
    expect(detail(res.body, "audio")?.reason).toBe(
      "replay-only mode: recorded runs and stored results are served only",
    );
  });

  type Mode = "off" | "fallback" | "only";
  type Budget = "available" | "exhausted" | "unverifiable" | "no provider";
  type Row = [Mode, Budget, "up" | "down", number, string, string, boolean];
  // mode, budget (with a provider set, or no provider: not_live), audio service →
  // HTTP status, audio check, provider check, budget check ok.
  const MATRIX: Row[] = [
    ["off", "available", "up", 200, "ok", "configured", true],
    ["off", "available", "down", 503, "unreachable", "configured", true],
    ["off", "exhausted", "up", 503, "ok", "configured", false],
    ["off", "exhausted", "down", 503, "unreachable", "configured", false],
    ["off", "unverifiable", "up", 503, "ok", "configured", false],
    ["off", "unverifiable", "down", 503, "unreachable", "configured", false],
    ["off", "no provider", "up", 503, "ok", "not_configured", true],
    ["off", "no provider", "down", 503, "unreachable", "not_configured", true],
    ["fallback", "available", "up", 200, "ok", "configured", true],
    ["fallback", "available", "down", 503, "unreachable", "configured", true],
    ["fallback", "exhausted", "up", 200, "not_needed", "not_needed", true],
    ["fallback", "exhausted", "down", 200, "not_needed", "not_needed", true],
    ["fallback", "unverifiable", "up", 200, "not_needed", "not_needed", true],
    ["fallback", "unverifiable", "down", 200, "not_needed", "not_needed", true],
    ["fallback", "no provider", "up", 503, "ok", "not_configured", true],
    ["fallback", "no provider", "down", 503, "unreachable", "not_configured", true],
    ["only", "available", "up", 200, "not_needed", "not_needed", true],
    ["only", "available", "down", 200, "not_needed", "not_needed", true],
    ["only", "exhausted", "up", 200, "not_needed", "not_needed", true],
    ["only", "exhausted", "down", 200, "not_needed", "not_needed", true],
    ["only", "unverifiable", "up", 200, "not_needed", "not_needed", true],
    ["only", "unverifiable", "down", 200, "not_needed", "not_needed", true],
    ["only", "no provider", "up", 200, "not_needed", "not_needed", true],
    ["only", "no provider", "down", 200, "not_needed", "not_needed", true],
  ];

  it.each(MATRIX)(
    "REPLAY_MODE=%s, budget %s, audio service %s → %i (audio %s, provider %s, budget ok %s)",
    async (mode, budget, audio, status, audioStatus, providerStatus, budgetOk) => {
      openDatabase();
      process.env.REPLAY_MODE = mode;
      process.env.SPOTIFY_CLIENT_ID = "dummy-spotify-id";
      process.env.SPOTIFY_CLIENT_SECRET = "dummy-spotify-secret";
      process.env.BUDGET_TOTAL_USD = "25";
      const stub = audio === "up" ? await audioStub(healthy) : null;
      process.env.AUDIO_ANALYSIS_URL = stub ? stub.url : await closedPort();
      if (budget === "no provider") {
        process.env.LLM_CASSETTE = "off";
        delete process.env.AZURE_OPENAI_API_KEY;
        delete process.env.AZURE_OPENAI_ENDPOINT;
        delete process.env.AZURE_OPENAI_BASE_URL;
        delete process.env.LLM_SPEND_LOG;
      } else {
        liveProvider({ available: 0.5, exhausted: 30, unverifiable: null }[budget]);
      }

      const res = await ready();

      expect(res.status).toBe(status);
      expect(res.body.status).toBe(status === 200 ? "ready" : "unavailable");
      expect(res.body.checks).toMatchObject({
        database: "ok",
        migrations: "ok",
        audio: audioStatus,
        provider: providerStatus,
        budget: mode === "only" ? "not_needed" : budget === "no provider" ? "not_live" : budget,
      });
      // The public answer names no variable.
      expect(res.text).not.toMatch(ENV_NAME);
      expect(detail(res.body, "budget")).toMatchObject({ ok: budgetOk });
      // A service that is not needed is not asked.
      if (stub && audioStatus === "not_needed") expect(stub.requests()).toBe(0);
    },
  );

  it("with REPLAY_MODE=fallback and no Spotify keys, serves recordings without audio or a provider", async () => {
    openDatabase();
    process.env.REPLAY_MODE = "fallback";
    delete process.env.SPOTIFY_CLIENT_ID;
    delete process.env.SPOTIFY_CLIENT_SECRET;
    process.env.AUDIO_ANALYSIS_URL = await closedPort();
    process.env.LLM_CASSETTE = "off";
    delete process.env.AZURE_OPENAI_API_KEY;
    delete process.env.AZURE_OPENAI_ENDPOINT;

    const res = await ready();

    expect(res.status).toBe(200);
    expect(res.body.checks).toMatchObject({ audio: "not_needed", provider: "not_needed" });
    expect(detail(res.body, "provider")?.reason).toContain("live_disabled");
  });

  it("answers 503 when no database is open", async () => {
    process.env.AUDIO_ANALYSIS_URL = (await audioStub(healthy)).url;

    const res = await ready();

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({
      status: "unavailable",
      checks: { database: "unavailable", migrations: "unavailable" },
    });
    expect(ReadyResponse.safeParse(res.body).success).toBe(true);
  });

  it("answers 503 once the database has been closed", async () => {
    openDatabase();
    closeDatabase();
    process.env.AUDIO_ANALYSIS_URL = (await audioStub(healthy)).url;

    const res = await ready();

    expect(res.status).toBe(503);
  });

  it("answers 503 when the recorded migrations are not this code's", async () => {
    openDatabase();
    process.env.AUDIO_ANALYSIS_URL = (await audioStub(healthy)).url;
    getDb().prepare("DELETE FROM schema_migrations WHERE version = ?").run(LATEST_SCHEMA_VERSION);

    const res = await ready();

    expect(res.status).toBe(503);
    expect(detail(res.body, "migrations")).toMatchObject({
      ok: false,
      status: "mismatch",
      reason: `at schema v${LATEST_SCHEMA_VERSION - 1}, expected schema v${LATEST_SCHEMA_VERSION}`,
    });
  });

  it("does not wait for another connection's write lock, and writes nothing", async () => {
    openDatabase();
    process.env.AUDIO_ANALYSIS_URL = (await audioStub(healthy)).url;
    const other = new Database(dbPath);
    try {
      other.exec("BEGIN IMMEDIATE");
      const started = Date.now();
      const res = await ready();
      // The database's busy timeout is 5 s.
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(detail(res.body, "database")).toMatchObject({ ok: true, status: "ok" });
      other.exec("ROLLBACK");
    } finally {
      other.close();
    }
    // The connection's busy timeout is as before.
    expect(getDb().pragma("busy_timeout", { simple: true })).toBe(5000);

    const res = await ready();
    expect(detail(res.body, "database")).toMatchObject({
      ok: true,
      status: "ok",
      reason: "open and writable",
    });
  });

  it("writes nothing when it proves the database can write", async () => {
    openDatabase();
    process.env.REPLAY_MODE = "only"; // nothing else to ask
    const hash = (path: string) =>
      existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
    const files = () => [hash(dbPath), hash(`${dbPath}-wal`)];
    const other = new Database(dbPath, { readonly: true });
    try {
      const before = {
        files: files(),
        userVersion: getDb().pragma("user_version", { simple: true }),
        dataVersion: other.pragma("data_version", { simple: true }),
      };

      for (let i = 0; i < 20; i++) {
        expect(databaseCheck()).toMatchObject({ ok: true, reason: "open and writable" });
      }
      const res = await ready();
      expect(detail(res.body, "database")).toMatchObject({ ok: true, status: "ok" });

      expect(getDb().inTransaction).toBe(false);
      expect(getDb().pragma("user_version", { simple: true })).toBe(before.userVersion);
      expect(getDb().pragma("busy_timeout", { simple: true })).toBe(5000);
      // No commit: another connection sees no change, and the files are as they were.
      expect(other.pragma("data_version", { simple: true })).toBe(before.dataVersion);
      expect(files()).toEqual(before.files);
    } finally {
      other.close();
    }
  });

  it("answers 503 when a transaction was left open", async () => {
    openDatabase();
    process.env.REPLAY_MODE = "only";
    getDb().exec("BEGIN");
    try {
      const res = await ready();

      expect(res.status).toBe(503);
      expect(detail(res.body, "database")).toMatchObject({
        ok: false,
        status: "unavailable",
        reason: "a transaction was left open",
      });
      // The transaction is not the probe's to end.
      expect(getDb().inTransaction).toBe(true);
    } finally {
      getDb().exec("ROLLBACK");
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    "answers 503 when the database file cannot be written",
    async () => {
      openDatabase();
      closeDatabase();
      chmodSync(dbPath, 0o444);
      // SQLite opens a file it cannot write read-only; the API starts on it.
      initializeDatabase(dbPath);
      process.env.AUDIO_ANALYSIS_URL = (await audioStub(healthy)).url;

      const res = await ready();

      expect(res.status).toBe(503);
      expect(detail(res.body, "database")).toMatchObject({
        ok: false,
        status: "read_only",
        reason: "the database file cannot be written",
      });
      // The probe kept nothing, and left the connection as it was.
      expect(getDb().inTransaction).toBe(false);
      expect(getDb().pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    },
  );

  it.each(["off", "fallback", "only"] as const)(
    "with REPLAY_MODE=%s, a probe logs no warning about the budget",
    async (mode) => {
      openDatabase();
      process.env.REPLAY_MODE = mode;
      process.env.SPOTIFY_CLIENT_ID = "dummy-spotify-id";
      process.env.SPOTIFY_CLIENT_SECRET = "dummy-spotify-secret";
      process.env.BUDGET_TOTAL_USD = "25";
      process.env.AUDIO_ANALYSIS_URL = (await audioStub(healthy)).url;
      const logs = captureLogsForTests();
      try {
        liveProvider(30); // spent
        await ready();
        resetBudgetStateForTests();
        liveProvider(null); // the spend log cannot be used
        await ready();
        await ready();

        expect(logs.entries().filter((entry) => entry.level === "warn")).toEqual([]);
      } finally {
        logs.restore();
      }
    },
  );

  it("with REPLAY_MODE=only, does not read the budget at all", async () => {
    openDatabase();
    process.env.REPLAY_MODE = "only";
    liveProvider(30);
    const spendDir = join(dir as string);
    const before = statSync(spendDir).mtimeMs;

    const res = await ready();

    expect(res.status).toBe(200);
    expect(detail(res.body, "budget")).toMatchObject({ ok: true, status: "not_needed" });
    // No lock file was made (and removed) next to the spend log.
    expect(statSync(spendDir).mtimeMs).toBe(before);
  });

  it("stops reading an audio /health answer past its size limit", async () => {
    openDatabase();
    // An endless body, chunked: only a probe that stops reading answers before its timeout.
    const chunk = "x".repeat(MAX_HEALTH_BYTES);
    process.env.AUDIO_ANALYSIS_URL = (
      await audioStub((res) => {
        res.writeHead(200, { "content-type": "application/json" });
        const timer = setInterval(() => res.write(chunk), 5);
        res.on("close", () => clearInterval(timer));
      })
    ).url;

    const started = Date.now();
    const res = await ready();

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(detail(res.body, "audio")).toMatchObject({
      ok: false,
      status: "unreachable",
      reason: "/health did not answer as the audio service",
    });
  });

  it("does not read an audio /health answer that says it is too long", async () => {
    openDatabase();
    process.env.AUDIO_ANALYSIS_URL = (
      await audioStub((res) => {
        res.writeHead(200, {
          "content-type": "application/json",
          "content-length": String(MAX_HEALTH_BYTES + 1),
        });
        res.flushHeaders(); // and never sends the body
      })
    ).url;

    const started = Date.now();
    const res = await ready();

    expect(Date.now() - started).toBeLessThan(1_000);
    expect(detail(res.body, "audio")).toMatchObject({ ok: false, status: "unreachable" });
  });
});
