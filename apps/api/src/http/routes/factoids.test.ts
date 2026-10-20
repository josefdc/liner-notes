/**
 * Route tests for /api/factoids/*: validation, generic errors, and the event stream (heartbeat,
 * in-stream errors, abort on disconnect). The model client is a stub; no model is called.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import { createTestApp } from "../testApp.js";
import factoidsRouter from "./factoids.js";

const model = vi.hoisted(() => ({
  generate: vi.fn(),
}));

vi.mock("../../agent/geminiClient.js", () => ({
  generateStructuredOutput: model.generate,
}));

const app = () => createTestApp(factoidsRouter);

const factoid = (id: string) => ({
  id,
  title: `Title ${id}`,
  content: "Content.",
  type: "production",
  entityNames: ["Roland Juno-106"],
});

const validBody = {
  trackId: "6GyFP1nfCDB8lbD2bG0Hq9",
  trackTitle: "Midnight City",
  trackArtist: "M83",
  existingFactoidIds: ["f1", "f2"],
};

beforeEach(() => {
  model.generate.mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// =============================================================================
// POST /api/factoids/decrypt
// =============================================================================

describe("POST /api/factoids/decrypt", () => {
  it("answers 400 to a non-array existingFactoidIds without calling the model", async () => {
    const res = await request(app())
      .post("/api/factoids/decrypt")
      .send({ ...validBody, existingFactoidIds: "not-an-array" })
      .timeout(2000);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: "invalid_input" });
    expect(res.body.issues.join(" ")).toContain("existingFactoidIds");
    expect(model.generate).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty body", {}],
    ["a JSON array", [1, 2]],
    ["a missing trackId", { ...validBody, trackId: undefined }],
    ["a trackId with other characters", { ...validBody, trackId: "../../etc" }],
    ["a blank title", { ...validBody, trackTitle: "   " }],
    ["a title with a control character", { ...validBody, trackTitle: "Mid\u0000night" }],
    ["a title of only format characters", { ...validBody, trackTitle: "\u200B\u202E\u2066" }],
    ["an artist of only format characters", { ...validBody, trackArtist: "\u200D\uFEFF" }],
    ["an existing id of 65 characters", { ...validBody, existingFactoidIds: ["é".repeat(65)] }],
    ["an existing id with a control character", { ...validBody, existingFactoidIds: ["f\u0007"] }],
    ["a blank existing id", { ...validBody, existingFactoidIds: ["\u200B "] }],
    ["a non-string existing id", { ...validBody, existingFactoidIds: [{ id: "f1" }] }],
  ])("answers 400 to %s", async (_label, body) => {
    const res = await request(app()).post("/api/factoids/decrypt").send(body).timeout(2000);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_input");
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("truncates long metadata to 200 code points instead of refusing it", async () => {
    model.generate.mockResolvedValue({ data: null, model: "stub", groundingUsed: false });
    const title = `${"\u{1F3B5}".repeat(199)}ab`; // 201 code points
    const artist = "x".repeat(300);

    const res = await request(app())
      .post("/api/factoids/decrypt")
      .send({ ...validBody, trackTitle: title, trackArtist: artist })
      .timeout(2000);

    expect(res.status).toBe(500); // reached the model (stubbed to fail)
    const { prompt } = model.generate.mock.calls[0][0] as { prompt: string };
    expect(prompt).toContain(`"${"\u{1F3B5}".repeat(199)}a" by ${"x".repeat(200)}.`);
  });

  it("names only the newest 50 ids in the prompt and numbers new ids after all of them", async () => {
    model.generate.mockResolvedValue({ data: null, model: "stub", groundingUsed: false });
    const ids = Array.from({ length: 60 }, (_, i) => `f${i + 1}`);

    await request(app())
      .post("/api/factoids/decrypt")
      .send({ ...validBody, existingFactoidIds: ids })
      .timeout(2000);

    const { prompt } = model.generate.mock.calls[0][0] as { prompt: string };
    expect(prompt).toContain(`IDs: ${ids.slice(10).join(", ")}\n`);
    expect(prompt).toContain('starting from "f61"');
  });

  it("accepts ids the model chose in any printable form", async () => {
    model.generate.mockResolvedValue({ data: null, model: "stub", groundingUsed: false });
    const ids = ["prod #2", "fact.3 (sample)", "ü-é", "\u{1F3B5}".repeat(64)];

    const res = await request(app())
      .post("/api/factoids/decrypt")
      .send({ ...validBody, existingFactoidIds: ids })
      .timeout(2000);

    expect(res.status).toBe(500); // reached the model (stubbed to fail), not a 400
    expect(model.generate).toHaveBeenCalledOnce();
  });

  it("accepts the limits: 200 code points (not UTF-16 units) and 50 ids", async () => {
    model.generate.mockResolvedValue({
      data: { factoids: [factoid("f51"), factoid("f52"), factoid("f53")] },
      model: "stub",
      groundingUsed: false,
    });
    const title = "\u{1F3B5}".repeat(200); // 200 code points, 400 UTF-16 units

    const res = await request(app())
      .post("/api/factoids/decrypt")
      .send({
        ...validBody,
        trackTitle: title,
        existingFactoidIds: Array.from({ length: 50 }, (_, i) => `f${i + 1}`),
      })
      .timeout(2000);

    expect(res.status).toBe(200);
    expect(res.body.factoids).toHaveLength(3);
    expect(model.generate).toHaveBeenCalledOnce();
  });

  it("answers a failed generation with a generic message, not the upstream one", async () => {
    model.generate.mockResolvedValue({
      data: null,
      model: "stub",
      groundingUsed: false,
      error: "upstream said: key AIza-secret invalid at /home/user/app",
    });

    const res = await request(app()).post("/api/factoids/decrypt").send(validBody).timeout(2000);

    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, code: "failed" });
    expect(JSON.stringify(res.body)).not.toMatch(/AIza|\/home|upstream said/);
  });

  it("does not offer the lyrics type to the model", async () => {
    model.generate.mockResolvedValue({ data: null, model: "stub", groundingUsed: false });

    await request(app()).post("/api/factoids/decrypt").send(validBody).timeout(2000);

    const { schema } = model.generate.mock.calls[0][0] as { schema: z.ZodTypeAny };
    const withType = (type: string) => ({
      factoids: [{ ...factoid("f3"), type }, factoid("f4"), factoid("f5")],
    });
    expect(schema.safeParse(withType("trivia")).success).toBe(true);
    expect(schema.safeParse(withType("lyrics")).success).toBe(false);
  });
});

// =============================================================================
// GET /api/factoids/decrypt/stream
// =============================================================================

interface OpenStream {
  status: number;
  headers: http.IncomingHttpHeaders;
  messages: Array<Record<string, unknown>>;
  /** Resolves when a message matching the predicate has arrived. */
  waitFor(predicate: (message: Record<string, unknown>) => boolean): Promise<void>;
  ended: Promise<void>;
  close(): void;
}

let server: http.Server | undefined;

afterEach(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;
  }
});

async function openStream(query: string): Promise<OpenStream> {
  server = createTestApp(factoidsRouter).listen(0, "127.0.0.1");
  await new Promise((resolve) => server?.once("listening", resolve));
  const { port } = server.address() as AddressInfo;

  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/api/factoids/decrypt/stream?${query}`, (res) => {
      const messages: Array<Record<string, unknown>> = [];
      const waiters: Array<{
        predicate: (m: Record<string, unknown>) => boolean;
        done: () => void;
      }> = [];
      let buffer = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => {
        buffer += chunk;
        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const data = part
            .split("\n")
            .filter((line) => line.startsWith("data: "))
            .map((line) => line.slice(6))
            .join("\n");
          if (!data) continue;
          const message = JSON.parse(data);
          messages.push(message);
          for (const waiter of [...waiters]) {
            if (waiter.predicate(message)) {
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.done();
            }
          }
        }
      });
      const ended = new Promise<void>((done) => {
        res.on("end", done);
        res.on("close", done);
      });
      resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        messages,
        ended,
        waitFor: (predicate) =>
          messages.some(predicate)
            ? Promise.resolve()
            : new Promise((done) => waiters.push({ predicate, done })),
        close: () => req.destroy(),
      });
    });
    req.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error);
    });
  });
}

const QUERY = "trackTitle=Midnight+City&trackArtist=M83&existingIds=f1,f2";
const ofType = (type: string) => (message: Record<string, unknown>) => message.type === type;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const until = async (condition: () => boolean, timeoutMs = 2000) => {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await new Promise((r) => setImmediate(r));
  }
};

describe("GET /api/factoids/decrypt/stream", () => {
  it("answers HEAD with the stream headers and does not call the model", async () => {
    const res = await request(app()).head(`/api/factoids/decrypt/stream?${QUERY}`).timeout(2000);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(model.generate).not.toHaveBeenCalled();
  });

  it("sends a heartbeat every 15 s while a factoid is pending, and stops it at the end", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const pending = deferred<unknown>();
    model.generate
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ data: factoid("f9"), model: "stub", groundingUsed: false });

    const stream = await openStream(QUERY);
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toContain("text/event-stream");
    expect(stream.headers["x-accel-buffering"]).toBe("no");
    await until(() => model.generate.mock.calls.length === 1);

    vi.advanceTimersByTime(15_000);
    await stream.waitFor(ofType("heartbeat"));
    vi.advanceTimersByTime(15_000);
    await until(() => stream.messages.filter(ofType("heartbeat")).length === 2);

    pending.resolve({ data: factoid("f3"), model: "stub", groundingUsed: false });
    await stream.waitFor(ofType("done"));
    await stream.ended;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops after the client disconnects: no further model call and no heartbeat", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const pending = deferred<unknown>();
    model.generate
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValue({ data: factoid("f9"), model: "stub", groundingUsed: false });

    const stream = await openStream(QUERY);
    await stream.waitFor(ofType("connected"));
    await until(() => model.generate.mock.calls.length === 1);

    stream.close();
    await until(() => vi.getTimerCount() === 0); // the heartbeat is cleared on close
    // The route stops waiting for the call in flight as soon as the client is gone.
    const log = vi.mocked(console.log);
    await until(() => log.mock.calls.some(([line]) => String(line).includes("Client left")));

    pending.resolve({ data: factoid("f3"), model: "stub", groundingUsed: false });
    await new Promise((r) => setTimeout(r, 100));
    expect(model.generate).toHaveBeenCalledTimes(1);
  });

  it("reports failures in the stream with a code and a generic message, then done", async () => {
    model.generate
      .mockResolvedValueOnce({
        data: null,
        model: "stub",
        groundingUsed: false,
        error: "upstream said: quota for key AIza-secret",
      })
      .mockRejectedValueOnce(new Error("socket hang up at /home/user/app/node_modules/x.js"))
      .mockResolvedValueOnce({ data: factoid("f5"), model: "stub", groundingUsed: false });

    const stream = await openStream(QUERY);
    await stream.waitFor(ofType("done"));

    expect(stream.messages.map((m) => m.type)).toEqual([
      "connected",
      "error",
      "error",
      "factoid",
      "done",
    ]);
    const errors = stream.messages.filter(ofType("error"));
    expect(errors).toEqual([
      { type: "error", code: "failed", error: "This fact could not be generated.", index: 0 },
      { type: "error", code: "failed", error: "This fact could not be generated.", index: 1 },
    ]);
    expect(JSON.stringify(stream.messages)).not.toMatch(/AIza|\/home|upstream said|hang up/);
  });

  it.each([
    ["a missing title", "trackArtist=M83"],
    ["a repeated title", "trackTitle=a&trackTitle=b"],
    ["an existing id with a control character", "trackTitle=x&existingIds=f1,f%07"],
    ["an existing id of 65 characters", `trackTitle=x&existingIds=f1,${"f".repeat(65)}`],
  ])(
    "reports %s as invalid input in the stream without calling the model",
    async (_label, query) => {
      const stream = await openStream(query);
      await stream.waitFor(ofType("done"));

      expect(stream.status).toBe(200);
      expect(stream.messages.map((m) => m.type)).toEqual(["error", "done"]);
      expect(stream.messages[0]).toMatchObject({ code: "invalid_input" });
      expect(model.generate).not.toHaveBeenCalled();
    },
  );

  it("does not offer the lyrics type to the model", async () => {
    model.generate.mockResolvedValue({ data: factoid("f3"), model: "stub", groundingUsed: false });

    const stream = await openStream(QUERY);
    await stream.waitFor(ofType("done"));

    const { schema } = model.generate.mock.calls[0][0] as { schema: z.ZodTypeAny };
    expect(schema.safeParse({ ...factoid("f3"), type: "sample" }).success).toBe(true);
    expect(schema.safeParse({ ...factoid("f3"), type: "lyrics" }).success).toBe(false);
  });

  it("truncates long metadata and uses the newest 50 ids, numbering after all of them", async () => {
    model.generate.mockResolvedValue({ data: factoid("x"), model: "stub", groundingUsed: false });
    const ids = Array.from({ length: 60 }, (_, i) => `f${i + 1}`);

    const stream = await openStream(
      `trackTitle=${"t".repeat(250)}&trackArtist=${"a".repeat(250)}&existingIds=${ids.join(",")},%3Cfact%3E`,
    );
    await stream.waitFor(ofType("done"));

    const { prompt } = model.generate.mock.calls[0][0] as { prompt: string };
    expect(prompt).toContain(`"${"t".repeat(200)}" by ${"a".repeat(200)}.`);
    expect(prompt).toContain(`IDs: ${[...ids.slice(11), "<fact>"].join(", ")})`);
    expect(prompt).toContain('Use ID: "f62"');
  });

  it("does not ask the model about lyrics", async () => {
    model.generate.mockResolvedValue({ data: factoid("f3"), model: "stub", groundingUsed: false });

    const stream = await openStream(QUERY);
    await stream.waitFor(ofType("done"));

    const prompts = model.generate.mock.calls.map(
      ([options]) => (options as { prompt: string }).prompt,
    );
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) expect(prompt).not.toMatch(/lyric/i);
  });
});
