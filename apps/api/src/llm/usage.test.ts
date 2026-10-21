import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, initializeDatabase } from "../store/database.js";
import { MIGRATIONS, runMigrations } from "../store/migrations.js";
import { type LlmUsageRow, listLlmUsage, recordLlmUsage, recordToOpenDatabase } from "./usage.js";

const row = (over: Partial<LlmUsageRow> = {}): LlmUsageRow => ({
  id: "call-1",
  runId: "run-1",
  callSite: "composer",
  tier: "main",
  deployment: "gpt-6-luna",
  purpose: "dev",
  mode: "live",
  status: "ok",
  inputTokens: 120,
  outputTokens: 40,
  reasoningTokens: 10,
  usdEst: 0.000035,
  priceMultiplier: 1,
  estimated: false,
  latencyMs: 812,
  ...over,
});

let dir: string | null = null;
afterEach(() => {
  closeDatabase();
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("llm_usage", () => {
  it("is created by migration 4", () => {
    expect(MIGRATIONS[3]).toMatchObject({ version: 4, name: "llm_usage" });
    const db = new Database(":memory:");
    runMigrations(db, MIGRATIONS.slice(0, 3));
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'llm_usage'").get()).toBe(
      undefined,
    );
    expect(runMigrations(db)).toEqual([4]);
    expect(db.pragma("user_version", { simple: true })).toBe(4);
    db.close();
  });

  it("stores and lists rows per run, nulls and flags included", () => {
    const db = new Database(":memory:");
    runMigrations(db);
    recordLlmUsage(db, row());
    recordLlmUsage(
      db,
      row({
        id: "call-2",
        status: "error:timeout",
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        estimated: true,
        priceMultiplier: 1.5,
      }),
    );
    recordLlmUsage(db, row({ id: "call-3", runId: "run-2", mode: "replay", usdEst: 0 }));
    expect(listLlmUsage(db, "run-1")).toEqual([
      row(),
      row({
        id: "call-2",
        status: "error:timeout",
        inputTokens: null,
        outputTokens: null,
        reasoningTokens: null,
        estimated: true,
        priceMultiplier: 1.5,
      }),
    ]);
    expect(listLlmUsage(db)).toHaveLength(3);
    db.close();
  });

  it("is written to the open app database, and skipped when none is open", () => {
    recordToOpenDatabase(row({ id: "no-db" }));
    dir = mkdtempSync(join(tmpdir(), "llm-usage-"));
    const db = initializeDatabase(join(dir, "app.db"));
    recordToOpenDatabase(row());
    expect(listLlmUsage(db).map((r) => r.id)).toEqual(["call-1"]);
  });
});
