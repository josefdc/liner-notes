/**
 * `npm run smoke:llm -w apps/api`: one minimal strict-schema call per tier through the provider
 * layer, to check the configured endpoint, deployments and structured output.
 *
 * Loads settings the way the app does (config/env.ts). Before any request it refuses, with a
 * non-zero exit, when the provider is not configured, LLM_CASSETTE=replay is set, or the spend
 * log (LLM_SPEND_LOG) is unset, missing, unreadable or unwritable. Each call has purpose `dev`,
 * passes the budget guard and is recorded in the spend log like any other.
 *
 * `npm run smoke:llm -w apps/api -- --init` only creates the spend log, empty, when it does not
 * exist (a missing log is otherwise refused), prints its totals and exits without any call.
 *
 * Prints per tier only: status, latency, tokens and estimated USD, plus the one schema field.
 * Never the key, the endpoint or any other response text. Exits 1 when any call fails.
 */

import { settings } from "../config/env.js";
import { LLM_TIERS, isLiveProvider } from "../config/settings.js";
import { SpendGuard } from "../llm/budget.js";
import { isLlmError } from "../llm/errors.js";
import { assertProviderConfigured } from "../llm/factory.js";
import { createLlm } from "../llm/invoke.js";
import { z } from "zod/v4";

const SmokeCheck = z.object({ ok: z.boolean() });
const MAX_OUTPUT_TOKENS = 2000;

function refuse(reason: string): never {
  console.error(`smoke:llm: refused before any request: ${reason}`);
  process.exit(2);
}

const config = settings.llm;

try {
  assertProviderConfigured(config);
} catch (error) {
  refuse(error instanceof Error ? error.message : String(error));
}
if (config.cassette === "replay") {
  refuse("LLM_CASSETTE=replay; smoke:llm checks the live provider, so unset LLM_CASSETTE");
}
if (!isLiveProvider(config)) refuse("no live provider is configured");
if (config.spendLog === null) {
  refuse("LLM_SPEND_LOG is not set; live model calls are refused until it names the spend log");
}

const guard = new SpendGuard({
  logPath: config.spendLog,
  caps: config.budget,
  init: config.spendLogInit,
});
const initOnly = process.argv.slice(2).includes("--init");
try {
  if (initOnly) {
    const created = await guard.init();
    console.log(
      `smoke:llm: spend log ${created ? "created" : "already exists"}: ${config.spendLog}`,
    );
  }
  const totals = await guard.preflight();
  console.log(
    `smoke:llm: spend log ok (${config.spendLog}, ${totals.lines} lines), ` +
      `USD ${totals.totalUsd.toFixed(4)} of ${config.budget.totalUsd.toFixed(2)} counted` +
      (totals.openReservations > 0 ? ` (${totals.openReservations} open reservation(s))` : ""),
  );
} catch (error) {
  refuse(error instanceof Error ? error.message : String(error));
}
if (initOnly) process.exit(0);

const llm = createLlm({ settings: config });
const runId = `smoke-${new Date().toISOString()}`;
let failed = 0;

for (const tier of LLM_TIERS) {
  const deployment = config.deployments[tier];
  const label = `${tier.padEnd(9)} ${deployment.padEnd(16)}`;
  try {
    const { output, usage } = await llm.invoke(
      "smoke",
      tier,
      [
        { role: "system", content: "You are a health check. Answer in the requested JSON format." },
        { role: "user", content: "Set ok to true." },
      ],
      SmokeCheck,
      { purpose: "dev", runId, maxOutputTokens: MAX_OUTPUT_TOKENS, schemaName: "SmokeCheck" },
    );
    console.log(
      `${label} ok        ${String(Math.round(usage.latencyMs)).padStart(6)} ms  ` +
        `in ${usage.inputTokens} out ${usage.outputTokens} (reasoning ${usage.reasoningTokens ?? "n/a"})  ` +
        `USD ${usage.usdEst.toFixed(6)}${usage.multiplier !== 1 ? ` (x${usage.multiplier}, no public price)` : ""}  ` +
        `attempts ${usage.attempts}  ok=${output.ok}`,
    );
  } catch (error) {
    failed += 1;
    const kind = isLlmError(error) ? error.kind : "unexpected";
    const status = isLlmError(error) && error.status !== undefined ? ` HTTP ${error.status}` : "";
    console.log(`${label} failed    ${kind}${status}`);
    if (isLlmError(error) && (kind === "budget_exceeded" || kind === "spend_log_unavailable")) {
      console.error(`smoke:llm: refused: ${error.message}`);
      process.exit(2);
    }
  }
}

process.exit(failed > 0 ? 1 : 0);
