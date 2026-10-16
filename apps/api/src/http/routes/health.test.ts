import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { closeDatabase, initializeDatabase } from "../../store/database.js";
import { createTestApp } from "../testApp.js";
import healthRouter from "./health.js";

describe("GET /api/health", () => {
  let dir: string | undefined;

  afterEach(() => {
    closeDatabase();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("reports a connected database", async () => {
    dir = mkdtempSync(join(tmpdir(), "health-"));
    initializeDatabase(join(dir, "test.db"));

    const res = await request(createTestApp(healthRouter)).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "ok", database: "connected" });
  });

  it("reports an unavailable database when none is open", async () => {
    const res = await request(createTestApp(healthRouter)).get("/api/health");

    expect(res.status).toBe(200);
    expect(res.body.database).toBe("unavailable");
  });
});
