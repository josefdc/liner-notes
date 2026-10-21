/**
 * The Responses API client for a tier.
 *
 *   fast      scout, classification, research planner   reasoning effort low
 *   main      composer                                   reasoning effort low
 *   research  research summaries                         reasoning effort medium
 *   judge     verifier, groundedness eval                reasoning effort medium
 *
 * LLM_PROVIDER=azure (default) uses the v1 API of an Azure OpenAI resource (base URL from
 * AZURE_OPENAI_ENDPOINT or AZURE_OPENAI_BASE_URL, key AZURE_OPENAI_API_KEY) through the
 * Responses API. LLM_PROVIDER=gemini is not implemented and is refused as not configured.
 *
 * `invoke.ts` is the only caller: every model call goes through `llm.invoke` and its budget
 * guard, so this module exports no ready-to-use chat model. The `openai` client is used
 * directly so the layer sees the provider's own answer (status, incomplete_details, refusal,
 * whether usage was reported at all) and sends exactly the JSON Schema it checked. A LangChain
 * wrapper, if a call site needs one, belongs behind the guard too.
 *
 * Temperature is never sent (reasoning models reject it), `store: false` is (the provider keeps
 * no copy), and the client's own retries are off: `invoke.ts` decides what is retried, so every
 * attempt passes the budget guard. The client takes nothing from OPENAI_* variables (base URL,
 * key, organisation, project, log level), and live calls are refused while OPENAI_CUSTOM_HEADERS
 * is set.
 */

import OpenAI from "openai";
import {
  deploymentVariable,
  LLM_TIERS,
  type LlmSettings,
  type LlmTier,
} from "../config/settings.js";
import { LlmError } from "./errors.js";

export { DEFAULT_DEPLOYMENTS, LLM_TIERS, type LlmTier } from "../config/settings.js";

export type ReasoningEffort = "low" | "medium";

export const REASONING_EFFORT: Readonly<Record<LlmTier, ReasoningEffort>> = {
  fast: "low",
  main: "low",
  research: "medium",
  judge: "medium",
};

export function isTier(value: string): value is LlmTier {
  return (LLM_TIERS as readonly string[]).includes(value);
}

/** The variables a live Azure call needs that are not set; names only. */
export function missingAzureSettings(settings: LlmSettings): string[] {
  const missing: string[] = [];
  if (settings.azureApiKey === null) missing.push("AZURE_OPENAI_API_KEY");
  if (settings.azureBaseUrl === null) {
    missing.push("AZURE_OPENAI_ENDPOINT (or AZURE_OPENAI_BASE_URL)");
  }
  return missing;
}

/**
 * Throws LlmError not_configured unless live calls to the configured provider are possible,
 * and while LangChain/LangSmith tracing is on without LLM_ALLOW_TRACING=1 (a tracer sends
 * prompts, answers and the endpoint to a third party).
 */
export function assertProviderConfigured(settings: LlmSettings): void {
  if (settings.provider === "gemini") {
    throw new LlmError(
      "not_configured",
      "LLM_PROVIDER=gemini is not implemented in this version; set LLM_PROVIDER=azure",
    );
  }
  const missing = missingAzureSettings(settings);
  if (missing.length > 0) {
    throw new LlmError(
      "not_configured",
      `Model provider not configured: set ${missing.join(", ")}`,
    );
  }
  if (settings.customHeadersSet) {
    throw new LlmError(
      "not_configured",
      "OPENAI_CUSTOM_HEADERS is set, which would add headers to every model request; unset it",
    );
  }
  if (settings.tracingRequested && !settings.allowTracing) {
    throw new LlmError(
      "not_configured",
      "LangSmith/LangChain tracing is on, which would send prompts and answers to " +
        "a tracing service; unset it, or set LLM_ALLOW_TRACING=1 to allow it",
    );
  }
}

/** The endpoint's host, for scrubbing it from messages; null when not configured. */
export function endpointHost(settings: LlmSettings): string | null {
  return settings.azureBaseUrl ? new URL(settings.azureBaseUrl).host : null;
}

/** The base URL without its query, and the query as the client's default query. */
function endpointParts(settings: LlmSettings) {
  // The client appends paths to baseURL as text, so a query there would end up mid-URL.
  const endpoint = new URL(settings.azureBaseUrl as string);
  const defaultQuery = Object.fromEntries(endpoint.searchParams);
  endpoint.search = "";
  return {
    baseURL: endpoint.href,
    ...(Object.keys(defaultQuery).length > 0 ? { defaultQuery } : {}),
  };
}

export interface ClientOptions {
  /** Client-side timeout of one request, in milliseconds. */
  timeoutMs: number;
  /** Replaces the HTTP client's fetch (tests, and invoke's sent-request tracking). */
  fetch?: typeof fetch;
}

/** The Responses API client `invoke.ts` uses; throws LlmError not_configured when not set up. */
export function createResponsesClient(settings: LlmSettings, options: ClientOptions): OpenAI {
  assertProviderConfigured(settings);
  return new OpenAI({
    apiKey: settings.azureApiKey as string,
    ...endpointParts(settings),
    // Never taken from OPENAI_* variables of the environment.
    organization: null,
    project: null,
    webhookSecret: null,
    adminAPIKey: null,
    logLevel: "off",
    maxRetries: 0,
    timeout: options.timeoutMs,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

/** The deployment a tier calls, with the variable that overrides it. */
export function deploymentFor(settings: LlmSettings, tier: LlmTier) {
  return { deployment: settings.deployments[tier], variable: deploymentVariable(tier) };
}
