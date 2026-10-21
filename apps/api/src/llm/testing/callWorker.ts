/**
 * Test helper run as a separate process: makes model calls through `createLlm` against a stub
 * provider (no network), so a test can run several processes against one spend log.
 *
 *   node --import tsx callWorker.ts
 *
 * Configured by the environment (settings as the app reads them, with LLM_SPEND_LOG_INIT=1 by
 * default, plus):
 *   SQLITE_DB_PATH        opens this app database, so usage rows are recorded in it
 *   WORKER_CALLS          number of calls (default 1)
 *   WORKER_PARALLEL       "1": start every call at once (default: one after another)
 *   WORKER_START_AT       epoch ms to wait for before the first call (to line processes up)
 *   WORKER_MAX_OUTPUT     max_output_tokens per call (default 1000)
 *   STUB_INPUT, STUB_OUTPUT   tokens the stub reports per call (default 100 / 20)
 *   STUB_DELAY_MS         delay before the stub answers (default 0)
 *   STUB_HANG             "1": the stub prints "in-flight" and never answers
 *
 * Prints one `RESULT {json}` line per call: { ok: true, usd } or { ok: false, kind }.
 */

import { readLlmSettings } from "../../config/settings.js";
import { initializeDatabase } from "../../store/database.js";
import { isLlmError } from "../errors.js";
import { createLlm } from "../invoke.js";
import { FAKE_API_KEY, FAKE_BASE_URL, providerFetch, responseBody } from "./providerStub.js";
import { z } from "zod/v4";

const env = process.env;
// Anything that reaches the real network is a test failure.
globalThis.fetch = (async () => {
  throw new Error("network denied in callWorker");
}) as typeof fetch;

const { settings, errors } = readLlmSettings({
  AZURE_OPENAI_API_KEY: FAKE_API_KEY,
  AZURE_OPENAI_BASE_URL: FAKE_BASE_URL,
  LLM_SPEND_LOG_INIT: "1",
  ...env,
  LLM_CASSETTE: "off",
});
if (errors.length > 0) throw new Error(errors.join("; "));
if (env.SQLITE_DB_PATH) initializeDatabase(env.SQLITE_DB_PATH);

const stubUsage = { input: Number(env.STUB_INPUT ?? 100), output: Number(env.STUB_OUTPUT ?? 20) };
const delayMs = Number(env.STUB_DELAY_MS ?? 0);
const provider = providerFetch(async () => {
  if (env.STUB_HANG === "1") {
    process.stdout.write("in-flight\n");
    return new Promise<Response>(() => {});
  }
  if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  return Response.json(responseBody({ ok: true }, stubUsage));
});

const llm = createLlm({ settings, fetch: provider.fetch });
const Schema = z.object({ ok: z.boolean() });
const calls = Number(env.WORKER_CALLS ?? 1);
const maxOutputTokens = Number(env.WORKER_MAX_OUTPUT ?? 1000);

const startAt = Number(env.WORKER_START_AT ?? 0);
while (Date.now() < startAt) await new Promise((r) => setTimeout(r, 2));

async function one(index: number): Promise<void> {
  try {
    const result = await llm.invoke("worker", "research", `call ${index}`, Schema, {
      purpose: "dev",
      runId: `worker-${process.pid}-${index}`,
      maxOutputTokens,
      schemaName: "WorkerOutput",
    });
    process.stdout.write(`RESULT ${JSON.stringify({ ok: true, usd: result.usage.usdEst })}\n`);
  } catch (error) {
    const kind = isLlmError(error) ? error.kind : "unexpected";
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`RESULT ${JSON.stringify({ ok: false, kind, message })}\n`);
  }
}

if (env.WORKER_PARALLEL === "1") {
  await Promise.all(Array.from({ length: calls }, (_, i) => one(i)));
} else {
  for (let i = 0; i < calls; i++) await one(i);
}
