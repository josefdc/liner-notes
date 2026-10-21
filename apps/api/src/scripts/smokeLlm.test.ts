/**
 * smoke:llm refuses before any request when the spend log cannot be used, and otherwise makes
 * one call per tier, printing only status, latency, tokens and cost.
 *
 * The script runs as a child process with fetch replaced by test/fixtures/fakeResponsesApi.mjs,
 * so nothing reaches the network, and with every setting it reads pinned here: it loads the
 * API's settings file like the app, and a developer's values must not change what is checked.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSpendLog } from "../llm/spendLog.js";
import { FAKE_API_KEY, FAKE_BASE_URL } from "../llm/testing/providerStub.js";

const apiRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = join(apiRoot, "..", "..");
const script = join(apiRoot, "src", "scripts", "smokeLlm.ts");
const fakeProvider = join(apiRoot, "test", "fixtures", "fakeResponsesApi.mjs");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "smoke-llm-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function pinnedEnv(overrides: Record<string, string>): Record<string, string> {
  return {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    NODE_ENV: "development",
    REPLAY_MODE: "off",
    SPOTIFY_CLIENT_ID: "test-spotify-id",
    SPOTIFY_CLIENT_SECRET: "test-spotify-secret",
    LLM_PROVIDER: "azure",
    AZURE_OPENAI_API_KEY: FAKE_API_KEY,
    AZURE_OPENAI_BASE_URL: FAKE_BASE_URL,
    AZURE_OPENAI_ENDPOINT: "",
    AZURE_OPENAI_API_VERSION: "",
    AZURE_OPENAI_DEPLOYMENT_PRO: "",
    AZURE_OPENAI_DEPLOYMENT_FAST: "gpt-6-luna",
    AZURE_OPENAI_DEPLOYMENT_MAIN: "gpt-6-luna",
    AZURE_OPENAI_DEPLOYMENT_RESEARCH: "gpt-6-sol",
    AZURE_OPENAI_DEPLOYMENT_JUDGE: "gpt-6-sol",
    LLM_CASSETTE: "off",
    LLM_CASSETTE_DIR: join(dir, "cassettes"),
    LLM_SPEND_LOG: join(dir, "spend.jsonl"),
    LANGSMITH_TRACING: "",
    LANGCHAIN_TRACING_V2: "",
    LANGCHAIN_TRACING: "",
    LANGSMITH_TRACING_V2: "",
    OPENAI_LOG: "",
    OPENAI_CUSTOM_HEADERS: "",
    LLM_ALLOW_TRACING: "",
    BUDGET_TOTAL_USD: "25",
    BUDGET_DAILY_USD: "13.5",
    BUDGET_EVAL_FLOOR_USD: "20",
    BUDGET_EVAL_GOLDEN_USD: "13",
    BUDGET_EVAL_BASELINE_USD: "2.5",
    BUDGET_EVAL_PERTURB_USD: "1",
    BUDGET_EVAL_VARIANCE_USD: "3.5",
    LLM_TIMEOUT_MS: "10000",
    MAX_LLM_CALLS_PER_RUN: "12",
    LLM_CONCURRENCY: "2",
    // Unused here; pinned so a settings file cannot point usage rows at a real database.
    SQLITE_DB_PATH: join(dir, "app.db"),
    ...overrides,
  };
}

function smoke(overrides: Record<string, string>, args: string[] = []) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--import", fakeProvider, script, ...args],
      {
        cwd: repoRoot,
        env: pinnedEnv(overrides),
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function expectNothingSecret(output: string) {
  expect(output).not.toContain(FAKE_API_KEY);
  expect(output).not.toContain("llm.invalid");
}

describe("smoke:llm", () => {
  it("refuses before any request when the spend log's directory does not exist", async () => {
    const missing = join(dir, "nonexistent", "dir", "x.jsonl");
    const run = await smoke({ LLM_SPEND_LOG: missing, FAKE_PROVIDER: "answer" });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("refused before any request");
    expect(run.stderr).toContain("LLM_SPEND_LOG cannot be");
    expect(run.stderr).not.toContain("NETWORK-ATTEMPT");
    expect(run.stdout).not.toMatch(/^fast/m);
    expect(existsSync(join(dir, "nonexistent"))).toBe(false);
    expectNothingSecret(run.stdout + run.stderr);
  }, 60_000);

  it("refuses before any request when LLM_SPEND_LOG is unset with a live provider", async () => {
    const run = await smoke({ LLM_SPEND_LOG: "", FAKE_PROVIDER: "answer" });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("LLM_SPEND_LOG is not set");
    expect(run.stderr).not.toContain("NETWORK-ATTEMPT");
    expectNothingSecret(run.stdout + run.stderr);
  }, 60_000);

  it("reports missing provider settings by name only", async () => {
    const run = await smoke({ AZURE_OPENAI_API_KEY: "", AZURE_OPENAI_BASE_URL: "" });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain(
      "set AZURE_OPENAI_API_KEY, AZURE_OPENAI_ENDPOINT (or AZURE_OPENAI_BASE_URL)",
    );
    expect(run.stderr).not.toContain("NETWORK-ATTEMPT");
  }, 60_000);

  it("refuses before any request when the spend log does not exist", async () => {
    const run = await smoke({ FAKE_PROVIDER: "answer" });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("LLM_SPEND_LOG does not exist");
    expect(run.stderr).not.toContain("NETWORK-ATTEMPT");
    expect(existsSync(join(dir, "spend.jsonl"))).toBe(false);
  }, 60_000);

  it("creates the spend log with --init, and makes no call", async () => {
    const run = await smoke({ FAKE_PROVIDER: "answer" }, ["--init"]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain("spend log created");
    expect(run.stdout).not.toMatch(/^fast/m);
    expect(readFileSync(join(dir, "spend.jsonl"), "utf8")).toBe("");
    const again = await smoke({ FAKE_PROVIDER: "answer" }, ["--init"]);
    expect(again.stdout).toContain("spend log already exists");
  }, 60_000);

  it("moves a torn last line aside with --repair-tail, and makes no call", async () => {
    const torn = '{"ts":"2026-10-21T00:00:00Z","deployment":"x","in":1,"ou';
    writeFileSync(join(dir, "spend.jsonl"), torn);
    const refused = await smoke({ FAKE_PROVIDER: "answer" });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("--repair-tail");
    const run = await smoke({ FAKE_PROVIDER: "answer" }, ["--repair-tail"]);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toContain(`moved the last line (${Buffer.byteLength(torn)} bytes)`);
    expect(run.stdout).not.toMatch(/^fast/m);
    expect(readFileSync(join(dir, "spend.jsonl"), "utf8")).toBe("");
    expect(readFileSync(join(dir, "spend.jsonl.torn"), "utf8")).toContain(torn);
  }, 60_000);

  it("refuses live calls while OPENAI_CUSTOM_HEADERS is set", async () => {
    writeFileSync(join(dir, "spend.jsonl"), "");
    const run = await smoke({ FAKE_PROVIDER: "answer", OPENAI_CUSTOM_HEADERS: "X-Route: other" });
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("OPENAI_CUSTOM_HEADERS");
    expect(run.stderr).not.toContain("X-Route");
    expect(run.stderr).not.toContain("NETWORK-ATTEMPT");
  }, 60_000);

  it("makes one strict-schema call per tier and records each in the spend log", async () => {
    writeFileSync(join(dir, "spend.jsonl"), "");
    const run = await smoke({ FAKE_PROVIDER: "answer" });
    expect(run.code, run.stderr).toBe(0);
    const tierLines = run.stdout.split("\n").filter((l) => /^(fast|main|research|judge)\s/.test(l));
    expect(tierLines.map((l) => l.split(/\s+/).slice(0, 3))).toEqual([
      ["fast", "gpt-6-luna", "ok"],
      ["main", "gpt-6-luna", "ok"],
      ["research", "gpt-6-sol", "ok"],
      ["judge", "gpt-6-sol", "ok"],
    ]);
    for (const line of tierLines) {
      expect(line).toMatch(
        /\d+ ms {2}in 40 out 30 \(reasoning 12\) {2}USD \d+\.\d{6} {2}attempts 1 {2}ok=true$/,
      );
    }
    expectNothingSecret(run.stdout + run.stderr);

    const lines = parseSpendLog(readFileSync(join(dir, "spend.jsonl"), "utf8"));
    const settles = lines.filter((l) => l.kind === "settle");
    expect(settles.map((l) => [l.tier, l.unit, l.callSite, l.status])).toEqual([
      ["fast", "dev", "smoke", "ok"],
      ["main", "dev", "smoke", "ok"],
      ["research", "dev", "smoke", "ok"],
      ["judge", "dev", "smoke", "ok"],
    ]);
    expect(lines.filter((l) => l.kind === "reserve")).toHaveLength(4);
  }, 60_000);

  it("exits non-zero when a call fails", async () => {
    writeFileSync(join(dir, "spend.jsonl"), "");
    // Without FAKE_PROVIDER every request is refused by the fake network.
    const run = await smoke({ LLM_TIMEOUT_MS: "2000" });
    expect(run.code).toBe(1);
    expect(run.stdout).toMatch(/^fast\s+gpt-6-luna\s+failed\s+network/m);
    expectNothingSecret(run.stdout + run.stderr);
  }, 60_000);
});
