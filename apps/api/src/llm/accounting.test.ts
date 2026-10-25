/**
 * The accounting invariant of invoke: an unknown outcome keeps the worst case, a known outcome
 * settles what was reported, and nothing that was never sent is charged. Covers answers with
 * missing usage, incomplete, refused, failed and malformed answers, the HTTP-status table, and
 * aborts before the request.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { captureLogsForTests } from "../logger.js";
import { resolveSpendLogPath } from "./budget.js";
import { isLlmError } from "./errors.js";
import { acquireLock } from "./fileLock.js";
import { createLlm, type InvokeOptions } from "./invoke.js";
import { parseSpendLog, type SpendLine, summarise } from "./spendLog.js";
import {
  errorResponse,
  hang,
  type ProviderRoute,
  providerFetch,
  responseBody,
  testSettings,
} from "./testing/providerStub.js";
import type { LlmUsageRow } from "./usage.js";

const Schema = z.object({ ok: z.boolean() });
const OPTIONS: InvokeOptions = {
  purpose: "dev",
  runId: "run-1",
  maxOutputTokens: 20_000,
  schemaName: "Ok",
};

let dir: string;
let log: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-accounting-"));
  log = join(dir, "spend.jsonl");
  writeFileSync(log, "");
  vi.stubGlobal("fetch", () => {
    throw new Error("network denied");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

function setup(route: ProviderRoute, env: Record<string, string> = {}) {
  const net = providerFetch(route);
  const rows: LlmUsageRow[] = [];
  const waits: number[] = [];
  const llm = createLlm({
    settings: testSettings({ LLM_SPEND_LOG: log, ...env }),
    fetch: net.fetch,
    recordUsage: (row) => rows.push(row),
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { llm, net, rows, waits };
}

const lines = (): SpendLine[] => parseSpendLog(readFileSync(log, "utf8"));
const settles = () => lines().filter((l) => l.kind === "settle");
const reserves = () => lines().filter((l) => l.kind === "reserve");

/** Every settle kept its reservation's worst case and says so. */
function expectWorstCaseKept() {
  const r = reserves();
  const s = settles();
  expect(s).toHaveLength(r.length);
  s.forEach((settle, i) => {
    expect(settle.usd_est).toBe(r[i].usd_est);
    expect(settle.estimated).toBe(true);
  });
  expect(summarise(lines()).totalUsd).toBeGreaterThan(0);
}

function body(over: Record<string, unknown>, usage: { input: number; output: number } | null) {
  return { ...(responseBody({ ok: true }, usage) as Record<string, unknown>), ...over };
}

/** The warnings logged from now until the test ends, as one text. */
function captureWarnings(): () => string {
  const logs = captureLogsForTests();
  onTestFinished(() => logs.restore());
  return () => logs.messages("warn").join(" ");
}

describe("usage the provider did not report", () => {
  it("keeps the worst case when an answer has no usage", async () => {
    const { llm, rows } = setup(() => Response.json(responseBody({ ok: true }, null)));
    const result = await llm.invoke("x", "research", "hi", Schema, OPTIONS);
    expect(result.output).toEqual({ ok: true });
    expect(result.usage).toMatchObject({ inputTokens: null, outputTokens: null });
    expectWorstCaseKept();
    expect(rows).toMatchObject([
      { estimated: true, inputTokens: null, outputTokens: null, sent: true },
    ]);
    expect(rows[0].usdEst).toBe(reserves()[0].usd_est);
  });

  it("keeps the worst case when only part of the usage is reported", async () => {
    const partial = responseBody({ ok: true }, null) as Record<string, unknown>;
    partial.usage = { input_tokens: 5000 };
    const { llm } = setup(() => Response.json(partial));
    await llm.invoke("x", "research", "hi", Schema, OPTIONS);
    expectWorstCaseKept();
  });

  it("settles a consistent reported zero as zero, never -0", async () => {
    // No text and no tokens: consistent, so it is what was billed.
    const { llm, rows } = setup(() => Response.json(responseBody("", { input: 0, output: 0 })));
    const error = await llm.invoke("x", "research", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "invalid_output")).toBe(true);
    expect(settles()).toMatchObject([{ usd_est: 0, estimated: false, in: 0, out: 0 }]);
    expect(Object.is(settles()[0].usd_est, 0)).toBe(true);
    expect(Object.is(rows[0].usdEst, 0)).toBe(true);
  });

  it("keeps the worst case for answer text reported with 0 output tokens", async () => {
    const warnings = captureWarnings();
    const { llm } = setup(() => Response.json(responseBody({ ok: true }, { input: 0, output: 0 })));
    const result = await llm.invoke("x", "research", "hi", Schema, OPTIONS);
    expect(result.usage).toMatchObject({ inputTokens: null, outputTokens: null });
    expectWorstCaseKept();
    expect(warnings()).toContain("inconsistent");
  });

  it("keeps the worst case when reasoning tokens exceed output tokens", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { llm } = setup(() =>
      Response.json(responseBody({ ok: true }, { input: 10, output: 5, reasoning: 15_000 })),
    );
    await llm.invoke("x", "research", "hi", Schema, OPTIONS);
    expectWorstCaseKept();
  });

  it("charges the fallback prices × 1.5 for an answer from a model outside the deployment's family", async () => {
    const warnings = captureWarnings();
    const { llm, rows } = setup(() =>
      Response.json(responseBody({ ok: true }, { input: 1000, output: 1000 }, "gpt-6-sol")),
    );
    // main = gpt-6-luna (USD 0.11 / 0.55), answered by gpt-6-sol.
    const result = await llm.invoke("x", "main", "hi", Schema, OPTIONS);
    expect(result.usage.multiplier).toBe(1.5);
    expect(result.usage.usdEst).toBe(0.075); // (1000 × 10 + 1000 × 40) / 1e6 × 1.5
    expect(settles()).toMatchObject([{ usd_est: 0.075, multiplier: 1.5 }]);
    expect(rows[0].priceMultiplier).toBe(1.5);
    expect(warnings()).toContain("outside the priced family");
  });

  it("accepts a dated model name of the deployment's family at its price", async () => {
    const { llm } = setup(() =>
      Response.json(
        responseBody({ ok: true }, { input: 1000, output: 1000 }, "gpt-6-luna-2026-09-01"),
      ),
    );
    const result = await llm.invoke("x", "main", "hi", Schema, OPTIONS);
    expect(result.usage).toMatchObject({ multiplier: 1, usdEst: 0.00066 });
  });
});

describe("answers that are not a usable result", () => {
  const incomplete = (text: string, reason: string) => {
    const b = responseBody(text, { input: 100, output: 300, reasoning: 250 }) as Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: a stub body, edited freely
      any
    >;
    b.status = "incomplete";
    b.incomplete_details = { reason };
    b.output[0].status = "incomplete";
    return b;
  };

  it("reports an answer cut at max_output_tokens as incomplete, bills it, does not retry", async () => {
    const { llm, net } = setup(() => Response.json(incomplete('{"ok":tr', "max_output_tokens")));
    const error = await llm.invoke("x", "main", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "incomplete")).toBe(true);
    expect(error.incompleteReason).toBe("max_output_tokens");
    expect(error.usage).toEqual({ inputTokens: 100, outputTokens: 300, reasoningTokens: 250 });
    expect(error.message).toContain("raise maxOutputTokens");
    expect(error.message).toContain("250 reasoning");
    expect(net.calls).toHaveLength(1);
    expect(settles()).toMatchObject([
      { in: 100, out: 300, reasoning: 250, status: "error:incomplete", estimated: false },
    ]);
    // The error says what the billed attempt cost, as it was settled.
    expect(error.cost).toEqual({
      deployment: settles()[0].deployment,
      usdEst: settles()[0].usd_est,
    });
    expect(error.cost.usdEst).toBeGreaterThan(0);
  });

  it("does not accept an incomplete answer whose text happens to be valid JSON", async () => {
    const { llm } = setup(() => Response.json(incomplete('{"ok":true}', "content_filter")));
    const error = await llm.invoke("x", "main", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "incomplete")).toBe(true);
    expect(error.incompleteReason).toBe("content_filter");
  });

  it("reports an answer that spent its whole budget reasoning as incomplete", async () => {
    const b = incomplete("", "max_output_tokens");
    b.output = [{ type: "reasoning", id: "rs_1", summary: [] }];
    const { llm } = setup(() => Response.json(b));
    const error = await llm.invoke("x", "main", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "incomplete")).toBe(true);
  });

  it("reports a refusal as refused, billed, not retried", async () => {
    const b = responseBody("", { input: 100, output: 10 });
    b.output[0].content = [{ type: "refusal", refusal: "I can't help with that." }] as never;
    const { llm, net } = setup(() => Response.json(b));
    const error = await llm.invoke("x", "main", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "refused")).toBe(true);
    expect(error.message).not.toContain("help with that");
    expect(net.calls).toHaveLength(1);
    expect(settles()).toMatchObject([{ in: 100, out: 10, status: "error:refused" }]);
    expect(error.cost?.usdEst).toBe(settles()[0].usd_est);
  });

  it("reports status failed with a server error as transient, billing its usage", async () => {
    const failed = body(
      { status: "failed", error: { code: "server_error", message: "boom" }, output: [] },
      { input: 100, output: 10 },
    );
    const { llm, net } = setup((_c, i) =>
      i === 0 ? Response.json(failed) : Response.json(responseBody({ ok: true }, null)),
    );
    const result = await llm.invoke("x", "main", "hi", Schema, OPTIONS);
    expect(result.usage.attempts).toBe(2);
    expect(net.calls).toHaveLength(2);
    expect(settles()[0]).toMatchObject({
      status: "error:response_failed",
      in: 100,
      out: 10,
      estimated: false,
    });
  });

  it("reports a completed answer that is not JSON as invalid_output, billing its usage", async () => {
    const { llm, net } = setup(() =>
      Response.json(responseBody('{"ok":', { input: 100, output: 2000 })),
    );
    const error = await llm.invoke("x", "research", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "invalid_output")).toBe(true);
    expect(error.usage).toMatchObject({ inputTokens: 100, outputTokens: 2000 });
    expect(net.calls).toHaveLength(1);
    expect(settles()).toMatchObject([{ in: 100, out: 2000, estimated: false }]);
  });

  it("reports an HTML 200 (a proxy page) as invalid_response at the worst case", async () => {
    const { llm, net } = setup(
      () =>
        new Response("<html>gateway</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    );
    const error = await llm.invoke("x", "main", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "invalid_response")).toBe(true);
    expect(net.calls).toHaveLength(1);
    expectWorstCaseKept();
  });

  it("reports a 400 context overflow as context_overflow, unbilled, not retried", async () => {
    const { llm, net } = setup(() =>
      Response.json(
        {
          error: {
            message: "Input tokens exceed the configured limit",
            type: "invalid_request_error",
            code: "context_length_exceeded",
          },
        },
        { status: 400 },
      ),
    );
    const error = await llm.invoke("x", "main", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "context_overflow")).toBe(true);
    expect(error.status).toBe(400);
    expect(net.calls).toHaveLength(1);
    expect(settles()).toMatchObject([{ usd_est: 0, estimated: false }]);
  });
});

describe("a prompt the content filter rejects", () => {
  it("is settled at its input bound only, estimated, and not retried", async () => {
    const { llm, net } = setup(() =>
      Response.json(
        { error: { message: "filtered", type: "invalid_request_error", code: "content_filter" } },
        { status: 400 },
      ),
    );
    const error = await llm.invoke("x", "research", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "content_filtered")).toBe(true);
    expect(net.calls).toHaveLength(1);
    const [reserve] = reserves();
    const [settle] = settles();
    // gpt-6-sol input price: the reservation's input bound × USD 2.20 per 1M.
    expect(settle).toMatchObject({ estimated: true, status: "error:content_filtered" });
    expect(settle.usd_est).toBeCloseTo((reserve.in * 2.2) / 1e6, 6);
    expect(settle.usd_est).toBeGreaterThan(0);
    expect(settle.usd_est).toBeLessThan(reserve.usd_est);
  });
});

describe("HTTP statuses", () => {
  it.each([400, 401, 403, 404])("settles a %i at zero: rejected before processing", async (s) => {
    const { llm } = setup(() => errorResponse(s));
    await llm.invoke("x", "research", "hi", Schema, OPTIONS).catch(() => {});
    expect(settles()).toMatchObject([{ usd_est: 0, estimated: false }]);
  });

  it("settles a 429 at zero", async () => {
    const { llm, rows } = setup(() => errorResponse(429));
    await llm.invoke("x", "research", "hi", Schema, OPTIONS).catch(() => {});
    expect(settles().every((l) => l.usd_est === 0 && l.estimated === false)).toBe(true);
    // The provider answered: the request reached it.
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.sent)).toBe(true);
  });

  it.each([408, 409, 500, 502, 503, 504])(
    "keeps the worst case for a %i: the provider may have processed it",
    async (status) => {
      const { llm, net } = setup(() => errorResponse(status));
      await llm.invoke("x", "research", "hi", Schema, OPTIONS).catch(() => {});
      expect(net.calls).toHaveLength(2);
      expectWorstCaseKept();
    },
  );

  it("settles at zero when no connection was made, recording the attempts as not sent", async () => {
    const { llm, rows } = setup(() => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
      });
    });
    const error = await llm.invoke("x", "research", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error, "network")).toBe(true);
    expect(settles().every((l) => l.usd_est === 0)).toBe(true);
    expect(rows.map((row) => [row.status, row.sent])).toEqual([
      ["error:network", false],
      ["error:network", false],
    ]);
  });

  // The errors fetch (undici) throws when no connection was made, as Node 24 shapes them.
  const undiciCause = (name: string, message: string, code?: string) =>
    Object.assign(new Error(message), { name, ...(code ? { code } : {}) });
  it.each([
    [
      "a connect timeout",
      undiciCause(
        "ConnectTimeoutError",
        "Connect Timeout Error (attempted address: 10.255.255.1:443, timeout: 10000ms)",
        "UND_ERR_CONNECT_TIMEOUT",
      ),
    ],
    [
      "an unreachable network",
      Object.assign(undiciCause("Error", "connect ENETUNREACH 10.0.0.1:443", "ENETUNREACH"), {
        syscall: "connect",
      }),
    ],
    [
      "an unreachable host",
      Object.assign(undiciCause("Error", "connect EHOSTUNREACH 10.0.0.1:443", "EHOSTUNREACH"), {
        syscall: "connect",
      }),
    ],
    // fetch refuses the ports browsers block before connecting, with no code.
    ["a port fetch blocks", undiciCause("Error", "bad port")],
  ])("settles at zero and records the attempts as not sent for %s", async (_, cause) => {
    const { llm, rows } = setup(() => {
      throw new TypeError("fetch failed", { cause });
    });
    const error = await llm.invoke("x", "research", "hi", Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(error)).toBe(true);
    expect(settles().length).toBeGreaterThan(0);
    expect(settles().every((l) => l.usd_est === 0 && l.estimated === false)).toBe(true);
    expect(summarise(lines()).totalUsd).toBe(0);
    expect(rows.length).toBe(settles().length);
    expect(rows.every((row) => row.sent === false && row.usdEst === 0)).toBe(true);
  });

  it("keeps the worst case for a reset connection, recording the attempts as sent", async () => {
    const { llm, rows } = setup(() => {
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
      });
    });
    await llm.invoke("x", "research", "hi", Schema, OPTIONS).catch(() => {});
    expectWorstCaseKept();
    expect(rows.map((row) => [row.status, row.sent])).toEqual([
      ["error:network", true],
      ["error:network", true],
    ]);
  });
});

describe("aborts", () => {
  it("throws LlmError aborted for a signal that is already aborted, reserving nothing", async () => {
    const { llm, net } = setup(hang);
    const controller = new AbortController();
    controller.abort();
    const error = await llm
      .invoke("x", "main", "hi", Schema, { ...OPTIONS, signal: controller.signal })
      .catch((e) => e);
    expect(isLlmError(error, "aborted")).toBe(true);
    expect(net.calls).toHaveLength(0);
    expect(readFileSync(log, "utf8")).toBe("");
  });

  it("leaves the queue at once when aborted while waiting for a slot, charging nothing", async () => {
    let first = true;
    const { llm, net } = setup(
      (call) => {
        if (!first) return hang(call);
        first = false;
        return new Promise((resolve) =>
          setTimeout(() => resolve(Response.json(responseBody({ ok: true }, null))), 500),
        );
      },
      { LLM_CONCURRENCY: "1" },
    );
    const running = llm.invoke("a", "research", "hi", Schema, { ...OPTIONS, runId: "rA" });
    const controller = new AbortController();
    const started = performance.now();
    const queued = llm
      .invoke("b", "research", "hi", Schema, {
        ...OPTIONS,
        runId: "rB",
        signal: controller.signal,
      })
      .catch((e) => e);
    setTimeout(() => controller.abort(), 20);
    const error = await queued;
    expect(isLlmError(error, "aborted")).toBe(true);
    expect(performance.now() - started).toBeLessThan(300);
    await running;
    expect(net.calls).toHaveLength(1);
    expect(lines().filter((l) => l.callSite === "b")).toEqual([]);
    expect(llm.callsForRun("rB")).toBe(0);
  });

  it("stops during the retry wait, sending and charging no second attempt", async () => {
    const controller = new AbortController();
    const net = providerFetch(() => errorResponse(503));
    const llm = createLlm({
      settings: testSettings({ LLM_SPEND_LOG: log }),
      fetch: net.fetch,
      recordUsage: () => {},
      sleep: () =>
        new Promise((resolve) => {
          controller.abort();
          setTimeout(resolve, 1000);
        }),
    });
    const started = performance.now();
    const error = await llm
      .invoke("x", "research", "hi", Schema, { ...OPTIONS, signal: controller.signal })
      .catch((e) => e);
    expect(isLlmError(error, "aborted")).toBe(true);
    // Without waiting out the 1 s retry wait.
    expect(performance.now() - started).toBeLessThan(500);
    expect(net.calls).toHaveLength(1);
    expect(reserves()).toHaveLength(1);
    expect(llm.callsForRun("run-1")).toBe(1);
  });

  it("releases the reservation of an attempt aborted before its request was sent", async () => {
    const controller = new AbortController();
    const net = providerFetch(hang);
    const rows: LlmUsageRow[] = [];
    const llm = createLlm({
      settings: testSettings({ LLM_SPEND_LOG: log }),
      fetch: net.fetch,
      recordUsage: (row) => rows.push(row),
    });
    // Aborts while the attempt waits for the spend log's lock, after it was admitted.
    const original = Date.prototype.toISOString;
    let aborted = false;
    vi.spyOn(Date.prototype, "toISOString").mockImplementation(function (this: Date) {
      if (!aborted) {
        aborted = true;
        controller.abort();
      }
      return original.call(this);
    });
    const error = await llm
      .invoke("x", "research", "hi", Schema, { ...OPTIONS, signal: controller.signal })
      .catch((e) => e);
    vi.restoreAllMocks();
    expect(isLlmError(error, "aborted")).toBe(true);
    expect(net.calls).toHaveLength(0);
    expect(settles()).toMatchObject([{ usd_est: 0, status: "error:aborted", estimated: false }]);
    expect(summarise(lines()).totalUsd).toBe(0);
    expect(llm.callsForRun("run-1")).toBe(0);
    // Recorded as an attempt, but not as one sent to the provider.
    expect(rows).toMatchObject([{ status: "error:aborted", usdEst: 0, sent: false }]);
  });

  it("keeps the worst case for an abort after the request was sent", async () => {
    const controller = new AbortController();
    const { llm, net, rows } = setup(hang);
    setTimeout(() => controller.abort(), 50);
    await llm
      .invoke("x", "research", "hi", Schema, { ...OPTIONS, signal: controller.signal })
      .catch(() => {});
    expect(net.calls).toHaveLength(1);
    expect(net.calls[0].signal?.aborted).toBe(true);
    expectWorstCaseKept();
    expect(rows).toMatchObject([{ status: "error:aborted", sent: true }]);
  });
});

describe("an abort while waiting for the spend log's lock", () => {
  it("returns at once, sending and charging nothing", async () => {
    const release = await acquireLock(await resolveSpendLogPath(log));
    setTimeout(() => void release(), 1500);
    const { llm, net } = setup(hang);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const started = performance.now();
    const error = await llm
      .invoke("x", "fast", "hi", Schema, { ...OPTIONS, signal: controller.signal })
      .catch((e) => e);
    expect(isLlmError(error, "aborted")).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(net.calls).toHaveLength(0);
    expect(llm.callsForRun("run-1")).toBe(0);
    await new Promise((r) => setTimeout(r, 1500));
    expect(readFileSync(log, "utf8")).toBe("");
  });
});

describe("cost above the reservation", () => {
  it("is settled as reported and reported in a warning", async () => {
    const warnings = captureWarnings();
    const { llm } = setup(() =>
      Response.json(responseBody({ ok: true }, { input: 10_000_000, output: 10 })),
    );
    await llm.invoke("x", "research", "hi", Schema, { ...OPTIONS, maxOutputTokens: 300 });
    expect(settles()[0].usd_est).toBeGreaterThan(reserves()[0].usd_est);
    expect(warnings()).toContain("above the reservation");
  });
});

describe("messages", () => {
  it("accepts LangChain messages", async () => {
    const { llm, net } = setup(() => Response.json(responseBody({ ok: true }, null)));
    await llm.invoke(
      "x",
      "main",
      [new SystemMessage("sys"), new HumanMessage("hello")],
      Schema,
      OPTIONS,
    );
    expect(net.calls[0].body.input).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
    ]);
  });

  it("refuses an empty message list or an unknown message before reserving", async () => {
    const { llm, net } = setup(() => Response.json(responseBody({ ok: true }, null)));
    const empty = await llm.invoke("x", "main", [], Schema, OPTIONS).catch((e) => e);
    expect(isLlmError(empty, "invalid_input")).toBe(true);
    const odd = await llm
      .invoke("x", "main", [{ role: "tool", content: "x" } as never], Schema, OPTIONS)
      .catch((e) => e);
    expect(isLlmError(odd, "invalid_input")).toBe(true);
    expect(net.calls).toHaveLength(0);
    expect(readFileSync(log, "utf8")).toBe("");
  });
});
