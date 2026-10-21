/**
 * llm.invoke against a stubbed Responses API: what is sent, what is retried, timeouts, the
 * per-run call cap, settlement and usage rows.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import {
  assertAzureStrict,
  ComposerOutput,
  LLM_SCHEMAS,
  toJsonSchema,
} from "@liner-notes/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { closeDatabase, initializeDatabase } from "../store/database.js";
import { isLlmError, type LlmError } from "./errors.js";
import {
  classifyError,
  createLlm,
  type InvokeOptions,
  MAX_RETRY_WAIT_MS,
  retryAfterMs,
} from "./invoke.js";
import { FALLBACK_PRICE, UNSOURCED_PRICE_MULTIPLIER } from "./prices.js";
import { parseSpendLog, summarise } from "./spendLog.js";
import {
  errorResponse,
  hang,
  type ProviderRoute,
  providerFetch,
  responseBody,
  testSettings,
} from "./testing/providerStub.js";
import { listLlmUsage, type LlmUsageRow } from "./usage.js";

const Schema = z.object({ ok: z.boolean() });
const OPTIONS: InvokeOptions = {
  purpose: "dev",
  runId: "run-1",
  maxOutputTokens: 300,
  schemaName: "Ok",
};

let dir: string;
let log: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-invoke-"));
  log = join(dir, "spend.jsonl");
  writeFileSync(log, "");
  vi.stubGlobal("fetch", () => {
    throw new Error("network denied");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  closeDatabase();
  rmSync(dir, { recursive: true, force: true });
});

function setup(route: ProviderRoute, env: Record<string, string> = {}) {
  const net = providerFetch(route);
  const rows: LlmUsageRow[] = [];
  const waits: number[] = [];
  const llm = createLlm({
    settings: testSettings({ LLM_SPEND_LOG: log, ...env }),
    fetch: net.fetch,
    recordUsage: (row) => rows.push(row),
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { llm, net, rows, waits };
}

const ok = () =>
  Response.json(responseBody({ ok: true }, { input: 100, output: 20, reasoning: 8 }));
const spendLines = () => parseSpendLog(readFileSync(log, "utf8"));

describe("the request", () => {
  it("calls the tier's deployment through the Responses API with strict JSON-schema output", async () => {
    const { llm, net } = setup(ok);
    const result = await llm.invoke("smoke", "research", "say ok", Schema, OPTIONS);
    expect(result.output).toEqual({ ok: true });
    const [call] = net.calls;
    expect(call.url).toBe("https://llm.invalid/openai/v1/responses");
    expect(call.body).toMatchObject({
      model: "gpt-6-sol",
      max_output_tokens: 300,
      reasoning: { effort: "medium" },
      text: { format: { type: "json_schema", name: "Ok", strict: true } },
    });
    expect(call.body).not.toHaveProperty("temperature");
    expect(call.body).not.toHaveProperty("top_p");
    // The provider keeps no copy of the response.
    expect(call.body.store).toBe(false);
  });

  it("calls the v1 API of the resource named by AZURE_OPENAI_ENDPOINT, with no api-version", async () => {
    const { llm, net } = setup(ok, {
      AZURE_OPENAI_BASE_URL: "",
      AZURE_OPENAI_ENDPOINT: "https://llm.invalid/",
      AZURE_OPENAI_API_VERSION: "2024-10-21",
      AZURE_OPENAI_DEPLOYMENT_FAST: "gpt-6-luna",
      AZURE_OPENAI_DEPLOYMENT_PRO: "gpt-6-sol",
    });
    for (const tier of ["fast", "main", "research", "judge"] as const) {
      await llm.invoke("smoke", tier, "say ok", Schema, OPTIONS);
    }
    expect(net.calls.map((c) => c.url)).toEqual(
      Array(4).fill("https://llm.invalid/openai/v1/responses"),
    );
    expect(net.calls.map((c) => [c.body.model, c.body.store])).toEqual([
      ["gpt-6-luna", false],
      ["gpt-6-luna", false],
      ["gpt-6-sol", false],
      ["gpt-6-sol", false],
    ]);
  });

  it("sends the endpoint's query (e.g. an API version) with each request", async () => {
    const { llm, net } = setup(ok, {
      AZURE_OPENAI_BASE_URL: "https://llm.invalid/openai/v1/?api-version=preview",
    });
    await llm.invoke("smoke", "fast", "say ok", Schema, OPTIONS);
    expect(net.calls[0].url).toBe("https://llm.invalid/openai/v1/responses?api-version=preview");
  });

  const wireSchema = (call: { body: Record<string, unknown> }) =>
    (call.body.text as { format: { schema: Record<string, unknown> } }).format.schema;

  it.each(Object.keys(LLM_SCHEMAS))(
    "sends exactly the checked JSON Schema of %s, and it passes the strict rules",
    async (name) => {
      const schema = LLM_SCHEMAS[name as keyof typeof LLM_SCHEMAS] as z.ZodType;
      const { llm, net } = setup(() => errorResponse(400));
      const { schemaName: _, ...withoutName } = OPTIONS;
      await llm.invoke("x", "main", "x", schema, withoutName).catch(() => {});
      const sent = wireSchema(net.calls[0]);
      expect(sent).toEqual(toJsonSchema(schema));
      expect(() => assertAzureStrict(sent)).not.toThrow();
      expect((net.calls[0].body.text as { format: { name: string } }).format.name).toBe(name);
    },
  );

  it("sends a reused sub-schema inlined, as it was checked", async () => {
    const Ref = z.object({ id: z.string(), note: z.string().nullable() });
    const Reused = z.object({ a: Ref, b: z.array(Ref) });
    const { llm, net } = setup(ok);
    await llm
      .invoke("x", "main", "x", Reused, { ...OPTIONS, schemaName: "Reused" })
      .catch(() => {});
    expect(wireSchema(net.calls[0])).toEqual(toJsonSchema(Reused));
    expect(JSON.stringify(wireSchema(net.calls[0]))).not.toContain("$ref");
  });

  it("refuses a schema name the Responses API would reject, before sending", async () => {
    const { llm, net } = setup(ok);
    const error = await llm
      .invoke("x", "main", "x", Schema, { ...OPTIONS, schemaName: "composer output.v2" })
      .catch((e) => e);
    expect(isLlmError(error, "schema_not_strict")).toBe(true);
    expect(net.calls).toHaveLength(0);
  });

  it("uses each tier's deployment and reasoning effort, overridable per tier", async () => {
    const { llm, net } = setup(ok, { AZURE_OPENAI_DEPLOYMENT_JUDGE: "my-judge" });
    for (const tier of ["fast", "main", "research", "judge"] as const) {
      await llm.invoke("smoke", tier, "say ok", Schema, OPTIONS);
    }
    expect(
      net.calls.map((c) => [c.body.model, (c.body.reasoning as { effort: string }).effort]),
    ).toEqual([
      ["gpt-6-luna", "low"],
      ["gpt-6-luna", "low"],
      ["gpt-6-sol", "medium"],
      ["my-judge", "medium"],
    ]);
    for (const call of net.calls) expect(call.body).not.toHaveProperty("temperature");
  });

  it("names a contract schema after its LLM_SCHEMAS entry", async () => {
    expect(LLM_SCHEMAS.ComposerOutput).toBe(ComposerOutput);
    const { llm, net } = setup(() => errorResponse(400));
    const { schemaName: _, ...withoutName } = OPTIONS;
    await llm.invoke("composer", "main", "x", ComposerOutput, withoutName).catch(() => {});
    expect((net.calls[0].body.text as { format: { name: string } }).format.name).toBe(
      "ComposerOutput",
    );
  });

  it("refuses a schema that is not strict before anything is sent", async () => {
    const { llm, net } = setup(ok);
    const loose = z.object({ name: z.string().min(1), note: z.string().optional() });
    const error = await llm.invoke("x", "fast", "hi", loose, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "schema_not_strict")).toBe(true);
    expect(error.message).toContain("minLength");
    expect(net.calls).toHaveLength(0);
  });
});

describe("configuration", () => {
  it("reports missing provider settings by variable name only", async () => {
    const net = providerFetch(ok);
    const settings = { ...testSettings({ LLM_SPEND_LOG: log }), azureApiKey: null };
    const llm = createLlm({ settings, fetch: net.fetch, recordUsage: () => {} });
    const error = await llm.invoke("x", "fast", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "not_configured")).toBe(true);
    expect(error.message).toBe("Model provider not configured: set AZURE_OPENAI_API_KEY");
    expect(net.calls).toHaveLength(0);
  });

  it("refuses LLM_PROVIDER=gemini as not configured", async () => {
    const { llm, net } = setup(ok, { LLM_PROVIDER: "gemini" });
    const error = await llm.invoke("x", "fast", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "not_configured")).toBe(true);
    expect(error.message).toContain("LLM_PROVIDER=gemini is not implemented");
    expect(net.calls).toHaveLength(0);
  });
});

describe("retries", () => {
  it.each([
    [429, "rate_limited"],
    [500, "provider"],
    [503, "provider"],
  ])("retries a %i once, then gives up", async (status, kind) => {
    const { llm, net, waits } = setup(() => errorResponse(status));
    const error = await llm.invoke("x", "fast", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, kind as LlmError["kind"])).toBe(true);
    expect(error.status).toBe(status);
    expect(net.calls).toHaveLength(2);
    expect(waits).toEqual([1000]);
  });

  it("succeeds on the second attempt after a transient error", async () => {
    const { llm, net } = setup((_call, i) => (i === 0 ? errorResponse(502) : ok()));
    const result = await llm.invoke("x", "fast", "hi", Schema, OPTIONS);
    expect(result.usage.attempts).toBe(2);
    expect(net.calls).toHaveLength(2);
  });

  it.each([
    [{ "retry-after": "3" }, 3000],
    [{ "retry-after-ms": "2500" }, 2500],
    [{ "retry-after-ms": "2500", "retry-after": "9" }, 2500],
  ])("waits as long as %o says", async (headers, wait) => {
    const { llm, waits } = setup((_c, i) => (i === 0 ? errorResponse(429, headers) : ok()));
    await llm.invoke("x", "fast", "hi", Schema, OPTIONS);
    expect(waits).toEqual([wait]);
  });

  it("reads an HTTP-date Retry-After", () => {
    const now = Date.parse("2026-10-21T10:00:00Z");
    expect(retryAfterMs({ "retry-after": "Wed, 21 Oct 2026 10:00:05 GMT" }, now)).toBe(5000);
  });

  it("does not retry when Retry-After is longer than it would wait", async () => {
    const { llm, net, waits } = setup((_c, i) =>
      i === 0 ? errorResponse(429, { "retry-after": "45" }) : ok(),
    );
    const error = await llm.invoke("x", "fast", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "rate_limited")).toBe(true);
    expect(error.retryAfterMs).toBe(45_000);
    expect(45_000).toBeGreaterThan(MAX_RETRY_WAIT_MS);
    expect(net.calls).toHaveLength(1);
    expect(waits).toEqual([]);
  });

  it("does not retry a 429 for exhausted quota", async () => {
    const { llm, net } = setup(() =>
      Response.json(
        { error: { message: "quota", type: "insufficient_quota", code: "insufficient_quota" } },
        { status: 429 },
      ),
    );
    const error = await llm.invoke("x", "fast", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "rate_limited")).toBe(true);
    expect(error.transient).toBe(false);
    expect(net.calls).toHaveLength(1);
  });

  it("retries a 409 once", async () => {
    const { llm, net } = setup((_c, i) => (i === 0 ? errorResponse(409) : ok()));
    await llm.invoke("x", "fast", "hi", Schema, OPTIONS);
    expect(net.calls).toHaveLength(2);
  });

  it.each([400, 401, 403, 404])("does not retry a %i", async (status) => {
    const { llm, net } = setup(() => errorResponse(status));
    const error = await llm.invoke("x", "fast", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "provider")).toBe(true);
    expect(net.calls).toHaveLength(1);
  });

  it("does not retry an answer that does not match the schema", async () => {
    const { llm, net } = setup(() =>
      Response.json(responseBody({ ok: "yes" }, { input: 10, output: 5 })),
    );
    const error = await llm.invoke("x", "fast", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "invalid_output")).toBe(true);
    expect(net.calls).toHaveLength(1);
    // The answer was billed: its usage is settled.
    const settle = spendLines().find((l) => l.kind === "settle");
    expect(settle).toMatchObject({
      in: 10,
      out: 5,
      status: "error:invalid_output",
      estimated: false,
    });
  });

  it("retries a dropped connection once, counting its worst case", async () => {
    const { llm, net } = setup(() => {
      throw new TypeError("fetch failed");
    });
    const error = await llm.invoke("x", "fast", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "network")).toBe(true);
    expect(net.calls).toHaveLength(2);
    const settles = spendLines().filter((l) => l.kind === "settle");
    expect(settles.map((l) => [l.status, l.estimated])).toEqual([
      ["error:network", true],
      ["error:network", true],
    ]);
  });

  it("classifies connection failures and client timeouts as transient", () => {
    const state = { timedOut: false, aborted: false, callSite: "x" };
    const kind = (error: unknown) => classifyError(error, state).kind;
    expect(
      kind(Object.assign(new Error("Connection error."), { name: "APIConnectionError" })),
    ).toBe("network");
    // The OpenAI client's classes are named "Error"; only the constructor tells them apart.
    class APIConnectionError extends Error {}
    expect(kind(new APIConnectionError("Connection error."))).toBe("network");
    expect(kind(new TypeError("fetch failed"))).toBe("network");
    expect(kind(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe("network");
    expect(kind(Object.assign(new Error("Request timed out."), { name: "TimeoutError" }))).toBe(
      "timeout",
    );
    expect(kind(Object.assign(new Error("x"), { status: 408 }))).toBe("timeout");
    expect(kind(new Error("something else"))).toBe("provider");
    expect(classifyError(new Error("x"), { ...state, aborted: true }).kind).toBe("aborted");
  });
});

describe("timeout", () => {
  it("gives up on an attempt after LLM_TIMEOUT_MS and retries once", async () => {
    const { llm, net } = setup(hang, { LLM_TIMEOUT_MS: "1000" });
    const started = Date.now();
    const error = await llm.invoke("x", "fast", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "timeout")).toBe(true);
    expect(net.calls).toHaveLength(2);
    expect(Date.now() - started).toBeLessThan(5000);
    // Whether the provider processed the request is unknown: the worst case stays counted.
    const settles = spendLines().filter((l) => l.kind === "settle");
    expect(settles).toHaveLength(2);
    const reserves = spendLines().filter((l) => l.kind === "reserve");
    for (const [i, settle] of settles.entries()) {
      expect(settle).toMatchObject({ status: "error:timeout", estimated: true });
      expect(settle.usd_est).toBe(reserves[i].usd_est);
    }
  });

  it("stops at once, without retrying, when the caller aborts", async () => {
    const { llm, net } = setup(hang);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const error = await llm
      .invoke("x", "fast", "hi", Schema, { ...OPTIONS, signal: controller.signal })
      .catch((e) => e);
    expect(isLlmError(error, "aborted")).toBe(true);
    expect(net.calls).toHaveLength(1);
  });
});

describe("per-run call cap", () => {
  it("refuses the call after MAX_LLM_CALLS_PER_RUN attempts in one run, before sending", async () => {
    const { llm, net } = setup(ok, { MAX_LLM_CALLS_PER_RUN: "3" });
    for (let i = 0; i < 3; i++) await llm.invoke("x", "fast", "hi", Schema, OPTIONS);
    const error = await llm.invoke("x", "fast", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "call_cap")).toBe(true);
    expect(net.calls).toHaveLength(3);
    // Other runs are not affected.
    await llm.invoke("x", "fast", "hi", Schema, { ...OPTIONS, runId: "run-2" });
    expect(llm.callsForRun("run-1")).toBe(3);
  });

  it("counts retries against the cap", async () => {
    const { llm, net } = setup(() => errorResponse(503), { MAX_LLM_CALLS_PER_RUN: "3" });
    await llm.invoke("x", "fast", "hi", Schema, OPTIONS).catch(() => {});
    const error = await llm.invoke("x", "fast", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "call_cap")).toBe(true);
    expect(net.calls).toHaveLength(3);
  });

  it("makes a twelve-call fan-out in one run impossible with the default cap", async () => {
    const { llm, net } = setup(ok);
    const results = await Promise.allSettled(
      Array.from({ length: 13 }, () => llm.invoke("composer", "main", "hi", Schema, OPTIONS)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(12);
    expect(net.calls).toHaveLength(12);
  });
});

describe("accounting", () => {
  it("settles the reported usage at table prices and records a usage row", async () => {
    const { llm, rows } = setup(ok);
    const result = await llm.invoke("smoke", "research", "say ok", Schema, OPTIONS);
    // gpt-6-sol: (100 × 2.20 + 20 × 11.00) / 1e6
    expect(result.usage).toMatchObject({
      inputTokens: 100,
      outputTokens: 20,
      reasoningTokens: 8,
      usdEst: 0.00044,
      multiplier: 1,
    });
    const [reserve, settle] = spendLines();
    expect(reserve.kind).toBe("reserve");
    expect(settle).toMatchObject({
      kind: "settle",
      id: reserve.id,
      usd_est: 0.00044,
      multiplier: 1,
    });
    expect(rows).toMatchObject([
      { id: reserve.id, mode: "live", status: "ok", usdEst: 0.00044, priceMultiplier: 1 },
    ]);
  });

  it("counts a deployment with no public price at the fallback prices × 1.5, visibly", async () => {
    const { llm } = setup(ok, { AZURE_OPENAI_DEPLOYMENT_FAST: "unpriced-deployment" });
    const result = await llm.invoke("smoke", "fast", "say ok", Schema, OPTIONS);
    const expected =
      ((100 * FALLBACK_PRICE.inputPer1M + 20 * FALLBACK_PRICE.outputPer1M) / 1e6) *
      UNSOURCED_PRICE_MULTIPLIER;
    expect(result.usage.usdEst).toBeCloseTo(expected, 6);
    expect(result.usage.multiplier).toBe(1.5);
    for (const line of spendLines()) expect(line.multiplier).toBe(1.5);
  });

  it("settles an error status at zero: the provider bills no failed request", async () => {
    const { llm } = setup(() => errorResponse(400));
    await llm.invoke("x", "fast", "hi", Schema, OPTIONS).catch(() => {});
    const settle = spendLines().find((l) => l.kind === "settle");
    expect(settle).toMatchObject({ usd_est: 0, status: "error:provider", estimated: false });
    expect(summarise(spendLines()).totalUsd).toBe(0);
  });

  it("writes usage rows to the open app database", async () => {
    const db = initializeDatabase(join(dir, "app.db"));
    const net = providerFetch(ok);
    const llm = createLlm({ settings: testSettings({ LLM_SPEND_LOG: log }), fetch: net.fetch });
    await llm.invoke("smoke", "main", "say ok", Schema, OPTIONS);
    expect(listLlmUsage(db, "run-1")).toMatchObject([
      {
        callSite: "smoke",
        tier: "main",
        deployment: "gpt-6-luna",
        purpose: "dev",
        mode: "live",
        status: "ok",
        inputTokens: 100,
        outputTokens: 20,
        reasoningTokens: 8,
        estimated: false,
      },
    ]);
  });

  it("answers within the default concurrency of two calls at a time", async () => {
    let active = 0;
    let peak = 0;
    const { llm } = setup(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 30));
      active -= 1;
      return ok();
    });
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        llm.invoke("x", "fast", "hi", Schema, { ...OPTIONS, runId: `r${i}` }),
      ),
    );
    expect(peak).toBe(2);
  });
});

describe("what errors keep", () => {
  it("scrubs the settings' key and the endpoint host from messages and causes", async () => {
    const key = "zzzz9999zzzz9999zzzz9999zzzz9999";
    const host = "my-resource.openai.azure.com";
    const net = providerFetch(() => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error(`getaddrinfo ENOTFOUND ${host} key ${key}`), {
          code: "ENOTFOUND",
          hostname: host,
        }),
      });
    });
    const unauthorised = providerFetch(() =>
      Response.json({ error: { message: `key ${key} at ${host} is invalid` } }, { status: 401 }),
    );
    for (const stub of [net, unauthorised]) {
      const llm = createLlm({
        settings: testSettings({
          LLM_SPEND_LOG: log,
          AZURE_OPENAI_API_KEY: key,
          AZURE_OPENAI_BASE_URL: `https://${host}/openai/v1/`,
        }),
        fetch: stub.fetch,
        recordUsage: () => {},
        sleep: async () => {},
        env: {},
      });
      const error = await llm.invoke("x", "fast", "hi", Schema, OPTIONS).catch((e) => e);
      expect(isLlmError(error)).toBe(true);
      const dumped = inspect(error, { depth: 10 });
      expect(dumped).not.toContain(key);
      expect(dumped).not.toContain(host);
    }
  });
});

describe("one way to call a model", () => {
  it("exports no chat model that would bypass the budget guard", async () => {
    const factory = await import("./factory.js");
    expect(Object.keys(factory)).not.toContain("createChatModel");
    const pkg = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(pkg.dependencies).not.toHaveProperty("@langchain/openai");
  });

  it("refuses live calls while OPENAI_CUSTOM_HEADERS is set", async () => {
    const { llm, net } = setup(ok, { OPENAI_CUSTOM_HEADERS: "X-Route: other" });
    const error = await llm.invoke("x", "fast", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "not_configured")).toBe(true);
    expect(error.message).toContain("OPENAI_CUSTOM_HEADERS");
    expect(net.calls).toHaveLength(0);
  });

  it("logs nothing from the client even when OPENAI_LOG asks for debug output", async () => {
    vi.stubEnv("OPENAI_LOG", "debug");
    const spies = (["log", "info", "debug", "warn", "error"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const { llm } = setup(ok);
      await llm.invoke("x", "fast", "hi", Schema, OPTIONS);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllEnvs();
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("tracing", () => {
  it("refuses live calls while LangSmith tracing is on, unless allowed", async () => {
    const { llm, net } = setup(ok, { LANGSMITH_TRACING: "true" });
    const error = await llm.invoke("x", "fast", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "not_configured")).toBe(true);
    expect(error.message).toContain("LLM_ALLOW_TRACING");
    expect(net.calls).toHaveLength(0);
  });

  it("sends nothing but the provider request when tracing is allowed", async () => {
    const outbound: string[] = [];
    vi.stubGlobal("fetch", async (input: unknown) => {
      outbound.push(String(input));
      return new Response("{}");
    });
    vi.stubEnv("LANGSMITH_TRACING", "true");
    vi.stubEnv("LANGSMITH_API_KEY", "lsv2_fake_test_key_000000");
    try {
      const { llm, net } = setup(ok, { LANGSMITH_TRACING: "true", LLM_ALLOW_TRACING: "1" });
      await llm.invoke("x", "fast", "the prompt text", Schema, OPTIONS);
      await new Promise((r) => setTimeout(r, 200));
      expect(net.calls).toHaveLength(1);
      expect(outbound).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
