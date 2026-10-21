/**
 * Reserve before spend: parallel calls near the cap cannot overshoot it, every admitted call is
 * settled, and a call whose process is killed mid-call keeps its reservation counted.
 * Run: npm test -w apps/api -- llm/reservation
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toJsonSchema } from "@liner-notes/contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod/v4";
import { isLlmError } from "./errors.js";
import { createLlm, estimateInputTokens } from "./invoke.js";
import { costUsd, priceFor } from "./prices.js";
import { parseSpendLog, summarise } from "./spendLog.js";
import { providerFetch, responseBody, testSettings } from "./testing/providerStub.js";
import { runWorker } from "./testing/runWorker.js";

const Schema = z.object({ ok: z.boolean() });
const MAX_OUTPUT = 1000;

/** The worst case reserved for one research-tier call with `prompt` (what invoke computes). */
function reservationFor(prompt: string): number {
  const tokens = estimateInputTokens([{ role: "user", content: prompt }], toJsonSchema(Schema));
  return costUsd(priceFor("gpt-6-sol"), tokens, MAX_OUTPUT);
}

/** A hand-written spend-log line recording earlier spending. */
const spentLine = (usd: number) =>
  `${JSON.stringify({ ts: new Date().toISOString(), deployment: "gpt-6-sol", in: 0, out: 0, usd_est: usd, unit: "dev" })}\n`;

let dir: string;
let log: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "llm-reservation-"));
  log = join(dir, "spend.jsonl");
  writeFileSync(log, "");
  vi.stubGlobal("fetch", () => {
    throw new Error("network denied");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

function expectAllSettled() {
  const lines = parseSpendLog(readFileSync(log, "utf8"));
  const reserves = lines.filter((l) => l.kind === "reserve");
  const settles = lines.filter((l) => l.kind === "settle");
  expect(settles.map((l) => l.id).sort()).toEqual(reserves.map((l) => l.id).sort());
  expect(summarise(lines).openReservations).toBe(0);
  return { reserves, settles };
}

describe("N=4 parallel calls at cap − ε", () => {
  it("admits at most one call in one process, and settles it", async () => {
    const r = reservationFor("same prompt");
    const cap = 1;
    // Room for one reservation, not two.
    writeFileSync(log, spentLine(cap - 1.5 * r));
    const net = providerFetch(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return Response.json(responseBody({ ok: true }, { input: 10, output: 10 }));
    });
    const llm = createLlm({
      settings: testSettings({
        LLM_SPEND_LOG: log,
        BUDGET_TOTAL_USD: String(cap),
        BUDGET_EVAL_FLOOR_USD: "0",
        LLM_CONCURRENCY: "4",
      }),
      fetch: net.fetch,
      recordUsage: () => {},
    });
    const results = await Promise.allSettled(
      Array.from({ length: 4 }, (_, i) =>
        llm.invoke("parallel", "research", "same prompt", Schema, {
          purpose: "dev",
          runId: `run-${i}`,
          maxOutputTokens: MAX_OUTPUT,
          schemaName: "T",
        }),
      ),
    );
    const admitted = results.filter((r) => r.status === "fulfilled");
    expect(admitted).toHaveLength(1);
    for (const result of results) {
      if (result.status === "rejected") {
        expect(isLlmError(result.reason, "budget_exceeded")).toBe(true);
      }
    }
    expect(net.calls).toHaveLength(1);
    const { reserves } = expectAllSettled();
    expect(reserves).toHaveLength(1);
    expect(summarise(parseSpendLog(readFileSync(log, "utf8"))).totalUsd).toBeLessThanOrEqual(cap);
  });

  it("admits at most one call across four processes, and settles it", async () => {
    const r = reservationFor("call 0");
    const cap = 1;
    writeFileSync(log, spentLine(cap - 1.5 * r));
    const startAt = String(Date.now() + 3000);
    const runs = await Promise.all(
      Array.from({ length: 4 }, (_, i) =>
        runWorker({
          LLM_SPEND_LOG: log,
          SQLITE_DB_PATH: join(dir, `p${i}.db`),
          BUDGET_TOTAL_USD: String(cap),
          BUDGET_EVAL_FLOOR_USD: "0",
          WORKER_MAX_OUTPUT: String(MAX_OUTPUT),
          WORKER_START_AT: startAt,
          STUB_DELAY_MS: "300",
        }),
      ),
    );
    for (const run of runs) expect(run.code, run.stderr).toBe(0);
    const results = runs.flatMap((run) => run.results);
    expect(results).toHaveLength(4);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok).map((r) => r.kind)).toEqual([
      "budget_exceeded",
      "budget_exceeded",
      "budget_exceeded",
    ]);
    expect(expectAllSettled().reserves).toHaveLength(1);
  }, 60_000);
});

describe("a call killed mid-call", () => {
  it("leaves its reservation counted, so the next call is refused", async () => {
    const r = reservationFor("call 0");
    // One reservation fits, two do not.
    const env = {
      LLM_SPEND_LOG: log,
      BUDGET_TOTAL_USD: String(1.5 * r),
      BUDGET_EVAL_FLOOR_USD: "0",
      WORKER_MAX_OUTPUT: String(MAX_OUTPUT),
    };

    const killed = await runWorker({ ...env, STUB_HANG: "1" }, { killOnInFlight: true });
    expect(killed.signal).toBe("SIGKILL");
    expect(killed.results).toEqual([]);

    const lines = parseSpendLog(readFileSync(log, "utf8"));
    expect(lines.map((l) => l.kind)).toEqual(["reserve"]);
    const totals = summarise(lines);
    expect(totals.openReservations).toBe(1);
    expect(totals.totalUsd).toBeCloseTo(r, 6);

    const next = await runWorker(env);
    expect(next.code, next.stderr).toBe(0);
    expect(next.results).toMatchObject([{ ok: false, kind: "budget_exceeded" }]);

    // Without the dead call's reservation the same call fits.
    writeFileSync(log, "");
    const control = await runWorker(env);
    expect(control.results).toMatchObject([{ ok: true }]);
  }, 60_000);
});
