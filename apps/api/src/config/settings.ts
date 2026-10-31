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

/**
 * Run tokens (http/runToken.ts) and the Turnstile check that issues them (http/turnstile.ts).
 * The secrets are never logged or printed.
 */
export interface RunTokenSettings {
  /**
   * RUN_TOKEN_SECRET, the key run tokens are signed with; null when unset (development only: a
   * random key per process, so tokens do not outlive the process).
   */
  secret: string | null;
  /** TURNSTILE_SECRET_KEY; null when unset (development only). */
  turnstileSecret: string | null;
  /** TURNSTILE_EXPECTED_HOSTNAME: the only hostname a solved challenge is accepted from. */
  expectedHostname: string | null;
  /**
   * The development bypass: outside production with no Turnstile secret, the Turnstile token
   * DEV_BYPASS_TOKEN passes. Run tokens are still issued and checked.
   */
  bypass: boolean;
}

/**
 * REPLAY_MODE: "off" (default) analyses live; "fallback" analyses live and serves recorded runs
 * of the showcase tracks when live analysis is unavailable; "only" serves recorded runs and
 * never calls a live service.
 */
export const REPLAY_MODES = ["off", "fallback", "only"] as const;
export type ReplayMode = (typeof REPLAY_MODES)[number];

/** The replay mode REPLAY_MODE names (unset or empty: "off"), or null for any other value. */
export function parseReplayMode(raw: string | undefined): ReplayMode | null {
  const value = raw?.trim() ?? "";
  if (value === "") return "off";
  return REPLAY_MODES.find((mode) => mode === value) ?? null;
}

export interface Settings {
  production: boolean;
  replayMode: ReplayMode;
  /** REPLAY_MODE=only (replaying recorded runs): no Spotify or model keys are required. */
  replayOnly: boolean;
  host: string;
  port: number;
  http: HttpSettings;
  runTokens: RunTokenSettings;
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
  fast: "gpt-6-luna",
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

/** The purposes LLM_RUN_PURPOSE may name: the evaluation sub-purposes. */
export const RUN_PURPOSES = Object.keys(EVAL_SUB_CAPS) as EvalSubPurpose[];

/** The purpose of the process's model calls when LLM_RUN_PURPOSE is unset. */
export const DEFAULT_RUN_PURPOSE: LlmPurpose = "dev";

/**
 * LLM_RUN_PURPOSE: the purpose every model call of this process is tagged with (the spend
 * log's `unit`, and the cap it counts against), for an evaluation harness that drives the API.
 * Unset or empty: `dev`. Otherwise one of RUN_PURPOSES, and only where the API runs for
 * development or tests (isDevelopment: NODE_ENV development or test, or unset under the dev
 * script), so a deployment, whatever its NODE_ENV says, spends as `dev` and never from the
 * evaluation floor; also refused with REPLAY_MODE=only (which makes no model call to tag). On a refusal or an unknown value the purpose is `dev`
 * and `error` says why; the API does not start with an error (readSettings), and the model
 * layer refuses every call (readLlmSettings).
 */
export function readRunPurpose(env: NodeJS.ProcessEnv): {
  purpose: LlmPurpose;
  error: string | null;
} {
  const raw = env.LLM_RUN_PURPOSE?.trim() ?? "";
  if (raw === "") return { purpose: DEFAULT_RUN_PURPOSE, error: null };
  const purpose = RUN_PURPOSES.find((candidate) => candidate === raw);
  const refused = (error: string): { purpose: LlmPurpose; error: string } => ({
    purpose: DEFAULT_RUN_PURPOSE,
    error,
  });
  if (!purpose) {
    return refused(`LLM_RUN_PURPOSE: expected one of ${RUN_PURPOSES.join(", ")}, or unset`);
  }
  if (!isDevelopment(env)) {
    return refused(
      `LLM_RUN_PURPOSE is not allowed ${OUTSIDE_DEVELOPMENT}: it is for evaluation runs`,
    );
  }
  if (parseReplayMode(env.REPLAY_MODE) === "only") {
    return refused(
      "LLM_RUN_PURPOSE is not allowed with REPLAY_MODE=only: a replay makes no model call",
    );
  }
  return { purpose, error: null };
}

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
   * LangChain/LangSmith tracing is switched on in the environment (LANGSMITH_TRACING,
   * LANGSMITH_TRACING_V2, LANGCHAIN_TRACING_V2 or LANGCHAIN_TRACING), which would send prompts
   * and answers to a third party.
   */
  tracingRequested: boolean;
  /**
   * OPENAI_CUSTOM_HEADERS is set: the OpenAI client would add its headers to every request (a
   * place for credentials or routing outside this layer's control). Live calls are refused.
   */
  customHeadersSet: boolean;
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

/** Variables that switch LangChain/LangSmith tracing on. */
export const TRACING_SWITCHES = [
  "LANGSMITH_TRACING",
  "LANGSMITH_TRACING_V2",
  "LANGCHAIN_TRACING_V2",
  "LANGCHAIN_TRACING",
] as const;

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
 *   fast      AZURE_OPENAI_DEPLOYMENT_FAST, else gpt-6-luna
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

  // A purpose that is refused refuses every call, rather than tagging it with another purpose.
  const runPurposeError = readRunPurpose(env).error;
  if (runPurposeError) errors.push(runPurposeError);

  const cassetteRaw = env.LLM_CASSETTE?.trim() || "off";
  const cassette = (["off", "record", "replay"] as const).find((mode) => mode === cassetteRaw);
  if (!cassette) errors.push('LLM_CASSETTE: expected "record", "replay" or "off"');
  if (cassette && cassette !== "off" && nodeEnv(env) === "production") {
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
    tracingRequested: TRACING_SWITCHES.some((name) =>
      /^(1|true|yes|on)$/i.test(env[name]?.trim() ?? ""),
    ),
    customHeadersSet: Boolean(env.OPENAI_CUSTOM_HEADERS?.trim()),
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
  // The verifier's judge grades what the main tier wrote: the same model would grade itself.
  if (isLiveProvider(settings) && deployments.judge === deployments.main) {
    warnings.push(
      "The judge and main tiers use the same deployment (AZURE_OPENAI_DEPLOYMENT_JUDGE, " +
        "AZURE_OPENAI_DEPLOYMENT_MAIN): the model that writes the notes would also check them",
    );
  }
  return { settings, errors, warnings };
}

export type SettingsResult =
  | { ok: true; settings: Settings; warnings: string[] }
  | { ok: false; errors: string[] };

/**
 * Keys live analysis needs. The API cannot start without them when REPLAY_MODE is off; with
 * "fallback" it starts and serves only recorded runs until they are set; "only" never uses them.
 */
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

/** Shortest RUN_TOKEN_SECRET, in bytes: an HMAC-SHA256 key is as strong as its 32 bytes. */
export const MIN_RUN_TOKEN_SECRET_BYTES = 32;
/** Longest SSE_HOLD_MS: ten minutes. */
export const MAX_SSE_HOLD_MS = 600_000;

/** NODE_ENV as it is meant: trimmed and in lower case, "" when unset. */
export function nodeEnv(env: NodeJS.ProcessEnv): string {
  return env.NODE_ENV?.trim().toLowerCase() ?? "";
}

/**
 * The API workspace's scripts for local work that read the settings (`npm run dev`, and the
 * model smoke test, which serves nothing): npm names the one running in npm_lifecycle_event.
 */
const DEVELOPMENT_SCRIPTS = new Set(["dev", "smoke:llm"]);

/**
 * True when the API runs for development or tests: NODE_ENV is `development` or `test` (vitest
 * sets `test`), or it is unset and the process is one of DEVELOPMENT_SCRIPTS. Anything else,
 * unset included, is treated as a deployment: the Turnstile and run token secrets are required,
 * and no test setting applies.
 */
export function isDevelopment(env: NodeJS.ProcessEnv): boolean {
  const mode = nodeEnv(env);
  if (mode === "development" || mode === "test") return true;
  return mode === "" && DEVELOPMENT_SCRIPTS.has(env.npm_lifecycle_event ?? "");
}

/**
 * SSE_HOLD_MS: how long a replayed analysis stream is held open, with its heartbeats, before its
 * first event, so a check can see a long stream pass through a proxy. 0 (the default) holds
 * nothing. For development and tests only (isDevelopment): anywhere else the API refuses to
 * start with it set (readSettings), and it reads as 0 whatever its value. Read on every request,
 * like REPLAY_MODE; a value that is not a whole number in range reads as 0.
 */
export function sseHoldMs(env: NodeJS.ProcessEnv = process.env): number {
  if (!isDevelopment(env)) return 0;
  const raw = env.SSE_HOLD_MS?.trim() ?? "";
  const value = /^\d{1,6}$/.test(raw) ? Number(raw) : 0;
  return value <= MAX_SSE_HOLD_MS ? value : 0;
}

/**
 * The run token and Turnstile settings. Outside development and tests (isDevelopment) both
 * secrets are required. In development, without a Turnstile secret, the development bypass
 * applies unless TURNSTILE_BYPASS=0 turns it off; TURNSTILE_BYPASS=1 only says so explicitly:
 * outside development or with a Turnstile secret it is an error, never a way to turn the check
 * off. Errors name variables, never their values.
 */
export function readRunTokenSettings(
  env: NodeJS.ProcessEnv,
  errors: string[],
  warnings: string[],
): RunTokenSettings {
  const development = isDevelopment(env);
  const secret = env.RUN_TOKEN_SECRET?.trim() || null;
  const turnstileSecret = env.TURNSTILE_SECRET_KEY?.trim() || null;

  if (!development && !secret) {
    errors.push(`RUN_TOKEN_SECRET is required ${OUTSIDE_DEVELOPMENT}`);
  }
  if (secret && Buffer.byteLength(secret, "utf8") < MIN_RUN_TOKEN_SECRET_BYTES) {
    errors.push(
      `RUN_TOKEN_SECRET: expected at least ${MIN_RUN_TOKEN_SECRET_BYTES} bytes ` +
        "(e.g. openssl rand -base64 48)",
    );
  }
  if (!development && !turnstileSecret) {
    errors.push(`TURNSTILE_SECRET_KEY is required ${OUTSIDE_DEVELOPMENT}`);
  }
  // Sent in a form body: printable ASCII, no space or line break.
  if (turnstileSecret && !/^[!-~]+$/.test(turnstileSecret)) {
    errors.push("TURNSTILE_SECRET_KEY: expected printable ASCII with no spaces");
  }

  const bypassRaw = env.TURNSTILE_BYPASS?.trim() ?? "";
  if (!["", "0", "1"].includes(bypassRaw)) {
    errors.push('TURNSTILE_BYPASS: expected "1" or "0"');
  } else if (bypassRaw === "1" && !development) {
    errors.push(`TURNSTILE_BYPASS=1 is not allowed ${OUTSIDE_DEVELOPMENT}`);
  } else if (bypassRaw === "1" && turnstileSecret) {
    errors.push(
      "TURNSTILE_BYPASS=1 is not allowed with TURNSTILE_SECRET_KEY set: the bypass applies " +
        "only where no token can be checked",
    );
  }

  const hostnameRaw = env.TURNSTILE_EXPECTED_HOSTNAME?.trim() ?? "";
  let expectedHostname: string | null = null;
  if (hostnameRaw !== "") {
    if (/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(hostnameRaw)) {
      expectedHostname = hostnameRaw.toLowerCase();
    } else {
      errors.push("TURNSTILE_EXPECTED_HOSTNAME: expected a hostname (no scheme, port or path)");
    }
  } else if (!development) {
    warnings.push(
      "TURNSTILE_EXPECTED_HOSTNAME is not set: a challenge solved on any hostname of the " +
        "Turnstile widget is accepted",
    );
  }

  const bypass = development && !turnstileSecret && bypassRaw !== "0";
  return { secret, turnstileSecret, expectedHostname, bypass };
}

/** How the errors that hold outside development say so. */
const OUTSIDE_DEVELOPMENT =
  "unless NODE_ENV is development or test (or unset under the dev script)";

/** SSE_HOLD_MS checked at startup: a whole number in range, and only in development. */
function checkSseHoldMs(env: NodeJS.ProcessEnv, errors: string[]): void {
  const raw = env.SSE_HOLD_MS?.trim() ?? "";
  if (raw === "" || raw === "0") return;
  if (!isDevelopment(env)) {
    errors.push(`SSE_HOLD_MS is not allowed ${OUTSIDE_DEVELOPMENT}: it is for tests`);
    return;
  }
  parseInteger(env, "SSE_HOLD_MS", 0, 0, MAX_SSE_HOLD_MS, errors);
}

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
  const production = nodeEnv(env) === "production";
  const parsedReplayMode = parseReplayMode(env.REPLAY_MODE);
  if (!parsedReplayMode) errors.push('REPLAY_MODE: expected "off", "fallback" or "only"');
  const replayMode = parsedReplayMode ?? "off";
  const replayOnly = replayMode === "only";

  const missing = REQUIRED_KEYS.filter((key) => !env[key]);
  if (missing.length > 0 && replayMode === "off") {
    errors.push(`Missing required environment variables: ${missing.join(", ")}`);
  } else if (missing.length > 0 && replayMode === "fallback") {
    warnings.push(
      `REPLAY_MODE=fallback without ${missing.join(", ")}: live analysis is unavailable, ` +
        "only recorded runs are served",
    );
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

  const runTokens = readRunTokenSettings(env, errors, warnings);
  checkSseHoldMs(env, errors);

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
      replayMode,
      replayOnly,
      host,
      port,
      http: { corsOrigins, trustProxy, rateLimit, globalRateLimit, searchRateLimit },
      runTokens,
      llm: llm.settings,
    },
  };
}
