/**
 * Requests that carry a credential: a redirect off the request's origin is refused (fetch would
 * forward an X-API-Key, and a downgrade to http would send it in clear), one within the origin
 * is followed; and recorded or logged text never holds a source credential, however short.
 * Uses two local HTTP servers, which are different origins (different ports).
 */

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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

describe("redirects of a credentialed POST", () => {
  let server: ReturnType<typeof createServer>;
  let base: string;
  const seen: Array<{ method: string; path: string; body: string; auth?: string; type?: string }> =
    [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        seen.push({
          method: req.method ?? "",
          path: req.url ?? "",
          body,
          auth: req.headers.authorization,
          type: req.headers["content-type"],
        });
        const status = req.url?.startsWith("/s") ? Number(req.url.slice(2)) : 0;
        if (status) {
          res.writeHead(status, { location: "/done", "content-type": "text/plain" });
          res.end("moved");
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ method: req.method }));
      });
    });
    base = await listen(server);
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });

  it.each([
    [303, "GET"],
    [302, "GET"],
    [301, "GET"],
    [307, "POST"],
  ])("follows a %i as %s, as fetch does", async (status, method) => {
    seen.length = 0;
    const answer = await fetchJson<{ method: string }>({
      source: "spotify",
      url: `${base}/s${status}`,
      method: "POST",
      headers: {
        Authorization: "Basic dGVzdDp0ZXN0",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      cassette: false,
    });
    expect(answer.method).toBe(method);
    const [, followed] = seen;
    expect(followed).toMatchObject({ method, path: "/done", auth: "Basic dGVzdDp0ZXN0" });
    if (method === "GET") {
      expect(followed.body).toBe("");
      expect(followed.type).toBeUndefined();
    } else {
      expect(followed.body).toBe("grant_type=client_credentials");
    }
  });
});

describe("redirect answers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cancels the body of every redirect answer, followed or refused", async () => {
    const cancelled: string[] = [];
    const stream = (tag: string) =>
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("x"));
        },
        cancel() {
          cancelled.push(tag);
        },
      });
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n++;
      if (n === 1)
        return new Response(stream("followed"), { status: 302, headers: { location: "/two" } });
      return new Response(stream("refused"), {
        status: 301,
        headers: { location: "https://elsewhere.invalid/x" },
      });
    });
    await expect(
      fetchJson({
        source: "genius",
        url: "https://api.genius.test/one",
        headers: { Authorization: "Bearer t0123456789" },
        cassette: false,
      }),
    ).rejects.toMatchObject({ kind: "http" });
    expect(cancelled).toEqual(["followed", "refused"]);
  });

  it("reports a Location that is not a URL as an unreadable answer", async () => {
    vi.stubGlobal(
      "fetch",
      async () => new Response("", { status: 302, headers: { location: "http://[bad" } }),
    );
    await expect(
      fetchJson({
        source: "genius",
        url: "https://api.genius.test/one",
        headers: { Authorization: "Bearer t0123456789" },
        cassette: false,
      }),
    ).rejects.toMatchObject({ kind: "parse", status: 302 });
  });
});
