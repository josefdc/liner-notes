/**
 * Test helper run as a separate process: makes model calls through `createLlm` against a stub
 * provider (no network), so a test can run several processes against one spend log.
 *
 *   node --import tsx callWorker.ts
 *
 * Configured by the environment (settings as the app reads them; the spend log must exist,
 * plus):
 *   SQLITE_DB_PATH        opens this app database, so usage rows are recorded in it
 *   WORKER_CALLS          number of calls (default 1)
 *   WORKER_PARALLEL       "1": start every call at once (default: one after another)
 *   WORKER_GROUP_DIR      a directory shared by the processes of one test, which line up on
 *                         it: none calls before all WORKER_GROUP_SIZE have started, and the
 *                         stub answers no call before every call of the group was sent to it or
 *                         refused (so an admitted call is still open while the others decide).
 *                         A process still waiting for the group 20 s after it started exits 2.
 *   WORKER_GROUP_SIZE     the number of calls in the group (its processes make one each)
 *   WORKER_MAX_OUTPUT     max_output_tokens per call (default 1000)
 *   STUB_INPUT, STUB_OUTPUT   tokens the stub reports per call (default 100 / 20)
 *   STUB_HANG             "1": the stub prints "in-flight" and never answers
 *
 * Prints one `RESULT {json}` line per call: { ok: true, usd } or { ok: false, kind }.
 */

import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readLlmSettings } from "../../config/settings.js";
import { initializeDatabase } from "../../store/database.js";
import { isLlmError } from "../errors.js";
import { createLlm } from "../invoke.js";
import { FAKE_API_KEY, FAKE_BASE_URL, providerFetch, responseBody } from "./providerStub.js";
import { z } from "zod";

const env = process.env;
// Anything that reaches the real network is a test failure.
globalThis.fetch = (async () => {
  throw new Error("network denied in callWorker");
}) as typeof fetch;

const { settings, errors } = readLlmSettings({
  AZURE_OPENAI_API_KEY: FAKE_API_KEY,
  AZURE_OPENAI_BASE_URL: FAKE_BASE_URL,
  ...env,
  LLM_CASSETTE: "off",
});
if (errors.length > 0) throw new Error(errors.join("; "));
if (env.SQLITE_DB_PATH) initializeDatabase(env.SQLITE_DB_PATH);

const groupDir = env.WORKER_GROUP_DIR;
const groupSize = Number(env.WORKER_GROUP_SIZE ?? 0);

let marks = 0;
/** Leaves a mark named `name` in the group's directory. */
const mark = (name: string) => {
  if (groupDir) writeFileSync(join(groupDir, `${name}-${process.pid}-${marks++}`), "");
};

/**
 * One deadline for both waits, well inside the tests' 60 s timeout: when a process of the group
 * never starts or never decides, the others exit 2 with a message, so the test shows every
 * process's exit code and output instead of timing out.
 */
const groupDeadline = Date.now() + 20_000;

/** Waits until the group's directory holds `groupSize` marks starting with `prefix`. */
async function untilGroup(prefix: string): Promise<void> {
  if (!groupDir) return;
  while (readdirSync(groupDir).filter((name) => name.startsWith(prefix)).length < groupSize) {
    if (Date.now() > groupDeadline) {
      process.stderr.write(`callWorker: the group did not reach ${groupSize} "${prefix}" marks\n`);
      process.exit(2);
    }
    await new Promise((r) => setTimeout(r, 5));
  }
}

const stubUsage = { input: Number(env.STUB_INPUT ?? 100), output: Number(env.STUB_OUTPUT ?? 20) };
const provider = providerFetch(async () => {
  if (env.STUB_HANG === "1") {
    process.stdout.write("in-flight\n");
    return new Promise<Response>(() => {});
  }
  mark("decided-sent");
  await untilGroup("decided-");
  return Response.json(responseBody({ ok: true }, stubUsage));
});

const llm = createLlm({ settings, fetch: provider.fetch });
const Schema = z.object({ ok: z.boolean() });
const calls = Number(env.WORKER_CALLS ?? 1);
const maxOutputTokens = Number(env.WORKER_MAX_OUTPUT ?? 1000);

mark("started");
await untilGroup("started-");

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
    // Refused (or failed) without being answered: decided too.
    mark("decided-refused");
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
