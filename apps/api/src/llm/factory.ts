/**
 * Clients for a tier.
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
 * `invoke.ts` calls the Responses API with `createResponsesClient`: the `openai` client that
 * LangChain's ChatOpenAI wraps, used directly so the layer sees the provider's own answer
 * (status, incomplete_details, refusal, whether usage was reported at all) and sends exactly the
 * JSON Schema it checked. LangChain fills missing usage with zeros and re-serialises schemas, so
 * through it an unreported cost reads as USD 0 and the checked schema is not the one sent.
 *
 * `createChatModel` builds the same configuration as a LangChain chat model, for graph code that
 * needs one. Both: temperature is never sent (reasoning models reject it), `store: false` (the
 * provider keeps no copy), and the client's own retries are off (`invoke.ts` decides what is
 * retried, so every attempt passes the budget guard).
 */

import { ChatOpenAI } from "@langchain/openai";
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
  if (settings.tracingRequested && !settings.allowTracing) {
    throw new LlmError(
      "not_configured",
      "LANGSMITH_TRACING or LANGCHAIN_TRACING_V2 is on, which would send prompts and answers to " +
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
    maxRetries: 0,
    timeout: options.timeoutMs,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}

export interface ChatModelOptions extends ClientOptions {
  /** max_output_tokens of the call, reasoning included. */
  maxOutputTokens: number;
}

/** The deployment a tier calls, with the variable that overrides it. */
export function deploymentFor(settings: LlmSettings, tier: LlmTier) {
  return { deployment: settings.deployments[tier], variable: deploymentVariable(tier) };
}

/** A LangChain chat model for `tier`; throws LlmError not_configured when not set up. */
export function createChatModel(
  tier: LlmTier,
  settings: LlmSettings,
  options: ChatModelOptions,
): ChatOpenAI {
  assertProviderConfigured(settings);
  return new ChatOpenAI({
    model: settings.deployments[tier],
    apiKey: settings.azureApiKey as string,
    configuration: {
      ...endpointParts(settings),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    },
    useResponsesApi: true,
    reasoning: { effort: REASONING_EFFORT[tier] },
    // The client sends `reasoning` only for model names it recognises (gpt-5*, gpt-6*, o<n>),
    // but an Azure deployment can have any name: send it for every deployment.
    modelKwargs: { reasoning: { effort: REASONING_EFFORT[tier] }, store: false },
    maxTokens: options.maxOutputTokens,
    timeout: options.timeoutMs,
    maxRetries: 0,
    streaming: false,
  });
}
