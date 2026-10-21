/**
 * Requests that carry a credential: a redirect off the request's origin is refused (fetch would
 * forward an X-API-Key, and a downgrade to http would send it in clear), one within the origin
 * is followed; and recorded or logged text never holds a source credential, however short.
 * Uses two local HTTP servers, which are different origins (different ports).
 */

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { describeError, fetchJson, scrubPayload } from "./http.js";

interface Seen {
  path: string;
  headers: IncomingHttpHeaders;
}

function serve(handler: (path: string, reply: (status: number, headers?: object) => void) => void) {
  const seen: Seen[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", headers: req.headers });
    handler(req.url ?? "", (status, headers = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  return { server, seen };
}

const listen = (server: Server) =>
  new Promise<string>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }),
  );

const KEY = "shs-redirect-test-key-0123";

let elsewhere: ReturnType<typeof serve>;
let origin: ReturnType<typeof serve>;
let elsewhereUrl: string;
let originUrl: string;

beforeAll(async () => {
  elsewhere = serve((_path, reply) => reply(200));
  elsewhereUrl = await listen(elsewhere.server);
  origin = serve((path, reply) => {
    if (path === "/away") reply(302, { location: `${elsewhereUrl}/stolen` });
    else if (path === "/moved") reply(301, { location: "/work/1" });
    else if (path === "/loop") reply(302, { location: "/loop" });
    else reply(200);
  });
  originUrl = await listen(origin.server);
});
afterAll(async () => {
  await new Promise((r) => origin.server.close(r));
  await new Promise((r) => elsewhere.server.close(r));
});
afterEach(() => {
  origin.seen.length = 0;
  elsewhere.seen.length = 0;
  delete process.env.SHS_API_KEY;
});

describe("redirects of a request that carries a credential", () => {
  it("refuses one to another origin: the key never reaches it", async () => {
    await expect(
      fetchJson({
        source: "secondhandsongs",
        url: `${originUrl}/away`,
        headers: { Accept: "application/json", "X-API-Key": KEY },
        cassette: false,
      }),
    ).rejects.toMatchObject({ kind: "http", status: 302 });
    expect(origin.seen).toHaveLength(1);
    expect(elsewhere.seen).toHaveLength(0);
  });

  it("follows one within the origin, with the key", async () => {
    const answer = await fetchJson<{ path: string }>({
      source: "secondhandsongs",
      url: `${originUrl}/moved`,
      headers: { "X-API-Key": KEY },
      cassette: false,
    });
    expect(answer.path).toBe("/work/1");
    expect(origin.seen.map((s) => [s.path, s.headers["x-api-key"]])).toEqual([
      ["/moved", KEY],
      ["/work/1", KEY],
    ]);
  });

  it("gives up after five redirects", async () => {
    await expect(
      fetchJson({
        source: "genius",
        url: `${originUrl}/loop`,
        headers: { Authorization: `Bearer ${KEY}` },
        cassette: false,
      }),
    ).rejects.toMatchObject({ message: "genius: too many redirects" });
    expect(origin.seen).toHaveLength(6);
  });

  it("still follows redirects anywhere for a request without a credential", async () => {
    const answer = await fetchJson<{ path: string }>({
      source: "musicbrainz",
      url: `${originUrl}/away`,
      cassette: false,
    });
    expect(answer.path).toBe("/stolen");
  });
});

describe("source credentials in recorded and logged text", () => {
  it("are redacted however short they are", () => {
    process.env.SHS_API_KEY = "k3y";
    expect(describeError(new Error("key k3y rejected"))).toBe("key [redacted] rejected");
    expect(JSON.stringify(scrubPayload({ message: "bad key k3y" }))).not.toContain("k3y");
  });

  it("are redacted under an X-API-Key field of an error body", () => {
    expect(scrubPayload({ "X-API-Key": "abc", detail: "denied" })).toEqual({
      "X-API-Key": "[redacted]",
      detail: "denied",
    });
  });
});
