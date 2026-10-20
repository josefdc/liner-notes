import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, initializeDatabase } from "../../store/database.js";
import { createTestApp } from "../testApp.js";
import healthRouter from "./health.js";

let dir: string | undefined;

function openDatabase() {
  dir = mkdtempSync(join(tmpdir(), "health-"));
  initializeDatabase(join(dir, "test.db"));
}

afterEach(() => {
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

describe("GET /api/ready", () => {
  it("answers 200 when the database answers a query", async () => {
    openDatabase();

    const res = await request(createTestApp(healthRouter)).get("/api/ready");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ready", checks: { database: "ok" } });
  });

  it("answers 503 when no database is open", async () => {
    const res = await request(createTestApp(healthRouter)).get("/api/ready");

    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ status: "unavailable", checks: { database: "unavailable" } });
  });

  it("answers 503 once the database has been closed", async () => {
    openDatabase();
    closeDatabase();

    const res = await request(createTestApp(healthRouter)).get("/api/ready");

    expect(res.status).toBe(503);
  });
});
