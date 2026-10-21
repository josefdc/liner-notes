/**
 * Reads and validates the API's settings from an environment. Pure: it never loads a file or
 * exits, so tests can call it with any environment. config/env.ts applies it to process.env
 * once at startup.
 */

import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export interface RateLimitSettings {
  /** Length of the window, in milliseconds. */
  windowMs: number;
  /** Requests allowed per IP address in one window. */
  max: number;
}

export interface HttpSettings {
  /** Origins allowed to call the API from a browser (exact `scheme://host[:port]` matches). */
  corsOrigins: string[];
  /** Number of reverse proxies in front of the API whose X-Forwarded-For is trusted; 0 = none. */
  trustProxy: number;
  /** Per-IP limit for the routes that call paid services (analysis and factoids). */
  rateLimit: RateLimitSettings;
  /** Limit shared by all clients on the same routes, over the same window. */
  globalRateLimit: RateLimitSettings;
  /** Limit for search suggestions (Spotify). */
  searchRateLimit: RateLimitSettings;
}

export interface Settings {
  production: boolean;
  /** REPLAY_MODE=only (replaying recorded runs): no Spotify or model keys are required. */
  replayOnly: boolean;
  host: string;
  port: number;
  http: HttpSettings;
  llm: LlmSettings;
}

// =============================================================================
// Language model provider (llm/)
// =============================================================================

/** Model tiers: each call site asks for a tier, never for a model. */
export const LLM_TIERS = ["fast", "main", "research", "judge"] as const;
export type LlmTier = (typeof LLM_TIERS)[number];

/** Azure deployment per tier when AZURE_OPENAI_DEPLOYMENT_<TIER> is not set. */
export const DEFAULT_DEPLOYMENTS: Readonly<Record<LlmTier, string>> = {
  fast: "gpt-5.6-terra",
  main: "gpt-6-luna",
  research: "gpt-6-sol",
  judge: "gpt-6-sol",
};

/** The variable that overrides a tier's deployment. */
export const deploymentVariable = (tier: LlmTier) =>
  `AZURE_OPENAI_DEPLOYMENT_${tier.toUpperCase()}`;

export const LLM_PROVIDERS = ["azure", "gemini"] as const;
export type LlmProvider = (typeof LLM_PROVIDERS)[number];

export type LlmCassetteMode = "off" | "record" | "replay";

/** Evaluation purposes with their own spending cap, and the variable that sets each cap. */
export const EVAL_SUB_CAPS = {
  "eval:golden": { variable: "BUDGET_EVAL_GOLDEN_USD", defaultUsd: 13 },
  "eval:baseline": { variable: "BUDGET_EVAL_BASELINE_USD", defaultUsd: 2.5 },
  "eval:perturb": { variable: "BUDGET_EVAL_PERTURB_USD", defaultUsd: 1 },
  "eval:variance": { variable: "BUDGET_EVAL_VARIANCE_USD", defaultUsd: 3.5 },
} as const;
export type EvalSubPurpose = keyof typeof EVAL_SUB_CAPS;

/** What a model call is for. `eval` and its sub-purposes may spend the evaluation floor. */
export const LLM_PURPOSES = ["dev", "eval", "showcase", ...Object.keys(EVAL_SUB_CAPS)] as [
  "dev",
  "eval",
  "showcase",
  ...EvalSubPurpose[],
];
export type LlmPurpose = "dev" | "eval" | "showcase" | EvalSubPurpose;

export interface BudgetSettings {
  /** Hard stop for all spending recorded in the spend log, in USD. */
  totalUsd: number;
  /** Spending allowed per UTC day, in USD. */
  dailyUsd: number;
  /** Part of the total kept for evaluations: other purposes stop once total > total − floor. */
  evalFloorUsd: number;
  /** Cap per evaluation sub-purpose, in USD. */
  evalSubCapsUsd: Record<EvalSubPurpose, number>;
}

export interface LlmSettings {
  provider: LlmProvider;
  /** Null when not set. Never logged or printed. */
  azureApiKey: string | null;
  /**
   * The Azure OpenAI v1 base URL (`https://<resource>…/openai/v1/`), possibly with a query,
   * from AZURE_OPENAI_BASE_URL or AZURE_OPENAI_ENDPOINT; null when neither is set. Never logged
   * or printed.
   */
  azureBaseUrl: string | null;
  deployments: Record<LlmTier, string>;
  cassette: LlmCassetteMode;
  /** Where LLM cassettes live; null for the default (apps/api/cassettes/llm). */
  cassetteDir: string | null;
  /** The cross-process spend log (JSONL); null when not set. Absolute, `~` expanded. */
  spendLog: string | null;
  /**
   * LLM_SPEND_LOG_INIT=1: create the spend log, empty, when it does not exist. Otherwise a
   * missing log is refused, so a mistyped path cannot start a fresh budget at USD 0.
   */
  spendLogInit: boolean;
  /**
   * LangChain/LangSmith tracing is switched on in the environment (LANGSMITH_TRACING or
   * LANGCHAIN_TRACING_V2), which would send prompts and answers to a third party.
   */
  tracingRequested: boolean;
  /** LLM_ALLOW_TRACING=1: allow model calls while tracing is on. */
  allowTracing: boolean;
  budget: BudgetSettings;
  /** Timeout of one attempt of one call, in milliseconds. */
  timeoutMs: number;
  /** Model calls (attempts) allowed per analysis run. */
  maxCallsPerRun: number;
  /** Model calls in flight at once in one process. */
  concurrency: number;
}

export const DEFAULT_LLM_TIMEOUT_MS = 90_000;
export const DEFAULT_MAX_LLM_CALLS_PER_RUN = 12;
export const DEFAULT_LLM_CONCURRENCY = 2;
export const DEFAULT_BUDGET_TOTAL_USD = 25;
export const DEFAULT_BUDGET_DAILY_USD = 13.5;
export const DEFAULT_BUDGET_EVAL_FLOOR_USD = 20;

/** True when calls would reach a paid provider: Azure with a key and an endpoint, no replay. */
export function isLiveProvider(llm: LlmSettings): boolean {
  return (
    llm.provider === "azure" &&
    llm.azureApiKey !== null &&
    llm.azureBaseUrl !== null &&
    llm.cassette !== "replay"
  );
}

function parseUsd(env: NodeJS.ProcessEnv, key: string, fallback: number, errors: string[]): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isFinite(value) || value > 100_000) {
    errors.push(`${key}: expected an amount in USD from 0 to 100000`);
    return fallback;
  }
  return value;
}

/** Expands a leading `~/`; anything else must already be absolute. */
function parseSpendLog(env: NodeJS.ProcessEnv, errors: string[]): string | null {
  const raw = env.LLM_SPEND_LOG?.trim() ?? "";
  if (raw === "") return null;
  const path = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  if (!isAbsolute(path)) {
    errors.push(
      "LLM_SPEND_LOG: expected an absolute path (or one starting with ~/), so every checkout " +
        "and process counts against the same log",
    );
    return null;
  }
  return path;
}

/** An endpoint URL from `variable`, or null (unset or invalid; invalid is reported). */
function parseEndpoint(env: NodeJS.ProcessEnv, variable: string, errors: string[]): URL | null {
  const raw = env[variable]?.trim();
  if (!raw) return null;
  let url: URL | null = null;
  try {
    url = new URL(raw);
  } catch {
    // reported below
  }
  const local = url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  // A query (e.g. ?api-version=preview) is allowed: the client sends it with every request.
  if (
    !url ||
    !(url.protocol === "https:" || (url.protocol === "http:" && local)) ||
    url.hash !== "" ||
    url.username !== "" ||
    url.password !== ""
  ) {
    errors.push(
      `${variable}: expected an https URL with no fragment or user credentials ` +
        "(e.g. https://<resource>.openai.azure.com/)",
    );
    return null;
  }
  return url;
}

/**
 * The v1 API base URL: AZURE_OPENAI_BASE_URL as given, or else AZURE_OPENAI_ENDPOINT (the
 * resource root) with `openai/v1/` appended. The endpoint may be the root, `/openai` or
 * `/openai/v1`; any other path (such as the portal's "Target URI" of one API,
 * `/openai/responses?api-version=…`) is refused, since appending to it gives a wrong URL.
 * AZURE_OPENAI_API_VERSION is accepted and ignored: the v1 API takes no api-version.
 */
export function readAzureBaseUrl(env: NodeJS.ProcessEnv, errors: string[]): string | null {
  if (env.AZURE_OPENAI_BASE_URL?.trim()) {
    return parseEndpoint(env, "AZURE_OPENAI_BASE_URL", errors)?.href ?? null;
  }
  const endpoint = parseEndpoint(env, "AZURE_OPENAI_ENDPOINT", errors);
  if (!endpoint) return null;
  const path = endpoint.pathname.replace(/\/+$/, "");
  if (!["", "/openai", "/openai/v1"].includes(path) || endpoint.search !== "") {
    errors.push(
      "AZURE_OPENAI_ENDPOINT: expected the resource URL (https://<resource>.openai.azure.com/ or " +
        "…/openai/v1/), not the URL of one API; or set AZURE_OPENAI_BASE_URL",
    );
    return null;
  }
  endpoint.pathname = "/openai/v1/";
  return endpoint.href;
}

/**
 * Deployment per tier, first match wins:
 *   fast      AZURE_OPENAI_DEPLOYMENT_FAST, else gpt-5.6-terra
 *   main      AZURE_OPENAI_DEPLOYMENT_MAIN, else AZURE_OPENAI_DEPLOYMENT_FAST, else gpt-6-luna
 *   research  AZURE_OPENAI_DEPLOYMENT_RESEARCH, else AZURE_OPENAI_DEPLOYMENT_PRO, else gpt-6-sol
 *   judge     AZURE_OPENAI_DEPLOYMENT_JUDGE, else AZURE_OPENAI_DEPLOYMENT_PRO, else gpt-6-sol
 */
export function readDeployments(env: NodeJS.ProcessEnv, errors: string[]): Record<LlmTier, string> {
  const key = env.AZURE_OPENAI_API_KEY?.trim();
  const named = (variable: string): string | undefined => {
    const raw = env[variable]?.trim();
    if (!raw) return undefined;
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(raw)) {
      errors.push(`${variable}: expected a deployment name (letters, digits, ".", "_", "-")`);
      return undefined;
    }
    // Deployment names are printed and written to the spend log: refuse a pasted key.
    if (raw === key || /^[0-9a-f]{32}$/i.test(raw) || /^[A-Za-z0-9]{60,}$/.test(raw)) {
      errors.push(`${variable}: looks like an API key, not a deployment name`);
      return undefined;
    }
    return raw;
  };
  const fast = named(deploymentVariable("fast"));
  const pro = named("AZURE_OPENAI_DEPLOYMENT_PRO");
  const main = named(deploymentVariable("main"));
  const research = named(deploymentVariable("research"));
  const judge = named(deploymentVariable("judge"));
  return {
    fast: fast ?? DEFAULT_DEPLOYMENTS.fast,
    main: main ?? fast ?? DEFAULT_DEPLOYMENTS.main,
    research: research ?? pro ?? DEFAULT_DEPLOYMENTS.research,
    judge: judge ?? pro ?? DEFAULT_DEPLOYMENTS.judge,
  };
}

/**
 * The language model settings. Errors and warnings name variables only: never a key, and never
 * the endpoint or a deployment name, which could carry a credential pasted by mistake.
 */
export function readLlmSettings(env: NodeJS.ProcessEnv): {
  settings: LlmSettings;
  errors: string[];
  warnings: string[];
} {
  const errors: string[] = [];
  const warnings: string[] = [];

  const providerRaw = env.LLM_PROVIDER?.trim() || "azure";
  const provider = (LLM_PROVIDERS as readonly string[]).includes(providerRaw)
    ? (providerRaw as LlmProvider)
    : "azure";
  if (provider !== providerRaw) errors.push('LLM_PROVIDER: expected "azure" or "gemini"');

  const azureApiKey = env.AZURE_OPENAI_API_KEY?.trim() || null;
  // Sent in a header: printable ASCII, no space or line break.
  if (azureApiKey !== null && !/^[!-~]+$/.test(azureApiKey)) {
    errors.push("AZURE_OPENAI_API_KEY: expected printable ASCII with no spaces");
  }

  const azureBaseUrl = readAzureBaseUrl(env, errors);
  const deployments = readDeployments(env, errors);

  const cassetteRaw = env.LLM_CASSETTE?.trim() || "off";
  const cassette = (["off", "record", "replay"] as const).find((mode) => mode === cassetteRaw);
  if (!cassette) errors.push('LLM_CASSETTE: expected "record", "replay" or "off"');
  if (cassette && cassette !== "off" && env.NODE_ENV === "production") {
    errors.push(
      `LLM_CASSETTE=${cassette} is not allowed when NODE_ENV=production: cassettes are for ` +
        "tests and evals",
    );
  }
  const cassetteDir = env.LLM_CASSETTE_DIR?.trim() || null;

  const spendLog = parseSpendLog(env, errors);

  const evalSubCapsUsd = Object.fromEntries(
    Object.entries(EVAL_SUB_CAPS).map(([purpose, cap]) => [
      purpose,
      parseUsd(env, cap.variable, cap.defaultUsd, errors),
    ]),
  ) as Record<EvalSubPurpose, number>;
  const budget: BudgetSettings = {
    totalUsd: parseUsd(env, "BUDGET_TOTAL_USD", DEFAULT_BUDGET_TOTAL_USD, errors),
    dailyUsd: parseUsd(env, "BUDGET_DAILY_USD", DEFAULT_BUDGET_DAILY_USD, errors),
    evalFloorUsd: parseUsd(env, "BUDGET_EVAL_FLOOR_USD", DEFAULT_BUDGET_EVAL_FLOOR_USD, errors),
    evalSubCapsUsd,
  };
  if (budget.evalFloorUsd > budget.totalUsd) {
    errors.push("BUDGET_EVAL_FLOOR_USD: must not be larger than BUDGET_TOTAL_USD");
  }
  const aboveTotal = Object.entries(EVAL_SUB_CAPS)
    .filter(([purpose]) => budget.evalSubCapsUsd[purpose as EvalSubPurpose] > budget.totalUsd)
    .map(([, cap]) => cap.variable);
  if (aboveTotal.length > 0) {
    warnings.push(
      `${aboveTotal.join(", ")} above BUDGET_TOTAL_USD: the total is the limit for those purposes`,
    );
  }
  const subCapSum = Object.values(budget.evalSubCapsUsd).reduce((a, b) => a + b, 0);
  if (subCapSum > budget.evalFloorUsd + 1e-9) {
    warnings.push(
      "The BUDGET_EVAL_*_USD sub-caps add up to more than BUDGET_EVAL_FLOOR_USD: evaluations " +
        "can spend beyond the floor, into what development could use",
    );
  }
  if (budget.dailyUsd > budget.totalUsd) {
    warnings.push("BUDGET_DAILY_USD is larger than BUDGET_TOTAL_USD: the total is the limit");
  }

  const settings: LlmSettings = {
    provider,
    azureApiKey,
    azureBaseUrl,
    deployments,
    cassette: cassette ?? "off",
    cassetteDir,
    spendLog,
    spendLogInit: env.LLM_SPEND_LOG_INIT?.trim() === "1",
    tracingRequested: ["LANGSMITH_TRACING", "LANGCHAIN_TRACING_V2", "LANGCHAIN_TRACING"].some(
      (name) => /^(1|true|yes|on)$/i.test(env[name]?.trim() ?? ""),
    ),
    allowTracing: env.LLM_ALLOW_TRACING?.trim() === "1",
    budget,
    timeoutMs: parseInteger(env, "LLM_TIMEOUT_MS", DEFAULT_LLM_TIMEOUT_MS, 1000, 600_000, errors),
    maxCallsPerRun: parseInteger(
      env,
      "MAX_LLM_CALLS_PER_RUN",
      DEFAULT_MAX_LLM_CALLS_PER_RUN,
      1,
      1000,
      errors,
    ),
    concurrency: parseInteger(env, "LLM_CONCURRENCY", DEFAULT_LLM_CONCURRENCY, 1, 32, errors),
  };

  if (provider === "gemini") {
    warnings.push(
      "LLM_PROVIDER=gemini is not implemented yet: model calls are refused as not configured",
    );
  }
  if (isLiveProvider(settings) && settings.spendLog === null) {
    warnings.push("LLM_SPEND_LOG is not set: every live model call will be refused");
  }
  return { settings, errors, warnings };
}

export type SettingsResult =
  | { ok: true; settings: Settings; warnings: string[] }
  | { ok: false; errors: string[] };

/** Keys the API cannot start without, outside REPLAY_MODE=only. */
export const REQUIRED_KEYS = ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"] as const;

/**
 * Optional credentials of the primary-record sources, each sent in a request header: Discogs
 * (`Authorization: Discogs token=…`), SecondHandSongs (`X-API-Key`; without it requests are
 * anonymous) and Genius (`Authorization: Bearer …`).
 */
export const SOURCE_CREDENTIALS = {
  discogs: "DISCOGS_TOKEN",
  secondhandsongs: "SHS_API_KEY",
  genius: "GENIUS_ACCESS_TOKEN",
} as const;

export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3001;
export const DEFAULT_RATE_LIMIT: RateLimitSettings = { windowMs: 10 * 60_000, max: 30 };
export const DEFAULT_GLOBAL_RATE_LIMIT_MAX = 300;
export const DEFAULT_SEARCH_RATE_LIMIT: RateLimitSettings = { windowMs: 60_000, max: 60 };

// The web dev server's ports: 3000, the worktree slots 3100-3190 and Vite's preview port.
const DEV_WEB_PORTS = [3000, 3100, 3110, 3120, 3130, 3140, 3150, 3160, 3170, 3180, 3190, 4173];

/** Origins allowed in development when CORS_ORIGINS is not set. */
export function developmentOrigins(webPort?: string): string[] {
  const ports = new Set(DEV_WEB_PORTS.map(String));
  if (webPort && /^\d{1,5}$/.test(webPort)) ports.add(webPort);
  return [...ports].flatMap((port) => [`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
}

function parseOrigins(value: string, errors: string[]): string[] {
  const origins: string[] = [];
  for (const entry of value.split(",")) {
    const origin = entry.trim();
    if (!origin) continue;
    let url: URL | null = null;
    try {
      url = new URL(origin);
    } catch {
      // reported below
    }
    // Browsers send an origin without its scheme's default port.
    if (
      url &&
      ["http:", "https:"].includes(url.protocol) &&
      url.port === "" &&
      url.origin !== origin
    ) {
      const explicit = origin.match(/^https?:\/\/[^/]+:(\d+)$/);
      if (explicit) {
        errors.push(
          `CORS_ORIGINS: "${origin}" names the default port ${explicit[1]}, which browsers leave out of the Origin header; write "${url.origin}"`,
        );
        continue;
      }
    }
    if (!url || !["http:", "https:"].includes(url.protocol) || url.origin !== origin) {
      errors.push(
        `CORS_ORIGINS: "${origin}" is not an origin (expected scheme://host[:port], no path or trailing slash)`,
      );
      continue;
    }
    origins.push(origin);
  }
  return origins;
}

function parseInteger(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
  errors: string[],
): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === "") return fallback;
  const value = /^\d+$/.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    errors.push(`${key}: expected an integer from ${min} to ${max}`);
    return fallback;
  }
  return value;
}

export function readSettings(env: NodeJS.ProcessEnv): SettingsResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const production = env.NODE_ENV === "production";
  const replayMode = env.REPLAY_MODE?.trim() ?? "";
  if (!["", "off", "only"].includes(replayMode)) {
    errors.push('REPLAY_MODE: expected "only" or "off"');
  }
  const replayOnly = replayMode === "only";

  if (!replayOnly) {
    const missing = REQUIRED_KEYS.filter((key) => !env[key]);
    if (missing.length > 0) {
      errors.push(`Missing required environment variables: ${missing.join(", ")}`);
    }
  }

  const host = env.HOST?.trim() || DEFAULT_HOST;
  const port = parseInteger(env, "PORT", DEFAULT_PORT, 0, 65_535, errors);

  let corsOrigins: string[];
  if (env.CORS_ORIGINS !== undefined) {
    corsOrigins = parseOrigins(env.CORS_ORIGINS, errors);
    if (corsOrigins.length === 0) {
      warnings.push("CORS_ORIGINS is empty: browsers on other origins cannot call the API");
    }
  } else if (production) {
    corsOrigins = [];
    warnings.push("CORS_ORIGINS is not set: browsers on other origins cannot call the API");
  } else {
    corsOrigins = developmentOrigins(env.WEB_PORT);
  }

  // Hop counts only: trusting every proxy would let any client choose its rate-limit key.
  const trustProxy = parseInteger(env, "TRUST_PROXY", 0, 0, 10, errors);

  const rateLimit: RateLimitSettings = {
    windowMs: parseInteger(
      env,
      "RATE_LIMIT_WINDOW_MS",
      DEFAULT_RATE_LIMIT.windowMs,
      1000,
      86_400_000,
      errors,
    ),
    max: parseInteger(env, "RATE_LIMIT_MAX", DEFAULT_RATE_LIMIT.max, 1, 100_000, errors),
  };
  const globalRateLimit: RateLimitSettings = {
    windowMs: rateLimit.windowMs,
    max: parseInteger(
      env,
      "RATE_LIMIT_GLOBAL_MAX",
      DEFAULT_GLOBAL_RATE_LIMIT_MAX,
      1,
      10_000_000,
      errors,
    ),
  };
  const searchRateLimit: RateLimitSettings = {
    windowMs: parseInteger(
      env,
      "SEARCH_RATE_LIMIT_WINDOW_MS",
      DEFAULT_SEARCH_RATE_LIMIT.windowMs,
      1000,
      86_400_000,
      errors,
    ),
    max: parseInteger(
      env,
      "SEARCH_RATE_LIMIT_MAX",
      DEFAULT_SEARCH_RATE_LIMIT.max,
      1,
      100_000,
      errors,
    ),
  };

  // Each source reads its credential when it runs; here they are only checked.
  for (const key of Object.values(SOURCE_CREDENTIALS)) {
    const value = env[key] ?? "";
    // Sent in a header: a token is printable ASCII, with no space or line break.
    if (!/^[!-~]*$/.test(value)) {
      errors.push(`${key}: expected printable ASCII with no spaces`);
    }
  }

  const llm = readLlmSettings(env);
  errors.push(...llm.errors);
  warnings.push(...llm.warnings);

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    warnings,
    settings: {
      production,
      replayOnly,
      host,
      port,
      http: { corsOrigins, trustProxy, rateLimit, globalRateLimit, searchRateLimit },
      llm: llm.settings,
    },
  };
}
