import { describe, expect, it } from "vitest";
import {
  DEFAULT_GLOBAL_RATE_LIMIT_MAX,
  DEFAULT_HOST,
  DEFAULT_RATE_LIMIT,
  developmentOrigins,
  readSettings,
  type Settings,
} from "./settings.js";

const KEYS = { SPOTIFY_CLIENT_ID: "x", SPOTIFY_CLIENT_SECRET: "x" };

function settingsOf(env: NodeJS.ProcessEnv): Settings {
  const result = readSettings(env);
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.settings;
}

function errorsOf(env: NodeJS.ProcessEnv): string {
  const result = readSettings(env);
  if (result.ok) throw new Error("expected invalid settings");
  return result.errors.join("; ");
}

describe("readSettings", () => {
  it("requires the Spotify keys", () => {
    expect(errorsOf({})).toContain("SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET");
    expect(errorsOf({ SPOTIFY_CLIENT_ID: "x" })).toContain("SPOTIFY_CLIENT_SECRET");
  });

  it("needs no Spotify or model keys with REPLAY_MODE=only", () => {
    const settings = settingsOf({ REPLAY_MODE: "only" });
    expect(settings.replayOnly).toBe(true);
  });

  it("accepts REPLAY_MODE only as only, off or unset", () => {
    expect(settingsOf({ ...KEYS, REPLAY_MODE: "off" }).replayOnly).toBe(false);
    expect(settingsOf({ ...KEYS, REPLAY_MODE: "" }).replayOnly).toBe(false);
    expect(settingsOf(KEYS).replayOnly).toBe(false);
    for (const value of ["on", "ONLY", "true", "1"]) {
      expect(errorsOf({ ...KEYS, REPLAY_MODE: value })).toContain("REPLAY_MODE");
    }
  });

  it("warns when CORS_ORIGINS is set but empty", () => {
    const result = readSettings({ ...KEYS, CORS_ORIGINS: " , " });
    expect(result.ok && result.warnings.join(" ")).toContain("CORS_ORIGINS is empty");
    const listed = readSettings({ ...KEYS, CORS_ORIGINS: "http://localhost:3000" });
    expect(listed.ok && listed.warnings).toEqual([]);
  });

  it("has a limit across all clients on the paid routes, over the per-IP window", () => {
    expect(settingsOf(KEYS).http.globalRateLimit).toEqual({
      windowMs: DEFAULT_RATE_LIMIT.windowMs,
      max: DEFAULT_GLOBAL_RATE_LIMIT_MAX,
    });
    expect(
      settingsOf({ ...KEYS, RATE_LIMIT_GLOBAL_MAX: "50", RATE_LIMIT_WINDOW_MS: "60000" }).http
        .globalRateLimit,
    ).toEqual({ windowMs: 60_000, max: 50 });
    expect(errorsOf({ ...KEYS, RATE_LIMIT_GLOBAL_MAX: "0" })).toContain("RATE_LIMIT_GLOBAL_MAX");
  });

  it("binds 127.0.0.1 by default and takes HOST and PORT from the environment", () => {
    expect(settingsOf(KEYS)).toMatchObject({ host: DEFAULT_HOST, port: 3001 });
    expect(DEFAULT_HOST).toBe("127.0.0.1");
    expect(settingsOf({ ...KEYS, HOST: "0.0.0.0", PORT: "3111" })).toMatchObject({
      host: "0.0.0.0",
      port: 3111,
    });
  });

  it("rejects a port that is not an integer in range", () => {
    expect(errorsOf({ ...KEYS, PORT: "abc" })).toContain("PORT");
    expect(errorsOf({ ...KEYS, PORT: "70000" })).toContain("PORT");
  });

  it("allows the local web ports in development when CORS_ORIGINS is not set", () => {
    const { corsOrigins } = settingsOf(KEYS).http;
    expect(corsOrigins).toEqual(expect.arrayContaining(developmentOrigins()));
    expect(corsOrigins).toContain("http://localhost:3000");
    expect(corsOrigins).toContain("http://127.0.0.1:3110");
    expect(settingsOf({ ...KEYS, WEB_PORT: "3290" }).http.corsOrigins).toContain(
      "http://localhost:3290",
    );
  });

  it("allows no origin in production when CORS_ORIGINS is not set, with a warning", () => {
    const result = readSettings({ ...KEYS, NODE_ENV: "production" });
    expect(result.ok && result.settings.http.corsOrigins).toEqual([]);
    expect(result.ok && result.warnings.join(" ")).toContain("CORS_ORIGINS");
  });

  it("reads CORS_ORIGINS as a comma-separated list of exact origins", () => {
    const env = {
      ...KEYS,
      CORS_ORIGINS: " https://app.example , http://localhost:3110,",
      NODE_ENV: "production",
    };
    expect(settingsOf(env).http.corsOrigins).toEqual([
      "https://app.example",
      "http://localhost:3110",
    ]);
    expect(settingsOf({ ...KEYS, CORS_ORIGINS: "" }).http.corsOrigins).toEqual([]);
  });

  it.each([
    "*",
    "https://app.example/",
    "https://app.example/path",
    "app.example",
    "ftp://x.example",
  ])("rejects %s as a CORS origin", (origin) => {
    expect(errorsOf({ ...KEYS, CORS_ORIGINS: origin })).toContain("CORS_ORIGINS");
  });

  it("explains that a default port must be left out of a CORS origin", () => {
    expect(errorsOf({ ...KEYS, CORS_ORIGINS: "http://localhost:80" })).toContain(
      'default port 80, which browsers leave out of the Origin header; write "http://localhost"',
    );
    expect(errorsOf({ ...KEYS, CORS_ORIGINS: "https://app.example:443" })).toContain(
      'write "https://app.example"',
    );
  });

  it("trusts no proxy by default and takes a hop count", () => {
    expect(settingsOf(KEYS).http.trustProxy).toBe(0);
    expect(settingsOf({ ...KEYS, TRUST_PROXY: "1" }).http.trustProxy).toBe(1);
    expect(errorsOf({ ...KEYS, TRUST_PROXY: "true" })).toContain("TRUST_PROXY");
  });

  it("has rate-limit defaults and validates overrides", () => {
    expect(settingsOf(KEYS).http.rateLimit).toEqual(DEFAULT_RATE_LIMIT);
    expect(
      settingsOf({ ...KEYS, RATE_LIMIT_MAX: "5", RATE_LIMIT_WINDOW_MS: "60000" }).http.rateLimit,
    ).toEqual({ max: 5, windowMs: 60_000 });
    expect(errorsOf({ ...KEYS, RATE_LIMIT_MAX: "0" })).toContain("RATE_LIMIT_MAX");
    expect(errorsOf({ ...KEYS, SEARCH_RATE_LIMIT_MAX: "-1" })).toContain("SEARCH_RATE_LIMIT_MAX");
  });

  it("treats the primary-record source credentials as optional", () => {
    const result = readSettings({ ...KEYS, DISCOGS_TOKEN: "", GENIUS_ACCESS_TOKEN: "abc123" });
    expect(result).toMatchObject({ ok: true, warnings: [] });
    expect(readSettings({ ...KEYS, SHS_API_KEY: "k" }).ok).toBe(true);
  });

  it("rejects a source credential that cannot be sent in a header", () => {
    expect(errorsOf({ ...KEYS, DISCOGS_TOKEN: "abc def" })).toContain("DISCOGS_TOKEN");
    expect(errorsOf({ ...KEYS, GENIUS_ACCESS_TOKEN: "abc\n" })).toContain("GENIUS_ACCESS_TOKEN");
    expect(errorsOf({ ...KEYS, SHS_API_KEY: " abc" })).toContain("SHS_API_KEY");
    // The message names the variable, never its value.
    expect(errorsOf({ ...KEYS, DISCOGS_TOKEN: "secret value" })).not.toContain("secret");
  });
});

describe("language model settings", () => {
  const AZURE = {
    ...KEYS,
    AZURE_OPENAI_API_KEY: "test-fake-key-0000",
    AZURE_OPENAI_BASE_URL: "https://example-resource.openai.azure.com/openai/v1/",
  };

  it("defaults to Azure, the default deployments and the planned budget", () => {
    const { llm } = settingsOf(KEYS);
    expect(llm).toMatchObject({
      provider: "azure",
      azureApiKey: null,
      azureBaseUrl: null,
      deployments: {
        fast: "gpt-6-luna",
        main: "gpt-6-luna",
        research: "gpt-6-sol",
        judge: "gpt-6-sol",
      },
      cassette: "off",
      spendLog: null,
      budget: {
        totalUsd: 25,
        dailyUsd: 13.5,
        evalFloorUsd: 20,
        evalSubCapsUsd: {
          "eval:golden": 13,
          "eval:baseline": 2.5,
          "eval:perturb": 1,
          "eval:variance": 3.5,
        },
      },
      timeoutMs: 90_000,
      maxCallsPerRun: 12,
      concurrency: 2,
    });
  });

  it("needs no model settings to start, and warns about none when no provider is set", () => {
    expect(readSettings(KEYS)).toMatchObject({ ok: true, warnings: [] });
  });

  it("warns when a live provider is configured without a spend log", () => {
    const result = readSettings(AZURE);
    expect(result.ok && result.warnings.join(" ")).toContain("LLM_SPEND_LOG is not set");
    const withLog = readSettings({ ...AZURE, LLM_SPEND_LOG: "/var/tmp/spend.jsonl" });
    expect(withLog.ok && withLog.warnings).toEqual([]);
    // Replay makes no live calls and needs no log.
    expect(readSettings({ ...AZURE, LLM_CASSETTE: "replay" })).toMatchObject({ warnings: [] });
  });

  it("overrides a tier's deployment by variable", () => {
    const { llm } = settingsOf({ ...KEYS, AZURE_OPENAI_DEPLOYMENT_JUDGE: "judge-2" });
    expect(llm.deployments).toMatchObject({ judge: "judge-2", research: "gpt-6-sol" });
    expect(errorsOf({ ...KEYS, AZURE_OPENAI_DEPLOYMENT_MAIN: "has space" })).toContain(
      "AZURE_OPENAI_DEPLOYMENT_MAIN",
    );
  });

  it("expands ~ in LLM_SPEND_LOG and requires an absolute path", () => {
    const { llm } = settingsOf({ ...KEYS, LLM_SPEND_LOG: "~/state/spend.jsonl" });
    expect(llm.spendLog).toMatch(/^\/.+\/state\/spend\.jsonl$/);
    expect(llm.spendLog?.startsWith("~")).toBe(false);
    expect(errorsOf({ ...KEYS, LLM_SPEND_LOG: "spend.jsonl" })).toContain("LLM_SPEND_LOG");
    expect(settingsOf({ ...KEYS, LLM_SPEND_LOG: "" }).llm.spendLog).toBeNull();
  });

  it("validates the provider, cassette mode and amounts", () => {
    expect(errorsOf({ ...KEYS, LLM_PROVIDER: "openai" })).toContain("LLM_PROVIDER");
    expect(errorsOf({ ...KEYS, LLM_CASSETTE: "on" })).toContain("LLM_CASSETTE");
    expect(errorsOf({ ...KEYS, BUDGET_TOTAL_USD: "-1" })).toContain("BUDGET_TOTAL_USD");
    expect(errorsOf({ ...KEYS, BUDGET_DAILY_USD: "lots" })).toContain("BUDGET_DAILY_USD");
    expect(errorsOf({ ...KEYS, BUDGET_EVAL_GOLDEN_USD: "1e3" })).toContain(
      "BUDGET_EVAL_GOLDEN_USD",
    );
    expect(errorsOf({ ...KEYS, BUDGET_TOTAL_USD: "10" })).toContain(
      "BUDGET_EVAL_FLOOR_USD: must not be larger than BUDGET_TOTAL_USD",
    );
    expect(errorsOf({ ...KEYS, MAX_LLM_CALLS_PER_RUN: "0" })).toContain("MAX_LLM_CALLS_PER_RUN");
    expect(errorsOf({ ...KEYS, LLM_TIMEOUT_MS: "5" })).toContain("LLM_TIMEOUT_MS");
    expect(settingsOf({ ...KEYS, BUDGET_DAILY_USD: "2.75" }).llm.budget.dailyUsd).toBe(2.75);
  });

  it("refuses cassettes in production", () => {
    expect(errorsOf({ ...KEYS, NODE_ENV: "production", LLM_CASSETTE: "replay" })).toContain(
      "LLM_CASSETTE=replay is not allowed",
    );
    expect(settingsOf({ ...KEYS, NODE_ENV: "production", LLM_CASSETTE: "off" }).llm.cassette).toBe(
      "off",
    );
  });

  it("names variables in errors, never their values", () => {
    const errors = errorsOf({
      ...KEYS,
      AZURE_OPENAI_API_KEY: "secret value",
      AZURE_OPENAI_BASE_URL: "https://user:leaked@secret-resource.example/openai/v1/",
      AZURE_OPENAI_DEPLOYMENT_FAST: "secret deployment",
      LLM_PROVIDER: "secret-provider",
    });
    expect(errors).toContain("AZURE_OPENAI_API_KEY");
    expect(errors).toContain("AZURE_OPENAI_BASE_URL");
    expect(errors).toContain("AZURE_OPENAI_DEPLOYMENT_FAST");
    expect(errors).not.toContain("secret");
    expect(errors).not.toContain("leaked");
  });

  it("accepts an endpoint with a query, such as an API version", () => {
    const url = "https://example-resource.openai.azure.com/openai/v1/?api-version=preview";
    expect(settingsOf({ ...KEYS, AZURE_OPENAI_BASE_URL: url }).llm.azureBaseUrl).toBe(url);
    expect(errorsOf({ ...KEYS, AZURE_OPENAI_BASE_URL: `${url}#x` })).toContain(
      "AZURE_OPENAI_BASE_URL",
    );
  });

  it("accepts an http endpoint only on this machine", () => {
    expect(
      settingsOf({ ...KEYS, AZURE_OPENAI_BASE_URL: "http://127.0.0.1:8080/v1/" }).llm.azureBaseUrl,
    ).toBe("http://127.0.0.1:8080/v1/");
    expect(errorsOf({ ...KEYS, AZURE_OPENAI_BASE_URL: "http://example.com/v1/" })).toContain(
      "AZURE_OPENAI_BASE_URL",
    );
  });

  it.each([
    [
      "no deployment variables",
      {},
      { fast: "gpt-6-luna", main: "gpt-6-luna", research: "gpt-6-sol", judge: "gpt-6-sol" },
    ],
    [
      "FAST and PRO only",
      { AZURE_OPENAI_DEPLOYMENT_FAST: "gpt-6-luna", AZURE_OPENAI_DEPLOYMENT_PRO: "gpt-6-sol" },
      { fast: "gpt-6-luna", main: "gpt-6-luna", research: "gpt-6-sol", judge: "gpt-6-sol" },
    ],
    [
      "FAST only",
      { AZURE_OPENAI_DEPLOYMENT_FAST: "fast-x" },
      { fast: "fast-x", main: "fast-x", research: "gpt-6-sol", judge: "gpt-6-sol" },
    ],
    [
      "PRO only",
      { AZURE_OPENAI_DEPLOYMENT_PRO: "pro-x" },
      { fast: "gpt-6-luna", main: "gpt-6-luna", research: "pro-x", judge: "pro-x" },
    ],
    [
      "per-tier variables over FAST and PRO",
      {
        AZURE_OPENAI_DEPLOYMENT_FAST: "fast-x",
        AZURE_OPENAI_DEPLOYMENT_PRO: "pro-x",
        AZURE_OPENAI_DEPLOYMENT_MAIN: "main-x",
        AZURE_OPENAI_DEPLOYMENT_RESEARCH: "research-x",
        AZURE_OPENAI_DEPLOYMENT_JUDGE: "judge-x",
      },
      { fast: "fast-x", main: "main-x", research: "research-x", judge: "judge-x" },
    ],
  ])("resolves tier deployments with %s", (_name, env, expected) => {
    expect(settingsOf({ ...KEYS, ...env }).llm.deployments).toEqual(expected);
  });

  it("names AZURE_OPENAI_DEPLOYMENT_PRO when it is not a deployment name", () => {
    expect(errorsOf({ ...KEYS, AZURE_OPENAI_DEPLOYMENT_PRO: "bad name" })).toContain(
      "AZURE_OPENAI_DEPLOYMENT_PRO",
    );
  });

  it.each([
    [
      "https://res.cognitiveservices.azure.com/",
      "https://res.cognitiveservices.azure.com/openai/v1/",
    ],
    [
      "https://res.cognitiveservices.azure.com",
      "https://res.cognitiveservices.azure.com/openai/v1/",
    ],
    ["https://res.openai.azure.com/openai/v1", "https://res.openai.azure.com/openai/v1/"],
    ["https://res.openai.azure.com/openai/v1/", "https://res.openai.azure.com/openai/v1/"],
    ["https://res.openai.azure.com/openai/", "https://res.openai.azure.com/openai/v1/"],
    ["https://res.openai.azure.com/openai", "https://res.openai.azure.com/openai/v1/"],
  ])("derives the v1 base URL from AZURE_OPENAI_ENDPOINT %s", (endpoint, expected) => {
    expect(settingsOf({ ...KEYS, AZURE_OPENAI_ENDPOINT: endpoint }).llm.azureBaseUrl).toBe(
      expected,
    );
  });

  it.each([
    "https://res.cognitiveservices.azure.com/openai/responses?api-version=2025-04-01-preview",
    "https://res.openai.azure.com/proxy/",
    "https://res.openai.azure.com/?api-version=2024-10-21",
  ])("refuses an AZURE_OPENAI_ENDPOINT that is not a resource URL: %s", (endpoint) => {
    const errors = errorsOf({ ...KEYS, AZURE_OPENAI_ENDPOINT: endpoint });
    expect(errors).toContain("AZURE_OPENAI_ENDPOINT: expected the resource URL");
    expect(errors).not.toContain("res.");
  });

  it("prefers AZURE_OPENAI_BASE_URL, and ignores AZURE_OPENAI_API_VERSION", () => {
    const { llm } = settingsOf({
      ...KEYS,
      AZURE_OPENAI_ENDPOINT: "https://res.cognitiveservices.azure.com/",
      AZURE_OPENAI_BASE_URL: "https://other.openai.azure.com/openai/v1/",
      AZURE_OPENAI_API_VERSION: "2024-10-21",
    });
    expect(llm.azureBaseUrl).toBe("https://other.openai.azure.com/openai/v1/");
    const fromEndpoint = settingsOf({
      ...KEYS,
      AZURE_OPENAI_ENDPOINT: "https://res.cognitiveservices.azure.com/",
      AZURE_OPENAI_API_VERSION: "2024-10-21",
    });
    expect(fromEndpoint.llm.azureBaseUrl).toBe(
      "https://res.cognitiveservices.azure.com/openai/v1/",
    );
    expect(fromEndpoint.llm.azureBaseUrl).not.toContain("api-version");
  });

  it("treats the owner's settings shape as a live provider", () => {
    const result = readSettings({
      ...KEYS,
      LLM_PROVIDER: "azure",
      AZURE_OPENAI_ENDPOINT: "https://res.cognitiveservices.azure.com/",
      AZURE_OPENAI_API_KEY: "test-fake-key-0000",
      AZURE_OPENAI_API_VERSION: "2024-10-21",
      AZURE_OPENAI_DEPLOYMENT_FAST: "gpt-6-luna",
      AZURE_OPENAI_DEPLOYMENT_PRO: "gpt-6-sol",
      LLM_SPEND_LOG: "/var/tmp/spend.jsonl",
    });
    expect(result).toMatchObject({ ok: true, warnings: [] });
    if (!result.ok) return;
    expect(result.settings.llm.azureBaseUrl).toBe(
      "https://res.cognitiveservices.azure.com/openai/v1/",
    );
    expect(result.settings.llm.deployments).toEqual({
      fast: "gpt-6-luna",
      main: "gpt-6-luna",
      research: "gpt-6-sol",
      judge: "gpt-6-sol",
    });
  });

  it("names AZURE_OPENAI_ENDPOINT, not its value, when it is invalid", () => {
    const errors = errorsOf({ ...KEYS, AZURE_OPENAI_ENDPOINT: "ftp://secret-host/" });
    expect(errors).toContain("AZURE_OPENAI_ENDPOINT");
    expect(errors).not.toContain("secret");
  });

  it("refuses a deployment name that looks like a pasted key", () => {
    const hex = "0123456789abcdef0123456789abcdef";
    const errors = errorsOf({ ...KEYS, AZURE_OPENAI_DEPLOYMENT_FAST: hex });
    expect(errors).toContain("AZURE_OPENAI_DEPLOYMENT_FAST: looks like an API key");
    expect(errors).not.toContain(hex);
    const same = errorsOf({
      ...KEYS,
      AZURE_OPENAI_API_KEY: "plain-key-value",
      AZURE_OPENAI_DEPLOYMENT_PRO: "plain-key-value",
    });
    expect(same).toContain("AZURE_OPENAI_DEPLOYMENT_PRO: looks like an API key");
    expect(same).not.toContain("plain-key-value");
  });

  it("never echoes a raw value in a startup error", () => {
    const errors = errorsOf({
      ...KEYS,
      BUDGET_TOTAL_USD: "secret-1",
      LLM_TIMEOUT_MS: "secret-2",
      REPLAY_MODE: "secret-3",
    });
    expect(errors).toContain("BUDGET_TOTAL_USD");
    expect(errors).toContain("LLM_TIMEOUT_MS");
    expect(errors).toContain("REPLAY_MODE");
    expect(errors).not.toContain("secret");
  });

  it("warns when the eval sub-caps add up to more than the floor, or exceed the total", () => {
    const sum = readSettings({ ...KEYS, BUDGET_EVAL_GOLDEN_USD: "18" });
    expect(sum.ok && sum.warnings.join(" ")).toContain("add up to more than BUDGET_EVAL_FLOOR_USD");
    const above = readSettings({ ...KEYS, BUDGET_EVAL_GOLDEN_USD: "100" });
    expect(above.ok && above.warnings.join(" ")).toContain(
      "BUDGET_EVAL_GOLDEN_USD above BUDGET_TOTAL_USD",
    );
    const daily = readSettings({ ...KEYS, BUDGET_DAILY_USD: "1000" });
    expect(daily.ok && daily.warnings.join(" ")).toContain("BUDGET_DAILY_USD is larger");
    expect(readSettings(KEYS)).toMatchObject({ warnings: [] });
  });

  it("reads the tracing switches, LLM_ALLOW_TRACING and OPENAI_CUSTOM_HEADERS", () => {
    expect(settingsOf(KEYS).llm).toMatchObject({
      tracingRequested: false,
      allowTracing: false,
      customHeadersSet: false,
    });
    for (const name of [
      "LANGSMITH_TRACING",
      "LANGSMITH_TRACING_V2",
      "LANGCHAIN_TRACING_V2",
      "LANGCHAIN_TRACING",
    ]) {
      expect(settingsOf({ ...KEYS, [name]: "true" }).llm.tracingRequested, name).toBe(true);
    }
    expect(
      settingsOf({ ...KEYS, LLM_ALLOW_TRACING: "1", OPENAI_CUSTOM_HEADERS: "X-Route: a" }).llm,
    ).toMatchObject({ allowTracing: true, customHeadersSet: true });
    // LLM_SPEND_LOG_INIT is gone: only smoke:llm --init creates a spend log.
    expect(settingsOf({ ...KEYS, LLM_SPEND_LOG_INIT: "1" }).llm).not.toHaveProperty("spendLogInit");
    expect(settingsOf({ ...KEYS, LANGSMITH_TRACING: "false" }).llm.tracingRequested).toBe(false);
  });
});
