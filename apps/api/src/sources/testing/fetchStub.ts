/**
 * Test helper: replaces global fetch with a router, so source tests never reach the network.
 * A request the router does not answer fails the test with "unexpected request". As the real
 * fetch does, a request whose signal has already aborted rejects with its reason (it is still
 * listed in `calls`): a stub never answers a request the source would not have got.
 *
 *   const net = stubFetch((call) => call.url.startsWith(SEARCH) ? json({ ... }) : undefined);
 *   ...
 *   expect(net.calls).toHaveLength(1);
 *
 * Undo with vi.unstubAllGlobals() (afterEach).
 */

import { vi } from "vitest";

export interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export type FetchRoute = (call: FetchCall) => Response | undefined | Promise<Response | undefined>;

export function stubFetch(route: FetchRoute) {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const call: FetchCall = {
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : init?.body?.toString(),
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    call.signal?.throwIfAborted();
    const response = await route(call);
    if (!response) throw new Error(`unexpected request: ${call.method} ${url}`);
    return response;
  });
  return { calls };
}

export const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);

export const html = (body: string, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

/** A response that never arrives; it rejects when the request's signal aborts. */
export function never(call: FetchCall): Promise<Response> {
  return new Promise((_resolve, reject) => {
    call.signal?.addEventListener("abort", () => reject(call.signal?.reason));
  });
}
