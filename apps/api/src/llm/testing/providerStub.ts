/**
 * Test helpers for the provider layer: a fetch that answers like the Responses API, settings
 * for a fake Azure endpoint, and a fetch that fails on any use (network denied).
 *
 * The key and endpoint are obvious fakes; nothing here can reach a real provider.
 */

import { type LlmSettings, readLlmSettings } from "../../config/settings.js";

export const FAKE_API_KEY = "test-fake-azure-key-not-a-secret-0000";
export const FAKE_BASE_URL = "https://llm.invalid/openai/v1/";

/** LLM settings from `env`, on top of a fake live Azure configuration. */
export function testSettings(env: NodeJS.ProcessEnv = {}): LlmSettings {
  const { settings, errors } = readLlmSettings({
    AZURE_OPENAI_API_KEY: FAKE_API_KEY,
    AZURE_OPENAI_BASE_URL: FAKE_BASE_URL,
    LLM_CASSETTE: "off",
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

/** A model name that providerFetch replaces with the requested model, as the provider does. */
export const REQUESTED_MODEL = "(requested model)";

/**
 * A Responses API body whose output text is `output` serialised. Its `model` is the requested
 * one unless `model` names another (to test an answer from an unexpected model).
 */
export function responseBody(output: unknown, usage: StubUsage | null, model = REQUESTED_MODEL) {
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
    const response = await route(call, calls.length - 1);
    if (!response.headers.get("content-type")?.includes("json")) return response;
    const body = (await response
      .clone()
      .json()
      .catch(() => null)) as { model?: unknown } | null;
    if (body?.model !== REQUESTED_MODEL) return response;
    return Response.json(
      { ...body, model: call.body.model },
      { status: response.status, headers: response.headers },
    );
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

/**
 * `route`, plus a promise that resolves when the first request reaches it: a test can abort
 * after the request was sent without guessing how long sending takes.
 */
export function onReceipt(route: ProviderRoute) {
  let resolve!: () => void;
  const received = new Promise<void>((r) => {
    resolve = r;
  });
  const wrapped: ProviderRoute = (call, index) => {
    resolve();
    return route(call, index);
  };
  return { route: wrapped, received };
}

/**
 * Waits until the stub has the request, or until `call` settles without sending it (which the
 * test's own expectations then reject). A call that does neither fails here, with a message,
 * after `ms` rather than at the test timeout; a passing test never waits for it.
 */
export async function untilSentOrSettled(
  received: Promise<void>,
  call: Promise<unknown>,
  ms = 4000,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the call neither sent its request nor settled within ${ms} ms`)),
      ms,
    );
  });
  try {
    await Promise.race([received, call, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `call`'s outcome, for a call that must settle on an event the test caused (an abort) without
 * anything else happening first. One that does not fails here, saying `what`, after `ms` rather
 * than at the test timeout; a passing test never waits for it.
 */
export async function settledWithin<T>(call: Promise<T>, what: string, ms = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} (not settled within ${ms} ms)`)), ms);
  });
  try {
    return await Promise.race([call, guard]);
  } finally {
    clearTimeout(timer);
  }
}

/** An error response as the Responses API sends it. */
export const errorResponse = (status: number, headers: Record<string, string> = {}) =>
  Response.json(
    { error: { message: `stub error ${status}`, type: "server_error", code: null } },
    { status, headers },
  );
