/**
 * Test helpers for the provider layer: a fetch that answers like the Responses API, settings
 * for a fake Azure endpoint, and a fetch that fails on any use (network denied).
 *
 * The key and endpoint are obvious fakes; nothing here can reach a real provider.
 */

import { type LlmSettings, readLlmSettings } from "../../config/settings.js";

export const FAKE_API_KEY = "test-fake-azure-key-not-a-secret-0000";
export const FAKE_BASE_URL = "https://llm.invalid/openai/v1/";

/**
 * LLM settings from `env`, on top of a fake live Azure configuration. The spend log is created
 * on first use (LLM_SPEND_LOG_INIT=1) unless `env` says otherwise.
 */
export function testSettings(env: NodeJS.ProcessEnv = {}): LlmSettings {
  const { settings, errors } = readLlmSettings({
    AZURE_OPENAI_API_KEY: FAKE_API_KEY,
    AZURE_OPENAI_BASE_URL: FAKE_BASE_URL,
    LLM_CASSETTE: "off",
    LLM_SPEND_LOG_INIT: "1",
    ...env,
  });
  if (errors.length > 0) throw new Error(errors.join("; "));
  return settings;
}

export interface StubUsage {
  input: number;
  output: number;
  reasoning?: number;
}

/** A Responses API body whose output text is `output` serialised. */
export function responseBody(output: unknown, usage: StubUsage | null, model = "gpt-6-sol") {
  const text = typeof output === "string" ? output : JSON.stringify(output);
  return {
    id: "resp_test",
    object: "response",
    created_at: 1_760_000_000,
    status: "completed",
    model,
    output: [
      {
        type: "message",
        id: "msg_test",
        status: "completed",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    ...(usage
      ? {
          usage: {
            input_tokens: usage.input,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens: usage.output,
            output_tokens_details: { reasoning_tokens: usage.reasoning ?? 0 },
            total_tokens: usage.input + usage.output,
          },
        }
      : {}),
  };
}

export interface ProviderCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal?: AbortSignal;
}

export type ProviderRoute = (call: ProviderCall, index: number) => Response | Promise<Response>;

/** A fetch for the model client that records each call and answers with `route`. */
export function providerFetch(route: ProviderRoute) {
  const calls: ProviderCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: ProviderCall = {
      url,
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : {},
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    return route(call, calls.length - 1);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

/** Answers every call with `output` and `usage`. */
export const answer = (output: unknown, usage: StubUsage | null = { input: 100, output: 20 }) =>
  providerFetch(() => Response.json(responseBody(output, usage)));

/** A response that never arrives; it rejects when the request's signal aborts. */
export function hang(call: ProviderCall): Promise<Response> {
  return new Promise((_resolve, reject) => {
    call.signal?.addEventListener("abort", () => reject(call.signal?.reason));
  });
}

/** An error response as the Responses API sends it. */
export const errorResponse = (status: number, headers: Record<string, string> = {}) =>
  Response.json(
    { error: { message: `stub error ${status}`, type: "server_error", code: null } },
    { status, headers },
  );
